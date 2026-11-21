import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return 'never';
  const date = new Date(value).getTime();
  if (Number.isNaN(date)) return 'never';
  const seconds = Math.round((Date.now() - date) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const STATUS_STYLES: Record<string, string> = {
  passed: 'border-positive/40 bg-positive/10 text-positive',
  healthy: 'border-positive/40 bg-positive/10 text-positive',
  failed: 'border-negative/40 bg-negative/10 text-negative',
  failing: 'border-negative/40 bg-negative/10 text-negative',
  blocked: 'border-warning/40 bg-warning/10 text-warning',
  degraded: 'border-warning/40 bg-warning/10 text-warning',
  timeout: 'border-orange-400/40 bg-orange-400/10 text-orange-300',
  error: 'border-negative/40 bg-negative/10 text-negative',
  running: 'border-cyan/40 bg-cyan/10 text-cyan',
  queued: 'border-line bg-ink-700/60 text-slate-300',
  cancelled: 'border-line bg-ink-700/60 text-slate-400',
  unverified: 'border-accent/40 bg-accent/10 text-accent-soft',
  unknown: 'border-line bg-ink-700/60 text-slate-400',
  skipped: 'border-line bg-ink-700/60 text-slate-400',
  proposed: 'border-accent/40 bg-accent/10 text-accent-soft',
  approved: 'border-cyan/40 bg-cyan/10 text-cyan',
  applied: 'border-warning/40 bg-warning/10 text-warning',
  rejected: 'border-line bg-ink-700/60 text-slate-400',
  verified: 'border-positive/40 bg-positive/10 text-positive',
  connected: 'border-positive/40 bg-positive/10 text-positive',
  passed_with_notes: 'border-warning/40 bg-warning/10 text-warning',
};

export const KIND_LABELS: Record<string, string> = {
  lint: 'Lint',
  typecheck: 'Types',
  format: 'Format',
  unit: 'Unit',
  integration: 'Integration',
  build: 'Build',
  browser: 'Browser',
  api: 'API',
  database: 'Database',
  security: 'Security',
  performance: 'Performance',
  'dependency-audit': 'Dependencies',
  'secret-scan': 'Secrets',
  'static-analysis': 'Static',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
