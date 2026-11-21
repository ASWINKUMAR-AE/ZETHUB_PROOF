import type { DbScenario, RunCounts, RunStatus, TestPlan, TestResult } from '@zethub/shared-types';
import { type EvidenceStore } from '../evidence/store.js';
import { runBrowserScenario } from '../browser/runner.js';
import { runApiScenario } from '../api/runner.js';
import { runDbScenario, type DbConnectionConfig } from '../database/runner.js';
import { executeCommandCase } from './command.js';
import { inspectArtifacts, runSecretScan } from '../security/scan.js';
import { predictClassification } from '../repair/classify.js';

export interface ExecutePlanOptions {
  runId: string;
  projectId: string;
  projectRoot: string;
  plan: TestPlan;
  artifacts: EvidenceStore;
  /** 'all' approves every command; a Set approves specific keys. */
  approvals: 'all' | 'none' | Set<string>;
  signal?: AbortSignal;
  variables?: Record<string, string>;
  secrets?: Record<string, string>;
  /** DB integration lookup by integration id. Credentials are resolved by the backend. */
  dbConnections?: Record<string, DbConnectionConfig>;
  writesConfirmed?: Set<string>;
  concurrency?: number;
  baseUrl?: string;
  onProgress?: (event: { key: string; status: 'running' | 'completed'; result?: TestResult }) => void;
}

export interface ExecutePlanResult {
  results: TestResult[];
  counts: RunCounts;
  status: RunStatus;
  remainingLimitations: string[];
}

const SEVERITY: Record<RunStatus, number> = {
  passed: 0,
  unverified: 1,
  blocked: 2,
  cancelled: 3,
  queued: 2,
  running: 2,
  timeout: 4,
  error: 5,
  failed: 6,
};

export function countsFor(results: TestResult[], durationMs: number): RunCounts {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    unverified: results.filter((r) => r.status === 'unverified' || r.status === 'skipped').length,
    skipped: results.filter((r) => r.status === 'cancelled' || r.status === 'timeout' || r.status === 'error').length,
    durationMs,
  };
}

export function aggregateStatus(results: TestResult[]): RunStatus {
  if (results.length === 0) return 'unverified';
  const map: Record<string, RunStatus> = {
    passed: 'passed',
    failed: 'failed',
    blocked: 'blocked',
    cancelled: 'cancelled',
    timeout: 'timeout',
    error: 'error',
    skipped: 'unverified',
    unverified: 'unverified',
  };
  let status: RunStatus = 'passed';
  for (const result of results) {
    const mapped = map[result.status] ?? 'error';
    if (SEVERITY[mapped] > SEVERITY[status]) status = mapped;
  }
  return status;
}

async function pool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) await worker(item, index);
    }
  });
  await Promise.all(runners);
}

export async function executePlan(options: ExecutePlanOptions): Promise<ExecutePlanResult> {
  const started = Date.now();
  const results: TestResult[] = new Array(options.plan.cases.length);
  const limitations = new Set<string>([
    'Only the checks listed in this plan were executed. Passing tests do not prove that untested behavior works.',
    'Test tool output is normalized heuristically; consult the captured logs and evidence files for exact details.',
  ]);

  const approved = (key: string) =>
    options.approvals === 'all' || (options.approvals !== 'none' && options.approvals.has(key));

  const runCase = async (testCase: TestPlan['cases'][number], index: number) => {
    if (options.signal?.aborted) {
      results[index] = {
        key: testCase.key,
        title: testCase.title,
        kind: testCase.kind,
        adapterId: testCase.adapterId,
        status: 'cancelled',
        durationMs: 0,
        assertions: [],
        evidence: [],
        message: 'Run cancelled before this case started.',
      };
      return;
    }
    options.onProgress?.({ key: testCase.key, status: 'running' });
    let result: TestResult;
    try {
      if (testCase.adapterId === 'zethub-secret-scan') {
        result = await runSecretScan(options.projectRoot, options.runId, options.artifacts);
      } else if (testCase.adapterId === 'zethub-builtin' && testCase.key === 'builtin:artifact-inspection') {
        result = await inspectArtifacts(options.projectRoot, options.runId, options.artifacts);
      } else if (testCase.browser) {
        result = await runBrowserScenario({
          runId: options.runId,
          projectId: options.projectId,
          scenario: testCase.browser,
          artifacts: options.artifacts,
          baseUrl: options.baseUrl,
          secrets: options.secrets,
          signal: options.signal,
        });
      } else if (testCase.api) {
        result = await runApiScenario({
          runId: options.runId,
          scenario: testCase.api,
          artifacts: options.artifacts,
          variables: options.variables,
          secrets: options.secrets,
          projectRoot: options.projectRoot,
          signal: options.signal,
        });
      } else if (testCase.database) {
        const connection = options.dbConnections?.[testCase.database.integrationId];
        if (!connection) {
          result = {
            key: testCase.key,
            title: testCase.title,
            kind: 'database',
            adapterId: testCase.adapterId,
            status: 'blocked',
            durationMs: 0,
            assertions: [
              {
                name: 'Database integration',
                status: 'blocked',
                message: `Integration "${testCase.database.integrationId}" is not configured with usable credentials.`,
              },
            ],
            evidence: [],
            classification: 'integration-missing',
          };
        } else {
          result = await runDbScenario({
            runId: options.runId,
            scenario: testCase.database as DbScenario,
            connection,
            artifacts: options.artifacts,
            signal: options.signal,
            writesConfirmed: options.writesConfirmed?.has(testCase.database.integrationId) ?? false,
          });
        }
      } else {
        result = await executeCommandCase({
          runId: options.runId,
          projectRoot: options.projectRoot,
          testCase,
          artifacts: options.artifacts,
          signal: options.signal,
          approved: !testCase.requiresApproval || approved(testCase.key),
          envVars: options.variables,
        });
      }
    } catch (error) {
      result = {
        key: testCase.key,
        title: testCase.title,
        kind: testCase.kind,
        adapterId: testCase.adapterId,
        status: options.signal?.aborted ? 'cancelled' : 'error',
        durationMs: 0,
        assertions: [],
        evidence: [],
        classification: predictClassification(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
    results[index] = result;
    options.onProgress?.({ key: testCase.key, status: 'completed', result });
  };

  const indexed = options.plan.cases.map((testCase, index) => ({ testCase, index }));
  // Artifact inspection must observe the final state of the workspace, so it
  // always runs after every other case, even when parallelism is enabled.
  const deferred = indexed.filter(
    ({ testCase }) => testCase.adapterId === 'zethub-builtin' && testCase.key === 'builtin:artifact-inspection',
  );
  const primary = indexed.filter((entry) => !deferred.includes(entry));
  await pool(primary, options.concurrency ?? 1, ({ testCase, index }) => runCase(testCase, index));
  await pool(deferred, 1, ({ testCase, index }) => runCase(testCase, index));

  const finalResults = results.filter(Boolean);
  const counts = countsFor(finalResults, Date.now() - started);
  if (counts.unverified > 0)
    limitations.add(
      `${counts.unverified} case(s) produced no verifiable evidence and are marked unverified rather than passed.`,
    );
  if (counts.blocked > 0)
    limitations.add(`${counts.blocked} case(s) were blocked by missing prerequisites, approvals or configuration.`);
  if (options.plan.cases.some((c) => c.browser || c.api || c.database)) {
    limitations.add(
      'Cross-layer scenarios only verify the exact flows and endpoints configured; they are not exhaustive coverage.',
    );
  }

  return {
    results: finalResults,
    counts,
    status: aggregateStatus(finalResults),
    remainingLimitations: [...limitations],
  };
}
