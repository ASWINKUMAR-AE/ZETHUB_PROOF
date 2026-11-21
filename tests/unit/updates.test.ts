import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  generateUpdateKeyPair,
  isRolloutEligible,
  isVersionNewer,
  isVersionValid,
  listReleaseEnvelopes,
  publishUpdate,
  releaseId,
  resolveArtifactFile,
  updateReleaseState,
  verifyArtifactDigest,
  verifyReleaseEnvelope,
} from '@zethub/verification-core';
import { tempDir, writeFile } from '../helpers';

const cleanups: string[] = [];

function workspace(): string {
  const dir = tempDir('zethub-update-');
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) fs.rmSync(cleanups.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = workspace();
  const storage = path.join(root, 'updates');
  const artifact = path.join(root, 'ZetHub-Proof-1.0.1-win.exe');
  fs.writeFileSync(artifact, 'signed-package-bytes');
  const keys = generateUpdateKeyPair();
  return { root, storage, artifact, keys };
}

async function publish(
  storage: string,
  artifact: string,
  keys: ReturnType<typeof generateUpdateKeyPair>,
  options = {},
) {
  return publishUpdate({
    storageDir: storage,
    artifactPath: artifact,
    version: '1.0.1',
    channel: 'stable',
    platform: 'windows',
    arch: 'x86_64',
    format: 'nsis',
    notes: 'Test release notes.',
    privateKeyPem: keys.privateKey,
    keyId: keys.keyId,
    ...options,
  });
}

describe('update version comparison', () => {
  it('orders stable and pre-release versions with semver rules', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0')).toBeLessThan(0);
    expect(isVersionNewer('1.1.0', '1.0.0')).toBe(true);
    expect(isVersionNewer('1.0.0', '1.0.0')).toBe(false);
  });

  it('rejects malformed versions instead of guessing', () => {
    expect(isVersionValid('1.0')).toBe(false);
    expect(isVersionValid('v1.0.0')).toBe(false);
    expect(isVersionValid('1.0.0-rc.1')).toBe(true);
    expect(() => compareVersions('nope', '1.0.0')).toThrow();
    expect(isVersionNewer('nope', '1.0.0')).toBe(false);
  });
});

describe('signed release publication', () => {
  it('publishes a signed manifest and artifact that verify', async () => {
    const { storage, artifact, keys } = fixture();
    const result = await publish(storage, artifact, keys);

    expect(result.draft).toBe(false);
    expect(result.envelope.payload.version).toBe('1.0.1');
    expect(result.envelope.payload.id).toBe(
      releaseId({ channel: 'stable', version: '1.0.1', platform: 'windows', arch: 'x86_64' }),
    );
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    expect(fs.existsSync(result.artifactPath)).toBe(true);
    const stored = fs.readFileSync(result.artifactPath, 'utf8');
    expect(stored).toBe('signed-package-bytes');

    const verification = verifyReleaseEnvelope(result.envelope, keys.publicKey);
    expect(verification.valid).toBe(true);
    expect(verification.error).toBeNull();
    expect(
      verifyArtifactDigest(
        result.envelope.payload.artifact.sha256,
        result.envelope.payload.artifact.digestSignature,
        keys.publicKey,
      ),
    ).toBe(true);
    expect(result.envelope.payload.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a manifest whose payload was altered after signing', async () => {
    const { storage, artifact, keys } = fixture();
    const result = await publish(storage, artifact, keys);
    const tampered = {
      ...result.envelope,
      payload: { ...result.envelope.payload, version: '9.9.9' },
    };
    const verification = verifyReleaseEnvelope(tampered, keys.publicKey);
    expect(verification.valid).toBe(false);
    expect(verification.error).toMatch(/signature/i);
  });

  it('rejects a manifest signed by a different key', async () => {
    const { storage, artifact, keys } = fixture();
    const result = await publish(storage, artifact, keys);
    const other = generateUpdateKeyPair();
    expect(verifyReleaseEnvelope(result.envelope, other.publicKey).valid).toBe(false);
  });

  it('rejects a checksum that does not match the signed digest', async () => {
    const { storage, artifact, keys } = fixture();
    const result = await publish(storage, artifact, keys);
    const digest = result.envelope.payload.artifact.sha256;
    const wrong = digest.replace(/^./, digest[0] === '0' ? '1' : '0');
    expect(verifyArtifactDigest(wrong, result.envelope.payload.artifact.digestSignature, keys.publicKey)).toBe(false);
  });

  it('refuses to overwrite an existing published version', async () => {
    const { storage, artifact, keys } = fixture();
    await publish(storage, artifact, keys);
    await expect(publish(storage, artifact, keys)).rejects.toThrow(/already exists/i);
  });

  it('keeps drafts out of the published feed', async () => {
    const { storage, artifact, keys } = fixture();
    const result = await publish(storage, artifact, keys, { draft: true });
    expect(result.draft).toBe(true);
    expect(listReleaseEnvelopes(storage)).toHaveLength(0);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
  });

  it('re-signs metadata when a release is paused and resumed', async () => {
    const { storage, artifact, keys } = fixture();
    const result = await publish(storage, artifact, keys);
    const id = result.envelope.payload.id;

    const paused = updateReleaseState(storage, id, { paused: true }, keys.privateKey, keys.keyId);
    expect(paused.payload.paused).toBe(true);
    expect(verifyReleaseEnvelope(paused, keys.publicKey).valid).toBe(true);

    const resumed = updateReleaseState(storage, id, { paused: false, rolloutPercent: 25 }, keys.privateKey, keys.keyId);
    expect(resumed.payload.paused).toBe(false);
    expect(resumed.payload.rolloutPercent).toBe(25);
    expect(verifyReleaseEnvelope(resumed, keys.publicKey).valid).toBe(true);

    const stored = listReleaseEnvelopes(storage)[0]!.envelope;
    expect(stored.payload.paused).toBe(false);
    expect(stored.payload.rolloutPercent).toBe(25);
  });

  it('rejects artifacts whose published path escapes the storage root', async () => {
    const { storage } = fixture();
    expect(() => resolveArtifactFile(storage, 'artifacts/../../etc/passwd')).toThrow(/safe|escapes/i);
    expect(() => resolveArtifactFile(storage, 'artifacts\\..\\evil.exe')).toThrow(/safe/i);
  });

  it('refuses unsafe artifact file names when publishing', async () => {
    const { root, storage, keys } = fixture();
    const unsafe = writeFile(root, 'bad name.exe', 'bad');
    await expect(publish(storage, unsafe, keys)).rejects.toThrow(/safe/i);
  });
});

describe('staged rollout bucketing', () => {
  it('is deterministic and respects percentage boundaries', () => {
    expect(isRolloutEligible('install-a', 'release-a', 100)).toBe(true);
    expect(isRolloutEligible('install-a', 'release-a', 0)).toBe(false);
    const first = isRolloutEligible('install-a', 'release-a', 50);
    expect(isRolloutEligible('install-a', 'release-a', 50)).toBe(first);
  });

  it('spreads different installations across rollout groups', () => {
    const eligible = Array.from({ length: 100 }, (_, index) =>
      isRolloutEligible(`install-${index}`, 'release-a', 50),
    ).filter(Boolean).length;
    expect(eligible).toBeGreaterThan(20);
    expect(eligible).toBeLessThan(80);
  });
});
