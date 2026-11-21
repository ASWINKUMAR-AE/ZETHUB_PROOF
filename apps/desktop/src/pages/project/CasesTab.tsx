import * as React from 'react';
import { ListChecks, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { parseJsonValue, splitList } from '../../lib/json';
import { kindLabel } from '../../lib/utils';
import type { TestCase } from '../../types';
import { ConfirmModal } from '../../components/common';
import type { ProjectTabProps } from '../ProjectDetailPage';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Switch,
  Textarea,
} from '../../components/ui';

const KINDS = [
  'lint',
  'typecheck',
  'format',
  'unit',
  'integration',
  'build',
  'browser',
  'api',
  'database',
  'security',
  'performance',
  'dependency-audit',
  'secret-scan',
  'static-analysis',
];

const SCENARIO_HINTS: Record<string, string> = {
  browser: JSON.stringify(
    {
      name: 'Homepage loads',
      startUrl: 'https://example.com',
      browser: 'chromium',
      viewport: { width: 1440, height: 900 },
      timeoutMs: 60000,
      trace: true,
      steps: [
        { action: 'goto', path: '/' },
        { action: 'expectVisible', locator: { strategy: 'role', role: 'heading', value: 'Welcome' } },
      ],
    },
    null,
    2,
  ),
  api: JSON.stringify(
    {
      name: 'Health endpoint',
      baseUrl: 'https://api.example.com',
      request: { method: 'GET', url: '/health', headers: [], bodyType: 'none', timeoutMs: 15000, allowMutation: false },
      expectations: [{ type: 'status', equals: 200 }],
    },
    null,
    2,
  ),
  database: JSON.stringify(
    {
      name: 'Users table exists',
      integrationId: 'INTEGRATION_ID',
      checks: [{ type: 'schemaTable', table: 'users', expectColumns: ['id', 'email'] }],
      allowWrites: false,
    },
    null,
    2,
  ),
};

const DEFAULT_FORM = {
  key: '',
  title: '',
  kind: 'unit',
  priority: 50,
  timeoutMs: 300000,
  reason: '',
  tags: '',
  mappedFiles: '',
  executable: '',
  args: '',
  cwd: '',
  scenario: '',
};

