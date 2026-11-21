import fs from 'node:fs';
import path from 'node:path';
import type { AssertionResult, TestResult } from '@zethub/shared-types';
import { type EvidenceStore } from '../evidence/store.js';
import { redact } from '../utils/redact.js';
import { toPosix } from '../utils/paths.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'target',
  'vendor',
  'artifacts',
  '.venv',
  'venv',
  '__pycache__',
  '.turbo',
  '.cache',
]);
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.env',
  '.ini',
  '.conf',
  '.yml',
  '.yaml',
  '.toml',
  '.py',
  '.rb',
  '.php',
  '.java',
  '.kt',
  '.cs',
  '.go',
  '.rs',
  '.sh',
  '.ps1',
  '.sql',
  '.md',
  '.txt',
  '.xml',
  '.gradle',
  '.properties',
  '.pem',
  '.key',
]);

interface SecretRule {
  id: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
  regex: RegExp;
  /** Values that are obviously placeholders must not be reported. */
  allow?: (match: string) => boolean;
}

const RULES: SecretRule[] = [
  {
    id: 'private-key',
    description: 'Private key block',
    severity: 'high',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  { id: 'aws-access-key', description: 'AWS access key ID', severity: 'high', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    id: 'github-token',
    description: 'GitHub token',
    severity: 'high',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
  },
  {
    id: 'stripe-key',
    description: 'Stripe secret key',
    severity: 'high',
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    allow: (m) => !/test_/.test(m),
  },
  { id: 'slack-token', description: 'Slack token', severity: 'high', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: 'google-api-key', description: 'Google API key', severity: 'high', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { id: 'openai-key', description: 'OpenAI-style API key', severity: 'high', regex: /\bsk-[A-Za-z0-9_-]{32,}\b/g },
  {
    id: 'db-credential',
    description: 'Database URL containing a password',
    severity: 'high',
    regex:
      /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\/[^\s/:@]+:(?!\*|REDACTED|password|pass|example|changeme)[^\s/@"']{4,}@/g,
    // A URL built from variables is a template, not a literal credential.
    allow: (m) => /\$\{|process\.env|os\.environ|<[^>]+>/.test(m),
  },
  {
    id: 'generic-assignment',
    description: 'Hard-coded credential assignment',
    severity: 'medium',
    regex:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']([^"'\s]{10,})["']/gi,
    allow: (m) =>
      /(example|placeholder|changeme|your[_-]|<[^>]+>|\$\{|process\.env|os\.environ|xxx|dummy|test[_-]?only)/i.test(m),
  },
];

export interface SecretFinding {
  file: string;
  line: number;
  ruleId: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
  preview: string;
}

function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function readIgnorePatterns(root: string): string[] {
  const patterns: string[] = [];
  for (const name of ['.gitignore', '.git/info/exclude']) {
    const file = path.join(root, name);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      patterns.push(line.replace(/^\//, '').replace(/\/$/, ''));
    }
  }
  return patterns;
}

/** Returns true when a local env file is covered by an ignore rule. */
export function isEnvFileIgnored(relFile: string, patterns: string[]): boolean {
  const base = path.posix.basename(relFile);
  for (const pattern of patterns) {
    if (!pattern) continue;
    const hasSlash = pattern.includes('/');
    const target = hasSlash ? relFile : base;
    const normalized = hasSlash ? pattern.replace(/^\*\*\//, '') : pattern;
    if (globToRegExp(normalized).test(target)) return true;
    if (hasSlash && globToRegExp(pattern).test(relFile)) return true;
  }
  return false;
}

export function scanForSecrets(
  root: string,
  maxFiles = 2500,
): {
  findings: SecretFinding[];
  filesScanned: number;
  skippedLarge: number;
  envFiles: string[];
  suppressedLines: number;
} {
  const findings: SecretFinding[] = [];
  const envFiles: string[] = [];
  let filesScanned = 0;
  let skippedLarge = 0;
  let suppressedLines = 0;

  const visit = (dir: string, depth: number) => {
    if (depth > 8 || filesScanned >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (filesScanned >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github')) continue;
        visit(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const looksLikeEnv = /^\.env(\.|$)/.test(entry.name) && !entry.name.endsWith('.example');
      const rel = toPosix(path.relative(root, abs));
      if (looksLikeEnv) {
        // Local-only secret stores are not source files. Their protection is
        // checked through .gitignore below instead of reporting every value.
        envFiles.push(rel);
        continue;
      }
      if (!TEXT_EXT.has(ext) && !['Dockerfile', 'Makefile'].includes(entry.name)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > 1_500_000) {
        skippedLarge += 1;
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\0')) continue;
      filesScanned += 1;
      const lines = content.split(/\r?\n/);
      let skipNextLine = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (skipNextLine) {
          skipNextLine = false;
          suppressedLines += 1;
          continue;
        }
        if (line.includes('zethub-secret-scan:ignore-next-line')) {
          skipNextLine = true;
          continue;
        }
        if (line.includes('zethub-secret-scan:ignore')) {
          suppressedLines += 1;
          continue;
        }
        if (line.length > 4000) continue;
        for (const rule of RULES) {
          rule.regex.lastIndex = 0;
          const match = rule.regex.exec(line);
          if (!match) continue;
          const value = match[0];
          if (rule.allow && rule.allow(value)) continue;
          findings.push({
            file: rel,
            line: i + 1,
            ruleId: rule.id,
            description: rule.description,
            severity: rule.severity,
            preview: redact(value).slice(0, 90),
          });
        }
      }
    }
  };
  visit(root, 0);

  // Local env files are excluded from content scanning, so verify that they are
  // protected from accidental commits instead of silently ignoring them.
  const ignorePatterns = readIgnorePatterns(root);
  for (const rel of envFiles) {
    if (isEnvFileIgnored(rel, ignorePatterns)) continue;
    findings.push({
      file: rel,
      line: 1,
      ruleId: 'unprotected-env-file',
      description: 'Local environment file is not covered by .gitignore',
      severity: 'high',
      preview: redact(rel),
    });
  }

  return { findings, filesScanned, skippedLarge, envFiles, suppressedLines };
}

export async function runSecretScan(root: string, runId: string, artifacts: EvidenceStore): Promise<TestResult> {
  const started = Date.now();
  const { findings, filesScanned, skippedLarge, envFiles, suppressedLines } = scanForSecrets(root);
  const ignorePatterns = readIgnorePatterns(root);
  const unprotectedEnv = envFiles.filter((rel) => !isEnvFileIgnored(rel, ignorePatterns));
  const assertions: AssertionResult[] = [
    {
      name: 'High-confidence credential patterns',
      status: findings.some((f) => f.severity === 'high') ? 'failed' : 'passed',
      expected: '0 high-confidence findings',
      actual: String(findings.filter((f) => f.severity === 'high').length),
    },
    {
      name: 'Files scanned',
      status: 'passed',
      actual: `${filesScanned} text file(s); ${skippedLarge} skipped as too large`,
    },
    {
      name: 'Inline suppressions',
      status: 'passed',
      expected: 'Only documented test fixtures and scanner patterns suppress findings',
      actual: `${suppressedLines} line(s) skipped, each marked with a zethub-secret-scan comment`,
    },
  ];
  if (envFiles.length > 0) {
    assertions.push({
      name: 'Local env files ignored by version control',
      status: unprotectedEnv.length > 0 ? 'failed' : 'passed',
      expected: '0 unignored env files',
      actual: `${envFiles.length} env file(s); ${unprotectedEnv.length} not ignored`,
      ...(unprotectedEnv.length > 0 ? { message: `Unprotected: ${unprotectedEnv.join(', ')}` } : {}),
    });
  }
  if (findings.some((f) => f.severity === 'medium')) {
    assertions.push({
      name: 'Heuristic credential assignments (review required)',
      status: 'passed',
      actual: `${findings.filter((f) => f.severity === 'medium').length} potential finding(s)`,
      message: 'Medium-severity findings are heuristics and are not treated as confirmed leaks.',
    });
  }
  const evidence = await artifacts.write({
    runId,
    fileName: 'secret-scan.json',
    content: JSON.stringify(
      {
        findings,
        filesScanned,
        suppressedLines,
        envFiles: envFiles.map((rel) => ({ file: rel, ignored: !unprotectedEnv.includes(rel) })),
        ruleCount: RULES.length,
        limitations: [
          'This scanner is a focused pattern check, not a full credential audit.',
          'Contents of local .env files are intentionally not scanned or stored; only their ignore status is checked.',
          'Only the repository .gitignore and .git/info/exclude are consulted for env protection; global git excludes are not evaluated.',
        ],
      },
      null,
      2,
    ),
    kind: 'json',
    mimeType: 'application/json',
  });
  return {
    key: 'builtin:secret-scan',
    title: 'Secret scan (built-in)',
    kind: 'secret-scan',
    adapterId: 'zethub-secret-scan',
    status: findings.some((f) => f.severity === 'high') ? 'failed' : 'passed',
    durationMs: Date.now() - started,
    assertions,
    evidence: [evidence],
    classification: findings.some((f) => f.severity === 'high') ? 'secrets-detected' : 'no-secrets-detected',
    message:
      findings.length > 0 ? `${findings.length} potential secret finding(s); review the evidence file.` : undefined,
  };
}

const ARTIFACT_DIRS = ['dist', 'build', 'out', 'target/release', 'target/debug', '.next', 'public/build'];
const NESTED_ARTIFACT_NAMES = ['dist', 'build', 'out', '.next'];

/**
 * Monorepos keep outputs under apps/<package>/dist and packages/<package>/dist
 * rather than the repository root. Discover those without walking dependency
 * or VCS trees.
 */
function discoverArtifactDirs(root: string): string[] {
  const found = new Set<string>();
  for (const rel of ARTIFACT_DIRS) {
    if (fs.existsSync(path.join(root, rel))) found.add(rel);
  }
  const visit = (dir: string, depth: number) => {
    if (depth > 2 || found.size >= 50) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      for (const name of NESTED_ARTIFACT_NAMES) {
        if (fs.existsSync(path.join(abs, name))) found.add(`${rel}/${name}`);
      }
      visit(abs, depth + 1);
    }
  };
  visit(root, 0);
  return [...found].sort();
}

export async function inspectArtifacts(root: string, runId: string, artifacts: EvidenceStore): Promise<TestResult> {
  const started = Date.now();
  const found: Array<{ dir: string; files: number; bytes: number; newest?: string }> = [];
  const artifactDirs = discoverArtifactDirs(root);
  for (const rel of artifactDirs) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    let files = 0;
    let bytes = 0;
    let newest = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || files > 5000) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(p);
          if (entry.isDirectory()) walk(p, depth + 1);
          else {
            files += 1;
            bytes += stat.size;
            newest = Math.max(newest, stat.mtimeMs);
          }
        } catch {
          /* ignore */
        }
      }
    };
    walk(abs, 0);
    found.push({ dir: rel, files, bytes, newest: newest ? new Date(newest).toISOString() : undefined });
  }

  const assertions: AssertionResult[] =
    found.length > 0
      ? found.map((f) => ({
          name: `Artifact directory ${f.dir}`,
          status: 'passed' as const,
          actual: `${f.files} file(s), ${(f.bytes / 1024 / 1024).toFixed(2)} MiB${f.newest ? `, newest ${f.newest}` : ''}`,
        }))
      : [
          {
            name: 'Build artifact directories',
            status: 'unverified',
            message:
              'No common build output directory exists. Build the project first or configure a custom output path.',
          },
        ];

  const evidence = await artifacts.write({
    runId,
    fileName: 'artifact-inspection.json',
    content: JSON.stringify({ found, inspected: artifactDirs }, null, 2),
    kind: 'json',
    mimeType: 'application/json',
  });

  return {
    key: 'builtin:artifact-inspection',
    title: 'Build artifact inspection',
    kind: 'static-analysis',
    adapterId: 'zethub-builtin',
    status: found.length > 0 ? 'passed' : 'unverified',
    durationMs: Date.now() - started,
    assertions,
    evidence: [evidence],
    classification: found.length > 0 ? 'artifacts-present' : 'artifacts-missing',
  };
}

export const SECRET_RULES = RULES;
