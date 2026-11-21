import fs from 'node:fs';
import path from 'node:path';
import type { TestQualityFinding } from '@zethub/shared-types';
import { isTestFile } from '../plan/plan.js';
import { toPosix } from '../utils/paths.js';

interface ParsedTest {
  name: string;
  startLine: number;
  endLine: number;
  body: string;
  skipped: boolean;
}

const JS_TEST_START = /^\s*(?:it|test|specify)(\.(?:skip|only|todo))?\s*\(\s*(['"`])(.+?)\2/gm;
const PY_TEST_START = /^\s*def\s+(test_\w+)\s*\(/gm;

function parseJsTests(content: string): ParsedTest[] {
  const lines = content.split(/\r?\n/);
  const starts: Array<{ index: number; name: string; skipped: boolean }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    JS_TEST_START.lastIndex = 0;
    const m = JS_TEST_START.exec(line);
    if (m) starts.push({ index: i, name: m[3] ?? 'unnamed', skipped: Boolean(m[1]) });
  }
  return starts.map((start, idx) => {
    const end = starts[idx + 1]?.index ?? Math.min(lines.length, start.index + 80);
    return {
      name: start.name,
      startLine: start.index + 1,
      endLine: end,
      body: lines.slice(start.index, end).join('\n'),
      skipped: start.skipped,
    };
  });
}

function parsePythonTests(content: string): ParsedTest[] {
  const lines = content.split(/\r?\n/);
  const starts: Array<{ index: number; name: string; indent: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    PY_TEST_START.lastIndex = 0;
    const m = PY_TEST_START.exec(line);
    if (m) starts.push({ index: i, name: m[1] ?? 'unnamed', indent: line.length - line.trimStart().length });
  }
  return starts.map((start, idx) => {
    let end = starts[idx + 1]?.index ?? lines.length;
    // Stop at dedent for the final test.
    if (!starts[idx + 1]) {
      for (let j = start.index + 1; j < lines.length; j += 1) {
        const line = lines[j] ?? '';
        if (line.trim() && line.length - line.trimStart().length <= start.indent) {
          end = j;
          break;
        }
      }
    }
    return {
      name: start.name,
      startLine: start.index + 1,
      endLine: end,
      body: lines.slice(start.index, end).join('\n'),
      skipped: /@pytest\.mark\.skip|@unittest\.skip/.test(
        lines.slice(Math.max(0, start.index - 3), start.index + 1).join('\n'),
      ),
    };
  });
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  return [...text.matchAll(re)].length;
}

export interface QualityAuditInput {
  rootPath: string;
  files?: string[];
  /** Historical flakiness signals from real runs: key -> pass/fail alternations. */
  flakyTests?: Array<{ testName: string; alternations: number; runs: number }>;
}

export interface QualityAuditResult {
  findings: TestQualityFinding[];
  filesAnalyzed: number;
  testsAnalyzed: number;
  limitations: string[];
}

export function auditTestQuality(input: QualityAuditInput): QualityAuditResult {
  const findings: TestQualityFinding[] = [];
  const limitations = [
    'Static findings are heuristics. They identify code patterns that deserve review, not confirmed ineffective tests.',
    'Mutation testing is the only way to confirm that a test detects a deliberate defect; it is available only through the explicit mutation endpoint.',
    'Flakiness signals are derived only from stored run history for this project.',
  ];
  let filesAnalyzed = 0;
  let testsAnalyzed = 0;

  const files = input.files ?? collectTestFiles(input.rootPath);
  const seenTitles = new Map<string, string[]>();

  for (const rel of files.slice(0, 500)) {
    let content: string;
    try {
      const abs = path.join(input.rootPath, rel);
      if (fs.statSync(abs).size > 1_000_000) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    filesAnalyzed += 1;
    const isPython = rel.endsWith('.py');
    const parsed = isPython ? parsePythonTests(content) : parseJsTests(content);
    testsAnalyzed += parsed.length;
    const assertionsRe = isPython ? /^\s*assert\s+/gm : /\bexpect\s*\(|\bassert\s*[.(]/g;

    for (const test of parsed) {
      const assertionCount = countMatches(test.body, assertionsRe);
      if (test.skipped) {
        findings.push({
          id: `${rel}:${test.startLine}:skipped`,
          file: rel,
          line: test.startLine,
          testName: test.name,
          category: 'skipped-test',
          severity: 'medium',
          confidence: 'confirmed',
          message: `Test "${test.name}" is explicitly skipped.`,
          suggestion:
            'Re-enable the test or document why it is intentionally disabled. A skipped test provides no verification.',
        });
      }
      if (assertionCount === 0 && !test.skipped) {
        const empty =
          /^\s*(?:async\s*)?(?:\(\s*\)|\w+)\s*=>\s*\{\s*\}\s*;?\s*$/.test(test.body) ||
          /^\s*def\s+\w+\([^)]*\):\s*(?:pass|\.\.\.)?\s*$/m.test(test.body);
        findings.push({
          id: `${rel}:${test.startLine}:missing-assertion`,
          file: rel,
          line: test.startLine,
          testName: test.name,
          category: empty ? 'empty-test' : 'missing-assertion',
          severity: 'high',
          confidence: 'confirmed',
          message: empty ? `Test "${test.name}" has an empty body.` : `Test "${test.name}" contains no assertion.`,
          suggestion: 'Add an assertion that verifies the intended outcome, not merely that the code executed.',
        });
      }
      if (/\bexpect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)|assert\s+True\b/.test(test.body)) {
        findings.push({
          id: `${rel}:${test.startLine}:weak`,
          file: rel,
          line: test.startLine,
          testName: test.name,
          category: 'weak-assertion',
          severity: 'high',
          confidence: 'confirmed',
          message: `Test "${test.name}" asserts a constant, which can never fail.`,
          suggestion: 'Assert on observable behavior (return value, rendered output, persisted state).',
        });
      }
      if (
        /\bto(?:BeDefined|BeTruthy)\s*\(\s*\)/.test(test.body) &&
        !/\bto(?:Equal|Be|Contain|Match|HaveLength|Throw)/.test(test.body)
      ) {
        findings.push({
          id: `${rel}:${test.startLine}:undefined-only`,
          file: rel,
          line: test.startLine,
          testName: test.name,
          category: 'weak-assertion',
          severity: 'medium',
          confidence: 'heuristic',
          message: `Test "${test.name}" only checks that a value is defined/truthy.`,
          suggestion: 'Assert the expected concrete value or shape.',
        });
      }
      if (
        /waitForTimeout\s*\(\s*\d{3,}\s*\)|setTimeout\s*\(\s*\d{3,}\s*\)|time\.sleep\s*\(\s*\d+\s*\)/.test(test.body)
      ) {
        findings.push({
          id: `${rel}:${test.startLine}:timeout`,
          file: rel,
          line: test.startLine,
          testName: test.name,
          category: 'hardcoded-timeout',
          severity: 'medium',
          confidence: 'confirmed',
          message: `Test "${test.name}" uses a hard-coded sleep.`,
          suggestion: 'Wait for a condition (element, response, state) with a retrying assertion instead.',
        });
      }
      if (
        /locator\s*\(\s*['"`](?:\/\/|\/html|#\d|div\s*>|body\s*>)/i.test(test.body) ||
        /page\.\$(?:x)?\s*\(\s*['"`](?:\/\/|#\d)/.test(test.body)
      ) {
        findings.push({
          id: `${rel}:${test.startLine}:selector`,
          file: rel,
          line: test.startLine,
          testName: test.name,
          category: 'fragile-selector',
          severity: 'low',
          confidence: 'heuristic',
          message: `Test "${test.name}" uses a structural or positional selector.`,
          suggestion: 'Prefer role/label/test-id locators tied to user-visible behavior.',
        });
      }
      const key = `${rel.split('/').slice(0, -1).join('/')}::${test.name}`;
      seenTitles.set(key, [...(seenTitles.get(key) ?? []), rel]);
    }

    if (/(?:catch\s*(?:\([^)]*\))?\s*\{\s*\}|except\s+Exception\s*:\s*pass)/.test(content)) {
      findings.push({
        id: `${rel}:broad-catch`,
        file: rel,
        category: 'broad-catch',
        severity: 'high',
        confidence: 'confirmed',
        message: 'Test file swallows exceptions with an empty catch/except block.',
        suggestion: 'Remove the empty handler or assert the expected failure explicitly.',
      });
    }
    if (
      countMatches(content, /\b(?:invalid|error|reject|fail(?:s|ed)?|forbidden|unauthorized|4\d\d|5\d\d)\b/gi) === 0 &&
      parsed.length > 0
    ) {
      findings.push({
        id: `${rel}:no-negative`,
        file: rel,
        category: 'missing-negative-case',
        severity: 'low',
        confidence: 'heuristic',
        message: 'No negative-path keywords were found in this test file.',
        suggestion: 'Consider adding invalid-input and error-path tests where the requirement allows it.',
      });
    }
    if (/\b(?:beforeAll|beforeEach)\s*\(/.test(content) && /\b(?:let|var)\s+\w+\s*[;=]/.test(content)) {
      findings.push({
        id: `${rel}:shared-state`,
        file: rel,
        category: 'shared-state',
        severity: 'low',
        confidence: 'heuristic',
        message: 'Mutable values are shared across tests via hooks.',
        suggestion: 'Reset shared state in beforeEach or construct state per test to avoid order dependence.',
      });
    }
  }

  for (const [key, paths] of seenTitles) {
    if (paths.length > 1) {
      findings.push({
        id: `${paths[0]}:duplicate:${key}`,
        file: paths[0] ?? '',
        testName: key.split('::')[1],
        category: 'duplicate-test',
        severity: 'low',
        confidence: 'heuristic',
        message: 'Tests with the same name exist in multiple files.',
        suggestion: 'Confirm whether both tests cover distinct behavior; remove duplicates otherwise.',
      });
    }
  }

  for (const flaky of input.flakyTests ?? []) {
    if (flaky.alternations >= 2 && flaky.runs >= 4) {
      findings.push({
        id: `flaky:${flaky.testName}`,
        file: '(history)',
        testName: flaky.testName,
        category: 'flaky-history',
        severity: 'high',
        confidence: 'confirmed',
        message: `Test "${flaky.testName}" changed outcome ${flaky.alternations} times across ${flaky.runs} stored runs.`,
        suggestion:
          'Investigate shared state, timing and external dependencies. A flaky test cannot be used as reliable proof.',
      });
    }
  }

  return { findings, filesAnalyzed, testsAnalyzed, limitations };
}

export function collectTestFiles(root: string, limit = 500): string[] {
  const out: string[] = [];
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'target',
    'vendor',
    '.venv',
    'venv',
    'coverage',
    '.next',
  ]);
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(abs, depth + 1);
      } else if (isTestFile(entry.name)) {
        out.push(toPosix(path.relative(root, abs)));
      }
    }
  };
  walk(root, 0);
  return out;
}

export function detectFlakiness(
  history: Array<{ testName: string; status: string }>,
): Array<{ testName: string; alternations: number; runs: number }> {
  const byTest = new Map<string, string[]>();
  for (const item of history) {
    byTest.set(item.testName, [...(byTest.get(item.testName) ?? []), item.status]);
  }
  const out: Array<{ testName: string; alternations: number; runs: number }> = [];
  for (const [testName, statuses] of byTest) {
    let alternations = 0;
    for (let i = 1; i < statuses.length; i += 1) if (statuses[i] !== statuses[i - 1]) alternations += 1;
    if (alternations > 0) out.push({ testName, alternations, runs: statuses.length });
  }
  return out;
}
