import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { APP_VERSION, config } from '../config.js';
import { checkDatabase, prisma, schemaState } from '../db.js';
import {
  authenticate,
  clearSessionCookie,
  countUsers,
  createSession,
  requireOwner,
  setSessionCookie,
} from '../auth.js';
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/http.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../security.js';
import { audit, DEFAULT_SETTINGS, getSettings } from '../lib/audit.js';
import { UserSettingsSchema } from '@zethub/shared-types';

const BootstrapBody = z.object({
  email: z.string().email().max(190),
  name: z.string().min(1).max(120),
  password: z.string().min(10).max(200),
});

const LoginBody = z.object({
  email: z.string().email().max(190),
  password: z.string().min(1).max(200),
  remember: z.boolean().default(false),
});

const ManagedRoleSchema = z.enum(['OWNER', 'ADMIN', 'VIEWER']);

const CreateUserBody = z.object({
  email: z.string().email().max(190),
  name: z.string().min(1).max(120),
  role: ManagedRoleSchema.default('ADMIN'),
  password: z.string().min(10).max(200).optional(),
});

const UpdateUserBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    role: ManagedRoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.role !== undefined || value.disabled !== undefined, {
    message: 'Provide a name, role or disabled value.',
  });

const ResetPasswordBody = z.object({
  password: z.string().min(10).max(200).optional(),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});

function generatePassword(): string {
  return `${crypto.randomBytes(18).toString('base64url')}aA7!`;
}

function assertLocalPassword(password: string): void {
  try {
    assertPasswordPolicy(password);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Password does not meet the local policy.');
  }
}

function managedUserView(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  _count?: { projects?: number };
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    projectCount: user._count?.projects ?? 0,
  };
}

