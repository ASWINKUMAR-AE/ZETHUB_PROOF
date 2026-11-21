import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import {
  compareVersions,
  isRolloutEligible,
  isVersionNewer,
  isVersionValid,
  keyIdForPublicKey,
  listReleaseEnvelopes,
  resolveArtifactFile,
  verifyArtifactDigest,
  verifyReleaseEnvelope,
} from '@zethub/verification-core';
import type {
  UpdateChannel,
  UpdateCheckResponse,
  UpdateDownloadJob,
  UpdateManifestEnvelope,
  UpdatePlatform,
  UpdateReleaseView,
  UpdateStagedRelease,
} from '@zethub/shared-types';
import { UpdateArchSchema, UpdateChannelSchema, UpdatePlatformSchema } from '@zethub/shared-types';
import { APP_VERSION, config } from '../config.js';
import { prisma } from '../db.js';
import { conflict, HttpError, notFound } from '../lib/http.js';

const PLATFORM_MAP: Record<string, UpdatePlatform> = { win32: 'windows', linux: 'linux' };
const ARCH_MAP: Record<string, 'x86_64' | 'aarch64'> = { x64: 'x86_64', arm64: 'aarch64' };

export function currentPlatform(): UpdatePlatform | null {
  return PLATFORM_MAP[process.platform] ?? null;
}

export function currentArch(): 'x86_64' | 'aarch64' | null {
  return ARCH_MAP[process.arch] ?? null;
}

export function platformLabel(): string {
  return process.platform;
}

export function archLabel(): string {
  return process.arch;
}

/* ------------------------------------------------------------------ */
/* Keys and storage                                                    */
/* ------------------------------------------------------------------ */

let publicKeyCache: { value: string | null; keyId: string | null } | null = null;
let privateKeyCache: string | null = null;

export function updatePublicKey(): string | null {
  if (publicKeyCache) return publicKeyCache.value;
  let value = config.updates.signingPublicKey;
  if (!value && config.updates.signingPublicKeyPath && fs.existsSync(config.updates.signingPublicKeyPath)) {
    value = fs.readFileSync(config.updates.signingPublicKeyPath, 'utf8');
  }
  const keyId = value ? keyIdForPublicKey(value) : null;
  publicKeyCache = { value: value ?? null, keyId };
  return publicKeyCache.value;
}

export function updateKeyId(): string | null {
  updatePublicKey();
  return publicKeyCache?.keyId ?? null;
}

export function updatePrivateKey(): string | null {
  if (privateKeyCache) return privateKeyCache;
  const file = config.updates.signingPrivateKeyPath;
  if (!file) return null;
  if (!fs.existsSync(file)) {
    throw new HttpError(
      503,
      'UPDATE_SIGNING_KEY_MISSING',
      'The update signing private key is not present on this machine. Publishing is disabled.',
    );
  }
  privateKeyCache = fs.readFileSync(file, 'utf8');
  return privateKeyCache;
}

