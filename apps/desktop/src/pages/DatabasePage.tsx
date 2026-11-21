import * as React from 'react';
import {
  ArrowDownToLine,
  CheckCircle2,
  CircleAlert,
  Database,
  HardDriveDownload,
  ListTree,
  Play,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Table2,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage, useAsync, useDocumentTitle } from '../lib/hooks';
import { formatBytes, formatDate, formatDuration, timeAgo } from '../lib/utils';
import type { BackupRecord, DbDashboard, DbTable } from '../types';
import { ErrorState, LoadingCard, PageHeader, KeyValue } from '../components/common';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Spinner,
  Textarea,
} from '../components/ui';

interface TablesResponse {
  tables: DbTable[];
  database: string;
}

interface SetupStep {
  step: string;
  status: 'passed' | 'failed' | 'skipped';
  message: string;
}

interface SetupResult {
  success: boolean;
  steps: SetupStep[];
  health: { read: boolean; write: boolean; cleanup: boolean; message: string } | null;
  migrations: DbDashboard['migrations'];
}

interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

interface HealthResult {
  health: { read: boolean; write: boolean; cleanup: boolean; message: string; latencyMs: number; checkedAt: string };
}

export function DatabasePage() {
  useDocumentTitle('Database');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [setup, setSetup] = React.useState<SetupResult | null>(null);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [migrateOpen, setMigrateOpen] = React.useState(false);
  const [backupOpen, setBackupOpen] = React.useState(false);
  const [xamppOpen, setXamppOpen] = React.useState(false);
  const [xamppPath, setXamppPath] = React.useState('');
  const [restoreTarget, setRestoreTarget] = React.useState<BackupRecord | null>(null);
  const [restoreName, setRestoreName] = React.useState('');
  const [preview, setPreview] = React.useState<{ table: string; rows: Array<Record<string, unknown>> } | null>(null);
  const [previewBusy, setPreviewBusy] = React.useState<string | null>(null);
  const [sql, setSql] = React.useState(
    'SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME LIMIT 20;',
  );
  const [queryResult, setQueryResult] = React.useState<QueryResult | null>(null);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  const [queryBusy, setQueryBusy] = React.useState(false);

  const { data, error, loading, reload } = useAsync<{ dashboard: DbDashboard; tables: TablesResponse }>(
    async (signal) => {
      const [dashboard, tables] = await Promise.all([
        api.get<DbDashboard>('/api/v1/db/dashboard', signal),
        api.get<TablesResponse>('/api/v1/db/tables', signal).catch(() => ({ tables: [], database: '' })),
      ]);
      return { dashboard, tables };
    },
    [],
  );

  const dashboard = data?.dashboard;
  const tables = data?.tables.tables ?? [];
  const databaseName = data?.tables.database || dashboard?.connection.database || 'zethub_proof';

  async function runAction(key: string, work: () => Promise<void>) {
    setBusy(key);
    try {
      await work();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const verifySetup = () =>
    runAction('setup', async () => {
      const result = await api.post<SetupResult>('/api/v1/db/setup/verify');
      setSetup(result);
      setSetupOpen(true);
      toast[result.success ? 'success' : 'error'](
        result.success ? 'Database setup verified.' : 'Setup verification found failures.',
      );
      reload();
    });

  const startXampp = () =>
    runAction('xampp', async () => {
      const body: Record<string, unknown> = { confirm: true };
      if (xamppPath.trim()) body.installPath = xamppPath.trim();
      const result = await api.post<{ result: { started: boolean; message?: string }; detection: { found: boolean } }>(
        '/api/v1/db/xampp/start',
        body,
      );
      toast.success(
        result.result.message ??
          (result.result.started ? 'XAMPP database started.' : 'XAMPP database is already reachable.'),
      );
      setXamppOpen(false);
      reload();
    });

  const runMigrations = () =>
    runAction('migrate', async () => {
      const result = await api.post<{ ok: boolean; output: string }>('/api/v1/db/migrate', { confirm: true });
      toast.success(result.output ? 'Migrations deployed. See audit output for details.' : 'Migrations deployed.');
      setMigrateOpen(false);
      reload();
    });

  const runHealth = () =>
    runAction('health', async () => {
      const result = await api.post<HealthResult>('/api/v1/db/health');
      const { health } = result;
      toast[health.read && health.write ? 'success' : 'error'](
        `Read ${health.read ? 'ok' : 'failed'} · write ${health.write ? 'ok' : 'failed'} · ${health.latencyMs} ms`,
      );
      reload();
    });

  const createBackup = () =>
    runAction('backup', async () => {
      const result = await api.post<{ backup: BackupRecord }>('/api/v1/db/backups', { confirm: true });
      toast.success(`Backup created: ${result.backup.fileName} (${formatBytes(result.backup.sizeBytes)}).`);
      setBackupOpen(false);
      reload();
    });

  const verifyBackup = (backup: BackupRecord) =>
    runAction(`verify-${backup.id}`, async () => {
      const result = await api.post<{ verification: { verified: boolean; message: string } }>(
        `/api/v1/db/backups/${encodeURIComponent(backup.id)}/verify`,
      );
      toast[result.verification.verified ? 'success' : 'error'](
        result.verification.verified
          ? 'Backup hash matches the stored SHA-256.'
          : `Backup verification failed: ${result.verification.message}`,
      );
      reload();
    });

  async function doRestore() {
    if (!restoreTarget) return;
    setBusy('restore');
    try {
      const result = await api.post<{ ok: boolean; message: string; safetyBackup: BackupRecord | null }>(
        '/api/v1/db/restore',
        {
          backupId: restoreTarget.id,
          confirmDatabaseName: restoreName,
          confirm: true,
        },
      );
      toast.success(
        result.safetyBackup
          ? `Restore complete. Safety snapshot: ${result.safetyBackup.fileName}.`
          : 'Restore complete.',
      );
      setRestoreTarget(null);
      setRestoreName('');
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function previewTable(table: DbTable) {
    setPreviewBusy(table.name);
    try {
      const result = await api.get<{ table: string; rows: Array<Record<string, unknown>> }>(
        `/api/v1/db/tables/${encodeURIComponent(table.name)}/preview?limit=20`,
      );
      setPreview(result);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPreviewBusy(null);
    }
  }

  async function runQuery(event: React.FormEvent) {
    event.preventDefault();
    setQueryBusy(true);
    setQueryError(null);
    try {
      const result = await api.post<QueryResult>('/api/v1/db/query', { sql });
      setQueryResult(result);
    } catch (caught) {
      setQueryResult(null);
      setQueryError(errorMessage(caught));
    } finally {
      setQueryBusy(false);
    }
  }

  if (loading) return <LoadingCard label="Inspecting the database…" />;
  if (error || !dashboard) return <ErrorState error={error ?? 'Database dashboard unavailable.'} onRetry={reload} />;

  const { xampp, connection, migrations, backups } = dashboard;
  const pending = migrations.pending.length;
  const schemaOk = migrations.upToDate && migrations.failed.length === 0;
  const queryColumns = queryResult?.rows[0] ? Object.keys(queryResult.rows[0]) : [];

  return (
    <div className="fade-in">
      <PageHeader
        title="Database"
        description="XAMPP / MariaDB discovery, non-destructive setup verification, migration status, health probes, read-only browsing and verified backups."
        icon={<Database className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" onClick={reload}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button variant="outline" onClick={() => void verifySetup()} loading={busy === 'setup'}>
              <ShieldCheck className="h-4 w-4" /> Verify setup
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setXamppPath(xampp.installPath ?? '');
                setXamppOpen(true);
              }}
              disabled={busy === 'xampp'}
            >
              <Play className="h-4 w-4" /> {xampp.mysqlProcessRunning ? 'Restart / ensure running' : 'Start XAMPP'}
            </Button>
            <Button onClick={() => setBackupOpen(true)} disabled={!connection.ok || busy === 'backup'}>
              <HardDriveDownload className="h-4 w-4" /> Backup now
            </Button>
          </>
        }
      />

      {!xampp.found ? (
        <div className="mb-4">
          <Alert tone="warning" title="XAMPP installation not detected">
            An external MySQL or MariaDB server can still be used through the{' '}
            <span className="font-mono">DATABASE_URL</span> configuration. ZetHub Proof will not install or silently
            start services it cannot find. Use “Start XAMPP” to point at an existing installation.
          </Alert>
        </div>
      ) : null}

      {!connection.ok ? (
        <div className="mb-4">
          <Alert tone="danger" title="Application database connection failed">
            {connection.error ?? 'The database is unreachable.'} Start XAMPP or correct the connection configuration.
            Verification runs that require storage cannot execute until the database is available.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatusTile
          label="Connection"
          value={connection.ok ? 'Online' : 'Offline'}
          tone={connection.ok ? 'positive' : 'negative'}
          hint={connection.ok ? `${connection.latencyMs ?? 0} ms round-trip` : (connection.error ?? 'Unreachable')}
          icon={<Database className="h-4 w-4" />}
        />
        <StatusTile
          label="Server"
          value={connection.serverVersion ? connection.serverVersion.split('-')[0] : (xampp.serverVersion ?? '—')}
          hint={`${xampp.serverType ?? connection.serverType} · port ${dashboard.connection.port}`}
          icon={<ServerCog className="h-4 w-4" />}
        />
        <StatusTile
          label="Schema"
          value={schemaOk ? 'Up to date' : pending > 0 ? `${pending} pending` : 'Check failed'}
          tone={schemaOk ? 'positive' : pending > 0 ? 'warning' : 'negative'}
          hint={
            migrations.failed.length > 0
              ? `${migrations.failed.length} failed migration(s)`
              : `${migrations.applied.length} applied`
          }
          icon={<ListTree className="h-4 w-4" />}
        />
        <StatusTile
          label="Tables"
          value={dashboard.tableCount}
          hint={`Database ${dashboard.connection.database}`}
          icon={<Table2 className="h-4 w-4" />}
        />
        <StatusTile
          label="Backups"
          value={backups.length}
          hint={backups[0] ? `Latest ${timeAgo(backups[0].createdAt)}` : 'No backups yet'}
          icon={<HardDriveDownload className="h-4 w-4" />}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="XAMPP / MariaDB detection"
            description="Read-only discovery of the local installation and service state."
            icon={<ServerCog className="h-4 w-4" />}
            actions={
              <Badge tone={xampp.found ? 'positive' : 'warning'}>{xampp.found ? 'detected' : 'not found'}</Badge>
            }
          />
          <CardBody className="space-y-1">
            <KeyValue label="Install path" mono>
              {xampp.installPath ?? '—'}
            </KeyValue>
            <KeyValue label="MySQL bin" mono>
              {xampp.mysqlBinDir ?? '—'}
            </KeyValue>
            <KeyValue label="Server executable" mono>
              {xampp.serverExecutable ?? '—'}
            </KeyValue>
            <KeyValue label="Client executable" mono>
              {xampp.clientExecutable ?? '—'}
            </KeyValue>
            <KeyValue label="Dump executable" mono>
              {xampp.dumpExecutable ?? '—'}
            </KeyValue>
            <KeyValue label="Configured port">{xampp.configuredPort ?? '—'}</KeyValue>
            <KeyValue label="Data directory" mono>
              {xampp.dataDir ?? '—'}
            </KeyValue>
            <KeyValue label="MySQL process">
              {xampp.mysqlProcessRunning ? (
                <Badge tone="positive">running</Badge>
              ) : (
                <Badge tone="warning">stopped</Badge>
              )}
            </KeyValue>
            <KeyValue label="Apache">
              {xampp.apacheRunning ? <Badge tone="positive">running</Badge> : <Badge>stopped</Badge>}
            </KeyValue>
            <KeyValue label="phpMyAdmin" mono>
              {xampp.phpMyAdminUrl ?? xampp.phpMyAdminPath ?? 'not detected'}
            </KeyValue>
            {xampp.warnings.length > 0 ? (
              <div className="mt-3 rounded-lg border border-warning/25 bg-warning/5 p-3 text-[11px] leading-relaxed text-warning/90">
                <div className="mb-1 font-semibold">Detection warnings</div>
                <ul className="list-disc space-y-0.5 pl-4">
                  {xampp.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {xampp.candidates.length > 0 ? (
              <div className="mt-3">
                <div className="label mb-1.5">Installation candidates</div>
                <div className="space-y-1">
                  {xampp.candidates.slice(0, 6).map((candidate) => (
                    <div
                      key={candidate.path}
                      className="flex items-start justify-between gap-2 rounded-lg border border-line-soft bg-ink-900/40 px-2.5 py-1.5 text-[10.5px]"
                    >
                      <span className="min-w-0 break-all font-mono text-slate-400">{candidate.path}</span>
                      {candidate.valid ? (
                        <Badge tone="positive">valid</Badge>
                      ) : (
                        <Badge tone="warning" className="shrink-0">
                          {candidate.reason ?? 'invalid'}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Migrations"
            description="Applied and expected Prisma migrations for the application schema."
            icon={<ListTree className="h-4 w-4" />}
            actions={
              <Button
                size="sm"
                variant={schemaOk ? 'outline' : 'primary'}
                onClick={() => setMigrateOpen(true)}
                disabled={!connection.ok || pending === 0}
              >
                <ArrowDownToLine className="h-3.5 w-3.5" /> Deploy migrations
              </Button>
            }
          />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={schemaOk ? 'positive' : pending > 0 ? 'warning' : 'negative'}>
                {schemaOk ? 'schema current' : pending > 0 ? `${pending} pending` : 'schema error'}
              </Badge>
              <Badge>{migrations.applied.length} applied</Badge>
              {migrations.failed.length > 0 ? <Badge tone="negative">{migrations.failed.length} failed</Badge> : null}
            </div>
            {migrations.error ? (
              <Alert tone="danger" title="Migration status unavailable">
                {migrations.error}
              </Alert>
            ) : null}
            <div>
              <div className="label mb-1.5">Pending</div>
              {migrations.pending.length === 0 ? (
                <p className="text-[11px] text-slate-500">No pending migrations.</p>
              ) : (
                <ul className="space-y-1 text-[11px] font-mono text-warning/90">
                  {migrations.pending.map((migration) => (
                    <li key={migration} className="rounded border border-warning/20 bg-warning/5 px-2 py-1">
                      {migration}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="label mb-1.5">Applied ({migrations.applied.length})</div>
              <div className="max-h-[150px] space-y-1 overflow-y-auto">
                {migrations.applied.length === 0 ? (
                  <p className="text-[11px] text-slate-500">No migrations recorded.</p>
                ) : (
                  migrations.applied.map((migration) => (
                    <div
                      key={migration}
                      className="truncate rounded border border-line-soft bg-ink-900/40 px-2 py-1 font-mono text-[10px] text-slate-400"
                      title={migration}
                    >
                      {migration}
                    </div>
                  ))
                )}
              </div>
            </div>
            {migrations.failed.length > 0 ? (
              <Alert tone="danger" title="Failed migrations">
                <ul className="space-y-1 font-mono text-[10.5px]">
                  {migrations.failed.map((migration) => (
                    <li key={migration}>{migration}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Health checks"
            description="Read/write probe using a temporary table that is dropped immediately."
            icon={<CheckCircle2 className="h-4 w-4" />}
            actions={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runHealth()}
                loading={busy === 'health'}
                disabled={!connection.ok}
              >
                <Play className="h-3.5 w-3.5" /> Run probe
              </Button>
            }
          />
          <CardBody className="space-y-3">
            {dashboard.lastHealthCheck ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <ProbeTile label="Read" ok={dashboard.lastHealthCheck.readOk} />
                  <ProbeTile label="Write" ok={dashboard.lastHealthCheck.writeOk} />
                  <div className="rounded-xl border border-line-soft bg-ink-900/50 p-2.5 text-center">
                    <div className="text-[9px] uppercase tracking-[0.1em] text-muted">Latency</div>
                    <div className="mt-1 text-sm font-semibold text-slate-200">
                      {formatDuration(dashboard.lastHealthCheck.latencyMs)}
                    </div>
                  </div>
                </div>
                <p className="text-[10.5px] text-slate-500">
                  Last probe {formatDate(dashboard.lastHealthCheck.checkedAt)}
                </p>
              </>
            ) : (
              <EmptyState
                title="No health probe recorded"
                description="Run a probe to confirm the application account can read and write."
                icon={<CircleAlert className="h-5 w-5" />}
              />
            )}
            <div className="rounded-lg border border-line-soft bg-ink-900/40 p-3 text-[11px] leading-relaxed text-slate-400">
              The write probe uses a temporary table scoped to the session and drops it before returning. No application
              rows are created, changed or deleted.
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Backups"
            description="SQL dumps stored on disk with a SHA-256 recorded in the database. Verification recomputes the hash."
            icon={<HardDriveDownload className="h-4 w-4" />}
            actions={
              <Button size="sm" variant="outline" onClick={() => setBackupOpen(true)} disabled={!connection.ok}>
                <HardDriveDownload className="h-3.5 w-3.5" /> New backup
              </Button>
            }
          />
          <CardBody className="p-0">
            <div className="border-b border-line-soft px-3.5 py-2 text-[10px] text-slate-500">
              Directory <span className="font-mono">{dashboard.backupDirectory}</span>
            </div>
            {backups.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="No backups recorded"
                  description="Create a verified backup before migrations or a restore."
                  icon={<HardDriveDownload className="h-5 w-5" />}
                />
              </div>
            ) : (
              <div className="max-h-[320px] overflow-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Size</th>
                      <th>Created</th>
                      <th>Verified</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {backups.map((backup) => (
                      <tr key={backup.id}>
                        <td>
                          <div
                            className="max-w-[210px] truncate font-mono text-[10px] text-slate-300"
                            title={backup.path}
                          >
                            {backup.fileName}
                          </div>
                          <div className="truncate font-mono text-[9px] text-slate-600" title={backup.sha256}>
                            {backup.sha256.slice(0, 18)}…
                          </div>
                        </td>
                        <td className="text-[10.5px] text-slate-400">{formatBytes(backup.sizeBytes)}</td>
                        <td className="text-[10.5px] text-muted" title={formatDate(backup.createdAt)}>
                          {timeAgo(backup.createdAt)}
                        </td>
                        <td>
                          {backup.verified ? (
                            <Badge tone="positive">verified</Badge>
                          ) : (
                            <Badge tone="warning">unverified</Badge>
                          )}
                        </td>
                        <td>
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void verifyBackup(backup)}
                              loading={busy === `verify-${backup.id}`}
                              title="Recompute SHA-256"
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setRestoreTarget(backup);
                                setRestoreName('');
                              }}
                              disabled={!backup.verified}
                              title={backup.verified ? 'Restore this backup' : 'Verify the backup first'}
                            >
                              <ArrowDownToLine className="h-3.5 w-3.5" />
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
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Tables"
          description="Schema metadata for the application database only. Click a table to preview at most 20 rows."
          icon={<Table2 className="h-4 w-4" />}
          actions={
            <Badge tone="accent">
              {tables.length} tables · {dashboard.connection.database}
            </Badge>
          }
        />
        <CardBody className="p-0">
          {tables.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No tables visible"
                description="The application database is unreachable or has no schema deployed."
                icon={<Table2 className="h-5 w-5" />}
              />
            </div>
          ) : (
            <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
              {tables.map((table) => (
                <button
                  key={table.name}
                  onClick={() => void previewTable(table)}
                  className="group flex items-start justify-between gap-2 rounded-xl border border-line-soft bg-ink-900/40 p-3 text-left transition hover:border-line-strong hover:bg-ink-800/60"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11.5px] font-medium text-slate-200 group-hover:text-accent-soft">
                      {table.name}
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-500">
                      {table.columns.length} columns · {table.engine ?? 'engine unknown'}
                    </div>
                    <div className="mt-0.5 truncate text-[9.5px] text-slate-600">
                      {table.columns
                        .slice(0, 3)
                        .map((column) => column.name)
                        .join(', ')}
                      {table.columns.length > 3 ? '…' : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[11px] font-semibold text-slate-300">
                      {table.rows === null ? '—' : table.rows.toLocaleString()}
                    </div>
                    <div className="text-[9px] uppercase tracking-[0.08em] text-slate-600">rows</div>
                    {previewBusy === table.name ? <Spinner className="ml-auto mt-1 h-3 w-3" /> : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader
          title="Read-only query"
          description="Owner-only SQL console limited to a single SELECT / SHOW / DESCRIBE / EXPLAIN / WITH statement. Writes and administrative keywords are rejected by the API."
          icon={<TerminalSquare className="h-4 w-4" />}
          actions={<Badge>owner only</Badge>}
        />
        <CardBody className="space-y-3">
          <form className="space-y-3" onSubmit={runQuery}>
            <Textarea
              className="min-h-[110px] font-mono text-[11.5px]"
              value={sql}
              onChange={(event) => setSql(event.target.value)}
              spellCheck={false}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10.5px] text-slate-500">
                Results are capped at 200 rows. The API audits every query attempt.
              </p>
              <Button type="submit" size="sm" loading={queryBusy} disabled={!sql.trim()}>
                <Search className="h-3.5 w-3.5" /> Run query
              </Button>
            </div>
          </form>
          {queryError ? (
            <Alert tone="danger" title="Query rejected">
              {queryError}
            </Alert>
          ) : null}
          {queryResult ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500">
                <Badge tone="positive">{queryResult.rowCount} row(s)</Badge>
                <span>{queryResult.durationMs} ms</span>
                {queryResult.truncated ? <Badge tone="warning">truncated to 200</Badge> : null}
              </div>
              {queryResult.rows.length === 0 ? (
                <p className="text-[11.5px] text-slate-500">The statement returned no rows.</p>
              ) : (
                <div className="max-h-[360px] overflow-auto rounded-lg border border-line">
                  <table className="table-base">
                    <thead>
                      <tr>
                        {queryColumns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {queryResult.rows.map((row, index) => (
                        <tr key={index}>
                          {queryColumns.map((column) => (
                            <td key={column} className="max-w-[320px] break-all font-mono text-[10px] text-slate-400">
                              {row[column] === null ? (
                                <span className="text-slate-600">NULL</span>
                              ) : typeof row[column] === 'object' ? (
                                JSON.stringify(row[column])
                              ) : (
                                String(row[column])
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <div className="mt-4">
        <Alert tone="info" title="Destructive actions are intentionally limited">
          {dashboard.limits.destructiveActions} {dashboard.limits.postgres}
        </Alert>
      </div>

      <Modal
        open={setupOpen}
        onOpenChange={setSetupOpen}
        title="Setup verification"
        description="Each step runs a real probe. Nothing is installed, created or dropped."
        width="lg"
        footer={
          <Button variant="ghost" onClick={() => setSetupOpen(false)}>
            Close
          </Button>
        }
      >
        {setup ? (
          <div className="space-y-3">
            <Alert
              tone={setup.success ? 'success' : 'danger'}
              title={setup.success ? 'Setup verified' : 'Setup needs attention'}
            >
              {setup.success
                ? 'All required steps passed. Optional steps may be skipped when XAMPP is not used.'
                : 'At least one required step failed. Review the messages below.'}
            </Alert>
            <div className="space-y-2">
              {setup.steps.map((step) => (
                <div key={step.step} className="rounded-lg border border-line-soft bg-ink-900/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-slate-200">{step.step}</span>
                    <Badge
                      tone={step.status === 'passed' ? 'positive' : step.status === 'failed' ? 'negative' : 'default'}
                    >
                      {step.status}
                    </Badge>
                  </div>
                  <p className="mt-1 break-words text-[11px] leading-relaxed text-slate-400">{step.message}</p>
                </div>
              ))}
            </div>
            {setup.health ? (
              <div className="rounded-lg border border-line-soft bg-ink-900/40 p-3 text-[11px] text-slate-400">
                Probe: read {setup.health.read ? 'ok' : 'failed'} · write {setup.health.write ? 'ok' : 'failed'} ·
                cleanup {setup.health.cleanup ? 'ok' : 'failed'} — {setup.health.message}
              </div>
            ) : null}
          </div>
        ) : (
          <LoadingBlock />
        )}
      </Modal>

      <Modal
        open={xamppOpen}
        onOpenChange={setXamppOpen}
        title="Start the XAMPP database"
        description="ZetHub Proof starts the MySQL/MariaDB service already installed on this machine. It does not download or install XAMPP."
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setXamppOpen(false)} disabled={busy === 'xampp'}>
              Cancel
            </Button>
            <Button onClick={() => void startXampp()} loading={busy === 'xampp'}>
              <Play className="h-4 w-4" /> Start database
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Alert tone="warning" title="This starts a local service">
            Only a detected XAMPP installation is used. Existing databases and data are preserved; no setup or drop
            command is executed.
          </Alert>
          <Field
            label="XAMPP installation path"
            hint="Leave as detected, or provide the folder that contains mysql\bin."
          >
            <Input
              value={xamppPath}
              onChange={(event) => setXamppPath(event.target.value)}
              placeholder="D:\xampp"
              spellCheck={false}
            />
          </Field>
          <div className="grid gap-1 rounded-lg border border-line-soft bg-ink-900/40 p-3">
            <KeyValue label="Detected" mono>
              {xampp.installPath ?? '—'}
            </KeyValue>
            <KeyValue label="Port">{xampp.configuredPort ?? '—'}</KeyValue>
            <KeyValue label="Process">{xampp.mysqlProcessRunning ? 'running' : 'stopped'}</KeyValue>
          </div>
        </div>
      </Modal>

      <Modal
        open={migrateOpen}
        onOpenChange={setMigrateOpen}
        title="Deploy migrations"
        description="Prisma applies only the pending migrations in prisma/migrations. It does not reset or seed the database."
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMigrateOpen(false)} disabled={busy === 'migrate'}>
              Cancel
            </Button>
            <Button onClick={() => void runMigrations()} loading={busy === 'migrate'} disabled={pending === 0}>
              Deploy {pending} migration(s)
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-300">
          <p>
            Pending migrations will be applied to{' '}
            <span className="font-mono text-white">{dashboard.connection.database}</span>.
          </p>
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-warning/90">
            Take a verified backup first if this database contains data you cannot recreate. Existing rows are not
            deleted by a forward migration, but schema changes are still irreversible without a backup.
          </div>
          {migrations.pending.length > 0 ? (
            <ul className="space-y-1 font-mono text-[10.5px] text-slate-400">
              {migrations.pending.map((migration) => (
                <li key={migration}>{migration}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={backupOpen}
        onOpenChange={setBackupOpen}
        title="Create database backup"
        description="Runs mysqldump, writes a .sql file into the backups directory and records its SHA-256."
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBackupOpen(false)} disabled={busy === 'backup'}>
              Cancel
            </Button>
            <Button onClick={() => void createBackup()} loading={busy === 'backup'}>
              <HardDriveDownload className="h-4 w-4" /> Create backup
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-300">
          <p>
            The dump uses the configured administrative account and the application database{' '}
            <span className="font-mono text-white">{dashboard.connection.database}</span>.
          </p>
          <div className="grid gap-1 rounded-lg border border-line-soft bg-ink-900/40 p-3">
            <KeyValue label="Database" mono>
              {dashboard.connection.database}
            </KeyValue>
            <KeyValue label="Directory" mono>
              {dashboard.backupDirectory}
            </KeyValue>
            <KeyValue label="mysqldump" mono>
              {xampp.dumpExecutable ?? 'not detected'}
            </KeyValue>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(restoreTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRestoreTarget(null);
            setRestoreName('');
          }
        }}
        title="Restore database backup"
        description="Restoring replaces data in the application database. ZetHub Proof takes a safety snapshot before writing."
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoreTarget(null)} disabled={busy === 'restore'}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void doRestore()}
              loading={busy === 'restore'}
              disabled={restoreName !== databaseName}
            >
              <ArrowDownToLine className="h-4 w-4" /> Restore backup
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Alert tone="danger" title="This overwrites current rows">
            The selected dump will be imported into <span className="font-mono">{databaseName}</span>. A verified safety
            snapshot is created automatically first, but a restore still changes live data.
          </Alert>
          {restoreTarget ? (
            <div className="grid gap-1 rounded-lg border border-line-soft bg-ink-900/40 p-3">
              <KeyValue label="Backup" mono>
                {restoreTarget.fileName}
              </KeyValue>
              <KeyValue label="Size">{formatBytes(restoreTarget.sizeBytes)}</KeyValue>
              <KeyValue label="Created">{formatDate(restoreTarget.createdAt)}</KeyValue>
              <KeyValue label="SHA-256" mono>
                {restoreTarget.sha256.slice(0, 32)}…
              </KeyValue>
            </div>
          ) : null}
          <Field label={`Type ${databaseName} to confirm`}>
            <Input
              value={restoreName}
              onChange={(event) => setRestoreName(event.target.value)}
              placeholder={databaseName}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title={preview ? `Preview · ${preview.table}` : 'Table preview'}
        description="At most 20 rows, returned by the application account through a parameterised table lookup."
        width="2xl"
        footer={
          <Button variant="ghost" onClick={() => setPreview(null)}>
            Close
          </Button>
        }
      >
        {preview ? (
          preview.rows.length === 0 ? (
            <p className="text-xs text-muted">This table is empty.</p>
          ) : (
            <div className="space-y-2">
              <div className="text-[10.5px] text-slate-500">
                {preview.rows.length} row(s) · {Object.keys(preview.rows[0] ?? {}).length} column(s)
              </div>
              <div className="max-h-[60vh] overflow-auto rounded-lg border border-line">
                <table className="table-base">
                  <thead>
                    <tr>
                      {Object.keys(preview.rows[0] ?? {}).map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, index) => (
                      <tr key={index}>
                        {Object.keys(preview.rows[0] ?? {}).map((column) => (
                          <td key={column} className="max-w-[280px] break-all font-mono text-[10px] text-slate-400">
                            {row[column] === null ? (
                              <span className="text-slate-600">NULL</span>
                            ) : typeof row[column] === 'object' ? (
                              <span title={JSON.stringify(row[column])}>
                                {JSON.stringify(row[column]).slice(0, 120)}
                              </span>
                            ) : (
                              String(row[column]).slice(0, 240)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : null}
      </Modal>
    </div>
  );
}

function StatusTile({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'default' | 'positive' | 'warning' | 'negative';
  icon?: React.ReactNode;
}) {
  const tones = {
    default: 'text-white',
    positive: 'text-positive',
    warning: 'text-warning',
    negative: 'text-negative',
  };
  return (
    <Card className="p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</div>
          <div
            className={`mt-1.5 truncate text-[17px] font-semibold ${tones[tone]}`}
            title={typeof value === 'string' ? value : undefined}
          >
            {value}
          </div>
          {hint ? (
            <div
              className="mt-0.5 truncate text-[10px] text-slate-500"
              title={typeof hint === 'string' ? hint : undefined}
            >
              {hint}
            </div>
          ) : null}
        </div>
        {icon ? <div className="rounded-lg border border-line bg-ink-800/80 p-1.5 text-slate-400">{icon}</div> : null}
      </div>
    </Card>
  );
}

function ProbeTile({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div
      className={`rounded-xl border p-2.5 text-center ${ok ? 'border-positive/25 bg-positive/5' : 'border-negative/25 bg-negative/5'}`}
    >
      <div className="text-[9px] uppercase tracking-[0.1em] text-muted">{label}</div>
      <div
        className={`mt-1 inline-flex items-center gap-1 text-sm font-semibold ${ok ? 'text-positive' : 'text-negative'}`}
      >
        {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />} {ok ? 'ok' : 'failed'}
      </div>
    </div>
  );
}
