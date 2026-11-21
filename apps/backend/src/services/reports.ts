import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FailureCapsule, TestPlan, TestResult, VerificationRunDetail } from '@zethub/shared-types';
import { buildFailureCapsule, buildReport, importFailureCapsule, type ReportBundle } from '@zethub/verification-core';
import type { FailureCapsule as PrismaCapsule, VerificationReport } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { conflict, notFound } from '../lib/http.js';
import { toJson } from '../lib/json.js';
import { evidenceStore, getRunDetail } from './runs.js';

export interface GeneratedReport {
  bundle: ReportBundle;
  records: VerificationReport[];
}

const REPORT_FILES: Record<'HTML' | 'JSON' | 'JUNIT', { name: string; kind: 'html' | 'json' | 'junit'; mime: string }> =
  {
    HTML: { name: 'evidence-passport.html', kind: 'html', mime: 'text/html; charset=utf-8' },
    JSON: { name: 'evidence-passport.json', kind: 'json', mime: 'application/json' },
    JUNIT: { name: 'junit.xml', kind: 'junit', mime: 'application/xml' },
  };

export async function generateReport(input: {
  runId: string;
  projectId: string;
  userId: string;
  generatedBy?: string;
}): Promise<GeneratedReport & { projectName: string }> {
  const run = await getRunDetail(input.runId, input.userId, input.projectId);
  const project = await prisma.project.findFirst({ where: { id: input.projectId, ownerId: input.userId } });
  if (!project) throw notFound('Project');
  const plan = (run.planSnapshot as TestPlan | null) ?? null;
  const bundle = buildReport({
    run: run as VerificationRunDetail,
    projectName: project.name,
    projectId: project.id,
    plan,
    signingSecret: config.sessionSecret,
    generatedBy: input.generatedBy ?? 'ZetHub Proof',
  });

  const records: VerificationReport[] = [];
  for (const format of ['HTML', 'JSON', 'JUNIT'] as const) {
    const file = REPORT_FILES[format];
    const content = format === 'HTML' ? bundle.html : format === 'JSON' ? bundle.json : bundle.junit;
    const artifact = await evidenceStore.write({
      runId: input.runId,
      fileName: file.name,
      content,
      kind: file.kind,
      mimeType: file.mime,
    });
    const record = await prisma.verificationReport.upsert({
      where: { runId_format: { runId: input.runId, format } },
      create: {
        runId: input.runId,
        format,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
        manifestJson: toJson(bundle.manifest),
        generatedBy: input.generatedBy ?? 'ZetHub Proof',
      },
      update: {
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
        manifestJson: toJson(bundle.manifest),
        generatedAt: new Date(),
        generatedBy: input.generatedBy ?? 'ZetHub Proof',
      },
    });
    records.push(record);
  }

  // The HTML report also references itself through the evidence store, so the
  // manifest is written next to the reports for offline verification.
  await evidenceStore.write({
    runId: input.runId,
    fileName: 'evidence-manifest.json',
    content: JSON.stringify(bundle.manifest, null, 2),
    kind: 'json',
    mimeType: 'application/json',
  });

  return { bundle, records, projectName: project.name };
}

export function reportContent(bundle: ReportBundle, format: 'html' | 'json' | 'junit'): string {
  if (format === 'html') return bundle.html;
  if (format === 'json') return bundle.json;
  return bundle.junit;
}

export async function getStoredReports(runId: string): Promise<VerificationReport[]> {
  return prisma.verificationReport.findMany({ where: { runId }, orderBy: { generatedAt: 'desc' } });
}

