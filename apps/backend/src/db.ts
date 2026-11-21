import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { config, paths } from './config.js';

export const prisma = new PrismaClient({
  datasourceUrl: config.db.databaseUrl,
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

let lastAvailability = false;
let lastError: string | null = null;

export interface DbAvailability {
  available: boolean;
  error: string | null;
  checkedAt: string;
}

export async function checkDatabase(): Promise<DbAvailability> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    lastAvailability = true;
    lastError = null;
  } catch (error) {
    lastAvailability = false;
    lastError = error instanceof Error ? error.message : String(error);
  }
  return { available: lastAvailability, error: lastError, checkedAt: new Date().toISOString() };
}

export function cachedAvailability(): DbAvailability {
  return { available: lastAvailability, error: lastError, checkedAt: new Date().toISOString() };
}

export interface SchemaState {
  accessible: boolean;
  appliedMigrations: string[];
  expectedMigrations: string[];
  pending: string[];
  tableCount: number;
  error: string | null;
}

export function expectedMigrations(): string[] {
  const dir = path.join(paths.root, 'prisma', 'migrations');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{8,}/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export async function schemaState(): Promise<SchemaState> {
  const expected = expectedMigrations();
  try {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
    >`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at`;
    const applied = rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`;
    return {
      accessible: true,
      appliedMigrations: applied,
      expectedMigrations: expected,
      pending: expected.filter((m) => !applied.includes(m)),
      tableCount: tables.length,
      error: null,
    };
  } catch (error) {
    return {
      accessible: false,
      appliedMigrations: [],
      expectedMigrations: expected,
      pending: expected,
      tableCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
