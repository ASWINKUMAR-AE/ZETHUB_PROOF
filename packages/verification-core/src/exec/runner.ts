import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BoundedBuffer, redactWithCount } from '../utils/redact.js';
import { isInsideRoot, resolveInside } from '../utils/paths.js';

export interface RunCommandOptions {
  executable: string;
  args: string[];
  cwd: string;
  /** Only these prefixes are passed from the caller; host env is minimized. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Absolute project root. cwd must stay inside it. */
  projectRoot?: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface RunCommandResult {
  commandDisplay: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  spawnError?: string;
  redactions: number;
}

export class CommandPolicyError extends Error {
  code = 'COMMAND_NOT_ALLOWED';
}

/** Tools that can legally appear as a plan executable. Shells are deliberately absent. */
export const ALLOWED_EXECUTABLES = new Set([
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'python',
  'python3',
  'py',
  'pytest',
  'pip',
  'pip3',
  'cargo',
  'rustc',
  'go',
  'dotnet',
  'java',
  'javac',
  'mvn',
  'mvnw',
  'gradle',
  'gradlew',
  'gradlew.bat',
  'php',
  'composer',
  'phpunit',
  'git',
  'docker',
  'make',
  'cmake',
  'ctest',
  'tsc',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'playwright',
  'mypy',
  'ruff',
  'black',
  'flake8',
  'bandit',
  'shellcheck',
  'gitleaks',
  'trivy',
  'npm-audit',
]);

const SHELLS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'wsl']);

export interface SpawnSpec {
  executable: string;
  args: string[];
  /** Human-readable explanation when the plan cannot be executed safely. */
  blocked?: string;
}

function findNpmCli(source: string): string | null {
  if (!source) return null;
  const dir = path.dirname(source);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Translate a plan command into a safe spawn specification.
 * Windows .cmd/.bat shims cannot be spawned without a shell, so npm/npx are
 * translated to `node <cli>.js`. Other batch shims are reported as blocked
 * rather than silently invoking cmd.exe.
 */
export function resolveSpawnSpec(executable: string, args: string[], projectRoot?: string): SpawnSpec {
  let exe = executable.trim();
  if (!exe) return { executable: '', args, blocked: 'Empty executable' };
  if (!path.isAbsolute(exe) && /[\\/]/.test(exe) && projectRoot) exe = path.resolve(projectRoot, exe);
  const base = path.basename(exe).toLowerCase();
  const stem = base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  const isWin = process.platform === 'win32';

  if (isWin && (stem === 'npm' || stem === 'npx')) {
    const npmPath = path.isAbsolute(exe) && fs.existsSync(exe) ? exe : (findOnPath('npm') ?? findOnPath('npx'));
    const cli = npmPath ? findNpmCli(npmPath) : null;
    if (!cli) {
      return {
        executable: '',
        args,
        blocked: 'npm CLI entry point could not be located. Install Node.js with npm, then retry.',
      };
    }
    const target = stem === 'npx' ? cli.replace(/npm-cli\.js$/, 'npx-cli.js') : cli;
    if (!fs.existsSync(target)) return { executable: '', args, blocked: `${stem} CLI not found next to npm` };
    return { executable: process.execPath, args: [target, ...args] };
  }

  if (isWin && /\.(cmd|bat)$/i.test(exe)) {
    return {
      executable: '',
      args,
      blocked: `Windows batch shim "${path.basename(exe)}" cannot be executed without a shell. Install the underlying tool on PATH or run the project under WSL/Linux.`,
    };
  }

  if (isWin && /^python(3)?\.exe$/i.test(base) && /[\\/]WindowsApps[\\/]/i.test(exe)) {
    const py = findOnPath('py');
    if (py) return { executable: py, args };
    return {
      executable: '',
      args,
      blocked:
        'The Python launcher on PATH is the Windows Store alias and did not run. Install Python from python.org.',
    };
  }

  if (path.isAbsolute(exe)) {
    if (!fs.existsSync(exe)) return { executable: exe, args, blocked: `Executable does not exist: ${exe}` };
    return { executable: exe, args };
  }

  const resolved = findOnPath(stem);
  if (!resolved) {
    return {
      executable: exe,
      args,
      blocked: `"${executable}" was not found on PATH. Install it or configure the project so its native tool is available.`,
    };
  }
  if (isWin && /\.(cmd|bat)$/i.test(resolved)) {
    return {
      executable: '',
      args,
      blocked: `Resolved "${executable}" to a batch shim; this runner refuses to invoke cmd.exe. Install a native executable.`,
    };
  }
  return { executable: resolved, args };
}

function findOnPath(name: string): string | null {
  const pathValue = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function assertSafeCommand(executable: string, args: string[], cwd: string, projectRoot?: string): void {
  const exeBase = path
    .basename(executable)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/i, '');
  if (SHELLS.has(exeBase)) throw new CommandPolicyError('Shell interpreters are not permitted as test executables');
  if (!ALLOWED_EXECUTABLES.has(exeBase)) {
    throw new CommandPolicyError(`Executable "${path.basename(executable)}" is not on the ZetHub Proof allowlist`);
  }
  if (!Array.isArray(args)) throw new CommandPolicyError('Arguments must be an array');
  for (const arg of args) {
    if (typeof arg !== 'string') throw new CommandPolicyError('Non-string argument rejected');
    if (arg.includes('\0')) throw new CommandPolicyError('NUL byte in argument');
  }
  if (process.platform === 'win32') {
    if (/[&|<>^]/.test(executable)) throw new CommandPolicyError('Metacharacters in executable path');
  }
  if (projectRoot) {
    if (!isInsideRoot(projectRoot, cwd)) throw new CommandPolicyError('Working directory escapes the project root');
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new CommandPolicyError(`Working directory does not exist: ${cwd}`);
  }
}

/** Minimal environment. Database credentials and unrelated host secrets are never inherited. */
export function buildSafeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    Path: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LANG: process.env.LANG,
    CI: process.env.CI,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (!/^ZETHUB_[A-Z0-9_]+$/.test(k)) continue;
    base[k] = v;
  }
  for (const key of Object.keys(base)) if (base[key] === undefined) delete base[key];
  return base;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    /* best effort cleanup */
  }
}

