import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ListChecks, Play, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { kindLabel } from '../lib/utils';
import type { PlanPreview, TestCase } from '../types';
import { Alert, Badge, Button, Checkbox, LoadingBlock, Modal, Select } from './ui';
import { ProgressBar } from './common';

export function PlanRunModal({
  projectId,
  projectName,
  open,
  onOpenChange,
  onStarted,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted?: (runId: string) => void;
}) {
  const navigate = useNavigate();
  const [strategy, setStrategy] = React.useState<'full' | 'changed' | 'selected'>('full');
  const [cases, setCases] = React.useState<TestCase[]>([]);
  const [casesLoading, setCasesLoading] = React.useState(false);
  const [selectedKeys, setSelectedKeys] = React.useState<string[]>([]);
  const [preview, setPreview] = React.useState<PlanPreview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [approvals, setApprovals] = React.useState<string[]>([]);
  const [writes, setWrites] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!open) return;
    setStrategy('full');
    setPreview(null);
    setSelectedKeys([]);
    setApprovals([]);
    setWrites([]);
    setError(null);
    setCasesLoading(true);
    api
      .get<{ items: TestCase[] }>(`/api/v1/projects/${projectId}/cases`)
      .then((result) => setCases(result.items.filter((item) => item.enabled)))
      .catch((caught) => setError(errorMessage(caught)))
      .finally(() => setCasesLoading(false));
  }, [open, projectId]);

  React.useEffect(() => {
    if (!open) return;
    setPreview(null);
    setApprovals([]);
    setWrites([]);
    setError(null);
  }, [strategy, selectedKeys, open]);

  const approvalKeys = preview?.approvalRequired.map((item) => item.key) ?? [];
  const dbWriteIntegrations = React.useMemo(() => {
    const ids = new Set<string>();
    for (const testCase of preview?.plan.cases ?? []) {
      if (testCase.database?.allowWrites) ids.add(testCase.database.integrationId);
    }
    return [...ids];
  }, [preview]);

  const allApproved = approvalKeys.length > 0 && approvalKeys.every((key) => approvals.includes(key));
  const writesConfirmed = dbWriteIntegrations.every((id) => writes.includes(id));

  async function buildPreview() {
    if (strategy === 'selected' && selectedKeys.length === 0) {
      setError('Select at least one case before building the plan.');
      return;
    }
    setPreviewing(true);
    setError(null);
    try {
      const result = await api.post<PlanPreview>(`/api/v1/projects/${projectId}/plans/preview`, {
        strategy,
        caseKeys: strategy === 'selected' ? selectedKeys : undefined,
      });
      setPreview(result);
      setApprovals([]);
      setWrites([]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPreviewing(false);
    }
  }

  async function startRun() {
    if (!preview) return;
    setStarting(true);
    setError(null);
    try {
      const result = await api.post<{ runId: string; caseCount: number }>(`/api/v1/projects/${projectId}/runs`, {
        strategy,
        caseKeys: strategy === 'selected' ? selectedKeys : undefined,
        approvals,
        writesConfirmed: writes,
        trigger: 'MANUAL',
      });
      toast.success(`Verification started · ${result.caseCount} check(s).`);
      onOpenChange(false);
      if (onStarted) onStarted(result.runId);
      else navigate(`/runs/${result.runId}`);
    } catch (caught) {
      const details = (
        caught as {
          details?: { approvalRequired?: Array<{ key: string; title: string }>; writesApprovalRequired?: string[] };
        }
      ).details;
      if (details?.approvalRequired?.length) {
        setError(`Approval is required for: ${details.approvalRequired.map((item) => item.key).join(', ')}.`);
      } else if (details?.writesApprovalRequired?.length) {
        setError(`Database write confirmation is required for: ${details.writesApprovalRequired.join(', ')}.`);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setStarting(false);
    }
  }

  const approvedCount = approvals.length;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Run verification · ${projectName}`}
      description="Build a server-side plan, review it, then approve the checks that execute commands or mutate state."
      width="xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={starting}>
            Cancel
          </Button>
          {preview ? (
            <Button
              onClick={() => void startRun()}
              loading={starting}
              disabled={
                preview.plan.cases.length === 0 ||
                (approvalKeys.length > 0 && approvedCount < approvalKeys.length) ||
                !writesConfirmed
              }
            >
              <Play className="h-4 w-4" /> Start {preview.summary.total} check{preview.summary.total === 1 ? '' : 's'}
            </Button>
          ) : (
            <Button onClick={() => void buildPreview()} loading={previewing}>
              <ListChecks className="h-4 w-4" /> Build plan preview
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[190px_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <div className="label">Strategy</div>
            <Select value={strategy} onChange={(event) => setStrategy(event.target.value as typeof strategy)}>
              <option value="full">Full verification</option>
              <option value="changed">Changed files</option>
              <option value="selected">Selected checks</option>
            </Select>
          </div>
          <div className="rounded-xl border border-line-soft bg-ink-900/50 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-slate-400">
            {strategy === 'full'
              ? 'All detected and saved checks are planned. Commands still require per-run approval.'
              : strategy === 'changed'
                ? 'Only checks mapped to files changed in the working tree are selected. Falls back to full when no mapping exists.'
                : 'Only the checks you select execute. Useful for a focused retest.'}
          </div>
        </div>

        {strategy === 'selected' ? (
          <div className="rounded-xl border border-line bg-ink-900/40">
            <div className="border-b border-line-soft px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
              Choose checks
            </div>
            {casesLoading ? (
              <LoadingBlock label="Loading test cases…" className="py-8" />
            ) : cases.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted">
                No enabled cases. Scan the project or add a case first.
              </div>
            ) : (
              <div className="max-h-[220px] space-y-1 overflow-y-auto p-2.5">
                {cases.map((testCase) => (
                  <Checkbox
                    key={testCase.id}
                    checked={selectedKeys.includes(testCase.key)}
                    onChange={(checked) =>
                      setSelectedKeys((current) =>
                        checked ? [...current, testCase.key] : current.filter((key) => key !== testCase.key),
                      )
                    }
                    label={
                      <span>
                        <span className="font-mono text-[11px] text-slate-300">{testCase.key}</span>{' '}
                        <span className="text-[11.5px] text-slate-500">· {testCase.title}</span>{' '}
                        <Badge className="ml-1">{kindLabel(testCase.kind)}</Badge>
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </div>
        ) : null}

        {error ? (
          <Alert tone="danger" title="Run cannot start">
            {error}
          </Alert>
        ) : null}

        {preview ? (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-line-soft bg-ink-900/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.1em] text-muted">Checks</div>
                <div className="mt-1 text-lg font-semibold text-white">{preview.summary.total}</div>
              </div>
              <div className="rounded-xl border border-line-soft bg-ink-900/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.1em] text-muted">Needs approval</div>
                <div className={`mt-1 text-lg font-semibold ${approvalKeys.length ? 'text-warning' : 'text-positive'}`}>
                  {approvalKeys.length}
                </div>
              </div>
              <div className="rounded-xl border border-line-soft bg-ink-900/60 p-3">
                <div className="text-[10px] uppercase tracking-[0.1em] text-muted">Coverage confidence</div>
                <div className="mt-1 text-lg font-semibold capitalize text-accent-soft">
                  {preview.plan.coverageConfidence}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {Object.entries(preview.summary.byKind).map(([kind, count]) => (
                <span key={kind} className="chip">
                  {kindLabel(kind)} · {count}
                </span>
              ))}
              {preview.plan.cases.length === 0 ? <Badge tone="warning">No executable checks in plan</Badge> : null}
            </div>

            {preview.plan.notes.length > 0 ? (
              <Alert tone="info" title="Plan notes">
                <ul className="list-disc space-y-1 pl-4">
                  {preview.plan.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {preview.plan.unverifiedAreas.length > 0 ? (
              <Alert tone="warning" title="Areas this plan does not verify">
                <ul className="list-disc space-y-1 pl-4">
                  {preview.plan.unverifiedAreas.map((area) => (
                    <li key={area}>{area}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <div className="max-h-[260px] overflow-y-auto rounded-xl border border-line">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Kind</th>
                    <th>Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.plan.cases.map((testCase) => (
                    <tr key={testCase.key}>
                      <td>
                        <div className="font-mono text-[11px] text-slate-200">{testCase.key}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">{testCase.title}</div>
                      </td>
                      <td>
                        <Badge>{kindLabel(testCase.kind)}</Badge>
                      </td>
                      <td>
                        {testCase.requiresApproval ? (
                          <Badge tone="warning">required</Badge>
                        ) : (
                          <Badge tone="positive">automatic</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {approvalKeys.length > 0 ? (
              <div className="rounded-xl border border-warning/30 bg-warning/5 p-3.5">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-warning">
                  <ShieldCheck className="h-4 w-4" /> Explicit approval
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  These checks execute commands or mutate state. They will not run without your selection.
                </p>
                <div className="mt-2.5">
                  <Checkbox
                    checked={allApproved}
                    onChange={(checked) => setApprovals(checked ? approvalKeys : [])}
                    label={
                      <span className="font-medium text-slate-200">
                        Approve all {approvalKeys.length} required checks
                      </span>
                    }
                  />
                </div>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {preview.approvalRequired.map((item) => (
                    <Checkbox
                      key={item.key}
                      checked={approvals.includes(item.key)}
                      onChange={(checked) =>
                        setApprovals((current) =>
                          checked ? [...new Set([...current, item.key])] : current.filter((key) => key !== item.key),
                        )
                      }
                      label={
                        <span>
                          <span className="font-mono text-[10.5px]">{item.key}</span>
                          <span className="ml-1 text-[10.5px] text-slate-500">{item.title}</span>
                        </span>
                      }
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {dbWriteIntegrations.length > 0 ? (
              <div className="rounded-xl border border-negative/30 bg-negative/5 p-3.5">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-negative">
                  <AlertTriangle className="h-4 w-4" /> Database writes
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  One or more scenarios set <code className="font-mono">allowWrites</code>. Confirm each integration
                  before the run can start.
                </p>
                <div className="mt-2 space-y-1">
                  {dbWriteIntegrations.map((id) => (
                    <Checkbox
                      key={id}
                      checked={writes.includes(id)}
                      onChange={(checked) =>
                        setWrites((current) =>
                          checked ? [...new Set([...current, id])] : current.filter((entry) => entry !== id),
                        )
                      }
                      label={
                        <span>
                          I confirm writes for integration <span className="font-mono text-[10.5px]">{id}</span>
                        </span>
                      }
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {preview.plan.cases.length > 0 ? (
              <div>
                <div className="mb-1.5 flex items-center justify-between text-[10.5px] text-muted">
                  <span>Approval readiness</span>
                  <span>
                    {approvedCount}/{approvalKeys.length} approved
                  </span>
                </div>
                <ProgressBar completed={approvedCount} total={Math.max(1, approvalKeys.length)} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
