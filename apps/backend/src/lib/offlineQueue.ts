import fs from 'node:fs';
import path from 'node:path';
import type { OfflineQueueItem } from '@zethub/shared-types';
import { OfflineQueueItemSchema } from '@zethub/shared-types';

/**
 * Durable offline queue. It is a local JSON-lines journal, not a replacement
 * for the MySQL application database. Items are idempotent by id.
 */
export class OfflineQueue {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'offline-queue.jsonl');
  }

  append(
    item: Omit<OfflineQueueItem, 'attempts' | 'lastError' | 'syncedAt'> &
      Partial<Pick<OfflineQueueItem, 'attempts' | 'lastError' | 'syncedAt'>>,
  ): OfflineQueueItem {
    const parsed = OfflineQueueItemSchema.parse({
      attempts: 0,
      lastError: null,
      syncedAt: null,
      ...item,
    });
    fs.appendFileSync(this.file, `${JSON.stringify(parsed)}\n`, 'utf8');
    return parsed;
  }

  list(): OfflineQueueItem[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return OfflineQueueItemSchema.parse(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((v): v is OfflineQueueItem => Boolean(v));
  }

  pending(): OfflineQueueItem[] {
    return this.list().filter((i) => !i.syncedAt);
  }

  has(id: string): boolean {
    return this.list().some((i) => i.id === id);
  }

  private rewrite(items: OfflineQueueItem[]): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  markSynced(ids: string[]): void {
    const set = new Set(ids);
    const now = new Date().toISOString();
    const items = this.list().map((i) => (set.has(i.id) ? { ...i, syncedAt: now, lastError: null } : i));
    this.rewrite(items);
  }

  markFailed(id: string, error: string): void {
    const items = this.list().map((i) =>
      i.id === id ? { ...i, attempts: i.attempts + 1, lastError: error.slice(0, 1000) } : i,
    );
    this.rewrite(items);
  }

  stats(): { total: number; pending: number; synced: number; failed: number } {
    const items = this.list();
    return {
      total: items.length,
      pending: items.filter((i) => !i.syncedAt).length,
      synced: items.filter((i) => i.syncedAt).length,
      failed: items.filter((i) => i.lastError && !i.syncedAt).length,
    };
  }
}
