import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  apiHost: string;
  apiPort: number;
  allowedOrigins: string[];
  rootDir: string;
  artifactsDir: string;
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    connectionTimeoutMs: number;
    adminUser: string;
    adminPassword: string;
    xamppHome: string | null;
    databaseUrl: string;
  };
  sessionSecret: string;
  trustLocalDevice: boolean;
  maxParallelTests: number;
  defaultCommandTimeoutMs: number;
  artifactRetentionDays: number;
  workspaceRoots: string[];
  ai: {
    enabled: boolean;
    provider: string | null;
    apiKey: string | null;
    model: string | null;
    baseUrl: string | null;
    consentSendCode: boolean;
  };
  githubToken: string | null;
  backupsDir: string;
  updates: {
    storageDir: string;
    feedUrl: string | null;
    publicBaseUrl: string | null;
    signingPrivateKeyPath: string | null;
    signingPublicKey: string | null;
    signingPublicKeyPath: string | null;
    betaFeedToken: string | null;
    installMode: 'manual' | 'windows-installer';
    checkTimeoutMs: number;
    maxArtifactMb: number;
  };
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, 'DB_NAME may contain only letters, digits and underscores')
    .default('zethub_proof'),
  DB_USER: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+$/)
    .default('zethub_proof_app'),
  DB_PASSWORD: z.string().default(''),
  DB_CONNECTION_TIMEOUT: z.coerce.number().int().min(1000).max(120000).default(10_000),
  DB_ADMIN_USER: z.string().default('root'),
  DB_ADMIN_PASSWORD: z.string().default(''),
  XAMPP_HOME: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  ARTIFACTS_DIR: z.string().default('./artifacts'),
  MAX_PARALLEL_TESTS: z.coerce.number().int().min(1).max(8).default(1),
  DEFAULT_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(5000).max(3_600_000).default(300_000),
  ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  WORKSPACE_ROOTS: z.string().default(''),
  SESSION_SECRET: z.string().min(16).optional(),
  TRUST_LOCAL_DEVICE: z.string().default('false'),
  AI_ENABLED: z.string().default('false'),
  AI_PROVIDER: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_CONSENT_SEND_CODE: z.string().default('false'),
  GITHUB_TOKEN: z.string().optional(),
  UPDATE_STORAGE_DIR: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().default('./data/updates'),
  ),
  UPDATE_FEED_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .url()
      .optional()
      .refine(
        (value) => {
          if (!value) return true;
          try {
            const url = new URL(value);
            return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
          } catch {
            return false;
          }
        },
        { message: 'UPDATE_FEED_URL must use HTTPS; HTTP is allowed only for loopback hosts.' },
      ),
  ),
  UPDATE_PUBLIC_BASE_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional(),
  ),
  UPDATE_SIGNING_PRIVATE_KEY_PATH: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional(),
  ),
  UPDATE_SIGNING_PUBLIC_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional(),
  ),
  UPDATE_SIGNING_PUBLIC_KEY_PATH: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional(),
  ),
  UPDATE_BETA_FEED_TOKEN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(16).optional(),
  ),
  UPDATE_INSTALL_MODE: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['manual', 'windows-installer']).default('manual'),
  ),
  UPDATE_CHECK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  UPDATE_MAX_ARTIFACT_MB: z.coerce.number().int().min(1).max(2048).default(512),
});

export class ConfigError extends Error {
  code = 'CONFIG_INVALID';
}

export function findRoot(startDir = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'prisma', 'schema.prisma')))
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/** Load .env from the repository root without overriding already-set variables. */
export function loadEnv(rootDir = findRoot()): string | null {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return null;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return envPath;
}

export function buildDatabaseUrl(
  db: { user: string; password: string; host: string; port: number; name: string },
  connectionLimit = 5,
): string {
  const user = encodeURIComponent(db.user);
  const password = encodeURIComponent(db.password);
  return `mysql://${user}:${password}@${db.host}:${db.port}/${db.name}?connection_limit=${connectionLimit}&pool_timeout=20&connect_timeout=10`;
}

