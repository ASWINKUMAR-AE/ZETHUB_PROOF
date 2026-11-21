import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Project } from '@prisma/client';
import { detectProject, validateProjectPath, isInsideRoot } from '@zethub/verification-core';
import { ProjectEnvironmentInputSchema, ProjectInputSchema, TestCaseInputSchema } from '@zethub/shared-types';
import { prisma } from '../db.js';
import { config, paths } from '../config.js';
import { authenticate, requireOwner } from '../auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { jsonArray, jsonRecord, toJson } from '../lib/json.js';
import { credentialStore } from '../services/runs.js';
import { scenarioFromBody, assertWebsiteUrl } from '../services/plan.js';

const ProjectQuery = z.object({
  search: z.string().max(200).optional(),
  archived: z.enum(['true', 'false', 'all']).default('false'),
  pinned: z.enum(['true', 'false']).optional(),
  sort: z.enum(['recent', 'name', 'health']).default('recent'),
});

const EnvironmentBody = ProjectEnvironmentInputSchema;
const CasePatch = z.object({
  title: z.string().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  reason: z.string().max(4000).optional(),
});

export function serializeProject(project: Project) {
  const detection = project.detectionJson as Record<string, unknown> | null;
  const ecosystems = Array.isArray(detection?.ecosystems)
    ? (detection?.ecosystems as Array<Record<string, unknown>>).slice(0, 8).map((e) => ({
        language: String(e.language ?? 'unknown'),
        framework: e.framework ? String(e.framework) : undefined,
        confidence: String(e.confidence ?? 'low'),
      }))
    : [];
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    sourceType: project.sourceType.toLowerCase(),
    rootPath: project.rootPath,
    repoUrl: project.repoUrl,
    websiteUrl: project.websiteUrl,
    defaultBranch: project.defaultBranch,
    pinned: project.pinned,
    archived: project.archived,
    health: project.health.toLowerCase(),
    lastVerifiedAt: project.lastVerifiedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    scanned: Boolean(project.detectionJson),
    ecosystems,
  };
}

async function findProject(userId: string, projectId: string): Promise<Project> {
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
  if (!project) throw notFound('Project');
  return project;
}

