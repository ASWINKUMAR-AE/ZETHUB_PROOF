import * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FlaskConical, RotateCw } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDate, formatDuration, timeAgo } from '../lib/utils';
import type { Paginated, ProjectSummary, RunSummary } from '../types';
import { ErrorState, LoadingCard, PageHeader, ProgressBar } from '../components/common';
import { Badge, Button, Card, CardBody, EmptyState, Select, StatusBadge } from '../components/ui';

const PAGE_SIZE = 25;

export function RunsPage() {
  useDocumentTitle('Verification runs');
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('all');
  const [trigger, setTrigger] = React.useState('all');
  const [projectId, setProjectId] = React.useState('all');

  const projects = useAsync<{ items: ProjectSummary[] }>(
    (signal) => api.get<{ items: ProjectSummary[] }>('/api/v1/projects?archived=all&sort=name', signal),
    [],
  );
  const { data, error, loading, reload } = useAsync<Paginated<RunSummary>>(
    (signal) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status !== 'all') params.set('status', status);
      if (trigger !== 'all') params.set('trigger', trigger);
      if (projectId !== 'all') params.set('projectId', projectId);
      return api.get<Paginated<RunSummary>>(`/api/v1/runs?${params.toString()}`, signal);
    },
    [page, status, trigger, projectId],
  );

  React.useEffect(() => setPage(1), [status, trigger, projectId]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="fade-in">
      <PageHeader
        title="Verification runs"
        description="Complete history of executed plans, including runs started by repair retests and the CLI. Results are never synthesised."
        icon={<FlaskConical className="h-5 w-5" />}
        actions={
          <Button variant="outline" onClick={reload}>
            <RotateCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />

      <Card>
        <CardBody className="border-b border-line-soft">
          <div className="flex flex-wrap items-center gap-2">
            <Select className="w-[170px]" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All statuses</option>
              {['queued', 'running', 'passed', 'failed', 'blocked', 'cancelled', 'timeout', 'error', 'unverified'].map(
                (value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ),
              )}
            </Select>
            <Select className="w-[170px]" value={trigger} onChange={(event) => setTrigger(event.target.value)}>
              <option value="all">All triggers</option>
              {['manual', 'cli', 'ci', 'repair-retest', 'scheduled'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
            <Select className="w-[230px]" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="all">All projects</option>
              {(projects.data?.items ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
            <span className="ml-auto text-[11px] text-muted">
              {data ? `${data.total} run${data.total === 1 ? '' : 's'}` : '—'}
            </span>
          </div>
        </CardBody>
        <CardBody className="p-0">
          {loading ? (
            <LoadingCard label="Loading runs…" />
          ) : error ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={reload} />
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<FlaskConical className="h-5 w-5" />}
                title="No runs match these filters"
                description="Change the filters, or start verification from a project."
              />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Project</th>
                      <th>Progress</th>
                      <th>Trigger</th>
                      <th>Strategy</th>
                      <th>Started</th>
                      <th>Duration</th>
                      <th>Report</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <StatusBadge status={run.status} />
                        </td>
                        <td>
                          <Link
                            to={`/projects/${run.projectId}`}
                            className="text-[12px] font-medium text-slate-200 hover:text-accent-soft"
                          >
                            {run.projectName}
                          </Link>
                          <div className="font-mono text-[9.5px] text-slate-600">{run.id.slice(0, 12)}</div>
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <ProgressBar
                              completed={
                                run.counts.passed + run.counts.failed + run.counts.blocked + run.counts.unverified
                              }
                              total={Math.max(1, run.counts.total)}
                              className="w-20"
                            />
                            <span className="font-mono text-[10.5px] text-slate-400">
                              {run.counts.passed}/{run.counts.total}
                            </span>
                          </div>
                          <div className="mt-1 flex gap-1 text-[9.5px] text-slate-600">
                            <span className="text-positive">{run.counts.passed}p</span>
                            <span className="text-negative">{run.counts.failed}f</span>
                            <span className="text-warning">{run.counts.blocked}b</span>
                            <span className="text-accent-soft">{run.counts.unverified}u</span>
                          </div>
                        </td>
                        <td>
                          <span className="chip">{run.trigger}</span>
                        </td>
                        <td>
                          <span className="chip">{run.strategy}</span>
                        </td>
                        <td className="text-[10.5px] text-muted" title={formatDate(run.startedAt)}>
                          {timeAgo(run.startedAt)}
                        </td>
                        <td className="text-[10.5px] text-muted">{formatDuration(run.counts.durationMs)}</td>
                        <td>{run.reportId ? <Badge tone="positive">ready</Badge> : <Badge>none</Badge>}</td>
                        <td className="text-right">
                          <Link to={`/runs/${run.id}`} className="link text-xs">
                            Inspect
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-line-soft px-4 py-3 text-[11px] text-muted">
                <span>
                  Page {data.page} of {totalPages} · {data.total} total
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={data.page <= 1}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                    disabled={data.page >= totalPages}
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
