import path from 'node:path';

/** Resolve `candidate` and assert it stays inside `root`. Throws on traversal. */
export function resolveInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '') return resolved;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathPolicyError(`Path escapes the allowed root: ${candidate}`);
  }
  return resolved;
}

export class PathPolicyError extends Error {
  code = 'PATH_TRAVERSAL';
}

/** Normalize separators and reject NUL bytes + control characters in user paths. */
export function normalizeUserPath(input: string): string {
  if (!input || input.includes('\0')) throw new PathPolicyError('Invalid path');
  // Control characters are rejected intentionally to keep stored paths printable.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(input)) throw new PathPolicyError('Path contains control characters');
  return path.normalize(input.trim());
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function validateProjectPath(input: string): string {
  const normalized = normalizeUserPath(input);
  if (process.platform === 'win32') {
    if (/[<>:"|?*]/.test(normalized.replace(/^[A-Za-z]:/, ''))) {
      throw new PathPolicyError('Path contains characters that are invalid on Windows');
    }
    const base = path.basename(normalized);
    if (WINDOWS_RESERVED.test(base)) throw new PathPolicyError('Reserved Windows device name');
  }
  return normalized;
}

/** Case-insensitive containment check on Windows, exact elsewhere. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
