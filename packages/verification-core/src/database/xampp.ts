import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { BackupRecord, XamppDetection } from '@zethub/shared-types';

export interface XamppCandidate {
  path: string;
  valid: boolean;
  reason?: string;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function parseXamppProperties(installPath: string): {
  port?: number;
  dataDir?: string;
  installDir?: string;
  phpMyAdminPath?: string;
} {
  const ini = path.join(installPath, 'properties.ini');
  if (!exists(ini)) return {};
  let text = '';
  try {
    text = fs.readFileSync(ini, 'utf8');
  } catch {
    return {};
  }
  const port = Number(text.match(/^mysql_port\s*=\s*(\d+)/m)?.[1] ?? NaN);
  const dataDir = text.match(/^mysql_data_directory\s*=\s*(.+)$/m)?.[1]?.trim();
  const installDir = text.match(/^installdir\s*=\s*(.+)$/m)?.[1]?.trim();
  const phpMyAdminPath = exists(path.join(installPath, 'phpMyAdmin'))
    ? path.join(installPath, 'phpMyAdmin')
    : undefined;
  return {
    port: Number.isFinite(port) ? port : undefined,
    dataDir,
    installDir,
    phpMyAdminPath,
  };
}

export function buildXamppCandidateList(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = new Set<string>();
  if (env.XAMPP_HOME) candidates.add(env.XAMPP_HOME);
  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:']) {
      candidates.add(`${drive}\\xampp`);
      candidates.add(`${drive}\\xampp_new`);
      candidates.add(`${drive}\\tools\\xampp`);
      candidates.add(`${drive}\\Program Files\\xampp`);
      candidates.add(`${drive}\\Program Files (x86)\\xampp`);
      // Root-level discovery: XAMPP is often unpacked into a custom folder.
      try {
        for (const entry of fs.readdirSync(`${drive}\\`, { withFileTypes: true })) {
          if (entry.isDirectory() && /xampp/i.test(entry.name)) candidates.add(`${drive}\\${entry.name}`);
        }
      } catch {
        /* drive may not exist */
      }
    }
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (base) candidates.add(path.join(base, 'xampp'));
      if (base) candidates.add(path.join(base, 'XAMPP'));
    }
  } else {
    candidates.add('/opt/lampp');
    candidates.add('/opt/xampp');
    candidates.add(path.join(os.homedir(), 'xampp'));
    candidates.add('/usr/local/xampp');
  }
  return [...candidates];
}

function validateXampp(dir: string): { valid: boolean; reason?: string; binDir?: string } {
  if (!exists(dir)) return { valid: false, reason: 'Directory does not exist' };
  const binDir = path.join(dir, 'mysql', 'bin');
  const exe = process.platform === 'win32' ? '.exe' : '';
  if (!exists(path.join(binDir, `mysqld${exe}`)) && !exists(path.join(binDir, 'mysqld'))) {
    return { valid: false, reason: 'mysql/bin/mysqld not found' };
  }
  if (!exists(path.join(binDir, `mysql${exe}`)) && !exists(path.join(binDir, 'mysql'))) {
    return { valid: false, reason: 'mysql/bin/mysql client not found' };
  }
  return { valid: true, binDir };
}

function probeServerVersion(serverExe: string): string | undefined {
  try {
    const result = spawnSync(serverExe, ['--version'], {
      timeout: 8000,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return text.match(/(\d+\.\d+\.\d+(?:-MariaDB)?)/)?.[1];
  } catch {
    return undefined;
  }
}

export function isPortOpen(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host === 'localhost' ? '127.0.0.1' : host);
    } catch {
      done(false);
    }
  });
}

function serverProcessRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq mysqld.exe', '/FO', 'CSV', '/NH'], {
        timeout: 6000,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
      });
      return /mysqld\.exe/i.test(result.stdout ?? '');
    }
    return (
      exists('/proc') &&
      fs.readdirSync('/proc').some((pid) => {
        try {
          return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'mysqld';
        } catch {
          return false;
        }
      })
    );
  } catch {
    return false;
  }
}

export interface DiscoverOptions {
  candidates?: string[];
  probe?: boolean;
  port?: number;
}

