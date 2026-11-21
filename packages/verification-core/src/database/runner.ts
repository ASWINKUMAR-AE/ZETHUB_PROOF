import mysql from 'mysql2/promise';
import type { AssertionResult, DbScenario, TestResult } from '@zethub/shared-types';
import { type EvidenceStore } from '../evidence/store.js';
import { redact } from '../utils/redact.js';

export interface DbConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  connectTimeoutMs?: number;
}

export interface DbRunOptions {
  runId: string;
  scenario: DbScenario;
  connection: DbConnectionConfig;
  artifacts: EvidenceStore;
  signal?: AbortSignal;
  /** Extra confirmation for writes, checked by the caller. */
  writesConfirmed?: boolean;
}

const READ_ONLY = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i;
const FORBIDDEN = /^\s*(DROP|TRUNCATE|ALTER|GRANT|REVOKE|CREATE\s+USER|DELETE\s+FROM\s+mysql\.|SHUTDOWN|KILL)\b/i;

export async function testDatabaseConnection(config: DbConnectionConfig): Promise<{
  ok: boolean;
  serverVersion?: string;
  serverType: 'mysql' | 'mariadb' | 'unknown';
  latencyMs?: number;
  error?: string;
}> {
  const started = Date.now();
  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database || undefined,
      connectTimeout: config.connectTimeoutMs ?? 10_000,
      ssl: config.ssl ? {} : undefined,
      multipleStatements: false,
    });
    const [rows] = await conn.query('SELECT VERSION() AS version');
    const version = String((rows as Array<{ version: string }>)[0]?.version ?? '');
    const serverType = /mariadb/i.test(version) ? 'mariadb' : version ? 'mysql' : 'unknown';
    return { ok: true, serverVersion: version, serverType, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      serverType: 'unknown',
      error: redact(error instanceof Error ? error.message : String(error)),
      latencyMs: Date.now() - started,
    };
  } finally {
    await conn?.end().catch(() => undefined);
  }
}

export async function inspectSchema(
  config: DbConnectionConfig,
): Promise<{ tables: Array<{ name: string; rows: number | null }>; error?: string }> {
  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectTimeout: config.connectTimeoutMs ?? 10_000,
      ssl: config.ssl ? {} : undefined,
    });
    const [rows] = await conn.query(
      'SELECT TABLE_NAME AS name, TABLE_ROWS AS rowEstimate FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [config.database],
    );
    return {
      tables: (rows as Array<{ name: string; rowEstimate: number | null }>).map((r) => ({
        name: r.name,
        rows: r.rowEstimate,
      })),
    };
  } catch (error) {
    return { tables: [], error: redact(error instanceof Error ? error.message : String(error)) };
  } finally {
    await conn?.end().catch(() => undefined);
  }
}

