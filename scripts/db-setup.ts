/**
 * ZetHub Proof database bootstrap.
 *
 * - Detects a local XAMPP MySQL/MariaDB server (no fixed install path assumption).
 * - Creates the application database and least-privilege user when authorized.
 * - Applies committed Prisma migrations.
 * - Verifies schema and runs a self-cleaning read/write health check.
 * - Never drops, resets or truncates anything.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import {
  buildDatabaseUrl,
  findRoot,
  loadEnv,
  discoverXampp,
  isPortOpen,
  startXamppDatabase,
  updateEnvFile,
  type XamppDetection,
} from '@zethub/verification-core';
import { config as loadDotenv } from 'dotenv';

interface SetupStep {
  step: string;
  status: 'passed' | 'failed' | 'skipped';
  message: string;
}

const REQUIRED_TABLES = [
  'users',
  'sessions',
  'projects',
  'project_environments',
  'project_adapters',
  'test_plans',
  'test_cases',
  'test_runs',
  'test_results',
  'test_assertions',
  'evidence_artifacts',
  'verification_reports',
  'failure_capsules',
  'repair_proposals',
  'integrations',
  'integration_credentials_metadata',
  'notifications',
  'audit_logs',
  'sync_queue',
  'user_settings',
  'db_backups',
  'db_health_checks',
  'deployment_locks',
];

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) {
    const next = process.argv[idx + 1];
    return next && !next.startsWith('--') ? next : 'true';
  }
  return undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`) || arg(name) === 'true';
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`${label} may contain only letters, digits and underscores`);
  return value;
}

function prismaCliPath(root: string): string | null {
  const candidates = [
    path.join(root, 'node_modules', 'prisma', 'build', 'index.js'),
    path.join(root, 'node_modules', '.bin', 'prisma'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function main(): Promise<void> {
  const root = findRoot();
  loadDotenv({ path: path.join(root, '.env') });
  loadEnv(root);

  const steps: SetupStep[] = [];
  const record = (step: string, status: SetupStep['status'], message: string) => {
    steps.push({ step, status, message });
    process.stdout.write(`${status === 'passed' ? '✓' : status === 'failed' ? '✗' : '–'} ${step}: ${message}\n`);
  };

  const database = safeIdentifier(arg('database') ?? process.env.DB_NAME ?? 'zethub_proof', 'Database name');
  const host = process.env.DB_HOST ?? '127.0.0.1';
  const port = Number(process.env.DB_PORT ?? 3306);
  const appUser = safeIdentifier(process.env.DB_USER ?? 'zethub_proof_app', 'DB_USER');
  const adminUser = process.env.DB_ADMIN_USER || 'root';
  const adminPassword = process.env.DB_ADMIN_PASSWORD ?? '';
  const allowCreateUser = flag('create-user') || process.env.DB_SETUP_CREATE_USER === 'true';
  const writeEnv = flag('write-env');
  const useTestDatabase = flag('test') || database.endsWith('_test');
  const existingPassword = process.env.DB_PASSWORD ?? '';
  const appPassword = existingPassword || crypto.randomBytes(18).toString('base64url');
  const sessionSecret = (process.env.SESSION_SECRET ?? '').trim();

  process.stdout.write(
    `\nZetHub Proof database setup\n${'─'.repeat(52)}\nTarget: ${appUser}@${host}:${port}/${database}\nMode:   ${useTestDatabase ? 'test database' : 'application database'}\n\n`,
  );

  /* 1. XAMPP discovery */
  const xampp: XamppDetection = await discoverXampp({
    port,
    candidates: process.env.XAMPP_HOME ? [process.env.XAMPP_HOME] : undefined,
  });
  if (xampp.found) {
    record(
      'XAMPP detection',
      'passed',
      `${xampp.installPath} (${xampp.serverType ?? 'MySQL-compatible'} ${xampp.serverVersion ?? 'version unknown'})`,
    );
  } else {
    record('XAMPP detection', 'skipped', 'XAMPP not detected; using the configured MySQL-compatible server.');
  }

  /* 2. Reachability, with optional start */
  let reachable = await isPortOpen(host, port);
  if (!reachable && flag('start-service') && xampp.found) {
    record('Service start', 'passed', 'Database is not listening; attempting a non-destructive XAMPP start...');
    const started = await startXamppDatabase(xampp.installPath!, port);
    record('Service start', started.started || started.alreadyRunning ? 'passed' : 'failed', started.message);
    reachable = await isPortOpen(host, port);
  }
  if (!reachable) {
    record(
      'Server connectivity',
      'failed',
      `${host}:${port} is not reachable. Start MySQL from the XAMPP control panel or pass --start-service.`,
    );
    finish(steps, false);
    return;
  }
  record('Server connectivity', 'passed', `${host}:${port} is accepting TCP connections.`);

  /* 3. Administrative connection */
  let admin: mysql.Connection | null = null;
  try {
    admin = await mysql.createConnection({
      host,
      port,
      user: adminUser,
      password: adminPassword,
      connectTimeout: 10_000,
      multipleStatements: false,
    });
    const [versionRows] = await admin.query('SELECT VERSION() AS version');
    const version = String((versionRows as Array<{ version: string }>)[0]?.version ?? '');
    record('Administrative connection', 'passed', `Authenticated as ${adminUser} (${version})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record('Administrative connection', 'failed', `Could not authenticate as ${adminUser}: ${message}`);
    printPhpMyAdminFallback(database, appUser, appPassword);
    finish(steps, false);
    return;
  }

  try {
    /* 4. Database creation */
    const [existing] = await admin.query(
      'SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database],
    );
    if ((existing as unknown[]).length > 0) {
      record('Database', 'passed', `Database "${database}" already exists and was preserved.`);
    } else {
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      record('Database', 'passed', `Created database "${database}" with utf8mb4/utf8mb4_unicode_ci.`);
    }

    /* 5. Application user */
    if (allowCreateUser) {
      const [userRows] = await admin.query('SELECT User, Host FROM mysql.user WHERE User = ?', [appUser]);
      const exists = (userRows as Array<{ User: string; Host: string }>).length > 0;
      if (!exists) {
        await admin.query(`CREATE USER ?@'127.0.0.1' IDENTIFIED BY ?`, [appUser, appPassword]);
        await admin.query(`CREATE USER ?@'localhost' IDENTIFIED BY ?`, [appUser, appPassword]);
        record('Application user', 'passed', `Created ${appUser} with a generated password (stored in .env only).`);
      } else {
        record('Application user', 'passed', `${appUser} already exists; password left unchanged.`);
      }
      for (const userHost of ['127.0.0.1', 'localhost']) {
        await admin.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE TEMPORARY TABLES ON \`${database}\`.* TO ?@'${userHost}'`,
          [appUser],
        );
      }
      await admin.query('FLUSH PRIVILEGES');
      record('Privileges', 'passed', `Granted schema-scoped privileges to ${appUser}@127.0.0.1 and @localhost.`);
    } else {
      record(
        'Application user',
        'skipped',
        'Pass --create-user to create or validate the application account. Using credentials from .env.',
      );
    }

    if (writeEnv) {
      const envPath = path.join(root, '.env');
      const updates: Record<string, string> = {
        DB_HOST: host,
        DB_PORT: String(port),
        DB_NAME: database,
        DB_USER: appUser,
        DATABASE_URL: buildDatabaseUrl({ user: appUser, password: appPassword, host, port, name: database }),
      };
      if (!existingPassword) updates.DB_PASSWORD = appPassword;
      let generatedSecret = false;
      if (sessionSecret.length < 32) {
        updates.SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
        generatedSecret = true;
      }
      const result = updateEnvFile(envPath, updates);
      record(
        '.env',
        'passed',
        `Updated ${envPath} (${result.updated.length} keys, ${result.appended.length} appended). Existing unrelated values were preserved.`,
      );
      if (generatedSecret) {
        record('Session secret', 'passed', 'Generated a 64-character SESSION_SECRET in .env.');
      }
    } else if (!existingPassword) {
      record(
        '.env',
        'skipped',
        `Generated password was not written. Re-run with --write-env, or set DB_PASSWORD=${appPassword}`,
      );
    } else if (sessionSecret.length < 32) {
      record(
        'Session secret',
        'skipped',
        'SESSION_SECRET is missing or shorter than 32 characters. Set one in .env or re-run with --write-env.',
      );
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  if (!existingPassword && !writeEnv && allowCreateUser) {
    record(
      'Migration',
      'failed',
      'A generated database password is not present in the environment. Re-run with --write-env so migrations can authenticate.',
    );
    finish(steps, false);
    return;
  }

  /* 6. Migrations */
  const effectivePassword = existingPassword || appPassword;
  const databaseUrl = buildDatabaseUrl({ user: appUser, password: effectivePassword, host, port, name: database });
  const prisma = prismaCliPath(root);
  if (!prisma) {
    record('Migration', 'failed', 'Prisma CLI was not found. Run npm install first.');
    finish(steps, false);
    return;
  }
  const migrate = spawnSync(
    process.execPath,
    [prisma, 'migrate', 'deploy', '--schema', path.join(root, 'prisma', 'schema.prisma')],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
      shell: false,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
  if (migrate.status !== 0) {
    record(
      'Migration',
      'failed',
      `${(migrate.stderr || migrate.stdout || 'Prisma migrate deploy failed').slice(0, 3000)}`,
    );
    finish(steps, false);
    return;
  }
  record('Migration', 'passed', 'Committed Prisma migrations are applied (migrate deploy, no reset).');

  /* 7. Schema verification + health check */
  let app: mysql.Connection | null = null;
  try {
    app = await mysql.createConnection({
      host,
      port,
      user: appUser,
      password: effectivePassword,
      database,
      connectTimeout: 10_000,
    });
    const [tables] = await app.query(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [database],
    );
    const names = (tables as Array<{ name: string }>).map((t) => t.name);
    const missing = REQUIRED_TABLES.filter((t) => !names.includes(t));
    if (missing.length > 0) {
      record('Schema verification', 'failed', `Missing tables: ${missing.join(', ')}`);
      finish(steps, false);
      return;
    }
    const [fk] = await app.query(
      'SELECT COUNT(*) AS count FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?',
      [database],
    );
    const fkCount = Number((fk as Array<{ count: number }>)[0]?.count ?? 0);
    record(
      'Schema verification',
      'passed',
      `${names.length} tables present, ${fkCount} foreign keys, all required tables found.`,
    );

    const healthId = `health_${crypto.randomUUID()}`;
    await app.query(
      'INSERT INTO db_health_checks (id, readOk, writeOk, latencyMs, checkedAt) VALUES (?, 1, 1, 0, NOW(3))',
      [healthId],
    );
    const [check] = await app.query('SELECT COUNT(*) AS count FROM db_health_checks WHERE id = ?', [healthId]);
    const readOk = Number((check as Array<{ count: number }>)[0]?.count ?? 0) === 1;
    await app.query('DELETE FROM db_health_checks WHERE id = ?', [healthId]);
    const [afterCleanup] = await app.query('SELECT COUNT(*) AS count FROM db_health_checks WHERE id = ?', [healthId]);
    const cleanupOk = Number((afterCleanup as Array<{ count: number }>)[0]?.count ?? 0) === 0;
    await app.query('DELETE FROM db_health_checks WHERE checkedAt < NOW(3) - INTERVAL 1 DAY');
    record(
      'Health check',
      readOk && cleanupOk ? 'passed' : 'failed',
      `Read/write ${readOk ? 'succeeded' : 'failed'}; temporary row ${cleanupOk ? 'removed' : 'was not cleaned up'}.`,
    );
    if (!readOk || !cleanupOk) {
      finish(steps, false);
      return;
    }
  } catch (error) {
    record('Schema verification', 'failed', error instanceof Error ? error.message : String(error));
    finish(steps, false);
    return;
  } finally {
    await app?.end().catch(() => undefined);
  }

  /* 8. Migration status summary */
  const soPath = path.join(root, 'prisma', 'migrations');
  const migrationCount = fs.existsSync(soPath)
    ? fs.readdirSync(soPath, { withFileTypes: true }).filter((d) => d.isDirectory()).length
    : 0;
  record('Migration history', 'passed', `${migrationCount} committed migration(s) in prisma/migrations.`);

  finish(steps, true, { database, databaseUrl: databaseUrl.replace(/:[^:@/]+@/, ':***@') });
}

function printPhpMyAdminFallback(database: string, user: string, password: string): void {
  process.stdout.write(
    `\nAdministrative credentials are unavailable. Execute the following in phpMyAdmin (SQL tab) with an authorized account:\n\n`,
  );
  process.stdout.write(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`,
  );
  process.stdout.write(`CREATE USER IF NOT EXISTS '${user}'@'127.0.0.1' IDENTIFIED BY '<YOUR_PASSWORD>';\n`);
  process.stdout.write(
    `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE TEMPORARY TABLES ON \`${database}\`.* TO '${user}'@'127.0.0.1';\n`,
  );
  process.stdout.write(`\nThen set DB_PASSWORD in .env and run: npm run db:migrate\n`);
  void password;
}

function finish(steps: SetupStep[], success: boolean, extra: Record<string, unknown> = {}): void {
  const failed = steps.filter((s) => s.status === 'failed');
  process.stdout.write(`\n${success ? 'Database setup complete.' : 'Database setup did not complete.'}\n`);
  if (!success) {
    process.stdout.write(`Failed step(s): ${failed.map((f) => f.step).join(', ')}\n`);
    process.stdout.write(
      'The existing database was preserved. Resolve the reported issue and re-run; setup is idempotent.\n',
    );
  }
  process.stdout.write(`${JSON.stringify({ success, steps, ...extra }, null, 2)}\n`);
  process.exitCode = success ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`Database setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