export function displayCommand(executable: string, args: string[]): string {
  const quote = (v: string) => (/^[\w@./:=+,%-]+$/.test(v) ? v : JSON.stringify(v));
  return [quote(path.basename(executable)), ...args.map(quote)].join(' ');
}

/**
 * Execute a child process without a shell, capture bounded output, enforce a
 * timeout and kill the entire process tree on timeout/cancellation.
 */
export async function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const cwd = resolveInside(
    options.projectRoot ?? options.cwd,
    path.relative(options.projectRoot ?? options.cwd, options.cwd) || '.',
  );
  assertSafeCommand(options.executable, options.args, cwd, options.projectRoot);

  const stdout = new BoundedBuffer(options.maxOutputBytes ?? 512 * 1024);
  const stderr = new BoundedBuffer(options.maxOutputBytes ?? 512 * 1024);
  const started = Date.now();
  let timedOut = false;
  let cancelled = false;
  let spawnError: string | undefined;
  let redactions = 0;

  const child = spawn(options.executable, options.args, {
    cwd,
    env: buildSafeEnv(options.env),
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const streamHandler = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const raw = chunk.toString('utf8');
    const redacted = redactWithCount(raw);
    redactions += redacted.replacements;
    (stream === 'stdout' ? stdout : stderr).append(redacted.text);
    if (options.onLine) {
      for (const line of redacted.text.split(/\r?\n/)) {
        if (line.trim()) options.onLine(stream, line.slice(0, 2000));
      }
    }
  };

  child.stdout?.on('data', streamHandler('stdout'));
  child.stderr?.on('data', streamHandler('stderr'));

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('error', (err) => {
      spawnError = err.message;
      resolve({ code: null, signal: null });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);

  const onAbort = () => {
    cancelled = true;
    killTree(child);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const { code, signal } = await exitPromise;
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    if (options.signal?.aborted) cancelled = true;

    const out = stdout.value();
    const err = stderr.value();
    return {
      commandDisplay: displayCommand(options.executable, options.args),
      exitCode: code,
      signal,
      timedOut,
      cancelled,
      durationMs: Date.now() - started,
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      spawnError,
      redactions,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
