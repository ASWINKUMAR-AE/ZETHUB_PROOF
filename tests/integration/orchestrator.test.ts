import { describe, expect, it } from 'vitest';
import { TestPlanSchema } from '@zethub/shared-types';
import { EvidenceStore, executePlan } from '@zethub/verification-core';
import { tempDir, writeFile } from '../helpers';

describe('plan orchestration', () => {
  it('runs artifact inspection after a build-producing case, even with parallelism', async () => {
    const root = tempDir('zethub-orchestrator-');
    writeFile(root, 'package.json', '{"name":"fixture"}\n');

    const plan = TestPlanSchema.parse({
      id: 'plan-orchestrator',
      projectId: 'project-orchestrator',
      createdAt: new Date().toISOString(),
      strategy: 'selected',
      coverageConfidence: 'high',
      // Intentional order: artifact inspection is first, so a scheduler that
      // respects only plan order would inspect the workspace too early.
      cases: [
        {
          key: 'builtin:artifact-inspection',
          title: 'Build artifact inspection',
          kind: 'static-analysis',
          adapterId: 'zethub-builtin',
          priority: 100,
        },
        {
          key: 'build:fixture',
          title: 'Fixture build',
          kind: 'build',
          adapterId: 'javascript',
          priority: 50,
          command: {
            executable: process.execPath,
            args: [
              '-e',
              "setTimeout(() => { require('fs').mkdirSync('dist', { recursive: true }); require('fs').writeFileSync('dist/app.js', 'ok'); }, 250)",
            ],
            cwd: root,
          },
        },
      ],
    });

    const result = await executePlan({
      runId: 'run-orchestrator',
      projectId: 'project-orchestrator',
      projectRoot: root,
      plan,
      artifacts: new EvidenceStore(tempDir('zethub-orchestrator-evidence-')),
      approvals: 'all',
      concurrency: 2,
    });

    const artifact = result.results.find((item) => item.key === 'builtin:artifact-inspection');
    expect(artifact?.status).toBe('passed');
    expect(artifact?.classification).toBe('artifacts-present');
    expect(result.results.find((item) => item.key === 'build:fixture')?.status).toBe('passed');
  });
});
