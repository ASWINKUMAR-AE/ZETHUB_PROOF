import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EvidenceArtifact, EvidenceKind } from '@zethub/shared-types';
import { resolveInside } from '../utils/paths.js';

export interface WriteEvidenceInput {
  runId: string;
  fileName: string;
  content: string | Buffer;
  kind: EvidenceKind;
  mimeType?: string;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.diff': 'text/x-diff',
};

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export class EvidenceStore {
  constructor(private readonly artifactsRoot: string) {}

  runDir(runId: string): string {
    const safeRun =
      runId
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.{2,}/g, '.')
        .replace(/^\.+/, '')
        .slice(0, 120) || 'run';
    return path.join(this.artifactsRoot, 'runs', safeRun);
  }

  async write(input: WriteEvidenceInput): Promise<EvidenceArtifact> {
    const safeName = input.fileName
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+/, '')
      .slice(0, 180);
    if (!safeName) throw new Error('Invalid evidence file name');
    const dir = this.runDir(input.runId);
    fs.mkdirSync(dir, { recursive: true });
    const abs = resolveInside(dir, safeName);
    const buffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
    fs.writeFileSync(abs, buffer);
    const relativePath = path.posix.join('runs', path.basename(dir), safeName);
    const ext = path.extname(safeName).toLowerCase();
    return {
      kind: input.kind,
      name: safeName,
      relativePath,
      mimeType: input.mimeType ?? MIME[ext] ?? 'application/octet-stream',
      sizeBytes: buffer.byteLength,
      sha256: sha256(buffer),
      createdAt: new Date().toISOString(),
    };
  }

  read(relativePath: string): Buffer {
    const abs = resolveInside(this.artifactsRoot, relativePath);
    return fs.readFileSync(abs);
  }

  absolute(relativePath: string): string {
    return resolveInside(this.artifactsRoot, relativePath);
  }

  exists(relativePath: string): boolean {
    try {
      return fs.existsSync(this.absolute(relativePath));
    } catch {
      return false;
    }
  }

  pruneOlderThan(days: number): { removed: number } {
    if (days <= 0) return { removed: 0 };
    const runsDir = path.join(this.artifactsRoot, 'runs');
    if (!fs.existsSync(runsDir)) return { removed: 0 };
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(runsDir, entry.name);
      try {
        if (fs.statSync(abs).mtimeMs < cutoff) {
          fs.rmSync(abs, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        /* ignore locked files */
      }
    }
    return { removed };
  }
}

/** HMAC manifest allows detecting tampering after report generation. */
export function signManifest(payload: unknown, secret: string): { algorithm: 'sha256'; digest: string } {
  const digest = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  return { algorithm: 'sha256', digest };
}
