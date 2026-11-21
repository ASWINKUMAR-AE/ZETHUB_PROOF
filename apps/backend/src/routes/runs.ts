import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { TestPlan } from '@zethub/shared-types';
import { importFailureCapsule } from '@zethub/verification-core';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { authenticate, requireOwner } from '../auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, parsePagination } from '../lib/http.js';
import { jsonArray } from '../lib/json.js';
import { activeRuns, cancelRun, getRunDetail, serializeRun, startRun, subscribe } from '../services/runs.js';
import { preparePlan } from '../services/plan.js';
import { createCapsule, generateReport, listCapsules, readCapsule, reportContent } from '../services/reports.js';

const PlanPreviewBody = z.object({
  strategy: z.enum(['full', 'changed', 'selected']).default('full'),
  caseKeys: z.array(z.string()).max(500).optional(),
  forceFull: z.boolean().optional(),
  changedFiles: z.array(z.string().max(1000)).max(2000).optional(),
});

const RunBody = PlanPreviewBody.extend({
  approvals: z.union([z.literal('all'), z.array(z.string().max(300)).max(1000)]).default([]),
  writesConfirmed: z.array(z.string().max(190)).max(50).optional(),
  trigger: z.enum(['MANUAL', 'CLI', 'CI', 'SCHEDULED']).default('MANUAL'),
  environmentId: z.string().optional(),
});

