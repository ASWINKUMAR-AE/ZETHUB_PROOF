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

describe('backend API against the disposable MySQL database', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let cookie = '';
  let csrf = '';
  let projectId = '';
  const email = `integration-${Date.now()}@zethub.test`;
  const password = 'Test!Passw0rd42'; // zethub-secret-scan:ignore test-only fixture

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
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
  });

  it('serves an unauthenticated health response', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/system/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ api: 'ok', database: 'ok' });
  });

  it('protects project routes without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('bootstraps the local owner account and returns a CSRF token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { email, name: 'Integration Owner', password },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe(email);
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    csrf = body.csrfToken;
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    cookie = String(raw ?? '').split(';')[0] ?? '';
    expect(cookie.startsWith('zh_session=')).toBe(true);
  });

  it('returns the authenticated profile with the session cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe(email);
  });

  it('rejects a state-changing cookie request without the CSRF header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'No CSRF' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_FAILED');
  });

  it('creates a project with a valid CSRF token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Integration Project', sourceType: 'LOCAL', rootPath: process.cwd() },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.project.name).toBe('Integration Project');
    projectId = body.project.id;
    expect(projectId).toBeTruthy();
  });

  it('lists and reads the created project', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((p: { id: string }) => p.id === projectId)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().project.id).toBe(projectId);
  });

  it('runs the database health probe against the dedicated test database', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/db/health',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().health).toMatchObject({ read: true, write: true, cleanup: true });
  });

  it('accepts an empty JSON body for no-payload endpoints', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/db/health',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: '',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().health.read).toBe(true);
  });

  it('allows read-only SQL and rejects writes', async () => {
    const select = await app.inject({
      method: 'POST',
      url: '/api/v1/db/query',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { sql: 'SELECT 1 AS value' },
    });
    expect(select.statusCode).toBe(200);
    expect(select.json().rows[0].value).toBe(1);

    const write = await app.inject({
      method: 'POST',
      url: '/api/v1/db/query',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { sql: 'DELETE FROM users' },
    });
    expect(write.statusCode).toBe(400);
  });

  it('rejects invalid JSON instead of crashing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/db/query',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: '{"sql": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REQUEST_REJECTED');
  });
});
