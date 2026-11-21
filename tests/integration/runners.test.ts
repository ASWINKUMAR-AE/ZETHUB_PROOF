import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EvidenceStore,
  inspectSchema,
  runApiScenario,
  runDbScenario,
  testDatabaseConnection,
  type DbConnectionConfig,
} from '@zethub/verification-core';
import { ApiScenarioSchema, DbScenarioSchema } from '@zethub/shared-types';
import { tempDir } from '../helpers';

describe('HTTP API verification runner', () => {
  let server: http.Server;
  let baseUrl: string;
  let requests = 0;
  const artifacts = new EvidenceStore(tempDir('zethub-api-evidence-'));
  const runId = 'run-api-integration';

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      requests += 1;
      const url = request.url ?? '/';
      if (url.startsWith('/ok')) {
        response.writeHead(200, { 'content-type': 'application/json', 'x-contract': 'v1' });
        response.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
        return;
      }
      if (url.startsWith('/created')) {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'new-1' }));
        return;
      }
      if (url.startsWith('/broken')) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('boom');
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('passes a real HTTP request with status, header, JSON path and body assertions', async () => {
    const scenario = ApiScenarioSchema.parse({
      name: 'Health contract',
      request: { method: 'GET', url: `${baseUrl}/ok` },
      expectations: [
        { type: 'status', equals: 200 },
        { type: 'header', name: 'x-contract', equals: 'v1' },
        { type: 'jsonPath', path: '$.items', valueType: 'array' },
        { type: 'jsonPath', path: '$.items.1', equals: 2 },
        { type: 'bodyContains', value: '"ok":true' },
        { type: 'responseTime', maxMs: 5000 },
      ],
    });
    const result = await runApiScenario({ runId, scenario, artifacts });
    expect(result.status).toBe('passed');
    expect(result.assertions.every((a) => a.status === 'passed')).toBe(true);
    expect(result.evidence).toHaveLength(1);
    expect(artifacts.exists(result.evidence[0]!.relativePath)).toBe(true);
  });

  it('fails when the response does not match expectations', async () => {
    const scenario = ApiScenarioSchema.parse({
      name: 'Wrong status',
      request: { method: 'GET', url: `${baseUrl}/ok` },
      expectations: [{ type: 'status', equals: 201 }],
    });
    const result = await runApiScenario({ runId, scenario, artifacts });
    expect(result.status).toBe('failed');
    expect(result.assertions.find((a) => a.name === 'Status 201')).toMatchObject({ status: 'failed', actual: '200' });
  });

  it('blocks state-changing requests until mutation is explicitly allowed', async () => {
    const blockedScenario = ApiScenarioSchema.parse({
      name: 'Blocked mutation',
      request: { method: 'POST', url: `${baseUrl}/created`, bodyType: 'json', body: { name: 'x' } },
      expectations: [{ type: 'status', equals: 201 }],
    });
    const before = requests;
    const blocked = await runApiScenario({ runId, scenario: blockedScenario, artifacts });
    expect(blocked.status).toBe('blocked');
    expect(blocked.classification).toBe('mutation-not-authorized');
    expect(requests).toBe(before);

    const allowed = await runApiScenario({
      runId,
      artifacts,
      scenario: ApiScenarioSchema.parse({
        name: 'Allowed mutation',
        request: {
          method: 'POST',
          url: `${baseUrl}/created`,
          bodyType: 'json',
          body: { name: 'x' },
          allowMutation: true,
        },
        expectations: [
          { type: 'status', equals: 201 },
          { type: 'jsonPath', path: '$.id', equals: 'new-1' },
        ],
      }),
    });
    expect(allowed.status).toBe('passed');
  });

  it('reports transport and server failures without claiming success', async () => {
    const result = await runApiScenario({
      runId,
      artifacts,
      scenario: ApiScenarioSchema.parse({
        name: 'Server error',
        request: { method: 'GET', url: `${baseUrl}/broken` },
        expectations: [{ type: 'status', equals: 200 }],
      }),
    });
    expect(result.status).toBe('failed');
    expect(result.assertions.some((a) => a.status === 'failed')).toBe(true);
  });

  it('redacts secrets from request evidence', async () => {
    const secret = 'integration-test-secret-value'; // zethub-secret-scan:ignore test-only fixture
    const result = await runApiScenario({
      runId,
      artifacts,
      secrets: { TOKEN: secret },
      scenario: ApiScenarioSchema.parse({
        name: 'Secret header',
        request: {
          method: 'GET',
          url: `${baseUrl}/ok`,
          headers: [{ name: 'authorization', value: 'Bearer ${secret.TOKEN}', secret: true }],
        },
        expectations: [{ type: 'status', equals: 200 }],
      }),
    });
    expect(result.status).toBe('passed');
    const raw = artifacts.read(result.evidence[0]!.relativePath).toString('utf8');
    expect(raw).not.toContain(secret);
  });
});

