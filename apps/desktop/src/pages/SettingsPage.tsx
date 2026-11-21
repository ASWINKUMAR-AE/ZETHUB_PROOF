import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import type { UserSettings } from '@zethub/shared-types';
import {
  Bell,
  Bot,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Cpu,
  Database,
  DownloadCloud,
  Fingerprint,
  KeyRound,
  ListChecks,
  Monitor,
  RefreshCw,
  Save,
  ServerCog,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage, useAsync, useDocumentTitle } from '../lib/hooks';
import { copyToClipboard, formatDate, formatDuration, timeAgo } from '../lib/utils';
import type { AuditItem, NotificationItem, SessionItem, SystemInfo } from '../types';
import { useAuth } from '../providers/AuthProvider';
import { ChangePasswordCard } from '../components/ChangePasswordCard';
import { UsersSettingsTab } from '../components/UsersSettingsTab';
import { CopyButton, ErrorState, KeyValue, LoadingCard, PageHeader } from '../components/common';
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
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui';
import { UpdatesSettingsTab } from '../components/UpdateSettingsTab';

interface SettingsBundle {
  settings: UserSettings;
  sessions: SessionItem[];
  system: SystemInfo;
  notifications: NotificationItem[];
}

const TABS = [
  { value: 'preferences', label: 'Preferences', icon: <SlidersHorizontal className="h-3.5 w-3.5" /> },
  { value: 'users', label: 'Users', icon: <Users className="h-3.5 w-3.5" /> },
  { value: 'updates', label: 'Updates', icon: <DownloadCloud className="h-3.5 w-3.5" /> },
  { value: 'sessions', label: 'Sessions & tokens', icon: <KeyRound className="h-3.5 w-3.5" /> },
  { value: 'notifications', label: 'Notifications', icon: <Bell className="h-3.5 w-3.5" /> },
  { value: 'audit', label: 'Audit log', icon: <ListChecks className="h-3.5 w-3.5" /> },
  { value: 'system', label: 'System', icon: <ServerCog className="h-3.5 w-3.5" /> },
];

