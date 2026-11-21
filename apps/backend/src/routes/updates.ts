import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  UpdateArchSchema,
  UpdateChannelSchema,
  UpdatePlatformSchema,
  UpdateReleasePayloadSchema,
} from '@zethub/shared-types';
import { compareVersions, publishUpdate, resolveArtifactFile, updateReleaseState } from '@zethub/verification-core';
import { authenticate, requireOwner } from '../auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/http.js';
import { config } from '../config.js';
import {
  adminReleases,
  cancelDownload,
  checkForUpdates,
  currentArch,
  currentPlatform,
  findPublishedRelease,
  getDownloadJob,
  installStaged,
  latestFor,
  readUpdateEvents,
  releaseView,
  removeStaged,
  stagedReleases,
  startDownload,
  updateKeyId,
  updatePrivateKey,
  updatePublicKey,
  updateStorageDir,
  updateSystemStatus,
  verifiedPublishedReleases,
} from '../services/updates.js';

const TargetParams = z.object({
  platform: UpdatePlatformSchema,
  arch: UpdateArchSchema,
  channel: UpdateChannelSchema,
});

const ReleaseParams = z.object({
  version: z.string().min(1).max(64),
});

const IdParams = z.object({ id: z.string().min(1).max(200) });

const PublishBody = UpdateReleasePayloadSchema.pick({
  version: true,
  channel: true,
  platform: true,
  arch: true,
  notes: true,
}).extend({
  artifactPath: z.string().min(1).max(2048),
  format: z.enum(['nsis', 'msi', 'appimage', 'deb', 'rpm', 'portable']),
  mandatory: z.boolean().default(false),
  minimumSupportedVersion: z.string().max(64).nullable().default(null),
  minimumOsVersion: z.string().max(120).nullable().default(null),
  rolloutPercent: z.number().int().min(0).max(100).default(100),
  draft: z.boolean().default(false),
});

const StateBody = z
  .object({
    paused: z.boolean().optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
  })
  .refine((value) => value.paused !== undefined || value.rolloutPercent !== undefined, {
    message: 'Provide paused and/or rolloutPercent.',
  });

const DownloadBody = z.object({ releaseId: z.string().min(1).max(200) });
const InstallBody = z.object({ releaseId: z.string().min(1).max(200), consent: z.literal(true) });
const CheckQuery = z.object({
  channel: UpdateChannelSchema.optional(),
  force: z
    .preprocess(
      (value) => (value === undefined ? undefined : value === true || value === 'true' || value === '1'),
      z.boolean().optional(),
    )
    .optional(),
});

