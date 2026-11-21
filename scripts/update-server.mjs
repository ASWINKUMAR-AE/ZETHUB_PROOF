#!/usr/bin/env node
/**
 * Standalone central update feed for ZetHub Proof.
 *
 * This process serves signed release metadata and artifacts without MySQL and
 * without the desktop application API. Put it behind an HTTPS reverse proxy
 * (nginx, Caddy, IIS ARR) and set UPDATE_PUBLIC_BASE_URL to the public origin.
 *
 *   node scripts/update-server.mjs
 *
 * Environment:
 *   UPDATE_STORAGE_DIR          Update store (default ./data/updates)
 *   UPDATE_SIGNING_PUBLIC_KEY   Public key PEM (preferred)
 *   UPDATE_SIGNING_PUBLIC_KEY_PATH  Path to the public key PEM
 *   UPDATE_BETA_FEED_TOKEN      Header token required for the beta channel
 *   UPDATE_SERVER_HOST          Bind host (default 127.0.0.1)
 *   UPDATE_SERVER_PORT          Bind port (default 4010)
 *   UPDATE_PUBLIC_BASE_URL      Public HTTPS origin, no trailing slash
 *
 * The server never publishes drafts, paused releases or unverified metadata.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import {
  compareVersions,
  findRoot,
  keyIdForPublicKey,
  listReleaseEnvelopes,
  loadEnv,
  resolveArtifactFile,
  verifyArtifactDigest,
  verifyReleaseEnvelope,
} from '../packages/verification-core/dist/index.js';

const root = findRoot();
loadEnv(root);

const storageDir = path.resolve(root, process.env.UPDATE_STORAGE_DIR || 'data/updates');
const host = process.env.UPDATE_SERVER_HOST || '127.0.0.1';
const port = Number(process.env.UPDATE_SERVER_PORT || 4010);
const publicBase = (process.env.UPDATE_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const betaToken = process.env.UPDATE_BETA_FEED_TOKEN || '';

function readPublicKey() {
  const inline = process.env.UPDATE_SIGNING_PUBLIC_KEY?.trim();
  if (inline) return inline;
  const file = process.env.UPDATE_SIGNING_PUBLIC_KEY_PATH
    ? path.resolve(root, process.env.UPDATE_SIGNING_PUBLIC_KEY_PATH)
    : path.join(root, 'secrets', 'update-signing-public.pem');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

const publicKey = readPublicKey();
const keyId = publicKey ? keyIdForPublicKey(publicKey) : null;

function loadVerified() {
  if (!publicKey) return [];
  return listReleaseEnvelopes(storageDir)
    .map((entry) => {
      const verification = verifyReleaseEnvelope(entry.envelope, publicKey);
      const digestOk =
        verification.payload !== null &&
        verifyArtifactDigest(
          verification.payload.artifact.sha256,
          verification.payload.artifact.digestSignature,
          publicKey,
        );
      return { ...entry, verified: verification.valid && digestOk };
    })
    .filter((entry) => entry.verified && !entry.envelope.payload.paused);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function betaAllowed(request) {
  if (!betaToken) return false;
  return safeEqual(request.headers['x-update-channel-token'], betaToken);
}

function downloadUrl(id) {
  const suffix = `/api/updates/artifact/${encodeURIComponent(id)}`;
  return publicBase ? `${publicBase}${suffix}` : suffix;
}

function releaseView(envelope) {
  const p = envelope.payload;
  return {
    id: p.id,
    version: p.version,
    channel: p.channel,
    platform: p.platform,
    arch: p.arch,
    publishedAt: p.publishedAt,
    notes: p.notes,
    mandatory: p.mandatory,
    minimumSupportedVersion: p.minimumSupportedVersion,
    minimumOsVersion: p.minimumOsVersion,
    paused: p.paused,
    rolloutPercent: p.rolloutPercent,
    format: p.artifact.format,
    fileName: p.artifact.fileName,
    sizeBytes: p.artifact.sizeBytes,
    sha256: p.artifact.sha256,
    downloadUrl: downloadUrl(p.id),
    artifactSignaturePresent: Boolean(p.artifact.digestSignature),
    keyId: envelope.keyId,
    signatureVerified: true,
    verification: 'verified',
    verificationMessage: 'Manifest and artifact digest signatures verified.',
  };
}

function json(response, status, body, extraHeaders = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  });
  response.end(payload);
}

function notFound(response) {
  json(response, 404, { error: { code: 'NOT_FOUND', message: 'Update resource not found.' } });
}

const buckets = new Map();
function rateLimited(remote) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const bucket = (buckets.get(remote) ?? []).filter((at) => at > windowStart);
  if (bucket.length >= 300) {
    buckets.set(remote, bucket);
    return true;
  }
  bucket.push(now);
  buckets.set(remote, bucket);
  return false;
}

function serveArtifact(response, id) {
  const entry = loadVerified().find((item) => item.envelope.payload.id === id);
  if (!entry) return notFound(response);
  let file;
  try {
    file = resolveArtifactFile(storageDir, entry.envelope.payload.artifact.path);
  } catch {
    return notFound(response);
  }
  if (!fs.existsSync(file)) return notFound(response);
  const stat = fs.statSync(file);
  if (stat.size !== entry.envelope.payload.artifact.sizeBytes) return notFound(response);
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(stat.size),
    'content-disposition': `attachment; filename="${entry.envelope.payload.artifact.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'cache-control': 'public, max-age=300',
    'x-update-sha256': entry.envelope.payload.artifact.sha256,
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer((request, response) => {
  const started = Date.now();
  const remote = request.socket.remoteAddress || 'unknown';
  response.on('finish', () => {
    if (process.env.UPDATE_SERVER_LOG !== 'quiet') {
      console.log(
        `${new Date().toISOString()} ${request.method} ${request.url} ${response.statusCode} ${Date.now() - started}ms`,
      );
    }
  });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported.' } });
  }
  if (rateLimited(remote)) {
    return json(response, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests. Retry later.' } });
  }
  let url;
  try {
    url = new URL(request.url || '/', 'http://update.invalid');
  } catch {
    return json(response, 400, { error: { code: 'BAD_REQUEST', message: 'Invalid request URL.' } });
  }
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  try {
    if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'updates' && segments[2] === 'health') {
      return json(response, 200, {
        ok: true,
        service: 'zethub-proof-updates',
        publicKeyConfigured: Boolean(publicKey),
        keyId,
        storageConfigured: fs.existsSync(storageDir),
        checkedAt: new Date().toISOString(),
      });
    }

    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'updates' && segments[2] === 'releases') {
      const version = segments[3];
      const channel = url.searchParams.get('channel') || 'stable';
      if (channel === 'beta' && !betaAllowed(request)) return notFound(response);
      const items = loadVerified()
        .filter((item) => item.envelope.payload.version === version)
        .filter((item) => item.envelope.payload.channel === channel)
        .filter(
          (item) =>
            !url.searchParams.get('platform') || item.envelope.payload.platform === url.searchParams.get('platform'),
        )
        .filter((item) => !url.searchParams.get('arch') || item.envelope.payload.arch === url.searchParams.get('arch'))
        .map((item) => releaseView(item.envelope));
      if (items.length === 0) return notFound(response);
      return json(response, 200, { version, items });
    }

    if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'updates' && segments[2] === 'releases') {
      const channel = url.searchParams.get('channel') || 'stable';
      if (channel === 'beta' && !betaAllowed(request)) return notFound(response);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const platform = url.searchParams.get('platform');
      const arch = url.searchParams.get('arch');
      const items = loadVerified()
        .filter((item) => item.envelope.payload.channel === channel)
        .filter((item) => !platform || item.envelope.payload.platform === platform)
        .filter((item) => !arch || item.envelope.payload.arch === arch)
        .map((item) => releaseView(item.envelope))
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, limit);
      return json(response, 200, { items });
    }

    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'updates' && segments[2] === 'artifact') {
      return serveArtifact(response, segments[3]);
    }

    if (segments.length === 5 && segments[0] === 'api' && segments[1] === 'updates') {
      const [, , platform, arch, channel] = segments;
      if (!['windows', 'linux'].includes(platform)) return notFound(response);
      if (!['x86_64', 'aarch64'].includes(arch)) return notFound(response);
      if (!['stable', 'beta'].includes(channel)) return notFound(response);
      if (channel === 'beta' && !betaAllowed(request)) return notFound(response);
      const matches = loadVerified()
        .filter(
          (item) =>
            item.envelope.payload.platform === platform &&
            item.envelope.payload.arch === arch &&
            item.envelope.payload.channel === channel,
        )
        .sort((a, b) => compareVersions(a.envelope.payload.version, b.envelope.payload.version));
      const latest = matches.at(-1);
      if (!latest) return notFound(response);
      return json(response, 200, {
        release: releaseView(latest.envelope),
        envelope: latest.envelope,
      });
    }

    return notFound(response);
  } catch (error) {
    console.error(`update server error: ${error instanceof Error ? error.message : String(error)}`);
    return json(response, 500, {
      error: { code: 'INTERNAL_ERROR', message: 'The update server failed to process the request.' },
    });
  }
});

setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [remote, values] of buckets) {
    const kept = values.filter((at) => at > cutoff);
    if (kept.length === 0) buckets.delete(remote);
    else buckets.set(remote, kept);
  }
}, 120_000).unref();

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

server.listen(port, host, () => {
  console.log(`ZetHub Proof update server listening on http://${host}:${port}`);
  console.log(`  storage : ${storageDir}`);
  console.log(`  public  : ${publicBase || 'relative URLs (set UPDATE_PUBLIC_BASE_URL)'}`);
  console.log(`  key id  : ${keyId ?? 'NOT CONFIGURED - no releases will be served'}`);
  if (!publicBase)
    console.warn('Set UPDATE_PUBLIC_BASE_URL and terminate TLS at a reverse proxy before production use.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
