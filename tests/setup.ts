/**
 * Shared test bootstrap.
 *
 * Loads the local .env without printing it and derives a disposable test
 * database URL. Unit tests never touch the database; integration/security
 * suites opt in through ZETHUB_TEST_DATABASE_URL.
 */
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: path.resolve(import.meta.dirname, '..', '.env') });
process.env.NODE_ENV = 'test';

function deriveTestUrl(): string | null {
  const base = process.env.DATABASE_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    const appDatabase = url.pathname.replace(/^\//, '');
    const testDatabase = process.env.TEST_DB_NAME ?? `${appDatabase}_test`;
    if (!testDatabase.endsWith('_test')) {
      throw new Error(`Refusing to derive a test URL for "${testDatabase}" (must end with _test).`);
    }
    url.pathname = `/${testDatabase}`;
    return url.toString();
  } catch (error) {
    throw new Error(`Could not derive a test database URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.env.ZETHUB_TEST_DATABASE_URL = deriveTestUrl() ?? '';
