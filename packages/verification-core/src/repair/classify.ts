import type { FailureCapsule, TestResult, VerificationRunSummary } from '@zethub/shared-types';
import { redact, redactWithCount } from '../utils/redact.js';
import { FailureCapsuleSchema } from '@zethub/shared-types';

export function predictClassification(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/timeout|timed out/i.test(text)) return 'timeout';
  if (/ENOENT|not found|missing/i.test(text)) return 'missing-prerequisite';
  if (/EACCES|EPERM|permission/i.test(text)) return 'permission-denied';
  if (/ECONNREFUSED|ENOTFOUND|network/i.test(text)) return 'network-failure';
  if (/\b(assert|expect)/i.test(text)) return 'assertion-failure';
  return 'runtime-error';
}

export interface CapsuleInput {
  run: VerificationRunSummary;
  project: { name: string; sourceType: string };
  result: TestResult;
  diff?: string;
  changedFiles?: string[];
  command?: string;
}

export function buildFailureCapsule(input: CapsuleInput): {
  capsule: FailureCapsule;
  serialized: string;
  redactions: number;
} {
  let redactions = 0;
  const clean = (value: string | undefined) => {
    if (!value) return undefined;
    const res = redactWithCount(value);
    redactions += res.replacements;
    return res.text;
  };
  const failedAssertion = input.result.assertions.find((a) => a.status === 'failed');
  const expected = failedAssertion?.expected;
  const actual = failedAssertion?.actual;
  const logExcerpt = [input.result.stdout, input.result.stderr].filter(Boolean).join('\n').slice(-8000);

  const capsule: FailureCapsule = {
    formatVersion: 1,
    id: `capsule-${input.run.id}-${input.result.key}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120),
    createdAt: new Date().toISOString(),
    project: {
      name: input.project.name,
      sourceType: input.project.sourceType,
      gitCommit: input.run.gitCommit,
      gitBranch: input.run.gitBranch,
    },
    test: { key: input.result.key, title: input.result.title, kind: input.result.kind },
    environment: input.run.environment,
    failure: {
      status: input.result.status,
      classification: input.result.classification ?? 'unclassified',
      message: clean(input.result.message),
      expected: clean(expected),
      actual: clean(actual),
      logExcerpt: clean(logExcerpt),
    },
    diff: input.diff ? clean(input.diff.slice(0, 50_000)) : undefined,
    changedFiles: (input.changedFiles ?? []).map((f) => redact(f)),
    reproduction: {
      steps: [
        `Check out commit ${input.run.gitCommit ?? '(working tree snapshot)'}.`,
        'Install the project dependencies using the project-native package manager.',
        'Open ZetHub Proof, import this capsule, and run the referenced verification case in a controlled environment.',
        'Compare the new evidence against the recorded evidence hashes.',
      ],
      command: clean(input.command ?? input.result.commandDisplay),
    },
    evidenceHashes: Object.fromEntries(input.result.evidence.map((e) => [e.name, e.sha256])),
    redactionsApplied: redactions,
  };

  return { capsule, serialized: JSON.stringify(capsule, null, 2), redactions };
}

export function importFailureCapsule(raw: string): { capsule: FailureCapsule; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Capsule is not valid JSON');
  }
  const result = FailureCapsuleSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Capsule failed validation: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const warnings: string[] = [
    'Capsules are data, not executables. Importing a capsule never runs commands automatically.',
    'Evidence hashes detect modification of the packaged artifacts, but do not prove that the original environment was trustworthy.',
  ];
  if (!result.data.project.gitCommit) warnings.push('Capsule has no commit reference; reproduction may not be exact.');
  return { capsule: result.data, warnings };
}
