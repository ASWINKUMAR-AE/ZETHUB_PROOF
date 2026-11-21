import * as React from 'react';
import { AlertCircle, Clipboard, Check, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, Button, Card, CodeBlock, Modal, Spinner } from './ui';
import { cn, copyToClipboard } from '../lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  icon,
  breadcrumb,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-1.5 text-[11.5px] text-muted">{breadcrumb}</div> : null}
        <div className="flex items-center gap-3">
          {icon ? (
            <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.08] to-accent-deep/25 p-2.5 text-lavender shadow-[inset_0_1px_0_rgba(255,255,255,.08)]">
              {icon}
            </div>
          ) : null}
          <div className="min-w-0">
            <h1 className="truncate text-[24px] font-semibold tracking-tight text-white">{title}</h1>
            {description ? (
              <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-muted">{description}</p>
            ) : null}
          </div>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: string; onRetry?: () => void; className?: string }) {
  return (
    <Card className={cn('p-5', className)}>
      <Alert tone="danger" title="Could not load this view">
        <div className="space-y-3">
          <p>{error}</p>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCw className="h-3.5 w-3.5" /> Retry
            </Button>
          ) : null}
        </div>
      </Alert>
    </Card>
  );
}

export function LoadingCard({ label = 'Loading…' }: { label?: string }) {
  return (
    <Card className="flex items-center justify-center gap-2.5 py-16 text-sm text-muted">
      <Spinner /> {label}
    </Card>
  );
}

export function ConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  onConfirm,
  children,
  requireText,
  requireTextLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  onConfirm: () => Promise<void> | void;
  children?: React.ReactNode;
  requireText?: string;
  requireTextLabel?: string;
}) {
  const [loading, setLoading] = React.useState(false);
  const [typed, setTyped] = React.useState('');

  React.useEffect(() => {
    if (!open) {
      setTyped('');
      setLoading(false);
    }
  }, [open]);

  const blocked = requireText !== undefined && typed !== requireText;

  async function handleConfirm() {
    if (blocked) return;
    setLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={handleConfirm}
            loading={loading}
            disabled={blocked}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {children}
        {requireText !== undefined ? (
          <div className="space-y-1.5">
            <div className="text-xs text-slate-400">
              {requireTextLabel ?? 'Type to confirm'}: <span className="font-mono text-warning">{requireText}</span>
            </div>
            <input
              className="input"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function CopyButton({
  value,
  label = 'Copy',
  size = 'sm',
  variant = 'ghost',
}: {
  value: string;
  label?: string;
  size?: 'sm' | 'md' | 'icon';
  variant?: 'ghost' | 'outline' | 'secondary';
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={async () => {
        try {
          await copyToClipboard(value);
          setCopied(true);
          toast.success('Copied to clipboard.');
          setTimeout(() => setCopied(false), 1600);
        } catch {
          toast.error('Clipboard access was denied.');
        }
      }}
      title={label}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
      {size !== 'icon' ? <span>{copied ? 'Copied' : label}</span> : null}
    </Button>
  );
}

export function ProgressBar({ completed, total, className }: { completed: number; total: number; className?: string }) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-ink-700', className)}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-accent to-cyan transition-all duration-500"
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

export function KeyValue({
  label,
  children,
  mono = false,
  stacked = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
        <div className="text-[10px] uppercase tracking-[0.1em] text-muted">{label}</div>
        <div className={cn('mt-0.5 break-all text-[12.5px] text-slate-200', mono && 'font-mono text-[11.5px]')}>
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line-soft py-2 last:border-0">
      <span className="text-[11.5px] uppercase tracking-[0.08em] text-muted">{label}</span>
      <span
        className={cn('min-w-0 break-all text-right text-[12.5px] text-slate-300', mono && 'font-mono text-[11.5px]')}
      >
        {children}
      </span>
    </div>
  );
}

export function JsonPreview({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  return (
    <CodeBlock className="overflow-auto" style={{ maxHeight }}>
      {JSON.stringify(value, null, 2)}
    </CodeBlock>
  );
}

export function InlineAlert({ children }: { children: React.ReactNode }) {
  return (
    <Alert tone="info">
      <span className="text-slate-300">{children}</span>
    </Alert>
  );
}

export { CodeBlock };

export function EmptyIcon() {
  return <AlertCircle className="h-5 w-5" />;
}