async function activeOwnerCount(): Promise<number> {
  return prisma.user.count({ where: { role: 'OWNER', disabled: false } });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/auth/status', async () => {
    const initialized = (await countUsers().catch(() => 0)) > 0;
    return {
      initialized,
      version: APP_VERSION,
      dbReachable: initialized ? true : await checkDatabase().then((d) => d.available),
    };
  });

  app.post(
    '/api/v1/auth/bootstrap',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = BootstrapBody.parse(request.body);
      const initialized = (await countUsers()) > 0;
      if (initialized)
        throw new HttpError(409, 'ALREADY_INITIALIZED', 'ZetHub Proof already has an account. Sign in instead.');
      try {
        assertPasswordPolicy(body.password);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'Password does not meet the local policy.');
      }
      const user = await prisma.user.create({
        data: {
          email: body.email.toLowerCase(),
          name: body.name,
          passwordHash: hashPassword(body.password),
          role: 'OWNER',
          settings: { create: { settingsJson: DEFAULT_SETTINGS } },
        },
      });
      const { token, csrfToken } = await createSession(
        user.id,
        request.ip,
        request.headers['user-agent'] ?? null,
        true,
      );
      setSessionCookie(reply, token, true, config.nodeEnv === 'production');
      await audit({ userId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id, ip: request.ip });
      return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, csrfToken };
    },
  );

  app.post(
    '/api/v1/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = LoginBody.parse(request.body);
      const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
      if (!user || user.disabled || !verifyPassword(body.password, user.passwordHash)) {
        await audit({
          userId: user?.id,
          action: 'SECURITY_DENIED',
          entityType: 'auth',
          metadata: { reason: 'invalid-credentials', email: body.email },
          ip: request.ip,
        });
        throw unauthorized('Invalid email or password.');
      }
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      const { token, csrfToken } = await createSession(
        user.id,
        request.ip,
        request.headers['user-agent'] ?? null,
        body.remember,
      );
      setSessionCookie(reply, token, body.remember, config.nodeEnv === 'production');
      await audit({ userId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id, ip: request.ip });
      return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, csrfToken };
    },
  );

  app.get('/api/v1/auth/me', { preHandler: authenticate }, async (request) => {
    const auth = request.auth!;
    const settings = await getSettings(auth.user.id);
    return {
      user: auth.user,
      csrfToken: auth.session.csrfToken,
      settings,
      session: { expiresAt: auth.session.expiresAt, viaBearer: auth.viaBearer },
    };
  });

  /* -------------------------- Account management ------------------------- */

  app.get('/api/v1/users', { preHandler: authenticate }, async (request) => {
    requireOwner(request);
    const items = await prisma.user.findMany({
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        disabled: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        _count: { select: { projects: true } },
      },
    });
    return {
      items: items.map(managedUserView),
      total: items.length,
      active: items.filter((item) => !item.disabled).length,
    };
  });

  app.post(
    '/api/v1/users',
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => {
      const actor = requireOwner(request);
      const body = CreateUserBody.parse(request.body);
      if (body.role === 'OWNER' && actor.user.role !== 'OWNER') {
        throw forbidden('Only an owner can create another owner account.');
      }
      const email = body.email.toLowerCase();
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) throw conflict('An account with this email already exists.');

      const generated = body.password === undefined;
      const password = body.password ?? generatePassword();
      assertLocalPassword(password);
      const user = await prisma.user.create({
        data: {
          email,
          name: body.name.trim(),
          passwordHash: hashPassword(password),
          role: body.role,
          settings: { create: { settingsJson: DEFAULT_SETTINGS } },
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          disabled: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
          _count: { select: { projects: true } },
        },
      });
      await audit({
        userId: actor.user.id,
        action: 'SETTINGS_UPDATE',
        entityType: 'user-account',
        entityId: user.id,
        metadata: { event: 'created', role: user.role, generatedPassword: generated },
        ip: request.ip,
      });
      return {
        user: managedUserView(user),
        temporaryPassword: generated ? password : null,
        generatedPassword: generated,
      };
    },
  );

  app.patch('/api/v1/users/:id', { preHandler: authenticate }, async (request) => {
    const actor = requireOwner(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = UpdateUserBody.parse(request.body);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('Account');
    if (target.role === 'OWNER' && actor.user.role !== 'OWNER') {
      throw forbidden('Only an owner can modify an owner account.');
    }
    if (body.role === 'OWNER' && actor.user.role !== 'OWNER') {
      throw forbidden('Only an owner can grant the owner role.');
    }
    if (target.id === actor.user.id) {
      if (body.disabled === true) throw badRequest('You cannot disable your own account.');
      if (body.role && body.role !== target.role) throw badRequest('You cannot change your own role.');
    }
    const removesActiveOwner =
      target.role === 'OWNER' &&
      !target.disabled &&
      (body.disabled === true || (body.role !== undefined && body.role !== 'OWNER'));
    if (removesActiveOwner && (await activeOwnerCount()) <= 1) {
      throw conflict('At least one active owner account must remain.');
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        disabled: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        _count: { select: { projects: true } },
      },
    });
    if (body.disabled === true) {
      await prisma.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await audit({
      userId: actor.user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'user-account',
      entityId: id,
      metadata: {
        event: 'updated',
        role: body.role ?? user.role,
        disabled: body.disabled ?? user.disabled,
      },
      ip: request.ip,
    });
    return { user: managedUserView(user) };
  });

  app.post('/api/v1/users/:id/reset-password', { preHandler: authenticate }, async (request) => {
    const actor = requireOwner(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = ResetPasswordBody.parse(request.body ?? {});
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('Account');
    if (target.id === actor.user.id) {
      throw badRequest('Use the password change form to update your own password.');
    }
    if (target.role === 'OWNER' && actor.user.role !== 'OWNER') {
      throw forbidden('Only an owner can reset an owner password.');
    }
    if (actor.user.role === 'ADMIN' && target.role !== 'VIEWER') {
      throw forbidden('Administrators can only reset passwords for viewer accounts.');
    }
    const generated = body.password === undefined;
    const password = body.password ?? generatePassword();
    assertLocalPassword(password);
    await prisma.user.update({ where: { id }, data: { passwordHash: hashPassword(password) } });
    await prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({
      userId: actor.user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'user-password',
      entityId: id,
      metadata: { event: 'reset', generatedPassword: generated },
      ip: request.ip,
    });
    return { ok: true, temporaryPassword: generated ? password : null, generatedPassword: generated };
  });

  app.post('/api/v1/auth/password', { preHandler: authenticate }, async (request) => {
    const auth = request.auth!;
    const body = ChangePasswordBody.parse(request.body);
    const user = await prisma.user.findUnique({ where: { id: auth.user.id } });
    if (!user || !verifyPassword(body.currentPassword, user.passwordHash)) {
      throw forbidden('Current password is incorrect.');
    }
    if (body.currentPassword === body.newPassword) {
      throw badRequest('The new password must differ from the current password.');
    }
    assertLocalPassword(body.newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(body.newPassword) } });
    await prisma.session.updateMany({
      where: { userId: user.id, id: { not: auth.session.id }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({
      userId: user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'user-password',
      entityId: user.id,
      metadata: { event: 'changed' },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.post('/api/v1/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    await prisma.session.update({ where: { id: request.auth!.session.id }, data: { revokedAt: new Date() } });
    clearSessionCookie(reply, config.nodeEnv === 'production');
    await audit({
      userId: request.auth!.user.id,
      action: 'LOGOUT',
      entityType: 'session',
      entityId: request.auth!.session.id,
      ip: request.ip,
    });
    return { ok: true };
  });

  /** Token for CLI / browser-extension clients. Returned once; only the hash is stored. */
  app.post('/api/v1/auth/device-token', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth!;
    const { token } = await createSession(auth.user.id, request.ip, 'device-token', true);
    await audit({
      userId: auth.user.id,
      action: 'SECURITY_DENIED',
      entityType: 'device-token',
      metadata: { event: 'token-created' },
      ip: request.ip,
    });
    reply.header('cache-control', 'no-store');
    return {
      token,
      note: 'Store this token securely. It is shown once and grants access to your local ZetHub Proof instance.',
    };
  });

  app.get('/api/v1/auth/sessions', { preHandler: authenticate }, async (request) => {
    const sessions = await prisma.session.findMany({
      where: { userId: request.auth!.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
      orderBy: { lastSeenAt: 'desc' },
    });
    return { items: sessions };
  });

  app.delete('/api/v1/auth/sessions/:id', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const result = await prisma.session.updateMany({
      where: { id, userId: request.auth!.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
    return { ok: true };
  });

  app.get('/api/v1/system/info', { preHandler: authenticate }, async () => {
    const db = await checkDatabase();
    const schema = db.available ? await schemaState() : null;
    return {
      version: APP_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      os: `${process.platform} ${process.arch}`,
      hostname: (await import('node:os')).hostname(),
      cwd: config.rootDir,
      artifactsDir: config.artifactsDir,
      backupsDir: config.backupsDir,
      db: { reachable: db.available, error: db.error ? 'Database unreachable' : null, schema },
      ai: {
        enabled: config.ai.enabled,
        provider: config.ai.provider,
        model: config.ai.model,
        consentSendCode: config.ai.consentSendCode,
      },
      config: {
        apiHost: config.apiHost,
        apiPort: config.apiPort,
        maxParallelTests: config.maxParallelTests,
        defaultCommandTimeoutMs: config.defaultCommandTimeoutMs,
        artifactRetentionDays: config.artifactRetentionDays,
        workspaceRoots: config.workspaceRoots,
      },
      tauri: { available: false },
    };
  });
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/settings', { preHandler: authenticate }, async (request) => {
    return { settings: await getSettings(request.auth!.user.id) };
  });

  app.put('/api/v1/settings', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const body = UserSettingsSchema.parse(request.body);
    const settings = await prisma.userSetting.upsert({
      where: { userId: auth.user.id },
      create: { userId: auth.user.id, settingsJson: body },
      update: { settingsJson: body },
    });
    await audit({
      userId: auth.user.id,
      action: 'SETTINGS_UPDATE',
      entityType: 'user-settings',
      entityId: settings.id,
      ip: request.ip,
    });
    return { settings: body };
  });

  app.get('/api/v1/notifications', { preHandler: authenticate }, async (request) => {
    const items = await prisma.notification.findMany({
      where: { userId: request.auth!.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items, unread: items.filter((i) => !i.readAt).length };
  });

  app.post('/api/v1/notifications/:id/read', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = await prisma.notification.updateMany({
      where: { id, userId: request.auth!.user.id },
      data: { readAt: new Date() },
    });
    if (result.count === 0) throw new HttpError(404, 'NOT_FOUND', 'Notification not found');
    return { ok: true };
  });

  app.get('/api/v1/audit', { preHandler: authenticate }, async (request) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.auditLog.count(),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  });
}

/** Local-only fallback when MySQL is unavailable: no DB, no user records. */
export async function localFallbackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/local/health', async () => {
    return { ok: true, mode: 'local-only', message: 'ZetHub Proof API is running without database-backed features.' };
  });
}
