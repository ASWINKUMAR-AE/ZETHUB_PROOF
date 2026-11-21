#!/usr/bin/env node
/**
 * Signed ZetHub Proof release tool.
 *
 * Examples:
 *   npm run update:keys
 *   npm run update:release -- list
 *   npm run update:release -- publish --artifact release/ZetHub-Proof-1.0.1-win.exe \
 *     --version 1.0.1 --platform windows --arch x86_64 --format nsis \
 *     --channel stable --notes-file release-notes/1.0.1.md --rollout 25
 *   npm run update:release -- pause --id stable-1.0.1-windows-x86_64
 *   npm run update:release -- resume --id stable-1.0.1-windows-x86_64
 *   npm run update:release -- rollout --id stable-1.0.1-windows-x86_64 --percent 100
 *   npm run update:release -- validate
 *
 * The private key is read from UPDATE_SIGNING_PRIVATE_KEY_PATH and is never
 * written into the update store, logs or release metadata.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  compareVersions,
  findRoot,
  keyIdForPublicKey,
  listDraftEnvelopes,
  listReleaseEnvelopes,
  loadEnv,
  publishUpdate,
  resolveArtifactFile,
  sha256File,
  updateReleaseState,
  verifyArtifactDigest,
  verifyReleaseEnvelope,
} from '@zethub/verification-core';
import {
  UpdateArchSchema,
  UpdateArtifactFormatSchema,
  UpdateChannelSchema,
  UpdatePlatformSchema,
  type UpdateManifestEnvelope,
} from '@zethub/shared-types';

const root = findRoot();
loadEnv(root);

function arg(name: string): string | null {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = process.argv[index + 1];
    if (next && !next.startsWith('--')) return next;
  }
  return null;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.argv.some((value) => value.startsWith(`--${name}=`));
}

function required(name: string): string {
  const value = arg(name);
  if (!value) {
    console.error(`Missing required --${name}.`);
    process.exit(1);
  }
  return value;
}

function integer(name: string, fallback?: number): number | undefined {
  const raw = arg(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    console.error(`--${name} must be an integer.`);
    process.exit(1);
  }
  return value;
}

function updateStorageDir(): string {
  return path.resolve(root, process.env.UPDATE_STORAGE_DIR || 'data/updates');
}

function publicKeyPem(): string | null {
  const inline = process.env.UPDATE_SIGNING_PUBLIC_KEY?.trim();
  if (inline) return inline;
  const file = process.env.UPDATE_SIGNING_PUBLIC_KEY_PATH
    ? path.resolve(root, process.env.UPDATE_SIGNING_PUBLIC_KEY_PATH)
    : path.join(root, 'secrets', 'update-signing-public.pem');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function privateKeyPem(): string {
  const file = process.env.UPDATE_SIGNING_PRIVATE_KEY_PATH
    ? path.resolve(root, process.env.UPDATE_SIGNING_PRIVATE_KEY_PATH)
    : path.join(root, 'secrets', 'update-signing-private.pem');
  if (!fs.existsSync(file)) {
    console.error(
      `Update signing private key not found at ${file}. Set UPDATE_SIGNING_PRIVATE_KEY_PATH to a key stored outside the repository.`,
    );
    process.exit(1);
  }
  const privateKey = fs.readFileSync(file, 'utf8');
  const derivedPublic = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const trustedPublic = publicKeyPem();
  if (trustedPublic && keyIdForPublicKey(derivedPublic) !== keyIdForPublicKey(trustedPublic)) {
    console.error(
      'The private key does not match the configured public key. Clients would reject every release signed with it.',
    );
    process.exit(1);
  }
  return privateKey;
}

function signingKeyId(): string {
  const publicKey = publicKeyPem();
  if (publicKey) return keyIdForPublicKey(publicKey);
  const privateKey = privateKeyPem();
  return keyIdForPublicKey(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString());
}

function inferFormat(file: string): string | null {
  const lower = file.toLowerCase();
  if (lower.endsWith('.exe')) return 'nsis';
  if (lower.endsWith('.msi')) return 'msi';
  if (lower.endsWith('.appimage')) return 'appimage';
  if (lower.endsWith('.deb')) return 'deb';
  if (lower.endsWith('.rpm')) return 'rpm';
  if (lower.endsWith('.zip')) return 'portable';
  return null;
}

function allPublished(): UpdateManifestEnvelope[] {
  return listReleaseEnvelopes(updateStorageDir()).map((entry) => entry.envelope);
}

function commandPublish(): Promise<void> {
  const artifactPath = path.resolve(required('artifact'));
  if (!fs.existsSync(artifactPath)) {
    console.error(`Artifact not found: ${artifactPath}`);
    process.exit(1);
  }
  const stat = fs.lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    console.error('The artifact must be a regular file (symbolic links are not accepted).');
    process.exit(1);
  }
  const version = required('version');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`Invalid version "${version}". Use semver, for example 1.0.1.`);
    process.exit(1);
  }
  const platform = UpdatePlatformSchema.parse(required('platform'));
  const arch = UpdateArchSchema.parse(required('arch'));
  const channel = UpdateChannelSchema.parse(arg('channel') ?? 'stable');
  const format = UpdateArtifactFormatSchema.parse(arg('format') ?? inferFormat(artifactPath));
  const extension = path.extname(artifactPath).toLowerCase();
  const allowed = platform === 'windows' ? ['.exe', '.msi', '.zip'] : ['.appimage', '.deb', '.rpm', '.zip'];
  if (!allowed.includes(extension)) {
    console.error(`A ${platform} release cannot use ${extension}. Expected one of ${allowed.join(', ')}.`);
    process.exit(1);
  }
  const notesPath = arg('notes-file');
  const notes = notesPath ? fs.readFileSync(path.resolve(root, notesPath), 'utf8') : (arg('notes') ?? '');
  const rolloutPercent = integer('rollout', 100)!;
  if (rolloutPercent < 0 || rolloutPercent > 100) {
    console.error('--rollout must be between 0 and 100.');
    process.exit(1);
  }
  const minimumSupportedVersion = arg('minimum-supported-version');
  if (minimumSupportedVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(minimumSupportedVersion)) {
    console.error('--minimum-supported-version must be a semver version.');
    process.exit(1);
  }

  const previous = allPublished()
    .filter(
      (envelope) =>
        envelope.payload.channel === channel &&
        envelope.payload.platform === platform &&
        envelope.payload.arch === arch,
    )
    .sort((a, b) => compareVersions(a.payload.version, b.payload.version))
    .at(-1);
  if (previous && compareVersions(version, previous.payload.version) <= 0 && !has('allow-downgrade')) {
    console.error(
      `Version ${version} is not newer than the latest published ${previous.payload.version} for ${platform}/${arch}/${channel}. Use --allow-downgrade only for a deliberate, documented recovery release.`,
    );
    process.exit(1);
  }

  const privateKey = privateKeyPem();
  const keyId = signingKeyId();
  console.log(`Signing ${path.basename(artifactPath)} as ${version} (${channel}/${platform}/${arch})...`);

  return publishUpdate({
    storageDir: updateStorageDir(),
    artifactPath,
    version,
    channel,
    platform,
    arch,
    format,
    notes,
    mandatory: has('mandatory'),
    minimumSupportedVersion: minimumSupportedVersion ?? null,
    minimumOsVersion: arg('minimum-os-version'),
    rolloutPercent,
    draft: has('draft'),
    privateKeyPem: privateKey,
    keyId,
  })
    .then(async (result) => {
      console.log('');
      console.log(`Release id : ${result.envelope.payload.id}`);
      console.log(`Manifest   : ${result.manifestPath}`);
      console.log(`Artifact   : ${result.artifactPath}`);
      console.log(`SHA-256    : ${result.envelope.payload.artifact.sha256}`);
      console.log(`Size       : ${result.envelope.payload.artifact.sizeBytes} bytes`);
      console.log(`Key id     : ${result.envelope.keyId}`);
      console.log(`State      : ${result.draft ? 'draft (not served)' : 'published'}`);
      console.log('');
      if (result.draft) {
        console.log('Drafts live under data/updates/drafts and are never served. Re-run without --draft to publish.');
      } else {
        console.log(
          'Upload data/updates/releases and data/updates/artifacts to the update server, then validate with:',
        );
        console.log('  npm run update:release -- validate');
      }
    })
    .catch((error: unknown) => {
      console.error(`Publish failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

function commandList(): void {
  const published = listReleaseEnvelopes(updateStorageDir());
  const drafts = listDraftEnvelopes(updateStorageDir());
  if (published.length === 0 && drafts.length === 0) {
    console.log('No releases or drafts exist in the update store.');
    return;
  }
  const rows = [
    ...published.map((entry) => ({ ...entry, draft: false })),
    ...drafts.map((entry) => ({ ...entry, draft: true })),
  ].sort((a, b) => Date.parse(b.envelope.payload.publishedAt) - Date.parse(a.envelope.payload.publishedAt));
  for (const row of rows) {
    const p = row.envelope.payload;
    console.log(
      [
        p.version.padEnd(14),
        p.channel.padEnd(7),
        `${p.platform}/${p.arch}`.padEnd(20),
        (p.paused ? 'paused' : row.draft ? 'draft' : 'published').padEnd(10),
        `rollout ${String(p.rolloutPercent).padStart(3)}%`,
        p.id,
      ].join('  '),
    );
  }
}

function commandState(change: 'pause' | 'resume' | 'rollout'): void {
  const id = required('id');
  const privateKey = privateKeyPem();
  const keyId = signingKeyId();
  const patch: { paused?: boolean; rolloutPercent?: number } =
    change === 'pause'
      ? { paused: true }
      : change === 'resume'
        ? { paused: false }
        : { rolloutPercent: integer('percent') ?? 100 };
  if (change === 'rollout') {
    const percent = patch.rolloutPercent!;
    if (percent < 0 || percent > 100) {
      console.error('--percent must be between 0 and 100.');
      process.exit(1);
    }
  }
  try {
    const envelope = updateReleaseState(updateStorageDir(), id, patch, privateKey, keyId);
    console.log(
      `Updated ${envelope.payload.id}: paused=${envelope.payload.paused} rollout=${envelope.payload.rolloutPercent}%`,
    );
    console.log('The metadata was re-signed. Clients will see the change on their next check.');
  } catch (error) {
    console.error(`State change failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function commandValidate(): Promise<void> {
  const only = arg('id');
  const publicKey = publicKeyPem();
  if (!publicKey) {
    console.error('No public key is configured; cannot validate releases.');
    process.exit(1);
  }
  const entries = listReleaseEnvelopes(updateStorageDir()).filter(
    (entry) => !only || entry.envelope.payload.id === only,
  );
  if (entries.length === 0) {
    console.error(only ? `Release ${only} not found.` : 'No published releases found.');
    process.exit(1);
  }
  let failures = 0;
  for (const entry of entries) {
    const envelope = entry.envelope;
    const verification = verifyReleaseEnvelope(envelope, publicKey);
    const digestOk = verifyArtifactDigest(
      envelope.payload.artifact.sha256,
      envelope.payload.artifact.digestSignature,
      publicKey,
    );
    let artifactMessage = 'missing';
    let artifactOk = false;
    try {
      const file = resolveArtifactFile(updateStorageDir(), envelope.payload.artifact.path);
      if (fs.existsSync(file)) {
        const hash = await sha256File(file);
        const size = fs.statSync(file).size;
        artifactOk = hash === envelope.payload.artifact.sha256 && size === envelope.payload.artifact.sizeBytes;
        artifactMessage = artifactOk ? 'verified' : 'hash or size mismatch';
      }
    } catch (error) {
      artifactMessage = error instanceof Error ? error.message : String(error);
    }
    const ok = verification.valid && digestOk && artifactOk;
    if (!ok) failures += 1;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'}  ${envelope.payload.version.padEnd(14)} ${envelope.payload.platform}/${envelope.payload.arch}  ${envelope.payload.id}`,
    );
    if (!ok) {
      console.log(
        `      manifest: ${verification.error ?? 'ok'}; digest: ${digestOk ? 'ok' : 'invalid'}; artifact: ${artifactMessage}`,
      );
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} release(s) failed validation. Do not serve this update store until it is repaired.`);
    process.exit(1);
  }
  console.log(`\nAll ${entries.length} release(s) verified against the configured public key.`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case 'publish':
      await commandPublish();
      return;
    case 'list':
      commandList();
      return;
    case 'pause':
      commandState('pause');
      return;
    case 'resume':
      commandState('resume');
      return;
    case 'rollout':
      commandState('rollout');
      return;
    case 'validate':
      await commandValidate();
      return;
    default:
      console.error('Usage: tsx scripts/update-release.ts <publish|list|pause|resume|rollout|validate> [options]');
      console.error('Run with no command or --help for examples.');
      if (!command || command === '--help') {
        console.error('');
        console.error('  publish  --artifact <file> --version <semver> --platform windows|linux --arch x86_64|aarch64');
        console.error('           [--format nsis|msi|appimage|deb|rpm|portable] [--channel stable|beta]');
        console.error('           [--notes-file <file>] [--mandatory] [--minimum-supported-version <semver>]');
        console.error('           [--minimum-os-version <value>] [--rollout 0-100] [--draft] [--allow-downgrade]');
        console.error('  list');
        console.error('  pause    --id <release-id>');
        console.error('  resume   --id <release-id>');
        console.error('  rollout  --id <release-id> --percent <0-100>');
        console.error('  validate [--id <release-id>]');
      }
      process.exit(command ? 1 : 0);
  }
}

void main();
