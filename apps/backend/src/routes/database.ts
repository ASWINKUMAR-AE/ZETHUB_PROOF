import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createDatabaseBackup,
  discoverXampp,
  restoreDatabaseBackup,
  startXamppDatabase,
  testDatabaseConnection,
  verifyBackupFile,
} from '@zethub/verification-core';
import { prisma } from '../db.js';
import { checkDatabase, expectedMigrations, schemaState } from '../db.js';
import { config, paths } from '../config.js';
import { authenticate, requireOwner } from '../auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict } from '../lib/http.js';
import { assertReadOnlySql } from '../lib/sql-guard.js';

function appConnection() {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    connectTimeoutMs: config.db.connectionTimeoutMs,
  };
}

async function migrationDetails() {
  const expected = expectedMigrations();
  try {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null; logs: string | null }>
    >`
      SELECT migration_name, finished_at, rolled_back_at, logs FROM _prisma_migrations ORDER BY started_at`;
    const applied = rows
      .filter((r): boolean => Boolean(r.finished_at) && !r.rolled_back_at)
      .map((r) => r.migration_name);
    const failed = rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
    return {
      expected,
      applied,
      pending: expected.filter((m) => !applied.includes(m) && !failed.includes(m)),
      failed,
      upToDate: failed.length === 0 && expected.every((m) => applied.includes(m)),
      deploymentLocked: false,
      error: null as string | null,
    };
  } catch (error) {
    return {
      expected,
      applied: [],
      pending: expected,
      failed: [],
      upToDate: false,
      deploymentLocked: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function dumpExecutable(): Promise<string | null> {
  const detection = await discoverXampp();
  if (detection.dumpExecutable) return detection.dumpExecutable;
  const probe = spawnSync('mysqldump', ['--version'], {
    timeout: 8000,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  return probe.status === 0 ? 'mysqldump' : null;
}

function serializeBackup(backup: {
  id: string;
  fileName: string;
  path: string;
  sizeBytes: bigint;
  sha256: string;
  verified: boolean;
  message: string | null;
  createdAt: Date;
}) {
  return {
    id: backup.id,
    fileName: backup.fileName,
    path: backup.path,
    sizeBytes: Number(backup.sizeBytes),
    sha256: backup.sha256,
    createdAt: backup.createdAt.toISOString(),
    verified: backup.verified,
    verificationMessage: backup.message ?? undefined,
  };
}

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/db/xampp', { preHandler: authenticate }, async () => {
    const detection = await discoverXampp();
    return { detection };
  });

  app.post('/api/v1/db/xampp/start', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const body = z
      .object({ confirm: z.literal(true), installPath: z.string().max(1024).optional() })
      .parse(request.body ?? {});
    void body;
    const detection = await discoverXampp();
    if (!detection.found && !body.installPath) {
      throw badRequest('XAMPP was not detected. Set XAMPP_HOME or browse to the installation and retry.');
    }
    const installPath = body.installPath ?? detection.installPath;
    if (!installPath) throw badRequest('No XAMPP installation path is available.');
    const port = detection.configuredPort ?? config.db.port;
    const result = await startXamppDatabase(installPath, port);
    const after = await discoverXampp();
    await audit({
      userId: auth.user.id,
      action: 'DB_SETUP',
      entityType: 'database',
      metadata: { action: 'start', installPath, port, started: result.started },
      ip: request.ip,
    });
    return { result, detection: after };
  });

  app.get('/api/v1/db/status', { preHandler: authenticate }, async () => {
    const started = Date.now();
    const connection = await testDatabaseConnection(appConnection());
    const schema = connection.ok ? await schemaState() : null;
    const migrations = connection.ok ? await migrationDetails() : null;
    const lastBackup = await prisma.dbBackup.findFirst({ orderBy: { createdAt: 'desc' } }).catch(() => null);
    return {
      status: {
        reachable: connection.ok,
        serverVersion: connection.serverVersion ?? null,
        serverType: connection.serverType,
        host: config.db.host,
        port: config.db.port,
        database: config.db.name,
        databaseExists: connection.ok,
        schemaUpToDate: schema ? schema.pending.length === 0 && schema.appliedMigrations.length > 0 : null,
        pendingMigrations: schema?.pending ?? [],
        appliedMigrations: schema?.appliedMigrations ?? [],
        tableCount: schema?.tableCount ?? 0,
        lastHealthCheck: null,
        lastBackup: lastBackup
          ? {
              fileName: lastBackup.fileName,
              createdAt: lastBackup.createdAt.toISOString(),
              verified: lastBackup.verified,
            }
          : null,
        latencyMs: connection.latencyMs ?? Date.now() - started,
        error: connection.error ?? null,
        checkedAt: new Date().toISOString(),
      },
      migrations,
    };
  });

  app.get('/api/v1/db/migrations', { preHandler: authenticate }, async () => {
    const details = await migrationDetails();
    return { migrations: details, schema: await schemaState() };
  });

  app.post('/api/v1/db/migrate', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    z.object({ confirm: z.literal(true) }).parse(request.body ?? {});
    const prismaCli = path.join(paths.root, 'node_modules', 'prisma', 'build', 'index.js');
    if (!fs.existsSync(prismaCli))
      throw badRequest('The Prisma CLI is not installed. Run npm install before deploying migrations.');
    const result = spawnSync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', path.join(paths.root, 'prisma', 'schema.prisma')],
      {
        cwd: paths.root,
        timeout: 180_000,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env: { ...process.env, DATABASE_URL: config.db.databaseUrl },
      },
    );
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(0, 20_000);
    const details = await migrationDetails();
    await audit({
      userId: auth.user.id,
      action: 'DB_MIGRATE',
      entityType: 'database',
      metadata: { exitCode: result.status, upToDate: details.upToDate },
      ip: request.ip,
    });
    if (result.status !== 0) {
      await prisma.dbHealthCheck
        .create({ data: { readOk: false, writeOk: false, latencyMs: 0 } })
        .catch(() => undefined);
      throw badRequest(`Migration deployment failed (exit ${result.status}).`, { output });
    }
    return { ok: true, output, migrations: details };
  });

  app.post('/api/v1/db/health', { preHandler: authenticate }, async () => {
    const started = Date.now();
    let readOk = false;
    let writeOk = false;
    let message = '';
    try {
      await prisma.$queryRaw`SELECT 1`;
      readOk = true;
      await prisma.$executeRawUnsafe(
        'CREATE TEMPORARY TABLE IF NOT EXISTS zethub_healthcheck_probe (id INT PRIMARY KEY, note VARCHAR(40))',
      );
      await prisma.$executeRawUnsafe("REPLACE INTO zethub_healthcheck_probe (id, note) VALUES (1, 'probe')");
      const rows = await prisma.$queryRawUnsafe<Array<{ note: string }>>(
        'SELECT note FROM zethub_healthcheck_probe WHERE id = 1',
      );
      writeOk = rows[0]?.note === 'probe';
      await prisma.$executeRawUnsafe('DROP TEMPORARY TABLE IF EXISTS zethub_healthcheck_probe');
      message =
        readOk && writeOk
          ? 'Read and write succeeded using a temporary table that was dropped afterwards.'
          : 'Write probe did not return the expected value.';
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const latencyMs = Date.now() - started;
    const record = await prisma.dbHealthCheck.create({ data: { readOk, writeOk, latencyMs } }).catch(() => null);
    return {
      health: {
        read: readOk,
        write: writeOk,
        cleanup: writeOk,
        message,
        latencyMs,
        checkedAt: record?.checkedAt.toISOString() ?? new Date().toISOString(),
      },
    };
  });

  app.get('/api/v1/db/tables', { preHandler: authenticate }, async () => {
    const tables = await prisma.$queryRaw<
      Array<{
        TABLE_NAME: string;
        TABLE_ROWS: bigint | null;
        DATA_LENGTH: bigint | null;
        INDEX_LENGTH: bigint | null;
        ENGINE: string | null;
        TABLE_COLLATION: string | null;
      }>
    >`
      SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, ENGINE, TABLE_COLLATION
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`;
    const columns = await prisma.$queryRaw<
      Array<{ TABLE_NAME: string; COLUMN_NAME: string; COLUMN_TYPE: string; IS_NULLABLE: string; COLUMN_KEY: string }>
    >`
      SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`;
    return {
      tables: tables.map((t) => ({
        name: t.TABLE_NAME,
        rows: t.TABLE_ROWS === null ? null : Number(t.TABLE_ROWS),
        dataBytes: t.DATA_LENGTH === null ? null : Number(t.DATA_LENGTH),
        indexBytes: t.INDEX_LENGTH === null ? null : Number(t.INDEX_LENGTH),
        engine: t.ENGINE,
        collation: t.TABLE_COLLATION,
        columns: columns
          .filter((c) => c.TABLE_NAME === t.TABLE_NAME)
          .map((c) => ({
            name: c.COLUMN_NAME,
            type: c.COLUMN_TYPE,
            nullable: c.IS_NULLABLE === 'YES',
            key: c.COLUMN_KEY,
          })),
      })),
      database: config.db.name,
    };
  });

  app.get('/api/v1/db/tables/:name/preview', { preHandler: authenticate }, async (request) => {
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    const limit = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse(request.query ?? {}).limit;
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw badRequest('Invalid table name.');
    const exists = await prisma.$queryRaw<Array<{ TABLE_NAME: string }>>`
      SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${name}`;
    if (exists.length === 0) throw badRequest('Table does not exist in the application database.');
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM \`${name}\` LIMIT ${limit}`,
    );
    return {
      table: name,
      rows: rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v,
          ]),
        ),
      ),
    };
  });

  app.post('/api/v1/db/query', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const body = z.object({ sql: z.string().min(1).max(20_000) }).parse(request.body);
    const sql = assertReadOnlySql(body.sql);
    const started = Date.now();
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql);
    const normalized = rows
      .slice(0, 200)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v,
          ]),
        ),
      );
    await audit({
      userId: auth.user.id,
      action: 'SECURITY_DENIED',
      entityType: 'database-query',
      metadata: { event: 'read-only-query', statements: 1, durationMs: Date.now() - started },
      ip: request.ip,
    });
    return {
      rows: normalized,
      rowCount: normalized.length,
      truncated: rows.length > 200,
      durationMs: Date.now() - started,
    };
  });

  app.get('/api/v1/db/backups', { preHandler: authenticate }, async () => {
    const items = await prisma.dbBackup.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    return { items: items.map(serializeBackup), directory: config.backupsDir };
  });

  app.post('/api/v1/db/backups', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    z.object({ confirm: z.literal(true) }).parse(request.body ?? {});
    const dump = await dumpExecutable();
    if (!dump) throw badRequest('mysqldump was not found. Install the MySQL client or start XAMPP.');
    const backup = await createDatabaseBackup({
      dumpExecutable: dump,
      host: config.db.host,
      port: config.db.port,
      user: config.db.adminUser,
      password: config.db.adminPassword,
      database: config.db.name,
      outputDir: config.backupsDir,
    });
    const record = await prisma.dbBackup.create({
      data: {
        fileName: backup.fileName,
        path: backup.path,
        sizeBytes: BigInt(backup.sizeBytes),
        sha256: backup.sha256,
        verified: backup.verified,
        message: backup.verificationMessage ?? null,
      },
    });
    await audit({
      userId: auth.user.id,
      action: 'DB_BACKUP',
      entityType: 'database',
      entityId: record.id,
      metadata: { fileName: record.fileName, sizeBytes: Number(record.sizeBytes) },
      ip: request.ip,
    });
    return { backup: serializeBackup(record) };
  });

  app.post('/api/v1/db/backups/:id/verify', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const record = await prisma.dbBackup.findUnique({ where: { id } });
    if (!record) throw badRequest('Backup record not found.');
    const verification = verifyBackupFile(record.path, record.sha256);
    const updated = await prisma.dbBackup.update({
      where: { id },
      data: { verified: verification.verified, message: verification.message },
    });
    await audit({
      userId: auth.user.id,
      action: 'DB_BACKUP',
      entityType: 'database',
      entityId: id,
      metadata: { action: 'verify', verified: verification.verified },
      ip: request.ip,
    });
    return { backup: serializeBackup(updated), verification };
  });

  app.post('/api/v1/db/restore', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const body = z
      .object({
        backupId: z.string().min(1),
        confirmDatabaseName: z.string().min(1),
        confirm: z.literal(true),
      })
      .parse(request.body);
    if (body.confirmDatabaseName !== config.db.name)
      throw badRequest(`Type the exact database name (${config.db.name}) to confirm the restore.`);
    const record = await prisma.dbBackup.findUnique({ where: { id: body.backupId } });
    if (!record) throw badRequest('Backup record not found.');
    const verification = verifyBackupFile(record.path, record.sha256);
    if (!verification.verified) throw badRequest(`Backup failed verification: ${verification.message}`);
    const dump = await dumpExecutable();
    if (!dump) throw badRequest('mysql client (dump executable) was not found.');

    // Take a safety snapshot before overwriting anything.
    const safety = await createDatabaseBackup({
      dumpExecutable: dump,
      host: config.db.host,
      port: config.db.port,
      user: config.db.adminUser,
      password: config.db.adminPassword,
      database: config.db.name,
      outputDir: config.backupsDir,
    });
    await prisma.dbBackup.create({
      data: {
        fileName: safety.fileName,
        path: safety.path,
        sizeBytes: BigInt(safety.sizeBytes),
        sha256: safety.sha256,
        verified: safety.verified,
        message: `Pre-restore safety snapshot. ${safety.verificationMessage ?? ''}`.trim(),
      },
    });
    const safetyRecord = await prisma.dbBackup.findFirst({ where: { fileName: safety.fileName } });

    const result = await restoreDatabaseBackup({
      dumpExecutable: dump,
      host: config.db.host,
      port: config.db.port,
      user: config.db.adminUser,
      password: config.db.adminPassword,
      database: config.db.name,
      inputPath: record.path,
    });
    await audit({
      userId: auth.user.id,
      action: 'DB_RESTORE',
      entityType: 'database',
      entityId: record.id,
      metadata: { ok: result.ok, safetyBackup: safety.fileName },
      ip: request.ip,
    });
    if (!result.ok) throw conflict(result.message);
    return { ok: true, message: result.message, safetyBackup: safetyRecord ? serializeBackup(safetyRecord) : null };
  });

  app.post('/api/v1/db/setup/verify', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const steps: Array<{ step: string; status: 'passed' | 'failed' | 'skipped'; message: string }> = [];
    const detection = await discoverXampp();
    steps.push({
      step: 'XAMPP detection',
      status: detection.found ? 'passed' : 'skipped',
      message: detection.found
        ? `Found ${detection.serverType ?? 'MySQL/MariaDB'} at ${detection.installPath}`
        : 'No XAMPP installation detected. An external MySQL server can still be used.',
    });
    const db = await checkDatabase();
    steps.push({
      step: 'Application connection',
      status: db.available ? 'passed' : 'failed',
      message: db.available ? 'Connected with the dedicated application account.' : `Connection failed: ${db.error}`,
    });
    const schema = await schemaState();
    steps.push({
      step: 'Schema verification',
      status: schema.accessible && schema.pending.length === 0 ? 'passed' : 'failed',
      message: schema.accessible
        ? `${schema.tableCount} tables present; ${schema.pending.length} pending migration(s).`
        : `Schema check failed: ${schema.error}`,
    });
    let health: { read: boolean; write: boolean; cleanup: boolean; message: string } | null = null;
    if (db.available) {
      let read = false;
      let write = false;
      let message = '';
      try {
        await prisma.$queryRaw`SELECT 1`;
        read = true;
        await prisma.$executeRawUnsafe('CREATE TEMPORARY TABLE IF NOT EXISTS zethub_setup_probe (id INT PRIMARY KEY)');
        await prisma.$executeRawUnsafe('INSERT INTO zethub_setup_probe (id) VALUES (1)');
        await prisma.$executeRawUnsafe('DROP TEMPORARY TABLE zethub_setup_probe');
        write = true;
        message = 'Read/write probe succeeded and cleaned up after itself.';
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      health = { read, write, cleanup: write, message };
      steps.push({ step: 'Health check', status: read && write ? 'passed' : 'failed', message });
    } else {
      steps.push({ step: 'Health check', status: 'skipped', message: 'Database is unreachable.' });
    }
    await audit({
      userId: auth.user.id,
      action: 'DB_SETUP',
      entityType: 'database',
      metadata: { action: 'verify', ok: steps.every((s) => s.status !== 'failed') },
      ip: request.ip,
    });
    return {
      success: steps.every((s) => s.status !== 'failed'),
      steps,
      detection,
      health,
      migrations: await migrationDetails(),
    };
  });

  app.get('/api/v1/db/dashboard', { preHandler: authenticate }, async () => {
    const [connection, migrations, backups, lastHealth] = await Promise.all([
      testDatabaseConnection(appConnection()),
      migrationDetails(),
      prisma.dbBackup.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.dbHealthCheck.findFirst({ orderBy: { checkedAt: 'desc' } }),
    ]);
    const detection = await discoverXampp();
    let tableCount = 0;
    if (connection.ok) {
      const tables = await prisma.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`;
      tableCount = Number(tables[0]?.n ?? 0);
    }
    return {
      xampp: detection,
      connection: { ...connection, host: config.db.host, port: config.db.port, database: config.db.name },
      migrations,
      tableCount,
      backups: backups.map(serializeBackup),
      backupDirectory: config.backupsDir,
      lastHealthCheck: lastHealth
        ? {
            readOk: lastHealth.readOk,
            writeOk: lastHealth.writeOk,
            latencyMs: lastHealth.latencyMs,
            checkedAt: lastHealth.checkedAt.toISOString(),
          }
        : null,
      limits: {
        destructiveActions:
          'Restore requires typing the exact database name and creates a safety snapshot first. Drop/reset actions are not exposed by the API.',
        postgres: 'Only MySQL/MariaDB connections are implemented.',
      },
    };
  });

  app.get('/api/v1/db/health-history', { preHandler: authenticate }, async () => {
    const items = await prisma.dbHealthCheck.findMany({ orderBy: { checkedAt: 'desc' }, take: 50 });
    return {
      items: items.map((i) => ({
        id: i.id,
        readOk: i.readOk,
        writeOk: i.writeOk,
        latencyMs: i.latencyMs,
        checkedAt: i.checkedAt.toISOString(),
      })),
    };
  });

  app.get('/api/v1/system/health', async () => {
    const db = await checkDatabase();
    return {
      ok: true,
      api: 'ok',
      database: db.available ? 'ok' : 'unavailable',
      version: '0.1.0',
      checkedAt: new Date().toISOString(),
      details: db.available ? undefined : { databaseError: 'Database unreachable' },
    };
  });
}