export function CasesTab({ project, reload, openRun }: ProjectTabProps) {
  const [search, setSearch] = React.useState('');
  const [kind, setKind] = React.useState('all');
  const [formOpen, setFormOpen] = React.useState(false);
  const [form, setForm] = React.useState(DEFAULT_FORM);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [editing, setEditing] = React.useState<TestCase | null>(null);
  const [editForm, setEditForm] = React.useState({ title: '', priority: 50, reason: '' });
  const [deleting, setDeleting] = React.useState<TestCase | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const filtered = project.cases.filter((testCase) => {
    if (kind !== 'all' && testCase.kind !== kind) return false;
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return (
      testCase.key.toLowerCase().includes(term) ||
      testCase.title.toLowerCase().includes(term) ||
      testCase.tags.some((tag) => tag.toLowerCase().includes(term))
    );
  });

  const scenarioKind = form.kind === 'browser' || form.kind === 'api' || form.kind === 'database';

  function openCreate() {
    setForm({ ...DEFAULT_FORM, cwd: project.project.rootPath ?? '', scenario: SCENARIO_HINTS[form.kind] ?? '' });
    setFormError(null);
    setFormOpen(true);
  }

  function changeKind(next: string) {
    setForm((current) => ({ ...current, kind: next, scenario: SCENARIO_HINTS[next] ?? '' }));
  }

  async function createCase(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const body: Record<string, unknown> = {
        key: form.key.trim(),
        title: form.title.trim(),
        kind: form.kind,
        priority: form.priority,
        timeoutMs: form.timeoutMs,
        reason: form.reason.trim() || undefined,
        tags: splitList(form.tags),
        mappedFiles: splitList(form.mappedFiles),
      };
      if (form.kind === 'browser' || form.kind === 'api' || form.kind === 'database') {
        if (!form.scenario.trim()) throw new Error('A scenario JSON document is required for this kind.');
        body.scenario = parseJsonValue(form.scenario, 'Scenario');
      } else {
        const args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
        body.command = {
          executable: form.executable.trim(),
          args,
          cwd: form.cwd.trim() || project.project.rootPath || '.',
          env: {},
        };
      }
      await api.post(`/api/v1/projects/${project.project.id}/cases`, body);
      toast.success('Test case saved.');
      setFormOpen(false);
      reload();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(testCase: TestCase, enabled: boolean) {
    setBusy(testCase.id);
    try {
      await api.patch(`/api/v1/projects/${project.project.id}/cases/${testCase.id}`, { enabled });
      toast.success(enabled ? 'Case enabled.' : 'Case disabled.');
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function openEdit(testCase: TestCase) {
    setEditing(testCase);
    setEditForm({ title: testCase.title, priority: testCase.priority, reason: testCase.reason ?? '' });
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      await api.patch(`/api/v1/projects/${project.project.id}/cases/${editing.id}`, {
        title: editForm.title.trim(),
        priority: editForm.priority,
        reason: editForm.reason.trim(),
      });
      toast.success('Test case updated.');
      setEditing(null);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function deleteCase() {
    if (!deleting) return;
    try {
      await api.del(`/api/v1/projects/${project.project.id}/cases/${deleting.id}`);
      toast.success('Test case deleted.');
      setDeleting(null);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  return (
    <Card>
      <CardHeader
        title="Test cases"
        description="Saved checks included in plans. Detected cases regenerate on scan; user cases are editable."
        icon={<ListChecks className="h-4 w-4" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={openRun}>
              Run verification
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" /> Add case
            </Button>
          </>
        }
      />
      <CardBody className="border-b border-line-soft">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 md:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              className="pl-9"
              placeholder="Search cases…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select className="w-[170px]" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">All kinds</option>
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {kindLabel(value)}
              </option>
            ))}
          </Select>
          <span className="ml-auto text-[11px] text-muted">
            {filtered.length} of {project.cases.length} cases
          </span>
        </div>
      </CardBody>
      <CardBody className="p-0">
        {project.cases.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<ListChecks className="h-5 w-5" />}
              title="No test cases"
              description="Scan the project to detect commands, or add a command/browser/API/DB case manually."
              action={
                <Button size="sm" onClick={openCreate}>
                  <Plus className="h-3.5 w-3.5" /> Add case
                </Button>
              }
            />
          </div>
        ) : filtered.length === 0 ? (
          <p className="p-5 text-xs text-muted">No cases match this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Kind</th>
                  <th>Source</th>
                  <th>Priority</th>
                  <th>Approval</th>
                  <th>Enabled</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((testCase) => (
                  <tr key={testCase.id}>
                    <td>
                      <div className="font-mono text-[11px] text-slate-200">{testCase.key}</div>
                      <div className="mt-0.5 text-[11.5px] text-slate-400">{testCase.title}</div>
                      {testCase.reason ? (
                        <div className="mt-0.5 max-w-[380px] text-[10.5px] text-slate-600">{testCase.reason}</div>
                      ) : null}
                    </td>
                    <td>
                      <Badge>{kindLabel(testCase.kind)}</Badge>
                    </td>
                    <td>
                      <Badge
                        tone={testCase.source === 'user' ? 'accent' : testCase.source === 'ai' ? 'warning' : 'default'}
                      >
                        {testCase.source}
                      </Badge>
                    </td>
                    <td className="font-mono text-[11px] text-slate-400">{testCase.priority}</td>
                    <td>
                      {testCase.requiresApproval ? (
                        <Badge tone="warning">required</Badge>
                      ) : (
                        <Badge tone="positive">automatic</Badge>
                      )}
                    </td>
                    <td>
                      <Switch
                        checked={testCase.enabled}
                        onCheckedChange={(value) => void toggleEnabled(testCase, value)}
                        disabled={busy === testCase.id}
                      />
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" title="Edit case" onClick={() => openEdit(testCase)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={testCase.source === 'detected' ? 'Detected cases cannot be deleted' : 'Delete case'}
                          onClick={() => setDeleting(testCase)}
                          disabled={testCase.source === 'detected'}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>

      <Modal
        open={formOpen}
        onOpenChange={setFormOpen}
        title="Add a test case"
        description="Command cases require explicit approval at run time. Browser, API and database scenarios are validated when saved."
        width="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="case-form" loading={saving}>
              Save case
            </Button>
          </>
        }
      >
        <form id="case-form" className="space-y-4" onSubmit={createCase}>
          {formError ? (
            <div className="rounded-lg border border-negative/30 bg-negative/5 px-3 py-2 text-xs text-negative">
              {formError}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Key" hint="Letters, digits, dots, colons, underscores or dashes.">
              <Input
                value={form.key}
                onChange={(event) => setForm({ ...form, key: event.target.value })}
                placeholder="unit:payments"
                required
                pattern="[A-Za-z0-9._:-]+"
              />
            </Field>
            <Field label="Kind">
              <Select value={form.kind} onChange={(event) => changeKind(event.target.value)}>
                {KINDS.map((value) => (
                  <option key={value} value={value}>
                    {kindLabel(value)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Title" className="sm:col-span-2">
              <Input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder="Checkout rejects expired cards"
                required
              />
            </Field>
            <Field label="Priority" hint="0–100. Higher-priority checks appear first.">
              <Input
                type="number"
                min={0}
                max={100}
                value={form.priority}
                onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })}
              />
            </Field>
            <Field label="Timeout (ms)">
              <Input
                type="number"
                min={1000}
                max={3600000}
                value={form.timeoutMs}
                onChange={(event) => setForm({ ...form, timeoutMs: Number(event.target.value) })}
              />
            </Field>
            <Field label="Reason">
              <Textarea
                value={form.reason}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
                placeholder="Why this check matters."
                rows={2}
              />
            </Field>
            <Field label="Tags" hint="Comma or newline separated.">
              <Input
                value={form.tags}
                onChange={(event) => setForm({ ...form, tags: event.target.value })}
                placeholder="smoke, payments"
              />
            </Field>
            <Field label="Mapped files" hint="Used for changed-file test selection." className="sm:col-span-2">
              <Input
                value={form.mappedFiles}
                onChange={(event) => setForm({ ...form, mappedFiles: event.target.value })}
                placeholder="src/payments/card.ts, src/payments/card.test.ts"
              />
            </Field>
          </div>

          {scenarioKind ? (
            <Field
              label={`${kindLabel(form.kind)} scenario JSON`}
              hint={
                form.kind === 'database'
                  ? 'Reference a saved DATABASE integration by id. No credentials belong in a scenario.'
                  : 'Validated against the shared scenario contract. Secrets should be referenced, not embedded.'
              }
            >
              <Textarea
                className="min-h-[260px]"
                value={form.scenario}
                onChange={(event) => setForm({ ...form, scenario: event.target.value })}
                spellCheck={false}
              />
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Executable"
                hint="Resolved on the machine. npm/npx shims are mapped to Node CLIs automatically."
              >
                <Input
                  value={form.executable}
                  onChange={(event) => setForm({ ...form, executable: event.target.value })}
                  placeholder="npm"
                  required
                />
              </Field>
              <Field label="Arguments" hint="Whitespace separated. Quoting is not parsed.">
                <Input
                  value={form.args}
                  onChange={(event) => setForm({ ...form, args: event.target.value })}
                  placeholder="run test -- --runInBand"
                  className="font-mono"
                />
              </Field>
              <Field label="Working directory" hint="Defaults to the project root." className="sm:col-span-2">
                <Input
                  value={form.cwd}
                  onChange={(event) => setForm({ ...form, cwd: event.target.value })}
                  placeholder={project.project.rootPath ?? '.'}
                  className="font-mono"
                />
              </Field>
              <div className="sm:col-span-2">
                <Checkbox
                  checked
                  onChange={() => undefined}
                  disabled
                  label={
                    <span className="text-[11.5px] text-slate-400">
                      Command cases always require explicit approval at run time.
                    </span>
                  }
                />
              </div>
            </div>
          )}
        </form>
      </Modal>

      <Modal
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Edit test case"
        description={editing ? `${editing.key} · ${editing.adapterId}` : undefined}
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="edit-case-form" loading={saving}>
              Save changes
            </Button>
          </>
        }
      >
        <form id="edit-case-form" className="space-y-4" onSubmit={saveEdit}>
          <Field label="Title">
            <Input
              value={editForm.title}
              onChange={(event) => setEditForm({ ...editForm, title: event.target.value })}
              required
            />
          </Field>
          <Field label="Priority">
            <Input
              type="number"
              min={0}
              max={100}
              value={editForm.priority}
              onChange={(event) => setEditForm({ ...editForm, priority: Number(event.target.value) })}
            />
          </Field>
          <Field label="Reason">
            <Textarea
              value={editForm.reason}
              onChange={(event) => setEditForm({ ...editForm, reason: event.target.value })}
              rows={3}
            />
          </Field>
        </form>
      </Modal>

      <ConfirmModal
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete test case"
        description="This removes the saved case. Existing run results remain in their run history."
        confirmLabel="Delete case"
        tone="danger"
        onConfirm={deleteCase}
      >
        <p className="text-sm text-slate-300">
          Delete <span className="font-mono text-[12px] text-white">{deleting?.key}</span>?
        </p>
      </ConfirmModal>
    </Card>
  );
}
