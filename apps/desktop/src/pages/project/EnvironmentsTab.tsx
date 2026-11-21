import * as React from 'react';
import { KeyRound, Layers, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { parseJsonObject, prettyJson } from '../../lib/json';
import type { ProjectEnvironment } from '../../types';
import { ConfirmModal } from '../../components/common';
import type { ProjectTabProps } from '../ProjectDetailPage';
import {
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
} from '../../components/ui';

const EMPTY = {
  name: '',
  kind: 'LOCAL',
  baseUrl: '',
  variables: '{}',
  secrets: '{}',
  isDefault: false,
};

export function EnvironmentsTab({ project, reload }: ProjectTabProps) {
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ProjectEnvironment | null>(null);
  const [form, setForm] = React.useState(EMPTY);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<ProjectEnvironment | null>(null);
  const [secretRemoval, setSecretRemoval] = React.useState<{ env: ProjectEnvironment; key: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY, isDefault: project.environments.length === 0 });
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(environment: ProjectEnvironment) {
    setEditing(environment);
    setForm({
      name: environment.name,
      kind: environment.kind.toUpperCase(),
      baseUrl: environment.baseUrl ?? '',
      variables: prettyJson(environment.variables),
      secrets: '{}',
      isDefault: environment.isDefault,
    });
    setFormError(null);
    setFormOpen(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const variables = parseJsonObject(form.variables, 'Variables');
      const secrets = parseJsonObject(form.secrets, 'Secrets');
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        kind: form.kind,
        baseUrl: form.baseUrl.trim() || null,
        variables,
        isDefault: form.isDefault,
      };
      if (Object.keys(secrets).length > 0) body.secrets = secrets;
      if (editing) await api.patch(`/api/v1/projects/${project.project.id}/environments/${editing.id}`, body);
      else await api.post(`/api/v1/projects/${project.project.id}/environments`, body);
      toast.success(editing ? 'Environment updated.' : 'Environment created.');
      setFormOpen(false);
      reload();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault(environment: ProjectEnvironment) {
    setBusy(environment.id);
    try {
      await api.patch(`/api/v1/projects/${project.project.id}/environments/${environment.id}`, { isDefault: true });
      toast.success('Default environment updated.');
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function deleteEnvironment() {
    if (!deleting) return;
    try {
      await api.del(`/api/v1/projects/${project.project.id}/environments/${deleting.id}`);
      toast.success('Environment deleted.');
      setDeleting(null);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function deleteSecret() {
    if (!secretRemoval) return;
    try {
      await api.del(
        `/api/v1/projects/${project.project.id}/environments/${secretRemoval.env.id}/secrets/${encodeURIComponent(secretRemoval.key)}`,
      );
      toast.success('Secret removed.');
      setSecretRemoval(null);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Environments"
          description="Variables and encrypted secrets resolved for runs. Secret values are never returned by the API."
          icon={<Layers className="h-4 w-4" />}
          actions={
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" /> Add environment
            </Button>
          }
        />
        <CardBody>
          {project.environments.length === 0 ? (
            <EmptyState
              icon={<Layers className="h-5 w-5" />}
              title="No environments"
              description="Create one to store base URLs, variables and encrypted secrets."
              action={
                <Button size="sm" onClick={openCreate}>
                  Add environment
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {project.environments.map((environment) => (
                <div key={environment.id} className="rounded-xl border border-line bg-ink-900/50 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13.5px] font-semibold text-white">{environment.name}</span>
                        <Badge
                          tone={
                            environment.kind === 'production'
                              ? 'negative'
                              : environment.kind === 'staging'
                                ? 'warning'
                                : 'accent'
                          }
                        >
                          {environment.kind}
                        </Badge>
                        {environment.isDefault ? (
                          <Badge tone="positive">
                            <Star className="h-2.5 w-2.5 fill-current" /> default
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate font-mono text-[10.5px] text-slate-500">
                        {environment.baseUrl ?? 'No base URL'}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {!environment.isDefault ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Make default"
                          onClick={() => void makeDefault(environment)}
                          disabled={busy === environment.id}
                        >
                          <Star className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit environment"
                        onClick={() => openEdit(environment)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete environment"
                        onClick={() => setDeleting(environment)}
                        disabled={project.environments.length <= 1}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="label mb-1">Variables</div>
                      {Object.keys(environment.variables).length === 0 ? (
                        <p className="text-[10.5px] text-slate-600">None</p>
                      ) : (
                        <div className="space-y-1">
                          {Object.entries(environment.variables).map(([key, value]) => (
                            <div key={key} className="flex items-center justify-between gap-2 text-[10.5px]">
                              <span className="font-mono text-slate-400">{key}</span>
                              <span className="truncate text-slate-300">{String(value)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="label mb-1">Secret keys</div>
                      {environment.secretKeys.length === 0 ? (
                        <p className="text-[10.5px] text-slate-600">None</p>
                      ) : (
                        <div className="space-y-1">
                          {environment.secretKeys.map((key) => (
                            <div key={key} className="flex items-center justify-between gap-2 text-[10.5px]">
                              <span className="inline-flex items-center gap-1 font-mono text-slate-400">
                                <KeyRound className="h-2.5 w-2.5" /> {key}
                              </span>
                              <button
                                className="text-slate-600 hover:text-negative"
                                onClick={() => setSecretRemoval({ env: environment, key })}
                                title="Remove secret"
                              >
                                remove
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card className="p-4">
        <div className="flex items-start gap-2.5">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-accent-soft" />
          <div className="text-[11.5px] leading-relaxed text-slate-400">
            Secrets are encrypted at rest with a key derived from the server secret. They are injected only into
            approved run operations and are never included in API responses, reports or capsules. Prefer environment
            variables over embedding credentials in scenarios.
          </div>
        </div>
      </Card>

      <Modal
        open={formOpen}
        onOpenChange={setFormOpen}
        title={editing ? 'Edit environment' : 'New environment'}
        description={
          editing
            ? 'Secrets are write-only. Supplying a key again replaces its encrypted value.'
            : 'At least one environment is required per project.'
        }
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="environment-form" loading={saving}>
              {editing ? 'Save changes' : 'Create environment'}
            </Button>
          </>
        }
      >
        <form id="environment-form" className="space-y-4" onSubmit={save}>
          {formError ? (
            <div className="rounded-lg border border-negative/30 bg-negative/5 px-3 py-2 text-xs text-negative">
              {formError}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </Field>
            <Field label="Kind">
              <Select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
                <option value="LOCAL">Local</option>
                <option value="TEST">Test</option>
                <option value="STAGING">Staging</option>
                <option value="PRODUCTION">Production</option>
              </Select>
            </Field>
            <Field
              label="Base URL"
              hint="Used by browser and API scenarios when no absolute URL is provided."
              className="sm:col-span-2"
            >
              <Input
                type="url"
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder="http://localhost:3000"
              />
            </Field>
            <Field
              label="Variables JSON"
              hint="Plain values. Safe for non-sensitive configuration."
              className="sm:col-span-2"
            >
              <Textarea
                value={form.variables}
                onChange={(event) => setForm({ ...form, variables: event.target.value })}
                spellCheck={false}
              />
            </Field>
            <Field
              label="Secrets JSON"
              hint="Encrypted at rest. Leave {} to keep existing secrets unchanged."
              className="sm:col-span-2"
            >
              <Textarea
                value={form.secrets}
                onChange={(event) => setForm({ ...form, secrets: event.target.value })}
                spellCheck={false}
                placeholder='{"API_TOKEN":"..."}'
              />
            </Field>
          </div>
          <Switch
            checked={form.isDefault}
            onCheckedChange={(value) => setForm({ ...form, isDefault: value })}
            label="Default environment"
            description="Runs resolve variables and secrets from the default environment."
          />
        </form>
      </Modal>

      <ConfirmModal
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete environment"
        description="At least one environment must remain. Runs keep their historical environment snapshot."
        confirmLabel="Delete environment"
        tone="danger"
        onConfirm={deleteEnvironment}
      >
        <p className="text-sm text-slate-300">
          Delete <span className="font-semibold text-white">{deleting?.name}</span> and its encrypted secrets?
        </p>
      </ConfirmModal>

      <ConfirmModal
        open={Boolean(secretRemoval)}
        onOpenChange={(open) => {
          if (!open) setSecretRemoval(null);
        }}
        title="Remove secret"
        description="The encrypted value is deleted immediately. Runs that need it will fail until it is restored."
        confirmLabel="Remove secret"
        tone="danger"
        onConfirm={deleteSecret}
      >
        <p className="text-sm text-slate-300">
          Remove <span className="font-mono text-[12px] text-white">{secretRemoval?.key}</span> from{' '}
          {secretRemoval?.env.name}?
        </p>
      </ConfirmModal>
    </div>
  );
}
