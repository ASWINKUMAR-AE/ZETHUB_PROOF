import fs from 'node:fs';
import path from 'node:path';
import type { DetectionResult, TestCasePlan, TestKind, TestPlan } from '@zethub/shared-types';
import { commandAdapters, SECRET_SCAN_ADAPTER_ID, BUILTIN_ADAPTER_ID } from '../adapters/index.js';
import type { AdapterContext } from '../adapters/types.js';
import { makeCase } from '../adapters/types.js';
import { toPosix } from '../utils/paths.js';
import { randomUUID } from 'node:crypto';

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'e2e', 'integration', 'unit', 'src']);
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'vendor',
  '.venv',
  'venv',
  'coverage',
  '.next',
  'artifacts',
]);

export function listTestFiles(root: string, limit = 400): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        if (!TEST_DIRS.has(entry.name) && depth >= 2 && !/test|spec|e2e/i.test(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && isTestFile(entry.name)) {
        out.push(toPosix(path.relative(root, path.join(dir, entry.name))));
      }
    }
  };
  walk(root, 0);
  return out;
}

export function isTestFile(name: string): boolean {
  return (
    /\.(test|spec)\.(t|j)sx?$|(^test_.*|_test)\.py$|Tests?\.(java|kt|cs|php)$|_test\.go$|\.feature$/.test(name) ||
    /^(test|tests)\.(py|js|ts)$/.test(name)
  );
}

export interface BuildPlanOptions {
  projectId: string;
  detection: DetectionResult;
  strategy?: 'full' | 'changed' | 'selected';
  extraCases?: TestCasePlan[];
  excludedKeys?: string[];
  maxTimeoutMs?: number;
  includeSecretScan?: boolean;
  packageManager?: string;
}

export function buildVerificationPlan(options: BuildPlanOptions): TestPlan {
  const { detection } = options;
  const testFiles = listTestFiles(detection.rootPath);
  const ctx: AdapterContext = {
    projectId: options.projectId,
    projectRoot: detection.rootPath,
    detection,
    testFiles,
    settings: { packageManager: options.packageManager, maxTimeoutMs: options.maxTimeoutMs ?? 900_000 },
  };
  const cases: TestCasePlan[] = [];
  for (const adapter of commandAdapters) {
    if (!adapter.detect(ctx)) continue;
    try {
      for (const c of adapter.plan(ctx)) cases.push(c);
    } catch (error) {
      // Never let one adapter break plan creation.
      cases.push(
        makeCase({
          key: `${adapter.id}:plan-error`,
          title: `${adapter.name} plan generation failed`,
          kind: 'static-analysis',
          adapterId: adapter.id,
          reason: error instanceof Error ? error.message : String(error),
          priority: 1,
        }),
      );
    }
  }

  // Draft a case for each unavailable detected tool so the limitation is visible.
  for (const tool of detection.tools) {
    if (tool.available || !['unit', 'build'].includes(tool.kind)) continue;
    const already = cases.some((c) => c.key.includes(tool.id));
    if (already) continue;
    cases.push(
      makeCase({
        key: `blocked:${tool.id}`,
        title: `${tool.name} unavailable`,
        kind: tool.kind,
        adapterId: 'zethub-builtin',
        reason: tool.reason ?? 'Required runtime not available.',
        priority: 5,
        tags: ['blocked'],
      }),
    );
  }

  if (options.includeSecretScan !== false) {
    cases.push(
      makeCase({
        key: 'builtin:secret-scan',
        title: 'Secret scan (built-in)',
        kind: 'secret-scan',
        adapterId: SECRET_SCAN_ADAPTER_ID,
        source: 'detected',
        reason: 'Scans tracked project text files for high-confidence credential patterns. Read-only.',
        priority: 58,
        requiresApproval: false,
        timeoutMs: 120_000,
        tags: ['security'],
      }),
    );
    cases.push(
      makeCase({
        key: 'builtin:artifact-inspection',
        title: 'Build artifact inspection',
        kind: 'static-analysis',
        adapterId: BUILTIN_ADAPTER_ID,
        source: 'detected',
        reason: 'Inspects common build output directories for suspicious or missing artifacts. Read-only.',
        priority: 20,
        requiresApproval: false,
        timeoutMs: 60_000,
        tags: ['build'],
      }),
    );
  }

  const extra = options.extraCases ?? [];
  for (const c of extra) cases.push(c);
  const excluded = new Set(options.excludedKeys ?? []);
  const seen = new Set<string>();
  const unique = cases.filter((c) => {
    if (excluded.has(c.key) || seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
  unique.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));

  const kinds = new Set(unique.map((c) => c.kind));
  const unverified: string[] = [];
  if (!kinds.has('unit') && !kinds.has('integration'))
    unverified.push('No executable unit or integration tests were proposed.');
  if (!kinds.has('browser')) unverified.push('No browser workflow is configured, so UI behavior is unverified.');
  if (!kinds.has('api')) unverified.push('No API scenarios are configured, so HTTP contracts are unverified.');
  if (!kinds.has('database'))
    unverified.push('No database checks are configured, so persistence behavior is unverified.');
  if (kinds.has('browser') || kinds.has('api') || kinds.has('database')) {
    unverified.push('Cross-layer coverage is limited to the scenarios explicitly configured for this project.');
  }

  const hasExecutableCore = kinds.has('unit') || kinds.has('integration') || kinds.has('build');
  const hasStatic = kinds.has('lint') || kinds.has('typecheck');
  const coverageConfidence: TestPlan['coverageConfidence'] =
    hasExecutableCore && hasStatic ? 'high' : hasExecutableCore ? 'medium' : 'low';

  const notes: string[] = [];
  if (detection.isMonorepo)
    notes.push(
      `Monorepo detected with ${detection.subprojects.length} nested package manifest(s). Cases currently target the repository root; add nested commands explicitly for deeper coverage.`,
    );
  if (unique.some((c) => c.tags.includes('blocked')))
    notes.push(
      'Some detected tools are unavailable in the current environment and are reported as blocked, not passed.',
    );
  if (unique.some((c) => c.kind === 'dependency-audit'))
    notes.push(
      'Dependency audit output depends on registry access and advisory databases; offline audits may be incomplete.',
    );

  return {
    id: randomUUID(),
    projectId: options.projectId,
    createdAt: new Date().toISOString(),
    strategy: options.strategy ?? 'full',
    cases: unique,
    notes,
    coverageConfidence,
    unverifiedAreas: [...new Set(unverified)],
  };
}

export function summarizePlan(plan: TestPlan): {
  total: number;
  byKind: Record<string, number>;
  approvalRequired: number;
} {
  const byKind: Record<string, number> = {};
  for (const c of plan.cases) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  return { total: plan.cases.length, byKind, approvalRequired: plan.cases.filter((c) => c.requiresApproval).length };
}

export const KIND_LABELS: Record<TestKind, string> = {
  lint: 'Lint',
  typecheck: 'Type check',
  format: 'Format',
  unit: 'Unit tests',
  integration: 'Integration tests',
  build: 'Build',
  browser: 'Browser workflow',
  api: 'API contract',
  database: 'Database check',
  security: 'Security',
  performance: 'Performance',
  'dependency-audit': 'Dependency audit',
  'secret-scan': 'Secret scan',
  'static-analysis': 'Static analysis',
};
