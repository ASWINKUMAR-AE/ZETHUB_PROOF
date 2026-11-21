import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditTestQuality, detectFlakiness } from '@zethub/verification-core';
import { prisma } from '../db.js';
import { checkDatabase } from '../db.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { badRequest, notFound } from '../lib/http.js';
import { toJson } from '../lib/json.js';
import { evidenceStore, offlineQueue, serializeRun } from '../services/runs.js';

const DayQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

function startOfDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/dashboard', { preHandler: authenticate }, async (request) => {
    const userId = request.auth!.user.id;
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [projects, healthy, failing, runsWeek, activeRuns, unread, recent, db, queue, lastBackup] = await Promise.all(
      [
        prisma.project.count({ where: { ownerId: userId, archived: false } }),
        prisma.project.count({ where: { ownerId: userId, archived: false, health: 'HEALTHY' } }),
        prisma.project.count({ where: { ownerId: userId, archived: false, health: 'FAILING' } }),
        prisma.testRun.findMany({
          where: { project: { ownerId: userId }, startedAt: { gte: weekAgo } },
          select: { status: true, passedCount: true, totalCount: true },
        }),
        prisma.testRun.count({ where: { project: { ownerId: userId }, status: 'RUNNING' } }),
        prisma.notification.count({ where: { userId, readAt: null } }),
        prisma.testRun.findMany({
          where: { project: { ownerId: userId } },
          orderBy: { startedAt: 'desc' },
          take: 6,
          include: { project: { select: { name: true } } },
        }),
        checkDatabase(),
        Promise.resolve(offlineQueue.stats()),
        prisma.dbBackup.findFirst({ orderBy: { createdAt: 'desc' } }),
      ],
    );
    const finished = runsWeek.filter((r) =>
      ['PASSED', 'FAILED', 'BLOCKED', 'TIMEOUT', 'ERROR', 'UNVERIFIED'].includes(r.status),
    );
    const passed = finished.filter((r) => r.status === 'PASSED').length;
    return {
      projects: { total: projects, healthy, failing, unknown: projects - healthy - failing },
      runsThisWeek: {
        total: runsWeek.length,
        finished: finished.length,
        passed,
        passRate: finished.length ? passed / finished.length : null,
      },
      activeRuns,
      unreadNotifications: unread,
      recentRuns: recent.map((r) => ({ ...serializeRun(r), projectName: r.project.name, reportId: null })),
      database: {
        reachable: db.available,
        error: db.error ? 'Database unreachable' : null,
        lastBackup: lastBackup
          ? {
              fileName: lastBackup.fileName,
              createdAt: lastBackup.createdAt.toISOString(),
              verified: lastBackup.verified,
            }
          : null,
      },
      offlineQueue: queue,
      ai: {
        enabled: config.ai.enabled,
        configured: Boolean(config.ai.apiKey && config.ai.provider && config.ai.model),
      },
    };
  });

  app.get('/api/v1/analytics/overview', { preHandler: authenticate }, async (request) => {
    const userId = request.auth!.user.id;
    const { days } = DayQuery.parse(request.query ?? {});
    const since = new Date(Date.now() - days * 86_400_000);
    const runs = await prisma.testRun.findMany({
      where: { project: { ownerId: userId }, startedAt: { gte: since } },
      select: {
        id: true,
        status: true,
        startedAt: true,
        durationMs: true,
        totalCount: true,
        passedCount: true,
        failedCount: true,
        blockedCount: true,
        unverifiedCount: true,
        projectId: true,
        project: { select: { name: true } },
      },
      orderBy: { startedAt: 'asc' },
    });

    const daysMap = new Map<
      string,
      {
        date: string;
        runs: number;
        passed: number;
        failed: number;
        blocked: number;
        unverified: number;
        durationMs: number;
        checks: number;
        checksPassed: number;
      }
    >();
    for (const run of runs) {
      const key = startOfDay(run.startedAt);
      const entry = daysMap.get(key) ?? {
        date: key,
        runs: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        unverified: 0,
        durationMs: 0,
        checks: 0,
        checksPassed: 0,
      };
      entry.runs += 1;
      entry.checks += run.totalCount;
      entry.checksPassed += run.passedCount;
      entry.durationMs += run.durationMs;
      if (run.status === 'PASSED') entry.passed += 1;
      else if (run.status === 'FAILED') entry.failed += 1;
      else if (run.status === 'BLOCKED') entry.blocked += 1;
      else if (run.status === 'UNVERIFIED') entry.unverified += 1;
      daysMap.set(key, entry);
    }

    const finished = runs.filter((r) =>
      ['PASSED', 'FAILED', 'BLOCKED', 'TIMEOUT', 'ERROR', 'UNVERIFIED'].includes(r.status),
    );
    const passed = finished.filter((r) => r.status === 'PASSED');

    const projectStats = new Map<
      string,
      {
        projectId: string;
        name: string;
        runs: number;
        passed: number;
        failed: number;
        checks: number;
        checksPassed: number;
      }
    >();
    for (const run of runs) {
      const entry = projectStats.get(run.projectId) ?? {
        projectId: run.projectId,
        name: run.project.name,
        runs: 0,
        passed: 0,
        failed: 0,
        checks: 0,
        checksPassed: 0,
      };
      entry.runs += 1;
      entry.checks += run.totalCount;
      entry.checksPassed += run.passedCount;
      if (run.status === 'PASSED') entry.passed += 1;
      if (run.status === 'FAILED') entry.failed += 1;
      projectStats.set(run.projectId, entry);
    }

    const failures = await prisma.testResult.groupBy({
      by: ['key', 'title'],
      where: {
        run: { project: { ownerId: userId }, startedAt: { gte: since } },
        status: { in: ['FAILED', 'ERROR', 'TIMEOUT'] },
      },
      _count: { _all: true },
      orderBy: { _count: { key: 'desc' } },
      take: 10,
    });

    const kinds = await prisma.testResult.groupBy({
      by: ['kind'],
      where: { run: { project: { ownerId: userId }, startedAt: { gte: since } } },
      _count: { _all: true },
    });
    const kindFailures = await prisma.testResult.groupBy({
      by: ['kind'],
      where: {
        run: { project: { ownerId: userId }, startedAt: { gte: since } },
        status: { in: ['FAILED', 'ERROR', 'TIMEOUT'] },
      },
      _count: { _all: true },
    });
    const kindFailureMap = new Map(kindFailures.map((k) => [k.kind, k._count._all]));

    return {
      days,
      totals: {
        runs: runs.length,
        finished: finished.length,
        passed: passed.length,
        failed: finished.filter((r) => r.status === 'FAILED').length,
        passRate: finished.length ? passed.length / finished.length : null,
        checks: runs.reduce((a, r) => a + r.totalCount, 0),
        checksPassed: runs.reduce((a, r) => a + r.passedCount, 0),
        checksFailed: runs.reduce((a, r) => a + r.failedCount, 0),
        avgDurationMs: Math.round(average(finished.map((r) => r.durationMs))),
      },
      series: [...daysMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      projects: [...projectStats.values()].sort((a, b) => b.runs - a.runs),
      topFailures: failures.map((f) => ({ key: f.key, title: f.title, failures: f._count._all })),
      byKind: kinds.map((k) => ({ kind: k.kind, total: k._count._all, failures: kindFailureMap.get(k.kind) ?? 0 })),
    };
  });

  app.get('/api/v1/projects/:id/analytics', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { days } = DayQuery.parse(request.query ?? {});
    const project = await prisma.project.findFirst({ where: { id, ownerId: request.auth!.user.id } });
    if (!project) throw notFound('Project');
    const since = new Date(Date.now() - days * 86_400_000);
    const runs = await prisma.testRun.findMany({
      where: { projectId: id, startedAt: { gte: since } },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true,
        status: true,
        startedAt: true,
        durationMs: true,
        totalCount: true,
        passedCount: true,
        failedCount: true,
        blockedCount: true,
        unverifiedCount: true,
        gitCommit: true,
        strategy: true,
      },
    });
    const results = await prisma.testResult.findMany({
      where: { run: { projectId: id, startedAt: { gte: since } } },
      select: { key: true, title: true, kind: true, status: true, durationMs: true, createdAt: true, runId: true },
      orderBy: { createdAt: 'asc' },
      take: 20_000,
    });
    const history = results.map((r) => ({ testName: `${r.key} ${r.title}`, status: r.status }));
    const flaky = detectFlakiness(history)
      .sort((a, b) => b.alternations - a.alternations)
      .slice(0, 10);
    const failuresByKind = new Map<string, number>();
    for (const r of results)
      if (['FAILED', 'ERROR', 'TIMEOUT'].includes(r.status))
        failuresByKind.set(r.kind, (failuresByKind.get(r.kind) ?? 0) + 1);
    const durations = new Map<string, number[]>();
    for (const r of results) durations.set(r.key, [...(durations.get(r.key) ?? []), r.durationMs]);
    const slowest = [...durations.entries()]
      .map(([key, values]) => ({ key, avgDurationMs: Math.round(average(values)), runs: values.length }))
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, 10);

    return {
      project: {
        id: project.id,
        name: project.name,
        health: project.health.toLowerCase(),
        lastVerifiedAt: project.lastVerifiedAt?.toISOString() ?? null,
      },
      days,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status.toLowerCase(),
        strategy: r.strategy.toLowerCase(),
        startedAt: r.startedAt.toISOString(),
        durationMs: r.durationMs,
        total: r.totalCount,
        passed: r.passedCount,
        failed: r.failedCount,
        blocked: r.blockedCount,
        unverified: r.unverifiedCount,
        gitCommit: r.gitCommit,
      })),
      failuresByKind: [...failuresByKind.entries()].map(([kind, failures]) => ({ kind, failures })),
      flaky,
      slowest,
    };
  });

  app.get('/api/v1/analytics/cross-os', { preHandler: authenticate }, async (request) => {
    const userId = request.auth!.user.id;
    const query = z
      .object({ projectId: z.string().optional(), days: z.coerce.number().int().min(1).max(365).default(90) })
      .parse(request.query ?? {});
    const since = new Date(Date.now() - query.days * 86_400_000);
    const runs = await prisma.testRun.findMany({
      where: {
        project: { ownerId: userId },
        startedAt: { gte: since },
        ...(query.projectId ? { projectId: query.projectId } : {}),
      },
      select: {
        id: true,
        projectId: true,
        status: true,
        environmentJson: true,
        startedAt: true,
        totalCount: true,
        passedCount: true,
        failedCount: true,
        gitCommit: true,
        project: { select: { name: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 2000,
    });
    const groups = new Map<
      string,
      {
        platform: string;
        os: string;
        arch: string;
        runs: number;
        passed: number;
        failed: number;
        checks: number;
        checksPassed: number;
      }
    >();
    for (const run of runs) {
      const env = (run.environmentJson ?? {}) as { platform?: string; os?: string; arch?: string };
      const platform = env.platform ?? 'unknown';
      const key = `${platform}|${env.arch ?? 'unknown'}`;
      const g = groups.get(key) ?? {
        platform,
        os: env.os ?? platform,
        arch: env.arch ?? 'unknown',
        runs: 0,
        passed: 0,
        failed: 0,
        checks: 0,
        checksPassed: 0,
      };
      g.runs += 1;
      g.checks += run.totalCount;
      g.checksPassed += run.passedCount;
      if (run.status === 'PASSED') g.passed += 1;
      if (run.status === 'FAILED') g.failed += 1;
      groups.set(key, g);
    }
    const comparison = [...groups.values()].map((g) => ({
      ...g,
      passRate: g.runs ? g.passed / g.runs : null,
      checkPassRate: g.checks ? g.checksPassed / g.checks : null,
    }));
    return {
      platforms: comparison,
      runs: runs.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        projectName: r.project.name,
        platform: (r.environmentJson as { platform?: string } | null)?.platform ?? 'unknown',
        status: r.status.toLowerCase(),
        startedAt: r.startedAt.toISOString(),
        gitCommit: r.gitCommit,
        total: r.totalCount,
        passed: r.passedCount,
        failed: r.failedCount,
      })),
      limitations: [
        comparison.length < 2
          ? 'Only one operating-system group has recorded runs, so cross-OS parity cannot be established yet.'
          : 'Cross-OS comparison is only meaningful for the same commit and the same configured checks. Compare the recorded commits before drawing conclusions.',
        'Results from different machines are independent evidence; ZetHub Proof does not remotely execute or attest other machines in this local deployment.',
      ],
    };
  });

  app.get('/api/v1/runs/:id/compare', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ otherId: z.string() }).parse(request.query ?? {});
    const userId = request.auth!.user.id;
    const [a, b] = await Promise.all([
      prisma.testRun.findFirst({
        where: { id, project: { ownerId: userId } },
        include: { results: true, project: { select: { name: true } } },
      }),
      prisma.testRun.findFirst({
        where: { id: query.otherId, project: { ownerId: userId } },
        include: { results: true, project: { select: { name: true } } },
      }),
    ]);
    if (!a || !b) throw notFound('Verification run');
    const keys = [...new Set([...a.results.map((r) => r.key), ...b.results.map((r) => r.key)])];
    const byKey = (run: typeof a) => new Map(run.results.map((r) => [r.key, r]));
    const mapA = byKey(a);
    const mapB = byKey(b);
    return {
      left: {
        ...serializeRun(a),
        platform: (a.environmentJson as { platform?: string } | null)?.platform ?? 'unknown',
      },
      right: {
        ...serializeRun(b),
        platform: (b.environmentJson as { platform?: string } | null)?.platform ?? 'unknown',
      },
      sameCommit: a.gitCommit != null && a.gitCommit === b.gitCommit,
      cases: keys.map((key) => ({
        key,
        left: mapA.get(key)?.status.toLowerCase() ?? 'missing',
        right: mapB.get(key)?.status.toLowerCase() ?? 'missing',
        changed: (mapA.get(key)?.status ?? 'missing') !== (mapB.get(key)?.status ?? 'missing'),
      })),
    };
  });

  app.post('/api/v1/projects/:id/quality/audit', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await prisma.project.findFirst({ where: { id, ownerId: request.auth!.user.id } });
    if (!project) throw notFound('Project');
    if (!project.rootPath) throw badRequest('Attach a local folder to audit test quality.');
    const body = z.object({ files: z.array(z.string().max(500)).max(500).optional() }).parse(request.body ?? {});
    const results = await prisma.testResult.findMany({
      where: { run: { projectId: id } },
      select: { key: true, title: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
    const flakyTests = detectFlakiness(results.map((r) => ({ testName: `${r.key} ${r.title}`, status: r.status })))
      .filter((f) => f.alternations >= 2 && f.runs >= 4)
      .slice(0, 50);
    const result = auditTestQuality({ rootPath: project.rootPath, files: body.files, flakyTests });
    const artifact = await evidenceStore.write({
      runId: `quality-${project.id}`,
      fileName: `quality-audit-${Date.now()}.json`,
      content: JSON.stringify({ projectId: id, generatedAt: new Date().toISOString(), ...result }, null, 2),
      kind: 'json',
      mimeType: 'application/json',
    });
    await prisma.auditLog
      .create({
        data: {
          userId: request.auth!.user.id,
          action: 'RUN_COMPLETE',
          entityType: 'quality-audit',
          entityId: project.id,
          metadata: toJson({
            findings: result.findings.length,
            filesAnalyzed: result.filesAnalyzed,
            testsAnalyzed: result.testsAnalyzed,
          }),
          ip: request.ip,
        },
      })
      .catch(() => undefined);
    return {
      ...result,
      artifact: { relativePath: artifact.relativePath, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes },
      mutationTesting: {
        available: false,
        reason:
          'Mutation testing requires a project-specific mutation runner. ZetHub Proof does not ship a generic mutation engine, so no mutation score is reported.',
      },
    };
  });

  app.get('/api/v1/analytics/flaky', { preHandler: authenticate }, async (request) => {
    const query = z
      .object({ projectId: z.string().optional(), days: z.coerce.number().int().min(1).max(365).default(90) })
      .parse(request.query ?? {});
    const since = new Date(Date.now() - query.days * 86_400_000);
    const results = await prisma.testResult.findMany({
      where: {
        run: {
          project: { ownerId: request.auth!.user.id },
          ...(query.projectId ? { projectId: query.projectId } : {}),
          startedAt: { gte: since },
        },
      },
      select: { key: true, title: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 20_000,
    });
    return {
      items: detectFlakiness(results.map((r) => ({ testName: `${r.key} ${r.title}`, status: r.status }))).sort(
        (a, b) => b.alternations - a.alternations,
      ),
    };
  });
}