export function updateStorageDir(): string {
  return config.updates.storageDir;
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

function feedBase(): string | null {
  return config.updates.feedUrl ? normalizeBase(config.updates.feedUrl) : null;
}

function localDownloadUrl(id: string): string {
  return `/api/updates/artifact/${encodeURIComponent(id)}`;
}

function downloadUrlFor(id: string): string {
  const base = feedBase();
  return base ? `${base}/api/updates/artifact/${encodeURIComponent(id)}` : localDownloadUrl(id);
}

/* ------------------------------------------------------------------ */
/* Release validation and views                                        */
/* ------------------------------------------------------------------ */

export interface VerifiedRelease {
  envelope: UpdateManifestEnvelope;
  file: string;
  verified: boolean;
  error: string | null;
}

export function verifiedPublishedReleases(): VerifiedRelease[] {
  const publicKey = updatePublicKey();
  return listReleaseEnvelopes(updateStorageDir()).map((entry) => {
    if (!publicKey) {
      return { ...entry, verified: false, error: 'Update signing public key is not configured.' };
    }
    const result = verifyReleaseEnvelope(entry.envelope, publicKey);
    const digestOk = result.payload
      ? verifyArtifactDigest(result.payload.artifact.sha256, result.payload.artifact.digestSignature, publicKey)
      : false;
    return {
      ...entry,
      verified: result.valid && digestOk,
      error: result.valid && digestOk ? null : (result.error ?? 'Artifact digest signature verification failed.'),
    };
  });
}

export function releaseView(entry: VerifiedRelease): UpdateReleaseView {
  const payload = entry.envelope.payload;
  return {
    id: payload.id,
    version: payload.version,
    channel: payload.channel,
    platform: payload.platform,
    arch: payload.arch,
    publishedAt: payload.publishedAt,
    notes: payload.notes,
    mandatory: payload.mandatory,
    minimumSupportedVersion: payload.minimumSupportedVersion,
    minimumOsVersion: payload.minimumOsVersion,
    paused: payload.paused,
    rolloutPercent: payload.rolloutPercent,
    format: payload.artifact.format,
    fileName: payload.artifact.fileName,
    sizeBytes: payload.artifact.sizeBytes,
    sha256: payload.artifact.sha256,
    downloadUrl: downloadUrlFor(payload.id),
    artifactSignaturePresent: Boolean(payload.artifact.digestSignature),
    keyId: entry.envelope.keyId,
    signatureVerified: entry.verified,
    verification: entry.verified ? 'verified' : 'failed',
    verificationMessage: entry.error ?? 'Manifest and artifact digest signatures verified.',
  };
}

export function findPublishedRelease(id: string): VerifiedRelease | null {
  return verifiedPublishedReleases().find((entry) => entry.envelope.payload.id === id) ?? null;
}

export function latestFor(
  platform: UpdatePlatform,
  arch: 'x86_64' | 'aarch64',
  channel: UpdateChannel,
  options: { includePaused?: boolean } = {},
): VerifiedRelease | null {
  const matches = verifiedPublishedReleases()
    .filter(
      (entry) =>
        entry.envelope.payload.platform === platform &&
        entry.envelope.payload.arch === arch &&
        entry.envelope.payload.channel === channel &&
        (options.includePaused || !entry.envelope.payload.paused),
    )
    .sort((a, b) => {
      const byVersion = compareVersions(a.envelope.payload.version, b.envelope.payload.version);
      if (byVersion !== 0) return byVersion;
      return Date.parse(a.envelope.payload.publishedAt) - Date.parse(b.envelope.payload.publishedAt);
    });
  return matches.at(-1) ?? null;
}

/* ------------------------------------------------------------------ */
/* OS compatibility                                                    */
/* ------------------------------------------------------------------ */

function looseVersion(value: string): number[] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function osCompatible(minimum: string | null): { compatible: boolean; current: string; reason: string | null } {
  const current = os.release();
  if (!minimum) return { compatible: true, current, reason: null };
  const required = looseVersion(minimum);
  const actual = looseVersion(current);
  if (!required || !actual) {
    return {
      compatible: true,
      current,
      reason: `The minimum OS value "${minimum}" is informational; this runtime reports "${current}".`,
    };
  }
  for (let i = 0; i < 3; i += 1) {
    if (actual[i]! > required[i]!) break;
    if (actual[i]! < required[i]!) {
      return {
        compatible: false,
        current,
        reason: `This system reports OS ${current}, but the release requires at least ${minimum}.`,
      };
    }
  }
  return { compatible: true, current, reason: null };
}

/* ------------------------------------------------------------------ */
/* Installation identity and local events                              */
/* ------------------------------------------------------------------ */

const INSTALL_ID_FILE = () => path.join(updateStorageDir(), 'install-id');

export function updateInstallId(): string {
  const file = INSTALL_ID_FILE();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9-]{32,64}$/i.test(existing)) return existing;
  } catch {
    /* create below */
  }
  const value = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  return value;
}

export function appendUpdateEvent(event: Record<string, unknown>): void {
  try {
    const file = path.join(updateStorageDir(), 'events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* Update event logging is best-effort and never blocks an update. */
  }
}

export function readUpdateEvents(limit = 500): Array<Record<string, unknown>> {
  const file = path.join(updateStorageDir(), 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-Math.min(limit, 2000));
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip malformed line */
    }
  }
  return out.reverse();
}

