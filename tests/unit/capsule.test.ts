import { describe, expect, it } from 'vitest';
import { buildFailureCapsule, importFailureCapsule, predictClassification } from '@zethub/verification-core';
import { runDetail, testResult } from '../helpers';

const SECRET = 'capsule-plaintext-secret'; // zethub-secret-scan:ignore test-only fixture

describe('failure capsules', () => {
  const run = runDetail({ status: 'failed', gitCommit: 'deadbeef', gitBranch: 'main' });

  it('captures failure context and redacts secrets', () => {
    const result = testResult({
      key: 'unit:failed',
      title: 'Failed login',
      kind: 'unit',
      adapterId: 'javascript',
      status: 'failed',
      message: `Request failed with password: "${SECRET}"`,
      stdout: `Authorization: Bearer ${'c'.repeat(24)}`,
      stderr: `mysql://app:${SECRET}@localhost/db`,
      assertions: [{ name: 'status', status: 'failed', expected: '200', actual: '500' }],
      commandDisplay: 'npm run test:unit',
    });
    const { capsule, serialized, redactions } = buildFailureCapsule({
      run,
      project: { name: 'Demo', sourceType: 'LOCAL' },
      result,
      diff: `+ const password = '${SECRET}'`,
      changedFiles: ['src/login.ts'],
    });
    expect(capsule.test.key).toBe('unit:failed');
    expect(capsule.failure.expected).toBe('200');
    expect(capsule.reproduction.command).toBe('npm run test:unit');
    expect(capsule.changedFiles).toEqual(['src/login.ts']);
    expect(redactions).toBeGreaterThan(0);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('c'.repeat(24));
  });

  it('round-trips through import with warnings', () => {
    const result = testResult({ key: 'unit:x', title: 'X', kind: 'unit', adapterId: 'javascript', status: 'failed' });
    const { serialized } = buildFailureCapsule({ run, project: { name: 'Demo', sourceType: 'LOCAL' }, result });
    const imported = importFailureCapsule(serialized);
    expect(imported.capsule.test.key).toBe('unit:x');
    expect(imported.warnings.some((w) => w.includes('never runs commands'))).toBe(true);
  });

  it('rejects malformed capsules', () => {
    expect(() => importFailureCapsule('not json')).toThrow('not valid JSON');
    expect(() => importFailureCapsule('{"formatVersion":1}')).toThrow('failed validation');
  });

  it('classifies common failure causes', () => {
    expect(predictClassification(new Error('operation timed out'))).toBe('timeout');
    expect(predictClassification(new Error('spawn npm ENOENT'))).toBe('missing-prerequisite');
    expect(predictClassification(new Error('EACCES permission denied'))).toBe('permission-denied');
    expect(predictClassification(new Error('connect ECONNREFUSED'))).toBe('network-failure');
    expect(predictClassification(new Error('expected 3 to equal 4'))).toBe('assertion-failure');
    expect(predictClassification(new Error('unexpected state'))).toBe('runtime-error');
  });
});
