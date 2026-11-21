import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { TestResult, AssertionResult, BrowserScenario, BrowserStep, Locator } from '@zethub/shared-types';
import type { Browser, Page } from 'playwright';
import type * as PngJs from 'pngjs';
import { type EvidenceStore } from '../evidence/store.js';
import { redact } from '../utils/redact.js';
import { toPosix } from '../utils/paths.js';

const require = createRequire(import.meta.url);

export interface BrowserRunOptions {
  runId: string;
  projectId: string;
  scenario: BrowserScenario;
  artifacts: EvidenceStore;
  /** Base URL for relative goto paths. */
  baseUrl?: string;
  /** Secrets resolved server-side (never persisted in scenario JSON). */
  secrets?: Record<string, string>;
  signal?: AbortSignal;
}

class StepFailure extends Error {}

function locatorFor(page: Page, loc: Locator) {
  const opts = { exact: loc.exact ?? false };
  switch (loc.strategy) {
    case 'role':
      return page.getByRole((loc.role ?? 'button') as never, { name: loc.value, ...opts });
    case 'label':
      return page.getByLabel(loc.value, opts);
    case 'text':
      return page.getByText(loc.value, opts);
    case 'testId':
      return page.getByTestId(loc.value);
    case 'placeholder':
      return page.getByPlaceholder(loc.value, opts);
    case 'altText':
      return page.getByAltText(loc.value, opts);
    case 'title':
      return page.getByTitle(loc.value, opts);
    case 'css':
      return page.locator(loc.value);
    default:
      throw new StepFailure(`Unknown locator strategy: ${String((loc as { strategy: string }).strategy)}`);
  }
}

function stepLabel(step: BrowserStep): string {
  switch (step.action) {
    case 'goto':
      return `Navigate to ${step.url ?? step.path ?? ''}`;
    case 'click':
      return `Click ${step.description ?? step.locator.value}`;
    case 'fill':
      return `Fill ${step.locator.value}`;
    case 'expectTitle':
      return `Page title ${step.mode} "${step.value}"`;
    case 'expectUrl':
      return `URL ${step.mode} "${step.value}"`;
    case 'expectVisible':
      return `"${step.locator.value}" is visible`;
    case 'expectText':
      return `"${step.locator.value}" ${step.mode} "${step.text}"`;
    case 'expectValue':
      return `"${step.locator.value}" has value`;
    case 'expectCount':
      return `"${step.locator.value}" count is ${step.count}`;
    case 'expectNoConsoleErrors':
      return 'No console errors';
    case 'expectNoFailedRequests':
      return 'No failed network requests';
    case 'waitForResponse':
      return `Response ${step.urlContains}${step.status ? ` (${step.status})` : ''}`;
    case 'screenshot':
      return `Screenshot ${step.name}`;
    case 'expectScreenshot':
      return `Screenshot matches baseline ${step.name}`;
    case 'upload':
      return `Upload file to ${step.locator.value}`;
    case 'expectDownload':
      return `Download triggered by ${step.locator.value}`;
    case 'expectAccessible':
      return `"${step.locator.value}" is accessible`;
    default:
      return step.action;
  }
}

