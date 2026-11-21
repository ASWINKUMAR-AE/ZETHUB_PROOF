import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  UpdateManifestEnvelopeSchema,
  UpdateReleasePayloadSchema,
  type UpdateChannel,
  type UpdateManifestEnvelope,
  type UpdateReleasePayload,
} from '@zethub/shared-types';

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

interface ParsedVersion {
  core: number[];
  pre: Array<string | number> | null;
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  const pre = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()))
    : null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}

/** Semver-style comparison. Returns a negative number when a < b. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Invalid version string: ${!left ? a : b}`);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i]! - right.core[i]!;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l - r;
    if (typeof l === 'number') return -1;
    if (typeof r === 'number') return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function isVersionNewer(candidate: string, current: string): boolean {
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    return false;
  }
}

export function isVersionValid(value: string): boolean {
  return parseVersion(value) !== null;
}

/* ------------------------------------------------------------------ */
/* Canonical JSON and signatures                                       */
/* ------------------------------------------------------------------ */

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        if (source[key] !== undefined) out[key] = canonicalValue(source[key]);
        return out;
      }, {});
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function normalizeKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('BEGIN ')) return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  return decoded.includes('BEGIN ') ? decoded : trimmed;
}

export function keyIdForPublicKey(publicKey: string | crypto.KeyObject): string {
  const key = typeof publicKey === 'string' ? crypto.createPublicKey(normalizeKey(publicKey)) : publicKey;
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

export function generateUpdateKeyPair(): { publicKey: string; privateKey: string; keyId: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKey: publicPem, privateKey: privatePem, keyId: keyIdForPublicKey(publicKey) };
}

export function signReleasePayload(
  payload: UpdateReleasePayload,
  privateKeyPem: string,
  keyId: string,
): UpdateManifestEnvelope {
  const parsed = UpdateReleasePayloadSchema.parse(payload);
  const signature = crypto.sign(null, Buffer.from(canonicalJson(parsed), 'utf8'), normalizeKey(privateKeyPem));
  return UpdateManifestEnvelopeSchema.parse({
    schemaVersion: 1,
    keyId,
    payload: parsed,
    signature: signature.toString('base64'),
  });
}

