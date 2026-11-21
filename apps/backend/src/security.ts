import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, r: 8, p: 1 }).toString('hex');
  return `scrypt$${SCRYPT_COST}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, cost, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !cost || !salt || !hash) return false;
    const computed = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: Number(cost), r: 8, p: 1 });
    const expected = Buffer.from(hash, 'hex');
    return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function fingerprint(value: string): string {
  return sha256(value).slice(0, 16);
}

/** Password policy for local accounts. */
export function assertPasswordPolicy(password: string): void {
  if (password.length < 10) throw new Error('Password must be at least 10 characters.');
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
    throw new Error('Password must contain a letter and a number.');
  if (
    /^(password|passw0rd|admin|administrator|1234567890|12345678|qwertyuiop|letmein)[0-9!@#$%^&*._-]*$/i.test(password)
  ) {
    throw new Error('Password is too common.');
  }
}

/**
 * Encrypted credential file protected by the local session secret.
 * Values never leave the backend; only fingerprints are exposed.
 */
export class CredentialStore {
  private readonly file: string;
  private readonly key: Buffer;

  constructor(dataDir: string, sessionSecret: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'credentials.enc');
    this.key = crypto.scryptSync(sessionSecret, 'zethub-proof-credentials-v1', 32);
  }

  private readAll(): Record<string, Record<string, string>> {
    if (!fs.existsSync(this.file)) return {};
    try {
      const raw = fs.readFileSync(this.file);
      if (raw.length < 12) return {};
      const nonce = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ciphertext = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      return JSON.parse(plaintext) as Record<string, Record<string, string>>;
    } catch {
      return {};
    }
  }

  private writeAll(values: Record<string, Record<string, string>>): void {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([nonce, tag, ciphertext]), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  set(ref: string, values: Record<string, string>): Record<string, string> {
    const all = this.readAll();
    all[ref] = { ...(all[ref] ?? {}), ...values };
    this.writeAll(all);
    return Object.fromEntries(Object.entries(all[ref]).map(([k, v]) => [k, fingerprint(v)]));
  }

  get(ref: string): Record<string, string> {
    return { ...(this.readAll()[ref] ?? {}) };
  }

  delete(ref: string): void {
    const all = this.readAll();
    delete all[ref];
    this.writeAll(all);
  }

  keys(ref: string): string[] {
    return Object.keys(this.readAll()[ref] ?? {});
  }
}
