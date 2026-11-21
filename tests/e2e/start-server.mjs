#!/usr/bin/env node
/**
 * Playwright web server: runs the real built backend against the disposable
 * `_test` database on port 4100, then bootstraps a local owner account.
 * It refuses to touch a database whose name does not end in `_test`.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnvFile() {
  const fs = require('node:fs');
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
loadEnvFile();

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL is not configured; run npm run db:setup first.');
const parsedUrl = new URL(baseUrl);
const appDatabase = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
const database = appDatabase.endsWith('_test') ? appDatabase : `${appDatabase}_test`;
if (!database.endsWith('_test')) throw new Error(`E2E refuses to use non-test database "${database}".`);
parsedUrl.pathname = `/${database}`;
const testUrl = parsedUrl.toString();

Object.assign(process.env, {
  DATABASE_URL: testUrl,
  DB_NAME: database,
  NODE_ENV: 'test',
  API_PORT: '4100',
  API_HOST: '127.0.0.1',
  ALLOWED_ORIGINS: 'http://127.0.0.1:4100,http://localhost:4100',
});

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasourceUrl: testUrl });
await prisma.user.deleteMany({});
await prisma.$disconnect();

const { buildApp } = await import('../../apps/backend/dist/app.js');
const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: 4100 });
app.log.info(`E2E API and UI listening on http://127.0.0.1:4100 (database ${database})`);

const email = 'e2e-owner@zethub.test';
const password = 'E2E!Passw0rd2026'; // zethub-secret-scan:ignore test-only fixture
const bootstrap = await fetch('http://127.0.0.1:4100/api/v1/auth/bootstrap', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, name: 'E2E Owner', password }),
});
if (!bootstrap.ok) {
  throw new Error(`E2E bootstrap failed: ${bootstrap.status} ${await bootstrap.text()}`);
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info(`E2E server shutting down (${signal}).`);
  await app.close().catch(() => undefined);
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
