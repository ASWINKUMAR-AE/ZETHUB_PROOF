/**
 * Standalone database verification (no API server required).
 *
 * Verifies connectivity with the application account, required tables,
 * applied migrations and a self-cleaning read/write probe. Read-only apart
 * from temporary tables and one transaction that is rolled back.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { findRoot, loadEnv, loadConfig } from '../packages/verification-core/src/index.ts';

const CORE_TABLES = [
  'users',
  'sessions',
  'projects',
  'project_environments',
  'test_plans',
  'test_cases',
  'test_runs',
  'test_results',
  'evidence_artifacts',
  'verification_reports',
  'failure_capsules',
  'repair_proposals',
  'integrations',
  'db_backups',
  'db_health_checks',
];

async function main(): Promise<void> {
  const root = findRoot();
  loadEnv(root);
  const config = loadConfig();
  const checks: Array<{ check: string; status: 'passed' | 'failed'; detail: string }> = [];

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.name,
      connectTimeout: config.db.connectionTimeoutMs,
    });
    const [versionRows] = await connection.query('SELECT VERSION() AS version, DATABASE() AS db');
    const row = (versionRows as Array<{ version: string; db: string }>)[0];
    checks.push({
      check: 'Connection',
      status: 'passed',
      detail: `${row?.version ?? 'unknown'} / ${row?.db ?? 'unknown'}`,
    });

    const [tableRows] = await connection.query(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
    );
    const tables = (tableRows as Array<{ name: string }>).map((t) => t.name);
    const missing = CORE_TABLES.filter((t) => !tables.includes(t));
    checks.push({
      check: 'Schema',
      status: missing.length === 0 ? 'passed' : 'failed',
      detail: missing.length === 0 ? `${tables.length} tables present` : `Missing: ${missing.join(', ')}`,
    });

    const migrationsDir = path.join(root, 'prisma', 'migrations');
    const expected = fs.existsSync(migrationsDir)
      ? fs
          .readdirSync(migrationsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
      : [];
    const [migrationRows] = await connection.query(
      'SELECT migration_name AS name, finished_at AS finishedAt, rolled_back_at AS rolledBackAt FROM _prisma_migrations',
    );
    const applied = (migrationRows as Array<{ name: string; finishedAt: Date | null; rolledBackAt: Date | null }>)
      .filter((m) => m.finishedAt && !m.rolledBackAt)
      .map((m) => m.name)
      .sort();
    const pending = expected.filter((m) => !applied.includes(m));
    checks.push({
      check: 'Migrations',
      status: pending.length === 0 ? 'passed' : 'failed',
      detail: pending.length === 0 ? `${applied.length} applied` : `Pending: ${pending.join(', ')}`,
    });

    const probe = `zethub_verify_${crypto.randomBytes(4).toString('hex')}`;
    await connection.query(`CREATE TEMPORARY TABLE \`${probe}\` (id INT PRIMARY KEY)`);
    await connection.query(`INSERT INTO \`${probe}\` (id) VALUES (1)`);
    const [probeRows] = await connection.query(`SELECT COUNT(*) AS n FROM \`${probe}\``);
    await connection.query(`DROP TEMPORARY TABLE \`${probe}\``);
    const wrote = Number((probeRows as Array<{ n: number }>)[0]?.n ?? 0) === 1;
    checks.push({
      check: 'Read/write probe',
      status: wrote ? 'passed' : 'failed',
      detail: wrote ? 'Temporary table written, read and dropped' : 'Temporary table read returned an unexpected value',
    });
  } catch (error) {
    checks.push({
      check: 'Connection',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await connection?.end().catch(() => undefined);
  }

  const success = checks.every((c) => c.status === 'passed');
  process.stdout.write(`${JSON.stringify({ success, database: config.db.name, checks }, null, 2)}\n`);
  process.exitCode = success ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`Verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
