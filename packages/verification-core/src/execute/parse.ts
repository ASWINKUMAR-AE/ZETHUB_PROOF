import type { AssertionResult, TestKind } from '@zethub/shared-types';

export interface ParsedOutcome {
  assertions: AssertionResult[];
  counts?: { total: number; passed: number; failed: number; skipped: number };
  classification: string;
  /** True only when the output proves that at least one test actually ran. */
  evidenceOfExecution: boolean;
  notes: string[];
}

interface NumberSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

function parseJestVitest(text: string): NumberSummary | null {
  // "Tests  3 passed (3)" / "Tests:       1 failed, 2 passed, 3 total".
  // A chained script (unit + integration + security) prints several summaries;
  // aggregate them so the report does not undercount executed tests.
  const lines = [...text.matchAll(/^[ \t]*Tests:?[ \t]+([^\n]*)$/gim)];
  if (lines.length === 0) return null;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;
  for (const match of lines) {
    const line = match[1] ?? '';
    failed += Number(line.match(/(\d+)\s+failed/i)?.[1] ?? 0);
    passed += Number(line.match(/(\d+)\s+passed/i)?.[1] ?? 0);
    skipped += Number(line.match(/(\d+)\s+(?:skipped|todo)/i)?.[1] ?? 0);
    total += Number(line.match(/(\d+)\s+total/i)?.[1] ?? 0);
  }
  if (passed + failed + skipped === 0 && total === 0) return null;
  return { passed, failed, skipped, total: Math.max(total, passed + failed + skipped) };
}

function parsePlaywright(text: string): NumberSummary | null {
  // Playwright's final summary: "10 passed (32.0s)" / "1 failed" / "2 skipped".
  // Require the duration suffix so per-test lines and generic tool output do not
  // get mistaken for a summary.
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(passed|failed|flaky|skipped)\b[^\n]*\(\d+(?:\.\d+)?\s*(?:ms|s|m)\)\s*$/i);
    if (!match) continue;
    found = true;
    const count = Number(match[1]);
    const kind = match[2]!.toLowerCase();
    if (kind === 'failed') failed += count;
    else if (kind === 'skipped') skipped += count;
    else passed += count;
  }
  if (!found) return null;
  return { passed, failed, skipped, total: passed + failed + skipped };
}

function parsePytest(text: string): NumberSummary | null {
  // Pytest summaries include a "==== ... ====" banner or an "in 0.12s" suffix.
  if (
    !/(?:=+[^\n]*(?:passed|failed|error|skipped)[^\n]*=+|\b(?:passed|failed|error|skipped)\b[^\n]*\bin\s+\d+(?:\.\d+)?s)/i.test(
      text,
    )
  ) {
    return null;
  }
  const summary = text.match(/(?:=+\s*)?((?:\d+\s+\w+(?:,\s*)?)+)(?:\s+in\s+[\d.]+s)?/gi);
  if (!summary) return null;
  const target = [...summary].reverse().find((s) => /passed|failed|error|skipped/i.test(s));
  if (!target) return null;
  const failed = Number(target.match(/(\d+)\s+(?:failed|error)/i)?.[1] ?? 0);
  const passed = Number(target.match(/(\d+)\s+passed/i)?.[1] ?? 0);
  const skipped = Number(target.match(/(\d+)\s+skipped/i)?.[1] ?? 0);
  if (passed + failed + skipped === 0) return null;
  return { passed, failed, skipped, total: passed + failed + skipped };
}

