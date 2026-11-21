import * as React from 'react';
import { KeyRound, RefreshCw, ShieldCheck, UserCheck, UserPlus, UserX, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage, useAsync } from '../lib/hooks';
import { formatDate, timeAgo } from '../lib/utils';
import { useAuth } from '../providers/AuthProvider';
import type { ManagedUser, UserRole, UsersBundle } from '../types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Select,
} from './ui';
import { ConfirmModal, CopyButton, ErrorState, KeyValue } from './common';

const ROLE_TONE: Record<UserRole, 'default' | 'accent' | 'warning'> = {
  OWNER: 'accent',
  ADMIN: 'default',
  VIEWER: 'warning',
};

const ROLE_HINT: Record<UserRole, string> = {
  OWNER: 'Full control, including account management.',
  ADMIN: 'Full workspace access and can manage most accounts.',
  VIEWER: 'Read-only access to the workspace they own.',
};

const EMPTY_FORM = { name: '', email: '', role: 'ADMIN' as UserRole, password: '' };

interface CredentialReveal {
  name: string;
  email: string;
  role: UserRole;
  password: string;
  reason: 'created' | 'reset';
}

export function UsersSettingsTab() {
  const { user } = useAuth();
  const isOwner = user?.role.toUpperCase() === 'OWNER';
  const { data, error, loading, reload } = useAsync<UsersBundle>((signal) => api.get('/api/v1/users', signal), []);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [credentials, setCredentials] = React.useState<CredentialReveal | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [disableTarget, setDisableTarget] = React.useState<ManagedUser | null>(null);
  const [resetTarget, setResetTarget] = React.useState<ManagedUser | null>(null);

  if (loading) return <LoadingBlock label="Loading accounts…" />;
  if (error || !data) return <ErrorState error={error ?? 'Accounts unavailable.'} onRetry={reload} />;

  const disabledCount = data.items.filter((item) => item.disabled).length;

  function openCreate() {
    setForm(EMPTY_FORM);
    setCreateError(null);
    setCreateOpen(true);
  }

  function canManage(target: ManagedUser): boolean {
    if (!user || target.id === user.id) return false;
    if (isOwner) return true;
    return target.role !== 'OWNER';
  }

  function canResetPassword(target: ManagedUser): boolean {
    if (!canManage(target)) return false;
    return isOwner || target.role === 'VIEWER';
  }

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const result = await api.post<{
        user: ManagedUser;
        temporaryPassword: string | null;
        generatedPassword: boolean;
      }>('/api/v1/users', {
        name: form.name.trim(),
        email: form.email.trim(),
        role: form.role,
        ...(form.password ? { password: form.password } : {}),
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      toast.success(`${result.user.name} can now sign in.`);
      if (result.temporaryPassword) {
        setCredentials({
          name: result.user.name,
          email: result.user.email,
          role: result.user.role,
          password: result.temporaryPassword,
          reason: 'created',
        });
      }
      reload();
    } catch (caught) {
      setCreateError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  }

  async function updateRole(target: ManagedUser, role: UserRole) {
    if (role === target.role) return;
    setBusyId(target.id);
    try {
      await api.patch(`/api/v1/users/${encodeURIComponent(target.id)}`, { role });
      toast.success(`${target.name} is now ${role.toLowerCase()}.`);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function toggleDisabled(target: ManagedUser) {
    setBusyId(target.id);
    try {
      await api.patch(`/api/v1/users/${encodeURIComponent(target.id)}`, { disabled: !target.disabled });
      toast.success(target.disabled ? `${target.name} can sign in again.` : `${target.name} was disabled.`);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(target: ManagedUser) {
    setBusyId(target.id);
    try {
      const result = await api.post<{ temporaryPassword: string | null }>(
        `/api/v1/users/${encodeURIComponent(target.id)}/reset-password`,
        {},
      );
      toast.success('Temporary password generated. Existing sessions were revoked.');
      if (result.temporaryPassword) {
        setCredentials({
          name: target.name,
          email: target.email,
          role: target.role,
          password: result.temporaryPassword,
          reason: 'reset',
        });
      }
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  const roleChoices: UserRole[] = isOwner ? ['OWNER', 'ADMIN', 'VIEWER'] : ['ADMIN', 'VIEWER'];

  return (
    <div className="space-y-4">
      <Alert tone="info" title="Accounts are separate workspaces">
        Each account signs in with its own email and password, and sees only the projects it owns. Accounts are disabled
        rather than deleted, so their projects, runs and reports stay intact. Share a project by exporting a capsule;
        there is no shared workspace in this build.
      </Alert>

      <Card>
        <CardHeader
          title="User accounts"
          description="Create as many local accounts as you need. Passwords are stored as scrypt hashes and are never shown again after creation."
          icon={<Users className="h-4 w-4" />}
          actions={
            <>
              <Button variant="outline" size="sm" onClick={reload}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
              <Button size="sm" onClick={openCreate}>
                <UserPlus className="h-3.5 w-3.5" /> New account
              </Button>
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-5 py-3">
          <Badge tone="accent">{data.active} active</Badge>
          <Badge>{data.total} total</Badge>
          {disabledCount > 0 ? <Badge tone="negative">{disabledCount} disabled</Badge> : null}
          <span className="text-[11px] text-slate-500">
            {isOwner
              ? 'You can create owners, admins and viewers.'
              : 'Only an owner can create or manage owner accounts.'}
          </span>
        </div>
        <CardBody className="p-0">
          {data.items.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No accounts"
                description="Create the first account to let someone else use this installation."
                icon={<Users className="h-5 w-5" />}
                action={
                  <Button size="sm" onClick={openCreate}>
                    <UserPlus className="h-3.5 w-3.5" /> New account
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="divide-y divide-line-soft">
              {data.items.map((item) => {
                const isSelf = item.id === user?.id;
                const manageable = canManage(item);
                const resetAllowed = canResetPassword(item);
                return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-white/[0.02] lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13.5px] font-medium text-slate-100">{item.name}</span>
                        {isSelf ? <Badge tone="accent">you</Badge> : null}
                        <Badge tone={ROLE_TONE[item.role]}>{item.role.toLowerCase()}</Badge>
                        <Badge tone={item.disabled ? 'negative' : 'positive'}>
                          {item.disabled ? 'disabled' : 'active'}
                        </Badge>
                      </div>
                      <div className="break-all font-mono text-[11px] text-slate-400">{item.email}</div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-slate-500">
                        <span>
                          {item.projectCount} project{item.projectCount === 1 ? '' : 's'}
                        </span>
                        <span title={item.lastLoginAt ? formatDate(item.lastLoginAt) : undefined}>
                          {item.lastLoginAt ? `Last sign-in ${timeAgo(item.lastLoginAt)}` : 'Never signed in'}
                        </span>
                        <span title={formatDate(item.createdAt)}>Created {timeAgo(item.createdAt)}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      <Select
                        className="h-8 w-[112px] py-1 text-[12px]"
                        value={item.role}
                        onChange={(event) => void updateRole(item, event.target.value as UserRole)}
                        disabled={!manageable || busyId === item.id}
                        aria-label={`Role for ${item.name}`}
                        title={manageable ? 'Change role' : 'Only an owner can change this role'}
                      >
                        {(roleChoices.includes(item.role) ? roleChoices : [item.role, ...roleChoices]).map((role) => (
                          <option key={role} value={role}>
                            {role.charAt(0) + role.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setResetTarget(item)}
                        disabled={!resetAllowed || busyId === item.id}
                        title={resetAllowed ? 'Reset password' : 'You cannot reset this account’s password'}
                      >
                        <KeyRound className="h-3.5 w-3.5" /> Reset
                      </Button>
                      {item.disabled ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void toggleDisabled(item)}
                          loading={busyId === item.id}
                          disabled={!manageable}
                        >
                          <UserCheck className="h-3.5 w-3.5" /> Enable
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setDisableTarget(item)}
                          disabled={!manageable || busyId === item.id}
                          title={manageable ? 'Disable account' : 'You cannot disable this account'}
                        >
                          <UserX className="h-3.5 w-3.5" /> Disable
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <div className="rounded-xl border border-line-soft bg-ink-900/40 p-4 text-[11px] leading-relaxed text-slate-500">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-lavender" />
          <p>
            Roles: <span className="text-slate-300">owner</span> manages every account,{' '}
            <span className="text-slate-300">admin</span> manages non-owner accounts and full workspace data, and{' '}
            <span className="text-slate-300">viewer</span> is read-only. At least one active owner must always remain.
            Disabling an account revokes its sessions immediately; its data is retained.
          </p>
        </div>
      </div>

      <Modal
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setCreateError(null);
        }}
        title="New account"
        description="The new account gets its own empty workspace. Roles control what it can do, not which projects it can see."
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" form="create-user-form" loading={creating}>
              <UserPlus className="h-4 w-4" /> Create account
            </Button>
          </>
        }
      >
        <form id="create-user-form" className="space-y-4" onSubmit={submitCreate}>
          {createError ? (
            <Alert tone="danger" title="Could not create the account">
              {createError}
            </Alert>
          ) : null}
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="A. Person"
              autoComplete="off"
              required
              maxLength={120}
            />
          </Field>
          <Field label="Email" hint="Used to sign in. Must be unique.">
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="person@example.com"
              autoComplete="off"
              required
              maxLength={190}
              spellCheck={false}
            />
          </Field>
          <Field label="Role" hint={ROLE_HINT[form.role]}>
            <Select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as UserRole })}>
              {roleChoices.map((role) => (
                <option key={role} value={role}>
                  {role.charAt(0) + role.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Password (optional)"
            hint="Leave blank to generate a one-time temporary password. The account can change it after signing in."
          >
            <Input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              placeholder="At least 10 characters"
              autoComplete="new-password"
              minLength={10}
              maxLength={200}
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={credentials !== null}
        onOpenChange={(open) => {
          if (!open) setCredentials(null);
        }}
        title="Temporary password"
        description="This value is shown once and cannot be retrieved later."
        width="md"
        footer={
          <>
            <CopyButton value={credentials?.password ?? ''} label="Copy password" variant="secondary" />
            <Button onClick={() => setCredentials(null)}>Done</Button>
          </>
        }
      >
        {credentials ? (
          <div className="space-y-4">
            <Alert tone="warning" title="Share this securely">
              Send the password through a private channel. The account holder should change it from Settings → Sessions
              &amp; tokens after signing in.
            </Alert>
            <div className="space-y-1">
              <KeyValue label="Account">
                {credentials.name} · <span className="font-mono">{credentials.email}</span>
              </KeyValue>
              <KeyValue label="Role">{credentials.role.toLowerCase()}</KeyValue>
              <KeyValue label="Reason">{credentials.reason === 'created' ? 'New account' : 'Password reset'}</KeyValue>
            </div>
            <div>
              <div className="label">Password</div>
              <code className="mt-1.5 block break-all rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5 font-mono text-[12.5px] text-warning">
                {credentials.password}
              </code>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmModal
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisableTarget(null);
        }}
        title={`Disable ${disableTarget?.name ?? 'this account'}?`}
        description="The account cannot sign in, and all of its active sessions are revoked immediately. Its projects, runs and reports are kept."
        confirmLabel="Disable account"
        tone="danger"
        onConfirm={() => (disableTarget ? toggleDisabled(disableTarget) : undefined)}
      />

      <ConfirmModal
        open={resetTarget !== null}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
        title={`Reset the password for ${resetTarget?.name ?? 'this account'}?`}
        description="A new temporary password is generated and every active session for that account is revoked. The password is shown once."
        confirmLabel="Reset password"
        onConfirm={() => (resetTarget ? resetPassword(resetTarget) : undefined)}
      />
    </div>
  );
}