/** Account management is owner/admin only; the tab is hidden for other roles. */
function canManageUsers(role: string | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

function visibleTabs(role: string | undefined) {
  return TABS.filter((tab) => tab.value !== 'users' || canManageUsers(role));
}

const DEFAULTS: UserSettings = {
  theme: 'dark',
  language: 'en',
  defaultProjectDir: null,
  maxParallelTests: 2,
  defaultTimeoutMs: 300_000,
  artifactRetentionDays: 30,
  offlineMode: 'auto',
  aiEnabled: false,
  aiConsentSendCode: false,
  aiProvider: null,
  aiModel: null,
  telemetry: false,
  defaultBrowser: 'chromium',
  screenshotOnFailureOnly: true,
  requireCommandApproval: true,
  updateChannel: 'stable',
  updateAutoCheck: true,
  updateCheckIntervalMinutes: 360,
  updateSkippedVersion: null,
};

export function SettingsPage() {
  useDocumentTitle('Settings');
  const { user, settings: authSettings, applySettings } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const visible = visibleTabs(user?.role);
  const activeTab = visible.some((tab) => tab.value === searchParams.get('tab'))
    ? searchParams.get('tab')!
    : 'preferences';

  const [draft, setDraft] = React.useState<UserSettings>(authSettings ?? DEFAULTS);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [token, setToken] = React.useState<{ token: string; note: string } | null>(null);
  const [tokenOpen, setTokenOpen] = React.useState(false);
  const [tokenBusy, setTokenBusy] = React.useState(false);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [marking, setMarking] = React.useState(false);
  const [auditPage, setAuditPage] = React.useState(1);

  const { data, error, loading, reload } = useAsync<SettingsBundle>(async (signal) => {
    const [settings, sessions, system, notifications] = await Promise.all([
      api.get<{ settings: UserSettings }>('/api/v1/settings', signal),
      api.get<{ items: SessionItem[] }>('/api/v1/auth/sessions', signal),
      api.get<SystemInfo>('/api/v1/system/info', signal),
      api.get<{ items: NotificationItem[]; unread: number }>('/api/v1/notifications', signal),
    ]);
    return { settings: settings.settings, sessions: sessions.items, system, notifications: notifications.items };
  }, []);

  const audit = useAsync<{ items: AuditItem[]; total: number; page: number; pageSize: number }>(
    (signal) => api.get(`/api/v1/audit?page=${auditPage}&pageSize=50`, signal),
    [auditPage],
  );

  React.useEffect(() => {
    if (data?.settings) setDraft(data.settings);
  }, [data?.settings]);

  async function savePreferences(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.put<{ settings: UserSettings }>('/api/v1/settings', draft);
      applySettings(result.settings);
      setDraft(result.settings);
      toast.success('Preferences saved to the local database.');
      reload();
    } catch (caught) {
      setSaveError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function createDeviceToken() {
    setTokenBusy(true);
    try {
      const result = await api.post<{ token: string; note: string }>('/api/v1/auth/device-token');
      setToken(result);
      setTokenOpen(true);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setTokenBusy(false);
    }
  }

  async function revokeSession(session: SessionItem) {
    setRevoking(session.id);
    try {
      await api.del(`/api/v1/auth/sessions/${encodeURIComponent(session.id)}`);
      toast.success('Session revoked.');
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setRevoking(null);
    }
  }

  async function markAllRead() {
    setMarking(true);
    try {
      const unread = data?.notifications.filter((item) => !item.readAt) ?? [];
      for (const item of unread) await api.post(`/api/v1/notifications/${encodeURIComponent(item.id)}/read`);
      toast.success(unread.length === 0 ? 'No unread notifications.' : `${unread.length} notification(s) marked read.`);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setMarking(false);
    }
  }

  if (loading) return <LoadingCard label="Loading settings…" />;
  if (error || !data) return <ErrorState error={error ?? 'Settings unavailable.'} onRetry={reload} />;

  const { system } = data;
  const unread = data.notifications.filter((item) => !item.readAt).length;
  const totalAuditPages = audit.data ? Math.max(1, Math.ceil(audit.data.total / audit.data.pageSize)) : 1;

  return (
    <div className="fade-in">
      <PageHeader
        title="Settings"
        description="Local preferences, sessions, notifications, audit history and runtime information. Every value is read from or written to the local API."
        icon={<Settings2 className="h-5 w-5" />}
        actions={
          <Button
            variant="outline"
            onClick={() => {
              reload();
              audit.reload();
            }}
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />

      <Tabs value={activeTab} onValueChange={(value) => setSearchParams({ tab: value }, { replace: true })}>
        <TabsList>
          {visible.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              count={
                tab.value === 'notifications'
                  ? unread || undefined
                  : tab.value === 'sessions'
                    ? data.sessions.length
                    : undefined
              }
            >
              {tab.icon}
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="users">
          <UsersSettingsTab />
        </TabsContent>

        <TabsContent value="updates">
          <UpdatesSettingsTab
            draft={draft}
            setDraft={setDraft}
            saving={saving}
            saveError={saveError}
            onSave={savePreferences}
          />
        </TabsContent>

        <TabsContent value="preferences">
          <form onSubmit={savePreferences} className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="Workspace defaults"
                  description="Applied to new plans and runs. Existing runs keep their stored values."
                  icon={<Settings2 className="h-4 w-4" />}
                />
                <CardBody className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Default project directory"
                    hint="Suggested folder when adding a local project."
                    className="sm:col-span-2"
                  >
                    <Input
                      value={draft.defaultProjectDir ?? ''}
                      onChange={(event) => setDraft({ ...draft, defaultProjectDir: event.target.value.trim() || null })}
                      placeholder="D:\work"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="Max parallel tests" hint="Between 1 and 8.">
                    <Input
                      type="number"
                      min={1}
                      max={8}
                      value={draft.maxParallelTests}
                      onChange={(event) => setDraft({ ...draft, maxParallelTests: Number(event.target.value) })}
                    />
                  </Field>
                  <Field label="Default timeout (ms)" hint="Between 5 seconds and 1 hour.">
                    <Input
                      type="number"
                      min={5000}
                      max={3_600_000}
                      step={1000}
                      value={draft.defaultTimeoutMs}
                      onChange={(event) => setDraft({ ...draft, defaultTimeoutMs: Number(event.target.value) })}
                    />
                  </Field>
                  <Field
                    label="Artifact retention (days)"
                    hint="Cleanup is manual in this build; the value is stored for future retention runs."
                  >
                    <Input
                      type="number"
                      min={1}
                      max={3650}
                      value={draft.artifactRetentionDays}
                      onChange={(event) => setDraft({ ...draft, artifactRetentionDays: Number(event.target.value) })}
                    />
                  </Field>
                  <Field label="Default browser">
                    <Select
                      value={draft.defaultBrowser}
                      onChange={(event) =>
                        setDraft({ ...draft, defaultBrowser: event.target.value as UserSettings['defaultBrowser'] })
                      }
                    >
                      <option value="chromium">Chromium</option>
                      <option value="firefox">Firefox</option>
                      <option value="webkit">WebKit</option>
                    </Select>
                  </Field>
                  <Field
                    label="Theme"
                    hint="The current build ships a single dark theme; the preference is stored for the desktop shell."
                  >
                    <Select
                      value={draft.theme}
                      onChange={(event) => setDraft({ ...draft, theme: event.target.value as UserSettings['theme'] })}
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                      <option value="system">System</option>
                    </Select>
                  </Field>
                  <Field label="Offline mode">
                    <Select
                      value={draft.offlineMode}
                      onChange={(event) =>
                        setDraft({ ...draft, offlineMode: event.target.value as UserSettings['offlineMode'] })
                      }
                    >
                      <option value="auto">Auto</option>
                      <option value="always">Always</option>
                      <option value="never">Never</option>
                    </Select>
                  </Field>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Safety and evidence"
                  description="These defaults govern approval friction, not whether evidence is recorded."
                  icon={<ShieldCheck className="h-4 w-4" />}
                />
                <CardBody className="space-y-2">
                  <Switch
                    checked={draft.requireCommandApproval}
                    onCheckedChange={(checked) => setDraft({ ...draft, requireCommandApproval: checked })}
                    label="Require command approval"
                    description="Plans mark externally invoking checks for explicit approval before executing. Keep this on unless you fully trust the project."
                  />
                  <Switch
                    checked={draft.screenshotOnFailureOnly}
                    onCheckedChange={(checked) => setDraft({ ...draft, screenshotOnFailureOnly: checked })}
                    label="Screenshots on failure only"
                    description="Capture browser screenshots only when a step fails, reducing artifact size."
                  />
                  <Switch
                    checked={draft.telemetry}
                    onCheckedChange={(checked) => setDraft({ ...draft, telemetry: checked })}
                    label="Telemetry preference"
                    description="This build never sends telemetry. The preference is stored, and nothing leaves the machine."
                    disabled
                  />
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="AI assistance"
                  description="Optional. AI is never called automatically, and generated output is never treated as verified evidence."
                  icon={<Bot className="h-4 w-4" />}
                />
                <CardBody className="space-y-3">
                  <Switch
                    checked={draft.aiEnabled}
                    onCheckedChange={(checked) => setDraft({ ...draft, aiEnabled: checked })}
                    label="Enable AI features"
                    description="Server-level AI_ENABLED also has to be true and a provider configured for calls to succeed."
                  />
                  <Switch
                    checked={draft.aiConsentSendCode}
                    onCheckedChange={(checked) => setDraft({ ...draft, aiConsentSendCode: checked })}
                    label="Allow sending selected source context"
                    description="When both server and user consent are enabled, project manifests may be included. Never sends environment secrets."
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Preferred provider">
                      <Input
                        value={draft.aiProvider ?? ''}
                        onChange={(event) => setDraft({ ...draft, aiProvider: event.target.value.trim() || null })}
                        placeholder="openai / anthropic"
                      />
                    </Field>
                    <Field label="Preferred model">
                      <Input
                        value={draft.aiModel ?? ''}
                        onChange={(event) => setDraft({ ...draft, aiModel: event.target.value.trim() || null })}
                        placeholder="model id"
                      />
                    </Field>
                  </div>
                  <Alert tone="info" title="Honest limitation">
                    Preferences do not override server configuration. Check Integrations for the effective AI provider
                    state.
                  </Alert>
                </CardBody>
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="Your account"
                  description="Your role decides what this install shows you. Create additional accounts under Settings → Users; every account owns a separate workspace."
                  icon={<Fingerprint className="h-4 w-4" />}
                />
                <CardBody className="space-y-1">
                  <KeyValue label="Name">{user?.name ?? '—'}</KeyValue>
                  <KeyValue label="Email" mono>
                    {user?.email ?? '—'}
                  </KeyValue>
                  <KeyValue label="Role">
                    <Badge tone="accent">{user?.role.toLowerCase() ?? '—'}</Badge>
                  </KeyValue>
                  <KeyValue label="User ID" mono>
                    {user?.id ?? '—'}
                  </KeyValue>
                </CardBody>
              </Card>

              <Card className="sticky top-20">
                <CardHeader
                  title="Save preferences"
                  description="Writes the full settings object with schema validation."
                  icon={<Save className="h-4 w-4" />}
                />
                <CardBody className="space-y-3">
                  {saveError ? (
                    <Alert tone="danger" title="Save failed">
                      {saveError}
                    </Alert>
                  ) : null}
                  <div className="rounded-lg border border-line-soft bg-ink-900/40 p-3 text-[10.5px] leading-relaxed text-slate-500">
                    Changes affect future plans and UI defaults. They are stored in MySQL, not in browser storage.
                  </div>
                  <Button type="submit" className="w-full" loading={saving}>
                    <Save className="h-4 w-4" /> Save preferences
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={() => setDraft(data.settings)}
                    disabled={saving}
                  >
                    Reset to saved values
                  </Button>
                </CardBody>
              </Card>
            </div>
          </form>
        </TabsContent>

        <TabsContent value="sessions">
          <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardHeader
                title="Active sessions"
                description="Database-backed sessions. Revoking one takes effect immediately for its next request."
                icon={<KeyRound className="h-4 w-4" />}
                actions={<Badge tone="accent">{data.sessions.length} active</Badge>}
              />
              <CardBody className="p-0">
                {data.sessions.length === 0 ? (
                  <div className="p-5">
                    <EmptyState
                      title="No active sessions"
                      description="This should not happen while you are signed in. Refresh the page."
                      icon={<KeyRound className="h-5 w-5" />}
                    />
                  </div>
                ) : (
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>Client</th>
                        <th>IP</th>
                        <th>Created</th>
                        <th>Last seen</th>
                        <th>Expires</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.sessions.map((session) => (
                        <tr key={session.id}>
                          <td>
                            <div
                              className="max-w-[260px] truncate text-[11px] text-slate-300"
                              title={session.userAgent ?? ''}
                            >
                              {session.userAgent ?? 'device token'}
                            </div>
                            <div className="font-mono text-[9px] text-slate-600">{session.id.slice(0, 12)}</div>
                          </td>
                          <td className="font-mono text-[10px] text-slate-400">{session.ip ?? '—'}</td>
                          <td className="text-[10px] text-muted" title={formatDate(session.createdAt)}>
                            {timeAgo(session.createdAt)}
                          </td>
                          <td className="text-[10px] text-muted" title={formatDate(session.lastSeenAt)}>
                            {timeAgo(session.lastSeenAt)}
                          </td>
                          <td className="text-[10px] text-muted">{formatDate(session.expiresAt)}</td>
                          <td className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void revokeSession(session)}
                              loading={revoking === session.id}
                              title="Revoke session"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardBody>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="Device token"
                  description="For CLI or browser-extension clients over loopback. Shown once."
                  icon={<KeyRound className="h-4 w-4" />}
                />
                <CardBody className="space-y-3">
                  <Alert tone="warning" title="Treat this like a password">
                    A device token grants access to this local instance. It is displayed once and only its hash is
                    stored.
                  </Alert>
                  <Button
                    className="w-full"
                    onClick={() => void createDeviceToken()}
                    loading={tokenBusy}
                    disabled={user?.role !== 'OWNER'}
                  >
                    <KeyRound className="h-4 w-4" /> Generate device token
                  </Button>
                  {user?.role !== 'OWNER' ? (
                    <p className="text-[10.5px] text-slate-500">Only the owner role can create tokens in this build.</p>
                  ) : null}
                  <div className="rounded-lg border border-line-soft bg-ink-900/40 p-3 text-[10.5px] leading-relaxed text-slate-500">
                    Use <span className="font-mono text-slate-400">Authorization: Bearer &lt;token&gt;</span> with the
                    local API. State-changing bearer requests still require the session CSRF token in this build.
                  </div>
                </CardBody>
              </Card>

              <ChangePasswordCard />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="notifications">
          <Card>
            <CardHeader
              title="Notifications"
              description="Generated by verification runs and database maintenance."
              icon={<Bell className="h-4 w-4" />}
              actions={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void markAllRead()}
                  loading={marking}
                  disabled={unread === 0}
                >
                  Mark all read
                </Button>
              }
            />
            <CardBody className="p-0">
              {data.notifications.length === 0 ? (
                <div className="p-5">
                  <EmptyState
                    title="No notifications"
                    description="Run verification or database maintenance to generate local notifications."
                    icon={<Bell className="h-5 w-5" />}
                  />
                </div>
              ) : (
                <div className="divide-y divide-line-soft">
                  {data.notifications.map((item) => (
                    <div key={item.id} className={`px-4 py-3 ${item.readAt ? '' : 'bg-accent/5'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[12.5px] font-medium text-slate-200">{item.title}</span>
                            <Badge>{item.type}</Badge>
                            {item.readAt ? null : <Badge tone="accent">new</Badge>}
                          </div>
                          {item.body ? (
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{item.body}</p>
                          ) : null}
                        </div>
                        <span className="shrink-0 text-[10px] text-slate-600" title={formatDate(item.createdAt)}>
                          {timeAgo(item.createdAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader
              title="Audit log"
              description="Security-relevant actions recorded by the API. Newest first."
              icon={<ListChecks className="h-4 w-4" />}
              actions={
                <Button size="sm" variant="ghost" onClick={audit.reload}>
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </Button>
              }
            />
            <CardBody className="p-0">
              {audit.loading ? (
                <LoadingBlock label="Loading audit log…" />
              ) : audit.error ? (
                <div className="p-4">
                  <ErrorState error={audit.error} onRetry={audit.reload} />
                </div>
              ) : !audit.data || audit.data.items.length === 0 ? (
                <div className="p-5">
                  <EmptyState
                    title="No audit entries"
                    description="Audit events appear after sign-in, project changes, runs and database actions."
                    icon={<ListChecks className="h-5 w-5" />}
                  />
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="table-base">
                      <thead>
                        <tr>
                          <th>Action</th>
                          <th>Entity</th>
                          <th>User</th>
                          <th>IP</th>
                          <th>Metadata</th>
                          <th>When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.data.items.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <Badge
                                tone={
                                  item.action.includes('DENIED')
                                    ? 'negative'
                                    : item.action.includes('DELETE')
                                      ? 'warning'
                                      : 'default'
                                }
                              >
                                {item.action}
                              </Badge>
                            </td>
                            <td>
                              <div className="text-[11px] text-slate-300">{item.entityType}</div>
                              <div className="font-mono text-[9px] text-slate-600">
                                {item.entityId?.slice(0, 14) ?? '—'}
                              </div>
                            </td>
                            <td className="font-mono text-[9.5px] text-slate-500">
                              {item.userId?.slice(0, 10) ?? 'system'}
                            </td>
                            <td className="font-mono text-[10px] text-slate-500">{item.ip ?? '—'}</td>
                            <td className="max-w-[260px]">
                              <div
                                className="truncate font-mono text-[9.5px] text-slate-500"
                                title={item.metadata ? JSON.stringify(item.metadata) : ''}
                              >
                                {item.metadata ? JSON.stringify(item.metadata) : '—'}
                              </div>
                            </td>
                            <td className="text-[10px] text-muted" title={formatDate(item.createdAt)}>
                              {timeAgo(item.createdAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-line-soft px-4 py-3 text-[11px] text-muted">
                    <span>
                      Page {audit.data.page} of {totalAuditPages} · {audit.data.total} entries
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAuditPage((page) => Math.max(1, page - 1))}
                        disabled={audit.data.page <= 1}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" /> Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAuditPage((page) => Math.min(totalAuditPages, page + 1))}
                        disabled={audit.data.page >= totalAuditPages}
                      >
                        Next <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="system">
          <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="Runtime"
                  description="Captured from the running API process."
                  icon={<Cpu className="h-4 w-4" />}
                  actions={<Badge tone="accent">v{system.version}</Badge>}
                />
                <CardBody className="space-y-1">
                  <KeyValue label="Node" mono>
                    {system.node}
                  </KeyValue>
                  <KeyValue label="Platform" mono>
                    {system.platform} · {system.arch}
                  </KeyValue>
                  <KeyValue label="Hostname" mono>
                    {system.hostname}
                  </KeyValue>
                  <KeyValue label="Root" mono>
                    {system.cwd}
                  </KeyValue>
                  <KeyValue label="Artifacts" mono>
                    {system.artifactsDir}
                  </KeyValue>
                  <KeyValue label="Backups" mono>
                    {system.backupsDir}
                  </KeyValue>
                  <KeyValue label="API bind" mono>
                    {system.config.apiHost}:{system.config.apiPort}
                  </KeyValue>
                  <KeyValue label="Max parallel tests">{system.config.maxParallelTests}</KeyValue>
                  <KeyValue label="Default timeout">{formatDuration(system.config.defaultCommandTimeoutMs)}</KeyValue>
                  <KeyValue label="Retention">{system.config.artifactRetentionDays} days</KeyValue>
                  <KeyValue label="Workspace roots" mono>
                    {system.config.workspaceRoots.length ? system.config.workspaceRoots.join(', ') : 'not restricted'}
                  </KeyValue>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Database"
                  description="Live readiness from the API's own connection."
                  icon={<Database className="h-4 w-4" />}
                  actions={
                    <Badge tone={system.db.reachable ? 'positive' : 'negative'}>
                      {system.db.reachable ? 'reachable' : 'offline'}
                    </Badge>
                  }
                />
                <CardBody className="space-y-1">
                  <KeyValue label="Reachable">{system.db.reachable ? 'yes' : 'no'}</KeyValue>
                  {system.db.error ? <KeyValue label="Error">{system.db.error}</KeyValue> : null}
                  {system.db.schema ? (
                    <>
                      <KeyValue label="Tables">{system.db.schema.tableCount}</KeyValue>
                      <KeyValue label="Pending migrations">
                        {system.db.schema.pending.length === 0 ? 'none' : system.db.schema.pending.join(', ')}
                      </KeyValue>
                      <KeyValue label="Applied migrations">{system.db.schema.appliedMigrations.length}</KeyValue>
                    </>
                  ) : null}
                </CardBody>
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="AI state"
                  description="Effective server configuration, not just UI preference."
                  icon={<Sparkles className="h-4 w-4" />}
                />
                <CardBody className="space-y-1">
                  <KeyValue label="Enabled">
                    <Badge tone={system.ai.enabled ? 'positive' : 'default'}>{system.ai.enabled ? 'yes' : 'no'}</Badge>
                  </KeyValue>
                  <KeyValue label="Provider">{system.ai.provider ?? '—'}</KeyValue>
                  <KeyValue label="Model">{system.ai.model ?? '—'}</KeyValue>
                  <KeyValue label="Code sharing consent">{system.ai.consentSendCode ? 'allowed' : 'denied'}</KeyValue>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Desktop shell"
                  description="Tauri packaging status for this installation."
                  icon={<Monitor className="h-4 w-4" />}
                />
                <CardBody className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge tone={system.tauri.available ? 'positive' : 'warning'}>
                      {system.tauri.available ? 'Tauri detected' : 'Web UI mode'}
                    </Badge>
                  </div>
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    This build runs the React UI in a browser against the loopback API. The Tauri shell source is
                    included, but a native bundle has not been produced on this machine because the Rust/MSVC toolchain
                    is not installed.
                  </p>
                  <Alert tone="info" title="What remains local">
                    The API binds to 127.0.0.1, artifacts and backups stay in the configured folders, and credentials
                    are stored in an encrypted file.
                  </Alert>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Copy diagnostics"
                  description="Useful for bug reports without exposing secrets."
                  icon={<ClipboardCopy className="h-4 w-4" />}
                />
                <CardBody className="space-y-2">
                  <pre className="max-h-[180px] overflow-auto rounded-lg border border-line-soft bg-ink-950/70 p-3 font-mono text-[10px] text-slate-400">
                    {[
                      `ZetHub Proof v${system.version}`,
                      `node ${system.node}`,
                      `${system.platform}/${system.arch} ${system.os}`,
                      `db ${system.db.reachable ? 'reachable' : 'offline'}`,
                      `schema ${system.db.schema?.tableCount ?? 0} tables, ${system.db.schema?.pending.length ?? 0} pending`,
                      `ai ${system.ai.enabled ? (system.ai.provider ?? 'enabled') : 'disabled'}`,
                      `tauri ${system.tauri.available ? 'available' : 'not built'}`,
                    ].join('\n')}
                  </pre>
                  <CopyButton
                    value={[
                      `ZetHub Proof v${system.version}`,
                      `node ${system.node}`,
                      `${system.platform}/${system.arch}`,
                      `db ${system.db.reachable ? 'reachable' : 'offline'}`,
                      `schema ${system.db.schema?.tableCount ?? 0} tables`,
                      `ai ${system.ai.enabled ? 'enabled' : 'disabled'}`,
                      `tauri ${system.tauri.available ? 'available' : 'not built'}`,
                    ].join('\n')}
                    label="Copy diagnostics"
                  />
                </CardBody>
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <Modal
        open={tokenOpen}
        onOpenChange={(open) => {
          setTokenOpen(open);
          if (!open) setToken(null);
        }}
        title="Device token created"
        description="Copy it now. The server stores only a hash and cannot show it again."
        width="lg"
        footer={
          <Button
            variant="ghost"
            onClick={() => {
              setTokenOpen(false);
              setToken(null);
            }}
          >
            Close
          </Button>
        }
      >
        {token ? (
          <div className="space-y-3">
            <Alert tone="warning" title="Shown once">
              {token.note}
            </Alert>
            <div className="rounded-lg border border-line bg-ink-950/80 p-3">
              <div className="break-all font-mono text-[11px] text-slate-300">{token.token}</div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  void copyToClipboard(token.token)
                    .then(() => toast.success('Token copied.'))
                    .catch(() => toast.error('Clipboard access was denied.'))
                }
              >
                <ClipboardCopy className="h-4 w-4" /> Copy token
              </Button>
            </div>
            <p className="text-[10.5px] leading-relaxed text-slate-500">
              Use it in the <span className="font-mono">Authorization: Bearer</span> header. Revoke it by deleting the
              corresponding session above. Device tokens do not bypass approvals or role checks.
            </p>
          </div>
        ) : (
          <LoadingBlock />
        )}
      </Modal>
    </div>
  );
}