describe('MySQL database verification runner', () => {
  const url = process.env.ZETHUB_TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      'ZETHUB_TEST_DATABASE_URL was not derived from .env; run `npm run db:setup -- --database <name>_test --create-user` first.',
    );

  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database.endsWith('_test')) throw new Error(`Integration tests refuse to use a non-test database: ${database}`);
  const connection: DbConnectionConfig = {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    connectTimeoutMs: 10_000,
  };
  const artifacts = new EvidenceStore(tempDir('zethub-db-evidence-'));

  it('connects to the disposable test database', async () => {
    const result = await testDatabaseConnection(connection);
    expect(result.ok).toBe(true);
    expect(result.serverVersion).toBeTruthy();
    expect(['mysql', 'mariadb']).toContain(result.serverType);
  });

  it('inspects the migrated schema', async () => {
    const schema = await inspectSchema(connection);
    expect(schema.error).toBeUndefined();
    expect(schema.tables.length).toBeGreaterThanOrEqual(20);
    expect(schema.tables.map((t) => t.name)).toContain('users');
  });

  it('runs read-only queries, schema and constraint checks', async () => {
    const scenario = DbScenarioSchema.parse({
      name: 'Core schema',
      integrationId: 'test-db',
      checks: [
        { type: 'query', sql: 'SELECT 1 AS value', expectRowsAtLeast: 1, expectFirstRow: { value: '1' } },
        { type: 'schemaTable', table: 'users', expectColumns: ['id', 'email', 'passwordHash'] },
        { type: 'constraint', table: 'users', column: 'email', expectNullable: false },
      ],
    });
    const result = await runDbScenario({ runId: 'run-db-integration', scenario, connection, artifacts });
    expect(result.status).toBe('passed');
    expect(result.evidence).toHaveLength(1);
  });

  it('reports a failed data expectation honestly', async () => {
    const scenario = DbScenarioSchema.parse({
      name: 'Wrong value',
      integrationId: 'test-db',
      checks: [{ type: 'query', sql: 'SELECT 1 AS value', expectFirstRow: { value: '2' } }],
    });
    const result = await runDbScenario({ runId: 'run-db-integration', scenario, connection, artifacts });
    expect(result.status).toBe('failed');
  });

  it('blocks writes unless writes are confirmed', async () => {
    const scenario = DbScenarioSchema.parse({
      name: 'Unconfirmed write',
      integrationId: 'test-db',
      allowWrites: true,
      checks: [{ type: 'transactionRollback', sql: ['DELETE FROM users'] }],
    });
    const result = await runDbScenario({ runId: 'run-db-integration', scenario, connection, artifacts });
    expect(result.status).toBe('blocked');
    expect(result.classification).toBe('writes-not-confirmed');

    const stillThere = await testDatabaseConnection(connection);
    expect(stillThere.ok).toBe(true);
  });

  it('rejects write SQL without allowWrites even when writes are confirmed', async () => {
    const scenario = DbScenarioSchema.parse({
      name: 'Write not allowed',
      integrationId: 'test-db',
      checks: [{ type: 'query', sql: 'DELETE FROM users' }],
    });
    const result = await runDbScenario({
      runId: 'run-db-integration',
      scenario,
      connection,
      artifacts,
      writesConfirmed: true,
    });
    expect(result.status).toBe('blocked');
    expect(result.assertions.some((a) => a.name.includes('write not allowed'))).toBe(true);
  });
});
