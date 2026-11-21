/**
 * Secret redaction. Applied to every log line, process output and report
 * before it is persisted. Conservative by design: false positives are
 * preferable to leaking credentials.
 */

const KEY_VALUE =
  /\b(password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|authorization|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/gi;

const CONNECTION_URL =
  /\b((?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp|https?):\/\/)([^\s/:@]+):([^\s/@]+)@/gi;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const KNOWN_PREFIXES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk_(live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
];

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g;

export interface RedactionResult {
  text: string;
  replacements: number;
}

export function redactWithCount(input: string): RedactionResult {
  let replacements = 0;
  let text = String(input ?? '');

  text = text.replace(PRIVATE_KEY_BLOCK, () => {
    replacements += 1;
    // zethub-secret-scan:ignore-next-line scanner pattern, not a credential
    return '-----BEGIN PRIVATE KEY-----***REDACTED***-----END PRIVATE KEY-----';
  });

  // Bearer tokens must be handled before key/value matching: otherwise the
  // "authorization" key consumes the literal word "Bearer" and leaves the token.
  text = text.replace(BEARER, () => {
    replacements += 1;
    return 'Bearer ***REDACTED***';
  });

  text = text.replace(KEY_VALUE, (_m, key: string, value: string) => {
    // Keep harmless boolean/string placeholders readable.
    const clean = value.replace(/^["']|["']$/g, '');
    if (clean === '' || clean === '***REDACTED***' || clean === 'undefined' || clean === 'null') {
      return `${key}=${value}`;
    }
    replacements += 1;
    return `${key}=***REDACTED***`;
  });

  text = text.replace(CONNECTION_URL, (_m, scheme: string, user: string) => {
    replacements += 1;
    return `${scheme}${user}:***REDACTED***@`;
  });

  for (const pattern of KNOWN_PREFIXES) {
    text = text.replace(pattern, (m) => {
      replacements += 1;
      return `${m.slice(0, 3)}***REDACTED***`;
    });
  }

  return { text, replacements };
}

export function redact(input: string): string {
  return redactWithCount(input).text;
}

/** Redact recursively for structured evidence such as request/response records. */
export function redactObject<T>(
  value: T,
  sensitiveKeys: RegExp = /password|secret|token|authorization|api[-_]?key|cookie|set-cookie/i,
): T {
  if (Array.isArray(value)) return value.map((v) => redactObject(v, sensitiveKeys)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (sensitiveKeys.test(k)) out[k] = '***REDACTED***';
      else out[k] = redactObject(v, sensitiveKeys);
    }
    return out as T;
  }
  if (typeof value === 'string') return redact(value) as unknown as T;
  return value;
}

/** Bounded output buffer that keeps head and tail for long logs. */
export class BoundedBuffer {
  private head = '';
  private tail = '';
  private truncated = false;
  constructor(private readonly limit = 512 * 1024) {}

  append(chunk: string): void {
    if (this.head.length + this.tail.length + chunk.length <= this.limit) {
      if (this.tail) this.tail += chunk;
      else this.head += chunk;
      return;
    }
    this.truncated = true;
    const combined = this.head + this.tail + chunk;
    const half = Math.floor(this.limit / 3);
    this.head = combined.slice(0, half);
    this.tail = combined.slice(-half);
  }

  value(): { text: string; truncated: boolean } {
    const marker = this.truncated ? '\n…[output truncated by ZetHub Proof]…\n' : '';
    return { text: this.head + marker + this.tail, truncated: this.truncated };
  }
}
