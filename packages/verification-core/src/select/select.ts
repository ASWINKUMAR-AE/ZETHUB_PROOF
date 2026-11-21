import fs from 'node:fs';
import path from 'node:path';
import type { TestCasePlan, TestPlan } from '@zethub/shared-types';
import { toPosix } from '../utils/paths.js';

export interface SelectionResult {
  plan: TestPlan;
  selections: Array<{ key: string; score: number; reasons: string[] }>;
  /** True when dependency information was insufficient and a broader suite is recommended. */
  fallbackRequired: boolean;
  fallbackReason?: string;
}

const CODE_EXT = /\.(t|j)sx?$|\.vue$|\.svelte$|\.py$|\.go$|\.rs$|\.php$|\.java$|\.kt$|\.cs$/;

/** Parse relative/aliased imports from JS/TS and Python test files. */
export function extractImportTargets(root: string, fileRel: string): string[] {
  const abs = path.join(root, fileRel);
  let text: string;
  try {
    if (fs.statSync(abs).size > 512_000) return [];
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const targets: string[] = [];
  if (/\.(t|j)sx?$|\.vue$|\.svelte$/.test(fileRel)) {
    const re = /(?:from\s+|require\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
    for (const match of text.matchAll(re)) {
      const spec = match[1];
      if (!spec || !spec.startsWith('.')) continue;
      const base = path.resolve(path.dirname(abs), spec);
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        path.join(base, 'index.ts'),
        path.join(base, 'index.js'),
      ]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          targets.push(toPosix(path.relative(root, candidate)));
          break;
        }
      }
    }
  } else if (fileRel.endsWith('.py')) {
    const re = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    for (const match of text.matchAll(re)) {
      const mod = (match[1] ?? match[2] ?? '').replace(/\./g, '/');
      if (!mod) continue;
      for (const candidate of [`${mod}.py`, path.join(mod, '__init__.py')]) {
        if (fs.existsSync(path.join(root, candidate))) targets.push(toPosix(candidate));
      }
    }
  }
  return targets;
}

export function buildImportMap(root: string, testFiles: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const testFile of testFiles) {
    for (const target of extractImportTargets(root, testFile)) {
      const list = map.get(target) ?? [];
      if (!list.includes(testFile)) list.push(testFile);
      map.set(target, list);
    }
  }
  return map;
}

function scoreCase(
  testCase: TestCasePlan,
  changedFiles: string[],
  importMap: Map<string, string[]>,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  for (const changed of changedFiles) {
    if (testCase.mappedFiles.includes(changed)) {
      score += 60;
      reasons.push(`Test file directly changed or mapped: ${changed}`);
    }
    const changedBase = path.basename(changed).replace(/\.[^.]+$/, '');
    if (changedBase.length > 3 && testCase.mappedFiles.some((m) => path.basename(m).includes(changedBase))) {
      score += 25;
      reasons.push(`Filename correspondence with changed file ${changed}`);
    }
    const importers = importMap.get(changed) ?? [];
    if (importers.length > 0) {
      const linked = testCase.mappedFiles.filter((m) => importers.includes(m));
      if (linked.length > 0) {
        score += 35;
        reasons.push(`Import dependency: ${linked.slice(0, 2).join(', ')} import(s) ${changed}`);
      }
    }
    if (testCase.tags.some((tag) => changed.toLowerCase().includes(tag.toLowerCase()))) {
      score += 8;
      reasons.push(`Tag match for ${changed}`);
    }
  }

  if (testCase.kind === 'secret-scan') {
    score += changedFiles.length > 0 ? 30 : 10;
    reasons.push('Credential patterns can be introduced by any change');
  }
  if (testCase.kind === 'build') {
    score += 15;
    reasons.push('Build verification guards compilation regressions');
  }
  if (testCase.kind === 'browser' || testCase.kind === 'api' || testCase.kind === 'database') {
    score += 20;
    reasons.push('Cross-layer verification for configured scenarios');
  }
  if (testCase.priority >= 90) {
    score += 10;
    reasons.push('Primary project test suite');
  }
  if (reasons.length === 0) reasons.push('Selected for regression coverage');
  return { score: Math.min(100, score + Math.round(testCase.priority / 5)), reasons };
}

export interface SelectOptions {
  changedFiles: string[];
  /** Force full suite when dependency data is incomplete. */
  forceFull?: boolean;
  maxSelected?: number;
}

