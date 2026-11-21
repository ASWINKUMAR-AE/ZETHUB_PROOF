import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ApiScenarioSchema, BrowserScenarioSchema, IntegrationTypeSchema } from '@zethub/shared-types';
import { testDatabaseConnection } from '@zethub/verification-core';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { authenticate, requireOwner } from '../auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, unavailable } from '../lib/http.js';
import { jsonRecord, toJson } from '../lib/json.js';
import { credentialStore, offlineQueue } from '../services/runs.js';
import { fingerprint } from '../security.js';

const IntegrationBody = z.object({
  projectId: z.string().nullable().optional(),
  type: IntegrationTypeSchema,
  name: z.string().min(1).max(120),
  config: z.record(z.unknown()).default({}),
  secrets: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
});

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/integrations', { preHandler: authenticate }, async (request) => {
    const query = z.object({ projectId: z.string().optional() }).parse(request.query ?? {});
    if (query.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: query.projectId, ownerId: request.auth!.user.id },
      });
      if (!project) throw notFound('Project');
    }
    const items = await prisma.integration.findMany({
      where: {
        ...(query.projectId
          ? { projectId: query.projectId }
          : { OR: [{ projectId: null }, { project: { ownerId: request.auth!.user.id } }] }),
      },
      include: { credentials: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      items: items.map((i) => ({
        id: i.id,
        projectId: i.projectId,
        type: i.type.toLowerCase(),
        name: i.name,
        config: jsonRecord(i.configJson),
        enabled: i.enabled,
        status: i.status,
        lastCheckedAt: i.lastCheckedAt?.toISOString() ?? null,
        credentials: i.credentials.map((c) => ({
          keyName: c.keyName,
          storage: c.storage.toLowerCase(),
          fingerprint: c.fingerprint,
          rotatedAt: c.rotatedAt?.toISOString() ?? null,
        })),
      })),
    };
  });

  app.post('/api/v1/integrations', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireOwner(request);
    const body = IntegrationBody.parse(request.body);
    if (body.projectId) {
      const project = await prisma.project.findFirst({ where: { id: body.projectId, ownerId: auth.user.id } });
      if (!project) throw notFound('Project');
    }
    const existing = await prisma.integration.findFirst({
      where: { projectId: body.projectId ?? null, type: body.type, name: body.name },
    });
    if (existing) throw badRequest('An integration with this type and name already exists.');
    const integration = await prisma.integration.create({
      data: {
        projectId: body.projectId ?? null,
        type: body.type,
        name: body.name,
        configJson: toJson(body.config),
        enabled: body.enabled,
      },
    });
    if (body.secrets) {
      credentialStore.set(`integration:${integration.id}`, body.secrets);
      for (const [keyName, value] of Object.entries(body.secrets)) {
        await prisma.integrationCredentialMeta.create({
          data: { integrationId: integration.id, keyName, storage: 'ENCRYPTED_FILE', fingerprint: fingerprint(value) },
        });
      }
    }
    await audit({
      userId: auth.user.id,
      action: 'INTEGRATION_UPDATE',
      entityType: 'integration',
      entityId: integration.id,
      metadata: { type: body.type, name: body.name, secretKeys: Object.keys(body.secrets ?? {}) },
      ip: request.ip,
    });
    reply.code(201);
    return {
      integration: {
        id: integration.id,
        type: integration.type.toLowerCase(),
        name: integration.name,
        config: body.config,
        enabled: integration.enabled,
      },
    };
  });

  app.patch('/api/v1/integrations/:id', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const existing = await prisma.integration.findFirst({
      where: { id, OR: [{ projectId: null }, { project: { ownerId: auth.user.id } }] },
    });
    if (!existing) throw notFound('Integration');
    const body = IntegrationBody.partial().parse(request.body);
    const updated = await prisma.integration.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.config !== undefined ? { configJson: toJson(body.config) } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
    });
    if (body.secrets) {
      credentialStore.set(`integration:${id}`, body.secrets);
      for (const [keyName, value] of Object.entries(body.secrets)) {
        await prisma.integrationCredentialMeta.upsert({
          where: { integrationId_keyName: { integrationId: id, keyName } },
          create: { integrationId: id, keyName, storage: 'ENCRYPTED_FILE', fingerprint: fingerprint(value) },
          update: { fingerprint: fingerprint(value), rotatedAt: new Date() },
        });
      }
    }
    await audit({
      userId: auth.user.id,
      action: 'INTEGRATION_UPDATE',
      entityType: 'integration',
      entityId: id,
      metadata: { secretKeys: Object.keys(body.secrets ?? {}) },
      ip: request.ip,
    });
    return {
      integration: {
        id: updated.id,
        type: updated.type.toLowerCase(),
        name: updated.name,
        config: jsonRecord(updated.configJson),
        enabled: updated.enabled,
      },
    };
  });

  app.delete('/api/v1/integrations/:id', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const existing = await prisma.integration.findFirst({
      where: { id, OR: [{ projectId: null }, { project: { ownerId: auth.user.id } }] },
    });
    if (!existing) throw notFound('Integration');
    await prisma.integration.delete({ where: { id } });
    credentialStore.delete(`integration:${id}`);
    return { ok: true };
  });

  app.post('/api/v1/integrations/:id/test', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const integration = await prisma.integration.findFirst({
      where: { id, OR: [{ projectId: null }, { project: { ownerId: auth.user.id } }] },
    });
    if (!integration) throw notFound('Integration');
    const cfg = jsonRecord(integration.configJson);
    const secrets = credentialStore.get(`integration:${id}`);
    const started = Date.now();
    let ok = false;
    let message = '';

    if (integration.type === 'DATABASE') {
      const result = await testDatabaseConnection({
        host: String(cfg.host ?? '127.0.0.1'),
        port: Number(cfg.port ?? 3306),
        user: String(cfg.user ?? ''),
        password: secrets.password ?? '',
        database: String(cfg.database ?? ''),
        ssl: Boolean(cfg.ssl),
        connectTimeoutMs: 10_000,
      });
      ok = result.ok;
      message = result.ok
        ? `Connected to ${result.serverType} ${result.serverVersion ?? ''}`
        : (result.error ?? 'Connection failed');
    } else if (integration.type === 'API') {
      const url = String(cfg.url ?? '');
      try {
        const target = new URL(url);
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('API URL must be http(s).');
        const res = await fetch(target, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
        ok = res.status < 500;
        message = `HTTP ${res.status}`;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    } else if (integration.type === 'GIT') {
      const repoPath = String(cfg.path ?? '');
      const repoUrl = String(cfg.url ?? '');
      if (repoPath) {
        ok = fs.existsSync(path.join(repoPath, '.git'));
        message = ok ? 'Local git repository detected.' : 'No .git directory at the configured path.';
      } else if (repoUrl) {
        const result = spawnSync('git', ['ls-remote', '--heads', repoUrl], {
          timeout: 20_000,
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
        });
        ok = result.status === 0;
        message = ok ? 'Remote repository is reachable.' : (result.stderr ?? 'git ls-remote failed').slice(0, 500);
      } else {
        message = 'Configure either a local path or a repository URL.';
      }
    } else if (integration.type === 'GITHUB') {
      const token = secrets.token ?? config.githubToken;
      if (!token) {
        message = 'No GitHub token configured.';
      } else {
        try {
          const res = await fetch('https://api.github.com/user', {
            headers: {
              authorization: `Bearer ${token}`,
              'user-agent': 'ZetHub-Proof',
              accept: 'application/vnd.github+json',
            },
            signal: AbortSignal.timeout(10_000),
          });
          ok = res.ok;
          const body = (await res.json()) as { login?: string; message?: string };
          message = ok ? `Authenticated as ${body.login}` : (body.message ?? `HTTP ${res.status}`);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
      }
    } else if (integration.type === 'AI') {
      message = 'AI providers are validated through the AI status endpoint; no code is sent by this connectivity test.';
      ok = config.ai.enabled && Boolean(config.ai.apiKey);
    } else if (integration.type === 'BROWSER') {
      message = 'Browser adapters are bundled with the verification engine; no external connection is needed.';
      ok = true;
    } else {
      message = 'This integration type has no connectivity test in the local build.';
    }

    const updated = await prisma.integration.update({
      where: { id },
      data: { status: ok ? 'connected' : 'error', lastCheckedAt: new Date() },
    });
    return {
      ok,
      message,
      latencyMs: Date.now() - started,
      status: updated.status,
      lastCheckedAt: updated.lastCheckedAt?.toISOString() ?? null,
    };
  });

  app.get('/api/v1/integrations/github/repos', { preHandler: authenticate }, async (request) => {
    const query = z.object({ integrationId: z.string().optional() }).parse(request.query ?? {});
    let token = config.githubToken;
    if (query.integrationId) {
      const integration = await prisma.integration.findFirst({
        where: {
          id: query.integrationId,
          type: 'GITHUB',
          OR: [{ projectId: null }, { project: { ownerId: request.auth!.user.id } }],
        },
      });
      if (!integration) throw notFound('GitHub integration');
      token = credentialStore.get(`integration:${integration.id}`).token ?? token;
    }
    if (!token) throw unavailable('No GitHub token is configured. Add a GitHub integration with a token first.');
    const res = await fetch('https://api.github.com/user/repos?per_page=50&sort=updated', {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'ZetHub-Proof',
        accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw unavailable(`GitHub returned HTTP ${res.status}.`);
    const repos = (await res.json()) as Array<{
      id: number;
      full_name: string;
      private: boolean;
      clone_url: string;
      default_branch: string;
      updated_at: string;
    }>;
    return {
      items: repos.map((r) => ({
        id: r.id,
        name: r.full_name,
        private: r.private,
        cloneUrl: r.clone_url,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
      })),
    };
  });
}

/* --------------------------------- offline -------------------------------- */

export async function offlineRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/offline/queue', { preHandler: authenticate }, async () => {
    return { stats: offlineQueue.stats(), items: offlineQueue.list().slice(-200) };
  });

  app.post('/api/v1/offline/sync', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const items = offlineQueue.pending();
    if (items.length === 0) return { synced: 0, message: 'The offline queue is empty.' };
    const db = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    if (!db) throw unavailable('The application database is unreachable. Queue items remain pending.');
    for (const item of items) {
      if (item.type === 'audit-event') {
        await prisma.auditLog
          .create({
            data: {
              userId: auth.user.id,
              action: 'SYNC',
              entityType: 'offline-queue',
              entityId: item.id,
              metadata: toJson({ type: item.type, createdAt: item.createdAt, payloadKeys: Object.keys(item.payload) }),
              ip: request.ip,
            },
          })
          .catch(() => undefined);
      }
    }
    offlineQueue.markSynced(items.map((i) => i.id));
    await audit({
      userId: auth.user.id,
      action: 'SYNC',
      entityType: 'offline-queue',
      metadata: { synced: items.length },
      ip: request.ip,
    });
    return {
      synced: items.length,
      message:
        'Queue entries were acknowledged and recorded in the audit log. Payloads remain in the local journal for traceability.',
    };
  });

  app.get('/api/v1/sync/queue', { preHandler: authenticate }, async (request) => {
    const items = await prisma.syncQueue.findMany({
      where: { userId: request.auth!.user.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      items: items.map((i) => ({
        id: i.id,
        clientId: i.clientId,
        type: i.type,
        status: i.status.toLowerCase(),
        attempts: i.attempts,
        lastError: i.lastError,
        createdAt: i.createdAt.toISOString(),
        syncedAt: i.syncedAt?.toISOString() ?? null,
      })),
      limitations: [
        'Remote/multi-device sync is not implemented in this local-only build. The queue stores records for inspection and future transport.',
      ],
    };
  });

  app.post('/api/v1/sync/push', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const body = z
      .object({
        clientId: z.string().min(1).max(120),
        items: z
          .array(
            z.object({
              type: z.string().min(1).max(60),
              payload: z.record(z.unknown()),
              idempotencyKey: z.string().min(1).max(190),
            }),
          )
          .min(1)
          .max(100),
      })
      .parse(request.body);
    let accepted = 0;
    for (const item of body.items) {
      const existing = await prisma.syncQueue.findUnique({ where: { idempotencyKey: item.idempotencyKey } });
      if (existing) continue;
      await prisma.syncQueue.create({
        data: {
          userId: auth.user.id,
          clientId: body.clientId,
          type: item.type,
          payloadJson: toJson(item.payload),
          idempotencyKey: item.idempotencyKey,
        },
      });
      accepted += 1;
    }
    await audit({
      userId: auth.user.id,
      action: 'SYNC',
      entityType: 'sync-queue',
      metadata: { accepted, total: body.items.length },
      ip: request.ip,
    });
    return {
      accepted,
      duplicates: body.items.length - accepted,
      note: 'Items are stored locally. No remote endpoint is contacted in this build.',
    };
  });
}

