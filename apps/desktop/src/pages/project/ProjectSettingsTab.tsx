import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, ArchiveRestore, FolderOpen, GitBranch, Save, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { errorMessage, useAsync } from '../../lib/hooks';
import { formatDate } from '../../lib/utils';
import type { ProjectDetailResponse } from '../../types';
import { CodeBlock, ConfirmModal } from '../../components/common';
import { FolderPicker } from '../../components/FolderPicker';
import type { ProjectTabProps } from '../ProjectDetailPage';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  LoadingBlock,
  Modal,
  StatusBadge,
  Textarea,
} from '../../components/ui';

interface GitInfo {
  available: boolean;
  reason?: string;
  branch?: string | null;
  commit?: string | null;
  dirty?: boolean;
  changedFiles?: string[];
  diffStat?: string;
  commits?: Array<{ hash: string; author: string; subject: string; date: string }>;
}

export function ProjectSettingsTab({ project, reload }: ProjectTabProps) {
  const navigate = useNavigate();
  const detail: ProjectDetailResponse = project;
  const [form, setForm] = React.useState({
    name: detail.project.name,
    description: detail.project.description ?? '',
    rootPath: detail.project.rootPath ?? '',
    websiteUrl: detail.project.websiteUrl ?? '',
    repoUrl: detail.project.repoUrl ?? '',
    defaultBranch: detail.project.defaultBranch ?? '',
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [diff, setDiff] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);

  const git = useAsync<GitInfo>(
    (signal) => api.get<GitInfo>(`/api/v1/projects/${detail.project.id}/git`, signal),
    [detail.project.id, detail.project.updatedAt],
  );

  React.useEffect(() => {
    setForm({
      name: detail.project.name,
      description: detail.project.description ?? '',
      rootPath: detail.project.rootPath ?? '',
      websiteUrl: detail.project.websiteUrl ?? '',
      repoUrl: detail.project.repoUrl ?? '',
      defaultBranch: detail.project.defaultBranch ?? '',
    });
  }, [detail.project]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/v1/projects/${detail.project.id}`, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        rootPath: form.rootPath.trim() || null,
        websiteUrl: form.websiteUrl.trim() || null,
        repoUrl: form.repoUrl.trim() || null,
        defaultBranch: form.defaultBranch.trim() || null,
      });
      toast.success('Project settings saved.');
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function togglePinned() {
    setBusy('pin');
    try {
      await api.patch(`/api/v1/projects/${detail.project.id}`, { pinned: !detail.project.pinned });
      toast.success(detail.project.pinned ? 'Project unpinned.' : 'Project pinned.');
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function toggleArchived() {
    setBusy('archive');
    try {
      await api.patch(`/api/v1/projects/${detail.project.id}`, { archived: !detail.project.archived });
      toast.success(detail.project.archived ? 'Project restored.' : 'Project archived.');
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function openDiff() {
    setBusy('diff');
    try {
      const result = await api.get<{ diff: string }>(`/api/v1/projects/${detail.project.id}/git/diff`);
      setDiff(result.diff || '(no working-tree diff)');
      setDiffOpen(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function deleteProject() {
    try {
      await api.del(`/api/v1/projects/${detail.project.id}`);
      toast.success('Project records deleted. Source files were preserved.');
      navigate('/projects');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Project details"
            description="Changing the source folder affects future scans and runs; existing run snapshots are immutable."
            icon={<Save className="h-4 w-4" />}
          />
          <CardBody>
            <form className="space-y-4" onSubmit={save}>
              {error ? (
                <Alert tone="danger" title="Could not save">
                  {error}
                </Alert>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name">
                  <Input
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    required
                    maxLength={160}
                  />
                </Field>
                <Field label="Default branch">
                  <Input
                    value={form.defaultBranch}
                    onChange={(event) => setForm({ ...form, defaultBranch: event.target.value })}
                    placeholder="main"
                  />
                </Field>
                <Field label="Description" className="sm:col-span-2">
                  <Textarea
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                    rows={3}
                  />
                </Field>
                <Field label="Source folder" className="sm:col-span-2" hint="Must exist and be a directory.">
                  <div className="flex gap-2">
                    <Input
                      value={form.rootPath}
                      onChange={(event) => setForm({ ...form, rootPath: event.target.value })}
                      placeholder="No folder attached"
                      spellCheck={false}
                    />
                    <Button type="button" variant="outline" onClick={() => setFolderOpen(true)}>
                      <FolderOpen className="h-3.5 w-3.5" /> Browse
                    </Button>
                  </div>
                </Field>
                <Field label="Website URL">
                  <Input
                    type="url"
                    value={form.websiteUrl}
                    onChange={(event) => setForm({ ...form, websiteUrl: event.target.value })}
                    placeholder="https://example.com"
                  />
                </Field>
                <Field label="Repository URL">
                  <Input
                    value={form.repoUrl}
                    onChange={(event) => setForm({ ...form, repoUrl: event.target.value })}
                    placeholder="https://github.com/org/repo.git"
                  />
                </Field>
              </div>
              <div className="flex justify-end">
                <Button type="submit" loading={saving}>
                  <Save className="h-4 w-4" /> Save changes
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Git context"
            description="Read-only inspection of the attached repository. ZetHub Proof does not commit or push."
            icon={<GitBranch className="h-4 w-4" />}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void openDiff()}
                loading={busy === 'diff'}
                disabled={!git.data?.available}
              >
                View diff
              </Button>
            }
          />
          <CardBody>
            {git.loading ? (
              <LoadingBlock label="Reading Git…" className="py-8" />
            ) : !git.data?.available ? (
              <p className="text-[11.5px] text-slate-500">
                {git.data?.reason ?? git.error ?? 'Git is unavailable for this project.'}
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <span className="chip">
                    <GitBranch className="h-3 w-3" /> {git.data.branch ?? 'detached'}
                  </span>
                  <span className="chip font-mono">{git.data.commit?.slice(0, 10) ?? 'no commit'}</span>
                  <Badge tone={git.data.dirty ? 'warning' : 'positive'}>
                    {git.data.dirty ? `${git.data.changedFiles?.length ?? 0} changed` : 'clean'}
                  </Badge>
                </div>
                {git.data.changedFiles && git.data.changedFiles.length > 0 ? (
                  <div className="rounded-lg border border-line-soft bg-ink-900/40 p-2.5">
                    <div className="label mb-1.5">Working tree</div>
                    <div className="space-y-0.5">
                      {git.data.changedFiles.slice(0, 15).map((file) => (
                        <div key={file} className="truncate font-mono text-[10.5px] text-slate-400">
                          {file}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {git.data.commits && git.data.commits.length > 0 ? (
                  <div>
                    <div className="label mb-1.5">Recent commits</div>
                    <div className="space-y-1">
                      {git.data.commits.map((commit) => (
                        <div
                          key={commit.hash}
                          className="rounded-lg border border-line-soft bg-ink-900/40 px-2.5 py-1.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[10px] text-accent-soft">{commit.hash}</span>
                            <span className="text-[9.5px] text-slate-600">{formatDate(commit.date)}</span>
                          </div>
                          <div className="truncate text-[11px] text-slate-300">{commit.subject}</div>
                          <div className="text-[9.5px] text-slate-600">{commit.author}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader title="Visibility" description="Pin important projects or archive ones you no longer verify." />
          <CardBody className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border border-line-soft bg-ink-900/40 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[12px] text-slate-300">
                <Star className="h-3.5 w-3.5 text-warning" /> Pinned
              </span>
              <Button variant="outline" size="sm" onClick={() => void togglePinned()} loading={busy === 'pin'}>
                {detail.project.pinned ? 'Unpin' : 'Pin'}
              </Button>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-line-soft bg-ink-900/40 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[12px] text-slate-300">
                {detail.project.archived ? (
                  <ArchiveRestore className="h-3.5 w-3.5" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                )}{' '}
                Archived
              </span>
              <Button variant="outline" size="sm" onClick={() => void toggleArchived()} loading={busy === 'archive'}>
                {detail.project.archived ? 'Restore' : 'Archive'}
              </Button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Record" description="Identifiers and timestamps are immutable." />
          <CardBody className="space-y-1.5 text-[11.5px]">
            <div className="flex justify-between gap-3 border-b border-line-soft pb-1.5">
              <span className="text-muted">Project ID</span>
              <span className="font-mono text-slate-300">{detail.project.id}</span>
            </div>
            <div className="flex justify-between gap-3 border-b border-line-soft pb-1.5">
              <span className="text-muted">Source type</span>
              <span className="text-slate-300">{detail.project.sourceType}</span>
            </div>
            <div className="flex justify-between gap-3 border-b border-line-soft pb-1.5">
              <span className="text-muted">Health</span>
              <StatusBadge status={detail.project.health} />
            </div>
            <div className="flex justify-between gap-3 border-b border-line-soft pb-1.5">
              <span className="text-muted">Last verified</span>
              <span className="text-slate-300">{formatDate(detail.project.lastVerifiedAt)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Created</span>
              <span className="text-slate-300">{formatDate(detail.project.createdAt)}</span>
            </div>
          </CardBody>
        </Card>

        <Card className="border-negative/25">
          <CardHeader
            title="Danger zone"
            description="Deletion removes database records and evidence metadata. Source files and artifact files remain on disk."
          />
          <CardBody>
            <Button variant="danger" className="w-full" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-4 w-4" /> Delete project records
            </Button>
          </CardBody>
        </Card>
      </div>

      <FolderPicker
        open={folderOpen}
        onOpenChange={setFolderOpen}
        initialPath={form.rootPath}
        onSelect={(path) => setForm((current) => ({ ...current, rootPath: path }))}
      />

      <Modal
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title="Working tree diff"
        description="Output of git diff --unified=3, truncated by the API at 200 KB."
        width="xl"
        footer={
          <Button variant="ghost" onClick={() => setDiffOpen(false)}>
            Close
          </Button>
        }
      >
        <CodeBlock className="max-h-[60vh]">{diff}</CodeBlock>
      </Modal>

      <ConfirmModal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete project records"
        description="This cannot be undone in the database. Source files are preserved."
        confirmLabel="Delete project"
        tone="danger"
        requireText={detail.project.name}
        requireTextLabel="Type the project name"
        onConfirm={deleteProject}
      >
        <Alert tone="warning" title="Source is not touched">
          Plans, runs, results, reports, capsules and project settings are deleted. Files under the source folder and
          managed workspaces stay on disk.
        </Alert>
      </ConfirmModal>
    </div>
  );
}