function assertLocalRoot(rootPath: string | null | undefined): string {
  if (!rootPath) throw badRequest('A local folder path is required for this project.');
  let normalized: string;
  try {
    normalized = path.resolve(validateProjectPath(rootPath));
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Invalid project path.');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalized);
  } catch {
    throw badRequest(`Folder not found: ${normalized}`);
  }
  if (!stat.isDirectory()) throw badRequest('The project path must be a directory.');
  return normalized;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

const SAFE_GIT_URL = /^(https:\/\/|ssh:\/\/|git@[A-Za-z0-9._-]+:)/;

function cloneRepository(repoUrl: string, name: string): string {
  if (!SAFE_GIT_URL.test(repoUrl))
    throw badRequest('Only https://, ssh:// or git@host:path repository URLs are supported.');
  const workspaceRoot = path.join(paths.root, 'workspaces');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const target = path.join(workspaceRoot, `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`);
  const result = spawnSync('git', ['clone', '--depth', '50', '--no-tags', repoUrl, target], {
    cwd: workspaceRoot,
    timeout: 180_000,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw badRequest(`Git clone failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw badRequest(`Git clone failed (exit ${result.status}): ${(result.stderr ?? '').slice(0, 1500)}`);
  }
  return target;
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/projects', { preHandler: authenticate }, async (request) => {
    const auth = request.auth!;
    const query = ProjectQuery.parse(request.query ?? {});
    const where = {
      ownerId: auth.user.id,
      ...(query.archived === 'all' ? {} : { archived: query.archived === 'true' }),
      ...(query.pinned ? { pinned: query.pinned === 'true' } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search } },
              { description: { contains: query.search } },
              { rootPath: { contains: query.search } },
            ],
          }
        : {}),
    };
    const projects = await prisma.project.findMany({
      where,
      orderBy:
        query.sort === 'name'
          ? [{ name: 'asc' }]
          : query.sort === 'health'
            ? [{ health: 'asc' }, { updatedAt: 'desc' }]
            : [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      include: {
        _count: { select: { runs: true, cases: true, environments: true } },
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { id: true, status: true, startedAt: true, passedCount: true, totalCount: true },
        },
      },
    });
    return {
      items: projects.map((p) => ({
        ...serializeProject(p),
        counts: { runs: p._count.runs, cases: p._count.cases, environments: p._count.environments },
        lastRun: p.runs[0]
          ? {
              id: p.runs[0].id,
              status: p.runs[0].status.toLowerCase(),
              startedAt: p.runs[0].startedAt.toISOString(),
              passed: p.runs[0].passedCount,
              total: p.runs[0].totalCount,
            }
          : null,
      })),
      total: projects.length,
    };
  });

  app.post('/api/v1/projects', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireOwner(request);
    const body = ProjectInputSchema.parse(request.body);
    if (body.websiteUrl) assertWebsiteUrl(body.websiteUrl);
    const duplicate = await prisma.project.findFirst({ where: { ownerId: auth.user.id, name: body.name } });
    if (duplicate) throw conflict('A project with this name already exists.');

    let rootPath: string | null = null;
    const repoUrl: string | null = body.repoUrl ?? null;
    if (body.sourceType === 'LOCAL') {
      rootPath = assertLocalRoot(body.rootPath);
    } else if (body.sourceType === 'GIT') {
      if (body.rootPath) {
        rootPath = assertLocalRoot(body.rootPath);
        if (!fs.existsSync(path.join(rootPath, '.git')))
          throw badRequest('The selected folder is not a Git repository.');
      } else if (repoUrl) {
        rootPath = cloneRepository(repoUrl, body.name);
      } else {
        throw badRequest('Provide an existing repository folder or a Git URL to clone.');
      }
    } else if (body.sourceType === 'URL') {
      if (!body.websiteUrl) throw badRequest('A website URL is required for URL projects.');
    }

    const project = await prisma.project.create({
      data: {
        ownerId: auth.user.id,
        name: body.name,
        description: body.description ?? null,
        sourceType: body.sourceType,
        rootPath,
        repoUrl,
        websiteUrl: body.websiteUrl ?? null,
        defaultBranch: body.defaultBranch ?? null,
      },
    });
    await prisma.projectEnvironment.create({
      data: {
        projectId: project.id,
        name: 'Local',
        kind: 'LOCAL',
        baseUrl: body.websiteUrl ?? null,
        isDefault: true,
        variables: toJson({}),
      },
    });
    await audit({
      userId: auth.user.id,
      action: 'PROJECT_CREATE',
      entityType: 'project',
      entityId: project.id,
      metadata: { name: project.name, sourceType: project.sourceType },
      ip: request.ip,
    });
    reply.code(201);
    return { project: serializeProject(project) };
  });

  app.get('/api/v1/projects/:id', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await findProject(request.auth!.user.id, id);
    const [environments, cases, runs, integrations, detection] = await Promise.all([
      prisma.projectEnvironment.findMany({
        where: { projectId: id },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
      prisma.testCase.findMany({ where: { projectId: id }, orderBy: [{ kind: 'asc' }, { priority: 'desc' }] }),
      prisma.testRun.findMany({ where: { projectId: id }, orderBy: { startedAt: 'desc' }, take: 8 }),
      prisma.integration.findMany({ where: { projectId: id }, orderBy: { createdAt: 'asc' } }),
      Promise.resolve(project.detectionJson as unknown),
    ]);
    return {
      project: serializeProject(project),
      detection,
      environments: environments.map((e) => ({
        id: e.id,
        name: e.name,
        kind: e.kind.toLowerCase(),
        baseUrl: e.baseUrl,
        variables: jsonRecord(e.variables),
        secretKeys: credentialStore.keys(`project-env:${e.id}`),
        isDefault: e.isDefault,
        createdAt: e.createdAt.toISOString(),
      })),
      cases: cases.map(serializeCase),
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status.toLowerCase(),
        strategy: r.strategy.toLowerCase(),
        trigger: r.trigger.toLowerCase(),
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        counts: {
          total: r.totalCount,
          passed: r.passedCount,
          failed: r.failedCount,
          blocked: r.blockedCount,
          unverified: r.unverifiedCount,
        },
      })),
      integrations: integrations.map((i) => ({
        id: i.id,
        type: i.type.toLowerCase(),
        name: i.name,
        enabled: i.enabled,
        status: i.status,
      })),
    };
  });

  app.patch('/api/v1/projects/:id', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await findProject(auth.user.id, id);
    const body = ProjectInputSchema.partial()
      .extend({
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .parse(request.body);
    if (body.websiteUrl) assertWebsiteUrl(body.websiteUrl);
    if (body.rootPath) assertLocalRoot(body.rootPath);
    const project = await prisma.project.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.rootPath !== undefined ? { rootPath: body.rootPath ? path.resolve(body.rootPath) : null } : {}),
        ...(body.repoUrl !== undefined ? { repoUrl: body.repoUrl } : {}),
        ...(body.websiteUrl !== undefined ? { websiteUrl: body.websiteUrl } : {}),
        ...(body.defaultBranch !== undefined ? { defaultBranch: body.defaultBranch } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
        ...(body.archived !== undefined ? { archived: body.archived } : {}),
      },
    });
    await audit({
      userId: auth.user.id,
      action: 'PROJECT_UPDATE',
      entityType: 'project',
      entityId: id,
      metadata: { fields: Object.keys(body) },
      ip: request.ip,
    });
    return { project: serializeProject(project) };
  });

  app.delete('/api/v1/projects/:id', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await findProject(auth.user.id, id);
    await prisma.project.delete({ where: { id } });
    await audit({
      userId: auth.user.id,
      action: 'PROJECT_DELETE',
      entityType: 'project',
      entityId: id,
      metadata: { name: project.name, sourcePreserved: true },
      ip: request.ip,
    });
    return {
      ok: true,
      sourcePreserved: true,
      note: 'Project records and evidence metadata were removed. Source files and cloned workspaces were left on disk.',
    };
  });

  app.post('/api/v1/projects/:id/scan', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await findProject(auth.user.id, id);
    if (!project.rootPath) {
      if (project.sourceType === 'URL') {
        let reachable = false;
        let status: number | null = null;
        let note = 'The site was not reachable.';
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          const res = await fetch(project.websiteUrl!, {
            method: 'HEAD',
            signal: controller.signal,
            redirect: 'follow',
          });
          clearTimeout(timer);
          reachable = res.ok || res.status < 500;
          status = res.status;
          note = `HTTP ${res.status} from ${res.url}`;
        } catch (error) {
          note = error instanceof Error ? error.message : String(error);
        }
        const detection = {
          rootPath: '',
          scannedAt: new Date().toISOString(),
          ecosystems: [],
          packageManagers: [],
          manifests: [],
          lockfiles: [],
          testTools: [],
          buildTools: [],
          tools: [],
          isMonorepo: false,
          subprojects: [],
          docker: { detected: false, files: [] },
          database: { detected: false, engines: [], configFiles: [], migrationDirs: [] },
          api: { detected: false, specFiles: [] },
          git: { isRepo: false },
          runtime: {},
          warnings: [
            `URL project: no local source is attached. Site probe: ${note}`,
            'Local command detection is unavailable for URL-only projects. Add browser/API scenarios to verify the site.',
          ],
          unsupported: ['local-command-execution'],
        };
        await prisma.project.update({ where: { id }, data: { detectionJson: toJson(detection) } });
        await audit({
          userId: auth.user.id,
          action: 'SCAN',
          entityType: 'project',
          entityId: id,
          metadata: { mode: 'url-probe', reachable, status },
          ip: request.ip,
        });
        return { detection, reachable, status };
      }
      throw badRequest('Attach a local folder to this project before scanning.');
    }
    if (!fs.existsSync(project.rootPath)) throw badRequest(`Project folder no longer exists: ${project.rootPath}`);
    const detection = detectProject(project.rootPath, { probeTools: true });
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id },
        data: { detectionJson: toJson(detection), health: 'UNKNOWN', lastVerifiedAt: null },
      });
      for (const tool of detection.tools) {
        await tx.projectAdapter.upsert({
          where: { projectId_adapterId: { projectId: id, adapterId: tool.id } },
          create: {
            projectId: id,
            adapterId: tool.id,
            version: tool.version ?? 'detected',
            enabled: tool.available,
            configJson: toJson({
              kind: tool.kind,
              name: tool.name,
              available: tool.available,
              reason: tool.reason ?? null,
            }),
          },
          update: { version: tool.version ?? 'detected', enabled: tool.available, detectedAt: new Date() },
        });
      }
    });
    await audit({
      userId: auth.user.id,
      action: 'SCAN',
      entityType: 'project',
      entityId: id,
      metadata: { ecosystems: detection.ecosystems.map((e) => e.language), warnings: detection.warnings.length },
      ip: request.ip,
    });
    return { detection };
  });

  app.get('/api/v1/projects/:id/detection', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await findProject(request.auth!.user.id, id);
    if (!project.detectionJson) throw notFound('Detection result');
    return { detection: project.detectionJson };
  });

  /* ----------------------------- environments ----------------------------- */

  app.get('/api/v1/projects/:id/environments', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await findProject(request.auth!.user.id, id);
    const items = await prisma.projectEnvironment.findMany({
      where: { projectId: id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return {
      items: items.map((e) => ({
        ...e,
        kind: e.kind.toLowerCase(),
        secretKeys: credentialStore.keys(`project-env:${e.id}`),
        variables: jsonRecord(e.variables),
      })),
    };
  });

  app.post('/api/v1/projects/:id/environments', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await findProject(auth.user.id, id);
    const body = EnvironmentBody.parse(request.body);
    if (body.baseUrl) assertWebsiteUrl(body.baseUrl);
    const existing = await prisma.projectEnvironment.findUnique({
      where: { projectId_name: { projectId: id, name: body.name } },
    });
    if (existing) throw conflict('An environment with this name already exists.');
    const env = await prisma.projectEnvironment.create({
      data: {
        projectId: id,
        name: body.name,
        kind: body.kind,
        baseUrl: body.baseUrl ?? null,
        variables: toJson(body.variables ?? {}),
        isDefault: body.isDefault ?? false,
      },
    });
    if (body.isDefault) {
      await prisma.projectEnvironment.updateMany({
        where: { projectId: id, id: { not: env.id } },
        data: { isDefault: false },
      });
    }
    if (body.secrets && Object.keys(body.secrets).length > 0)
      credentialStore.set(`project-env:${env.id}`, body.secrets);
    reply.code(201);
    return {
      environment: {
        ...env,
        kind: env.kind.toLowerCase(),
        variables: jsonRecord(env.variables),
        secretKeys: credentialStore.keys(`project-env:${env.id}`),
      },
    };
  });

  app.patch('/api/v1/projects/:id/environments/:envId', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id, envId } = z.object({ id: z.string(), envId: z.string() }).parse(request.params);
    await findProject(auth.user.id, id);
    const body = EnvironmentBody.partial().parse(request.body);
    if (body.baseUrl) assertWebsiteUrl(body.baseUrl);
    const env = await prisma.projectEnvironment.findFirst({ where: { id: envId, projectId: id } });
    if (!env) throw notFound('Environment');
    if (body.name && body.name !== env.name) {
      const dup = await prisma.projectEnvironment.findUnique({
        where: { projectId_name: { projectId: id, name: body.name } },
      });
      if (dup) throw conflict('An environment with this name already exists.');
    }
    const updated = await prisma.projectEnvironment.update({
      where: { id: envId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.variables !== undefined ? { variables: toJson(body.variables) } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      },
    });
    if (body.isDefault) {
      await prisma.projectEnvironment.updateMany({
        where: { projectId: id, id: { not: envId } },
        data: { isDefault: false },
      });
    }
    if (body.secrets && Object.keys(body.secrets).length > 0) credentialStore.set(`project-env:${envId}`, body.secrets);
    return {
      environment: {
        ...updated,
        kind: updated.kind.toLowerCase(),
        variables: jsonRecord(updated.variables),
        secretKeys: credentialStore.keys(`project-env:${envId}`),
      },
    };
  });

  app.delete('/api/v1/projects/:id/environments/:envId', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id, envId } = z.object({ id: z.string(), envId: z.string() }).parse(request.params);
    await findProject(auth.user.id, id);
    const env = await prisma.projectEnvironment.findFirst({ where: { id: envId, projectId: id } });
    if (!env) throw notFound('Environment');
    const count = await prisma.projectEnvironment.count({ where: { projectId: id } });
    if (count <= 1) throw badRequest('Keep at least one environment for this project.');
    await prisma.projectEnvironment.delete({ where: { id: envId } });
    credentialStore.delete(`project-env:${envId}`);
    return { ok: true };
  });

  app.delete('/api/v1/projects/:id/environments/:envId/secrets/:key', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id, envId, key } = z.object({ id: z.string(), envId: z.string(), key: z.string() }).parse(request.params);
    await findProject(auth.user.id, id);
    const env = await prisma.projectEnvironment.findFirst({ where: { id: envId, projectId: id } });
    if (!env) throw notFound('Environment');
    const values = credentialStore.get(`project-env:${envId}`);
    delete values[key];
    credentialStore.set(`project-env:${envId}`, values);
    return { ok: true };
  });

  /* ------------------------------- test cases ------------------------------ */

  app.get('/api/v1/projects/:id/cases', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await findProject(request.auth!.user.id, id);
    const items = await prisma.testCase.findMany({
      where: { projectId: id },
      orderBy: [{ kind: 'asc' }, { priority: 'desc' }],
    });
    return { items: items.map(serializeCase) };
  });

  app.post('/api/v1/projects/:id/cases', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await findProject(auth.user.id, id);
    const body = TestCaseInputSchema.parse(request.body);
    const existing = await prisma.testCase.findUnique({ where: { projectId_key: { projectId: id, key: body.key } } });
    if (existing) throw conflict('A test case with this key already exists.');
    let config: Record<string, unknown> = {};
    let adapterId = 'user-command';
    let requiresApproval = true;
    if (body.kind === 'browser' || body.kind === 'api' || body.kind === 'database') {
      const mapped = scenarioFromBody(body.kind, body.scenario);
      config = { scenario: mapped.scenario };
      adapterId = mapped.adapterId;
      requiresApproval = mapped.requiresApproval;
    } else {
      if (!body.command) throw badRequest('A command is required for command-based cases.');
      config = { command: body.command, timeoutMs: body.timeoutMs };
    }
    const testCase = await prisma.testCase.create({
      data: {
        projectId: id,
        key: body.key,
        title: body.title,
        kind: body.kind,
        adapterId,
        source: 'USER',
        reason: body.reason ?? 'User-configured check.',
        configJson: toJson(config),
        requiresApproval,
        mappedFiles: toJson(body.mappedFiles ?? []),
        tags: toJson(body.tags ?? []),
        priority: body.priority,
      },
    });
    await audit({
      userId: auth.user.id,
      action: 'PLAN_CREATE',
      entityType: 'test-case',
      entityId: testCase.id,
      metadata: { key: body.key, kind: body.kind },
      ip: request.ip,
    });
    reply.code(201);
    return { case: serializeCase(testCase) };
  });

  app.patch('/api/v1/projects/:id/cases/:caseId', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id, caseId } = z.object({ id: z.string(), caseId: z.string() }).parse(request.params);
    await findProject(auth.user.id, id);
    const body = CasePatch.parse(request.body);
    const existing = await prisma.testCase.findFirst({ where: { id: caseId, projectId: id } });
    if (!existing) throw notFound('Test case');
    const updated = await prisma.testCase.update({
      where: { id: caseId },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      },
    });
    return { case: serializeCase(updated) };
  });

  app.delete('/api/v1/projects/:id/cases/:caseId', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id, caseId } = z.object({ id: z.string(), caseId: z.string() }).parse(request.params);
    await findProject(auth.user.id, id);
    const existing = await prisma.testCase.findFirst({ where: { id: caseId, projectId: id } });
    if (!existing) throw notFound('Test case');
    if (existing.source === 'DETECTED')
      throw forbidden('Detected cases regenerate from a scan. Disable the case instead of deleting it.');
    await prisma.testCase.delete({ where: { id: caseId } });
    return { ok: true };
  });

  /* --------------------------------- git ---------------------------------- */

  app.get('/api/v1/projects/:id/git', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await findProject(request.auth!.user.id, id);
    if (!project.rootPath) return { available: false, reason: 'No local folder attached.' };
    const git = (args: string[]) =>
      spawnSync('git', args, {
        cwd: project.rootPath!,
        timeout: 12_000,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
      });
    if (!fs.existsSync(path.join(project.rootPath, '.git')))
      return { available: false, reason: 'Not a git repository.' };
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const commit = git(['rev-parse', 'HEAD']);
    const status = git(['status', '--porcelain']);
    const diff = git(['diff', '--stat']);
    const log = git(['log', '-5', '--pretty=format:%h|%an|%s|%aI']);
    const changedFiles = (status.stdout ?? '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return {
      available: true,
      branch: branch.stdout?.trim() || null,
      commit: commit.stdout?.trim() || null,
      dirty: changedFiles.length > 0,
      changedFiles,
      diffStat: diff.stdout?.trim() || '',
      commits: (log.stdout ?? '')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [hash, author, subject, date] = line.split('|');
          return { hash, author, subject, date };
        }),
    };
  });

  app.get('/api/v1/projects/:id/git/diff', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await findProject(request.auth!.user.id, id);
    if (!project.rootPath || !fs.existsSync(path.join(project.rootPath, '.git')))
      throw badRequest('This project is not a git repository.');
    const result = spawnSync('git', ['diff', '--unified=3'], {
      cwd: project.rootPath,
      timeout: 20_000,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { diff: (result.stdout ?? '').slice(0, 200_000) };
  });

  /* ------------------------------- file system ----------------------------- */

  app.get('/api/v1/fs/roots', { preHandler: authenticate }, async () => {
    const roots: Array<{ label: string; path: string; kind: 'workspace' | 'home' | 'drive' }> = [];
    for (const ws of config.workspaceRoots)
      if (fs.existsSync(ws)) roots.push({ label: path.basename(ws) || ws, path: path.resolve(ws), kind: 'workspace' });
    if (!roots.some((r) => r.path === os.homedir())) roots.push({ label: 'Home', path: os.homedir(), kind: 'home' });
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${letter}:\\`;
        if (fs.existsSync(drive)) roots.push({ label: drive, path: drive, kind: 'drive' });
      }
    }
    return { roots: dedupeByPath(roots) };
  });

  app.get('/api/v1/fs/list', { preHandler: authenticate }, async (request) => {
    const query = z
      .object({ path: z.string().max(1024).optional(), showHidden: z.enum(['true', 'false']).default('false') })
      .parse(request.query ?? {});
    const target = query.path ? path.resolve(validateProjectPath(query.path)) : os.homedir();
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      throw badRequest(`Folder not found: ${target}`);
    }
    if (!stat.isDirectory()) throw badRequest('The selected path is not a directory.');
    const showHidden = query.showHidden === 'true';
    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .filter((e) => showHidden || (!e.name.startsWith('.') && !/^\$|^System Volume Information$/i.test(e.name)))
      .slice(0, 500)
      .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(target);
    return {
      path: target,
      parent: isInsideRoot(path.parse(target).root, parent) && parent !== target ? parent : null,
      entries,
      drives:
        process.platform === 'win32'
          ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'
              .split('')
              .map((l) => `${l}:\\`)
              .filter((d) => fs.existsSync(d))
          : ['/'],
    };
  });

  app.get('/api/v1/fs/validate', { preHandler: authenticate }, async (request) => {
    const query = z.object({ path: z.string().min(1).max(1024) }).parse(request.query ?? {});
    const resolved = path.resolve(validateProjectPath(query.path));
    try {
      const stat = fs.statSync(resolved);
      return { valid: stat.isDirectory(), path: resolved, isGitRepo: fs.existsSync(path.join(resolved, '.git')) };
    } catch {
      return { valid: false, path: resolved, isGitRepo: false };
    }
  });
}

