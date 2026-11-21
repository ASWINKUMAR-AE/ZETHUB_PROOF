import { describe, expect, it } from 'vitest';
import { buildReport, renderJUnit } from '@zethub/verification-core';
import { runDetail, testResult } from '../helpers';

const evidence = {
  kind: 'json' as const,
  name: 'result.json',
  relativePath: 'runs/run-test-1/result.json',
  mimeType: 'application/json',
  sizeBytes: 2,
  sha256: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
};

const run = runDetail({
  status: 'failed',
  counts: { total: 2, passed: 1, failed: 1, blocked: 0, unverified: 0, skipped: 0, durationMs: 24 },
  results: [
    testResult({ key: 'unit:pass', title: 'Passing <check>', kind: 'unit', adapterId: 'javascript', status: 'passed' }),
    testResult({
      key: 'unit:fail',
      title: 'Failing check',
      kind: 'unit',
      adapterId: 'javascript',
      status: 'failed',
      assertions: [{ name: 'expected value', status: 'failed', expected: '3', actual: '4' }],
      evidence: [evidence],
      message: 'Expected 3 but received 4',
      stdout: 'assertion output',
    }),
  ],
});

describe('evidence passport report', () => {
  const bundle = buildReport({
    run,
    projectName: '<Project & Co>',
    projectId: 'project-test-1',
    plan: null,
    signingSecret: 'test-signing-secret',
  });

  it('produces JSON, HTML and JUnit files', () => {
    expect(bundle.verificationId).toBe(run.id);
    expect(JSON.parse(bundle.json).run.id).toBe(run.id);
    expect(bundle.html).toContain('<!doctype html>');
    expect(bundle.junit).toContain('<testsuites>');
  });

  it('escapes untrusted names in HTML and XML', () => {
    expect(bundle.html).toContain('&lt;Project &amp; Co&gt;');
    expect(bundle.html).not.toContain('<Project & Co>');
    expect(bundle.junit).toContain('Passing &lt;check&gt;');
    expect(bundle.junit).toContain('<failure');
  });

  it('records artifact hashes in the signed manifest', () => {
    expect(bundle.manifest.artifactHashes['unit:fail/result.json']).toBe(evidence.sha256);
    expect(bundle.manifest.signed.algorithm).toBe('sha256');
    expect(bundle.manifest.signed.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.manifest.disclaimer).toContain('do not independently prove');
  });

  it('reports accurate JUnit counters', () => {
    const junit = renderJUnit(run);
    expect(junit).toContain('tests="2"');
    expect(junit).toContain('failures="1"');
    expect(junit).toContain('errors="0"');
    expect(junit).toContain('skipped="0"');
  });

  it('is stable for the same input but detects changes to artifact hashes', () => {
    const same = buildReport({
      run,
      projectName: '<Project & Co>',
      projectId: 'project-test-1',
      plan: null,
      signingSecret: 'test-signing-secret',
    });
    expect(same.manifest.artifactHashes).toEqual(bundle.manifest.artifactHashes);
    const tampered = { ...run, results: [{ ...run.results[1]!, evidence: [{ ...evidence, sha256: 'b'.repeat(64) }] }] };
    const changed = buildReport({
      run: tampered,
      projectName: 'x',
      projectId: 'project-test-1',
      plan: null,
      signingSecret: 'test-signing-secret',
    });
    expect(changed.manifest.artifactHashes['unit:fail/result.json']).not.toBe(
      bundle.manifest.artifactHashes['unit:fail/result.json'],
    );
    expect(changed.manifest.signed.digest).not.toBe(bundle.manifest.signed.digest);
  });
});
