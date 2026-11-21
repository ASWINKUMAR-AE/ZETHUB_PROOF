import { describe, expect, it } from 'vitest';
import { auditTestQuality, detectFlakiness } from '@zethub/verification-core';
import { tempDir, writeFile } from '../helpers';

describe('test quality auditor', () => {
  const root = tempDir('zethub-quality-');
  writeFile(
    root,
    'tests/quality.test.ts',
    [
      "it('covers behavior', () => expect(1 + 1).toBe(2));",
      "it.skip('disabled test', () => expect(1).toBe(1));",
      "it('empty test', () => {});",
      "it('constant assertion', () => { expect(true).toBe(true); });",
      "it('sleeps', async () => { await page.waitForTimeout(750); expect(1).toBe(1); });",
      "it('handles invalid input', () => { try { broken(); } catch (error) {} expect(error).toBeDefined(); });",
    ].join('\n'),
  );

  const audit = auditTestQuality({ rootPath: root, files: ['tests/quality.test.ts'] });
  const categories = audit.findings.map((f) => f.category);

  it('finds skipped, empty, weak and slow tests', () => {
    expect(audit.filesAnalyzed).toBe(1);
    expect(audit.testsAnalyzed).toBe(6);
    expect(categories).toContain('skipped-test');
    expect(categories).toContain('missing-assertion');
    expect(categories).toContain('weak-assertion');
    expect(categories).toContain('hardcoded-timeout');
    expect(categories).toContain('broad-catch');
  });

  it('states that findings are heuristics, not proof', () => {
    expect(audit.limitations.join(' ')).toMatch(/heuristic/i);
    expect(audit.findings.every((f) => f.id && f.message && f.suggestion)).toBe(true);
  });

  it('flags duplicate test names across files', () => {
    writeFile(root, 'tests/duplicate.test.ts', "it('covers behavior', () => expect(2).toBe(2));\n");
    const duplicateAudit = auditTestQuality({
      rootPath: root,
      files: ['tests/quality.test.ts', 'tests/duplicate.test.ts'],
    });
    expect(duplicateAudit.findings.some((f) => f.category === 'duplicate-test')).toBe(true);
  });

  it('turns real run-history alternations into a flaky finding', () => {
    const history = detectFlakiness([
      { testName: 'flaky', status: 'passed' },
      { testName: 'flaky', status: 'failed' },
      { testName: 'flaky', status: 'passed' },
      { testName: 'flaky', status: 'failed' },
    ]);
    expect(history).toEqual([{ testName: 'flaky', alternations: 3, runs: 4 }]);
    const withHistory = auditTestQuality({ rootPath: root, files: ['tests/quality.test.ts'], flakyTests: history });
    expect(withHistory.findings.some((f) => f.category === 'flaky-history')).toBe(true);
  });
});
