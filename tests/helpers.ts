import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DetectionResult, EnvironmentInfo, TestResult, VerificationRunDetail } from '@zethub/shared-types';

export function tempDir(prefix = 'zethub-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(root: string, relative: string, content: string): string {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
  return absolute;
}

export function detection(rootPath: string, overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    rootPath,
    scannedAt: new Date().toISOString(),
    ecosystems: [{ language: 'TypeScript', framework: 'Fastify', confidence: 'high', evidence: ['package.json'] }],
    packageManagers: ['npm'],
    manifests: ['package.json', 'tsconfig.json'],
    lockfiles: ['package-lock.json'],
    testTools: ['Vitest'],
    buildTools: ['npm run build'],
    tools: [
      { id: 'node-vitest', name: 'Vitest', kind: 'unit', available: true },
      { id: 'node-tsc', name: 'TypeScript compiler', kind: 'typecheck', available: true },
      { id: 'node-audit', name: 'npm audit', kind: 'dependency-audit', available: true },
    ],
    isMonorepo: false,
    subprojects: [],
    docker: { detected: false, files: [] },
    database: { detected: false, engines: [], configFiles: [], migrationDirs: [] },
    api: { detected: false, specFiles: [] },
    git: { isRepo: false },
    runtime: { node: process.version },
    warnings: [],
    unsupported: [],
    ...overrides,
  };
}

export const environment: EnvironmentInfo = {
  os: process.platform,
  arch: process.arch,
  platform: process.platform,
  node: process.version,
  hostname: 'test-host',
  appVersion: '0.1.0',
  toolVersions: {},
};

export function testResult(
  overrides: Partial<TestResult> & Pick<TestResult, 'key' | 'title' | 'kind' | 'adapterId' | 'status'>,
): TestResult {
  return {
    durationMs: 12,
    assertions: [],
    evidence: [],
    ...overrides,
  };
}

export function runDetail(overrides: Partial<VerificationRunDetail> = {}): VerificationRunDetail {
  return {
    id: 'run-test-1',
    projectId: 'project-test-1',
    planId: null,
    trigger: 'manual',
    status: 'passed',
    strategy: 'full',
    gitCommit: 'abc123',
    gitBranch: 'main',
    environment,
    counts: { total: 1, passed: 1, failed: 0, blocked: 0, unverified: 0, skipped: 0, durationMs: 12 },
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    reportId: null,
    verifiedScope: 'Synthetic test run used by the test suite.',
    remainingLimitations: ['This is synthetic data created inside a test.'],
    results: [
      testResult({
        key: 'unit:example',
        title: 'Example unit test',
        kind: 'unit',
        adapterId: 'javascript',
        status: 'passed',
      }),
    ],
    planSnapshot: null,
    logs: [],
    ...overrides,
  };
}
