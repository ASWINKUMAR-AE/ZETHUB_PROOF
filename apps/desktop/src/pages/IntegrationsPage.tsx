import * as React from 'react';
import {
  Bot,
  Boxes,
  Braces,
  CloudOff,
  Database,
  GitBranch,
  Github,
  Globe2,
  KeyRound,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  RefreshCcw,
  ServerCog,
  Trash2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage, useAsync, useDocumentTitle } from '../lib/hooks';
import { parseJsonObject, prettyJson } from '../lib/json';
import { formatDate, timeAgo } from '../lib/utils';
import type { Integration, OfflineQueueItem, OfflineQueueStats, ProjectSummary, SyncQueueItem } from '../types';
import { ConfirmModal, ErrorState, LoadingCard, PageHeader } from '../components/common';
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
  Modal,
  Select,
  Switch,
  Textarea,
} from '../components/ui';

const TYPES = ['GIT', 'GITHUB', 'API', 'DATABASE', 'BROWSER', 'AI', 'CI'] as const;
type IntegrationType = (typeof TYPES)[number];

const TYPE_META: Record<
  IntegrationType,
  { label: string; description: string; icon: React.ReactNode; template: Record<string, unknown> }
> = {
  GIT: {
    label: 'Git repository',
    description: 'Local path or remote URL used for connectivity checks and commit context.',
    icon: <GitBranch className="h-4 w-4" />,
    template: { path: 'D:\\work\\project' },
  },
  GITHUB: {
    label: 'GitHub',
    description: 'Personal access token for repository listing and remote checks.',
    icon: <Github className="h-4 w-4" />,
    template: {},
  },
  API: {
    label: 'HTTP API',
    description: 'Base URL probed with a HEAD request. Credentials are stored encrypted.',
    icon: <Globe2 className="h-4 w-4" />,
    template: { url: 'https://api.example.com/health' },
  },
  DATABASE: {
    label: 'Database',
    description: 'MySQL/MariaDB connection tested with a real handshake. Password is never returned.',
    icon: <Database className="h-4 w-4" />,
    template: { host: '127.0.0.1', port: 3306, user: 'zethub_app', database: 'example' },
  },
  BROWSER: {
    label: 'Browser',
    description: 'Bundled Playwright browsers. No external connection is required.',
    icon: <Boxes className="h-4 w-4" />,
    template: { browser: 'chromium' },
  },
  AI: {
    label: 'AI provider',
    description: 'Provider status is read from server configuration; no code is sent by a connectivity test.',
    icon: <Bot className="h-4 w-4" />,
    template: {},
  },
  CI: {
    label: 'CI pipeline',
    description: 'Metadata placeholder for CI-produced runs. No remote CI API is contacted in this build.',
    icon: <ServerCog className="h-4 w-4" />,
    template: { provider: 'github-actions' },
  },
};

interface IntegrationsBundle {
  items: Integration[];
  projects: ProjectSummary[];
  ai: {
    enabled: boolean;
    configured: boolean;
    provider: string | null;
    model: string | null;
    consentSendCode: boolean;
    note: string;
  };
  offline: { stats: OfflineQueueStats; items: OfflineQueueItem[] };
  sync: { items: SyncQueueItem[]; limitations: string[] };
}

interface GithubRepo {
  id: number;
  name: string;
  private: boolean;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt: string;
}

const EMPTY_FORM = {
  type: 'API' as IntegrationType,
  name: '',
  projectId: '',
  config: '{\n  "url": "https://example.com/health"\n}',
  secrets: '',
  enabled: true,
};

