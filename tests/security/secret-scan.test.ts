import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvidenceStore,
  inspectArtifacts,
  isEnvFileIgnored,
  runSecretScan,
  scanForSecrets,
} from '@zethub/verification-core';
import { tempDir, writeFile } from '../helpers';

const AWS_KEY = 'AKIA' + 'Q'.repeat(16);
const ENV_SECRET = 'super-secret-value-that-must-not-leak';

describe('secret scanning', () => {
  it('finds high-confidence credential patterns without echoing the value', () => {
    const root = tempDir('zethub-secrets-');
    writeFile(root, 'src/config.ts', `export const key = '${AWS_KEY}';\nexport const ok = true;\n`);
    // zethub-secret-scan:ignore-next-line test-only fixture
    writeFile(root, 'keys/server.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n');

    const result = scanForSecrets(root);
    const ids = result.findings.map((f) => f.ruleId);
    expect(ids).toContain('aws-access-key');
    expect(ids).toContain('private-key');
    expect(result.findings.every((f) => f.severity === 'high')).toBe(true);
    for (const finding of result.findings) {
      expect(finding.preview).not.toContain(AWS_KEY);
    }
  });

  it('ignores placeholder assignments', () => {
    const root = tempDir('zethub-placeholders-');
    writeFile(
      root,
      'src/env.ts',
      [
        "const password = 'changeme-please-123';",
        "const apiKey = '${process.env.API_KEY}';",
        "const token = 'your-token-here';",
      ].join('\n'),
    );

    const result = scanForSecrets(root);
    expect(result.findings.filter((f) => f.ruleId === 'generic-assignment')).toHaveLength(0);
  });

  it('does not report connection URLs assembled from variables', () => {
    const root = tempDir('zethub-db-template-');
    writeFile(
      root,
      'src/config.ts',
      'export const url = `mysql://${user}:${password}@localhost:3306/app`;\n' +
        "export const fixed = 'mysql://app:hunter2-real-secret@localhost:3306/app';\n", // zethub-secret-scan:ignore test fixture
    );

    const result = scanForSecrets(root);
    const urls = result.findings.filter((f) => f.ruleId === 'db-credential');
    expect(urls).toHaveLength(1);
    expect(urls[0]?.preview).toContain('***REDACTED***');
  });

  it('honours explicit suppression comments for documented fixtures', () => {
    const root = tempDir('zethub-suppression-');
    writeFile(
      root,
      'src/fixture.ts',
      [
        "const password = 'documented-test-value'; // zethub-secret-scan:ignore test fixture",
        '// zethub-secret-scan:ignore-next-line test fixture',
        "const token = 'another-test-value';",
        "const password = 'unsuppressed-real-value';", // zethub-secret-scan:ignore test fixture
      ].join('\n'),
    );

    const result = scanForSecrets(root);
    expect(result.suppressedLines).toBe(2);
    expect(result.findings.filter((f) => f.ruleId === 'generic-assignment')).toHaveLength(1);
    expect(result.findings[0]?.line).toBe(4);
  });

  it('skips env file contents and flags unprotected env files', () => {
    const root = tempDir('zethub-env-unprotected-');
    writeFile(root, '.env', `DB_PASSWORD=${ENV_SECRET}\n`);
    writeFile(root, 'app.ts', 'export const x = 1;\n');

    const result = scanForSecrets(root);
    expect(result.envFiles).toEqual(['.env']);
    expect(result.findings.some((f) => f.ruleId === 'unprotected-env-file')).toBe(true);
    expect(JSON.stringify(result.findings)).not.toContain(ENV_SECRET);
  });

  it('treats env files covered by .gitignore as protected', () => {
    const root = tempDir('zethub-env-protected-');
    writeFile(root, '.gitignore', 'node_modules/\n.env\n.env.*.local\n');
    writeFile(root, '.env', `DB_PASSWORD=${ENV_SECRET}\n`);
    writeFile(root, 'packages/api/.env', 'TOKEN=another-local-value\n');

    const result = scanForSecrets(root);
    expect(result.envFiles.sort()).toEqual(['.env', 'packages/api/.env']);
    expect(result.findings.filter((f) => f.ruleId === 'unprotected-env-file')).toHaveLength(0);
  });

  it('flags nested env files not covered by a root-only rule', () => {
    const root = tempDir('zethub-env-nested-');
    writeFile(root, '.gitignore', '.env\n');
    writeFile(root, '.env.local', 'TOKEN=local-value\n');

    const result = scanForSecrets(root);
    const unprotected = result.findings.filter((f) => f.ruleId === 'unprotected-env-file').map((f) => f.file);
    expect(unprotected).toEqual(['.env.local']);
  });

  it('matches ignore patterns against basenames and paths', () => {
    expect(isEnvFileIgnored('.env', ['.env'])).toBe(true);
    expect(isEnvFileIgnored('apps/web/.env', ['.env'])).toBe(true);
    expect(isEnvFileIgnored('apps/web/.env', ['apps/web/.env'])).toBe(true);
    expect(isEnvFileIgnored('apps/web/.env.production', ['.env'])).toBe(false);
    expect(isEnvFileIgnored('apps/web/.env.production', ['**/.env*'])).toBe(true);
    expect(isEnvFileIgnored('.env.local', ['.env.*.local'])).toBe(false);
    expect(isEnvFileIgnored('.env.local', ['.env.*'])).toBe(true);
  });

  it('writes evidence that reports env protection without leaking values', async () => {
    const root = tempDir('zethub-secrets-run-');
    writeFile(root, '.gitignore', '.env\n');
    writeFile(root, '.env', `DB_PASSWORD=${ENV_SECRET}\n`);
    writeFile(root, 'src/app.ts', 'export const ok = 1;\n');
    const store = new EvidenceStore(tempDir('zethub-artifacts-'));

    const result = await runSecretScan(root, 'run-security-1', store);
    expect(result.status).toBe('passed');
    expect(
      result.assertions.some((a) => a.name === 'Local env files ignored by version control' && a.status === 'passed'),
    ).toBe(true);
    expect(result.evidence).toHaveLength(1);
    const artifact = result.evidence[0]!;
    const content = store.read(artifact.relativePath).toString('utf8');
    expect(content).not.toContain(ENV_SECRET);
    const parsed = JSON.parse(content);
    expect(parsed.envFiles).toEqual([{ file: '.env', ignored: true }]);
    expect(parsed.limitations.join(' ')).toContain('.env');
    expect(artifact.sha256).toHaveLength(64);
  });

  it('fails the run when an env file is unprotected', async () => {
    const root = tempDir('zethub-secrets-fail-');
    writeFile(root, '.env', `DB_PASSWORD=${ENV_SECRET}\n`);
    const store = new EvidenceStore(tempDir('zethub-artifacts-'));

    const result = await runSecretScan(root, 'run-security-2', store);
    expect(result.status).toBe('failed');
    expect(result.classification).toBe('secrets-detected');
    expect(
      result.assertions.some((a) => a.name === 'Local env files ignored by version control' && a.status === 'failed'),
    ).toBe(true);
  });

  it('reports artifact directories factually', async () => {
    const root = tempDir('zethub-artifacts-scan-');
    const store = new EvidenceStore(tempDir('zethub-artifacts-'));

    const missing = await inspectArtifacts(root, 'run-artifacts-1', store);
    expect(missing.status).toBe('unverified');
    expect(missing.classification).toBe('artifacts-missing');

    writeFile(root, 'dist/app.js', 'console.log(1);\n');
    const present = await inspectArtifacts(root, 'run-artifacts-2', store);
    expect(present.status).toBe('passed');
    expect(present.classification).toBe('artifacts-present');
    const parsed = JSON.parse(store.read(present.evidence[0]!.relativePath).toString('utf8'));
    expect(parsed.found[0].dir).toBe('dist');
    expect(parsed.found[0].files).toBe(1);

    writeFile(root, 'apps/web/dist/app.js', 'console.log(2);\n');
    const nested = await inspectArtifacts(root, 'run-artifacts-3', store);
    const nestedEvidence = JSON.parse(store.read(nested.evidence[0]!.relativePath).toString('utf8'));
    expect(nestedEvidence.found.map((item: { dir: string }) => item.dir)).toContain('apps/web/dist');
  });

  it('does not follow symlinks out of the project', () => {
    const root = tempDir('zethub-symlink-');
    const outside = tempDir('zethub-outside-');
    writeFile(outside, 'secret.ts', `export const key = '${AWS_KEY}';\n`);
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    } catch {
      return; // symlink creation is not permitted on this platform
    }

    const result = scanForSecrets(root);
    expect(result.findings).toHaveLength(0);
  });
});
