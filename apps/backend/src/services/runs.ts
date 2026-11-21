import crypto from 'node:crypto';
import os from 'node:os';
import type { EnvironmentInfo, TestPlan, TestResult, VerificationRunDetail } from '@zethub/shared-types';
import { EvidenceStore, executePlan, countsFor, type DbConnectionConfig } from '@zethub/verification-core';
import type {
  Project,
  RunStatus as PrismaRunStatus,
  ResultStatus as PrismaResultStatus,
  TestRun,
} from '@prisma/client';
import { prisma } from '../db.js';
import { config, APP_VERSION, paths } from '../config.js';
import { CredentialStore } from '../security.js';
import { audit } from '../lib/audit.js';
import { OfflineQueue } from '../lib/offlineQueue.js';
import { HttpError, notFound } from '../lib/http.js';
import { toJson } from '../lib/json.js';

export const evidenceStore = new EvidenceStore(config.artifactsDir);
export const credentialStore = new CredentialStore(paths.data, config.sessionSecret);
export const offlineQueue = new OfflineQueue(paths.data);

export interface ActiveRun {
  controller: AbortController;
  startedAt: number;
  projectId: string;
  userId: string;
  sequence: number;
  subscribers: Set<(event: RunEvent) => void>;
  lastEvent?: RunEvent;
}

export interface RunEvent {
  type: 'status' | 'case-start' | 'case-complete' | 'log' | 'done' | 'error';
  runId: string;
  at: string;
  caseKey?: string;
  title?: string;
  status?: string;
  progress?: { completed: number; total: number };
  message?: string;
}

export const activeRuns = new Map<string, ActiveRun>();

export function subscribe(runId: string, handler: (event: RunEvent) => void): () => void {
  const active = activeRuns.get(runId);
  if (!active) return () => undefined;
  active.subscribers.add(handler);
  return () => active.subscribers.delete(handler);
}

