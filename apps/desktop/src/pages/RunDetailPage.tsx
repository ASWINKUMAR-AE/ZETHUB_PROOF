import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  FileArchive,
  FileCheck2,
  FlaskConical,
  GitBranch,
  ListChecks,
  RotateCw,
  Search,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, apiUrl, downloadFile, subscribeRunEvents, type SseEvent } from '../lib/api';
import { errorMessage, useAsync, useInterval, useDocumentTitle } from '../lib/hooks';
import { formatBytes, formatDate, formatDuration, kindLabel, timeAgo } from '../lib/utils';
import type { RepairProposal, RunDetailResponse, RunSummary, TestResult } from '../types';
import { ConfirmModal, ErrorState, LoadingCard, PageHeader, ProgressBar } from '../components/common';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '../components/ui';

interface CapsuleItem {
  id: string;
  testKey: string;
  relativePath: string;
  sha256: string;
  formatVersion: number;
  redactions: number;
  createdAt: string;
}

interface CompareResponse {
  left: RunSummary & { platform: string };
  right: RunSummary & { platform: string };
  sameCommit: boolean;
  cases: Array<{ key: string; left: string; right: string; changed: boolean }>;
}

export function RunDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAsync<RunDetailResponse>(
    (signal) => api.get<RunDetailResponse>(`/api/v1/runs/${encodeURIComponent(id)}`, signal),
    [id],
  );
  const [live, setLive] = React.useState<SseEvent | null>(null);
  const [tab, setTab] = React.useState('results');
  const [cancelling, setCancelling] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [reportBusy, setReportBusy] = React.useState(false);
  const [repairTarget, setRepairTarget] = React.useState<TestResult | null>(null);
  const [capsuleBusy, setCapsuleBusy] = React.useState<string | null>(null);
  const [compareOpen, setCompareOpen] = React.useState(false);
  const run = data?.run;

  useDocumentTitle(run ? `Run ${run.id.slice(0, 8)}` : 'Run');

  React.useEffect(() => {
    if (!run || !data?.active) return;
    const unsubscribe = subscribeRunEvents(run.id, (event) => {
      setLive(event);
      if (event.type === 'done') {
        setTimeout(() => reload(), 600);
      }
    });
    return unsubscribe;
  }, [run, data?.active, reload]);

  useInterval(
    () => {
      if (data?.active) reload();
    },
    data?.active ? 3500 : null,
  );

  const capsules = useAsync<{ items: CapsuleItem[] }>(
    (signal) => api.get<{ items: CapsuleItem[] }>(`/api/v1/runs/${encodeURIComponent(id)}/capsules`, signal),
    [id, run?.finishedAt],
  );
  const repairs = useAsync<{ items: RepairProposal[] }>(
    (signal) => api.get<{ items: RepairProposal[] }>(`/api/v1/runs/${encodeURIComponent(id)}/repairs`, signal),
    [id, run?.finishedAt],
  );

  async function cancel() {
    setCancelling(true);
    try {
      await api.post(`/api/v1/runs/${id}/cancel`);
      toast.success('Cancellation requested. Child processes are being stopped.');
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setCancelling(false);
    }
  }

  async function generateReport() {
    setReportBusy(true);
    try {
      const result = await api.post<{ reports: Array<{ format: string }> }>(`/api/v1/runs/${id}/reports`);
      toast.success(`Evidence passport generated (${result.reports.map((r) => r.format).join(', ')}).`);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setReportBusy(false);
    }
  }

  async function removeRun() {
    try {
      await api.del(`/api/v1/runs/${id}`);
      toast.success('Run records deleted. Evidence files remain until retention cleanup.');
      navigate('/runs');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function createCapsule(result: TestResult) {
    setCapsuleBusy(result.key);
    try {
      const created = await api.post<{ existing: boolean; capsule: { id: string } }>(`/api/v1/runs/${id}/capsules`, {
        resultKey: result.key,
      });
      toast.success(
        created.existing
          ? 'A capsule already existed and was re-validated.'
          : 'Failure capsule exported with redactions applied.',
      );
      capsules.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setCapsuleBusy(null);
    }
  }

  if (loading) return <LoadingCard label="Loading run…" />;
  if (error || !data || !run) return <ErrorState error={error ?? 'Run unavailable.'} onRetry={reload} />;

  const completed = run.counts.passed + run.counts.failed + run.counts.blocked + run.counts.unverified;
  const progressCompleted = live?.progress?.completed ?? completed;
  const progressTotal = live?.progress?.total ?? run.counts.total;

  return (
    <div className="fade-in">
      <PageHeader
        breadcrumb={
          <>
            <Link to="/runs" className="link">
              Verification runs
            </Link>
            <span className="mx-1.5 text-slate-600">/</span>
            <Link to={`/projects/${run.projectId}`} className="link">
              {run.projectName}
            </Link>
          </>
        }
        title={`Run ${run.id.slice(0, 8)}`}
        description={`${run.trigger} · ${run.strategy} strategy · started ${formatDate(run.startedAt)}`}
        icon={<FlaskConical className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" onClick={() => navigate(`/projects/${run.projectId}?tab=runs`)}>
              <ArrowLeft className="h-4 w-4" /> Project
            </Button>
            {data.active ? (
              <Button variant="danger" onClick={() => void cancel()} loading={cancelling}>
                <Square className="h-3.5 w-3.5" /> Cancel run
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setCompareOpen(true)}>
                <Activity className="h-4 w-4" /> Compare
              </Button>
            )}
            <Button variant="outline" onClick={() => void generateReport()} loading={reportBusy} disabled={data.active}>
              <FileCheck2 className="h-4 w-4" /> Generate passport
            </Button>
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <Badge tone="accent">{run.trigger}</Badge>
            <Badge>{run.strategy}</Badge>
            {run.gitCommit ? (
              <span className="chip font-mono">
                <GitBranch className="h-3 w-3" /> {run.gitBranch ?? 'branch'} · {run.gitCommit.slice(0, 8)}
              </span>
            ) : null}
            {data.active ? <Badge tone="accent">live</Badge> : null}
            <span className="ml-auto text-[10.5px] text-muted">
              {run.finishedAt ? `finished ${timeAgo(run.finishedAt)}` : `started ${timeAgo(run.startedAt)}`}
            </span>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <ProgressBar completed={progressCompleted} total={Math.max(1, progressTotal)} className="flex-1" />
            <span className="shrink-0 font-mono text-[11px] text-slate-400">
              {progressCompleted}/{progressTotal}
            </span>
          </div>
          {data.active ? (
            <div className="mt-2.5 flex items-center gap-2 text-[11px] text-cyan">
              <Activity className="h-3.5 w-3.5 animate-pulse" />{' '}
              {live?.title ? `${live.title} · ${live.status ?? 'running'}` : (live?.message ?? 'Run in progress…')}
            </div>
          ) : run.errorMessage ? (
            <div className="mt-2.5 text-[11px] text-negative">{run.errorMessage}</div>
          ) : null}
        </Card>
        <div className="grid grid-cols-5 gap-2">
          <MiniStat label="Total" value={run.counts.total} />
          <MiniStat label="Passed" value={run.counts.passed} tone="positive" />
          <MiniStat label="Failed" value={run.counts.failed} tone="negative" />
          <MiniStat label="Blocked" value={run.counts.blocked} tone="warning" />
          <MiniStat label="Unverified" value={run.counts.unverified} tone="accent" />
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="p-3.5">
          <div className="label mb-1.5">Environment</div>
          <div className="space-y-0.5 text-[11px] text-slate-400">
            <div>
              {run.environment.os} · {run.environment.arch}
            </div>
            <div>{run.environment.hostname}</div>
            <div>
              Node {run.environment.node} · ZetHub {run.environment.appVersion}
            </div>
          </div>
        </Card>
        <Card className="p-3.5">
          <div className="label mb-1.5">Verified scope</div>
          <p className="text-[11px] leading-relaxed text-slate-400">
            {run.verifiedScope || 'See the individual results. The scope is limited to checks that actually executed.'}
          </p>
        </Card>
        <Card className="p-3.5">
          <div className="label mb-1.5">Remaining limitations</div>
          {run.remainingLimitations.length === 0 ? (
            <p className="text-[11px] text-slate-500">No additional limitations recorded for this run.</p>
          ) : (
            <ul className="list-disc space-y-0.5 pl-4 text-[10.5px] leading-relaxed text-warning/90">
              {run.remainingLimitations.slice(0, 3).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="results" count={run.results.length}>
              Results
            </TabsTrigger>
            <TabsTrigger value="evidence" count={data.reports.length + (capsules.data?.items.length ?? 0)}>
              Evidence
            </TabsTrigger>
            <TabsTrigger value="repairs" count={repairs.data?.items.length ?? 0}>
              Repairs
            </TabsTrigger>
            <TabsTrigger value="plan" count={run.planSnapshot?.cases.length ?? 0}>
              Plan
            </TabsTrigger>
          </TabsList>

          <TabsContent value="results">
            <ResultsPanel run={run} onCapsule={createCapsule} capsuleBusy={capsuleBusy} onRepair={setRepairTarget} />
          </TabsContent>

          <TabsContent value="evidence">
            <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
              <Card>
                <CardHeader
                  title="Evidence passport"
                  description="HTML, JSON and JUnit outputs generated from stored results, with a signed manifest."
                  icon={<FileCheck2 className="h-4 w-4" />}
                  actions={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void generateReport()}
                      loading={reportBusy}
                      disabled={data.active}
                    >
                      <RotateCw className="h-3.5 w-3.5" /> Regenerate
                    </Button>
                  }
                />
                <CardBody className="space-y-2.5">
                  {data.reports.length === 0 ? (
                    <EmptyState
                      title="No passport yet"
                      description="Generate a passport once the run has finished. Every format is derived from the same results."
                      icon={<FileCheck2 className="h-5 w-5" />}
                      action={
                        <Button
                          size="sm"
                          onClick={() => void generateReport()}
                          loading={reportBusy}
                          disabled={data.active}
                        >
                          Generate passport
                        </Button>
                      }
                    />
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() =>
                            window.open(apiUrl(`/api/v1/runs/${id}/report?format=html`), '_blank', 'noopener')
                          }
                        >
                          <FileCheck2 className="h-3.5 w-3.5" /> Open HTML
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void downloadFile(
                              `/api/v1/runs/${id}/report?format=json`,
                              `evidence-passport-${id}.json`,
                            ).catch((caught) => toast.error(errorMessage(caught)))
                          }
                        >
                          <Download className="h-3.5 w-3.5" /> JSON
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void downloadFile(
                              `/api/v1/runs/${id}/report?format=junit`,
                              `evidence-passport-${id}.xml`,
                            ).catch((caught) => toast.error(errorMessage(caught)))
                          }
                        >
                          <Download className="h-3.5 w-3.5" /> JUnit XML
                        </Button>
                      </div>
                      <div className="overflow-hidden rounded-lg border border-line">
                        <table className="table-base">
                          <thead>
                            <tr>
                              <th>Format</th>
                              <th>SHA-256</th>
                              <th>Generated</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {data.reports.map((report) => (
                              <tr key={report.id}>
                                <td>
                                  <Badge tone="accent">{report.format}</Badge>
                                </td>
                                <td>
                                  <span className="font-mono text-[9.5px] text-slate-500" title={report.sha256}>
                                    {report.sha256.slice(0, 20)}…
                                  </span>
                                </td>
                                <td className="text-[10.5px] text-muted">{timeAgo(report.generatedAt)}</td>
                                <td className="text-right">
                                  <button
                                    className="link text-[11px]"
                                    onClick={() =>
                                      void downloadFile(
                                        `/api/v1/reports/${report.id}/download`,
                                        `${report.format}-${id}.${report.format === 'junit' ? 'xml' : report.format}`,
                                      ).catch((caught) => toast.error(errorMessage(caught)))
                                    }
                                  >
                                    Download
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Failure capsules"
                  description="Minimal, redacted reproduction bundles for failed checks."
                  icon={<FileArchive className="h-4 w-4" />}
                />
                <CardBody className="space-y-2">
                  {capsules.loading ? (
                    <LoadingCard label="Loading capsules…" />
                  ) : (capsules.data?.items.length ?? 0) === 0 ? (
                    <p className="text-[11.5px] leading-relaxed text-slate-500">
                      No capsules. Expand a failed check in Results and choose “Export capsule”.
                    </p>
                  ) : (
                    capsules.data!.items.map((capsule) => (
                      <div key={capsule.id} className="rounded-lg border border-line-soft bg-ink-900/40 px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10.5px] text-slate-200">{capsule.testKey}</span>
                          <Badge tone="accent">v{capsule.formatVersion}</Badge>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[9.5px] text-slate-600" title={capsule.sha256}>
                          {capsule.sha256}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between">
                          <span className="text-[9.5px] text-slate-600">
                            {capsule.redactions} redaction(s) · {timeAgo(capsule.createdAt)}
                          </span>
                          <button
                            className="link text-[10.5px]"
                            onClick={() =>
                              void downloadFile(
                                `/api/v1/capsules/${capsule.id}`,
                                `failure-capsule-${capsule.testKey.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`,
                              ).catch((caught) => toast.error(errorMessage(caught)))
                            }
                          >
                            Download
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </CardBody>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="repairs">
            <Card>
              <CardHeader
                title="Repairs for this run"
                description="Proposals are created from a failed result. Approval, application and retesting are separate actions."
                icon={<Wrench className="h-4 w-4" />}
                actions={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/projects/${run.projectId}?tab=repairs`)}
                  >
                    Open project repairs
                  </Button>
                }
              />
              <CardBody className="p-0">
                {(repairs.data?.items.length ?? 0) === 0 ? (
                  <div className="p-4">
                    <EmptyState
                      title="No repair proposals"
                      description="Expand a failed check in Results and choose “Propose repair”."
                      icon={<Wrench className="h-5 w-5" />}
                    />
                  </div>
                ) : (
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
                      {repairs.data!.items.map((repair) => (
                        <tr key={repair.id}>
                          <td>
                            <StatusBadge status={repair.status} />
                          </td>
                          <td className="font-mono text-[10.5px]">{repair.testKey}</td>
                          <td>
                            <span className="chip">{repair.classification}</span>
                          </td>
                          <td className="text-[10.5px] text-slate-400">{repair.files.length} file(s)</td>
                          <td className="text-[10.5px] text-muted">{timeAgo(repair.createdAt)}</td>
                          <td className="text-right">
                            <Link className="link text-[11px]" to={`/projects/${run.projectId}?tab=repairs`}>
                              Review
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardBody>
            </Card>
          </TabsContent>

          <TabsContent value="plan">
            <Card>
              <CardHeader
                title="Plan snapshot"
                description="The exact plan this run executed, preserved even if cases change later."
                icon={<ListChecks className="h-4 w-4" />}
              />
              <CardBody className="p-0">
                {!run.planSnapshot ? (
                  <p className="p-4 text-xs text-muted">No plan snapshot was stored for this run.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="table-base">
                      <thead>
                        <tr>
                          <th>Check</th>
                          <th>Kind</th>
                          <th>Source</th>
                          <th>Approval</th>
                          <th>Timeout</th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.planSnapshot.cases.map((testCase) => (
                          <tr key={testCase.key}>
                            <td>
                              <div className="font-mono text-[10.5px] text-slate-200">{testCase.key}</div>
                              <div className="text-[11px] text-slate-500">{testCase.title}</div>
                            </td>
                            <td>
                              <Badge>{kindLabel(testCase.kind)}</Badge>
                            </td>
                            <td>
                              <span className="chip">{testCase.source}</span>
                            </td>
                            <td>
                              {testCase.requiresApproval ? (
                                <Badge tone="warning">required</Badge>
                              ) : (
                                <Badge tone="positive">automatic</Badge>
                              )}
                            </td>
                            <td className="text-[10.5px] text-muted">{formatDuration(testCase.timeoutMs)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-4">
        <div className="text-[10.5px] text-slate-600">
          Run ID <span className="font-mono">{run.id}</span> · report ID {run.reportId ?? 'none'}
        </div>
        <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)} disabled={data.active}>
          <Trash2 className="h-3.5 w-3.5" /> Delete run records
        </Button>
      </div>

      <RepairModal
        open={Boolean(repairTarget)}
        onOpenChange={(open) => {
          if (!open) setRepairTarget(null);
        }}
        runId={id}
        result={repairTarget}
        onCreated={() => {
          repairs.reload();
          setRepairTarget(null);
        }}
      />

      <CompareModal open={compareOpen} onOpenChange={setCompareOpen} run={run} />

      <ConfirmModal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete run records?"
        description="The run, results and report records are removed. Artifact files remain until retention cleanup."
        confirmLabel="Delete run"
        tone="danger"
        requireText={run.id}
        requireTextLabel="Type the run id"
        onConfirm={removeRun}
      >
        <p className="text-sm text-slate-300">This cannot be undone in the database.</p>
      </ConfirmModal>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'positive' | 'negative' | 'warning' | 'accent';
}) {
  const tones = {
    default: 'text-white',
    positive: 'text-positive',
    negative: 'text-negative',
    warning: 'text-warning',
    accent: 'text-accent-soft',
  };
  return (
    <div className="rounded-xl border border-line-soft bg-ink-900/60 p-2.5 text-center">
      <div className="text-[9px] uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${tones[tone]}`}>{value}</div>
    </div>
  );
}

function ResultsPanel({
  run,
  onCapsule,
  capsuleBusy,
  onRepair,
}: {
  run: NonNullable<RunDetailResponse['run']>;
  onCapsule: (result: TestResult) => Promise<void>;
  capsuleBusy: string | null;
  onRepair: (result: TestResult) => void;
}) {
  const [filter, setFilter] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const statuses = ['all', 'passed', 'failed', 'blocked', 'timeout', 'error', 'unverified', 'skipped', 'cancelled'];
  const results = run.results.filter((result) => {
    if (filter !== 'all' && result.status !== filter) return false;
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return (
      result.key.toLowerCase().includes(term) ||
      result.title.toLowerCase().includes(term) ||
      (result.message ?? '').toLowerCase().includes(term)
    );
  });

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader
        title="Check results"
        description="Each row is a stored result. Expand to inspect assertions, output and evidence hashes."
        icon={<ListChecks className="h-4 w-4" />}
        actions={
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <Input
                className="h-8 w-[200px] pl-8"
                placeholder="Filter results…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Select className="h-8 w-[135px]" value={filter} onChange={(event) => setFilter(event.target.value)}>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {status === 'all' ? 'All statuses' : status}
                </option>
              ))}
            </Select>
          </div>
        }
      />
      <CardBody className="p-0">
        {run.results.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No results recorded"
              description="The run may have failed to start, or no cases were executed."
              icon={<FlaskConical className="h-5 w-5" />}
            />
          </div>
        ) : results.length === 0 ? (
          <p className="p-4 text-xs text-muted">No results match this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th className="w-8" />
                  <th>Check</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => {
                  const isOpen = expanded.has(result.key);
                  return (
                    <React.Fragment key={result.key}>
                      <tr className="cursor-pointer" onClick={() => toggle(result.key)}>
                        <td>
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted" />
                          )}
                        </td>
                        <td>
                          <div className="font-mono text-[10.5px] text-slate-200">{result.key}</div>
                          <div className="text-[11.5px] text-slate-400">{result.title}</div>
                        </td>
                        <td>
                          <Badge>{kindLabel(result.kind)}</Badge>
                        </td>
                        <td>
                          <StatusBadge status={result.status} />
                        </td>
                        <td className="text-[11px] text-muted">{formatDuration(result.durationMs)}</td>
                        <td className="max-w-[300px] truncate text-[11px] text-slate-500">
                          {result.message ?? result.classification ?? '—'}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr>
                          <td colSpan={6} className="bg-ink-950/50">
                            <div className="space-y-3 px-2 py-2.5">
                              <div className="flex flex-wrap items-center gap-2">
                                {result.commandDisplay ? (
                                  <span className="chip font-mono text-[10px]">{result.commandDisplay}</span>
                                ) : null}
                                {result.exitCode !== null && result.exitCode !== undefined ? (
                                  <Badge tone={result.exitCode === 0 ? 'positive' : 'negative'}>
                                    exit {result.exitCode}
                                  </Badge>
                                ) : null}
                                {result.classification ? <Badge tone="warning">{result.classification}</Badge> : null}
                                {result.stdoutTruncated ? <Badge tone="warning">stdout truncated</Badge> : null}
                                <span className="ml-auto flex flex-wrap gap-2">
                                  {result.status !== 'passed' ? (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => void onCapsule(result)}
                                        loading={capsuleBusy === result.key}
                                      >
                                        <FileArchive className="h-3.5 w-3.5" /> Export capsule
                                      </Button>
                                      <Button size="sm" variant="outline" onClick={() => onRepair(result)}>
                                        <Wrench className="h-3.5 w-3.5" /> Propose repair
                                      </Button>
                                    </>
                                  ) : null}
                                </span>
                              </div>

                              {result.assertions.length > 0 ? (
                                <div className="overflow-hidden rounded-lg border border-line">
                                  <table className="table-base">
                                    <thead>
                                      <tr>
                                        <th>Assertion</th>
                                        <th>Status</th>
                                        <th>Expected</th>
                                        <th>Actual</th>
                                        <th>Message</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {result.assertions.map((assertion, index) => (
                                        <tr key={`${result.key}-assertion-${index}`}>
                                          <td className="text-[11px]">{assertion.name}</td>
                                          <td>
                                            <StatusBadge status={assertion.status} />
                                          </td>
                                          <td className="max-w-[220px] break-all font-mono text-[10px]">
                                            {assertion.expected ?? '—'}
                                          </td>
                                          <td className="max-w-[220px] break-all font-mono text-[10px]">
                                            {assertion.actual ?? '—'}
                                          </td>
                                          <td className="max-w-[260px] text-[10.5px] text-slate-500">
                                            {assertion.message ?? '—'}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : null}

                              {result.stdout ? (
                                <div>
                                  <div className="label mb-1">stdout</div>
                                  <CodeBlock className="max-h-[320px]">{result.stdout}</CodeBlock>
                                </div>
                              ) : null}
                              {result.stderr ? (
                                <div>
                                  <div className="label mb-1">stderr</div>
                                  <CodeBlock className="max-h-[320px] border-negative/25">{result.stderr}</CodeBlock>
                                </div>
                              ) : null}

                              {result.evidence.length > 0 ? (
                                <div>
                                  <div className="label mb-1">Evidence artifacts</div>
                                  <div className="grid gap-1.5 sm:grid-cols-2">
                                    {result.evidence.map((artifact) => (
                                      <a
                                        key={artifact.relativePath}
                                        className="flex items-center justify-between gap-2 rounded-lg border border-line-soft bg-ink-900/40 px-2.5 py-1.5 text-[10.5px] transition hover:border-line-strong"
                                        href={apiUrl(
                                          `/api/v1/artifacts/${artifact.relativePath.split('/').map(encodeURIComponent).join('/')}`,
                                        )}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        <span className="truncate text-slate-300">{artifact.name}</span>
                                        <span className="shrink-0 text-slate-600">
                                          {artifact.kind} · {formatBytes(artifact.sizeBytes)}
                                        </span>
                                      </a>
                                    ))}
                                  </div>
                                </div>
                              ) : null}

                              {result.message ? (
                                <div>
                                  <div className="label mb-1">Message</div>
                                  <p className="rounded-lg border border-line-soft bg-ink-900/40 px-3 py-2 text-[11.5px] text-slate-400">
                                    {result.message}
                                  </p>
                                </div>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function RepairModal({
  open,
  onOpenChange,
  runId,
  result,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  result: TestResult | null;
  onCreated: () => void;
}) {
  const [diff, setDiff] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setDiff('');
      setNotes('');
      setError(null);
    }
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!result) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/v1/runs/${runId}/repairs`, {
        testKey: result.key,
        diff: diff.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success('Repair proposal saved. Review, approve and apply it explicitly.');
      onCreated();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={result ? `Propose repair · ${result.key}` : 'Propose repair'}
      description="ZetHub Proof never generates a patch silently. Provide a unified diff from your editor or an approved AI provider; it is validated with git apply --check."
      width="xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="repair-form" loading={saving}>
            Save proposal
          </Button>
        </>
      }
    >
      <form id="repair-form" className="space-y-4" onSubmit={submit}>
        {error ? (
          <Alert tone="danger" title="Proposal rejected">
            {error}
          </Alert>
        ) : null}
        {result ? (
          <div className="rounded-xl border border-line-soft bg-ink-900/40 p-3">
            <div className="flex items-center gap-2">
              <StatusBadge status={result.status} />
              <Badge>{result.classification ?? 'unclassified'}</Badge>
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-slate-400">
              {result.message ?? 'No failure message captured. Inspect stdout/stderr before proposing a patch.'}
            </p>
          </div>
        ) : null}
        <Field
          label="Unified diff"
          hint="Optional. Without a diff this is a metadata-only proposal. Absolute paths, traversal and binary patches are rejected."
        >
          <Textarea
            className="min-h-[240px]"
            value={diff}
            onChange={(event) => setDiff(event.target.value)}
            placeholder={
              'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n-const value = 1;\n+const value = 2;'
            }
            spellCheck={false}
          />
        </Field>
        <Field label="Notes">
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            placeholder="What changed and why."
          />
        </Field>
      </form>
    </Modal>
  );
}

function CompareModal({
  open,
  onOpenChange,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: RunSummary;
}) {
  const [otherId, setOtherId] = React.useState('');
  const [runs, setRuns] = React.useState<RunSummary[]>([]);
  const [comparison, setComparison] = React.useState<CompareResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setComparison(null);
    setError(null);
    api
      .get<{ items: RunSummary[] }>(`/api/v1/runs?projectId=${encodeURIComponent(run.projectId)}&pageSize=100`)
      .then((result) => setRuns(result.items.filter((item) => item.id !== run.id)))
      .catch((caught) => setError(errorMessage(caught)));
  }, [open, run.id, run.projectId]);

  React.useEffect(() => {
    if (!open || !otherId) return;
    setLoading(true);
    setError(null);
    api
      .get<CompareResponse>(`/api/v1/runs/${run.id}/compare?otherId=${encodeURIComponent(otherId)}`)
      .then(setComparison)
      .catch((caught) => setError(errorMessage(caught)))
      .finally(() => setLoading(false));
  }, [open, otherId, run.id]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Compare runs"
      description="Compare per-check outcomes between two stored runs. Different commits may not be comparable."
      width="lg"
      footer={
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Compare with">
          <Select value={otherId} onChange={(event) => setOtherId(event.target.value)}>
            <option value="">Choose a run…</option>
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id.slice(0, 8)} · {item.status} · {formatDate(item.startedAt)}
              </option>
            ))}
          </Select>
        </Field>
        {error ? (
          <Alert tone="danger" title="Comparison failed">
            {error}
          </Alert>
        ) : null}
        {loading ? (
          <LoadingCard label="Comparing…" />
        ) : comparison ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-line-soft bg-ink-900/40 p-3">
                <div className="label">This run</div>
                <div className="mt-1">
                  <StatusBadge status={comparison.left.status} />
                </div>
                <div className="mt-1 text-[10.5px] text-muted">
                  {comparison.left.platform} · {comparison.left.gitCommit?.slice(0, 8) ?? 'no commit'}
                </div>
              </div>
              <div className="rounded-xl border border-line-soft bg-ink-900/40 p-3">
                <div className="label">Other run</div>
                <div className="mt-1">
                  <StatusBadge status={comparison.right.status} />
                </div>
                <div className="mt-1 text-[10.5px] text-muted">
                  {comparison.right.platform} · {comparison.right.gitCommit?.slice(0, 8) ?? 'no commit'}
                </div>
              </div>
            </div>
            <div
              className={
                comparison.sameCommit
                  ? 'rounded-lg border border-positive/30 bg-positive/5 px-3 py-2 text-[11px] text-positive'
                  : 'rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning'
              }
            >
              {comparison.sameCommit
                ? 'Both runs recorded the same commit. Differences are more likely environmental or flaky.'
                : 'The runs do not share the same commit (or one has no commit). Outcome differences may come from code changes.'}
            </div>
            <div className="max-h-[320px] overflow-y-auto rounded-xl border border-line">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>This run</th>
                    <th>Other</th>
                    <th>Changed</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.cases.map((testCase) => (
                    <tr key={testCase.key}>
                      <td className="font-mono text-[10px]">{testCase.key}</td>
                      <td>
                        <StatusBadge status={testCase.left} />
                      </td>
                      <td>
                        <StatusBadge status={testCase.right} />
                      </td>
                      <td>
                        {testCase.changed ? (
                          <Badge tone="warning">yes</Badge>
                        ) : (
                          <span className="text-[10.5px] text-slate-600">no</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="text-[11.5px] text-slate-500">Choose another run to compare check outcomes.</p>
        )}
      </div>
    </Modal>
  );
}
