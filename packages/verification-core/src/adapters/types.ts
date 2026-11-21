import type { DetectionResult, TestCasePlan, TestKind } from '@zethub/shared-types';

export interface AdapterContext {
  projectId: string;
  projectRoot: string;
  detection: DetectionResult;
  /** Findings from lightweight source scanning (test file list). */
  testFiles: string[];
  settings: {
    packageManager?: string;
    maxTimeoutMs: number;
  };
}

export interface VerificationAdapter {
  id: string;
  name: string;
  version: string;
  supports: TestKind[];
  prerequisites: string[];
  detect(ctx: AdapterContext): boolean;
  plan(ctx: AdapterContext): TestCasePlan[];
}

export function pmRunScript(packageManager: string, script: string): { executable: string; args: string[] } {
  switch (packageManager) {
    case 'pnpm':
      return { executable: 'pnpm', args: [script] };
    case 'yarn':
      return { executable: 'yarn', args: [script] };
    case 'bun':
      return { executable: 'bun', args: ['run', script] };
    default:
      return { executable: 'npm', args: ['run', script] };
  }
}

export function makeCase(
  partial: Partial<TestCasePlan> & Pick<TestCasePlan, 'key' | 'title' | 'kind' | 'adapterId'>,
): TestCasePlan {
  return {
    source: 'detected',
    reason: '',
    timeoutMs: 300_000,
    requiresApproval: true,
    mappedFiles: [],
    tags: [],
    priority: 50,
    ...partial,
  };
}