const RunListQuery = z.object({
  projectId: z.string().optional(),
  status: z.string().optional(),
  trigger: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export async function runRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------- plans -------------------------------- */

  app.post('/api/v1/projects/:id/plans/preview', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await prisma.project.findFirst({ where: { id, ownerId: request.auth!.user.id } });
    if (!project) throw notFound('Project');
    const body = PlanPreviewBody.parse(request.body ?? {});
    const prepared = await preparePlan({
      project,
      strategy: body.strategy,
      caseKeys: body.caseKeys,
      forceFull: body.forceFull,
      changedFiles: body.changedFiles,
    });
    return {
      plan: prepared.plan,
      selection: prepared.selection,
      git: prepared.git,
      changedFiles: prepared.changedFiles,
      approvalRequired: prepared.plan.cases
        .filter((c) => c.requiresApproval)
        .map((c) => ({ key: c.key, title: c.title, kind: c.kind })),
      summary: {
        total: prepared.plan.cases.length,
        byKind: prepared.plan.cases.reduce<Record<string, number>>(
          (acc, c) => ({ ...acc, [c.kind]: (acc[c.kind] ?? 0) + 1 }),
          {},
        ),
        requiresApproval: prepared.plan.cases.filter((c) => c.requiresApproval).length,
      },
    };
  });

  app.post('/api/v1/projects/:id/plans', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await prisma.project.findFirst({ where: { id, ownerId: auth.user.id } });
    if (!project) throw notFound('Project');
    const body = PlanPreviewBody.parse(request.body ?? {});
    const prepared = await preparePlan({
      project,
      strategy: body.strategy,
      caseKeys: body.caseKeys,
      forceFull: body.forceFull,
      changedFiles: body.changedFiles,
    });
    const saved = await prisma.testPlan.create({
      data: {
        id: prepared.plan.id,
        projectId: project.id,
        strategy: prepared.plan.strategy.toUpperCase() as 'FULL' | 'CHANGED' | 'SELECTED',
        coverageConfidence: prepared.plan.coverageConfidence,
        planJson: prepared.plan as unknown as object,
        notesJson: prepared.plan.notes,
        unverifiedJson: prepared.plan.unverifiedAreas,
      },
    });
    await audit({
      userId: auth.user.id,
      action: 'PLAN_CREATE',
      entityType: 'test-plan',
      entityId: saved.id,
      metadata: { cases: prepared.plan.cases.length, strategy: prepared.plan.strategy },
      ip: request.ip,
    });
    reply.code(201);
    return { plan: prepared.plan, planId: saved.id, selection: prepared.selection };
  });

  app.get('/api/v1/projects/:id/plans', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.project.findFirstOrThrow({ where: { id, ownerId: request.auth!.user.id } }).catch(() => {
      throw notFound('Project');
    });
    const items = await prisma.testPlan.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      items: items.map((p) => {
        const plan = p.planJson as unknown as TestPlan;
        return {
          id: p.id,
          strategy: p.strategy.toLowerCase(),
          coverageConfidence: p.coverageConfidence,
          caseCount: plan.cases?.length ?? 0,
          cases: plan.cases?.map((c) => ({
            key: c.key,
            title: c.title,
            kind: c.kind,
            requiresApproval: c.requiresApproval,
          })),
          notes: jsonArray(p.notesJson),
          createdAt: p.createdAt.toISOString(),
        };
      }),
    };
  });

  app.get('/api/v1/plans/:planId', { preHandler: authenticate }, async (request) => {
    const { planId } = z.object({ planId: z.string() }).parse(request.params);
    const plan = await prisma.testPlan.findFirst({
      where: { id: planId, project: { ownerId: request.auth!.user.id } },
    });
    if (!plan) throw notFound('Test plan');
    return { plan: plan.planJson };
  });

  /* --------------------------------- runs --------------------------------- */

  app.post('/api/v1/projects/:id/runs', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await prisma.project.findFirst({ where: { id, ownerId: auth.user.id } });
    if (!project) throw notFound('Project');
    const body = RunBody.parse(request.body ?? {});
    if (body.strategy === 'selected' && (!body.caseKeys || body.caseKeys.length === 0)) {
      throw badRequest('Select at least one case for a selected-strategy run.');
    }
    const prepared = await preparePlan({
      project,
      strategy: body.strategy,
      caseKeys: body.caseKeys,
      forceFull: body.forceFull,
      changedFiles: body.changedFiles,
    });
    if (prepared.plan.cases.length === 0) throw badRequest('The plan contains no executable cases.');

    if (activeRuns.size > 0) {
      const sameProject = [...activeRuns.values()].some((r) => r.projectId === project.id);
      if (sameProject)
        throw conflict(
          'A verification run is already in progress for this project. Wait for it to finish or cancel it first.',
        );
    }

    const requiresApproval = prepared.plan.cases.filter((c) => c.requiresApproval).map((c) => c.key);
    const approvedKeys = body.approvals === 'all' ? new Set(requiresApproval) : new Set(body.approvals);
    const missing = requiresApproval.filter((key) => !approvedKeys.has(key));
    if (missing.length > 0) {
      throw conflict('Explicit approval is required for command and mutating checks before they can run.', {
        approvalRequired: prepared.plan.cases
          .filter((c) => missing.includes(c.key))
          .map((c) => ({
            key: c.key,
            title: c.title,
            kind: c.kind,
            reason: c.reason,
            command: c.command ? `${c.command.executable} ${c.command.args.join(' ')}` : undefined,
          })),
      });
    }

    const dbWriteKeys = prepared.plan.cases
      .filter((c) => c.database?.allowWrites)
      .map((c) => c.database!.integrationId);
    const writesConfirmed = new Set(body.writesConfirmed ?? []);
    const missingWrites = dbWriteKeys.filter((integrationId) => !writesConfirmed.has(integrationId));
    if (missingWrites.length > 0) {
      throw conflict('Database write confirmation is required for scenarios with allowWrites enabled.', {
        writesApprovalRequired: missingWrites,
      });
    }

    const { runId, planId } = await startRun({
      project,
      userId: auth.user.id,
      trigger: body.trigger,
      plan: prepared.plan,
      approvals: body.approvals,
      writesConfirmed: body.writesConfirmed,
      ip: request.ip,
    });
    await audit({
      userId: auth.user.id,
      action: 'RUN_START',
      entityType: 'test-run',
      entityId: runId,
      metadata: { planId, cases: prepared.plan.cases.length, strategy: prepared.plan.strategy },
      ip: request.ip,
    });
    reply.code(202);
    return {
      runId,
      planId,
      status: 'running',
      approved: body.approvals === 'all' ? 'all' : body.approvals,
      caseCount: prepared.plan.cases.length,
    };
  });

  app.get('/api/v1/runs', { preHandler: authenticate }, async (request) => {
    const auth = request.auth!;
    const query = RunListQuery.parse(request.query ?? {});
    const { page, pageSize, skip } = parsePagination(query as unknown as Record<string, unknown>, query.pageSize);
    const where = {
      project: { ownerId: auth.user.id },
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: query.status.toUpperCase() as never } : {}),
      ...(query.trigger ? { trigger: query.trigger.toUpperCase() as never } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.testRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip,
        take: pageSize,
        include: { project: { select: { name: true } }, reports: { select: { id: true } } },
      }),
      prisma.testRun.count({ where }),
    ]);
    return {
      items: items.map((r) => ({ ...serializeRun(r), reportId: r.reports[0]?.id ?? null })),
      page,
      pageSize,
      total,
    };
  });

  app.get('/api/v1/runs/:id', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await getRunDetail(id, request.auth!.user.id);
    const reports = await prisma.verificationReport.findMany({
      where: { runId: id },
      select: { id: true, format: true, relativePath: true, sha256: true, generatedAt: true },
    });
    return {
      run: { ...run, reportId: reports[0]?.id ?? null },
      reports: reports.map((r) => ({ ...r, format: r.format.toLowerCase(), generatedAt: r.generatedAt.toISOString() })),
      active: activeRuns.has(id),
    };
  });

  app.get('/api/v1/runs/:id/events', { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await prisma.testRun.findFirst({
      where: { id, project: { ownerId: request.auth!.user.id } },
      include: { project: { select: { name: true } } },
    });
    if (!run) throw notFound('Verification run');

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: unknown) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client disconnected */
      }
    };
    send({
      type: 'snapshot',
      runId: id,
      at: new Date().toISOString(),
      status: run.status.toLowerCase(),
      progress: { completed: 0, total: run.totalCount },
    });
    const unsubscribe = subscribe(id, send);
    const ping = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15_000);
    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    };
    if (!activeRuns.has(id)) {
      send({ type: 'done', runId: id, at: new Date().toISOString(), status: run.status.toLowerCase() });
      cleanup();
      return;
    }
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    return reply;
  });

  app.post('/api/v1/runs/:id/cancel', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await prisma.testRun.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!run) throw notFound('Verification run');
    const cancelled = cancelRun(id, auth.user.id);
    if (!cancelled) throw conflict('This run is not active.');
    return {
      ok: true,
      message: 'Cancellation requested. The run will be marked cancelled after child processes stop.',
    };
  });

  app.delete('/api/v1/runs/:id', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await prisma.testRun.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!run) throw notFound('Verification run');
    if (activeRuns.has(id)) throw conflict('Cannot delete an active run. Cancel it first.');
    await prisma.testRun.delete({ where: { id } });
    return {
      ok: true,
      note: 'Database records were deleted. Evidence files remain in the artifact store until retention cleanup.',
    };
  });

  /* -------------------------------- reports ------------------------------- */

  app.post('/api/v1/runs/:id/reports', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await prisma.testRun.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!run) throw notFound('Verification run');
    if (activeRuns.has(id)) throw conflict('Wait for the run to finish before generating a report.');
    const generated = await generateReport({
      runId: id,
      projectId: run.projectId,
      userId: auth.user.id,
      generatedBy: auth.user.email,
    });
    await audit({
      userId: auth.user.id,
      action: 'REPORT_GENERATE',
      entityType: 'test-run',
      entityId: id,
      metadata: { formats: generated.records.map((r) => r.format) },
      ip: request.ip,
    });
    return {
      verificationId: id,
      manifest: generated.bundle.manifest,
      reports: generated.records.map((r) => ({
        id: r.id,
        format: r.format.toLowerCase(),
        relativePath: r.relativePath,
        sha256: r.sha256,
        generatedAt: r.generatedAt.toISOString(),
      })),
    };
  });

  app.get('/api/v1/runs/:id/report', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ format: z.enum(['html', 'json', 'junit']).default('html') }).parse(request.query ?? {});
    const run = await prisma.testRun.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!run) throw notFound('Verification run');
    const generated = await generateReport({
      runId: id,
      projectId: run.projectId,
      userId: auth.user.id,
      generatedBy: auth.user.email,
    });
    const content = reportContent(generated.bundle, query.format);
    const fileName = `evidence-passport-${id}.${query.format === 'junit' ? 'xml' : query.format}`;
    reply
      .header(
        'content-type',
        query.format === 'html'
          ? 'text/html; charset=utf-8'
          : query.format === 'json'
            ? 'application/json'
            : 'application/xml',
      )
      .header('content-disposition', `inline; filename="${fileName}"`)
      .header('cache-control', 'no-store');
    return reply.send(content);
  });

  app.get('/api/v1/reports/:reportId/download', { preHandler: authenticate }, async (request, reply) => {
    const { reportId } = z.object({ reportId: z.string() }).parse(request.params);
    const report = await prisma.verificationReport.findFirst({
      where: { id: reportId, run: { project: { ownerId: request.auth!.user.id } } },
    });
    if (!report) throw notFound('Report');
    const content = fs.readFileSync(path.join(config.artifactsDir, report.relativePath));
    reply
      .header(
        'content-type',
        report.format === 'HTML'
          ? 'text/html; charset=utf-8'
          : report.format === 'JSON'
            ? 'application/json'
            : 'application/xml',
      )
      .header(
        'content-disposition',
        `attachment; filename="${report.format.toLowerCase()}-${report.runId}.${report.format === 'JUNIT' ? 'xml' : report.format.toLowerCase()}"`,
      );
    return reply.send(content);
  });

  /* -------------------------------- capsules ------------------------------ */

  app.get('/api/v1/runs/:id/capsules', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return { items: await listCapsules(id, request.auth!.user.id) };
  });

  app.post('/api/v1/runs/:id/capsules', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ resultKey: z.string().min(1).max(190) }).parse(request.body);
    const run = await prisma.testRun.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!run) throw notFound('Verification run');
    if (activeRuns.has(id)) throw conflict('Wait for the run to finish before exporting a capsule.');
    const created = await createCapsule({ runId: id, resultKey: body.resultKey, userId: auth.user.id });
    if (!created.existing) {
      await audit({
        userId: auth.user.id,
        action: 'CAPSULE_EXPORT',
        entityType: 'failure-capsule',
        entityId: created.record.id,
        metadata: { runId: id, testKey: body.resultKey },
        ip: request.ip,
      });
      reply.code(201);
    }
    return {
      capsule: created.capsule,
      id: created.record.id,
      sha256: created.record.sha256,
      redactions: created.record.redactions,
      existing: created.existing,
    };
  });

  app.get('/api/v1/capsules/:capsuleId', { preHandler: authenticate }, async (request, reply) => {
    const { capsuleId } = z.object({ capsuleId: z.string() }).parse(request.params);
    const { raw, record } = await readCapsule(capsuleId, request.auth!.user.id);
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="failure-capsule-${record.testKey.replace(/[^a-zA-Z0-9._-]/g, '_')}.json"`,
      );
    return reply.send(raw);
  });

  app.post('/api/v1/capsules/import', { preHandler: authenticate }, async (request) => {
    const body = z.object({ raw: z.string().min(2).max(5_000_000) }).parse(request.body);
    let parsed;
    try {
      parsed = importFailureCapsule(body.raw);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Invalid capsule');
    }
    await audit({
      userId: request.auth!.user.id,
      action: 'CAPSULE_IMPORT',
      entityType: 'failure-capsule',
      metadata: { capsuleId: parsed.capsule.id, testKey: parsed.capsule.test.key },
      ip: request.ip,
    });
    return {
      capsule: parsed.capsule,
      warnings: parsed.warnings,
      note: 'Import validates and displays capsule data. It does not execute commands or modify the project.',
    };
  });
}
