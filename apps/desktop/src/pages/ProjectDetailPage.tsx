import * as React from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  Boxes,
  CheckCircle2,
  CircleSlash,
  Database,
  FileSearch,
  FlaskConical,
  FolderCog,
  GitBranch,
  Layers,
  Play,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage, useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDate, kindLabel, timeAgo } from '../lib/utils';
import type { ProjectDetailResponse } from '../types';
import { ErrorState, LoadingCard, PageHeader, ProgressBar } from '../components/common';
import { PlanRunModal } from '../components/PlanRunModal';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  StatCard,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui';
import { CasesTab } from './project/CasesTab';
import { EnvironmentsTab } from './project/EnvironmentsTab';
import { QualityTab } from './project/QualityTab';
import { RepairsTab } from './project/RepairsTab';
import { ProjectSettingsTab } from './project/ProjectSettingsTab';

export interface ProjectTabProps {
  project: ProjectDetailResponse;
  reload: () => void;
  openRun: () => void;
}

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'cases', label: 'Test cases' },
  { value: 'runs', label: 'Runs' },
  { value: 'environments', label: 'Environments' },
  { value: 'quality', label: 'Quality' },
  { value: 'repairs', label: 'Repairs' },
  { value: 'settings', label: 'Settings' },
];

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [runOpen, setRunOpen] = React.useState(false);
  const [scanning, setScanning] = React.useState(false);
  const { data, error, loading, reload } = useAsync<ProjectDetailResponse>(
    (signal) => api.get<ProjectDetailResponse>(`/api/v1/projects/${encodeURIComponent(id)}`, signal),
    [id],
  );
  useDocumentTitle(data?.project.name ?? 'Project');

  const activeTab = TABS.some((tab) => tab.value === searchParams.get('tab')) ? searchParams.get('tab')! : 'overview';

  async function scan() {
    setScanning(true);
    try {
      const result = await api.post<{ detection: { ecosystems: unknown[]; tools: unknown[]; warnings: string[] } }>(
        `/api/v1/projects/${encodeURIComponent(id)}/scan`,
      );
      toast.success(
        `Scan complete · ${result.detection.ecosystems.length} ecosystem(s), ${result.detection.tools.length} tool(s).`,
      );
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setScanning(false);
    }
  }

  if (loading) return <LoadingCard label="Loading project…" />;
  if (error || !data) return <ErrorState error={error ?? 'Project unavailable.'} onRetry={reload} />;
  const { project } = data;

  return (
    <div className="fade-in">
      <PageHeader
        breadcrumb={
          <>
            <Link to="/projects" className="link">
              Projects
            </Link>{' '}
            <span className="mx-1.5 text-slate-600">/</span> {project.name}
          </>
        }
        title={project.name}
        description={project.description || 'No description yet. Add one in project settings.'}
        icon={<FolderCog className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" onClick={() => void scan()} loading={scanning} disabled={!project.rootPath}>
              <Radar className="h-4 w-4" /> {project.scanned ? 'Re-scan' : 'Scan project'}
            </Button>
            <Button onClick={() => setRunOpen(true)}>
              <Play className="h-4 w-4" /> Run verification
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone="accent">{project.sourceType}</Badge>
        <StatusBadge status={project.health} />
        {project.pinned ? <Badge tone="warning">pinned</Badge> : null}
        {project.archived ? <Badge>archived</Badge> : null}
        <span className="chip">{data.cases.length} cases</span>
        <span className="chip">{data.environments.length} environments</span>
        <span className="chip">{data.runs.length} recent runs</span>
        <span className="ml-auto text-[11px] text-muted">Last verified {timeAgo(project.lastVerifiedAt)}</span>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel-soft flex items-center gap-2.5 px-3.5 py-2.5">
          <FolderCog className="h-4 w-4 text-accent-soft" />
          <div className="min-w-0">
            <div className="text-[9.5px] uppercase tracking-[0.1em] text-muted">Source</div>
            <div
              className="truncate font-mono text-[10.5px] text-slate-300"
              title={project.rootPath ?? project.websiteUrl ?? ''}
            >
              {project.rootPath ?? project.websiteUrl ?? project.repoUrl ?? 'none'}
            </div>
          </div>
        </div>
        <div className="panel-soft flex items-center gap-2.5 px-3.5 py-2.5">
          <GitBranch className="h-4 w-4 text-cyan" />
          <div className="min-w-0">
            <div className="text-[9.5px] uppercase tracking-[0.1em] text-muted">Git</div>
            <div className="truncate text-[11px] text-slate-300">
              {data.detection?.git.isRepo
                ? `${data.detection.git.branch ?? 'detached'} · ${data.detection.git.commit?.slice(0, 8) ?? 'unknown'}`
                : 'Not a repository'}
            </div>
          </div>
        </div>
        <div className="panel-soft flex items-center gap-2.5 px-3.5 py-2.5">
          <Layers className="h-4 w-4 text-positive" />
          <div className="min-w-0">
            <div className="text-[9.5px] uppercase tracking-[0.1em] text-muted">Detected stack</div>
            <div className="truncate text-[11px] text-slate-300">
              {project.ecosystems.length ? project.ecosystems.map((e) => e.language).join(', ') : 'Not scanned'}
            </div>
          </div>
        </div>
        <div className="panel-soft flex items-center gap-2.5 px-3.5 py-2.5">
          <Activity className="h-4 w-4 text-warning" />
          <div className="min-w-0">
            <div className="text-[9.5px] uppercase tracking-[0.1em] text-muted">Last run</div>
            <div className="truncate text-[11px] text-slate-300">
              {data.runs[0]
                ? `${data.runs[0].status} · ${data.runs[0].counts.passed}/${data.runs[0].counts.total}`
                : 'No runs yet'}
            </div>
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setSearchParams({ tab: value }, { replace: true })}>
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              count={
                tab.value === 'cases'
                  ? data.cases.length
                  : tab.value === 'runs'
                    ? data.runs.length
                    : tab.value === 'environments'
                      ? data.environments.length
                      : undefined
              }
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab
            project={data}
            reload={reload}
            scan={scan}
            scanning={scanning}
            openRun={() => setRunOpen(true)}
          />
        </TabsContent>
        <TabsContent value="cases">
          <CasesTab project={data} reload={reload} openRun={() => setRunOpen(true)} />
        </TabsContent>
        <TabsContent value="runs">
          <RunsTab project={data} reload={reload} openRun={() => setRunOpen(true)} />
        </TabsContent>
        <TabsContent value="environments">
          <EnvironmentsTab project={data} reload={reload} openRun={() => setRunOpen(true)} />
        </TabsContent>
        <TabsContent value="quality">
          <QualityTab project={data} reload={reload} openRun={() => setRunOpen(true)} />
        </TabsContent>
        <TabsContent value="repairs">
          <RepairsTab project={data} reload={reload} openRun={() => setRunOpen(true)} />
        </TabsContent>
        <TabsContent value="settings">
          <ProjectSettingsTab project={data} reload={reload} openRun={() => setRunOpen(true)} />
        </TabsContent>
      </Tabs>

      <PlanRunModal
        projectId={project.id}
        projectName={project.name}
        open={runOpen}
        onOpenChange={setRunOpen}
        onStarted={(runId) => {
          reload();
          navigate(`/runs/${runId}`);
        }}
      />
    </div>
  );
}

