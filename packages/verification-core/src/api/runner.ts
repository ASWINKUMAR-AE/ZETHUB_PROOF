import type { ApiScenario, ApiExpectation, AssertionResult, TestResult } from '@zethub/shared-types';
import AjvModule from 'ajv';
import { type EvidenceStore } from '../evidence/store.js';
import { redact, redactObject } from '../utils/redact.js';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

interface JsonValidator {
  (data: unknown): boolean;
  errors?: unknown;
}

interface AjvLike {
  compile: (schema: object) => JsonValidator;
  errorsText: (errors?: unknown) => string;
}

const AjvCtor =
  (AjvModule as unknown as { default?: new (options?: Record<string, unknown>) => AjvLike }).default ??
  (AjvModule as unknown as new (options?: Record<string, unknown>) => AjvLike);

export interface ApiRunOptions {
  runId: string;
  scenario: ApiScenario;
  artifacts: EvidenceStore;
  /** Values for ${env.NAME} references, resolved server-side from the project environment. */
  variables?: Record<string, string>;
  /** Values for ${secret.NAME}; never persisted. */
  secrets?: Record<string, string>;
  /** Project root used for local OpenAPI specs. */
  projectRoot?: string;
  signal?: AbortSignal;
}

function interpolate(input: string, vars: Record<string, string>): string {
  return input.replace(/\$\{(env|secret)\.([A-Z0-9_]+)\}/g, (_m, scope: string, name: string) => {
    const value = vars[`${scope}.${name}`] ?? vars[name];
    if (value === undefined) throw new Error(`Unresolved ${scope} reference: ${name}`);
    return value;
  });
}

