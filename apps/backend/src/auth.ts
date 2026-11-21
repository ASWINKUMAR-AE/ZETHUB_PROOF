import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Session, User } from '@prisma/client';
import { prisma } from './db.js';
import { HttpError, forbidden, unauthorized, unavailable } from './lib/http.js';
import { randomToken, sha256 } from './security.js';

export interface AuthContext {
  user: Pick<User, 'id' | 'email' | 'name' | 'role' | 'disabled'>;
  session: Session;
  viaBearer: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const SESSION_COOKIE = 'zh_session';

export async function createSession(
  userId: string,
  ip: string | null,
  userAgent: string | null,
  remember = false,
): Promise<{ token: string; csrfToken: string; session: Session }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + (remember ? 30 : 1) * 24 * 3600 * 1000);
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      csrfToken,
      ip: ip?.slice(0, 64) ?? null,
      userAgent: userAgent?.slice(0, 255) ?? null,
      expiresAt,
    },
  });
  return { token, csrfToken, session };
}

export async function resolveAuth(request: FastifyRequest): Promise<AuthContext | null> {
  const header = request.headers.authorization;
  const cookieToken = request.cookies?.[SESSION_COOKIE];
  let token: string | undefined;
  let viaBearer = false;
  if (header?.startsWith('Bearer ')) {
    token = header.slice(7).trim();
    viaBearer = true;
  } else if (cookieToken) {
    token = cookieToken;
  }
  if (!token) return null;

  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;
  if (session.user.disabled) return null;

  // Touch at most once per minute to avoid a write on every request.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    void prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      disabled: session.user.disabled,
    },
    session,
    viaBearer,
  };
}

export const authenticate: preHandlerHookHandler = async (request: FastifyRequest, _reply: FastifyReply) => {
  let auth: AuthContext | null;
  try {
    auth = await resolveAuth(request);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable(
      'The database is unavailable, so authentication cannot be verified. Local-only execution remains available through the local runner.',
      { detail: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!auth) throw unauthorized();
  request.auth = auth;
  if (auth.user.role === 'VIEWER' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    throw forbidden('Viewer accounts are read-only.');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
    if (!auth.viaBearer) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || csrf !== auth.session.csrfToken) {
        throw new HttpError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token for a state-changing request.');
      }
    }
  }
};

export function requireOwner(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  if (request.auth.user.role !== 'OWNER' && request.auth.user.role !== 'ADMIN')
    throw forbidden('This action requires an owner or admin account.');
  return request.auth;
}

export function setSessionCookie(reply: FastifyReply, token: string, remember: boolean, production: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    path: '/',
    maxAge: remember ? 30 * 24 * 3600 : 24 * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply, production: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: production });
}

export async function countUsers(): Promise<number> {
  return prisma.user.count();
}