function OverviewTab({
  project,
  scan,
  scanning,
  openRun,
}: ProjectTabProps & { scan: () => Promise<void>; scanning: boolean }) {
  const data = project;
  const detection = data.detection;
  if (!detection) {
    return (
      <Card className="p-5">
        <EmptyState
          icon={<FileSearch className="h-5 w-5" />}
          title="This project has not been scanned"
          description={
            data.project.rootPath
              ? 'Scanning detects languages, tools, manifests and Git state without modifying the source.'
              : 'Attach a local folder in project settings before scanning. URL-only projects can still run browser and API scenarios.'
          }
          action={
            <Button onClick={() => void scan()} loading={scanning} disabled={!data.project.rootPath}>
              <Radar className="h-4 w-4" /> Scan now
            </Button>
          }
        />
      </Card>
    );
  }

  const availableTools = detection.tools.filter((tool) => tool.available).length;
  const runtime = Object.entries(detection.runtime).filter(([, value]) => Boolean(value));

  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Ecosystems"
            value={detection.ecosystems.length}
            hint={detection.ecosystems.map((e) => e.language).join(', ') || 'None detected'}
            icon={<Boxes className="h-4 w-4" />}
          />
          <StatCard
            label="Tools available"
            value={`${availableTools}/${detection.tools.length}`}
            hint="Detected by probing the machine"
            tone={availableTools > 0 ? 'positive' : 'warning'}
            icon={<Wrench className="h-4 w-4" />}
          />
          <StatCard
            label="Test tools"
            value={detection.testTools.length}
            hint={detection.testTools.slice(0, 3).join(', ') || 'No test entries'}
            icon={<FlaskConical className="h-4 w-4" />}
          />
          <StatCard
            label="Database / API"
            value={`${detection.database.detected ? 'DB' : '—'} / ${detection.api.detected ? 'API' : '—'}`}
            hint="Detection only; no connections made"
            icon={<Database className="h-4 w-4" />}
          />
        </div>

        {detection.warnings.length > 0 ? (
          <Card className="border-warning/25 p-3.5">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-warning">
              <ShieldAlert className="h-4 w-4" /> Detection warnings
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[11.5px] leading-relaxed text-slate-400">
              {detection.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title="Detected tools"
            description={`Read-only probe from ${formatDate(detection.scannedAt)}. Unavailable tools stay visible with their reason.`}
            icon={<Wrench className="h-4 w-4" />}
            actions={
              <Button variant="outline" size="sm" onClick={() => void scan()} loading={scanning}>
                <Radar className="h-3.5 w-3.5" /> Re-scan
              </Button>
            }
          />
          <CardBody className="p-0">
            {detection.tools.length === 0 ? (
              <p className="p-4 text-xs text-muted">No test or build tools were detected for this project.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Kind</th>
                      <th>Available</th>
                      <th>Version</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detection.tools.map((tool) => (
                      <tr key={tool.id}>
                        <td>
                          <div className="font-medium text-slate-200">{tool.name}</div>
                          <div className="font-mono text-[10px] text-slate-500">{tool.id}</div>
                        </td>
                        <td>
                          <Badge>{kindLabel(tool.kind)}</Badge>
                        </td>
                        <td>
                          {tool.available ? (
                            <Badge tone="positive">
                              <CheckCircle2 className="h-2.5 w-2.5" /> yes
                            </Badge>
                          ) : (
                            <Badge tone="warning">unavailable</Badge>
                          )}
                        </td>
                        <td className="font-mono text-[10.5px]">{tool.version ?? '—'}</td>
                        <td className="max-w-[300px] text-[11px] text-slate-500">
                          {tool.reason ?? tool.configFile ?? '—'}
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
            title="Recent runs"
            description="Stored verification runs for this project."
            icon={<Activity className="h-4 w-4" />}
            actions={
              <Button size="sm" onClick={openRun}>
                <Play className="h-3.5 w-3.5" /> New run
              </Button>
            }
          />
          <CardBody className="p-0">
            {data.runs.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="No runs yet"
                  description="Build a plan and approve the checks you want to execute."
                  icon={<FlaskConical className="h-5 w-5" />}
                  action={
                    <Button size="sm" onClick={openRun}>
                      Run verification
                    </Button>
                  }
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Strategy</th>
                      <th>Progress</th>
                      <th>Started</th>
                      <th>Duration</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <StatusBadge status={run.status} />
                        </td>
                        <td>
                          <span className="chip">{run.strategy}</span>
                        </td>
                        <td>
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
                        <td className="text-[11px] text-muted">{timeAgo(run.startedAt)}</td>
                        <td className="text-[11px] text-muted">
                          {run.finishedAt && run.startedAt
                            ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
                            : '—'}
                        </td>
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

      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Detection snapshot"
            description="Facts captured during the last scan."
            icon={<FileSearch className="h-4 w-4" />}
          />
          <CardBody className="space-y-2 text-[11.5px]">
            <Info label="Root" value={<span className="font-mono">{detection.rootPath || '—'}</span>} />
            <Info label="Package managers" value={detection.packageManagers.join(', ') || '—'} />
            <Info label="Manifests" value={detection.manifests.join(', ') || '—'} />
            <Info label="Lockfiles" value={detection.lockfiles.join(', ') || '—'} />
            <Info
              label="Monorepo"
              value={detection.isMonorepo ? `yes · ${detection.subprojects.length} subprojects` : 'no'}
            />
            <Info
              label="Docker"
              value={detection.docker.detected ? detection.docker.files.join(', ') : 'not detected'}
            />
            <Info
              label="Database"
              value={
                detection.database.detected
                  ? `${detection.database.engines.join(', ') || 'engine unknown'}`
                  : 'not detected'
              }
            />
            <Info
              label="API spec"
              value={detection.api.detected ? detection.api.specFiles.join(', ') : 'not detected'}
            />
          </CardBody>
        </Card>

        {runtime.length > 0 ? (
          <Card>
            <CardHeader
              title="Runtime"
              description="Executables found on this machine."
              icon={<Layers className="h-4 w-4" />}
            />
            <CardBody className="flex flex-wrap gap-1.5">
              {runtime.map(([name, value]) => (
                <span key={name} className="chip">
                  <span className="text-muted">{name}</span>{' '}
                  <span className="font-mono text-[10px] text-slate-300">{value}</span>
                </span>
              ))}
            </CardBody>
          </Card>
        ) : null}

        {detection.subprojects.length > 0 ? (
          <Card>
            <CardHeader
              title="Subprojects"
              description="Workspaces discovered below the root."
              icon={<Boxes className="h-4 w-4" />}
            />
            <CardBody className="space-y-2">
              {detection.subprojects.slice(0, 12).map((subproject) => (
                <div key={subproject.relPath} className="rounded-lg border border-line-soft bg-ink-900/40 px-3 py-2">
                  <div className="text-[12px] font-medium text-slate-200">{subproject.name}</div>
                  <div className="truncate font-mono text-[10px] text-slate-500">{subproject.relPath}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {subproject.languages.map((language) => (
                      <span key={language} className="chip text-[9.5px]">
                        {language}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        ) : null}

        {detection.unsupported.length > 0 ? (
          <Card>
            <CardHeader
              title="Not verified by this build"
              description="Honest coverage boundaries for this project."
              icon={<CircleSlash className="h-4 w-4" />}
            />
            <CardBody>
              <ul className="list-disc space-y-1.5 pl-4 text-[11.5px] leading-relaxed text-slate-400">
                {detection.unsupported.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title="Evidence integrity"
            description="Reports are generated only from stored results."
            icon={<ShieldCheck className="h-4 w-4" />}
          />
          <CardBody className="text-[11.5px] leading-relaxed text-slate-400">
            ZetHub Proof never reports a check as passed unless a result row exists with captured output. Evidence
            passports include SHA-256 hashes and an HMAC-signed manifest.
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line-soft pb-1.5 last:border-0">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 break-all text-right text-slate-300">{value}</span>
    </div>
  );
}

function RunsTab({ project, openRun }: ProjectTabProps) {
  return (
    <Card>
      <CardHeader
        title="Verification runs"
        description="Runs ordered by start time. Each run stores its own plan snapshot and environment."
        icon={<FlaskConical className="h-4 w-4" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={openRun}>
              <Play className="h-3.5 w-3.5" /> Run verification
            </Button>
            <Button variant="ghost" size="sm" onClick={() => window.location.assign('/runs')}>
              All runs
            </Button>
          </>
        }
      />
      <CardBody className="p-0">
        {project.runs.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No runs for this project"
              description="Run verification to create the first evidence record."
              icon={<FlaskConical className="h-5 w-5" />}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Trigger</th>
                  <th>Strategy</th>
                  <th>Checks</th>
                  <th>Started</th>
                  <th>Finished</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {project.runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <StatusBadge status={run.status} />
                    </td>
                    <td>
                      <span className="chip">{run.trigger}</span>
                    </td>
                    <td>
                      <span className="chip">{run.strategy}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-slate-300">
                          {run.counts.passed}/{run.counts.total}
                        </span>
                        <ProgressBar
                          completed={run.counts.passed + run.counts.failed + run.counts.blocked + run.counts.unverified}
                          total={run.counts.total}
                          className="w-20"
                        />
                      </div>
                    </td>
                    <td className="text-[11px] text-muted">{formatDate(run.startedAt)}</td>
                    <td className="text-[11px] text-muted">{run.finishedAt ? formatDate(run.finishedAt) : '—'}</td>
                    <td className="text-right">
                      <Link className="link text-xs" to={`/runs/${run.id}`}>
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
  );
}
