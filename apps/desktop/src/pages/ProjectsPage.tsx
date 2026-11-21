import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  FolderKanban,
  FolderOpen,
  GitBranch,
  Globe2,
  Plus,
  Radar,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage, useAsync, useDebounced, useDocumentTitle } from '../lib/hooks';
import { formatDate, timeAgo } from '../lib/utils';
import type { ProjectSummary } from '../types';
import { ErrorState, LoadingCard, PageHeader } from '../components/common';
import { FolderPicker } from '../components/FolderPicker';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, StatusBadge, Textarea } from '../components/ui';

type SourceType = 'LOCAL' | 'GIT' | 'URL';

const EMPTY_FORM = {
  name: '',
  description: '',
  sourceType: 'LOCAL' as SourceType,
  rootPath: '',
  repoUrl: '',
  websiteUrl: '',
  defaultBranch: '',
};

export function ProjectsPage() {
  useDocumentTitle('Projects');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebounced(search);
  const [archived, setArchived] = React.useState('false');
  const [sort, setSort] = React.useState('recent');
  const [createOpen, setCreateOpen] = React.useState(searchParams.get('new') === '1');
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<ProjectSummary | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const { data, error, loading, reload } = useAsync<{ items: ProjectSummary[]; total: number }>(
    (signal) => {
      const params = new URLSearchParams({ archived, sort });
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      return api.get<{ items: ProjectSummary[]; total: number }>(`/api/v1/projects?${params.toString()}`, signal);
    },
    [debouncedSearch, archived, sort],
  );

  React.useEffect(() => {
    if (searchParams.get('new') === '1') {
      setCreateOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreateOpen(true);
  }

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        sourceType: form.sourceType,
      };
      if (form.sourceType === 'LOCAL' || form.sourceType === 'GIT') payload.rootPath = form.rootPath.trim() || null;
      if (form.sourceType === 'GIT') payload.repoUrl = form.repoUrl.trim() || null;
      if (form.sourceType === 'URL') payload.websiteUrl = form.websiteUrl.trim();
      if (form.defaultBranch.trim()) payload.defaultBranch = form.defaultBranch.trim();
      const result = await api.post<{ project: ProjectSummary }>('/api/v1/projects', payload);
      toast.success(`Project “${result.project.name}” created.`);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      navigate(`/projects/${result.project.id}`);
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function patchProject(project: ProjectSummary, body: Record<string, unknown>, success: string) {
    setBusy(project.id);
    try {
      await api.patch(`/api/v1/projects/${project.id}`, body);
      toast.success(success);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function scanProject(project: ProjectSummary) {
    setBusy(project.id);
    try {
      const result = await api.post<{ detection: { ecosystems: unknown[]; warnings: string[] } }>(
        `/api/v1/projects/${project.id}/scan`,
      );
      toast.success(
        `Scan complete: ${result.detection.ecosystems.length} ecosystem(s), ${result.detection.warnings.length} warning(s).`,
      );
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function deleteProject() {
    if (!deleting) return;
    try {
      await api.del(`/api/v1/projects/${deleting.id}`);
      toast.success('Project records removed. Source files were preserved.');
      setDeleting(null);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  const projects = data?.items ?? [];

  return (
    <div className="fade-in">
      <PageHeader
        title="Projects"
        description="Each project is a folder, repository or website you want to verify. Scanning writes a real detection snapshot."
        icon={<FolderKanban className="h-5 w-5" />}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New project
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 md:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <Input
            className="pl-9"
            placeholder="Search projects, paths or descriptions…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select className="w-[150px]" value={archived} onChange={(event) => setArchived(event.target.value)}>
          <option value="false">Active</option>
          <option value="true">Archived</option>
          <option value="all">All</option>
        </Select>
        <Select className="w-[150px]" value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="recent">Recently updated</option>
          <option value="name">Name</option>
          <option value="health">Health</option>
        </Select>
        <div className="ml-auto text-[11.5px] text-muted">
          {data ? `${data.total} project${data.total === 1 ? '' : 's'}` : '—'}
        </div>
      </div>

      {loading ? (
        <LoadingCard label="Loading projects…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : projects.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            icon={<FolderKanban className="h-5 w-5" />}
            title={debouncedSearch ? 'No projects match this search' : 'No projects yet'}
            description={
              debouncedSearch
                ? 'Try a different search term or change the archive filter.'
                : 'Add a local folder, clone a Git repository or register a website. Scanning is explicit and read-only.'
            }
            action={
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" /> New project
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Card key={project.id} className="flex flex-col p-4 transition hover:border-line-strong">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    to={`/projects/${project.id}`}
                    className="block truncate text-[14.5px] font-semibold text-white hover:text-accent-soft"
                  >
                    {project.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone="accent">{project.sourceType}</Badge>
                    <StatusBadge status={project.health} />
                    {project.pinned ? (
                      <Badge tone="warning">
                        <Star className="h-2.5 w-2.5 fill-current" /> pinned
                      </Badge>
                    ) : null}
                    {project.archived ? <Badge>archived</Badge> : null}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    className="rounded-lg p-1.5 text-muted transition hover:bg-ink-800 hover:text-warning"
                    title={project.pinned ? 'Unpin project' : 'Pin project'}
                    onClick={() =>
                      void patchProject(
                        project,
                        { pinned: !project.pinned },
                        project.pinned ? 'Project unpinned.' : 'Project pinned.',
                      )
                    }
                    disabled={busy === project.id}
                  >
                    <Star className={`h-3.5 w-3.5 ${project.pinned ? 'fill-warning text-warning' : ''}`} />
                  </button>
                  <button
                    className="rounded-lg p-1.5 text-muted transition hover:bg-ink-800 hover:text-white"
                    title={project.archived ? 'Restore project' : 'Archive project'}
                    onClick={() =>
                      void patchProject(
                        project,
                        { archived: !project.archived },
                        project.archived ? 'Project restored.' : 'Project archived.',
                      )
                    }
                    disabled={busy === project.id}
                  >
                    {project.archived ? (
                      <ArchiveRestore className="h-3.5 w-3.5" />
                    ) : (
                      <Archive className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    className="rounded-lg p-1.5 text-muted transition hover:bg-negative/10 hover:text-negative"
                    title="Delete project records"
                    onClick={() => setDeleting(project)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <p className="mt-2 line-clamp-2 min-h-[32px] text-[11.5px] leading-relaxed text-slate-500">
                {project.description || 'No description.'}
              </p>

              <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
                {project.sourceType === 'url' ? (
                  <Globe2 className="h-3.5 w-3.5 text-cyan" />
                ) : project.sourceType === 'git' ? (
                  <GitBranch className="h-3.5 w-3.5 text-accent-soft" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5 text-slate-500" />
                )}
                <span
                  className="truncate font-mono text-[10.5px]"
                  title={project.rootPath ?? project.websiteUrl ?? project.repoUrl ?? ''}
                >
                  {project.rootPath ?? project.websiteUrl ?? project.repoUrl ?? 'No source attached'}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-1">
                {project.ecosystems.length === 0 ? (
                  <span className="text-[10.5px] text-slate-600">Not scanned</span>
                ) : (
                  project.ecosystems.slice(0, 4).map((eco) => (
                    <span key={`${project.id}-${eco.language}-${eco.framework ?? ''}`} className="chip text-[10px]">
                      {eco.language}
                      {eco.framework ? ` · ${eco.framework}` : ''}
                    </span>
                  ))
                )}
              </div>

              <div className="mt-3 grid grid-cols-3 gap-1.5 rounded-lg border border-line-soft bg-ink-900/50 p-2 text-center">
                <div>
                  <div className="text-[13px] font-semibold text-white">{project.counts?.runs ?? 0}</div>
                  <div className="text-[9.5px] uppercase tracking-[0.1em] text-slate-500">Runs</div>
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-white">{project.counts?.cases ?? 0}</div>
                  <div className="text-[9.5px] uppercase tracking-[0.1em] text-slate-500">Cases</div>
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-white">{project.counts?.environments ?? 0}</div>
                  <div className="text-[9.5px] uppercase tracking-[0.1em] text-slate-500">Envs</div>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2 text-[10.5px] text-slate-500">
                <span>
                  {project.lastRun ? (
                    <>
                      Last run <StatusBadge status={project.lastRun.status} className="ml-1" />
                    </>
                  ) : (
                    'No run yet'
                  )}
                </span>
                <span title={formatDate(project.updatedAt)}>{timeAgo(project.updatedAt)}</span>
              </div>

              <div className="mt-3 flex gap-2 border-t border-line-soft pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => void scanProject(project)}
                  loading={busy === project.id}
                >
                  <Radar className="h-3.5 w-3.5" /> Scan
                </Button>
                <Button size="sm" className="flex-1" onClick={() => navigate(`/projects/${project.id}`)}>
                  Open <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New project"
        description="The project name is unique per owner. Scans and runs never modify your source unless a repair you approved is applied."
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button form="new-project-form" type="submit" loading={saving}>
              Create project
            </Button>
          </>
        }
      >
        <form id="new-project-form" className="space-y-4" onSubmit={createProject}>
          {formError ? (
            <div className="rounded-lg border border-negative/30 bg-negative/5 px-3 py-2 text-xs text-negative">
              {formError}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project name" className="sm:col-span-2">
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Payments API"
                aria-label="Project name"
                required
                maxLength={160}
              />
            </Field>
            <Field label="Description" className="sm:col-span-2">
              <Textarea
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                placeholder="What this project does and what “working” means."
                rows={3}
              />
            </Field>
          </div>

          <Field label="Source">
            <div className="grid grid-cols-3 gap-2">
              {(['LOCAL', 'GIT', 'URL'] as SourceType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setForm({ ...form, sourceType: type })}
                  className={`rounded-lg border px-3 py-2 text-left text-xs transition ${form.sourceType === type ? 'border-accent/60 bg-accent/10 text-white' : 'border-line bg-ink-900/50 text-slate-400 hover:border-line-strong'}`}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {type === 'LOCAL' ? (
                      <FolderOpen className="h-3.5 w-3.5" />
                    ) : type === 'GIT' ? (
                      <GitBranch className="h-3.5 w-3.5" />
                    ) : (
                      <Globe2 className="h-3.5 w-3.5" />
                    )}
                    {type === 'LOCAL' ? 'Local folder' : type === 'GIT' ? 'Git repo' : 'Website'}
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-500">
                    {type === 'LOCAL'
                      ? 'Existing source tree'
                      : type === 'GIT'
                        ? 'Clone or attach'
                        : 'Browser + API only'}
                  </div>
                </button>
              ))}
            </div>
          </Field>

          {form.sourceType !== 'URL' ? (
            <Field
              label={form.sourceType === 'GIT' ? 'Repository folder (optional if cloning)' : 'Project folder'}
              hint={
                form.sourceType === 'GIT'
                  ? 'Provide either an existing repository folder or a clone URL.'
                  : 'The folder must exist and be readable.'
              }
            >
              <div className="flex gap-2">
                <Input
                  value={form.rootPath}
                  onChange={(event) => setForm({ ...form, rootPath: event.target.value })}
                  placeholder="D:\work\my-project"
                  spellCheck={false}
                  required={form.sourceType === 'LOCAL'}
                />
                <Button type="button" variant="outline" onClick={() => setFolderOpen(true)}>
                  <FolderOpen className="h-3.5 w-3.5" /> Browse
                </Button>
              </div>
            </Field>
          ) : null}

          {form.sourceType === 'GIT' ? (
            <Field
              label="Clone URL"
              hint="https://, ssh:// or git@host:path. Clones run with --depth 50 into the managed workspace."
            >
              <Input
                value={form.repoUrl}
                onChange={(event) => setForm({ ...form, repoUrl: event.target.value })}
                placeholder="https://github.com/org/repo.git"
                spellCheck={false}
              />
            </Field>
          ) : null}

          {form.sourceType === 'URL' || form.sourceType === 'GIT' ? (
            <Field
              label="Website URL"
              hint={
                form.sourceType === 'URL'
                  ? 'Required for URL projects. The site is only probed with HEAD requests.'
                  : 'Optional deployment URL for browser/API scenarios.'
              }
            >
              <Input
                value={form.websiteUrl}
                onChange={(event) => setForm({ ...form, websiteUrl: event.target.value })}
                placeholder="https://example.com"
                aria-label="Website URL"
                type="url"
                required={form.sourceType === 'URL'}
              />
            </Field>
          ) : null}

          <Field label="Default branch" hint="Optional. Used for context in reports.">
            <Input
              value={form.defaultBranch}
              onChange={(event) => setForm({ ...form, defaultBranch: event.target.value })}
              placeholder="main"
            />
          </Field>
        </form>
      </Modal>

      <FolderPicker
        open={folderOpen}
        onOpenChange={setFolderOpen}
        initialPath={form.rootPath}
        onSelect={(path) => setForm((current) => ({ ...current, rootPath: path }))}
      />

      <Modal
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete project records?"
        description="This removes the project, its plans, runs, results and evidence metadata from the database."
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void deleteProject()}>
              Delete records
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-300">
          <p>
            <span className="font-semibold text-white">{deleting?.name}</span> will be permanently removed from ZetHub
            Proof.
          </p>
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning/90">
            Source files, cloned workspaces and artifact files are <span className="font-semibold">not</span> deleted.
            The API leaves them on disk deliberately.
          </div>
        </div>
      </Modal>
    </div>
  );
}
