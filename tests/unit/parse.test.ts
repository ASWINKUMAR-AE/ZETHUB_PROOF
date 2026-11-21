import { describe, expect, it } from 'vitest';
import { classifyFailure, parseTestOutput } from '@zethub/verification-core';

describe('parseTestOutput', () => {
  it('parses a passing Vitest summary', () => {
    const parsed = parseTestOutput('unit', ' Tests  3 passed (3)\n', '');
    expect(parsed.counts).toEqual({ passed: 3, failed: 0, skipped: 0, total: 3 });
    expect(parsed.classification).toBe('tests-passed');
    expect(parsed.evidenceOfExecution).toBe(true);
  });

  it('parses a failing Vitest summary and lists failing tests', () => {
    const parsed = parseTestOutput(
      'unit',
      'Tests  1 failed | 2 passed (3)\n FAIL  tests/add.test.ts > adds numbers\n',
      '',
    );
    expect(parsed.counts).toEqual({ passed: 2, failed: 1, skipped: 0, total: 3 });
    expect(parsed.classification).toBe('test-failure');
    expect(parsed.assertions.some((a) => a.name.includes('adds numbers'))).toBe(true);
  });

  it('aggregates multiple Vitest summaries from a chained test script', () => {
    const parsed = parseTestOutput(
      'unit',
      ' Tests  72 passed (72)\n\n Tests  23 passed (23)\n\n Tests  12 passed (12)\n',
      '',
    );
    expect(parsed.counts).toEqual({ passed: 107, failed: 0, skipped: 0, total: 107 });
  });

  it('labels Playwright output as Playwright rather than pytest', () => {
    const parsed = parseTestOutput('browser', '\n  10 passed (32.0s)\n', '');
    expect(parsed.counts).toEqual({ passed: 10, failed: 0, skipped: 0, total: 10 });
    expect(parsed.assertions[0]?.name).toBe('playwright test execution');
  });

  it('parses pytest output', () => {
    const parsed = parseTestOutput('unit', '==== 2 passed, 1 failed in 0.12s ====', '');
    expect(parsed.counts).toMatchObject({ passed: 2, failed: 1 });
    expect(parsed.evidenceOfExecution).toBe(true);
  });

  it('parses cargo output including ignored tests', () => {
    const parsed = parseTestOutput('unit', 'test result: ok. 5 passed; 0 failed; 1 ignored', '');
    expect(parsed.counts).toEqual({ passed: 5, failed: 0, skipped: 1, total: 6 });
  });

  it('parses JUnit XML', () => {
    const xml = '<testsuites><testsuite tests="2" failures="1" errors="0" skipped="0"></testsuite></testsuites>';
    const parsed = parseTestOutput('integration', xml, '');
    expect(parsed.counts).toEqual({ passed: 1, failed: 1, skipped: 0, total: 2 });
    expect(parsed.classification).toBe('test-failure');
  });

  it('does not treat unrecognizable output as a pass', () => {
    const parsed = parseTestOutput('unit', 'All good, trust me', '');
    expect(parsed.evidenceOfExecution).toBe(false);
    expect(parsed.classification).toBe('no-test-evidence');
    expect(parsed.assertions).toEqual([]);
  });

  it('fails typecheck output with TypeScript diagnostics', () => {
    const parsed = parseTestOutput('typecheck', 'src/index.ts(1,1): error TS2322: bad type', '');
    expect(parsed.assertions[0]?.status).toBe('failed');
    expect(parsed.classification).toBe('typecheck-errors');
  });

  it('passes a clean lint run', () => {
    const parsed = parseTestOutput('lint', 'no issues found', '');
    expect(parsed.assertions[0]?.status).toBe('passed');
    expect(parsed.classification).toBe('clean');
  });

  it('detects build failures', () => {
    const parsed = parseTestOutput('build', 'error TS1005: expected ;', '');
    expect(parsed.assertions[0]?.status).toBe('failed');
    expect(parsed.classification).toBe('build-failure');
  });

  it('parses npm audit totals', () => {
    const stdout = JSON.stringify({
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 } },
    });
    const parsed = parseTestOutput('dependency-audit', stdout, '');
    expect(parsed.assertions[0]).toMatchObject({
      name: 'Known vulnerable dependencies',
      status: 'failed',
      actual: '2',
    });
    expect(parsed.classification).toBe('dependency-vulnerabilities');
  });

  it('marks unparseable audit JSON as unverified rather than passed', () => {
    const parsed = parseTestOutput('dependency-audit', 'not json', '');
    expect(parsed.evidenceOfExecution).toBe(false);
    expect(parsed.classification).toBe('audit-output-unparsed');
  });
});

describe('classifyFailure', () => {
  it('classifies missing executables and port conflicts', () => {
    const empty = parseTestOutput('unit', '', '');
    expect(classifyFailure(empty, 1, 'spawn npm ENOENT')).toBe('missing-prerequisite');
    expect(classifyFailure(empty, 1, 'listen EADDRINUSE: address already in use')).toBe('environment-port-conflict');
    expect(classifyFailure(empty, 1, 'something else broke')).toBe('command-failed');
  });
});