export async function discoverXampp(options: DiscoverOptions = {}): Promise<XamppDetection> {
  const candidates = options.candidates ?? buildXamppCandidateList();
  const checked: XamppCandidate[] = [];
  let chosen: { dir: string; binDir: string } | null = null;
  for (const candidate of candidates) {
    const result = validateXampp(candidate);
    checked.push({ path: candidate, valid: result.valid, reason: result.reason });
    if (result.valid && !chosen) chosen = { dir: path.resolve(candidate), binDir: result.binDir! };
  }

  const configuredPort = chosen ? parseXamppProperties(chosen.dir).port : undefined;
  const port = options.port ?? configuredPort ?? 3306;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const warnings: string[] = [];
  if (!chosen) {
    warnings.push('XAMPP installation was not detected. Use the custom path setting if XAMPP is installed elsewhere.');
  } else if (options.port && configuredPort && options.port !== configuredPort) {
    warnings.push(`Configured DB_PORT (${options.port}) differs from XAMPP's properties.ini port (${configuredPort}).`);
  }

  const serverExe = chosen ? path.join(chosen.binDir, `mysqld${exe}`) : null;
  const clientExe = chosen ? path.join(chosen.binDir, `mysql${exe}`) : null;
  const dumpExe = chosen
    ? ([path.join(chosen.binDir, `mariadb-dump${exe}`), path.join(chosen.binDir, `mysqldump${exe}`)].find(exists) ??
      null)
    : null;
  const adminExe = chosen
    ? ([path.join(chosen.binDir, `mariadb-admin${exe}`), path.join(chosen.binDir, `mysqladmin${exe}`)].find(exists) ??
      null)
    : null;
  const version = serverExe ? probeServerVersion(serverExe) : undefined;
  const props = chosen ? parseXamppProperties(chosen.dir) : {};

  const [mysqlListening, apacheListening] = await Promise.all([
    isPortOpen('127.0.0.1', port),
    isPortOpen('127.0.0.1', 80),
  ]);

  const phpMyAdminUrl = apacheListening && props.phpMyAdminPath ? `http://127.0.0.1/phpmyadmin/` : null;

  return {
    found: Boolean(chosen),
    installPath: chosen?.dir ?? null,
    mysqlBinDir: chosen?.binDir ?? null,
    serverExecutable: serverExe,
    clientExecutable: clientExe,
    dumpExecutable: dumpExe,
    adminExecutable: adminExe,
    serverType: version ? (/mariadb/i.test(version) ? 'MariaDB' : 'MySQL') : null,
    serverVersion: version ?? null,
    configuredPort: props.port ?? null,
    dataDir: props.dataDir ?? null,
    phpMyAdminPath: props.phpMyAdminPath ?? null,
    phpMyAdminUrl,
    apacheRunning: apacheListening,
    mysqlProcessRunning: serverProcessRunning() || mysqlListening,
    serviceName: null,
    serviceState: mysqlListening ? 'running' : serverProcessRunning() ? 'process-running' : 'stopped',
    candidates: checked.filter((c) => c.valid || /xampp/i.test(c.path)).slice(0, 20),
    warnings,
  };
}

export interface StartResult {
  started: boolean;
  alreadyRunning: boolean;
  message: string;
  logPath?: string;
}

/** Start XAMPP MariaDB/MySQL without invoking a shell or stopping anything. */
export async function startXamppDatabase(installPath: string, port: number, timeoutMs = 30_000): Promise<StartResult> {
  const validation = validateXampp(installPath);
  if (!validation.valid)
    return { started: false, alreadyRunning: false, message: validation.reason ?? 'Invalid XAMPP installation' };
  if (await isPortOpen('127.0.0.1', port)) {
    return {
      started: false,
      alreadyRunning: true,
      message: 'Database server is already reachable on the configured port.',
    };
  }
  const exe = process.platform === 'win32' ? '.exe' : '';
  const server = path.join(validation.binDir!, `mysqld${exe}`);
  const dataDir = parseXamppProperties(installPath).dataDir;
  if (!dataDir || !exists(dataDir)) {
    return {
      started: false,
      alreadyRunning: false,
      message: 'XAMPP data directory is not configured in properties.ini; start MySQL from the XAMPP control panel.',
    };
  }
  const logDir = path.join(installPath, 'mysql', 'data');
  const logPath = path.join(logDir, 'zethub-start.log');
  const out = fs.openSync(logPath, 'a');
  try {
    const child = spawn(server, [`--datadir=${dataDir}`, `--port=${port}`, '--console'], {
      cwd: path.join(installPath, 'mysql', 'bin'),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
      shell: false,
    });
    child.unref();
  } catch (error) {
    return {
      started: false,
      alreadyRunning: false,
      message: `Failed to start database: ${error instanceof Error ? error.message : String(error)}`,
      logPath,
    };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen('127.0.0.1', port, 800)) {
      return { started: true, alreadyRunning: false, message: `Database became reachable on port ${port}.`, logPath };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    started: false,
    alreadyRunning: false,
    message: `Database did not become reachable within ${timeoutMs}ms. Inspect the log for details.`,
    logPath,
  };
}