export function IntegrationsPage() {
  useDocumentTitle('Integrations');
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Integration | null>(null);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Integration | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [githubId, setGithubId] = React.useState('');
  const [repos, setRepos] = React.useState<GithubRepo[] | null>(null);
  const [reposError, setReposError] = React.useState<string | null>(null);
  const [reposLoading, setReposLoading] = React.useState(false);

  const { data, error, loading, reload } = useAsync<IntegrationsBundle>(async (signal) => {
    const [integrations, projects, ai, offline, sync] = await Promise.all([
      api.get<{ items: Integration[] }>('/api/v1/integrations', signal),
      api.get<{ items: ProjectSummary[] }>('/api/v1/projects?archived=all&sort=name', signal),
      api.get<IntegrationsBundle['ai']>('/api/v1/ai/status', signal),
      api.get<IntegrationsBundle['offline']>('/api/v1/offline/queue', signal),
      api.get<IntegrationsBundle['sync']>('/api/v1/sync/queue', signal),
    ]);
    return { items: integrations.items, projects: projects.items, ai, offline, sync };
  }, []);

  const integrations = data?.items ?? [];
  const projects = data?.projects ?? [];
  const githubIntegrations = integrations.filter((item) => item.type === 'github');

  React.useEffect(() => {
    if (!githubId && githubIntegrations[0]) setGithubId(githubIntegrations[0].id);
  }, [githubId, githubIntegrations]);

  function openCreate(type: IntegrationType = 'API') {
    setEditing(null);
    setForm({ ...EMPTY_FORM, type, config: prettyJson(TYPE_META[type].template) });
    setFormError(null);
    setEditorOpen(true);
  }

  function openEdit(integration: Integration) {
    setEditing(integration);
    setForm({
      type: integration.type.toUpperCase() as IntegrationType,
      name: integration.name,
      projectId: integration.projectId ?? '',
      config: prettyJson(integration.config),
      secrets: '',
      enabled: integration.enabled,
    });
    setFormError(null);
    setEditorOpen(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const config = parseJsonObject(form.config, 'Configuration');
      const secrets = form.secrets.trim() ? parseJsonObject(form.secrets, 'Secrets') : undefined;
      if (editing) {
        await api.patch(`/api/v1/integrations/${editing.id}`, {
          name: form.name.trim(),
          config,
          enabled: form.enabled,
          ...(secrets ? { secrets } : {}),
        });
        toast.success('Integration updated.');
      } else {
        await api.post('/api/v1/integrations', {
          type: form.type,
          name: form.name.trim(),
          config,
          enabled: form.enabled,
          projectId: form.projectId || null,
          ...(secrets ? { secrets } : {}),
        });
        toast.success('Integration created.');
      }
      setEditorOpen(false);
      reload();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function test(integration: Integration) {
    setBusy(`test-${integration.id}`);
    try {
      const result = await api.post<{ ok: boolean; message: string; latencyMs: number }>(
        `/api/v1/integrations/${encodeURIComponent(integration.id)}/test`,
      );
      toast[result.ok ? 'success' : 'error'](`${integration.name}: ${result.message} (${result.latencyMs} ms)`);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(`delete-${deleting.id}`);
    try {
      await api.del(`/api/v1/integrations/${encodeURIComponent(deleting.id)}`);
      toast.success('Integration removed. Its encrypted credential entry was deleted.');
      setDeleting(null);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function loadRepos() {
    if (!githubId) {
      setReposError('Add a GitHub integration with a token first.');
      return;
    }
    setReposLoading(true);
    setReposError(null);
    try {
      const result = await api.get<{ items: GithubRepo[] }>(
        `/api/v1/integrations/github/repos?integrationId=${encodeURIComponent(githubId)}`,
      );
      setRepos(result.items);
      toast.success(`${result.items.length} repositories loaded from GitHub.`);
    } catch (caught) {
      setReposError(errorMessage(caught));
      setRepos(null);
    } finally {
      setReposLoading(false);
    }
  }

  async function syncOffline() {
    setBusy('offline-sync');
    try {
      const result = await api.post<{ synced: number; message: string }>('/api/v1/offline/sync');
      toast.success(result.message);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <LoadingCard label="Loading integrations…" />;
  if (error || !data) return <ErrorState error={error ?? 'Integrations unavailable.'} onRetry={reload} />;

  const projectName = (id: string | null) =>
    projects.find((project) => project.id === id)?.name ?? (id ? id.slice(0, 8) : 'Global');

  return (
    <div className="fade-in">
      <PageHeader
        title="Integrations"
        description="Optional connections to repositories, APIs, databases and AI providers. Secrets are encrypted at rest and never returned by the API."
        icon={<Plug className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" onClick={reload}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button onClick={() => openCreate()}>
              <Plus className="h-4 w-4" /> New integration
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-3.5">
          <div className="text-[9.5px] uppercase tracking-[0.12em] text-muted">Integrations</div>
          <div className="mt-1.5 text-xl font-semibold text-white">{integrations.length}</div>
          <div className="text-[10px] text-slate-500">{integrations.filter((item) => item.enabled).length} enabled</div>
        </Card>
        <Card className="p-3.5">
          <div className="text-[9.5px] uppercase tracking-[0.12em] text-muted">Connected</div>
          <div className="mt-1.5 text-xl font-semibold text-positive">
            {integrations.filter((item) => item.status === 'connected').length}
          </div>
          <div className="text-[10px] text-slate-500">Last connectivity checks</div>
        </Card>
        <Card className="p-3.5">
          <div className="text-[9.5px] uppercase tracking-[0.12em] text-muted">Offline queue</div>
          <div className="mt-1.5 text-xl font-semibold text-warning">{data.offline.stats.pending}</div>
          <div className="text-[10px] text-slate-500">
            {data.offline.stats.synced} acknowledged · {data.offline.stats.total} total
          </div>
        </Card>
        <Card className="p-3.5">
          <div className="text-[9.5px] uppercase tracking-[0.12em] text-muted">AI assistance</div>
          <div className="mt-1.5 text-[13px] font-semibold text-slate-200">
            {data.ai.configured
              ? `${data.ai.provider} · ${data.ai.model}`
              : data.ai.enabled
                ? 'Enabled · incomplete'
                : 'Disabled'}
          </div>
          <div className="text-[10px] text-slate-500">Opt-in only. No automatic calls.</div>
        </Card>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {TYPES.map((type) => (
          <button
            key={type}
            onClick={() => openCreate(type)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-ink-900/60 px-2.5 py-1.5 text-[11px] text-slate-400 transition hover:border-line-strong hover:text-slate-200"
          >
            {TYPE_META[type].icon} {TYPE_META[type].label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.45fr_1fr]">
        <Card>
          <CardHeader
            title="Configured integrations"
            description="Connectivity tests contact the real target. Unavailable providers report the actual failure."
            icon={<Plug className="h-4 w-4" />}
            actions={<Badge tone="accent">{integrations.length} configured</Badge>}
          />
          <CardBody className="p-0">
            {integrations.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  icon={<Plug className="h-5 w-5" />}
                  title="No integrations configured"
                  description="Integrations are optional. Add one when a project needs a database, API base URL, GitHub token or AI provider."
                  action={
                    <Button size="sm" onClick={() => openCreate()}>
                      <Plus className="h-3.5 w-3.5" /> Add integration
                    </Button>
                  }
                />
              </div>
            ) : (
              <div className="divide-y divide-line-soft">
                {integrations.map((integration) => {
                  const meta = TYPE_META[integration.type.toUpperCase() as IntegrationType] ?? TYPE_META.API;
                  return (
                    <div key={integration.id} className="p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-2.5">
                          <div className="mt-0.5 rounded-lg border border-line bg-ink-800 p-1.5 text-accent-soft">
                            {meta.icon}
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[13px] font-semibold text-slate-200">
                                {integration.name}
                              </span>
                              <Badge tone="accent">{integration.type}</Badge>
                              {integration.enabled ? <Badge tone="positive">enabled</Badge> : <Badge>disabled</Badge>}
                              <Badge
                                tone={
                                  integration.status === 'connected'
                                    ? 'positive'
                                    : integration.status === 'error'
                                      ? 'negative'
                                      : 'default'
                                }
                              >
                                {integration.status}
                              </Badge>
                            </div>
                            <div className="mt-0.5 text-[10.5px] text-slate-500">{meta.description}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-600">
                              <span>Project: {projectName(integration.projectId)}</span>
                              <span>·</span>
                              <span>{integration.credentials.length} stored secret(s)</span>
                              <span>·</span>
                              <span>
                                {integration.lastCheckedAt
                                  ? `checked ${timeAgo(integration.lastCheckedAt)}`
                                  : 'never tested'}
                              </span>
                            </div>
                            {integration.credentials.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {integration.credentials.map((credential) => (
                                  <span
                                    key={credential.keyName}
                                    className="inline-flex items-center gap-1 rounded border border-line-soft bg-ink-900/50 px-1.5 py-0.5 font-mono text-[9px] text-slate-500"
                                    title={`${credential.storage} · fingerprint ${credential.fingerprint}`}
                                  >
                                    <KeyRound className="h-2.5 w-2.5" /> {credential.keyName} ·{' '}
                                    {credential.fingerprint.slice(0, 8)}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            {Object.keys(integration.config).length > 0 ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-[10px] text-slate-500 hover:text-slate-300">
                                  Configuration (non-secret)
                                </summary>
                                <pre className="mt-1 max-h-[160px] overflow-auto rounded-lg border border-line-soft bg-ink-950/70 p-2 font-mono text-[10px] text-slate-400">
                                  {prettyJson(integration.config)}
                                </pre>
                              </details>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void test(integration)}
                            loading={busy === `test-${integration.id}`}
                          >
                            <Zap className="h-3.5 w-3.5" /> Test
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => openEdit(integration)} title="Edit">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDeleting(integration)} title="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader
              title="AI assistance"
              description="Read from server configuration. AI is opt-in and never invoked automatically."
              icon={<Bot className="h-4 w-4" />}
            />
            <CardBody className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge tone={data.ai.enabled ? 'positive' : 'default'}>
                  {data.ai.enabled ? 'enabled' : 'disabled'}
                </Badge>
                <Badge tone={data.ai.configured ? 'accent' : 'warning'}>
                  {data.ai.configured ? 'configured' : 'incomplete'}
                </Badge>
                {data.ai.consentSendCode ? (
                  <Badge tone="warning">code sharing allowed</Badge>
                ) : (
                  <Badge>no code sharing</Badge>
                )}
              </div>
              <div className="grid gap-1 text-[11px]">
                <div className="flex justify-between gap-3 border-b border-line-soft py-1.5">
                  <span className="text-muted">Provider</span>
                  <span className="text-slate-300">{data.ai.provider ?? '—'}</span>
                </div>
                <div className="flex justify-between gap-3 border-b border-line-soft py-1.5">
                  <span className="text-muted">Model</span>
                  <span className="text-slate-300">{data.ai.model ?? '—'}</span>
                </div>
              </div>
              <p className="text-[10.5px] leading-relaxed text-slate-500">{data.ai.note}</p>
              <Alert tone="info" title="Honest boundary">
                If no provider is configured, AI endpoints return a real “unavailable” error. ZetHub Proof never
                fabricates AI scenarios or patches.
              </Alert>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="GitHub repositories"
              description="Uses the token stored in the selected GitHub integration."
              icon={<Github className="h-4 w-4" />}
              actions={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void loadRepos()}
                  loading={reposLoading}
                  disabled={!githubId}
                >
                  <RefreshCcw className="h-3.5 w-3.5" /> Load
                </Button>
              }
            />
            <CardBody className="space-y-3">
              {githubIntegrations.length === 0 ? (
                <p className="text-[11.5px] leading-relaxed text-slate-500">
                  No GitHub integration exists. Create one with a personal access token to list repositories.
                </p>
              ) : (
                <Field label="GitHub integration">
                  <Select value={githubId} onChange={(event) => setGithubId(event.target.value)}>
                    {githubIntegrations.map((integration) => (
                      <option key={integration.id} value={integration.id}>
                        {integration.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {reposError ? (
                <Alert tone="danger" title="Repositories unavailable">
                  {reposError}
                </Alert>
              ) : null}
              {repos ? (
                repos.length === 0 ? (
                  <p className="text-[11.5px] text-slate-500">The token can see no repositories.</p>
                ) : (
                  <div className="max-h-[280px] space-y-1.5 overflow-y-auto">
                    {repos.map((repo) => (
                      <div key={repo.id} className="rounded-lg border border-line-soft bg-ink-900/40 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[11.5px] text-slate-200">{repo.name}</span>
                          {repo.private ? <Badge tone="warning">private</Badge> : <Badge>public</Badge>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[9.5px] text-slate-600">
                          <span>{repo.defaultBranch}</span>
                          <span>updated {formatDate(repo.updatedAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Offline queue"
            description="Local journal of events that could not be delivered while the database or network was unavailable."
            icon={<CloudOff className="h-4 w-4" />}
            actions={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void syncOffline()}
                loading={busy === 'offline-sync'}
                disabled={data.offline.stats.pending === 0}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Acknowledge
              </Button>
            }
          />
          <CardBody className="p-0">
            <div className="grid grid-cols-3 gap-2 border-b border-line-soft p-3">
              <div className="rounded-lg border border-line-soft bg-ink-900/40 p-2 text-center">
                <div className="text-[9px] uppercase tracking-[0.1em] text-muted">Pending</div>
                <div className="mt-0.5 text-sm font-semibold text-warning">{data.offline.stats.pending}</div>
              </div>
              <div className="rounded-lg border border-line-soft bg-ink-900/40 p-2 text-center">
                <div className="text-[9px] uppercase tracking-[0.1em] text-muted">Synced</div>
                <div className="mt-0.5 text-sm font-semibold text-positive">{data.offline.stats.synced}</div>
              </div>
              <div className="rounded-lg border border-line-soft bg-ink-900/40 p-2 text-center">
                <div className="text-[9px] uppercase tracking-[0.1em] text-muted">Total</div>
                <div className="mt-0.5 text-sm font-semibold text-slate-200">{data.offline.stats.total}</div>
              </div>
            </div>
            {data.offline.items.length === 0 ? (
              <p className="p-4 text-[11.5px] text-slate-500">
                The queue is empty. Entries appear only when local delivery fails.
              </p>
            ) : (
              <div className="max-h-[260px] overflow-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Created</th>
                      <th>Attempts</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.offline.items
                      .slice(-30)
                      .reverse()
                      .map((item) => (
                        <tr key={item.id}>
                          <td className="font-mono text-[10px]">{item.type}</td>
                          <td className="text-[10px] text-muted">{timeAgo(item.createdAt)}</td>
                          <td className="text-[10px]">{item.attempts}</td>
                          <td>
                            {item.syncedAt ? (
                              <Badge tone="positive">synced</Badge>
                            ) : (
                              <Badge tone="warning">pending</Badge>
                            )}
                            {item.lastError ? (
                              <div
                                className="mt-0.5 max-w-[160px] truncate text-[9px] text-negative"
                                title={item.lastError}
                              >
                                {item.lastError}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="border-t border-line-soft px-3.5 py-2 text-[10px] leading-relaxed text-slate-600">
              Acknowledging writes an audit record and marks entries synced. Payloads stay in the local journal for
              traceability.
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Sync queue"
            description="Records staged for a future remote transport. This build does not contact a remote server."
            icon={<Braces className="h-4 w-4" />}
            actions={<Badge tone="warning">not implemented</Badge>}
          />
          <CardBody className="space-y-3">
            <Alert tone="warning" title="Remote sync is unavailable">
              <ul className="list-disc space-y-1 pl-4">
                {data.sync.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Alert>
            {data.sync.items.length === 0 ? (
              <p className="text-[11.5px] text-slate-500">No queued records.</p>
            ) : (
              <div className="max-h-[240px] overflow-auto rounded-lg border border-line">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Client</th>
                      <th>Status</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sync.items.map((item) => (
                      <tr key={item.id}>
                        <td className="font-mono text-[10px]">{item.type}</td>
                        <td
                          className="max-w-[120px] truncate font-mono text-[9.5px] text-slate-500"
                          title={item.clientId}
                        >
                          {item.clientId}
                        </td>
                        <td>
                          <Badge>{item.status}</Badge>
                        </td>
                        <td className="text-[10px] text-muted">{timeAgo(item.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Modal
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title={editing ? 'Edit integration' : 'New integration'}
        description="Only public configuration is listed back to the client. Secrets are sent once and stored in the encrypted credential file."
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="integration-form" loading={saving}>
              {editing ? 'Save changes' : 'Create integration'}
            </Button>
          </>
        }
      >
        <form id="integration-form" className="space-y-4" onSubmit={save}>
          {formError ? (
            <Alert tone="danger" title="Could not save">
              {formError}
            </Alert>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <Select
                value={form.type}
                onChange={(event) => {
                  const type = event.target.value as IntegrationType;
                  setForm({ ...form, type, config: prettyJson(TYPE_META[type].template) });
                }}
                disabled={Boolean(editing)}
              >
                {TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_META[type].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Staging API"
                required
                maxLength={120}
              />
            </Field>
          </div>
          {!editing ? (
            <Field label="Project scope" hint="Global integrations are available to every project.">
              <Select value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
                <option value="">Global</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Configuration (JSON)" hint={TYPE_META[form.type].description}>
            <Textarea
              className="min-h-[150px] font-mono text-[11px]"
              value={form.config}
              onChange={(event) => setForm({ ...form, config: event.target.value })}
              spellCheck={false}
            />
          </Field>
          <Field
            label={editing ? 'Rotate secrets (JSON, optional)' : 'Secrets (JSON, optional)'}
            hint={
              editing
                ? 'Only keys you include are overwritten. Existing secrets are never displayed.'
                : 'Example: {"token":"github_pat_…"} or {"password":"…"}. Stored encrypted; never returned by the API.'
            }
          >
            <Textarea
              className="min-h-[90px] font-mono text-[11px]"
              value={form.secrets}
              onChange={(event) => setForm({ ...form, secrets: event.target.value })}
              placeholder='{"token":"…"}'
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Switch
            checked={form.enabled}
            onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
            label="Enabled"
            description="Disabled integrations are kept but not used for new plans."
          />
        </form>
      </Modal>

      <ConfirmModal
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete integration?"
        description="The integration record and its encrypted credential entry are removed. Existing runs and results are unchanged."
        confirmLabel="Delete integration"
        tone="danger"
        onConfirm={remove}
      >
        <p className="text-sm text-slate-300">
          <span className="font-semibold text-white">{deleting?.name}</span> will no longer be available to plans.
        </p>
      </ConfirmModal>
    </div>
  );
}
