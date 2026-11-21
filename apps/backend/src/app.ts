import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { config, APP_VERSION, paths } from './config.js';
import { prisma } from './db.js';
import { HttpError } from './lib/http.js';
import { authenticate } from './auth.js';
import { authRoutes, localFallbackRoutes, settingsRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { runRoutes } from './routes/runs.js';
import { analyticsRoutes } from './routes/analytics.js';
import { repairRoutes } from './routes/repairs.js';
import { databaseRoutes } from './routes/database.js';
import { aiRoutes, integrationRoutes, offlineRoutes } from './routes/integrations.js';
import { updateRoutes } from './routes/updates.js';
import { evidenceStore } from './services/runs.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? (config.nodeEnv === 'development' ? 'info' : 'warn'),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 10 * 1024 * 1024,
    requestTimeout: 120_000,
    disableRequestLogging: config.nodeEnv === 'production',
  });

  /**
   * Treat an empty JSON body as "no payload" instead of rejecting the request.
   * Several endpoints take no input; some clients still send a JSON content type.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : String(body ?? '');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const error = new Error('The request body is not valid JSON.') as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (config.allowedOrigins.includes(origin)) return callback(null, true);
      // Browser extensions (the extension still authenticates with a bearer token).
      if (/^(?:chrome|moz)-extension:\/\//.test(origin)) return callback(null, true);
      // Tauri desktop webviews.
      if (/^(tauri:\/\/localhost|http:\/\/tauri\.localhost|https:\/\/tauri\.localhost)$/.test(origin))
        return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token'],
    maxAge: 600,
  });

  await app.register(cookie, { parseOptions: {} });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    allowList: [],
    errorResponseBuilder: () => ({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a moment and retry.' },
    }),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'ZetHub Proof API',
        description:
          'Local-only API for the ZetHub Proof developer verification platform. All state-changing cookie requests require the X-CSRF-Token header returned by /api/v1/auth/me. Bearer device tokens bypass CSRF because they are not ambient browser credentials.',
        version: APP_VERSION,
      },
      servers: [{ url: `http://${config.apiHost}:${config.apiPort}`, description: 'Local loopback instance' }],
      tags: [
        { name: 'auth', description: 'Local accounts, sessions and device tokens' },
        { name: 'projects', description: 'Projects, environments, cases and filesystem browsing' },
        { name: 'runs', description: 'Plans, verification runs, reports and capsules' },
        { name: 'analytics', description: 'Real aggregates computed from stored runs' },
        { name: 'database', description: 'XAMPP/MySQL administration with explicit confirmations' },
        { name: 'integrations', description: 'Git, GitHub, API, database, browser and AI integrations' },
        { name: 'updates', description: 'Signed release metadata, artifact delivery and safe update installation' },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    staticCSP: false,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  const uiDist = path.join(config.rootDir, 'apps', 'desktop', 'dist');
  const uiIndex = path.join(uiDist, 'index.html');

  app.get('/', async (_request, reply) => {
    if (fs.existsSync(uiIndex)) {
      reply.type('text/html; charset=utf-8');
      return reply.send(fs.createReadStream(uiIndex));
    }
    return {
      name: 'ZetHub Proof API',
      version: APP_VERSION,
      docs: '/api/docs',
      health: '/api/v1/system/health',
      note: 'Loopback-only local verification service. The desktop UI is served separately.',
    };
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request did not match the expected shape.',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
      return;
    }
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
      return;
    }
    const statusCode =
      typeof (error as { statusCode?: number }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode === 429) {
      reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a moment and retry.' } });
      return;
    }
    if (statusCode < 500) {
      reply.code(statusCode).send({ error: { code: 'REQUEST_REJECTED', message: (error as Error).message } });
      return;
    }
    request.log.error({ err: error }, 'unhandled request error');
    reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message:
          'An unexpected server error occurred. Inspect the local API log for details; no stack trace is returned to the client.',
      },
    });
  });

  await app.register(authRoutes);
  await app.register(settingsRoutes);
  await app.register(localFallbackRoutes);
  await app.register(projectRoutes);
  await app.register(runRoutes);
  await app.register(analyticsRoutes);
  await app.register(repairRoutes);
  await app.register(databaseRoutes);
  await app.register(integrationRoutes);
  await app.register(offlineRoutes);
  await app.register(aiRoutes);
  await app.register(updateRoutes);

  /** Authenticated, authorisation-checked artifact streaming. */
  app.get('/api/v1/artifacts/*', { preHandler: authenticate }, async (request, reply) => {
    const relative = (request.params as { '*': string })['*'];
    if (!relative) throw new HttpError(400, 'BAD_REQUEST', 'Artifact path is required.');
    const user = request.auth!.user;
    const [evidence, report, capsule] = await Promise.all([
      prisma.evidenceArtifact.findFirst({ where: { relativePath: relative, run: { project: { ownerId: user.id } } } }),
      prisma.verificationReport.findFirst({
        where: { relativePath: relative, run: { project: { ownerId: user.id } } },
      }),
      prisma.failureCapsule.findFirst({ where: { relativePath: relative, run: { project: { ownerId: user.id } } } }),
    ]);
    if (!evidence && !report && !capsule) throw new HttpError(404, 'NOT_FOUND', 'Artifact not found.');
    let absolute: string;
    try {
      absolute = evidenceStore.absolute(relative);
    } catch {
      throw new HttpError(400, 'PATH_TRAVERSAL', 'Invalid artifact path.');
    }
    if (!fs.existsSync(absolute)) throw new HttpError(410, 'GONE', 'The artifact file is no longer present on disk.');
    reply.header(
      'content-type',
      evidence?.mimeType ??
        (report?.format === 'HTML'
          ? 'text/html; charset=utf-8'
          : report?.format === 'JSON'
            ? 'application/json'
            : capsule
              ? 'application/json'
              : 'application/octet-stream'),
    );
    reply.header('cache-control', 'private, max-age=60');
    return reply.send(fs.createReadStream(absolute));
  });

  /** Serve the built desktop UI when present. */
  if (fs.existsSync(uiIndex)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: '/', wildcard: false, index: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.includes('.')) {
        return reply.type('text/html; charset=utf-8').send(fs.createReadStream(path.join(uiDist, 'index.html')));
      }
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
    });
  }

  return app;
}

export { paths };