function dedupeByPath<T extends { path: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function serializeCase(testCase: {
  id: string;
  key: string;
  title: string;
  kind: string;
  adapterId: string;
  source: string;
  reason: string | null;
  configJson: unknown;
  enabled: boolean;
  requiresApproval: boolean;
  mappedFiles: unknown;
  tags: unknown;
  priority: number;
  updatedAt: Date;
}) {
  return {
    id: testCase.id,
    key: testCase.key,
    title: testCase.title,
    kind: testCase.kind,
    adapterId: testCase.adapterId,
    source: testCase.source.toLowerCase(),
    reason: testCase.reason,
    config: jsonRecord(testCase.configJson),
    enabled: testCase.enabled,
    requiresApproval: testCase.requiresApproval,
    mappedFiles: jsonArray(testCase.mappedFiles),
    tags: jsonArray(testCase.tags),
    priority: testCase.priority,
    updatedAt: testCase.updatedAt.toISOString(),
  };
}

/** Shared helper for routes that accept a pre-selected environment. */
export async function resolveEnvironment(projectId: string, environmentId?: string | null) {
  if (environmentId) {
    return prisma.projectEnvironment.findFirst({ where: { id: environmentId, projectId } });
  }
  return prisma.projectEnvironment.findFirst({
    where: { projectId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
}