/* ------------------------------------------------------------------ */
/* Checking                                                            */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  at: number;
  response: UpdateCheckResponse;
}

const checkCache = new Map<string, CacheEntry>();
const CHECK_CACHE_MS = 60_000;

function parseTarget(platform: string, arch: string, channel: string) {
  return {
    platform: UpdatePlatformSchema.parse(platform),
    arch: UpdateArchSchema.parse(arch),
    channel: UpdateChannelSchema.parse(channel),
  };
}

function unavailable(
  message: string,
  source: 'local' | 'remote',
  currentVersion: string,
  state: UpdateCheckResponse['status'] = 'unavailable',
): UpdateCheckResponse {
  return {
    status: state,
    currentVersion,
    latestVersion: null,
    release: null,
    message,
    checkedAt: new Date().toISOString(),
    source,
    cached: false,
    updateAvailable: false,
    mandatory: false,
  };
}

async function fetchRemoteEnvelope(
  platform: UpdatePlatform,
  arch: string,
  channel: UpdateChannel,
): Promise<UpdateManifestEnvelope | null> {
  const base = feedBase();
  if (!base) throw new Error('No remote update feed is configured.');
  const url = `${base}/api/updates/${encodeURIComponent(platform)}/${encodeURIComponent(arch)}/${encodeURIComponent(channel)}`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': `ZetHub-Proof/${APP_VERSION}`,
      ...(channel === 'beta' && config.updates.betaFeedToken
        ? { 'x-update-channel-token': config.updates.betaFeedToken }
        : {}),
    },
    signal: AbortSignal.timeout(config.updates.checkTimeoutMs),
    redirect: 'follow',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Update server returned HTTP ${response.status}.`);
  const payload = (await response.json()) as { envelope?: unknown };
  if (!payload.envelope) throw new Error('Update server returned an invalid response.');
  return payload.envelope as UpdateManifestEnvelope;
}

export async function checkForUpdates(input: {
  currentVersion?: string;
  platform?: string;
  arch?: string;
  channel?: UpdateChannel;
  force?: boolean;
}): Promise<UpdateCheckResponse> {
  const platform = input.platform ?? currentPlatform();
  const arch = input.arch ?? currentArch();
  if (!platform || !arch) {
    return unavailable(
      `Automatic updates are not available for ${process.platform}/${process.arch}. Windows and Linux are supported.`,
      'local',
      input.currentVersion ?? APP_VERSION,
    );
  }
  const target = parseTarget(platform, arch, input.channel ?? 'stable');
  const currentVersion = input.currentVersion ?? APP_VERSION;
  const cacheKey = `${feedBase() ?? 'local'}:${target.platform}:${target.arch}:${target.channel}:${currentVersion}`;
  const cached = checkCache.get(cacheKey);
  if (!input.force && cached && Date.now() - cached.at < CHECK_CACHE_MS) {
    return { ...cached.response, cached: true };
  }

  const source: 'local' | 'remote' = feedBase() ? 'remote' : 'local';
  const publicKey = updatePublicKey();
  if (!publicKey) {
    return unavailable(
      'Update signature verification is not configured. For safety, updates cannot be checked or installed until an update public key is deployed.',
      source,
      currentVersion,
    );
  }

  let envelope: UpdateManifestEnvelope | null = null;
  try {
    envelope = feedBase()
      ? await fetchRemoteEnvelope(target.platform, target.arch, target.channel)
      : (latestFor(target.platform, target.arch, target.channel, { includePaused: true })?.envelope ?? null);
  } catch (error) {
    const result = unavailable(
      `The update server is unavailable. The application continues to work with the installed version. ${
        error instanceof Error ? error.message : ''
      }`.trim(),
      source,
      currentVersion,
      'error',
    );
    checkCache.set(cacheKey, { at: Date.now(), response: result });
    return result;
  }
  if (!envelope) {
    const result: UpdateCheckResponse = {
      status: 'none',
      currentVersion,
      latestVersion: null,
      release: null,
      message: 'No published release is available for this platform and channel.',
      checkedAt: new Date().toISOString(),
      source,
      cached: false,
      updateAvailable: false,
      mandatory: false,
    };
    checkCache.set(cacheKey, { at: Date.now(), response: result });
    return result;
  }

  const verification = verifyReleaseEnvelope(envelope, publicKey);
  if (!verification.valid || !verification.payload) {
    return unavailable(
      `The update metadata signature is invalid. This release will not be offered. ${verification.error ?? ''}`.trim(),
      source,
      currentVersion,
      'error',
    );
  }
  const payload = verification.payload;
  if (payload.platform !== target.platform || payload.arch !== target.arch || payload.channel !== target.channel) {
    return unavailable(
      'The update server returned metadata for a different platform, architecture or channel.',
      source,
      currentVersion,
      'error',
    );
  }
  const digestOk = verifyArtifactDigest(payload.artifact.sha256, payload.artifact.digestSignature, publicKey);
  if (!digestOk) {
    return unavailable(
      'The update package signature is invalid. This release will not be offered.',
      source,
      currentVersion,
      'error',
    );
  }

  const entry: VerifiedRelease = { envelope, file: '', verified: true, error: null };
  const release = releaseView(entry);
  const osCheck = osCompatible(payload.minimumOsVersion);
  if (!osCheck.compatible) {
    return {
      status: 'incompatible',
      currentVersion,
      latestVersion: payload.version,
      release,
      message: osCheck.reason ?? 'This release is not compatible with the current operating system version.',
      checkedAt: new Date().toISOString(),
      source,
      cached: false,
      updateAvailable: false,
      mandatory: false,
    };
  }
  if (payload.paused) {
    return {
      status: 'paused',
      currentVersion,
      latestVersion: payload.version,
      release,
      message: 'This release has been paused by the administrator and is not being offered.',
      checkedAt: new Date().toISOString(),
      source,
      cached: false,
      updateAvailable: false,
      mandatory: false,
    };
  }
  if (isVersionNewer(payload.version, currentVersion)) {
    // continue below
  } else {
    return {
      status: 'none',
      currentVersion,
      latestVersion: payload.version,
      release,
      message: 'You are running the latest available version for this channel.',
      checkedAt: new Date().toISOString(),
      source,
      cached: false,
      updateAvailable: false,
      mandatory: false,
    };
  }
  if (!isRolloutEligible(updateInstallId(), payload.id, payload.rolloutPercent)) {
    const result: UpdateCheckResponse = {
      status: 'none',
      currentVersion,
      latestVersion: payload.version,
      release,
      message: `Version ${payload.version} is being rolled out gradually. This installation is not in the current rollout group.`,
      checkedAt: new Date().toISOString(),
      source,
      cached: false,
      updateAvailable: false,
      mandatory: false,
    };
    checkCache.set(cacheKey, { at: Date.now(), response: result });
    return result;
  }
  const mandatory =
    payload.mandatory ||
    (payload.minimumSupportedVersion !== null &&
      isVersionValid(payload.minimumSupportedVersion) &&
      compareVersions(currentVersion, payload.minimumSupportedVersion) < 0);
  const result: UpdateCheckResponse = {
    status: 'available',
    currentVersion,
    latestVersion: payload.version,
    release,
    message: mandatory
      ? `Version ${payload.version} is available and required for continued support.`
      : `Version ${payload.version} is available.`,
    checkedAt: new Date().toISOString(),
    source,
    cached: false,
    updateAvailable: true,
    mandatory,
  };
  checkCache.set(cacheKey, { at: Date.now(), response: result });
  return result;
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

interface InternalJob extends UpdateDownloadJob {
  userId: string;
}

const jobs = new Map<string, InternalJob>();
const activeDownloads = new Set<string>();
const downloadControllers = new Map<string, AbortController>();
let installInProgress = false;

function downloadsRoot(): string {
  return path.join(updateStorageDir(), 'downloads');
}

function stageDirFor(releaseId: string): string {
  return path.join(downloadsRoot(), releaseId.replace(/[^A-Za-z0-9._-]/g, '_'));
}

function jobView(job: InternalJob): UpdateDownloadJob {
  const { userId: _userId, ...rest } = job;
  return rest;
}

function updateJob(job: InternalJob, patch: Partial<InternalJob>): void {
  Object.assign(job, patch);
  if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled') {
    job.finishedAt = job.finishedAt ?? new Date().toISOString();
  }
}

async function downloadToFile(
  url: string,
  destination: string,
  job: InternalJob,
  maxBytes: number,
  controller: AbortController,
): Promise<{ size: number }> {
  const timer = setTimeout(() => controller.abort(), Math.max(config.updates.checkTimeoutMs, 120_000));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/octet-stream', 'user-agent': `ZetHub-Proof/${APP_VERSION}` },
      redirect: 'follow',
    });
    if (!response.ok || !response.body) throw new Error(`Update download returned HTTP ${response.status}.`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new Error('Update package is larger than the configured maximum size.');
    if (declared > 0) updateJob(job, { totalBytes: declared });
    let received = 0;
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        controller.abort();
        return;
      }
      updateJob(job, {
        bytesReceived: received,
        progress: job.totalBytes ? Math.min(0.99, received / job.totalBytes) : 0,
      });
    });
    await pipeline(body, fs.createWriteStream(destination, { mode: 0o600 }));
    if (received > maxBytes) throw new Error('Update package exceeded the configured maximum size.');
    return { size: received };
  } finally {
    clearTimeout(timer);
  }
}

async function runDownload(job: InternalJob, entry: VerifiedRelease, publicKey: string): Promise<void> {
  const payload = entry.envelope.payload;
  const dir = stageDirFor(payload.id);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, payload.artifact.fileName);
  const partPath = `${finalPath}.part`;
  const controller = new AbortController();
  downloadControllers.set(payload.id, controller);
  updateJob(job, { status: 'downloading', startedAt: new Date().toISOString() });
  try {
    const remoteBase = feedBase();
    if (remoteBase) {
      await downloadToFile(
        `${remoteBase}/api/updates/artifact/${encodeURIComponent(payload.id)}`,
        partPath,
        job,
        config.updates.maxArtifactMb * 1024 * 1024,
        controller,
      );
    } else {
      const source = resolveArtifactFile(updateStorageDir(), payload.artifact.path);
      if (!fs.existsSync(source)) throw new Error('The update package is missing from the local update store.');
      updateJob(job, { totalBytes: payload.artifact.sizeBytes });
      await pipeline(fs.createReadStream(source), fs.createWriteStream(partPath, { mode: 0o600 }));
      updateJob(job, { bytesReceived: payload.artifact.sizeBytes, progress: 0.99 });
    }
    if (job.status === 'cancelled' || controller.signal.aborted) throw new Error('Cancelled by the user.');
    updateJob(job, { status: 'verifying' });
    const stat = fs.statSync(partPath);
    if (stat.size !== payload.artifact.sizeBytes)
      throw new Error('Downloaded package size does not match the signed metadata.');
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(partPath), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk as Buffer);
        yield chunk;
      }
    });
    const digest = hash.digest('hex');
    if (digest !== payload.artifact.sha256)
      throw new Error('Downloaded package checksum does not match the signed metadata.');
    if (!verifyArtifactDigest(digest, payload.artifact.digestSignature, publicKey)) {
      throw new Error('Downloaded package signature is invalid.');
    }
    fs.renameSync(partPath, finalPath);
    fs.writeFileSync(
      path.join(dir, 'staged.json'),
      `${JSON.stringify(
        {
          releaseId: payload.id,
          version: payload.version,
          fileName: payload.artifact.fileName,
          path: finalPath,
          sha256: digest,
          verified: true,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    updateJob(job, {
      status: 'ready',
      bytesReceived: stat.size,
      totalBytes: stat.size,
      progress: 1,
      stagedPath: finalPath,
      sha256: digest,
      fileName: payload.artifact.fileName,
    });
    appendUpdateEvent({
      at: new Date().toISOString(),
      event: 'download',
      currentVersion: APP_VERSION,
      latestVersion: payload.version,
      platform: payload.platform,
      arch: payload.arch,
      releaseId: payload.id,
    });
  } catch (error) {
    fs.rmSync(partPath, { force: true });
    if (job.status !== 'cancelled') {
      updateJob(job, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      appendUpdateEvent({
        at: new Date().toISOString(),
        event: 'download-failed',
        currentVersion: APP_VERSION,
        latestVersion: payload.version,
        platform: payload.platform,
        arch: payload.arch,
        releaseId: payload.id,
        detail: job.error ?? undefined,
      });
    }
  } finally {
    activeDownloads.delete(payload.id);
    downloadControllers.delete(payload.id);
  }
}

export function startDownload(input: { releaseId: string; userId: string }): UpdateDownloadJob {
  const entry = findPublishedRelease(input.releaseId);
  if (!entry || !entry.verified) throw notFound('Verified release not found.');
  const payload = entry.envelope.payload;
  if (payload.platform !== currentPlatform() || payload.arch !== currentArch()) {
    throw conflict('This package targets a different platform or architecture.');
  }
  if (payload.paused) throw conflict('This release is paused and cannot be downloaded.');
  if (activeDownloads.has(payload.id)) throw conflict('A download for this release is already in progress.');
  const publicKey = updatePublicKey();
  if (!publicKey) throw new HttpError(503, 'UPDATE_UNVERIFIED', 'Update signature verification is not configured.');
  const job: InternalJob = {
    id: crypto.randomUUID(),
    releaseId: payload.id,
    version: payload.version,
    status: 'queued',
    bytesReceived: 0,
    totalBytes: payload.artifact.sizeBytes,
    progress: 0,
    fileName: payload.artifact.fileName,
    stagedPath: null,
    sha256: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    userId: input.userId,
  };
  jobs.set(job.id, job);
  activeDownloads.add(payload.id);
  void runDownload(job, entry, publicKey);
  return jobView(job);
}

export function getDownloadJob(jobId: string, userId: string): UpdateDownloadJob {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) throw notFound('Download job not found.');
  return jobView(job);
}

export function cancelDownload(jobId: string, userId: string): UpdateDownloadJob {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) throw notFound('Download job not found.');
  if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled') return jobView(job);
  updateJob(job, { status: 'cancelled', error: 'Cancelled by the user.' });
  downloadControllers.get(job.releaseId)?.abort();
  activeDownloads.delete(job.releaseId);
  return jobView(job);
}

