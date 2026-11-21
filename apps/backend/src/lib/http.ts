import type { FastifyReply } from 'fastify';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have access to this resource') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'BAD_REQUEST', message, details);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'CONFLICT', message, details);
export const unavailable = (message: string, details?: unknown) =>
  new HttpError(503, 'SERVICE_UNAVAILABLE', message, details);

export function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: unknown): void {
  reply.code(status).send({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

export function parsePagination(
  query: Record<string, unknown>,
  defaultSize = 25,
): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? defaultSize) || defaultSize));
  return { page, pageSize, skip: (page - 1) * pageSize };
}
