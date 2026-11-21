import * as React from 'react';
import { Link } from 'react-router-dom';
import { Activity, BarChart3, ChartNoAxesCombined, Globe2, ShieldAlert, Timer, TriangleAlert } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDuration, kindLabel } from '../lib/utils';
import type { AnalyticsOverview, CrossOsData, FlakyTest } from '../types';
import { ErrorState, LoadingCard, PageHeader } from '../components/common';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, Select, StatCard } from '../components/ui';

const DAY_OPTIONS = [7, 30, 90, 365];

export function AnalyticsPage() {
  useDocumentTitle('Analytics');
  const [days, setDays] = React.useState(30);
  const { data, error, loading, reload } = useAsync<{
    overview: AnalyticsOverview;
    crossOs: CrossOsData;
    flaky: { items: FlakyTest[] };
  }>(
    async (signal) => {
      const [overview, crossOs, flaky] = await Promise.all([
        api.get<AnalyticsOverview>(`/api/v1/analytics/overview?days=${days}`, signal),
        api.get<CrossOsData>(`/api/v1/analytics/cross-os?days=${days}`, signal),
        api.get<{ items: FlakyTest[] }>(`/api/v1/analytics/flaky?days=${days}`, signal),
      ]);
      return { overview, crossOs, flaky };
    },
    [days],
  );

  if (loading) return <LoadingCard label="Computing analytics…" />;
  if (error || !data) return <ErrorState error={error ?? 'Analytics unavailable.'} onRetry={reload} />;
  const { overview, crossOs, flaky } = data;
  const passRate = overview.totals.passRate === null ? null : Math.round(overview.totals.passRate * 100);
  const topFlaky = flaky.items.slice(0, 10);

  return (
    <div className="fade-in">
      <PageHeader
        title="Analytics"
        description="Aggregates computed live from stored runs, results and environments. No sample data is inserted."
        icon={<ChartNoAxesCombined className="h-5 w-5" />}
        actions={
          <Select className="w-[170px]" value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {DAY_OPTIONS.map((value) => (
              <option key={value} value={value}>
                Last {value} days
              </option>
            ))}
          </Select>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Runs"
          value={overview.totals.runs}
          hint={`${overview.totals.finished} finished · ${overview.totals.runs - overview.totals.finished} in progress`}
          icon={<Activity className="h-4 w-4" />}
        />
        <StatCard
          label="Pass rate"
          value={passRate === null ? '—' : `${passRate}%`}
          hint={`${overview.totals.passed} passed · ${overview.totals.failed} failed`}
          tone={passRate === null ? 'default' : passRate >= 90 ? 'positive' : passRate >= 60 ? 'warning' : 'negative'}
          icon={<BarChart3 className="h-4 w-4" />}
        />
        <StatCard
          label="Checks passed"
          value={overview.totals.checksPassed}
          hint={`${overview.totals.checksFailed} failed of ${overview.totals.checks} executed`}
          tone={overview.totals.checksFailed > 0 ? 'warning' : 'positive'}
        />
        <StatCard
          label="Average run duration"
          value={formatDuration(overview.totals.avgDurationMs)}
          hint="Across finished runs"
          icon={<Timer className="h-4 w-4" />}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Run outcomes over time"
            description="Daily run counts and outcomes in the selected window."
            icon={<Activity className="h-4 w-4" />}
          />
          <CardBody>
            {overview.series.length === 0 ? (
              <EmptyState
                title="No runs in this window"
                description="Start a verification run to populate the trend."
              />
            ) : (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={overview.series} margin={{ top: 6, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(value: string) => value.slice(5)}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={20}
                    />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
                    <Tooltip
                      contentStyle={{
                        background: '#0d1220',
                        border: '1px solid #1d2440',
                        borderRadius: 12,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: '#c7cee6' }}
                    />
                    <Line type="monotone" dataKey="passed" name="Passed" stroke="#34d399" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="failed" name="Failed" stroke="#f87171" strokeWidth={2} dot={false} />
                    <Line
                      type="monotone"
                      dataKey="blocked"
                      name="Blocked"
                      stroke="#fbbf24"
                      strokeWidth={1.5}
                      dot={false}
                    />
                    <Line type="monotone" dataKey="runs" name="Runs" stroke="#7c5cff" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Failures by check kind"
            description="Where executed checks fail, aggregated across the window."
            icon={<BarChart3 className="h-4 w-4" />}
          />
          <CardBody>
            {overview.byKind.length === 0 ? (
              <EmptyState title="No checks recorded" description="Check results will appear after a run finishes." />
            ) : (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={overview.byKind.map((item) => ({ ...item, label: kindLabel(item.kind) }))}
                    margin={{ top: 6, right: 8, bottom: 0, left: -20 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      angle={-18}
                      height={50}
                      textAnchor="end"
                    />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
                    <Tooltip
                      contentStyle={{
                        background: '#0d1220',
                        border: '1px solid #1d2440',
                        borderRadius: 12,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: '#c7cee6' }}
                    />
                    <Bar dataKey="total" name="Executed" fill="#2a3558" radius={[5, 5, 0, 0]} />
                    <Bar dataKey="failures" name="Failed" fill="#f87171" radius={[5, 5, 0, 0]}>
                      {overview.byKind.map((entry) => (
                        <Cell key={entry.kind} fill={entry.failures > 0 ? '#f87171' : '#34d399'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader
            title="Most frequent failures"
            description="Top failing check keys in the selected window."
            icon={<TriangleAlert className="h-4 w-4" />}
          />
          <CardBody className="p-0">
            {overview.topFailures.length === 0 ? (
              <p className="p-4 text-xs text-muted">No failures recorded in this window.</p>
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Title</th>
                    <th>Failures</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.topFailures.map((failure) => (
                    <tr key={`${failure.key}-${failure.title}`}>
                      <td className="font-mono text-[10.5px]">{failure.key}</td>
                      <td className="text-[11.5px]">{failure.title}</td>
                      <td>
                        <Badge tone="negative">{failure.failures}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Project performance"
            description="Runs and checks by project in this window."
            icon={<ChartNoAxesCombined className="h-4 w-4" />}
          />
          <CardBody className="p-0">
            {overview.projects.length === 0 ? (
              <p className="p-4 text-xs text-muted">No project activity in this window.</p>
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Runs</th>
                    <th>Passed</th>
                    <th>Check rate</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.projects.map((project) => (
                    <tr key={project.projectId}>
                      <td>
                        <Link
                          to={`/projects/${project.projectId}`}
                          className="text-[11.5px] text-slate-200 hover:text-accent-soft"
                        >
                          {project.name}
                        </Link>
                      </td>
                      <td className="text-[11px]">{project.runs}</td>
                      <td className="text-[11px] text-positive">{project.passed}</td>
                      <td className="text-[11px]">
                        {project.checks ? `${Math.round((project.checksPassed / project.checks) * 100)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Cross-OS comparison"
            description="Independent evidence from each platform that recorded runs."
            icon={<Globe2 className="h-4 w-4" />}
          />
          <CardBody className="space-y-3">
            {crossOs.platforms.length === 0 ? (
              <EmptyState
                title="No platform data"
                description="Runs record their platform, architecture and OS release."
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-line">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Platform</th>
                      <th>Runs</th>
                      <th>Pass rate</th>
                      <th>Check rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crossOs.platforms.map((platform) => (
                      <tr key={`${platform.platform}-${platform.arch}`}>
                        <td>
                          <div className="text-[11.5px] text-slate-200">
                            {platform.os} · {platform.platform}/{platform.arch}
                          </div>
                        </td>
                        <td className="text-[11px]">
                          {platform.runs} <span className="text-slate-600">({platform.failed} failed)</span>
                        </td>
                        <td className="text-[11px]">
                          {platform.passRate === null ? '—' : `${Math.round(platform.passRate * 100)}%`}
                        </td>
                        <td className="text-[11px]">
                          {platform.checkPassRate === null ? '—' : `${Math.round(platform.checkPassRate * 100)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Alert tone="warning" title="How to read this">
              <ul className="list-disc space-y-1 pl-4">
                {crossOs.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Alert>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Flaky checks"
            description="Checks that alternate outcomes across recorded runs. Minimum history required."
            icon={<ShieldAlert className="h-4 w-4" />}
          />
          <CardBody className="p-0">
            {topFlaky.length === 0 ? (
              <p className="p-4 text-xs text-muted">No alternating-outcome checks detected in this window.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Check</th>
                      <th>Runs</th>
                      <th>Alternations</th>
                      <th>Failures</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topFlaky.map((test) => (
                      <tr key={test.testName}>
                        <td className="max-w-[320px] truncate text-[11px] text-slate-300" title={test.testName}>
                          {test.testName}
                        </td>
                        <td className="text-[11px]">{test.runs}</td>
                        <td>
                          <Badge tone={test.alternations >= 3 ? 'negative' : 'warning'}>{test.alternations}</Badge>
                        </td>
                        <td className="text-[11px]">{test.failures}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4">
        <Card className="p-4">
          <div className="flex items-start gap-2.5 text-[11.5px] leading-relaxed text-slate-400">
            <Activity className="mt-0.5 h-4 w-4 shrink-0 text-accent-soft" />
            <span>
              All figures are derived from database rows created by actual runs. When there is insufficient history,
              ZetHub Proof shows an empty state instead of inventing a trend. Cross-OS comparison becomes meaningful
              only when the same commit is verified on multiple platforms; this local deployment does not execute tests
              on remote machines.
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}