/* ------------------------------------------------------------------ */
/* Staged packages and installation                                    */
/* ------------------------------------------------------------------ */

export function stagedReleases(): UpdateStagedRelease[] {
  const root = downloadsRoot();
  if (!fs.existsSync(root)) return [];
  const items: UpdateStagedRelease[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'staged.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as UpdateStagedRelease;
      if (parsed.verified && parsed.path && fs.existsSync(parsed.path)) items.push(parsed);
    } catch {
      /* skip incomplete stages */
    }
  }
  return items.sort((a, b) => Date.parse(b.downloadedAt) - Date.parse(a.downloadedAt));
}

export function removeStaged(releaseId: string): boolean {
  const staged = stagedReleases().find((item) => item.releaseId === releaseId);
  if (!staged) return false;
  const root = path.resolve(downloadsRoot());
  const target = path.resolve(staged.path);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a staged file outside the update download directory.');
  }
  const container = path.dirname(target);
  const containerRelative = path.relative(root, container);
  if (!containerRelative || containerRelative.startsWith('..') || path.isAbsolute(containerRelative)) {
    fs.rmSync(target, { force: true });
  } else {
    fs.rmSync(container, { recursive: true, force: true });
  }
  return true;
}

export async function activeRunCount(): Promise<number> {
  try {
    return await prisma.testRun.count({ where: { status: 'RUNNING' } });
  } catch {
    return 0;
  }
}

