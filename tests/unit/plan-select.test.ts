import { describe, expect, it } from 'vitest';
import { buildVerificationPlan, evaluateSelectionMisses, isRiskyChange, selectTests } from '@zethub/verification-core';
import type { TestCasePlan } from '@zethub/shared-types';
import { detection, tempDir, writeFile } from '../helpers';

describe('buildVerificationPlan', () => {
  const root = tempDir('zethub-plan-');
  writeFile(
    root,
    'package.json',
    JSON.stringify({
      name: 'fixture',
      scripts: {
        test: 'vitest run',
        'test:unit': 'vitest run unit',
        build: 'tsc -p .',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      },
      devDependencies: { vitest: '3.2.4', typescript: '5.8.3' },
    }),
  );
  writeFile(root, 'tsconfig.json', '{}');
  writeFile(
    root,
    'tests/example.test.ts',
    "import { it, expect } from 'vitest';\nit('works', () => expect(1).toBe(1));\n",
  );

  const plan = buildVerificationPlan({ projectId: 'p1', detection: detection(root) });
  const keys = plan.cases.map((c) => c.key);

  it('plans the detected package scripts', () => {
    expect(keys).toContain('js:test');
    expect(keys).toContain('js:test:unit');
    expect(keys).toContain('js:build');
    expect(keys).toContain('js:lint');
    expect(keys).toContain('js:typecheck');
  });

  it('always adds built-in safety checks', () => {
    expect(keys).toContain('builtin:secret-scan');
    expect(keys).toContain('builtin:artifact-inspection');
    expect(plan.cases.find((c) => c.key === 'builtin:secret-scan')?.requiresApproval).toBe(false);
  });

  it('maps the discovered test file to test cases', () => {
    const unit = plan.cases.find((c) => c.key === 'js:test:unit');
    expect(unit?.mappedFiles).toContain('tests/example.test.ts');
    expect(unit?.command?.executable).toBe('npm');
    expect(unit?.command?.args).toEqual(['run', 'test:unit']);
  });

  it('reports the monorepo note and coverage confidence honestly', () => {
    const monorepo = buildVerificationPlan({
      projectId: 'p2',
      detection: detection(root, {
        isMonorepo: true,
        subprojects: [
          { name: 'api', relPath: 'apps/api', languages: ['TypeScript'], frameworks: [], manifests: ['package.json'] },
        ],
      }),
    });
    expect(monorepo.notes.some((n) => n.includes('Monorepo'))).toBe(true);
    expect(monorepo.coverageConfidence).toBe('high');
    expect(monorepo.unverifiedAreas.some((a) => a.includes('browser'))).toBe(true);
  });

  it('deduplicates extra user cases by key', () => {
    const extra: TestCasePlan = {
      key: 'js:test',
      title: 'Custom override',
      kind: 'unit',
      adapterId: 'user-command',
      source: 'user',
      reason: 'custom',
      timeoutMs: 10_000,
      requiresApproval: true,
      mappedFiles: [],
      tags: [],
      priority: 100,
    };
    const withExtra = buildVerificationPlan({ projectId: 'p3', detection: detection(root), extraCases: [extra] });
    expect(withExtra.cases.filter((c) => c.key === 'js:test')).toHaveLength(1);
    expect(withExtra.cases.find((c) => c.key === 'js:test')?.title).toBe('JavaScript test suite');
  });
});

describe('dependency-aware selection', () => {
  const root = tempDir('zethub-select-');
  writeFile(root, 'src/math.ts', 'export const add = (a: number, b: number) => a + b;\n');
  writeFile(
    root,
    'tests/math.test.ts',
    "import { add } from '../src/math';\nit('adds', () => expect(add(1, 2)).toBe(3));\n",
  );
  writeFile(root, 'tests/other.test.ts', "it('other', () => expect(true).toBe(true));\n");

  const cases: TestCasePlan[] = [
    {
      key: 'unit:math',
      title: 'Math tests',
      kind: 'unit',
      adapterId: 'javascript',
      source: 'detected',
      reason: '',
      timeoutMs: 10_000,
      requiresApproval: false,
      mappedFiles: ['tests/math.test.ts'],
      tags: [],
      priority: 70,
    },
    {
      key: 'unit:other',
      title: 'Other tests',
      kind: 'unit',
      adapterId: 'javascript',
      source: 'detected',
      reason: '',
      timeoutMs: 10_000,
      requiresApproval: false,
      mappedFiles: ['tests/other.test.ts'],
      tags: [],
      priority: 60,
    },
  ];
  const plan = {
    id: 'plan-1',
    projectId: 'p1',
    createdAt: new Date().toISOString(),
    strategy: 'full' as const,
    cases,
    notes: [],
    coverageConfidence: 'high' as const,
    unverifiedAreas: [],
  };

  it('selects the test that imports a changed source file', () => {
    const result = selectTests(plan, root, { changedFiles: ['src/math.ts'] });
    expect(result.fallbackRequired).toBe(false);
    expect(result.plan.strategy).toBe('changed');
    expect(result.plan.cases.map((c) => c.key)).toEqual(['unit:math']);
    expect(result.selections[0]?.reasons.join(' ')).toContain('Import dependency');
  });

  it('always retains the secret scan even when source changes', () => {
    const withScan: TestCasePlan[] = [
      ...cases,
      {
        key: 'builtin:secret-scan',
        title: 'Secret scan',
        kind: 'secret-scan',
        adapterId: 'zethub-secret-scan',
        source: 'detected',
        reason: '',
        timeoutMs: 10_000,
        requiresApproval: false,
        mappedFiles: [],
        tags: [],
        priority: 58,
      },
    ];
    const result = selectTests({ ...plan, cases: withScan }, root, { changedFiles: ['src/math.ts'] });
    expect(result.plan.cases.map((c) => c.key)).toContain('builtin:secret-scan');
  });

  it('forces the full plan when there are no changed files', () => {
    const result = selectTests(plan, root, { changedFiles: [] });
    expect(result.plan.strategy).toBe('full');
    expect(result.plan.cases).toHaveLength(2);
  });

  it('falls back when no case maps to the change', () => {
    const result = selectTests(plan, root, { changedFiles: ['src/unrelated.ts'] });
    expect(result.fallbackRequired).toBe(true);
    expect(result.plan.strategy).toBe('full');
  });

  it('measures failures missed by a reduced selection', () => {
    const misses = evaluateSelectionMisses(
      [
        { key: 'a', status: 'passed' },
        { key: 'b', status: 'failed' },
        { key: 'c', status: 'failed' },
      ],
      ['a', 'b'],
    );
    expect(misses).toEqual({ missedFailures: 1, missedKeys: ['c'], totalFailures: 2 });
  });

  it('flags risky dependency and security changes', () => {
    expect(isRiskyChange(['package-lock.json']).risky).toBe(true);
    expect(isRiskyChange(['prisma/migrations/001/migration.sql']).risky).toBe(true);
    expect(isRiskyChange(['src/auth/session.ts']).risky).toBe(true);
    expect(isRiskyChange(['README.md']).risky).toBe(false);
  });
});