function publish(runId: string, event: RunEvent): void {
  const active = activeRuns.get(runId);
  if (!active) return;
  active.lastEvent = event;
  for (const subscriber of active.subscribers) {
    try {
      subscriber(event);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

const STATUS_MAP: Record<string, PrismaResultStatus> = {
  passed: 'PASSED',
  failed: 'FAILED',
  blocked: 'BLOCKED',
  cancelled: 'CANCELLED',
  timeout: 'TIMEOUT',
  error: 'ERROR',
  skipped: 'SKIPPED',
  unverified: 'UNVERIFIED',
};

const RUN_STATUS_MAP: Record<string, PrismaRunStatus> = {
  passed: 'PASSED',
  failed: 'FAILED',
  blocked: 'BLOCKED',
  cancelled: 'CANCELLED',
  timeout: 'TIMEOUT',
  error: 'ERROR',
  unverified: 'UNVERIFIED',
  queued: 'QUEUED',
  running: 'RUNNING',
};

export function environmentInfo(plan: TestPlan | null): VerificationRunDetail['environment'] {
  return {
    os: `${process.platform} ${os.release()}`,
    arch: process.arch,
    platform: process.platform,
    node: process.version,
    hostname: os.hostname(),
    appVersion: APP_VERSION,
    toolVersions: Object.fromEntries(
      (plan?.cases ?? [])
        .map((c) => c.adapterId)
        .filter((v, i, a) => a.indexOf(v) === i)
        .map((id) => [id, 'detected']),
    ),
  };
}

export async function resolveRunInputs(
  project: Project,
  plan: TestPlan,
): Promise<{
  variables: Record<string, string>;
  secrets: Record<string, string>;
  dbConnections: Record<string, DbConnectionConfig>;
  baseUrl?: string;
}> {
  const environment = await prisma.projectEnvironment.findFirst({
    where: { projectId: project.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  const variables: Record<string, string> = {};
  if (environment?.variables && typeof environment.variables === 'object') {
    for (const [k, v] of Object.entries(environment.variables as Record<string, unknown>)) {
      variables[k] = String(v);
    }
  }
  const secrets = environment ? credentialStore.get(`project-env:${environment.id}`) : {};

  const dbConnections: Record<string, DbConnectionConfig> = {};
  const integrationIds = [
    ...new Set(plan.cases.map((c) => c.database?.integrationId).filter((v): v is string => Boolean(v))),
  ];
  for (const integrationId of integrationIds) {
    const integration = await prisma.integration.findFirst({
      where: { id: integrationId, projectId: project.id, type: 'DATABASE' },
    });
    if (!integration || !integration.enabled) continue;
    const cfg = (integration.configJson ?? {}) as Record<string, unknown>;
    const creds = credentialStore.get(`integration:${integration.id}`);
    dbConnections[integrationId] = {
      host: String(cfg.host ?? '127.0.0.1'),
      port: Number(cfg.port ?? 3306),
      user: String(cfg.user ?? ''),
      password: creds.password ?? '',
      database: String(cfg.database ?? ''),
      ssl: Boolean(cfg.ssl),
      connectTimeoutMs: 10_000,
    };
  }
  return {
    variables,
    secrets,
    dbConnections,
    baseUrl: environment?.baseUrl ?? project.websiteUrl ?? undefined,
  };
}

export interface StartRunInput {
  project: Project;
  userId: string;
  trigger?: 'MANUAL' | 'CLI' | 'CI' | 'REPAIR_RETEST' | 'SCHEDULED';
  plan: TestPlan;
  approvals: 'all' | string[];
  writesConfirmed?: string[];
  ip?: string;
  retestOf?: string;
  repairProposalId?: string;
}

export async function startRun(input: StartRunInput): Promise<{ runId: string; planId: string }> {
  const { project, plan } = input;
  const planId = crypto.randomUUID();
  plan.id = planId;
  await prisma.testPlan.create({
    data: {
      id: planId,
      projectId: project.id,
      strategy: plan.strategy.toUpperCase() as 'FULL' | 'CHANGED' | 'SELECTED',
      coverageConfidence: plan.coverageConfidence,
      planJson: toJson(plan),
      notesJson: toJson(plan.notes),
      unverifiedJson: toJson(plan.unverifiedAreas),
    },
  });

  for (const testCase of plan.cases) {
    const cfg: Record<string, unknown> = {};
    if (testCase.browser) cfg.scenario = testCase.browser;
    else if (testCase.api) cfg.scenario = testCase.api;
    else if (testCase.database) cfg.scenario = testCase.database;
    else if (testCase.command) {
      cfg.command = testCase.command;
      cfg.timeoutMs = testCase.timeoutMs;
    }
    await prisma.testCase.upsert({
      where: { projectId_key: { projectId: project.id, key: testCase.key } },
      create: {
        projectId: project.id,
        key: testCase.key,
        title: testCase.title,
        kind: testCase.kind,
        adapterId: testCase.adapterId,
        source: testCase.source === 'ai' ? 'AI' : testCase.source === 'user' ? 'USER' : 'DETECTED',
        reason: testCase.reason,
        configJson: toJson(cfg),
        requiresApproval: testCase.requiresApproval,
        mappedFiles: toJson(testCase.mappedFiles),
        tags: toJson(testCase.tags),
        priority: testCase.priority,
      },
      update: {},
    });
  }

  const run = await prisma.testRun.create({
    data: {
      projectId: project.id,
      planId,
      userId: input.userId,
      trigger: input.trigger ?? 'MANUAL',
      status: 'RUNNING',
      strategy: plan.strategy.toUpperCase() as 'FULL' | 'CHANGED' | 'SELECTED',
      environmentJson: environmentInfo(plan),
      gitCommit: project.rootPath ? ((plan as { gitCommit?: string }).gitCommit ?? null) : null,
      verifiedScope: `Executed ${plan.cases.length} planned check(s). Only these checks are covered by this evidence.`,
      limitationsJson: plan.unverifiedAreas,
    },
  });

  const controller = new AbortController();
  const active: ActiveRun = {
    controller,
    startedAt: Date.now(),
    projectId: project.id,
    userId: input.userId,
    sequence: 0,
    subscribers: new Set(),
  };
  activeRuns.set(run.id, active);

  void executeRun({
    runId: run.id,
    project,
    plan,
    approvals: input.approvals,
    writesConfirmed: input.writesConfirmed,
    signal: controller.signal,
    active,
    userId: input.userId,
    ip: input.ip,
    repairProposalId: input.repairProposalId,
  });

  return { runId: run.id, planId };
}

async function executeRun(input: {
  runId: string;
  project: Project;
  plan: TestPlan;
  approvals: 'all' | string[];
  writesConfirmed?: string[];
  signal: AbortSignal;
  active: ActiveRun;
  userId: string;
  ip?: string;
  repairProposalId?: string;
}): Promise<void> {
  const { runId, project, plan } = input;
  const startedAt = new Date();
  const total = plan.cases.length;
  let completed = 0;
  try {
    const resolved = await resolveRunInputs(project, plan);
    const result = await executePlan({
      runId,
      projectId: project.id,
      projectRoot: project.rootPath ?? paths.root,
      plan,
      artifacts: evidenceStore,
      approvals: input.approvals === 'all' ? 'all' : new Set(input.approvals),
      signal: input.signal,
      variables: resolved.variables,
      secrets: resolved.secrets,
      dbConnections: resolved.dbConnections,
      writesConfirmed: new Set(input.writesConfirmed ?? []),
      concurrency: config.maxParallelTests,
      baseUrl: resolved.baseUrl,
      onProgress: (event) => {
        if (event.status === 'running') {
          publish(runId, {
            type: 'case-start',
            runId,
            at: new Date().toISOString(),
            caseKey: event.key,
            progress: { completed, total },
          });
        } else {
          completed += 1;
          publish(runId, {
            type: 'case-complete',
            runId,
            at: new Date().toISOString(),
            caseKey: event.key,
            status: event.result?.status,
            title: event.result?.title,
            progress: { completed, total },
          });
        }
      },
    });

    const finishedAt = new Date();
    await prisma.$transaction(async (tx) => {
      for (const r of result.results) {
        const created = await tx.testResult.create({
          data: {
            runId,
            key: r.key,
            title: r.title,
            kind: r.kind,
            adapterId: r.adapterId,
            status: STATUS_MAP[r.status] ?? 'ERROR',
            durationMs: Math.round(r.durationMs),
            exitCode: r.exitCode ?? null,
            commandDisplay: r.commandDisplay ?? null,
            stdout: r.stdout ?? null,
            stderr: r.stderr ?? null,
            classification: r.classification ?? null,
            message: r.message ?? null,
            metadataJson: { stdoutTruncated: r.stdoutTruncated ?? false },
          },
        });
        if (r.assertions.length > 0) {
          await tx.testAssertion.createMany({
            data: r.assertions.map((a) => ({
              resultId: created.id,
              name: a.name.slice(0, 500),
              status: STATUS_MAP[a.status] ?? 'ERROR',
              expected: a.expected?.slice(0, 4000) ?? null,
              actual: a.actual?.slice(0, 4000) ?? null,
              message: a.message?.slice(0, 4000) ?? null,
              durationMs: a.durationMs ?? null,
            })),
          });
        }
        for (const artifact of r.evidence) {
          await tx.evidenceArtifact.create({
            data: {
              runId,
              resultId: created.id,
              kind: artifact.kind.toUpperCase() as never,
              name: artifact.name,
              relativePath: artifact.relativePath,
              mimeType: artifact.mimeType,
              sizeBytes: BigInt(artifact.sizeBytes),
              sha256: artifact.sha256,
            },
          });
        }
      }
      await tx.testRun.update({
        where: { id: runId },
        data: {
          status: RUN_STATUS_MAP[result.status] ?? 'ERROR',
          totalCount: result.counts.total,
          passedCount: result.counts.passed,
          failedCount: result.counts.failed,
          blockedCount: result.counts.blocked,
          unverifiedCount: result.counts.unverified,
          skippedCount: result.counts.skipped,
          durationMs: Math.round(result.counts.durationMs),
          limitationsJson: result.remainingLimitations,
          finishedAt,
          // A startup recovery in another process may have written an
          // "interrupted" note while this run was still executing. A completed
          // run with persisted results must not keep that stale message.
          errorMessage: null,
        },
      });
      await tx.project.update({
        where: { id: project.id },
        data: {
          lastVerifiedAt: finishedAt,
          health: result.status === 'passed' ? 'HEALTHY' : result.status === 'failed' ? 'FAILING' : 'DEGRADED',
        },
      });
      await tx.notification.create({
        data: {
          userId: input.userId,
          type: result.status === 'passed' ? 'run-passed' : 'run-failed',
          title: `${project.name}: verification ${result.status}`,
          body: `${result.counts.passed}/${result.counts.total} checks passed; ${result.counts.failed} failed, ${result.counts.blocked} blocked, ${result.counts.unverified} unverified.`,
        },
      });
      if (input.repairProposalId) {
        await tx.repairProposal.updateMany({
          where: { id: input.repairProposalId },
          data: {
            status: result.status === 'passed' ? 'VERIFIED' : 'FAILED',
            verifiedAt: result.status === 'passed' ? finishedAt : null,
            retestRunId: runId,
          },
        });
      }
    });

    await audit({
      userId: input.userId,
      action: 'RUN_COMPLETE',
      entityType: 'test-run',
      entityId: runId,
      metadata: { status: result.status, counts: result.counts },
      ip: input.ip,
    });
    publish(runId, {
      type: 'done',
      runId,
      at: finishedAt.toISOString(),
      status: result.status,
      progress: { completed: total, total },
      message: result.remainingLimitations.join(' '),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publish(runId, { type: 'error', runId, at: new Date().toISOString(), message });
    // Preserve the run so history is not silently corrupted.
    try {
      await prisma.testRun.update({
        where: { id: runId },
        data: { status: 'ERROR', errorMessage: message.slice(0, 8000), finishedAt: new Date() },
      });
    } catch {
      offlineQueue.append({
        id: `run-error-${runId}`,
        type: 'run-result',
        payload: { runId, projectId: project.id, phase: 'persistence-error', message, at: new Date().toISOString() },
        createdAt: new Date().toISOString(),
      });
    }
    await audit({
      userId: input.userId,
      action: 'RUN_COMPLETE',
      entityType: 'test-run',
      entityId: runId,
      metadata: { status: 'error', message: message.slice(0, 500) },
      ip: input.ip,
    });
  } finally {
    activeRuns.delete(runId);
    void startedAt;
  }
}

export function cancelRun(runId: string, userId: string): boolean {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.controller.abort();
  publish(runId, {
    type: 'log',
    runId,
    at: new Date().toISOString(),
    message: 'Cancellation requested. Waiting for child process cleanup.',
  });
  void audit({ userId, action: 'RUN_CANCEL', entityType: 'test-run', entityId: runId });
  return true;
}

export async function recoverInterruptedRuns(): Promise<number> {
  // Results are persisted in the same transaction that finalizes the run, so a
  // RUNNING row with results is a recovery race (for example, a second API
  // process starting) rather than a crash. Only mark truly empty runs.
  const stale = await prisma.testRun.findMany({
    where: { status: 'RUNNING', results: { none: {} } },
  });
  for (const run of stale) {
    await prisma.testRun.update({
      where: { id: run.id },
      data: {
        status: 'ERROR',
        errorMessage:
          'The API process restarted while this run was in progress. The run was marked as interrupted; no partial result was reported as passed.',
        finishedAt: new Date(),
      },
    });
  }
  return stale.length;
}

/* ----------------------------- serializers ----------------------------- */

export function serializeRun(run: TestRun & { project?: { name: string } | null; reports?: unknown[] }) {
  return {
    id: run.id,
    projectId: run.projectId,
    projectName: run.project?.name,
    planId: run.planId,
    trigger: run.trigger.toLowerCase() as 'manual' | 'cli' | 'ci' | 'repair-retest' | 'scheduled',
    status: run.status.toLowerCase() as
      'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'timeout' | 'error' | 'unverified',
    strategy: run.strategy.toLowerCase() as 'full' | 'changed' | 'selected',
    gitCommit: run.gitCommit,
    gitBranch: run.gitBranch,
    environment: run.environmentJson as unknown as EnvironmentInfo,
    counts: {
      total: run.totalCount,
      passed: run.passedCount,
      failed: run.failedCount,
      blocked: run.blockedCount,
      unverified: run.unverifiedCount,
      skipped: run.skippedCount,
      durationMs: run.durationMs,
    },
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    reportId: null,
    verifiedScope: run.verifiedScope ?? undefined,
    remainingLimitations: (run.limitationsJson as string[] | null) ?? [],
    errorMessage: run.errorMessage,
  };
}

export async function getRunDetail(
  runId: string,
  userId: string,
  projectId?: string,
): Promise<VerificationRunDetail & { errorMessage?: string | null }> {
  const run = await prisma.testRun.findFirst({
    where: { id: runId, ...(projectId ? { projectId } : {}), project: { ownerId: userId } },
    include: {
      project: { select: { name: true } },
      results: { include: { assertions: true, evidence: true }, orderBy: { createdAt: 'asc' } },
      plan: true,
      reports: { select: { id: true, format: true, relativePath: true, sha256: true, generatedAt: true } },
    },
  });
  if (!run) throw notFound('Verification run');
  const plan = run.plan ? (run.plan.planJson as unknown as TestPlan) : null;
  const results: TestResult[] = run.results.map((r) => ({
    key: r.key,
    title: r.title,
    kind: r.kind as TestResult['kind'],
    adapterId: r.adapterId,
    status: r.status.toLowerCase() as TestResult['status'],
    durationMs: r.durationMs,
    exitCode: r.exitCode,
    commandDisplay: r.commandDisplay ?? undefined,
    stdout: r.stdout ?? undefined,
    stderr: r.stderr ?? undefined,
    assertions: r.assertions.map((a) => ({
      name: a.name,
      status: a.status.toLowerCase() as TestResult['status'],
      expected: a.expected ?? undefined,
      actual: a.actual ?? undefined,
      message: a.message ?? undefined,
      durationMs: a.durationMs ?? undefined,
    })),
    evidence: r.evidence.map((e) => ({
      id: e.id,
      kind: e.kind.toLowerCase() as TestResult['evidence'][number]['kind'],
      name: e.name,
      relativePath: e.relativePath,
      mimeType: e.mimeType,
      sizeBytes: Number(e.sizeBytes),
      sha256: e.sha256,
      createdAt: e.createdAt.toISOString(),
    })),
    classification: r.classification ?? undefined,
    message: r.message ?? undefined,
    stdoutTruncated: (r.metadataJson as { stdoutTruncated?: boolean } | null)?.stdoutTruncated,
  }));
  return {
    ...serializeRun(run as never),
    reportId: run.reports[0]?.id ?? null,
    results,
    planSnapshot: plan,
    logs: [],
    errorMessage: run.errorMessage,
  };
}

export async function findProjectForUser(userId: string, projectId: string): Promise<Project> {
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
  if (!project) throw notFound('Project');
  return project;
}

export function countStatuses(results: TestResult[]): ReturnType<typeof countsFor> {
  return countsFor(results, 0);
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}
