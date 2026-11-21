#!/usr/bin/env node
/**
 * Generate an Ed25519 key pair for signing ZetHub Proof update metadata.
 *
 * The private key must never be committed or shipped with the application.
 * By default both files are written to ./secrets, which is gitignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { generateUpdateKeyPair } from '@zethub/verification-core';

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : null;
}

const force = process.argv.includes('--force');
const outDir = path.resolve(flag('out-dir') ?? 'secrets');
const privatePath = path.join(outDir, 'update-signing-private.pem');
const publicPath = path.join(outDir, 'update-signing-public.pem');

if (!force) {
  for (const file of [privatePath, publicPath]) {
    if (fs.existsSync(file)) {
      console.error(`Refusing to overwrite ${file}. Pass --force only if you intend to rotate the update signing key.`);
      process.exit(1);
    }
  }
}

const keys = generateUpdateKeyPair();
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(privatePath, keys.privateKey, { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(publicPath, keys.publicKey, { encoding: 'utf8', mode: 0o644 });
try {
  fs.chmodSync(outDir, 0o700);
  fs.chmodSync(privatePath, 0o600);
} catch {
  /* Windows ACLs do not map to POSIX modes. Restrict access with NTFS permissions instead. */
}

console.log('Update signing key pair generated.');
console.log(`  private key : ${privatePath}`);
console.log(`  public key  : ${publicPath}`);
console.log(`  key id      : ${keys.keyId}`);
console.log('');
console.log('Keep the private key OUTSIDE the repository and the installer package. Back it up securely.');
console.log('Configure the application with the PUBLIC key only:');
console.log(`  UPDATE_SIGNING_PUBLIC_KEY_PATH=${path.relative(process.cwd(), publicPath).replace(/\\/g, '/')}`);
console.log('Configure the release machine (never the client) with:');
console.log(`  UPDATE_SIGNING_PRIVATE_KEY_PATH=${path.relative(process.cwd(), privatePath).replace(/\\/g, '/')}`);
console.log('');
console.log('Rotating keys makes existing signed metadata unverifiable. Publish new metadata signed with the new key.');
