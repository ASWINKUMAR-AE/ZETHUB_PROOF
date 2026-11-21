import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

const testUrl = process.env.ZETHUB_TEST_DATABASE_URL;
if (!testUrl)
  throw new Error(
    'ZETHUB_TEST_DATABASE_URL was not derived from .env; integration tests need the disposable test database.',
  );

const database = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
if (!database.endsWith('_test'))
  throw new Error(`Refusing to run destructive integration setup against "${database}".`);

describe('multi-user account management', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const stamp = Date.now();
  const ownerEmail = `users-owner-${stamp}@zethub.test`;
  const adminEmail = `users-admin-${stamp}@zethub.test`;
  const viewerEmail = `users-viewer-${stamp}@zethub.test`;
  const ownerPassword = 'Owner!Pass123'; // zethub-secret-scan:ignore test-only fixture
  const adminPassword = 'Admin!Pass123'; // zethub-secret-scan:ignore test-only fixture

  let ownerSession = { cookie: '', csrf: '' };
  let adminSession = { cookie: '', csrf: '' };
  let viewerSession = { cookie: '', csrf: '' };
  let adminId = '';
  let viewerId = '';
  let viewerTempPassword = '';

  function extractSession(response: { headers: Record<string, unknown>; json: () => { csrfToken: string } }): {
    cookie: string;
    csrf: string;
  } {
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return { cookie: String(raw ?? '').split(';')[0] ?? '', csrf: response.json().csrfToken };
  }

  async function login(email: string, password: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password, remember: false },
    });
    expect(response.statusCode).toBe(200);
    return extractSession(response);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaClient({ datasourceUrl: testUrl });
    // The test database is disposable; only it is cleaned.
    await prisma.user.deleteMany({});
    const { buildApp } = await import('../../apps/backend/src/app');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({}).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
  });

  it('requires owner or admin to list accounts', async () => {
    const createOwner = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { email: ownerEmail, name: 'Users Owner', password: ownerPassword },
    });
    expect(createOwner.statusCode).toBe(200);
    ownerSession = extractSession(createOwner);

    const unauth = await app.inject({ method: 'GET', url: '/api/v1/users' });
    expect(unauth.statusCode).toBe(401);
  });

  it('creates an admin account with an explicit password and keeps the password secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { email: adminEmail, name: 'Users Admin', role: 'ADMIN', password: adminPassword },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.role).toBe('ADMIN');
    expect(body.temporaryPassword).toBeNull();
    expect(JSON.stringify(body)).not.toContain(adminPassword);
    adminId = body.user.id;
  });

  it('rejects a duplicate email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { email: adminEmail, name: 'Duplicate', role: 'VIEWER' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('rejects weak passwords for managed accounts', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { email: `weak-${stamp}@zethub.test`, name: 'Weak', role: 'VIEWER', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { email: `weak-${stamp}@zethub.test` } })).toBeNull();
  });

  it('creates a viewer account with a generated password and logs in with it once', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { email: viewerEmail, name: 'Users Viewer', role: 'VIEWER' },
    });
    expect(create.statusCode).toBe(200);
    const body = create.json();
    expect(body.generatedPassword).toBe(true);
    expect(body.temporaryPassword).toMatch(/^.{22,}aA7!$/);
    viewerId = body.user.id;
    viewerTempPassword = body.temporaryPassword;

    viewerSession = await login(viewerEmail, viewerTempPassword);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: viewerSession.cookie } });
    expect(me.json().user.role).toBe('VIEWER');
  });

  it('blocks viewer accounts from account management', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: viewerSession.cookie } });
    expect(list.statusCode).toBe(403);

    const mutate = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: viewerSession.cookie, 'x-csrf-token': viewerSession.csrf },
      payload: { email: `peek-${stamp}@zethub.test`, name: 'Nope', role: 'VIEWER' },
    });
    expect(mutate.statusCode).toBe(403);
  });

  it('lets the admin log in and prevents admin-only elevation rules', async () => {
    adminSession = await login(adminEmail, adminPassword);

    const createOwner = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: adminSession.cookie, 'x-csrf-token': adminSession.csrf },
      payload: { email: `elevate-${stamp}@zethub.test`, name: 'Escalate', role: 'OWNER' },
    });
    expect(createOwner.statusCode).toBe(403);
    expect(await prisma.user.findUnique({ where: { email: `elevate-${stamp}@zethub.test` } })).toBeNull();
  });

  it('prevents an admin from modifying or resetting an owner account', async () => {
    const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
    expect(owner?.role).toBe('OWNER');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${owner?.id}`,
      headers: { cookie: adminSession.cookie, 'x-csrf-token': adminSession.csrf },
      payload: { name: 'Hijacked' },
    });
    expect(patch.statusCode).toBe(403);

    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${owner?.id}/reset-password`,
      headers: { cookie: adminSession.cookie, 'x-csrf-token': adminSession.csrf },
      payload: {},
    });
    expect(reset.statusCode).toBe(403);
  });

  it('prevents an admin from resetting another admin password but allows viewer resets', async () => {
    const resetAdmin = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${adminId}/reset-password`,
      headers: { cookie: adminSession.cookie, 'x-csrf-token': adminSession.csrf },
      payload: {},
    });
    expect(resetAdmin.statusCode).toBe(403);

    const resetViewer = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${viewerId}/reset-password`,
      headers: { cookie: adminSession.cookie, 'x-csrf-token': adminSession.csrf },
      payload: {},
    });
    expect(resetViewer.statusCode).toBe(200);
    expect(resetViewer.json().temporaryPassword).toMatch(/^.{22,}aA7!$/);
    viewerTempPassword = resetViewer.json().temporaryPassword;
  });

  it('disables a viewer account and revokes its active sessions', async () => {
    // The password reset above revoked the old viewer session; sign in again first.
    viewerSession = await login(viewerEmail, viewerTempPassword);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${viewerId}`,
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { disabled: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().user.disabled).toBe(true);

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: viewerSession.cookie },
    });
    expect(denied.statusCode).toBe(401);
  });

  it('re-enables the viewer account and allows a fresh login', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${viewerId}`,
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { disabled: false },
    });
    expect(patch.statusCode).toBe(200);
    viewerSession = await login(viewerEmail, viewerTempPassword);
    expect(viewerSession.csrf).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('blocks self-destruction and self-role changes', async () => {
    const selfId = (await prisma.user.findUnique({ where: { email: ownerEmail } }))!.id;

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${selfId}`,
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(400);

    const role = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${selfId}`,
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { role: 'ADMIN' },
    });
    expect(role.statusCode).toBe(400);
  });

  it('protects the last active owner from demotion or disabling', async () => {
    const owner = (await prisma.user.findUnique({ where: { email: ownerEmail } }))!;

    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${owner.id}`,
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { role: 'ADMIN' },
    });
    expect(demote.statusCode).toBe(409);

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${owner.id}`,
      headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrf },
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(409);
  });

  it('rejects a wrong current password when changing your own password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: adminSession.cookie, 'x-csrf-token': adminSession.csrf },
      payload: { currentPassword: 'Wrong!Pass999', newPassword: 'Admin!Pass456' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('changes the admin password and revokes every other session for that account', async () => {
    const secondSession = await login(adminEmail, adminPassword);
    const change = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: adminSession.cookie, 'x-csrf-token': adminSession.csrf },
      payload: { currentPassword: adminPassword, newPassword: 'Admin!Pass456' },
    });
    expect(change.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: secondSession.cookie },
    });
    expect(revoked.statusCode).toBe(401);

    adminSession = await login(adminEmail, 'Admin!Pass456');
  });

  it('lists accounts with project counts and login metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: ownerSession.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBeGreaterThanOrEqual(3);
    const ids = body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(adminId);
    expect(ids).toContain(viewerId);
    const adminRow = body.items.find((item: { id: string }) => item.id === adminId);
    expect(adminRow.projectCount).toBe(0);
    expect(typeof adminRow.lastLoginAt).toBe('string');
  });
});
