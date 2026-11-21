import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EvidenceStore,
  PathPolicyError,
  normalizeUserPath,
  resolveInside,
  sha256,
  signManifest,
  toPosix,
  validateProjectPath,
} from '@zethub/verification-core';
import { tempDir } from '../helpers';

describe('path policy', () => {
  const root = path.resolve(tempDir('zethub-paths-'));

  it('resolves paths inside the root', () => {
    expect(resolveInside(root, 'runs/run-1/evidence.json')).toBe(path.join(root, 'runs', 'run-1', 'evidence.json'));
    expect(resolveInside(root, '.')).toBe(root);
  });

  it('rejects parent traversal and absolute escapes', () => {
    expect(() => resolveInside(root, '../outside.txt')).toThrow(PathPolicyError);
    expect(() => resolveInside(root, path.resolve(root, '..', 'outside.txt'))).toThrow(PathPolicyError);
  });

  it('rejects NUL bytes and control characters', () => {
    expect(() => normalizeUserPath(`bad\0path`)).toThrow(PathPolicyError);
    expect(() => normalizeUserPath('bad\npath')).toThrow(PathPolicyError);
  });

  it('accepts a normal absolute project path', () => {
    expect(validateProjectPath(root)).toBe(path.normalize(root));
  });

  it('normalizes Windows separators for report paths', () => {
    expect(toPosix('a\\b\\c.ts')).toBe('a/b/c.ts');
  });
});

describe('EvidenceStore', () => {
  const artifactsRoot = tempDir('zethub-evidence-');
  const store = new EvidenceStore(artifactsRoot);

  it('writes an artifact with a hash and relative path', async () => {
    const artifact = await store.write({
      runId: 'run/../unsafe',
      fileName: 'report.json',
      content: '{"ok":true}',
      kind: 'json',
    });
    expect(artifact.name).toBe('report.json');
    expect(artifact.relativePath.startsWith('runs/')).toBe(true);
    expect(artifact.mimeType).toBe('application/json');
    expect(artifact.sha256).toBe(sha256('{"ok":true}'));
    expect(store.read(artifact.relativePath).toString('utf8')).toBe('{"ok":true}');
    expect(store.exists(artifact.relativePath)).toBe(true);
  });

  it('sanitizes traversal attempts in run ids and file names', async () => {
    const artifact = await store.write({
      runId: '../../escape',
      fileName: '../../escape.txt',
      content: 'safe',
      kind: 'log',
    });
    const absolute = store.absolute(artifact.relativePath);
    expect(absolute.startsWith(path.resolve(artifactsRoot))).toBe(true);
    expect(fs.existsSync(absolute)).toBe(true);
    expect(artifact.name).not.toContain('/');
    expect(artifact.relativePath).not.toContain('..');
  });

  it('refuses to read outside the artifacts root', () => {
    expect(() => store.read('../secret.txt')).toThrow(PathPolicyError);
    expect(store.exists('../secret.txt')).toBe(false);
  });

  it('signs manifests deterministically and detects tampering', () => {
    const payload = { run: 'run-1', hashes: { a: 'b' } };
    const first = signManifest(payload, 'secret-one');
    const second = signManifest(payload, 'secret-one');
    const different = signManifest(payload, 'secret-two');
    expect(first).toEqual(second);
    expect(first.digest).not.toBe(different.digest);
    expect(first.digest).toBe(crypto.createHmac('sha256', 'secret-one').update(JSON.stringify(payload)).digest('hex'));
  });
});
