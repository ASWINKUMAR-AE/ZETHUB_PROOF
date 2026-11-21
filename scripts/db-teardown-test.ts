/**
 * Removes the disposable integration-test database.
 *
 * Safety rails: the target name must end with `_test`, must differ from the
 * application database, and `--confirm` is mandatory. The application
 * database is never touched by this script.
 */
import mysql from 'mysql2/promise';
import { findRoot, loadEnv, loadConfig } from '../packages/verification-core/src/index.ts';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv(findRoot());
  const config = loadConfig();
  const target = arg('database') ?? process.env.TEST_DB_NAME ?? `${config.db.name}_test`;
  if (!target.endsWith('_test')) throw new Error('Refusing to drop a database whose name does not end with "_test".');
  if (target === config.db.name) throw new Error('Refusing to drop the application database.');
  if (!process.argv.includes('--confirm')) {
    process.stdout.write(`Would drop test database "${target}". Re-run with --confirm to proceed.\n`);
    return;
  }

  const admin = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.adminUser,
    password: config.db.adminPassword,
    connectTimeout: config.db.connectionTimeoutMs,
  });
  try {
    const [rows] = await admin.query(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [target],
    );
    if ((rows as unknown[]).length === 0) {
      process.stdout.write(`Test database "${target}" does not exist; nothing to do.\n`);
      return;
    }
    await admin.query(`DROP DATABASE \`${target}\``);
    process.stdout.write(`Dropped disposable test database "${target}".\n`);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