export function verifyReleaseEnvelope(
  envelope: unknown,
  publicKeyPem: string,
): { valid: boolean; keyId: string; payload: UpdateReleasePayload | null; error: string | null } {
  const parsed = UpdateManifestEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    return {
      valid: false,
      keyId: '',
      payload: null,
      error: `Manifest schema invalid: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    };
  }
  try {
    if (parsed.data.keyId !== keyIdForPublicKey(publicKeyPem)) {
      return {
        valid: false,
        keyId: parsed.data.keyId,
        payload: parsed.data.payload,
        error: 'Manifest key id mismatch.',
      };
    }
    const valid = crypto.verify(
      null,
      Buffer.from(canonicalJson(parsed.data.payload), 'utf8'),
      crypto.createPublicKey(normalizeKey(publicKeyPem)),
      Buffer.from(parsed.data.signature, 'base64'),
    );
    return {
      valid,
      keyId: parsed.data.keyId,
      payload: parsed.data.payload,
      error: valid ? null : 'Manifest signature verification failed.',
    };
  } catch (error) {
    return {
      valid: false,
      keyId: parsed.data.keyId,
      payload: parsed.data.payload,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Sign the 32-byte SHA-256 digest, not the entire artifact. */
export function signArtifactDigest(sha256Hex: string, privateKeyPem: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256Hex)) throw new Error('Artifact digest must be 64 lowercase hex characters.');
  return crypto.sign(null, Buffer.from(sha256Hex, 'hex'), normalizeKey(privateKeyPem)).toString('base64');
}

export function verifyArtifactDigest(sha256Hex: string, signature: string, publicKeyPem: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(sha256Hex)) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(sha256Hex, 'hex'),
      crypto.createPublicKey(normalizeKey(publicKeyPem)),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export function releaseId(payload: Pick<UpdateReleasePayload, 'channel' | 'version' | 'platform' | 'arch'>): string {
  return `${payload.channel}-${payload.version}-${payload.platform}-${payload.arch}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function artifactRelativePath(
  payload: Pick<UpdateReleasePayload, 'version' | 'platform' | 'arch' | 'artifact'>,
) {
  return path.posix.join('artifacts', payload.version, payload.platform, payload.arch, payload.artifact.fileName);
}

export function releasesRoot(storageDir: string): string {
  return path.join(storageDir, 'releases');
}

export function draftsRoot(storageDir: string): string {
  return path.join(storageDir, 'drafts');
}

export function artifactsRoot(storageDir: string): string {
  return path.join(storageDir, 'artifacts');
}

export function ensureStorage(storageDir: string): void {
  for (const dir of [
    releasesRoot(storageDir),
    draftsRoot(storageDir),
    artifactsRoot(storageDir),
    path.join(storageDir, 'staging'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertSafeArtifactName(fileName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error('Artifact file name is not safe.');
  }
}

export function resolveArtifactFile(storageDir: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\\') || relativePath.includes('..')) {
    throw new Error('Artifact path is not safe.');
  }
  const root = artifactsRoot(storageDir);
  const resolved = path.resolve(storageDir, relativePath);
  if (!isInside(root, resolved)) throw new Error('Artifact path escapes the update storage directory.');
  return resolved;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temp, filePath);
}

function walkJson(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJson(absolute));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(absolute);
  }
  return out.sort();
}

export function listReleaseEnvelopes(storageDir: string): Array<{ file: string; envelope: UpdateManifestEnvelope }> {
  const items: Array<{ file: string; envelope: UpdateManifestEnvelope }> = [];
  for (const file of walkJson(releasesRoot(storageDir))) {
    try {
      const parsed = UpdateManifestEnvelopeSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (parsed.success) items.push({ file, envelope: parsed.data });
    } catch {
      /* Skip unreadable metadata; publish validation reports these separately. */
    }
  }
  return items;
}

export function listDraftEnvelopes(storageDir: string): Array<{ file: string; envelope: UpdateManifestEnvelope }> {
  const items: Array<{ file: string; envelope: UpdateManifestEnvelope }> = [];
  for (const file of walkJson(draftsRoot(storageDir))) {
    try {
      const parsed = UpdateManifestEnvelopeSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (parsed.success) items.push({ file, envelope: parsed.data });
    } catch {
      /* ignore */
    }
  }
  return items;
}

export interface PublishUpdateInput {
  storageDir: string;
  artifactPath: string;
  version: string;
  channel: UpdateChannel;
  platform: UpdateReleasePayload['platform'];
  arch: UpdateReleasePayload['arch'];
  format: UpdateReleasePayload['artifact']['format'];
  notes: string;
  mandatory?: boolean;
  minimumSupportedVersion?: string | null;
  minimumOsVersion?: string | null;
  rolloutPercent?: number;
  draft?: boolean;
  privateKeyPem: string;
  keyId: string;
}

export interface PublishUpdateResult {
  envelope: UpdateManifestEnvelope;
  manifestPath: string;
  artifactPath: string;
  draft: boolean;
}

export async function publishUpdate(input: PublishUpdateInput): Promise<PublishUpdateResult> {
  ensureStorage(input.storageDir);
  assertSafeArtifactName(path.basename(input.artifactPath));
  const artifactStat = fs.lstatSync(input.artifactPath);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
    throw new Error('The artifact must be a regular file (symbolic links are rejected).');
  }
  const fileName = path.basename(input.artifactPath);
  const sha256 = await sha256File(input.artifactPath);
  const payload = UpdateReleasePayloadSchema.parse({
    schemaVersion: 1,
    id: releaseId({
      channel: input.channel,
      version: input.version,
      platform: input.platform,
      arch: input.arch,
    }),
    version: input.version,
    channel: input.channel,
    platform: input.platform,
    arch: input.arch,
    publishedAt: new Date().toISOString(),
    notes: input.notes,
    mandatory: input.mandatory ?? false,
    minimumSupportedVersion: input.minimumSupportedVersion ?? null,
    minimumOsVersion: input.minimumOsVersion ?? null,
    paused: false,
    rolloutPercent: input.rolloutPercent ?? 100,
    artifact: {
      fileName,
      format: input.format,
      sizeBytes: artifactStat.size,
      sha256,
      digestSignature: signArtifactDigest(sha256, input.privateKeyPem),
      path: path.posix.join('artifacts', input.version, input.platform, input.arch, fileName),
    },
  });
  const envelope = signReleasePayload(payload, input.privateKeyPem, input.keyId);

  const targetRoot = input.draft ? draftsRoot(input.storageDir) : releasesRoot(input.storageDir);
  const manifestPath = path.join(targetRoot, input.channel, input.platform, input.arch, `${input.version}.json`);
  if (fs.existsSync(manifestPath)) {
    throw new Error(
      `Release ${input.version} for ${input.platform}/${input.arch} (${input.channel}) already exists. Publish a new version instead of overwriting a release.`,
    );
  }

  const staging = fs.mkdtempSync(path.join(input.storageDir, 'staging', 'publish-'));
  const finalArtifact = input.draft
    ? path.join(targetRoot, input.channel, input.platform, input.arch, fileName)
    : resolveArtifactFile(input.storageDir, payload.artifact.path);
  try {
    const stagedArtifact = path.join(staging, fileName);
    fs.copyFileSync(input.artifactPath, stagedArtifact);
    const stagedHash = await sha256File(stagedArtifact);
    if (stagedHash !== sha256) throw new Error('Artifact changed while publishing; aborting.');
    if (input.draft) {
      fs.mkdirSync(path.dirname(finalArtifact), { recursive: true });
      if (fs.existsSync(finalArtifact)) throw new Error('The draft artifact already exists.');
      fs.copyFileSync(stagedArtifact, finalArtifact);
    } else {
      const destination = finalArtifact;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) throw new Error('The target artifact already exists.');
      fs.copyFileSync(stagedArtifact, `${destination}.tmp`);
      fs.renameSync(`${destination}.tmp`, destination);
    }
    writeJsonAtomic(manifestPath, envelope);
    return { envelope, manifestPath, artifactPath: finalArtifact, draft: input.draft ?? false };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function updateReleaseState(
  storageDir: string,
  id: string,
  patch: { paused?: boolean; rolloutPercent?: number },
  privateKeyPem: string,
  keyId: string,
): UpdateManifestEnvelope {
  const entries = listReleaseEnvelopes(storageDir).filter((entry) => entry.envelope.payload.id === id);
  if (entries.length === 0) throw new Error('Release not found in published storage.');
  const entry = entries[0]!;
  const payload: UpdateReleasePayload = {
    ...entry.envelope.payload,
    ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
    ...(patch.rolloutPercent !== undefined ? { rolloutPercent: patch.rolloutPercent } : {}),
  };
  const envelope = signReleasePayload(payload, privateKeyPem, keyId);
  writeJsonAtomic(entry.file, envelope);
  return envelope;
}

export function rolloutBucket(installId: string, releaseIdValue: string): number {
  const digest = crypto.createHash('sha256').update(`${installId}:${releaseIdValue}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function isRolloutEligible(installId: string, releaseIdValue: string, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return rolloutBucket(installId, releaseIdValue) < percent;
}