/* ------------------------------------ AI ---------------------------------- */

interface AiConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

function aiConfig(): AiConfig {
  if (!config.ai.enabled)
    throw unavailable('AI features are disabled. Set AI_ENABLED=true and configure a provider, model and API key.');
  if (!config.ai.provider || !config.ai.model || !config.ai.apiKey) {
    throw unavailable('AI is enabled but provider, model or API key is missing.');
  }
  return {
    provider: config.ai.provider.toLowerCase(),
    model: config.ai.model,
    apiKey: config.ai.apiKey,
    baseUrl:
      config.ai.baseUrl ??
      (config.ai.provider.toLowerCase() === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'),
  };
}

async function callAi(messages: Array<{ role: 'system' | 'user'; content: string }>, ai: AiConfig): Promise<string> {
  if (ai.provider === 'anthropic') {
    const system = messages.find((m) => m.role === 'system')?.content;
    const rest = messages.filter((m) => m.role !== 'system');
    const res = await fetch(`${ai.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ai.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ai.model, max_tokens: 2000, messages: rest, ...(system ? { system } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw unavailable(`AI provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return body.content?.map((c) => c.text ?? '').join('') ?? '';
  }
  const res = await fetch(`${ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ai.apiKey}` },
    body: JSON.stringify({ model: ai.model, temperature: 0.2, messages }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw unavailable(`AI provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? '';
}

function jsonExtract(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw badRequest('The AI response did not contain a JSON object.');
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/ai/status', { preHandler: authenticate }, async () => ({
    enabled: config.ai.enabled,
    configured: Boolean(config.ai.enabled && config.ai.provider && config.ai.model && config.ai.apiKey),
    provider: config.ai.provider,
    model: config.ai.model,
    consentSendCode: config.ai.consentSendCode,
    note: 'AI is optional. It never runs automatically; every generated scenario or patch is returned for review and must be saved or applied explicitly.',
  }));

  app.post('/api/v1/projects/:id/ai/suggest', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        objective: z.string().min(5).max(2000),
        kind: z.enum(['browser', 'api']).default('browser'),
        consentSendCode: z.boolean().default(false),
      })
      .parse(request.body);
    const project = await prisma.project.findFirst({ where: { id, ownerId: auth.user.id } });
    if (!project) throw notFound('Project');
    const ai = aiConfig();
    const includeCode = body.consentSendCode && config.ai.consentSendCode;
    let context = `Project: ${project.name}\nWebsite: ${project.websiteUrl ?? '(none)'}\n`;
    if (project.rootPath && includeCode) {
      const packageJson = path.join(project.rootPath, 'package.json');
      if (fs.existsSync(packageJson) && fs.statSync(packageJson).size < 100_000) {
        context += `package.json:\n${fs.readFileSync(packageJson, 'utf8')}\n`;
      }
      const detection = project.detectionJson as { manifests?: string[]; testTools?: string[] } | null;
      context += `Manifests: ${(detection?.manifests ?? []).slice(0, 20).join(', ')}\n`;
    } else {
      context += 'Source code is not being shared. Generate from the stated objective only.\n';
    }
    const schemaHint =
      body.kind === 'browser'
        ? '{"name":"...","startUrl":"https://...","browser":"chromium","viewport":{"width":1440,"height":900},"timeoutMs":60000,"trace":true,"steps":[{"action":"goto","path":"/"},{"action":"expectVisible","locator":{"strategy":"role","role":"heading","value":"Welcome"}}],"tags":[]}'
        : '{"name":"...","baseUrl":"https://...","request":{"method":"GET","url":"/health","headers":[],"bodyType":"none","timeoutMs":15000,"allowMutation":false},"expectations":[{"type":"status","equals":200}],"tags":[]}';
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      {
        role: 'system',
        content: `You generate a single ${body.kind === 'browser' ? 'browser' : 'API'} verification scenario as strict JSON. Use only the documented step actions. Never invent credentials, never include secrets, and never use destructive requests. Respond with JSON only.`,
      },
      {
        role: 'user',
        content: `${context}\nObjective: ${body.objective}\n\nReturn JSON matching this shape:\n${schemaHint}`,
      },
    ];
    const raw = await callAi(messages, ai);
    const parsed = jsonExtract(raw);
    const validation =
      body.kind === 'browser' ? BrowserScenarioSchema.safeParse(parsed) : ApiScenarioSchema.safeParse(parsed);
    if (!validation.success) {
      throw badRequest(`The AI response was not a valid ${body.kind} scenario. Nothing was saved.`, {
        issues: validation.error.issues,
        raw: raw.slice(0, 4000),
      });
    }
    await audit({
      userId: auth.user.id,
      action: 'PLAN_CREATE',
      entityType: 'ai-suggestion',
      entityId: project.id,
      metadata: { kind: body.kind, sentCode: includeCode, provider: ai.provider },
      ip: request.ip,
    });
    return {
      kind: body.kind,
      scenario: validation.data,
      validated: true,
      sentCode: includeCode,
      note: 'Review this suggestion and save it as a test case explicitly. AI output is not trusted evidence.',
      raw: raw.slice(0, 20_000),
    };
  });

  app.post('/api/v1/repairs/:id/ai-suggest', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const repair = await prisma.repairProposal.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!repair) throw notFound('Repair proposal');
    const ai = aiConfig();
    const run = await prisma.testRun.findFirst({ where: { id: repair.runId }, include: { results: true } });
    const result = run?.results.find((r) => r.key === repair.testKey);
    const prompt = [
      `Failure classification: ${repair.classification}`,
      `Test: ${repair.testKey}`,
      `Message: ${(result?.message ?? '').slice(0, 2000)}`,
      `stderr: ${(result?.stderr ?? '').slice(0, 4000)}`,
      `stdout: ${(result?.stdout ?? '').slice(0, 2000)}`,
      'Produce a minimal unified diff that addresses the most plausible cause. Return JSON {"diff":"...","explanation":"..."} only. Never include secrets or unrelated refactors.',
    ].join('\n');
    const raw = await callAi(
      [
        { role: 'system', content: 'You are a careful software engineer. Return only JSON.' },
        { role: 'user', content: prompt },
      ],
      ai,
    );
    const parsed = jsonExtract(raw) as { diff?: string; explanation?: string };
    if (typeof parsed.diff !== 'string') throw badRequest('The AI response did not include a diff.');
    return {
      diff: parsed.diff,
      explanation: parsed.explanation ?? '',
      note: 'Review and validate the patch before saving it as a repair proposal.',
    };
  });
}