export function loadConfig(overrides: Record<string, string | undefined> = {}, rootDir = findRoot()): AppConfig {
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const env = parsed.data;
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    throw new ConfigError(
      'SESSION_SECRET must be at least 32 characters. Run `npm run db:setup` to generate a local configuration.',
    );
  }
  const password = env.DB_PASSWORD;
  if (!password) {
    throw new ConfigError(
      'DB_PASSWORD is empty. Run `npm run db:setup -- --create-user --write-env` or configure an existing application account.',
    );
  }
  const databaseUrl =
    env.DATABASE_URL?.trim() ||
    buildDatabaseUrl({
      user: env.DB_USER,
      password,
      host: env.DB_HOST,
      port: env.DB_PORT,
      name: env.DB_NAME,
    });
  return {
    nodeEnv: env.NODE_ENV,
    apiHost: env.API_HOST,
    apiPort: env.API_PORT,
    allowedOrigins: env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    rootDir,
    artifactsDir: path.resolve(rootDir, env.ARTIFACTS_DIR),
    db: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      name: env.DB_NAME,
      user: env.DB_USER,
      password,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT,
      adminUser: env.DB_ADMIN_USER,
      adminPassword: env.DB_ADMIN_PASSWORD,
      xamppHome: env.XAMPP_HOME?.trim() || null,
      databaseUrl,
    },
    sessionSecret,
    trustLocalDevice: env.TRUST_LOCAL_DEVICE === 'true',
    maxParallelTests: env.MAX_PARALLEL_TESTS,
    defaultCommandTimeoutMs: env.DEFAULT_COMMAND_TIMEOUT_MS,
    artifactRetentionDays: env.ARTIFACT_RETENTION_DAYS,
    workspaceRoots: env.WORKSPACE_ROOTS.split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    ai: {
      enabled: env.AI_ENABLED === 'true',
      provider: env.AI_PROVIDER || null,
      apiKey: env.AI_API_KEY || null,
      model: env.AI_MODEL || null,
      baseUrl: env.AI_BASE_URL || null,
      consentSendCode: env.AI_CONSENT_SEND_CODE === 'true',
    },
    githubToken: env.GITHUB_TOKEN || null,
    backupsDir: path.resolve(rootDir, 'backups'),
    updates: {
      storageDir: path.resolve(rootDir, env.UPDATE_STORAGE_DIR),
      feedUrl: env.UPDATE_FEED_URL?.replace(/\/+$/, '') || null,
      publicBaseUrl: env.UPDATE_PUBLIC_BASE_URL?.replace(/\/+$/, '') || null,
      signingPrivateKeyPath: env.UPDATE_SIGNING_PRIVATE_KEY_PATH
        ? path.resolve(rootDir, env.UPDATE_SIGNING_PRIVATE_KEY_PATH)
        : null,
      signingPublicKey: env.UPDATE_SIGNING_PUBLIC_KEY || null,
      signingPublicKeyPath: env.UPDATE_SIGNING_PUBLIC_KEY_PATH
        ? path.resolve(rootDir, env.UPDATE_SIGNING_PUBLIC_KEY_PATH)
        : null,
      betaFeedToken: env.UPDATE_BETA_FEED_TOKEN || null,
      installMode: env.UPDATE_INSTALL_MODE,
      checkTimeoutMs: env.UPDATE_CHECK_TIMEOUT_MS,
      maxArtifactMb: env.UPDATE_MAX_ARTIFACT_MB,
    },
  };
}

/** Update .env values without discarding comments or unrelated keys. */
export function updateEnvFile(
  filePath: string,
  values: Record<string, string>,
): { updated: string[]; appended: string[] } {
  const updated: string[] = [];
  const appended: string[] = [];
  let lines: string[] = [];
  if (fs.existsSync(filePath)) lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const remaining = new Map(Object.entries(values));
  const result = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || !remaining.has(match[1]!)) return line;
    const key = match[1]!;
    const value = remaining.get(key)!;
    remaining.delete(key);
    updated.push(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) {
    result.push(`${key}=${value}`);
    appended.push(key);
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', { encoding: 'utf8', flag: 'wx' });
  }
  fs.writeFileSync(filePath, result.join('\n'), 'utf8');
  return { updated, appended };
}

export function requireLocalBinding(host: string): void {
  const allowed = ['127.0.0.1', 'localhost', '::1'];
  if (!allowed.includes(host)) {
    throw new ConfigError(
      `API_HOST is "${host}". ZetHub Proof requires a loopback bind (127.0.0.1/localhost/::1) to keep the local runner private.`,
    );
  }
}