export function selectTests(plan: TestPlan, rootPath: string, options: SelectOptions): SelectionResult {
  if (options.forceFull || options.changedFiles.length === 0) {
    return {
      plan: {
        ...plan,
        strategy: 'full',
        notes: [
          ...plan.notes,
          options.forceFull
            ? 'Full regression requested by the user.'
            : 'No changed files were supplied, so the full plan is used.',
        ],
      },
      selections: plan.cases.map((c) => ({ key: c.key, score: c.priority, reasons: ['Full suite requested'] })),
      fallbackRequired: false,
    };
  }

  const testFiles = [...new Set(plan.cases.flatMap((c) => c.mappedFiles))];
  const importMap = buildImportMap(rootPath, testFiles);
  const scored = plan.cases.map((testCase) => {
    const { score, reasons } = scoreCase(testCase, options.changedFiles, importMap);
    return { testCase, score, reasons };
  });

  const selected = scored.filter((s) => s.score >= 25 || s.testCase.kind === 'secret-scan');
  const maxSelected = options.maxSelected ?? 40;
  selected.sort((a, b) => b.score - a.score);
  const limited = selected.slice(0, maxSelected);

  const hasExplicitMapping = plan.cases.some((c) => c.mappedFiles.length > 0);
  const fallbackRequired = !hasExplicitMapping || limited.length === 0;
  const fallbackReason = !hasExplicitMapping
    ? 'No test-to-code mappings were discovered (no recognizable test files or imports). Running only the reduced set could miss regressions.'
    : limited.length === 0
      ? 'No tests matched the changed files; a full verification is safer.'
      : undefined;

  if (fallbackRequired) {
    return {
      plan: {
        ...plan,
        strategy: 'full',
        notes: [...plan.notes, fallbackReason ?? 'Falling back to the full plan due to incomplete dependency data.'],
      },
      selections: plan.cases.map((c) => ({
        key: c.key,
        score: c.priority,
        reasons: [fallbackReason ?? 'Fallback full suite'],
      })),
      fallbackRequired: true,
      fallbackReason,
    };
  }

  const chosen = new Set(limited.map((s) => s.testCase.key));
  // Always retain non-command safety checks (secret scan) and primary build/test if mapped.
  return {
    plan: {
      ...plan,
      strategy: 'changed',
      cases: plan.cases.filter((c) => chosen.has(c.key)),
      notes: [
        ...plan.notes,
        `Reduced plan: ${limited.length} of ${plan.cases.length} cases selected from ${options.changedFiles.length} changed file(s). Unselected tests remain unverified.`,
      ],
    },
    selections: limited.map((s) => ({ key: s.testCase.key, score: s.score, reasons: s.reasons })),
    fallbackRequired: false,
  };
}

/**
 * Compare a reduced selection with stored full-suite outcomes to measure
 * whether dependency-aware selection would have missed a failure.
 */
export function evaluateSelectionMisses(
  fullResults: Array<{ key: string; status: string }>,
  selectedKeys: string[],
): { missedFailures: number; missedKeys: string[]; totalFailures: number } {
  const selected = new Set(selectedKeys);
  const failures = fullResults.filter((r) => r.status === 'failed');
  const missed = failures.filter((f) => !selected.has(f.key));
  return { missedFailures: missed.length, missedKeys: missed.map((m) => m.key), totalFailures: failures.length };
}

/** Git is used read-only. Arguments are fixed; no user-supplied revision is executed. */
export interface GitChangeSummary {
  isRepo: boolean;
  branch?: string;
  commit?: string;
  changedFiles: string[];
  diff?: string;
  error?: string;
}

export function gitChangedFiles(
  root: string,
  spawnFn: (args: string[]) => { stdout: string; status: number | null },
): GitChangeSummary {
  if (!fs.existsSync(path.join(root, '.git')))
    return { isRepo: false, changedFiles: [], error: 'Not a git repository' };
  try {
    const branch = spawnFn(['rev-parse', '--abbrev-ref', 'HEAD']);
    const commit = spawnFn(['rev-parse', '--short=12', 'HEAD']);
    const status = spawnFn(['status', '--porcelain']);
    const diffNames = spawnFn(['diff', '--name-only', 'HEAD']);
    const changed = new Set<string>();
    for (const line of `${status.stdout}\n${diffNames.stdout}`.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^[ MADRCU?!]{2}\s/.test(line)) changed.add(line.slice(3).trim().replace(/^"|"$/g, ''));
      else changed.add(trimmed);
    }
    const diff = spawnFn(['diff', '--unified=2', '--no-color', 'HEAD']);
    return {
      isRepo: true,
      branch: branch.stdout.trim() || undefined,
      commit: commit.stdout.trim() || undefined,
      changedFiles: [...changed].filter((f) => CODE_EXT.test(f) || f.includes('package') || f.includes('lock')),
      diff: diff.stdout.slice(0, 60_000),
    };
  } catch (error) {
    return { isRepo: true, changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function isRiskyChange(files: string[]): { risky: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (
    files.some((f) =>
      /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|pom\.xml|build\.gradle)$/.test(
        f,
      ),
    )
  ) {
    reasons.push('Dependency manifests changed; full test suite is advised.');
  }
  if (files.some((f) => /(^|\/)(migrations?|schema\.prisma|alembic)\//.test(f))) {
    reasons.push('Database schema/migration files changed; database verification is advised.');
  }
  if (files.some((f) => /(^|\/)(auth|security|permission|crypto)(\/|[^/]*\.(t|j)sx?$)/.test(f))) {
    reasons.push('Security-sensitive code changed; security checks are advised.');
  }
  return { risky: reasons.length > 0, reasons };
}
