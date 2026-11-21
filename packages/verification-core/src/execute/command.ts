import fs from 'node:fs';
import path from 'node:path';
import type { TestCasePlan, TestResult } from '@zethub/shared-types';
import { type EvidenceStore } from '../evidence/store.js';
import { redact } from '../utils/redact.js';
import { resolveExecutable } from '../detect/detect.js';
import { displayCommand, resolveSpawnSpec, runCommand } from '../exec/runner.js';
import { classifyFailure, parseTestOutput } from './parse.js';

export interface ExecuteCommandOptions {
  runId: string;
  projectRoot: string;
  testCase: TestCasePlan;
  artifacts: EvidenceStore;
  signal?: AbortSignal;
  /** Explicit user approval for cases with requiresApproval. */
  approved: boolean;
  envVars?: Record<string, string>;
}

export async function executeCommandCase(options: ExecuteCommandOptions): Promise<TestResult> {
  const { testCase, artifacts, runId } = options;
  const base: Pick<TestResult, 'key' | 'title' | 'kind' | 'adapterId'> = {
    key: testCase.key,
    title: testCase.title,
    kind: testCase.kind,
    adapterId: testCase.adapterId,
  };

  if (testCase.tags.includes('blocked')) {
    return {
      ...base,
      status: 'blocked',
      durationMs: 0,
      assertions: [
        {
          name: 'Prerequisite check',
          status: 'blocked',
          message: testCase.reason || 'Required tool or runtime is unavailable.',
        },
      ],
      evidence: [],
      classification: 'missing-prerequisite',
      message: testCase.reason,
    };
  }

  if (!testCase.command) {
    return {
      ...base,
      status: 'blocked',
      durationMs: 0,
      assertions: [{ name: 'Command definition', status: 'blocked', message: 'This case has no executable command.' }],
      evidence: [],
      classification: 'no-command',
    };
  }

  if (testCase.requiresApproval && !options.approved) {
    return {
      ...base,
      status: 'blocked',
      durationMs: 0,
      assertions: [
        {
          name: 'Execution approval',
          status: 'blocked',
          message: 'Command execution requires explicit approval for this project.',
        },
      ],
      evidence: [],
      classification: 'approval-required',
      message: 'Approve the proposed command before it can execute.',
    };
  }

  const spec = resolveSpawnSpec(testCase.command.executable, testCase.command.args);
  if (spec.blocked) {
    const evidence = await artifacts.write({
      runId,
      fileName: `blocked-${testCase.key.replace(/[^a-zA-Z0-9._-]/g, '_')}.txt`,
      content: spec.blocked,
      kind: 'log',
    });
    return {
      ...base,
      status: 'blocked',
      durationMs: 0,
      commandDisplay: displayCommand(testCase.command.executable, testCase.command.args),
      assertions: [{ name: 'Executable resolution', status: 'blocked', message: spec.blocked }],
      evidence: [evidence],
      classification: 'missing-prerequisite',
      message: spec.blocked,
    };
  }

  const cwd = path.resolve(options.projectRoot, path.relative(options.projectRoot, testCase.command.cwd) || '.');
  const result = await runCommand({
    executable: spec.executable,
    args: spec.args,
    cwd,
    projectRoot: options.projectRoot,
    timeoutMs: testCase.timeoutMs,
    signal: options.signal,
    env: { ...(testCase.command.env ?? {}), ...(options.envVars ?? {}) },
  });

  const parsed = parseTestOutput(testCase.kind, result.stdout, result.stderr);
  let status: TestResult['status'];
  let message: string | undefined;

  if (result.timedOut) {
    status = 'timeout';
    message = `Command exceeded ${testCase.timeoutMs}ms and its process tree was terminated.`;
  } else if (result.cancelled) {
    status = 'cancelled';
    message = 'Cancelled by the user; child processes were terminated.';
  } else if (result.spawnError) {
    status = 'blocked';
    message = `Could not start the executable: ${result.spawnError}`;
  } else if (result.exitCode === 0) {
    if (['unit', 'integration', 'browser'].includes(testCase.kind)) {
      if (parsed.counts && parsed.counts.passed > 0 && parsed.counts.failed === 0) status = 'passed';
      else if (parsed.counts && parsed.counts.total === 0) status = 'unverified';
      else status = 'unverified';
      if (status === 'unverified') {
        message = parsed.counts
          ? 'The runner executed zero tests. A zero exit code alone is not verification.'
          : 'The command exited 0, but no test evidence could be parsed from the output. Configure a supported reporter for trustworthy results.';
      }
    } else {
      status = parsed.assertions.some((a) => a.status === 'failed') ? 'failed' : 'passed';
    }
  } else {
    status = 'failed';
    message =
      result.exitCode === null
        ? 'Process terminated without an exit code.'
        : `Command exited with code ${result.exitCode}.`;
  }

  if (status === 'unverified' && parsed.counts && parsed.counts.passed + parsed.counts.failed > 0) {
    status = parsed.counts.failed > 0 ? 'failed' : 'passed';
    message = undefined;
  }

  const stdoutEvidence = await artifacts.write({
    runId,
    fileName: `${testCase.key.replace(/[^a-zA-Z0-9._-]/g, '_')}-stdout.log`,
    content: result.stdout || '(no standard output)',
    kind: 'stdout',
  });
  const stderrEvidence = await artifacts.write({
    runId,
    fileName: `${testCase.key.replace(/[^a-zA-Z0-9._-]/g, '_')}-stderr.log`,
    content: result.stderr || '(no standard error)',
    kind: 'stderr',
  });
  const summaryEvidence = await artifacts.write({
    runId,
    fileName: `${testCase.key.replace(/[^a-zA-Z0-9._-]/g, '_')}-summary.json`,
    content: JSON.stringify(
      {
        command: result.commandDisplay,
        cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        durationMs: result.durationMs,
        classification: parsed.classification,
        counts: parsed.counts,
        notes: parsed.notes,
        outputTruncated: result.stdoutTruncated || result.stderrTruncated,
      },
      null,
      2,
    ),
    kind: 'json',
    mimeType: 'application/json',
  });

  return {
    ...base,
    status,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    commandDisplay: result.commandDisplay,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    stdoutTruncated: result.stdoutTruncated,
    assertions: parsed.assertions,
    evidence: [stdoutEvidence, stderrEvidence, summaryEvidence],
    classification:
      result.exitCode !== 0
        ? ['clean', 'build-ok', 'tests-passed'].includes(parsed.classification)
          ? `${testCase.kind}-failure`
          : classifyFailure(parsed, result.exitCode, result.stderr)
        : parsed.counts && parsed.counts.failed > 0
          ? 'test-failure'
          : parsed.classification,
    message,
  };
}

/** Resolve a plan executable for pre-flight display without running it. */
export function preflightExecutable(executable: string): { available: boolean; resolved?: string; reason?: string } {
  const spec = resolveSpawnSpec(executable, []);
  if (spec.blocked) return { available: false, reason: spec.blocked };
  if (path.isAbsolute(spec.executable) && fs.existsSync(spec.executable))
    return { available: true, resolved: spec.executable };
  const found = resolveExecutable(path.basename(spec.executable).replace(/\.(exe|cmd|bat)$/i, ''));
  return found
    ? { available: true, resolved: found }
    : { available: false, reason: `Executable not found: ${executable}` };
}