export async function runBrowserScenario(options: BrowserRunOptions): Promise<TestResult> {
  const { scenario, artifacts, runId } = options;
  const started = Date.now();
  const assertions: AssertionResult[] = [];
  const evidence: TestResult['evidence'] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ url: string; method: string; failure: string }> = [];
  const responses: Array<{ url: string; status: number }> = [];
  const secrets = options.secrets ?? {};

  let browser: Browser | null = null;
  let status: TestResult['status'] = 'passed';
  let message: string | undefined;
  let classification: string | undefined;

  const environment = {
    browser: scenario.browser,
    viewport: scenario.viewport,
  };

  const timeoutHandle = setTimeout(() => {
    status = 'timeout';
    message = `Scenario exceeded ${scenario.timeoutMs}ms`;
    void browser?.close().catch(() => undefined);
  }, scenario.timeoutMs);

  try {
    const playwright = await import('playwright');
    const engine = playwright[scenario.browser] ?? playwright.chromium;
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({
      viewport: scenario.viewport,
      ignoreHTTPSErrors: false,
      acceptDownloads: true,
    });
    if (scenario.trace) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(15_000, scenario.timeoutMs));

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(redact(msg.text()).slice(0, 1000));
    });
    page.on('pageerror', (err) => pageErrors.push(redact(err.message).slice(0, 1000)));
    page.on('requestfailed', (req) => {
      failedRequests.push({
        url: redact(req.url()),
        method: req.method(),
        failure: req.failure()?.errorText ?? 'unknown',
      });
    });
    page.on('response', (res) => {
      if (responses.length < 500) responses.push({ url: redact(res.url()), status: res.status() });
    });

    const currentUrl = () => page.url();
    const resolveUrl = (target: string) => {
      if (/^https?:\/\//i.test(target)) return target;
      const base = scenario.startUrl ?? options.baseUrl;
      if (!base) throw new StepFailure('Relative navigation requires a start URL');
      return new URL(target, base).toString();
    };

    for (const step of scenario.steps) {
      if (options.signal?.aborted) {
        status = 'cancelled';
        message = 'Cancelled by user';
        break;
      }
      const label = stepLabel(step);
      const stepStart = Date.now();
      try {
        switch (step.action) {
          case 'goto': {
            const target = resolveUrl(step.url ?? step.path ?? '');
            const response = await page.goto(target, {
              waitUntil: 'domcontentloaded',
              timeout: Math.min(30_000, scenario.timeoutMs),
            });
            if (!response) throw new StepFailure(`No HTTP response for ${target}`);
            if (response.status() >= 400) throw new StepFailure(`HTTP ${response.status()} for ${target}`);
            assertions.push({
              name: label,
              status: 'passed',
              actual: `HTTP ${response.status()}`,
              durationMs: Date.now() - stepStart,
            });
            break;
          }
          case 'expectTitle': {
            const title = await page.title();
            const ok = step.mode === 'equals' ? title === step.value : title.includes(step.value);
            if (!ok) throw new StepFailure(`Title was "${title}"`);
            assertions.push({ name: label, status: 'passed', expected: step.value, actual: title });
            break;
          }
          case 'expectUrl': {
            const url = currentUrl();
            const ok = step.mode === 'equals' ? url === step.value : url.includes(step.value);
            if (!ok) throw new StepFailure(`URL was ${url}`);
            assertions.push({ name: label, status: 'passed', expected: step.value, actual: url });
            break;
          }
          case 'click': {
            const loc = locatorFor(page, step.locator);
            await loc.click();
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'fill': {
            let value = step.value;
            const match = value.match(/^\$\{secret\.([A-Z0-9_]+)\}$/);
            if (match) {
              const secret = secrets[match[1] ?? ''];
              if (!secret) throw new StepFailure(`Missing test secret ${match[1]}`);
              value = secret;
            }
            await locatorFor(page, step.locator).fill(value);
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'press': {
            await locatorFor(page, step.locator).press(step.key);
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'select': {
            await locatorFor(page, step.locator).selectOption(step.value);
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'check': {
            const loc = locatorFor(page, step.locator);
            if (step.checked) await loc.check();
            else await loc.uncheck();
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'waitForVisible': {
            await locatorFor(page, step.locator).waitFor({ state: 'visible', timeout: step.timeoutMs ?? 10_000 });
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'waitForHidden': {
            await locatorFor(page, step.locator).waitFor({ state: 'hidden', timeout: step.timeoutMs ?? 10_000 });
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'expectVisible': {
            const loc = locatorFor(page, step.locator);
            await loc.waitFor({ state: 'visible', timeout: step.timeoutMs ?? 10_000 });
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'expectText': {
            const actual = (await locatorFor(page, step.locator).innerText()).trim();
            const ok =
              step.mode === 'equals'
                ? actual === step.text
                : step.mode === 'regex'
                  ? new RegExp(step.text).test(actual)
                  : actual.includes(step.text);
            if (!ok) throw new StepFailure(`Expected ${step.mode} "${step.text}", received "${actual.slice(0, 300)}"`);
            assertions.push({ name: label, status: 'passed', expected: step.text, actual });
            break;
          }
          case 'expectValue': {
            const actual = await locatorFor(page, step.locator).inputValue();
            if (actual !== step.value) throw new StepFailure(`Expected value "${step.value}", received "${actual}"`);
            assertions.push({ name: label, status: 'passed', expected: step.value, actual });
            break;
          }
          case 'expectCount': {
            const count = await locatorFor(page, step.locator).count();
            if (count !== step.count) throw new StepFailure(`Expected ${step.count} element(s), found ${count}`);
            assertions.push({ name: label, status: 'passed', expected: String(step.count), actual: String(count) });
            break;
          }
          case 'expectNoConsoleErrors': {
            if (consoleErrors.length > 0)
              throw new StepFailure(
                `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 3).join(' | ')}`,
              );
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'expectNoFailedRequests': {
            if (failedRequests.length > 0)
              throw new StepFailure(
                `${failedRequests.length} failed request(s): ${failedRequests
                  .slice(0, 3)
                  .map((r) => r.url)
                  .join(' | ')}`,
              );
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'waitForResponse': {
            const response = await page.waitForResponse(
              (res) => res.url().includes(step.urlContains) && (!step.status || res.status() === step.status),
              { timeout: step.timeoutMs ?? 15_000 },
            );
            assertions.push({ name: label, status: 'passed', actual: `HTTP ${response.status()}` });
            break;
          }
          case 'screenshot': {
            const buffer = await page.screenshot({ fullPage: true });
            const artifact = await artifacts.write({
              runId,
              fileName: `screenshot-${step.name}.png`,
              content: buffer,
              kind: 'screenshot',
              mimeType: 'image/png',
            });
            evidence.push(artifact);
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'expectScreenshot': {
            const buffer = await page.screenshot({ fullPage: true });
            const snapshot = await artifacts.write({
              runId,
              fileName: `actual-${step.name}.png`,
              content: buffer,
              kind: 'screenshot',
              mimeType: 'image/png',
            });
            evidence.push(snapshot);
            const baselinePath = path.join(artifacts.absolute('.'), 'baselines', options.projectId, `${step.name}.png`);
            if (!fs.existsSync(baselinePath)) {
              assertions.push({
                name: label,
                status: 'unverified',
                message:
                  'No approved baseline exists. Approve this screenshot as a baseline before relying on visual regression.',
              });
              status = 'unverified';
            } else {
              const baseline = fs.readFileSync(baselinePath);
              const diffRatio = comparePng(baseline, buffer);
              if (diffRatio > step.maxDiffPixelRatio) {
                throw new StepFailure(
                  `Screenshot differs from approved baseline (${(diffRatio * 100).toFixed(2)}% pixels, limit ${(step.maxDiffPixelRatio * 100).toFixed(2)}%)`,
                );
              }
              assertions.push({
                name: label,
                status: 'passed',
                actual: `${(diffRatio * 100).toFixed(3)}% pixel difference`,
              });
            }
            break;
          }
          case 'upload': {
            await locatorFor(page, step.locator).setInputFiles(step.filePath);
            assertions.push({ name: label, status: 'passed' });
            break;
          }
          case 'expectDownload': {
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: 20_000 }),
              locatorFor(page, step.locator).click(),
            ]);
            const suggested = download.suggestedFilename().replace(/[^a-zA-Z0-9._-]/g, '_');
            const p = path.join(artifacts.runDir(runId), `download-${suggested}`);
            await download.saveAs(p);
            evidence.push({
              kind: 'json',
              name: `download-${suggested}`,
              relativePath: toPosix(path.relative(artifacts.absolute('.'), p)),
              mimeType: 'application/octet-stream',
              sizeBytes: fs.statSync(p).size,
              sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
            });
            assertions.push({ name: label, status: 'passed', actual: suggested });
            break;
          }
          case 'expectAccessible': {
            const loc = locatorFor(page, step.locator);
            const [visible, enabled] = await Promise.all([loc.isVisible(), loc.isEnabled()]);
            const name = await loc.getAttribute('aria-label');
            if (!visible) throw new StepFailure('Element is not visible');
            if (!enabled) throw new StepFailure('Element is disabled');
            assertions.push({ name: label, status: 'passed', actual: name ?? 'visible and enabled' });
            break;
          }
          default:
            throw new StepFailure(`Unsupported step ${(step as { action: string }).action}`);
        }
      } catch (error) {
        const msg = redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
        assertions.push({ name: label, status: 'failed', message: msg, durationMs: Date.now() - stepStart });
        status = 'failed';
        message = msg;
        classification = error instanceof StepFailure ? 'browser-assertion-failed' : 'browser-runtime-error';
        try {
          const buffer = await page.screenshot({ fullPage: true });
          evidence.push(
            await artifacts.write({
              runId,
              fileName: `failure-${step.action}.png`,
              content: buffer,
              kind: 'screenshot',
              mimeType: 'image/png',
            }),
          );
        } catch {
          /* page may be closed */
        }
        break;
      }
    }

    if (status === 'passed' && consoleErrors.length > 0) {
      assertions.push({
        name: 'Console errors observed',
        status: 'failed',
        actual: consoleErrors.slice(0, 5).join(' | '),
      });
      status = 'failed';
      classification = 'console-errors';
      message = message ?? `${consoleErrors.length} console error(s) were observed during the workflow.`;
    }

    if (scenario.trace) {
      const tracePath = path.join(
        artifacts.runDir(runId),
        `trace-${scenario.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`,
      );
      await context.tracing.stop({ path: tracePath });
      const buffer = fs.readFileSync(tracePath);
      evidence.push(
        await artifacts.write({
          runId,
          fileName: path.basename(tracePath),
          content: buffer,
          kind: 'trace',
          mimeType: 'application/zip',
        }),
      );
    }

    // Always capture a final screenshot for evidence on failure or when requested.
    if (
      !evidence.some((e) => e.kind === 'screenshot') &&
      (status !== 'passed' || !scenario.steps.some((s) => s.action === 'screenshot'))
    ) {
      try {
        const buffer = await page.screenshot({ fullPage: true });
        evidence.push(
          await artifacts.write({
            runId,
            fileName: 'final-state.png',
            content: buffer,
            kind: 'screenshot',
            mimeType: 'image/png',
          }),
        );
      } catch {
        /* ignore */
      }
    }

    await context.close();
  } catch (error) {
    status = (status as string) === 'timeout' ? 'timeout' : 'error';
    classification = 'browser-infrastructure-error';
    message = redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
    assertions.push({ name: 'Browser infrastructure', status: 'error', message });
  } finally {
    clearTimeout(timeoutHandle);
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }

  if (status === 'passed' && scenario.steps.length === 0) {
    status = 'unverified';
    message = 'Scenario contained no steps';
  }

  const diagnostics = {
    consoleErrors,
    pageErrors,
    failedRequests: failedRequests.slice(0, 100),
    responses: responses.filter((r) => r.status >= 400).slice(0, 100),
    environment,
  };
  if (diagnostics.consoleErrors.length + diagnostics.pageErrors.length + diagnostics.failedRequests.length > 0) {
    evidence.push(
      await artifacts.write({
        runId,
        fileName: `browser-diagnostics-${Date.now()}.json`,
        content: JSON.stringify(diagnostics, null, 2),
        kind: 'json',
        mimeType: 'application/json',
      }),
    );
  }

  return {
    key: `browser:${scenario.id ?? scenario.name}`,
    title: scenario.name,
    kind: 'browser',
    adapterId: 'browser-playwright',
    status,
    durationMs: Date.now() - started,
    assertions,
    evidence,
    classification,
    message,
  };
}

/**
 * Minimal PNG pixel comparison. Falls back to byte equality when dimensions
 * differ (always a failure) or when decompression is unavailable.
 */
function comparePng(a: Buffer, b: Buffer): number {
  if (a.equals(b)) return 0;
  try {
    // Lazy require keeps startup cheap; pngjs is a small, dependency-free decoder.
    const { PNG } = require('pngjs') as typeof PngJs;
    const imgA = PNG.sync.read(a);
    const imgB = PNG.sync.read(b);
    if (imgA.width !== imgB.width || imgA.height !== imgB.height) return 1;
    let diff = 0;
    const total = imgA.width * imgA.height;
    for (let i = 0; i < total; i += 1) {
      const idx = i * 4;
      if (
        Math.abs(imgA.data[idx]! - imgB.data[idx]!) > 8 ||
        Math.abs(imgA.data[idx + 1]! - imgB.data[idx + 1]!) > 8 ||
        Math.abs(imgA.data[idx + 2]! - imgB.data[idx + 2]!) > 8
      ) {
        diff += 1;
      }
    }
    return diff / total;
  } catch {
    return 1;
  }
}
