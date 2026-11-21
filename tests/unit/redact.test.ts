import { describe, expect, it } from 'vitest';
import { BoundedBuffer, redact, redactObject, redactWithCount } from '@zethub/verification-core';

const SECRET = 'hunter2-not-a-real-secret'; // zethub-secret-scan:ignore test-only fixture

describe('secret redaction', () => {
  it('redacts key/value credentials and reports a replacement', () => {
    const result = redactWithCount(`password: "${SECRET}"`);
    expect(result.text).toContain('***REDACTED***');
    expect(result.text).not.toContain(SECRET);
    expect(result.replacements).toBe(1);
  });

  it('redacts the password portion of connection URLs', () => {
    const text = redact(`mysql://app:${SECRET}@127.0.0.1:3306/zethub_proof`);
    expect(text).toBe('mysql://app:***REDACTED***@127.0.0.1:3306/zethub_proof');
  });

  it('redacts bearer tokens and known token prefixes', () => {
    const bearer = 'a'.repeat(24);
    expect(redact(`Authorization: Bearer ${bearer}`)).not.toContain(bearer);

    const githubToken = ['gh', 'p_', 'A'.repeat(36)].join('');
    expect(redact(`token=${githubToken}`)).not.toContain(githubToken);
  });

  it('leaves harmless placeholders readable', () => {
    expect(redact('token=undefined')).toBe('token=undefined');
    expect(redact('secret=null')).toBe('secret=null');
  });

  it('redacts nested objects recursively', () => {
    const redacted = redactObject({
      password: SECRET,
      nested: { apiKey: SECRET, note: `Bearer ${'b'.repeat(20)}` },
      safe: 'visible',
    });
    expect(redacted.password).toBe('***REDACTED***');
    expect(redacted.nested.apiKey).toBe('***REDACTED***');
    expect(redacted.nested.note).not.toContain('b'.repeat(20));
    expect(redacted.safe).toBe('visible');
  });
});

describe('BoundedBuffer', () => {
  it('keeps the head and the tail with an explicit truncation marker', () => {
    const buffer = new BoundedBuffer(60);
    buffer.append('H'.repeat(50));
    buffer.append('T'.repeat(50));
    const value = buffer.value();
    expect(value.truncated).toBe(true);
    expect(value.text).toContain('output truncated');
    expect(value.text.startsWith('H')).toBe(true);
    expect(value.text.endsWith('T')).toBe(true);
    expect(value.text.length).toBeLessThan(120);
  });

  it('does not mark small output as truncated', () => {
    const buffer = new BoundedBuffer(1024);
    buffer.append('small output');
    expect(buffer.value()).toEqual({ text: 'small output', truncated: false });
  });
});
