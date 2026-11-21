import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { AlertCircle, Check, ChevronDown, Loader2, X } from 'lucide-react';
import { cn, STATUS_STYLES } from '../lib/utils';

/* --------------------------------- button --------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-r from-accent to-accent-deep text-white border border-lavender/20 shadow-[0_10px_34px_-14px_rgba(72,73,169,.9)] hover:from-[#6a6ade] hover:to-[#33347a] focus-visible:ring-lavender/40',
  secondary:
    'bg-white/[0.06] border border-white/10 text-slate-100 hover:bg-white/[0.1] focus-visible:ring-lavender/35',
  ghost: 'bg-transparent text-slate-300 hover:bg-white/[0.055] hover:text-white focus-visible:ring-lavender/30',
  danger: 'bg-ember/15 text-ember-soft border border-ember/30 hover:bg-ember/25 focus-visible:ring-ember/40',
  outline:
    'border border-white/[0.1] bg-white/[0.025] text-slate-200 hover:border-white/20 hover:bg-white/[0.06] focus-visible:ring-lavender/30',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[12.5px] gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-[15px] gap-2',
  icon: 'h-9 w-9',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-full font-medium transition focus:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {children}
    </button>
  );
});

/* ---------------------------------- card ---------------------------------- */

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('panel', className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {icon ? (
          <div className="mt-0.5 rounded-xl border border-white/10 bg-white/[0.045] p-2 text-lavender">{icon}</div>
        ) : null}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('p-5', className)}>{children}</div>;
}

/* --------------------------------- badge ---------------------------------- */

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]',
        STATUS_STYLES[status] ?? STATUS_STYLES.unknown,
        className,
      )}
    >
      {status === 'running' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" /> : null}
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function Badge({
  children,
  className,
  tone = 'default',
}: {
  children: React.ReactNode;
  className?: string;
  tone?: 'default' | 'accent' | 'positive' | 'warning' | 'negative';
}) {
  const tones = {
    default: 'border-line bg-ink-800/80 text-slate-300',
    accent: 'border-accent/30 bg-accent/10 text-accent-soft',
    positive: 'border-positive/30 bg-positive/10 text-positive',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    negative: 'border-negative/30 bg-negative/10 text-negative',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* --------------------------------- inputs --------------------------------- */

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn('input', className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn('textarea', className)} {...props} />;
  },
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <div className="relative">
        <select ref={ref} className={cn('input appearance-none pr-8', className)} {...props}>
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      </div>
    );
  },
);

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label className="label">{label}</label>
      {children}
      {error ? (
        <p className="flex items-center gap-1 text-[11.5px] text-negative">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-[11.5px] leading-relaxed text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  label,
  description,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  description?: string;
}) {
  const control = (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full border border-line transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50',
        checked ? 'bg-accent border-accent' : 'bg-ink-700',
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
        )}
      />
    </SwitchPrimitive.Root>
  );
  if (!label) return control;
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-line-soft bg-ink-900/40 px-3.5 py-3">
      <div>
        <div className="text-sm font-medium text-slate-200">{label}</div>
        {description ? <div className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500">{description}</div> : null}
      </div>
      {control}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 text-sm text-slate-300',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border transition',
          checked ? 'border-accent bg-accent text-white' : 'border-line bg-ink-900',
        )}
      >
        {checked ? <Check className="h-3 w-3" /> : null}
      </span>
      <span className="min-w-0 leading-relaxed">{label}</span>
    </label>
  );
}

/* --------------------------------- dialog --------------------------------- */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'lg',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
}) {
  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', '2xl': 'max-w-6xl' } as const;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[3px] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          className={cn(
            'glass fixed left-1/2 top-1/2 z-50 grid max-h-[92vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-3xl outline-none data-[state=open]:animate-fade-in',
            widths[width],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold text-white">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-xs leading-relaxed text-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close className="rounded-full p-1.5 text-muted transition hover:bg-white/10 hover:text-white">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="overflow-y-auto px-5 py-5">{children}</div>
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.07] bg-black/15 px-5 py-3.5">
              {footer}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ---------------------------------- tabs ---------------------------------- */

export const Tabs = TabsPrimitive.Root;

export function TabsList({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <TabsPrimitive.List
      className={cn(
        'flex flex-wrap items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.025] p-1',
        className,
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({ value, children, count }: { value: string; children: React.ReactNode; count?: number }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium text-muted transition hover:text-slate-200 data-[state=active]:bg-white/[0.09] data-[state=active]:text-white data-[state=active]:shadow-sm"
    >
      {children}
      {typeof count === 'number' ? (
        <span className="rounded-full bg-white/[0.1] px-1.5 py-0.5 text-[10px] text-slate-300">{count}</span>
      ) : null}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.Content value={value} className={cn('mt-4 focus:outline-none', className)}>
      {children}
    </TabsPrimitive.Content>
  );
}

/* -------------------------------- feedback -------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-accent-soft', className)} />;
}

export function LoadingBlock({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2.5 py-16 text-sm text-muted', className)}>
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? <div className="mb-3 rounded-xl border border-line bg-ink-800 p-3 text-accent-soft">{icon}</div> : null}
      <div className="text-sm font-semibold text-slate-200">{title}</div>
      {description ? <div className="mt-1 max-w-md text-xs leading-relaxed text-muted">{description}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Alert({
  tone = 'warning',
  title,
  children,
  icon,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  const tones = {
    info: 'border-cyan/30 bg-cyan/5 text-cyan/90',
    warning: 'border-warning/30 bg-warning/5 text-warning/90',
    danger: 'border-negative/30 bg-negative/5 text-negative/90',
    success: 'border-positive/30 bg-positive/5 text-positive/90',
  } as const;
  return (
    <div className={cn('rounded-xl border px-3.5 py-3 text-xs leading-relaxed', tones[tone])}>
      <div className="flex items-start gap-2">
        {icon ?? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
        <div className="min-w-0">
          {title ? <div className="font-semibold">{title}</div> : null}
          {children ? <div className={cn(title && 'mt-0.5', 'text-slate-300/80')}>{children}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'default' | 'accent' | 'positive' | 'warning' | 'negative' | 'cyan';
}) {
  const tones = {
    default: 'text-white',
    accent: 'text-accent-soft',
    positive: 'text-positive',
    warning: 'text-warning',
    negative: 'text-negative',
    cyan: 'text-cyan',
  } as const;
  return (
    <Card className="relative overflow-hidden p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.13em] text-muted">{label}</div>
          <div className={cn('mt-2 text-2xl font-semibold tracking-tight', tones[tone])}>{value}</div>
          {hint ? <div className="mt-1 text-[11.5px] text-slate-500">{hint}</div> : null}
        </div>
        {icon ? <div className="rounded-lg border border-line bg-ink-800/80 p-2 text-slate-400">{icon}</div> : null}
      </div>
    </Card>
  );
}

export function CodeBlock({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <pre
      style={style}
      className={cn(
        'max-h-[420px] overflow-auto rounded-xl border border-line bg-ink-950/80 p-3.5 font-mono text-[11.5px] leading-relaxed text-slate-300',
        className,
      )}
    >
      {children}
    </pre>
  );
}