export async function createCapsule(input: {
  runId: string;
  resultKey: string;
  userId: string;
}): Promise<{ capsule: FailureCapsule; serialized: string; record: PrismaCapsule; existing: boolean }> {
  const run = await getRunDetail(input.runId, input.userId);
  const project = await prisma.project.findFirst({ where: { id: run.projectId, ownerId: input.userId } });
  if (!project) throw notFound('Project');
  const result = run.results.find((r) => r.key === input.resultKey);
  if (!result) throw notFound('Test result');
  if (result.status === 'passed')
    throw conflict('A failure capsule can only be created for a check that did not pass.');

  const existing = await prisma.failureCapsule.findFirst({ where: { runId: input.runId, testKey: input.resultKey } });
  if (existing) {
    const raw = fs.readFileSync(evidenceStore.absolute(existing.relativePath), 'utf8');
    const parsed = importFailureCapsule(raw);
    return { capsule: parsed.capsule, serialized: raw, record: existing, existing: true };
  }

  const { capsule, serialized, redactions } = buildFailureCapsule({
    run: {
      id: run.id,
      projectId: run.projectId,
      projectName: run.projectName,
      planId: run.planId,
      trigger: run.trigger,
      status: run.status,
      strategy: run.strategy,
      gitCommit: run.gitCommit,
      gitBranch: run.gitBranch,
      environment: run.environment,
      counts: run.counts,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      reportId: run.reportId,
      verifiedScope: run.verifiedScope,
      remainingLimitations: run.remainingLimitations,
    },
    project: { name: project.name, sourceType: project.sourceType.toLowerCase() },
    result,
    command: result.commandDisplay,
  });

  const artifact = await evidenceStore.write({
    runId: input.runId,
    fileName: `capsule-${input.resultKey.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`,
    content: serialized,
    kind: 'capsule',
    mimeType: 'application/json',
  });
  const dbResult = await prisma.testResult.findFirst({ where: { runId: input.runId, key: input.resultKey } });
  const record = await prisma.failureCapsule.create({
    data: {
      runId: input.runId,
      resultId: dbResult?.id ?? null,
      testKey: input.resultKey,
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
      formatVersion: 1,
      redactions,
    },
  });
  return { capsule, serialized, record, existing: false };
}

export async function listCapsules(runId: string, userId: string) {
  const run = await prisma.testRun.findFirst({ where: { id: runId, project: { ownerId: userId } } });
  if (!run) throw notFound('Verification run');
  const items = await prisma.failureCapsule.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
  return items.map((c) => ({
    id: c.id,
    testKey: c.testKey,
    relativePath: c.relativePath,
    sha256: c.sha256,
    formatVersion: c.formatVersion,
    redactions: c.redactions,
    createdAt: c.createdAt.toISOString(),
  }));
}

export async function readCapsule(capsuleId: string, userId: string): Promise<{ raw: string; record: PrismaCapsule }> {
  const record = await prisma.failureCapsule.findFirst({
    where: { id: capsuleId, run: { project: { ownerId: userId } } },
  });
  if (!record) throw notFound('Failure capsule');
  const raw = fs.readFileSync(evidenceStore.absolute(record.relativePath), 'utf8');
  return { raw, record };
}

/**
 * Compute a rough "related files" list for a failed result from the stored plan.
 * This is evidence for a human, not an automated root-cause claim.
 */
export function relatedFiles(result: TestResult, plan: TestPlan | null): string[] {
  const planned = plan?.cases.find((c) => c.key === result.key);
  if (planned?.mappedFiles.length) return planned.mappedFiles;
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const matches = [
    ...text.matchAll(/(?:^|\s)([\w./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|php|sql|json|yml|yaml))(?::\d+)?/g),
  ]
    .map((m) => m[1]!.replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((f) => !f.includes('node_modules') && f.length < 240);
  return [...new Set(matches)].slice(0, 25);
}

export function workingTreeDiff(rootPath: string): string | undefined {
  try {
    if (!fs.existsSync(path.join(rootPath, '.git'))) return undefined;
    const result = spawnSync('git', ['diff', '--unified=2'], {
      cwd: rootPath,
      timeout: 15_000,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout) return undefined;
    return result.stdout.slice(0, 50_000);
  } catch {
    return undefined;
  }
}

export async function sha256File(filePath: string): Promise<string> {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