export interface DumpOptions {
  dumpExecutable: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  outputDir: string;
}

/** Password is passed via MYSQL_PWD, never as a command-line argument. */
export async function createDatabaseBackup(options: DumpOptions): Promise<BackupRecord> {
  fs.mkdirSync(options.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `zethub_proof_${stamp}.sql`;
  const outputPath = path.join(options.outputDir, fileName);
  const args = [
    '--host',
    options.host,
    '--port',
    String(options.port),
    '--user',
    options.user,
    '--single-transaction',
    '--routines',
    '--events',
    '--default-character-set=utf8mb4',
    options.database,
  ];
  const result = spawnSync(options.dumpExecutable, args, {
    timeout: 300_000,
    windowsHide: true,
    shell: false,
    encoding: 'buffer',
    env: { ...process.env, MYSQL_PWD: options.password },
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Backup failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const err = (result.stderr ?? Buffer.from('')).toString('utf8').slice(0, 4000);
    throw new Error(`Backup failed (exit ${result.status}): ${err}`);
  }
  fs.writeFileSync(outputPath, result.stdout ?? Buffer.alloc(0));
  const content = fs.readFileSync(outputPath);
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const verified =
    content.length > 0 &&
    /CREATE TABLE|MariaDB dump|MySQL dump/i.test(content.toString('utf8', 0, Math.min(content.length, 200_000)));
  return {
    fileName,
    path: outputPath,
    sizeBytes: content.length,
    sha256: sha,
    createdAt: new Date().toISOString(),
    verified,
    verificationMessage: verified
      ? 'Dump contains a schema/header marker.'
      : 'Dump is empty or does not contain a recognizable schema marker.',
  };
}

export function verifyBackupFile(
  filePath: string,
  expectedSha?: string,
): { verified: boolean; sizeBytes: number; message: string } {
  if (!exists(filePath)) return { verified: false, sizeBytes: 0, message: 'Backup file not found' };
  const buffer = fs.readFileSync(filePath);
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expectedSha && sha !== expectedSha)
    return { verified: false, sizeBytes: buffer.length, message: 'SHA-256 does not match the recorded backup' };
  const ok =
    buffer.length > 0 &&
    /CREATE TABLE|MariaDB dump|MySQL dump/i.test(buffer.toString('utf8', 0, Math.min(buffer.length, 200_000)));
  return { verified: ok, sizeBytes: buffer.length, message: ok ? `Verified SHA-256 ${sha}` : 'Missing schema marker' };
}

/** Restores a dump. The caller must obtain explicit confirmation first. */
export async function restoreDatabaseBackup(
  options: Omit<DumpOptions, 'outputDir'> & { inputPath: string },
): Promise<{ ok: boolean; message: string }> {
  if (!exists(options.inputPath)) return { ok: false, message: 'Backup file not found' };
  const args = ['--host', options.host, '--port', String(options.port), '--user', options.user, options.database];
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(options.dumpExecutable, args, {
      windowsHide: true,
      shell: false,
      env: { ...process.env, MYSQL_PWD: options.password },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 4000);
    });
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin?.end(fs.createReadStream(options.inputPath));
  });
  return result.code === 0
    ? { ok: true, message: 'Restore completed.' }
    : { ok: false, message: `Restore failed (exit ${result.code}): ${result.stderr.slice(0, 2000)}` };
}