function getJsonPath(data: unknown, pathExpr: string): unknown {
  const parts = pathExpr
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

let ajv: AjvLike | null = null;
function validator(): AjvLike {
  ajv ??= new AjvCtor({ strict: false, allErrors: true, allowUnionTypes: true });
  return ajv;
}

function matchOpenApi(
  expectation: Extract<ApiExpectation, { type: 'matchOpenApi' }>,
  projectRoot: string | undefined,
  method: string,
  url: string,
  body: unknown,
): AssertionResult {
  const specPath = path.resolve(projectRoot ?? '.', expectation.specPath);
  if (!fs.existsSync(specPath)) {
    return { name: 'OpenAPI contract', status: 'blocked', message: `Spec not found: ${expectation.specPath}` };
  }
  let spec: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(specPath, 'utf8');
    spec = (specPath.endsWith('.json') ? JSON.parse(raw) : yaml.parse(raw)) as Record<string, unknown>;
  } catch (error) {
    return {
      name: 'OpenAPI contract',
      status: 'error',
      message: `Spec could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const paths = (spec.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  const expected = String(expectation.operationId);
  const operation = Object.entries(paths)
    .flatMap(([p, methods]) => Object.entries(methods).map(([m, op]) => ({ p, m, op })))
    .find(({ op }) => op && typeof op === 'object' && (op as { operationId?: string }).operationId === expected);
  if (!operation) {
    return {
      name: `OpenAPI operation ${expected}`,
      status: 'failed',
      message: 'operationId not found in the supplied specification',
    };
  }
  const resolvedPath = operation.p.replace(/\{[^}]+\}/g, '[^/]+');
  const pathMatches = new RegExp(`^${resolvedPath}$`).test(pathname);
  if (!pathMatches) {
    return { name: `OpenAPI operation ${expected}`, status: 'failed', expected: operation.p, actual: pathname };
  }
  if (operation.m.toLowerCase() !== method.toLowerCase()) {
    return {
      name: `OpenAPI operation ${expected}`,
      status: 'failed',
      expected: operation.m.toUpperCase(),
      actual: method,
    };
  }
  const responses = (operation.op.responses ?? {}) as Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
  const schema =
    responses['200']?.content?.['application/json']?.schema ??
    Object.values(responses)[0]?.content?.['application/json']?.schema;
  if (!schema) {
    return {
      name: `OpenAPI operation ${expected}`,
      status: 'passed',
      message: 'Operation and path match; no response schema to validate.',
    };
  }
  const validate = validator().compile(schema);
  return validate(body)
    ? { name: `OpenAPI schema ${expected}`, status: 'passed', actual: 'Response validates against spec' }
    : { name: `OpenAPI schema ${expected}`, status: 'failed', message: validator().errorsText(validate.errors) };
}

export async function runApiScenario(options: ApiRunOptions): Promise<TestResult> {
  const { scenario, artifacts, runId } = options;
  const started = Date.now();
  const assertions: AssertionResult[] = [];
  const evidence: TestResult['evidence'] = [];
  let status: TestResult['status'] = 'passed';
  let message: string | undefined;
  let classification: string | undefined;

  const method = scenario.request.method;
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (mutating && !scenario.request.allowMutation) {
    return {
      key: `api:${scenario.id ?? scenario.name}`,
      title: scenario.name,
      kind: 'api',
      adapterId: 'api-http',
      status: 'blocked',
      durationMs: Date.now() - started,
      assertions: [
        {
          name: 'Mutation authorization',
          status: 'blocked',
          message: `${method} is state-changing. Enable allowMutation and confirm an authorized test environment before running.`,
        },
      ],
      evidence: [],
      classification: 'mutation-not-authorized',
      message: 'State-changing request was blocked by policy.',
    };
  }

  const evidenceJson: Record<string, unknown> = {};
  try {
    const rawUrl = interpolate(scenario.request.url, options.variables ?? {});
    const base = scenario.baseUrl ? interpolate(scenario.baseUrl, options.variables ?? {}) : undefined;
    const url = new URL(rawUrl, base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are supported');
    if (scenario.request.query) {
      for (const [key, value] of Object.entries(scenario.request.query))
        url.searchParams.set(key, interpolate(value, options.variables ?? {}));
    }

    const headers: Record<string, string> = {};
    for (const header of scenario.request.headers) {
      headers[header.name] = interpolate(header.value, { ...(options.variables ?? {}), ...(options.secrets ?? {}) });
    }

    let body: string | undefined;
    if (scenario.request.bodyType === 'json' && scenario.request.body !== undefined) {
      body = JSON.stringify(scenario.request.body);
      headers['content-type'] ??= 'application/json';
    } else if (scenario.request.bodyType === 'text' && scenario.request.body !== undefined) {
      body = String(scenario.request.body);
    } else if (
      scenario.request.bodyType === 'form' &&
      scenario.request.body &&
      typeof scenario.request.body === 'object'
    ) {
      body = new URLSearchParams(
        Object.entries(scenario.request.body as Record<string, string>).map(([k, v]) => [
          k,
          interpolate(String(v), options.variables ?? {}),
        ]) as Array<[string, string]>,
      ).toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    }

    const requestEvidence = {
      method,
      url: redact(url.toString()),
      headers: redactObject(headers),
      bodyPreview: body ? redact(body).slice(0, 4000) : undefined,
      allowMutation: scenario.request.allowMutation,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), scenario.request.timeoutMs);
    const abortBridge = () => controller.abort();
    options.signal?.addEventListener('abort', abortBridge, { once: true });
    // 0 = no redirect following so redirect assertions are observable.
    const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' }).finally(
      () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abortBridge);
      },
    );
    const durationMs = Date.now() - started;
    const rawText = await response.text();
    const text = redact(rawText.slice(0, 300_000));
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      json = undefined;
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    evidenceJson.request = requestEvidence;
    evidenceJson.response = {
      status: response.status,
      headers: redactObject(responseHeaders),
      body: text.slice(0, 20_000),
      durationMs,
    };

    assertions.push({
      name: 'HTTP request completed',
      status: 'passed',
      expected: `${method} ${url.pathname}`,
      actual: `${response.status} in ${durationMs}ms`,
      durationMs,
    });

    for (const expectation of scenario.expectations) {
      switch (expectation.type) {
        case 'status': {
          const ok = response.status === expectation.equals;
          assertions.push({
            name: `Status ${expectation.equals}`,
            status: ok ? 'passed' : 'failed',
            expected: String(expectation.equals),
            actual: String(response.status),
          });
          break;
        }
        case 'statusClass': {
          const ok = statusClass(response.status) === expectation.value;
          assertions.push({
            name: `Status class ${expectation.value}`,
            status: ok ? 'passed' : 'failed',
            expected: expectation.value,
            actual: statusClass(response.status),
          });
          break;
        }
        case 'header': {
          const actual = response.headers.get(expectation.name) ?? '';
          const ok =
            expectation.equals !== undefined
              ? actual === expectation.equals
              : expectation.contains !== undefined
                ? actual.includes(expectation.contains)
                : Boolean(actual);
          assertions.push({
            name: `Header ${expectation.name}`,
            status: ok ? 'passed' : 'failed',
            expected: expectation.equals ?? expectation.contains ?? 'present',
            actual,
          });
          break;
        }
        case 'jsonPath': {
          const actual = getJsonPath(json, expectation.path);
          let ok: boolean;
          if (expectation.exists !== undefined) ok = (actual !== undefined) === expectation.exists;
          else if (expectation.equals !== undefined) ok = JSON.stringify(actual) === JSON.stringify(expectation.equals);
          else if (expectation.valueType !== undefined) {
            const actualType = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
            ok = actualType === expectation.valueType;
          } else ok = actual !== undefined;
          assertions.push({
            name: `JSON path ${expectation.path}`,
            status: ok ? 'passed' : 'failed',
            expected:
              expectation.equals !== undefined
                ? JSON.stringify(expectation.equals)
                : (expectation.valueType ?? String(expectation.exists)),
            actual: actual === undefined ? 'undefined' : JSON.stringify(actual).slice(0, 500),
          });
          break;
        }
        case 'jsonSchema': {
          try {
            const validate = validator().compile(expectation.schema);
            if (json === undefined) {
              assertions.push({ name: 'JSON schema', status: 'failed', message: 'Response was not valid JSON' });
            } else if (validate(json)) {
              assertions.push({ name: 'JSON schema', status: 'passed', actual: 'Response matches schema' });
            } else {
              assertions.push({
                name: 'JSON schema',
                status: 'failed',
                message: validator().errorsText(validate.errors)?.slice(0, 1500),
              });
            }
          } catch (error) {
            assertions.push({
              name: 'JSON schema',
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }
        case 'bodyContains': {
          const ok = rawText.includes(expectation.value);
          assertions.push({
            name: 'Body contains expected text',
            status: ok ? 'passed' : 'failed',
            expected: expectation.value.slice(0, 200),
          });
          break;
        }
        case 'responseTime': {
          const ok = durationMs <= expectation.maxMs;
          assertions.push({
            name: `Response time < ${expectation.maxMs}ms`,
            status: ok ? 'passed' : 'failed',
            actual: `${durationMs}ms`,
          });
          break;
        }
        case 'matchOpenApi': {
          assertions.push(matchOpenApi(expectation, options.projectRoot, method, url.toString(), json));
          break;
        }
        default:
          assertions.push({ name: 'Unknown expectation', status: 'error' });
      }
    }

    evidence.push(
      await artifacts.write({
        runId,
        fileName: `api-${(scenario.id ?? scenario.name).replace(/[^a-zA-Z0-9._-]/g, '_')}-request.json`,
        content: JSON.stringify(evidenceJson, null, 2),
        kind: 'json',
        mimeType: 'application/json',
      }),
    );

    if (assertions.some((a) => a.status === 'failed')) status = 'failed';
    else if (assertions.some((a) => a.status === 'blocked')) status = 'blocked';
    else if (assertions.some((a) => a.status === 'error')) status = 'error';
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
    status = options.signal?.aborted ? 'cancelled' : isAbort ? 'timeout' : 'error';
    classification = isAbort ? 'api-timeout' : 'api-transport-error';
    message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1500);
    assertions.push({ name: 'HTTP request', status, message });
  }

  return {
    key: `api:${scenario.id ?? scenario.name}`,
    title: scenario.name,
    kind: 'api',
    adapterId: 'api-http',
    status,
    durationMs: Date.now() - started,
    assertions,
    evidence,
    classification,
    message,
  };
}
