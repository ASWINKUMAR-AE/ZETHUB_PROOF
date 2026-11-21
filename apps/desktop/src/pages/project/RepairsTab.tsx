import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bot, GitPullRequest, Play, ThumbsDown, ThumbsUp, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { errorMessage, useAsync } from '../../lib/hooks';
import { formatDate, timeAgo } from '../../lib/utils';
import type { RepairProposal } from '../../types';
import { CodeBlock, ConfirmModal } from '../../components/common';
import type { ProjectTabProps } from '../ProjectDetailPage';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LoadingBlock,
  Modal,
  StatusBadge,
} from '../../components/ui';

export function RepairsTab({ project, reload, openRun }: ProjectTabProps) {
  const navigate = useNavigate();
  const {
    data,
    loading,
    error,
    reload: reloadRepairs,
  } = useAsync<{ items: RepairProposal[] }>(
    (signal) => api.get<{ items: RepairProposal[] }>(`/api/v1/projects/${project.project.id}/repairs`, signal),
    [project.project.id],
  );
  const [selected, setSelected] = React.useState<RepairProposal | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ type: 'apply' | 'reject'; repair: RepairProposal } | null>(null);
  const [aiDiff, setAiDiff] = React.useState<{ diff: string; explanation: string } | null>(null);
  const [aiLoading, setAiLoading] = React.useState(false);

  const failedRun = project.runs.find((run) => ['failed', 'error', 'timeout', 'blocked'].includes(run.status));

  function refresh() {
    reloadRepairs();
    reload();
  }

  async function approve(repair: RepairProposal) {
    setBusy(repair.id);
    setActionError(null);
    try {
      await api.post(`/api/v1/repairs/${repair.id}/approve`);
      toast.success('Repair approved. Apply it explicitly when ready.');
      setSelected(null);
      refresh();
    } catch (caught) {
      setActionError(errorMessage(caught));
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function confirmAction() {
    if (!confirm) return;
    setBusy(confirm.repair.id);
    setActionError(null);
    try {
      if (confirm.type === 'apply') {
        await api.post(`/api/v1/repairs/${confirm.repair.id}/apply`, { confirm: true });
        toast.success('Patch applied to the working tree. Review it with git diff.');
      } else {
        await api.post(`/api/v1/repairs/${confirm.repair.id}/reject`);
        toast.success('Repair rejected.');
      }
      setConfirm(null);
      setSelected(null);
      refresh();
    } catch (caught) {
      setActionError(errorMessage(caught));
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function retest(repair: RepairProposal) {
    setBusy(repair.id);
    setActionError(null);
    try {
      const result = await api.post<{ runId: string }>(`/api/v1/repairs/${repair.id}/retest`);
      toast.success('Retest started. The proposal is verified only if the run passes.');
      setSelected(null);
      refresh();
      navigate(`/runs/${result.runId}`);
    } catch (caught) {
      setActionError(errorMessage(caught));
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function aiSuggest(repair: RepairProposal) {
    setAiLoading(true);
    setActionError(null);
    try {
      const result = await api.post<{ diff: string; explanation: string }>(`/api/v1/repairs/${repair.id}/ai-suggest`);
      setAiDiff(result);
      toast.success('AI suggested a patch. Review it carefully; it is not saved or applied automatically.');
    } catch (caught) {
      setActionError(errorMessage(caught));
      toast.error(errorMessage(caught));
    } finally {
      setAiLoading(false);
    }
  }

  const repairs = data?.items ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Repair proposals"
          description="Patches are supplied by you or an approved AI provider, validated with git apply --check, applied explicitly and retested."
          icon={<Wrench className="h-4 w-4" />}
          actions={
            <>
              {failedRun ? (
                <Button variant="outline" size="sm" onClick={() => navigate(`/runs/${failedRun.id}`)}>
                  <GitPullRequest className="h-3.5 w-3.5" /> Open failing run
                </Button>
              ) : null}
              <Button size="sm" onClick={openRun}>
                <Play className="h-3.5 w-3.5" /> New run
              </Button>
            </>
          }
        />
        <CardBody className="p-0">
          {loading ? (
            <LoadingBlock label="Loading repairs…" />
          ) : error ? (
            <div className="p-4">
              <Alert tone="danger" title="Could not load repairs">
                {error}
              </Alert>
            </div>
          ) : repairs.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<Wrench className="h-5 w-5" />}
                title="No repair proposals"
                description="Repair proposals start from a failed result inside a run. Open a failing run, choose “Propose repair” on the failed check, then review it here."
                action={
                  failedRun ? (
                    <Button size="sm" onClick={() => navigate(`/runs/${failedRun.id}`)}>
                      Open failing run
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Check</th>
                    <th>Classification</th>
                    <th>Files</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {repairs.map((repair) => (
                    <tr key={repair.id}>
                      <td>
                        <StatusBadge status={repair.status} />
                      </td>
                      <td>
                        <div className="font-mono text-[11px] text-slate-200">{repair.testKey}</div>
                        <div className="text-[10px] text-slate-500">{repair.id}</div>
                      </td>
                      <td>
                        <span className="chip">{repair.classification}</span>
                      </td>
                      <td>
                        {repair.files.length ? (
                          <div className="space-y-0.5">
                            {repair.files.slice(0, 2).map((file) => (
                              <div key={file} className="font-mono text-[10px] text-slate-400">
                                {file}
                              </div>
                            ))}
                            {repair.files.length > 2 ? (
                              <div className="text-[10px] text-slate-600">+{repair.files.length - 2} more</div>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-[10.5px] text-slate-600">No patch</span>
                        )}
                      </td>
                      <td className="text-[11px] text-muted" title={formatDate(repair.createdAt)}>
                        {timeAgo(repair.createdAt)}
                      </td>
                      <td className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelected(repair);
                            setAiDiff(null);
                            setActionError(null);
                          }}
                        >
                          Review
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Safety rails"
          description="How a repair can change source, and what is never automatic."
          icon={<GitPullRequest className="h-4 w-4" />}
        />
        <CardBody>
          <ul className="list-disc space-y-1.5 pl-5 text-[11.5px] leading-relaxed text-slate-400">
            <li>A proposal with no diff is metadata only; it cannot be applied.</li>
            <li>
              Patches must apply cleanly to a Git working tree, cannot contain absolute paths or traversal, and binary
              patches are rejected.
            </li>
            <li>
              Approval, application and retesting are separate explicit actions. A retest marks the proposal verified
              only when the retest passes.
            </li>
            <li>
              Rolling back an applied patch is a Git operation performed by you; ZetHub Proof does not auto-revert
              source.
            </li>
          </ul>
        </CardBody>
      </Card>

      <Modal
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selected ? `Repair · ${selected.testKey}` : 'Repair'}
        description={selected ? `${selected.classification} · proposed ${formatDate(selected.createdAt)}` : undefined}
        width="xl"
        footer={
          selected ? (
            <>
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Close
              </Button>
              {selected.status === 'proposed' || selected.status === 'rejected' ? (
                <Button variant="outline" onClick={() => void approve(selected)} loading={busy === selected.id}>
                  <ThumbsUp className="h-3.5 w-3.5" /> Approve
                </Button>
              ) : null}
              {selected.status === 'approved' ? (
                <Button
                  onClick={() => setConfirm({ type: 'apply', repair: selected })}
                  disabled={!selected.diff.trim() || busy === selected.id}
                >
                  <GitPullRequest className="h-3.5 w-3.5" /> Apply patch
                </Button>
              ) : null}
              {['applied', 'failed', 'verified'].includes(selected.status) ? (
                <Button onClick={() => void retest(selected)} loading={busy === selected.id}>
                  <Play className="h-3.5 w-3.5" /> Retest
                </Button>
              ) : null}
              {!['applied', 'verified'].includes(selected.status) ? (
                <Button
                  variant="danger"
                  onClick={() => setConfirm({ type: 'reject', repair: selected })}
                  disabled={busy === selected.id}
                >
                  <ThumbsDown className="h-3.5 w-3.5" /> Reject
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {selected ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={selected.status} />
              <Badge>{selected.classification}</Badge>
              {selected.retestRunId ? (
                <Link className="link text-[11px]" to={`/runs/${selected.retestRunId}`}>
                  Retest run
                </Link>
              ) : null}
              {selected.verifiedAt ? <Badge tone="positive">verified {formatDate(selected.verifiedAt)}</Badge> : null}
              {selected.appliedAt ? <Badge tone="warning">applied {formatDate(selected.appliedAt)}</Badge> : null}
            </div>

            {actionError ? (
              <Alert tone="danger" title="Action failed">
                {actionError}
              </Alert>
            ) : null}

            <div>
              <div className="label mb-1.5">Possible causes</div>
              <ul className="list-disc space-y-1 pl-5 text-[11.5px] leading-relaxed text-slate-400">
                {selected.possibleCauses.map((cause) => (
                  <li key={cause}>{cause}</li>
                ))}
              </ul>
            </div>

            {selected.notes ? (
              <div>
                <div className="label mb-1.5">Notes</div>
                <p className="rounded-lg border border-line-soft bg-ink-900/50 px-3 py-2 text-[11.5px] text-slate-300">
                  {selected.notes}
                </p>
              </div>
            ) : null}

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <div className="label">Patch</div>
                <span className="text-[10px] text-slate-600">{selected.files.length} file(s)</span>
              </div>
              {selected.diff.trim() ? (
                <CodeBlock className="max-h-[320px]">{selected.diff}</CodeBlock>
              ) : (
                <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-slate-500">
                  No patch was supplied. This proposal cannot be applied.
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
              <Button variant="outline" size="sm" onClick={() => void aiSuggest(selected)} loading={aiLoading}>
                <Bot className="h-3.5 w-3.5" /> Ask AI for a patch
              </Button>
              <span className="text-[10.5px] text-slate-600">
                Requires AI configuration and explicit consent. Any AI diff must be saved as a new proposal before it
                can be applied.
              </span>
            </div>

            {aiDiff ? (
              <div className="space-y-2 rounded-xl border border-accent/25 bg-accent/5 p-3">
                <div className="text-[12px] font-semibold text-accent-soft">AI suggestion (not saved)</div>
                {aiDiff.explanation ? (
                  <p className="text-[11.5px] leading-relaxed text-slate-400">{aiDiff.explanation}</p>
                ) : null}
                <CodeBlock className="max-h-[260px]">{aiDiff.diff}</CodeBlock>
                <p className="text-[10.5px] text-slate-500">
                  To apply this, reject this proposal if needed and create a new proposal from the run with this diff.
                  ZetHub Proof validates it with git apply --check first.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <ConfirmModal
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm?.type === 'apply' ? 'Apply patch to working tree?' : 'Reject repair?'}
        description={
          confirm?.type === 'apply'
            ? 'This runs git apply in the project root. Review the resulting diff before committing. The patch can only be reverted with Git.'
            : 'The proposal is retained for history but cannot be applied until it is approved again.'
        }
        confirmLabel={confirm?.type === 'apply' ? 'Apply patch' : 'Reject repair'}
        tone={confirm?.type === 'reject' ? 'danger' : 'primary'}
        onConfirm={confirmAction}
      >
        <p className="text-sm text-slate-300">
          {confirm ? (
            <>
              Repair <span className="font-mono text-[11.5px] text-white">{confirm.repair.testKey}</span> ·{' '}
              {confirm.repair.files.length} file(s).
            </>
          ) : null}
        </p>
      </ConfirmModal>
    </div>
  );
}