function parseCargo(text: string): NumberSummary | null {
  const matches = [...text.matchAll(/test result: (?:ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored/g)];
  if (matches.length === 0) return null;
  let passed = 0,
    failed = 0,
    skipped = 0;
  for (const m of matches) {
    passed += Number(m[1]);
    failed += Number(m[2]);
    skipped += Number(m[3]);
  }
  return { passed, failed, skipped, total: passed + failed + skipped };
}

function parseGo(text: string): NumberSummary | null {
  if (!/^(ok|FAIL|--- FAIL|\?)/m.test(text)) return null;
  const failed = (text.match(/^--- FAIL:/gm) ?? []).length + (text.match(/^FAIL\s/gm) ?? []).length;
  const packagesOk = (text.match(/^ok\s+/gm) ?? []).length;
  const noTest = (text.match(/\[no test files\]/gm) ?? []).length;
  if (packagesOk === 0 && failed === 0 && noTest === 0) return null;
  const passed = packagesOk > 0 ? Math.max(1, packagesOk - failed) : 0;
  return { passed, failed, skipped: noTest, total: passed + failed + noTest };
}

function parseDotnet(text: string): NumberSummary | null {
  const m = text.match(
    /(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/i,
  );
  if (!m) return null;
  return { failed: Number(m[1]), passed: Number(m[2]), skipped: Number(m[3]), total: Number(m[4]) };
}

function parsePhpUnit(text: string): NumberSummary | null {
  const ok = text.match(/OK \((\d+) tests?,\s*(\d+) assertions?\)/i);
  if (ok) return { passed: Number(ok[1]), failed: 0, skipped: 0, total: Number(ok[1]) };
  const fail = text.match(/Tests:\s*(\d+),\s*Assertions:\s*(\d+),\s*(?:Failures|Errors):\s*(\d+)/i);
  if (fail) {
    const total = Number(fail[1]);
    const failed = Number(fail[3]);
    return { passed: Math.max(0, total - failed), failed, skipped: 0, total };
  }
  return null;
}

function parseJUnitXml(text: string): NumberSummary | null {
  const suites = [...text.matchAll(/<testsuite\b[^>]*>/g)];
  if (suites.length === 0) return null;
  let tests = 0,
    failures = 0,
    errors = 0,
    skipped = 0;
  for (const s of suites) {
    const tag = s[0];
    tests += Number(tag.match(/\btests="(\d+)"/)?.[1] ?? 0);
    failures += Number(tag.match(/\bfailures="(\d+)"/)?.[1] ?? 0);
    errors += Number(tag.match(/\berrors="(\d+)"/)?.[1] ?? 0);
    skipped += Number(tag.match(/\bskipped="(\d+)"/)?.[1] ?? 0);
  }
  if (tests === 0) return null;
  const failed = failures + errors;
  return { passed: Math.max(0, tests - failed - skipped), failed, skipped, total: tests };
}

export function parseTestOutput(kind: TestKind, stdout: string, stderr: string): ParsedOutcome {
  const text = `${stdout}\n${stderr}`;
  const notes: string[] = [];
  let summary: NumberSummary | null = null;
  let runner = 'unknown';

  if (kind === 'unit' || kind === 'integration' || kind === 'browser') {
    const parsers: Array<[string, (t: string) => NumberSummary | null]> = [
      ['vitest/jest', parseJestVitest],
      ['playwright', parsePlaywright],
      ['pytest', parsePytest],
      ['cargo', parseCargo],
      ['go', parseGo],
      ['dotnet', parseDotnet],
      ['phpunit', parsePhpUnit],
      ['junit', parseJUnitXml],
    ];
    for (const [name, parser] of parsers) {
      summary = parser(text);
      if (summary) {
        runner = name;
        break;
      }
    }
  }

  if (kind === 'dependency-audit') {
    try {
      const parsed = JSON.parse(stdout) as {
        metadata?: { vulnerabilities?: Record<string, number> };
        vulnerabilities?: Record<string, unknown>;
      };
      const vulns = parsed.metadata?.vulnerabilities ?? {};
      const total = Object.entries(vulns)
        .filter(([k]) => k !== 'info' && k !== 'total')
        .reduce((acc, [, v]) => acc + Number(v ?? 0), 0);
      const totalReported = Number(vulns['total'] ?? total);
      return {
        assertions: [
          {
            name: 'Known vulnerable dependencies',
            status: totalReported > 0 ? 'failed' : 'passed',
            expected: '0 vulnerabilities',
            actual: String(totalReported),
          },
        ],
        counts: { total: 1, passed: totalReported > 0 ? 0 : 1, failed: totalReported > 0 ? 1 : 0, skipped: 0 },
        classification: totalReported > 0 ? 'dependency-vulnerabilities' : 'dependency-clean',
        evidenceOfExecution: true,
        notes: ['npm audit data depends on registry availability and advisory freshness.'],
      };
    } catch {
      notes.push('Audit output was not valid JSON; result is unverified.');
      return { assertions: [], classification: 'audit-output-unparsed', evidenceOfExecution: false, notes };
    }
  }

  if (kind === 'lint' || kind === 'typecheck' || kind === 'format') {
    const problems = text.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?/i);
    const tsErrors = (text.match(/error TS\d+/g) ?? []).length;
    const errorCount = Number(problems?.[2] ?? tsErrors);
    return {
      assertions: [
        {
          name: `${kind} diagnostics`,
          status: errorCount > 0 ? 'failed' : 'passed',
          expected: '0 errors',
          actual: String(errorCount),
        },
      ],
      counts: { total: 1, passed: errorCount === 0 ? 1 : 0, failed: errorCount > 0 ? 1 : 0, skipped: 0 },
      classification: errorCount > 0 ? `${kind}-errors` : 'clean',
      evidenceOfExecution: true,
      notes: notes.length
        ? notes
        : ['Diagnostics are reported by the project tool; ZetHub does not reimplement the linter.'],
    };
  }

  if (kind === 'build') {
    const compileErrors = (text.match(/error TS\d+|error:|BUILD FAILED|Compilation failed/gi) ?? []).length;
    return {
      assertions: [
        {
          name: 'Build completed',
          status: compileErrors > 0 ? 'failed' : 'passed',
          expected: 'No compiler errors',
          actual: compileErrors > 0 ? `${compileErrors} error marker(s)` : 'No compiler errors detected',
        },
      ],
      counts: { total: 1, passed: compileErrors > 0 ? 0 : 1, failed: compileErrors > 0 ? 1 : 0, skipped: 0 },
      classification: compileErrors > 0 ? 'build-failure' : 'build-ok',
      evidenceOfExecution: true,
      notes: ['Build success is inferred from exit status and compiler error markers.'],
    };
  }

  if (summary) {
    const assertions: AssertionResult[] = [
      {
        name: `${runner} test execution`,
        status: summary.failed > 0 ? 'failed' : summary.passed > 0 ? 'passed' : 'unverified',
        expected: 'All executed tests pass',
        actual: `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.total} total)`,
      },
    ];
    if (summary.failed > 0) {
      const failures = [...text.matchAll(/^\s*(?:FAIL|✕|×|✗)\s+(.{1,160})$/gm)].slice(0, 20);
      for (const failure of failures) {
        assertions.push({ name: `Failing test: ${failure[1]?.trim()}`, status: 'failed' });
      }
    }
    return {
      assertions,
      counts: summary,
      classification: summary.failed > 0 ? 'test-failure' : summary.passed > 0 ? 'tests-passed' : 'no-tests-executed',
      evidenceOfExecution: summary.passed + summary.failed > 0,
      notes:
        summary.total === 0 ? ['The runner reported no tests. A zero exit code is not evidence of verification.'] : [],
    };
  }

  return {
    assertions: [],
    classification: 'no-test-evidence',
    evidenceOfExecution: false,
    notes: [
      'Command output did not contain recognizable test evidence. ZetHub marks this as unverified instead of passed.',
      'If your runner uses a custom reporter, configure a JUnit/JSON reporter so results can be normalized.',
    ],
  };
}

export function classifyFailure(parsed: ParsedOutcome, exitCode: number | null, stderr: string): string {
  if (parsed.classification !== 'no-test-evidence') return parsed.classification;
  if (/ENOENT|not recognized|command not found|is not installed/i.test(stderr)) return 'missing-prerequisite';
  if (/EADDRINUSE|port .* in use/i.test(stderr)) return 'environment-port-conflict';
  if (/EACCES|EPERM|permission denied/i.test(stderr)) return 'permission-denied';
  if (/ETIMEDOUT|network|getaddrinfo|ENOTFOUND/i.test(stderr)) return 'network-failure';
  return exitCode === 0 ? 'no-test-evidence' : 'command-failed';
}