export async function runDbScenario(options: DbRunOptions): Promise<TestResult> {
  const { scenario, connection, artifacts, runId } = options;
  const started = Date.now();
  const assertions: AssertionResult[] = [];
  const evidence: TestResult['evidence'] = [];
  const evidenceJson: Record<string, unknown> = {
    integration: { host: connection.host, port: connection.port, database: connection.database },
    checks: [],
  };
  let status: TestResult['status'] = 'passed';
  let message: string | undefined;
  let classification: string | undefined;
  let conn: mysql.Connection | null = null;

  if (
    !options.writesConfirmed &&
    (scenario.allowWrites || scenario.checks.some((c) => c.type === 'transactionRollback'))
  ) {
    return {
      key: `database:${scenario.id ?? scenario.name}`,
      title: scenario.name,
      kind: 'database',
      adapterId: 'database-mysql',
      status: 'blocked',
      durationMs: 0,
      assertions: [
        {
          name: 'Write authorization',
          status: 'blocked',
          message: 'This scenario can write data. Confirm the target is a dedicated test database before running.',
        },
      ],
      evidence: [],
      classification: 'writes-not-confirmed',
      message: 'Blocked until writes are explicitly confirmed.',
    };
  }

  const cleanupStatements: string[] = [];

  try {
    conn = await mysql.createConnection({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      connectTimeout: connection.connectTimeoutMs ?? 10_000,
      multipleStatements: false,
      ssl: connection.ssl ? {} : undefined,
    });
    assertions.push({
      name: 'Database connection',
      status: 'passed',
      actual: `${connection.host}:${connection.port}/${connection.database}`,
    });

    for (const check of scenario.checks) {
      if (options.signal?.aborted) {
        status = 'cancelled';
        message = 'Cancelled by user';
        break;
      }
      switch (check.type) {
        case 'query': {
          if (!READ_ONLY.test(check.sql) && !scenario.allowWrites) {
            assertions.push({
              name: `Query rejected (write not allowed): ${check.sql.slice(0, 80)}`,
              status: 'blocked',
              message: 'Only SELECT/SHOW/EXPLAIN statements are allowed without allowWrites.',
            });
            status = 'blocked';
            break;
          }
          const [rows] = await conn.query(check.sql, check.params);
          const rowArray = rows as Array<Record<string, unknown>>;
          evidenceJson.checks = [
            ...(evidenceJson.checks as unknown[]),
            { sql: redact(check.sql), rowCount: rowArray.length, sample: rowArray.slice(0, 5) },
          ];
          if (check.expectRowsAtLeast !== undefined) {
            const ok = rowArray.length >= check.expectRowsAtLeast;
            assertions.push({
              name: `Rows >= ${check.expectRowsAtLeast}`,
              status: ok ? 'passed' : 'failed',
              actual: String(rowArray.length),
            });
            if (!ok) status = 'failed';
          }
          if (check.expectFirstRow) {
            const first = rowArray[0] ?? {};
            for (const [key, expected] of Object.entries(check.expectFirstRow)) {
              const actual = first[key];
              const ok = String(actual) === String(expected);
              assertions.push({
                name: `Column ${key}`,
                status: ok ? 'passed' : 'failed',
                expected: String(expected),
                actual: String(actual),
              });
              if (!ok) status = 'failed';
            }
          }
          if (!check.expectRowsAtLeast && !check.expectFirstRow) {
            assertions.push({ name: `Query executed (${rowArray.length} rows)`, status: 'passed' });
          }
          break;
        }
        case 'schemaTable': {
          const [cols] = await conn.query(
            'SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable, COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
            [connection.database, check.table],
          );
          const columns = (cols as Array<{ name: string }>).map((c) => c.name);
          if (columns.length === 0) {
            assertions.push({ name: `Table ${check.table} exists`, status: 'failed', message: 'Table not found' });
            status = 'failed';
            break;
          }
          assertions.push({
            name: `Table ${check.table} exists`,
            status: 'passed',
            actual: `${columns.length} columns`,
          });
          for (const expected of check.expectColumns) {
            const ok = columns.includes(expected);
            assertions.push({ name: `Column ${check.table}.${expected}`, status: ok ? 'passed' : 'failed' });
            if (!ok) status = 'failed';
          }
          evidenceJson.checks = [...(evidenceJson.checks as unknown[]), { table: check.table, columns }];
          break;
        }
        case 'constraint': {
          const [cols] = await conn.query(
            'SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [connection.database, check.table, check.column],
          );
          const row = (cols as Array<{ nullable: string }>)[0];
          if (!row) {
            assertions.push({
              name: `Constraint ${check.table}.${check.column}`,
              status: 'failed',
              message: 'Column not found',
            });
            status = 'failed';
          } else {
            const nullable = row.nullable === 'YES';
            const ok = nullable === check.expectNullable;
            assertions.push({
              name: `${check.table}.${check.column} nullable=${check.expectNullable}`,
              status: ok ? 'passed' : 'failed',
              actual: `nullable=${nullable}`,
            });
            if (!ok) status = 'failed';
          }
          break;
        }
        case 'transactionRollback': {
          for (const sql of check.sql) {
            if (FORBIDDEN.test(sql)) throw new Error(`Destructive statement refused: ${sql.slice(0, 60)}`);
          }
          await conn.beginTransaction();
          try {
            const results: unknown[] = [];
            for (const sql of check.sql) {
              const [result] = await conn.query(sql);
              results.push(result);
            }
            await conn.rollback();
            assertions.push({
              name: `Transaction rollback (${check.sql.length} statements)`,
              status: 'passed',
              message: 'Statements executed inside a transaction that was rolled back; nothing was committed.',
            });
            evidenceJson.checks = [
              ...(evidenceJson.checks as unknown[]),
              { transaction: true, statements: check.sql.map((s) => redact(s)), rolledBack: true },
            ];
          } catch (error) {
            await conn.rollback().catch(() => undefined);
            throw error;
          }
          break;
        }
        default:
          assertions.push({ name: 'Unsupported DB check', status: 'error' });
          status = 'error';
      }
    }

    if (status === 'passed' && assertions.some((a) => a.status === 'failed')) status = 'failed';
  } catch (error) {
    status = options.signal?.aborted ? 'cancelled' : 'failed';
    classification = 'database-error';
    message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1500);
    assertions.push({ name: 'Database check', status, message });
  } finally {
    await conn?.end().catch(() => undefined);
    void cleanupStatements;
  }

  try {
    evidence.push(
      await artifacts.write({
        runId,
        fileName: `db-${(scenario.id ?? scenario.name).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`,
        content: JSON.stringify(evidenceJson, null, 2),
        kind: 'json',
        mimeType: 'application/json',
      }),
    );
  } catch {
    /* evidence directory may be unavailable */
  }

  return {
    key: `database:${scenario.id ?? scenario.name}`,
    title: scenario.name,
    kind: 'database',
    adapterId: 'database-mysql',
    status,
    durationMs: Date.now() - started,
    assertions,
    evidence,
    classification,
    message,
  };
}
