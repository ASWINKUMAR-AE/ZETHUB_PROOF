import type { AuditAction, UserSettings } from '@zethub/shared-types';
import { UserSettingsSchema } from '@zethub/shared-types';
import { prisma } from '../db.js';
import { toJson } from './json.js';

export async function audit(input: {
  userId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        metadata: input.metadata ? toJson(sanitizeMetadata(input.metadata)) : undefined,
        ip: input.ip ?? null,
      },
    });
  } catch {
    // Auditing must never break the primary operation, but failures are logged by the server.
  }
}

const SECRET_KEY = /password|secret|token|authorization|api[-_]?key|cookie/i;
function sanitizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) out[k] = '***REDACTED***';
    else if (v && typeof v === 'object') out[k] = sanitizeMetadata(v);
    else out[k] = v;
  }
  return out;
}

export const DEFAULT_SETTINGS: UserSettings = UserSettingsSchema.parse({});

export async function getSettings(userId: string): Promise<UserSettings> {
  const row = await prisma.userSetting.findUnique({ where: { userId } });
  if (!row) return { ...DEFAULT_SETTINGS };
  const parsed = UserSettingsSchema.safeParse(row.settingsJson);
  return parsed.success ? { ...DEFAULT_SETTINGS, ...parsed.data } : { ...DEFAULT_SETTINGS };
}

export async function saveSettings(userId: string, settings: UserSettings): Promise<UserSettings> {
  const parsed = UserSettingsSchema.parse(settings);
  await prisma.userSetting.upsert({
    where: { userId },
    create: { userId, settingsJson: parsed },
    update: { settingsJson: parsed },
  });
  return parsed;
}

export async function notify(userId: string, type: string, title: string, body?: string): Promise<void> {
  try {
    await prisma.notification.create({ data: { userId, type, title, body } });
  } catch {
    /* notifications are best-effort */
  }
}
