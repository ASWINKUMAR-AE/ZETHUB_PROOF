import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CredentialStore,
  assertPasswordPolicy,
  constantTimeEqual,
  hashPassword,
  verifyPassword,
} from '../../apps/backend/src/security';
import { assertReadOnlySql } from '../../apps/backend/src/lib/sql-guard';
import { tempDir } from '../helpers';

describe('password storage', () => {
  it('hashes with scrypt and verifies only the correct password', () => {
    const stored = hashPassword('CorrectHorse9');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('CorrectHorse9');
    expect(verifyPassword('CorrectHorse9', stored)).toBe(true);
    expect(verifyPassword('WrongHorse9', stored)).toBe(false);
    expect(verifyPassword('CorrectHorse9', 'not-a-hash')).toBe(false);
  });

  it('enforces the local password policy', () => {
    expect(() => assertPasswordPolicy('short1')).toThrow('at least 10');
    expect(() => assertPasswordPolicy('onlyletters')).toThrow('letter and a number');
    expect(() => assertPasswordPolicy('Password123')).toThrow('too common');
    expect(() => assertPasswordPolicy('Pr0of!Verify2026')).not.toThrow();
  });

  it('compares tokens in constant time', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('encrypted credential store', () => {
  it('encrypts values at rest and only exposes fingerprints', () => {
    const dir = tempDir('zethub-credentials-');
    const store = new CredentialStore(dir, 'test-session-secret');
    const secret = 'db-password-value'; // zethub-secret-scan:ignore test-only fixture
    const fingerprints = store.set('integration:1', { password: secret, user: 'app' });

    expect(store.get('integration:1').password).toBe(secret);
    expect(store.keys('integration:1').sort()).toEqual(['password', 'user']);
    expect(fingerprints.password).not.toBe(secret);
    expect(fingerprints.password).toMatch(/^[a-f0-9]{16}$/);

    const raw = fs.readFileSync(path.join(dir, 'credentials.enc'));
    expect(raw.toString('utf8')).not.toContain(secret);
    expect(raw.length).toBeGreaterThan(28);

    store.delete('integration:1');
    expect(store.get('integration:1')).toEqual({});
  });

  it('cannot decrypt with a different session secret', () => {
    const dir = tempDir('zethub-credentials-');
    new CredentialStore(dir, 'secret-one').set('ref', { token: 'value' });
    const other = new CredentialStore(dir, 'secret-two');
    expect(other.get('ref')).toEqual({});
  });
});

describe('read-only SQL guard', () => {
  it('accepts single read-only statements', () => {
    expect(assertReadOnlySql('SELECT * FROM users LIMIT 5')).toBe('SELECT * FROM users LIMIT 5');
    expect(assertReadOnlySql('WITH c AS (SELECT 1) SELECT * FROM c;')).toBe('WITH c AS (SELECT 1) SELECT * FROM c');
    expect(assertReadOnlySql('SHOW TABLES')).toBe('SHOW TABLES');
    expect(assertReadOnlySql('EXPLAIN SELECT 1')).toBe('EXPLAIN SELECT 1');
  });

  it('rejects multiple statements', () => {
    expect(() => assertReadOnlySql('SELECT 1; SELECT 2')).toThrow('one read-only statement');
  });

  it('rejects writes even inside a CTE or subquery', () => {
    expect(() => assertReadOnlySql('WITH x AS (SELECT 1) DELETE FROM users')).toThrow('write');
    expect(() => assertReadOnlySql('SELECT * FROM users INTO OUTFILE "x"')).toThrow('write');
    expect(() => assertReadOnlySql('DROP TABLE users')).toThrow('read-only');
  });

  it('rejects empty input', () => {
    expect(() => assertReadOnlySql('   ')).toThrow('Enter a read-only SQL statement');
  });
});