export interface InstallResult {
  status: 'manual-required' | 'installer-started' | 'blocked';
  message: string;
  version: string;
  path: string | null;
  confirmationRequired: boolean;
}

export async function installStaged(input: { releaseId: string; consent: boolean }): Promise<InstallResult> {
  if (!input.consent) throw conflict('Explicit consent is required before launching an installer.');
  if (installInProgress) throw conflict('Another update installation is already in progress.');
  const staged = stagedReleases().find((item) => item.releaseId === input.releaseId);
  if (!staged) throw notFound('No verified staged package exists for this release.');
  const entry = findPublishedRelease(input.releaseId);
  if (!entry || !entry.verified) throw conflict('The release metadata is no longer valid or has been paused.');
  const publicKey = updatePublicKey();
  if (!publicKey) throw new HttpError(503, 'UPDATE_UNVERIFIED', 'Update signature verification is not configured.');
  const hash = await new Promise<string>((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const stream = fs.createReadStream(staged.path);
    stream.on('error', reject);
    stream.on('data', (chunk) => digest.update(chunk as Buffer));
    stream.on('end', () => resolve(digest.digest('hex')));
  });
  if (hash !== entry.envelope.payload.artifact.sha256) {
    throw conflict('The staged package changed on disk and no longer matches its signed checksum.');
  }
  if (!verifyArtifactDigest(hash, entry.envelope.payload.artifact.digestSignature, publicKey)) {
    throw conflict('The staged package signature is invalid.');
  }
  const runs = await activeRunCount();
  if (runs > 0) throw conflict(`Installation is deferred because ${runs} verification run(s) are active.`);
  if (config.updates.installMode === 'manual') {
    appendUpdateEvent({
      at: new Date().toISOString(),
      event: 'manual-install',
      currentVersion: APP_VERSION,
      latestVersion: entry.envelope.payload.version,
      platform: entry.envelope.payload.platform,
      arch: entry.envelope.payload.arch,
      releaseId: entry.envelope.payload.id,
    });
    return {
      status: 'manual-required',
      message:
        'The package is verified and ready. Automatic installation is disabled in this build; close ZetHub Proof and run the verified installer manually.',
      version: entry.envelope.payload.version,
      path: staged.path,
      confirmationRequired: true,
    };
  }
  if (process.platform !== 'win32') {
    throw conflict('The Windows installer mode is only available on Windows. Use manual installation on Linux.');
  }
  const fileName = path.basename(staged.path);
  installInProgress = true;
  try {
    if (fileName.toLowerCase().endsWith('.msi')) {
      const child = spawn('msiexec.exe', ['/i', staged.path], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
    } else {
      const child = spawn(staged.path, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
    }
    appendUpdateEvent({
      at: new Date().toISOString(),
      event: 'install-started',
      currentVersion: APP_VERSION,
      latestVersion: entry.envelope.payload.version,
      platform: entry.envelope.payload.platform,
      arch: entry.envelope.payload.arch,
      releaseId: entry.envelope.payload.id,
    });
    return {
      status: 'installer-started',
      message:
        'The signed installer was launched with your consent. ZetHub Proof cannot claim success until the installer completes and the new version reports itself after restart.',
      version: entry.envelope.payload.version,
      path: staged.path,
      confirmationRequired: false,
    };
  } finally {
    setTimeout(() => {
      installInProgress = false;
    }, 30_000).unref();
  }
}

/* ------------------------------------------------------------------ */
/* Status and admin                                                    */
/* ------------------------------------------------------------------ */

export async function updateSystemStatus(userId: string): Promise<Record<string, unknown>> {
  const platform = currentPlatform();
  const arch = currentArch();
  const configured = Boolean(updatePublicKey());
  const releases = verifiedPublishedReleases();
  return {
    currentVersion: APP_VERSION,
    feedConfigured: Boolean(feedBase()),
    feedUrl: feedBase(),
    storageConfigured: fs.existsSync(updateStorageDir()),
    publicKeyConfigured: configured,
    keyId: updateKeyId(),
    installMode: config.updates.installMode,
    platform: platform ?? process.platform,
    arch: arch ?? process.arch,
    activeRuns: await activeRunCount(),
    staged: stagedReleases(),
    releases: releases.length,
    message: configured
      ? 'Update metadata can be verified with the deployed public key.'
      : 'No update public key is configured. Check and install actions are disabled for safety.',
    userId,
  };
}

export function adminReleases(): Array<UpdateReleaseView & { status: 'published' | 'paused'; served: boolean }> {
  return verifiedPublishedReleases()
    .map((entry) => ({
      ...releaseView(entry),
      status: entry.envelope.payload.paused ? ('paused' as const) : ('published' as const),
      served: entry.verified && !entry.envelope.payload.paused,
    }))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
