import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Database,
  FileCheck2,
  FolderKanban,
  Gauge,
  Plus,
  Sparkles,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDuration, timeAgo } from '../lib/utils';
import type { AnalyticsOverview, DashboardData } from '../types';
import { PageHeader, ErrorState, LoadingCard, ProgressBar } from '../components/common';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, StatCard, StatusBadge } from '../components/ui';

interface DashboardBundle {
  dashboard: DashboardData;
  analytics: AnalyticsOverview;
}

export function DashboardPage() {
  useDocumentTitle('Dashboard');
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAsync<DashboardBundle>(async (signal) => {
    const [dashboard, analytics] = await Promise.all([
      api.get<DashboardData>('/api/v1/dashboard', signal),
      api.get<AnalyticsOverview>('/api/v1/analytics/overview?days=30', signal),
    ]);
    return { dashboard, analytics };
  }, []);

  if (loading) return <LoadingCard label="Loading dashboard…" />;
  if (error || !data) return <ErrorState error={error ?? 'Dashboard unavailable.'} onRetry={reload} />;
  const { dashboard, analytics } = data;
  const passRate = dashboard.runsThisWeek.passRate;
  const series = analytics.series.slice(-21);

  return (
    <div className="fade-in">
      <PageHeader
        title="Verification overview"
        description="Every number below is computed from runs stored in your local database. Nothing is simulated."
        icon={<Gauge className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" onClick={() => navigate('/runs')}>
              <Activity className="h-4 w-4" /> All runs
            </Button>
            <Button onClick={() => navigate('/projects?new=1')}>
              <Plus className="h-4 w-4" /> New project
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Projects"
          value={dashboard.projects.total}
          hint={`${dashboard.projects.healthy} healthy · ${dashboard.projects.failing} failing`}
          icon={<FolderKanban className="h-4 w-4" />}
        />
        <StatCard
          label="Pass rate · 7 days"
          value={passRate === null ? '—' : `${Math.round(passRate * 100)}%`}
          hint={`${dashboard.runsThisWeek.passed}/${dashboard.runsThisWeek.finished} finished runs passed`}
          tone={passRate === null ? 'default' : passRate >= 0.9 ? 'positive' : passRate >= 0.6 ? 'warning' : 'negative'}
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <StatCard
          label="Active runs"
          value={dashboard.activeRuns}
          hint={dashboard.activeRuns > 0 ? 'Verification in progress' : 'No run executing now'}
          tone={dashboard.activeRuns > 0 ? 'cyan' : 'default'}
          icon={<Activity className="h-4 w-4" />}
        />
        <StatCard
          label="Database"
          value={dashboard.database.reachable ? 'Online' : 'Offline'}
          hint={
            dashboard.database.lastBackup
              ? `Last backup ${timeAgo(dashboard.database.lastBackup.createdAt)}`
              : 'No verified backup yet'
          }
          tone={dashboard.database.reachable ? 'positive' : 'negative'}
          icon={<Database className="h-4 w-4" />}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader
            title="Verification activity"
            description="Runs per day over the last 21 recorded days, with pass and fail outcomes."
            icon={<Activity className="h-4 w-4" />}
            actions={<Badge tone="accent">{analytics.days} day window</Badge>}
          />
          <CardBody>
            {series.length === 0 ? (
              <EmptyState
                title="No verification history yet"
                description="Create a project, scan it, and start a run. This chart fills from real stored results."
                icon={<Activity className="h-5 w-5" />}
              />
            ) : (
              <div className="h-[268px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: -22 }}>
                    <defs>
                      <linearGradient id="runsFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#7c5cff" stopOpacity={0.42} />
                        <stop offset="100%" stopColor="#7c5cff" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="passedFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#34d399" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="#34d399" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(value: string) => value.slice(5)}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={18}
                    />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={38} />
                    <Tooltip
                      contentStyle={{
                        background: '#0d1220',
                        border: '1px solid #1d2440',
                        borderRadius: 12,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: '#c7cee6' }}
                      itemStyle={{ color: '#9d86ff' }}
                    />
                    <Area
                      type="monotone"
                      dataKey="runs"
                      name="Runs"
                      stroke="#7c5cff"
                      strokeWidth={2}
                      fill="url(#runsFill)"
                    />
                    <Area
                      type="monotone"
                      dataKey="passed"
                      name="Passed"
                      stroke="#34d399"
                      strokeWidth={1.6}
                      fill="url(#passedFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardBody>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader
              title="Evidence pipeline"
              description="Reports and capsules are generated on demand from finished runs."
              icon={<FileCheck2 className="h-4 w-4" />}
            />
            <CardBody className="space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-xl border border-line-soft bg-ink-900/60 p-3">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Checks executed</div>
                  <div className="mt-1.5 text-xl font-semibold text-white">{analytics.totals.checks}</div>
                </div>
                <div className="rounded-xl border border-line-soft bg-ink-900/60 p-3">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Checks failed</div>
                  <div
                    className={`mt-1.5 text-xl font-semibold ${analytics.totals.checksFailed > 0 ? 'text-negative' : 'text-positive'}`}
                  >
                    {analytics.totals.checksFailed}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-line-soft bg-ink-900/60 px-3 py-2.5 text-xs">
                <span className="text-muted">Offline queue</span>
                <span className="text-slate-300">
                  {dashboard.offlineQueue.pending} pending · {dashboard.offlineQueue.synced} synced
                </span>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-line-soft bg-ink-900/60 px-3 py-2.5 text-xs">
                <span className="text-muted">AI assistance</span>
                <Badge tone={dashboard.ai.configured ? 'accent' : 'default'}>
                  {dashboard.ai.configured
                    ? 'Configured · opt-in'
                    : dashboard.ai.enabled
                      ? 'Enabled · incomplete'
                      : 'Disabled'}
                </Badge>
              </div>
              <Button variant="outline" className="w-full" onClick={() => navigate('/evidence')}>
                Open evidence passports <ArrowRight className="h-4 w-4" />
              </Button>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Attention"
              description="Signals that need a human decision."
              icon={<TriangleAlert className="h-4 w-4" />}
            />
            <CardBody className="space-y-2">
              <Link
                to="/projects?archived=false"
                className="flex items-center justify-between rounded-lg border border-line-soft bg-ink-900/50 px-3 py-2.5 text-xs text-slate-300 transition hover:border-line-strong"
              >
                <span className="inline-flex items-center gap-2">
                  <XCircle className="h-3.5 w-3.5 text-negative" /> Failing projects
                </span>
                <span className="font-semibold text-white">{dashboard.projects.failing}</span>
              </Link>
              <Link
                to="/database"
                className="flex items-center justify-between rounded-lg border border-line-soft bg-ink-900/50 px-3 py-2.5 text-xs text-slate-300 transition hover:border-line-strong"
              >
                <span className="inline-flex items-center gap-2">
                  <Database className="h-3.5 w-3.5 text-cyan" /> Database readiness
                </span>
                <Badge tone={dashboard.database.reachable ? 'positive' : 'negative'}>
                  {dashboard.database.reachable ? 'ready' : 'offline'}
                </Badge>
              </Link>
              <Link
                to="/settings?tab=notifications"
                className="flex items-center justify-between rounded-lg border border-line-soft bg-ink-900/50 px-3 py-2.5 text-xs text-slate-300 transition hover:border-line-strong"
              >
                <span className="inline-flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-accent-soft" /> Unread notifications
                </span>
                <span className="font-semibold text-white">{dashboard.unreadNotifications}</span>
              </Link>
            </CardBody>
          </Card>
        </div>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Recent verification runs"
          description="Newest runs across every project, including runs that stopped early."
          icon={<Activity className="h-4 w-4" />}
          actions={
            <Button variant="ghost" size="sm" onClick={() => navigate('/runs')}>
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <CardBody className="p-0">
          {dashboard.recentRuns.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No runs recorded"
                description="A run appears here as soon as the first check executes."
                icon={<Activity className="h-5 w-5" />}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Project</th>
                    <th>Progress</th>
                    <th>Trigger</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {dashboard.recentRuns.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="font-medium text-slate-200">{run.projectName}</td>
                      <td className="min-w-[160px]">
                        <div className="flex items-center gap-2">
                          <ProgressBar
                            completed={
                              run.counts.passed + run.counts.failed + run.counts.blocked + run.counts.unverified
                            }
                            total={run.counts.total}
                            className="w-24"
                          />
                          <span className="text-[11px] text-muted">
                            {run.counts.passed}/{run.counts.total}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="chip">{run.trigger}</span>
                      </td>
                      <td className="text-xs text-muted">{timeAgo(run.startedAt)}</td>
                      <td className="text-xs text-muted">{formatDuration(run.counts.durationMs)}</td>
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
          )}
        </CardBody>
      </Card>
    </div>
  );
}