function publishedView(id: string) {
  const entry = findPublishedRelease(id);
  if (!entry || !entry.verified || entry.envelope.payload.paused) return null;
  return entry;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function betaAuthorized(headers: Record<string, unknown>): boolean {
  const expected = config.updates.betaFeedToken;
  const supplied = headers['x-update-channel-token'];
  if (!expected || typeof supplied !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------- Central update feed ------------------------- */

  app.get('/api/updates/health', async () => ({
    ok: true,
    service: 'zethub-proof-updates',
    publicKeyConfigured: Boolean(updatePublicKey()),
    keyId: updateKeyId(),
    checkedAt: new Date().toISOString(),
  }));

  app.get('/api/updates/releases', async (request) => {
    const query = z
      .object({
        channel: UpdateChannelSchema.optional(),
        platform: UpdatePlatformSchema.optional(),
        arch: UpdateArchSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    const restricted = query.channel === 'beta' && !betaAuthorized(request.headers);
    if (restricted) throw notFound('Published release');
    const items = verifiedPublishedReleases()
      .filter((entry) => entry.verified && !entry.envelope.payload.paused)
      .filter((entry) =>
        query.channel ? entry.envelope.payload.channel === query.channel : entry.envelope.payload.channel === 'stable',
      )
      .filter((entry) => !query.platform || entry.envelope.payload.platform === query.platform)
      .filter((entry) => !query.arch || entry.envelope.payload.arch === query.arch)
      .map((entry) => releaseView(entry))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, query.limit);
    return { items };
  });

  app.get('/api/updates/releases/:version', async (request) => {
    const params = ReleaseParams.parse(request.params);
    const query = z
      .object({
        channel: UpdateChannelSchema.optional(),
        platform: UpdatePlatformSchema.optional(),
        arch: UpdateArchSchema.optional(),
      })
      .parse(request.query);
    if (query.channel === 'beta' && !betaAuthorized(request.headers)) throw notFound('Published release');
    const items = verifiedPublishedReleases()
      .filter((entry) => entry.verified && !entry.envelope.payload.paused)
      .filter((entry) => entry.envelope.payload.version === params.version)
      .filter((entry) =>
        query.channel ? entry.envelope.payload.channel === query.channel : entry.envelope.payload.channel === 'stable',
      )
      .filter((entry) => !query.platform || entry.envelope.payload.platform === query.platform)
      .filter((entry) => !query.arch || entry.envelope.payload.arch === query.arch)
      .map((entry) => releaseView(entry));
    if (items.length === 0) throw notFound('Published release');
    return { version: params.version, items };
  });

  app.get('/api/updates/:platform/:arch/:channel', async (request) => {
    const target = TargetParams.parse(request.params);
    if (target.channel === 'beta' && !betaAuthorized(request.headers)) {
      throw new HttpError(404, 'NO_RELEASE', 'No published release is available for this target.');
    }
    const entry = latestFor(target.platform, target.arch, target.channel);
    if (!entry || !entry.verified) {
      throw new HttpError(404, 'NO_RELEASE', 'No published release is available for this target.');
    }
    return {
      release: releaseView(entry),
      envelope: entry.envelope,
    };
  });

  app.get('/api/updates/artifact/:id', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const entry = publishedView(id);
    if (!entry) throw notFound('Published update artifact');
    let absolute: string;
    try {
      absolute = resolveArtifactFile(updateStorageDir(), entry.envelope.payload.artifact.path);
    } catch {
      throw new HttpError(400, 'UNSAFE_ARTIFACT_PATH', 'The published artifact path is invalid.');
    }
    if (!fs.existsSync(absolute)) throw new HttpError(410, 'GONE', 'The update artifact is not available.');
    const stat = fs.statSync(absolute);
    if (stat.size !== entry.envelope.payload.artifact.sizeBytes) {
      throw new HttpError(410, 'GONE', 'The update artifact no longer matches its published size.');
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(stat.size));
    reply.header(
      'content-disposition',
      `attachment; filename="${safeFileName(entry.envelope.payload.artifact.fileName)}"`,
    );
    reply.header('cache-control', 'public, max-age=300');
    reply.header('x-update-sha256', entry.envelope.payload.artifact.sha256);
    return reply.send(fs.createReadStream(absolute));
  });

  /* ----------------------- Authenticated client API ---------------------- */

  app.get('/api/v1/updates/status', { preHandler: authenticate }, async (request) => {
    const status = await updateSystemStatus(request.auth!.user.id);
    delete (status as { userId?: string }).userId;
    return status;
  });

  app.get('/api/v1/updates/check', { preHandler: authenticate }, async (request) => {
    const query = CheckQuery.parse(request.query);
    return checkForUpdates({ channel: query.channel, force: query.force });
  });

  app.get('/api/v1/updates/releases', { preHandler: authenticate }, async () => ({
    items: adminReleases(),
  }));

  app.post('/api/v1/updates/download', { preHandler: authenticate }, async (request) => {
    const body = DownloadBody.parse(request.body);
    return startDownload({ releaseId: body.releaseId, userId: request.auth!.user.id });
  });

  app.get('/api/v1/updates/downloads/:id', { preHandler: authenticate }, async (request) => {
    const { id } = IdParams.parse(request.params);
    return getDownloadJob(id, request.auth!.user.id);
  });

  app.post('/api/v1/updates/downloads/:id/cancel', { preHandler: authenticate }, async (request) => {
    const { id } = IdParams.parse(request.params);
    return cancelDownload(id, request.auth!.user.id);
  });

  app.get('/api/v1/updates/staged', { preHandler: authenticate }, async () => ({
    items: stagedReleases(),
  }));

  app.post('/api/v1/updates/install', { preHandler: authenticate }, async (request) => {
    const body = InstallBody.parse(request.body);
    const result = await installStaged({ releaseId: body.releaseId, consent: body.consent });
    await audit({
      userId: request.auth!.user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'update-install',
      entityId: body.releaseId,
      metadata: { version: result.version, status: result.status },
      ip: request.ip,
    });
    return result;
  });

  app.get('/api/v1/updates/events', { preHandler: authenticate }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(2000).default(200) }).parse(request.query);
    return { items: readUpdateEvents(query.limit) };
  });

  /* --------------------------- Admin controls ---------------------------- */

  app.get('/api/v1/updates/admin/releases', { preHandler: authenticate }, async (request) => {
    requireOwner(request);
    return {
      items: adminReleases(),
      publicKeyConfigured: Boolean(updatePublicKey()),
      keyId: updateKeyId(),
      installMode: config.updates.installMode,
      platform: currentPlatform(),
      arch: currentArch(),
    };
  });

  app.post('/api/v1/updates/admin/publish', { preHandler: authenticate }, async (request) => {
    const owner = requireOwner(request);
    const body = PublishBody.parse(request.body);
    if (!/\.(exe|msi|appimage|deb|rpm|zip)$/i.test(body.artifactPath)) {
      throw badRequest('The artifact path must point to a supported package file.');
    }
    if (!fs.existsSync(body.artifactPath)) throw badRequest('The artifact file does not exist on this machine.');
    const previous = latestFor(body.platform, body.arch, body.channel, { includePaused: true });
    if (previous && compareVersions(body.version, previous.envelope.payload.version) <= 0 && !body.draft) {
      throw conflict(
        `Version ${body.version} is not newer than the latest published ${previous.envelope.payload.version} for this target.`,
      );
    }
    const privateKey = updatePrivateKey();
    const keyId = updateKeyId();
    if (!privateKey || !keyId) {
      throw new HttpError(503, 'UPDATE_SIGNING_KEY_MISSING', 'Update signing is not configured on this machine.');
    }
    const result = await publishUpdate({
      storageDir: updateStorageDir(),
      artifactPath: body.artifactPath,
      version: body.version,
      channel: body.channel,
      platform: body.platform,
      arch: body.arch,
      format: body.format,
      notes: body.notes,
      mandatory: body.mandatory,
      minimumSupportedVersion: body.minimumSupportedVersion,
      minimumOsVersion: body.minimumOsVersion,
      rolloutPercent: body.rolloutPercent,
      draft: body.draft,
      privateKeyPem: privateKey,
      keyId,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) throw conflict(message);
      throw badRequest(message);
    });
    await audit({
      userId: owner.user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'update-release',
      entityId: result.envelope.payload.id,
      metadata: {
        version: body.version,
        platform: body.platform,
        arch: body.arch,
        channel: body.channel,
        draft: result.draft,
      },
      ip: request.ip,
    });
    return {
      release: releaseView({ envelope: result.envelope, file: result.manifestPath, verified: true, error: null }),
      draft: result.draft,
      published: !result.draft,
    };
  });

  app.post('/api/v1/updates/admin/releases/:id/state', { preHandler: authenticate }, async (request) => {
    const owner = requireOwner(request);
    const { id } = IdParams.parse(request.params);
    const body = StateBody.parse(request.body);
    const privateKey = updatePrivateKey();
    const keyId = updateKeyId();
    if (!privateKey || !keyId) {
      throw new HttpError(503, 'UPDATE_SIGNING_KEY_MISSING', 'Update signing is not configured on this machine.');
    }
    if (!findPublishedRelease(id)) throw notFound('Release');
    const envelope = updateReleaseState(updateStorageDir(), id, body, privateKey, keyId);
    await audit({
      userId: owner.user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'update-release-state',
      entityId: id,
      metadata: { paused: body.paused, rolloutPercent: body.rolloutPercent },
      ip: request.ip,
    });
    return {
      release: releaseView({ envelope, file: '', verified: true, error: null }),
    };
  });

  app.post('/api/v1/updates/admin/releases/:id/pause', { preHandler: authenticate }, async (request) => {
    const owner = requireOwner(request);
    const { id } = IdParams.parse(request.params);
    const privateKey = updatePrivateKey();
    const keyId = updateKeyId();
    if (!privateKey || !keyId) {
      throw new HttpError(503, 'UPDATE_SIGNING_KEY_MISSING', 'Update signing is not configured on this machine.');
    }
    if (!findPublishedRelease(id)) throw notFound('Release');
    const envelope = updateReleaseState(updateStorageDir(), id, { paused: true }, privateKey, keyId);
    await audit({
      userId: owner.user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'update-release-state',
      entityId: id,
      metadata: { paused: true },
      ip: request.ip,
    });
    return { release: releaseView({ envelope, file: '', verified: true, error: null }) };
  });

  app.post('/api/v1/updates/admin/releases/:id/resume', { preHandler: authenticate }, async (request) => {
    const owner = requireOwner(request);
    const { id } = IdParams.parse(request.params);
    const privateKey = updatePrivateKey();
    const keyId = updateKeyId();
    if (!privateKey || !keyId) {
      throw new HttpError(503, 'UPDATE_SIGNING_KEY_MISSING', 'Update signing is not configured on this machine.');
    }
    if (!findPublishedRelease(id)) throw notFound('Release');
    const envelope = updateReleaseState(updateStorageDir(), id, { paused: false }, privateKey, keyId);
    await audit({
      userId: owner.user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'update-release-state',
      entityId: id,
      metadata: { paused: false },
      ip: request.ip,
    });
    return { release: releaseView({ envelope, file: '', verified: true, error: null }) };
  });

  app.delete('/api/v1/updates/admin/staged/:id', { preHandler: authenticate }, async (request) => {
    const owner = requireOwner(request);
    const { id } = IdParams.parse(request.params);
    const staged = stagedReleases().find((item) => item.releaseId === id);
    if (!staged) throw notFound('Staged package');
    try {
      removeStaged(id);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Unable to remove the staged package.');
    }
    await audit({
      userId: owner.user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'update-staged',
      entityId: id,
      metadata: { removed: true },
      ip: request.ip,
    });
    return { ok: true };
  });
}
