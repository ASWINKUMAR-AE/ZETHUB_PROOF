import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { generateUpdateKeyPair, publishUpdate, releaseId } from '@zethub/verification-core';
import { tempDir } from '../helpers';

const testUrl = process.env.ZETHUB_TEST_DATABASE_URL;
if (!testUrl) throw new Error('ZETHUB_TEST_DATABASE_URL is required for the update integration tests.');

const platform = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : null;
const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null;

describe.runIf(platform !== null && arch !== null)('signed update API against the disposable database', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let cookie = '';
  let csrf = '';
  let root = '';
  let storage = '';
  let artifact = '';
  let privateKey = '';
  let publicKey = '';
  let keyId = '';
  const releaseVersion = '1.0.1';
  let releaseIdValue = '';
  const email = `updates-${Date.now()}@zethub.test`;
  const password = 'Test!Passw0rd42'; // zethub-secret-scan:ignore test-only fixture

  beforeAll(async () => {
    root = tempDir('zethub-update-integration-');
    storage = path.join(root, 'updates');
    artifact = path.join(
      root,
      `ZetHub-Proof-${releaseVersion}-${platform}.${platform === 'windows' ? 'exe' : 'AppImage'}`,
    );
    fs.writeFileSync(artifact, 'verified-update-package');
    const keys = generateUpdateKeyPair();
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
    keyId = keys.keyId;
    const privatePath = path.join(root, 'signing-private.pem');
    const publicPath = path.join(root, 'signing-public.pem');
    fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
    fs.writeFileSync(publicPath, publicKey, { mode: 0o644 });
    releaseIdValue = releaseId({
      channel: 'stable',
      version: releaseVersion,
      platform: platform!,
      arch: arch!,
    });
    await publishUpdate({
      storageDir: storage,
      artifactPath: artifact,
      version: releaseVersion,
      channel: 'stable',
      platform: platform!,
      arch: arch!,
      format: platform === 'windows' ? 'nsis' : 'appimage',
      notes: 'Integration test release.',
      privateKeyPem: privateKey,
      keyId,
    });

    process.env.DATABASE_URL = testUrl;
    process.env.UPDATE_STORAGE_DIR = storage;
    process.env.UPDATE_SIGNING_PUBLIC_KEY = publicKey;
    process.env.UPDATE_SIGNING_PRIVATE_KEY_PATH = privatePath;
    process.env.UPDATE_INSTALL_MODE = 'manual';
    process.env.UPDATE_CHECK_TIMEOUT_MS = '2000';

    prisma = new PrismaClient({ datasourceUrl: testUrl });
    await prisma.user.deleteMany({});
    const { buildApp } = await import('../../apps/backend/src/app');
    app = await buildApp();
    await app.ready();

    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { email, name: 'Updates Owner', password },
    });
    expect(bootstrap.statusCode).toBe(200);
    csrf = bootstrap.json().csrfToken;
    const setCookie = bootstrap.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    cookie = String(raw ?? '').split(';')[0] ?? '';
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not expose the update check without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/updates/check' });
    expect(response.statusCode).toBe(401);
  });

  it('serves a signed platform feed and artifact', async () => {
    const feed = await app.inject({ method: 'GET', url: `/api/updates/${platform}/${arch}/stable` });
    expect(feed.statusCode).toBe(200);
    const body = feed.json();
    expect(body.envelope.payload.id).toBe(releaseIdValue);
    expect(body.release.signatureVerified).toBe(true);
    expect(body.release.sha256).toMatch(/^[a-f0-9]{64}$/);

    const download = await app.inject({ method: 'GET', url: `/api/updates/artifact/${releaseIdValue}` });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('verified-update-package');
    expect(download.headers['x-update-sha256']).toBe(body.release.sha256);
  });

  it('detects the compatible update for the authenticated owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/updates/check?force=1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('available');
    expect(body.currentVersion).toBe('0.1.0');
    expect(body.latestVersion).toBe(releaseVersion);
    expect(body.release.signatureVerified).toBe(true);
    expect(body.updateAvailable).toBe(true);
  });

  it('reports the update system status without leaking the private key path', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/updates/status', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.publicKeyConfigured).toBe(true);
    expect(body.keyId).toBe(keyId);
    expect(body.installMode).toBe('manual');
    expect(JSON.stringify(body)).not.toContain(privateKey.slice(20, 80));
    expect(JSON.stringify(body)).not.toContain('signing-private.pem');
  });

  it('lists releases for an owner and refuses admin routes to anonymous callers', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/updates/admin/releases' });
    expect(anonymous.statusCode).toBe(401);
    const owner = await app.inject({
      method: 'GET',
      url: '/api/v1/updates/admin/releases',
      headers: { cookie },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().items.some((item: { id: string }) => item.id === releaseIdValue)).toBe(true);
  });

  it('downloads, verifies and stages the package', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/updates/download',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { releaseId: releaseIdValue },
    });
    expect(start.statusCode).toBe(200);
    const jobId = start.json().id as string;
    let job = start.json();
    for (let attempt = 0; attempt < 60 && !['ready', 'failed', 'cancelled'].includes(job.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const poll = await app.inject({
        method: 'GET',
        url: `/api/v1/updates/downloads/${jobId}`,
        headers: { cookie },
      });
      expect(poll.statusCode).toBe(200);
      job = poll.json();
    }
    expect(job.status).toBe('ready');
    expect(job.progress).toBe(1);
    expect(job.sha256).toMatch(/^[a-f0-9]{64}$/);

    const staged = await app.inject({ method: 'GET', url: '/api/v1/updates/staged', headers: { cookie } });
    expect(staged.statusCode).toBe(200);
    const item = staged.json().items.find((entry: { releaseId: string }) => entry.releaseId === releaseIdValue);
    expect(item).toBeTruthy();
    // Downloads must stay under the configured update store, not the repository data directory.
    expect(path.resolve(item.path).startsWith(path.resolve(storage))).toBe(true);
  });

  it('requires explicit consent before installation and reports the real manual state', async () => {
    const withoutConsent = await app.inject({
      method: 'POST',
      url: '/api/v1/updates/install',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { releaseId: releaseIdValue, consent: false },
    });
    expect(withoutConsent.statusCode).toBe(400);

    const install = await app.inject({
      method: 'POST',
      url: '/api/v1/updates/install',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { releaseId: releaseIdValue, consent: true },
    });
    expect(install.statusCode).toBe(200);
    const body = install.json();
    expect(body.status).toBe('manual-required');
    expect(body.version).toBe(releaseVersion);
    expect(body.message).toMatch(/automatic installation is disabled/i);
    expect(body.path).toContain(`ZetHub-Proof-${releaseVersion}`);
  });

  it('rejects a staged package that was modified after verification', async () => {
    const staged = await app.inject({ method: 'GET', url: '/api/v1/updates/staged', headers: { cookie } });
    const item = staged.json().items.find((entry: { releaseId: string }) => entry.releaseId === releaseIdValue);
    expect(item).toBeTruthy();
    fs.writeFileSync(item.path, 'tampered-package');
    const install = await app.inject({
      method: 'POST',
      url: '/api/v1/updates/install',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { releaseId: releaseIdValue, consent: true },
    });
    expect(install.statusCode).toBe(409);
    expect(install.json().error.message).toMatch(/changed on disk|checksum|signature/i);
  });

  it('pauses and resumes a release, changing what clients receive', async () => {
    const pause = await app.inject({
      method: 'POST',
      url: `/api/v1/updates/admin/releases/${encodeURIComponent(releaseIdValue)}/pause`,
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(pause.statusCode).toBe(200);

    const feed = await app.inject({ method: 'GET', url: `/api/updates/${platform}/${arch}/stable` });
    expect(feed.statusCode).toBe(404);

    const check = await app.inject({
      method: 'GET',
      url: '/api/v1/updates/check?force=1',
      headers: { cookie },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().status).toBe('paused');
    expect(check.json().updateAvailable).toBe(false);

    const resume = await app.inject({
      method: 'POST',
      url: `/api/v1/updates/admin/releases/${encodeURIComponent(releaseIdValue)}/resume`,
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(resume.statusCode).toBe(200);
    const back = await app.inject({ method: 'GET', url: `/api/updates/${platform}/${arch}/stable` });
    expect(back.statusCode).toBe(200);
  });

  it('refuses to publish a version that is not newer than the published release', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/updates/admin/publish',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        artifactPath: artifact,
        version: releaseVersion,
        platform,
        arch,
        format: platform === 'windows' ? 'nsis' : 'appimage',
        channel: 'stable',
        notes: 'duplicate',
      },
    });
    expect(response.statusCode).toBe(409);
  });
});
