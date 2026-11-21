import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  DownloadCloud,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  UpdateCheckResponse,
  UpdateDownloadJob,
  UpdateStagedRelease,
  UpdateSystemStatus,
} from '@zethub/shared-types';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import type { UpdateInstallResult } from '../types';
import { formatDate } from '../lib/utils';
import { useAuth } from './AuthProvider';
import { Alert, Badge, Button, Modal, Spinner } from '../components/ui';
import { ProgressBar } from '../components/common';

const AWAITING_KEY = 'zethub:update:awaiting-version';

interface UpdateContextValue {
  status: UpdateSystemStatus | null;
  check: UpdateCheckResponse | null;
  job: UpdateDownloadJob | null;
  checking: boolean;
  busy: boolean;
  error: string | null;
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  checkNow: (force?: boolean) => Promise<UpdateCheckResponse | null>;
  startDownload: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  installNow: () => Promise<UpdateInstallResult | null>;
  remindLater: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  staged: UpdateStagedRelease[];
}

const UpdateContext = React.createContext<UpdateContextValue | null>(null);

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const { user, settings, applySettings } = useAuth();
  const [status, setStatus] = React.useState<UpdateSystemStatus | null>(null);
  const [check, setCheck] = React.useState<UpdateCheckResponse | null>(null);
  const [job, setJob] = React.useState<UpdateDownloadJob | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [installResult, setInstallResult] = React.useState<UpdateInstallResult | null>(null);
  const autoChecked = React.useRef(false);

  const refreshStatus = React.useCallback(async () => {
    try {
      const next = await api.get<UpdateSystemStatus>('/api/v1/updates/status');
      setStatus(next);
      const awaiting = window.localStorage.getItem(AWAITING_KEY);
      if (awaiting && next.currentVersion === awaiting) {
        window.localStorage.removeItem(AWAITING_KEY);
        setCheck((current) =>
          current && current.latestVersion === awaiting
            ? { ...current, status: 'none', updateAvailable: false, message: `Updated to version ${awaiting}.` }
            : current,
        );
        toast.success(`ZetHub Proof ${awaiting} is running.`);
      }
    } catch {
      /* status is informative; checking exposes the actionable error */
    }
  }, []);

  const checkNow = React.useCallback(
    async (force = false) => {
      setChecking(true);
      setError(null);
      try {
        const result = await api.get<UpdateCheckResponse>(
          `/api/v1/updates/check?channel=${encodeURIComponent(settings?.updateChannel ?? 'stable')}${force ? '&force=1' : ''}`,
        );
        setCheck(result);
        if (result.status === 'available' && force) {
          setPanelOpen(true);
        } else if (result.status === 'error' || result.status === 'unavailable') {
          setError(result.message);
        }
        void refreshStatus();
        return result;
      } catch (caught) {
        setError(errorMessage(caught));
        return null;
      } finally {
        setChecking(false);
      }
    },
    [refreshStatus, settings?.updateChannel],
  );

  React.useEffect(() => {
    if (!user) return;
    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(), 120_000);
    return () => window.clearInterval(interval);
  }, [refreshStatus, user]);

  React.useEffect(() => {
    if (!user || !settings?.updateAutoCheck || autoChecked.current) return;
    autoChecked.current = true;
    const timer = window.setTimeout(() => void checkNow(false), 8_000);
    return () => window.clearTimeout(timer);
  }, [checkNow, settings?.updateAutoCheck, user]);

  React.useEffect(() => {
    if (!user || !settings?.updateAutoCheck) return;
    const minutes = Math.max(15, settings.updateCheckIntervalMinutes ?? 360);
    const timer = window.setInterval(() => void checkNow(false), minutes * 60_000);
    return () => window.clearInterval(timer);
  }, [checkNow, settings?.updateAutoCheck, settings?.updateCheckIntervalMinutes, user]);

  React.useEffect(() => {
    if (!job || !['queued', 'downloading', 'verifying'].includes(job.status)) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api.get<UpdateDownloadJob>(`/api/v1/updates/downloads/${encodeURIComponent(job.id)}`);
        if (cancelled) return;
        setJob(next);
        if (next.status === 'ready') {
          toast.success('Update downloaded and verified.');
          void refreshStatus();
        } else if (next.status === 'failed') {
          toast.error(next.error ?? 'The update download failed verification.');
        }
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    }, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job, refreshStatus]);

  const startDownload = React.useCallback(async () => {
    if (!check?.release) return;
    setBusy(true);
    setError(null);
    setInstallResult(null);
    try {
      const next = await api.post<UpdateDownloadJob>('/api/v1/updates/download', {
        releaseId: check.release.id,
      });
      setJob(next);
      toast.info(`Downloading ${check.release.fileName}…`);
    } catch (caught) {
      setError(errorMessage(caught));
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [check?.release]);

  const cancelDownload = React.useCallback(async () => {
    if (!job) return;
    try {
      const next = await api.post<UpdateDownloadJob>(`/api/v1/updates/downloads/${encodeURIComponent(job.id)}/cancel`);
      setJob(next);
      toast.info('Update download cancelled.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }, [job]);

  const installNow = React.useCallback(async () => {
    const release = check?.release;
    if (!release) return null;
    if ((status?.activeRuns ?? 0) > 0) {
      toast.error('Installation is deferred while verification runs are active.');
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<UpdateInstallResult>('/api/v1/updates/install', {
        releaseId: release.id,
        consent: true,
      });
      setInstallResult(result);
      if (result.status === 'installer-started') {
        window.localStorage.setItem(AWAITING_KEY, release.version);
        toast.success('Installer launched. The update is confirmed only after the new version reports itself.');
      } else {
        toast.info('Verified package is ready for manual installation.');
      }
      await refreshStatus();
      return result;
    } catch (caught) {
      setError(errorMessage(caught));
      toast.error(errorMessage(caught));
      return null;
    } finally {
      setBusy(false);
    }
  }, [check?.release, refreshStatus, status?.activeRuns]);

  const remindLater = React.useCallback(async () => {
    const version = check?.latestVersion;
    if (!version || !settings) {
      setPanelOpen(false);
      return;
    }
    try {
      const next = { ...settings, updateSkippedVersion: version };
      const result = await api.put<{ settings: typeof next }>('/api/v1/settings', next);
      applySettings(result.settings);
      toast.info(`You will be reminded about ${version} later. Mandatory updates are never skipped.`);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
    setPanelOpen(false);
  }, [applySettings, check?.latestVersion, settings]);

  const staged = React.useMemo(() => status?.staged ?? [], [status?.staged]);
  const skipped = Boolean(check?.latestVersion && settings?.updateSkippedVersion === check.latestVersion);
  const visibleAvailable = Boolean(check?.updateAvailable && (check.mandatory || !skipped));

  const value = React.useMemo<UpdateContextValue>(
    () => ({
      status,
      check,
      job,
      checking,
      busy,
      error,
      panelOpen,
      openPanel: () => setPanelOpen(true),
      closePanel: () => setPanelOpen(false),
      checkNow,
      startDownload,
      cancelDownload,
      installNow,
      remindLater,
      refreshStatus,
      staged,
    }),
    [
      status,
      check,
      job,
      checking,
      busy,
      error,
      panelOpen,
      checkNow,
      startDownload,
      cancelDownload,
      installNow,
      remindLater,
      refreshStatus,
      staged,
    ],
  );

  const release = check?.release ?? null;
  const verification = release?.verification ?? 'unavailable';
  const verificationOk = verification === 'verified';

  return (
    <UpdateContext.Provider value={value}>
      {children}
      <Modal
        open={panelOpen}
        onOpenChange={setPanelOpen}
        title="Software updates"
        description="Signed releases from your configured update service. Nothing is installed without your explicit consent."
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPanelOpen(false)}>
              Close
            </Button>
            {check?.updateAvailable && !check.mandatory ? (
              <Button variant="outline" onClick={() => void remindLater()}>
                Remind me later
              </Button>
            ) : null}
            {check?.updateAvailable && (!job || job.status === 'failed' || job.status === 'cancelled') ? (
              <Button onClick={() => void startDownload()} loading={busy}>
                <DownloadCloud className="h-4 w-4" /> Download update
              </Button>
            ) : null}
            {job?.status === 'ready' ? (
              <Button onClick={() => void installNow()} loading={busy} disabled={(status?.activeRuns ?? 0) > 0}>
                <ShieldCheck className="h-4 w-4" /> Install verified update
              </Button>
            ) : null}
          </>
        }
      >
        <div className="space-y-4">
          <div className="glass-soft flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3.5">
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-lavender/70">
                Installed version
              </div>
              <div className="mt-0.5 text-lg font-semibold text-white">
                v{status?.currentVersion ?? check?.currentVersion ?? '—'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-lavender/70">
                Latest {settings?.updateChannel ?? status?.channel ?? 'stable'}
              </div>
              <div className="mt-0.5 text-lg font-semibold text-white">{check?.latestVersion ?? '—'}</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => void checkNow(true)} loading={checking}>
              <RefreshCw className="h-3.5 w-3.5" /> Check now
            </Button>
          </div>

          {error ? (
            <Alert tone="danger" title="Update check failed">
              {error}
            </Alert>
          ) : null}

          {!status?.publicKeyConfigured ? (
            <Alert tone="warning" title="Update verification is not configured">
              No update public key is deployed. The application will not check for or install updates until this is
              configured. Existing features are unaffected.
            </Alert>
          ) : null}

          {check?.status === 'none' ? (
            <div className="flex items-center gap-3 rounded-2xl border border-positive/20 bg-positive/5 px-4 py-3.5">
              <CheckCircle2 className="h-5 w-5 text-positive" />
              <div>
                <div className="text-sm font-medium text-white">You are up to date</div>
                <div className="text-xs text-muted">{check.message}</div>
              </div>
            </div>
          ) : null}

          {check?.status === 'paused' || check?.status === 'incompatible' ? (
            <Alert tone="warning" title={check.status === 'paused' ? 'Release paused' : 'Release incompatible'}>
              {check.message}
            </Alert>
          ) : null}

          {visibleAvailable && release ? (
            <>
              <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Sparkles className="h-4 w-4 text-ember-soft" />
                  <span className="text-sm font-semibold text-white">ZetHub Proof {release.version} is available</span>
                  {check?.mandatory ? <Badge tone="warning">Mandatory</Badge> : <Badge tone="accent">Optional</Badge>}
                  <Badge tone={verificationOk ? 'positive' : 'negative'}>
                    {verificationOk ? 'Signature verified' : 'Signature failed'}
                  </Badge>
                </div>
                <div className="mt-3 grid gap-2 text-[11.5px] text-muted sm:grid-cols-2">
                  <div>Published: {formatDate(release.publishedAt)}</div>
                  <div>Rollout: {release.rolloutPercent}%</div>
                  <div>
                    Package: {release.fileName} ({Math.round(release.sizeBytes / 1024 / 1024)} MB)
                  </div>
                  <div>
                    Platform: {release.platform}/{release.arch}
                  </div>
                </div>
                {release.notes ? (
                  <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap rounded-xl border border-white/5 bg-black/20 p-3 font-sans text-[12px] leading-relaxed text-slate-300">
                    {release.notes}
                  </pre>
                ) : (
                  <p className="mt-3 text-xs text-muted">No release notes were provided.</p>
                )}
                <div className="mt-3 break-all font-mono text-[10.5px] text-slate-500">SHA-256 {release.sha256}</div>
              </div>

              {job ? (
                <div className="rounded-2xl border border-line-soft bg-ink-900/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-white">
                      {['queued', 'downloading', 'verifying'].includes(job.status) ? (
                        <Spinner />
                      ) : job.status === 'ready' ? (
                        <ShieldCheck className="h-4 w-4 text-positive" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-warning" />
                      )}
                      {job.status === 'ready'
                        ? 'Downloaded, checksum and signature verified'
                        : job.status === 'verifying'
                          ? 'Verifying package…'
                          : job.status === 'failed'
                            ? 'Download failed'
                            : job.status === 'cancelled'
                              ? 'Download cancelled'
                              : 'Downloading…'}
                    </div>
                    <span className="text-xs text-muted">{Math.round(job.progress * 100)}%</span>
                  </div>
                  <ProgressBar completed={Math.round(job.progress * 100)} total={100} className="mt-3" />
                  {job.error ? <p className="mt-2 text-xs text-negative">{job.error}</p> : null}
                  {['queued', 'downloading', 'verifying'].includes(job.status) ? (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => void cancelDownload()}>
                      <X className="h-3.5 w-3.5" /> Cancel download
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {(status?.activeRuns ?? 0) > 0 ? (
                <Alert tone="info" title="Installation deferred">
                  {status?.activeRuns} verification run(s) are active. Installation stays disabled until they finish, so
                  evidence generation is never interrupted.
                </Alert>
              ) : null}

              {installResult ? (
                <Alert
                  tone={installResult.status === 'manual-required' ? 'info' : 'success'}
                  title={
                    installResult.status === 'manual-required' ? 'Manual installation required' : 'Installer launched'
                  }
                >
                  <div>{installResult.message}</div>
                  {installResult.path ? (
                    <div className="mt-2 break-all font-mono text-[10.5px] text-slate-400">{installResult.path}</div>
                  ) : null}
                </Alert>
              ) : null}
            </>
          ) : null}

          {staged.length > 0 ? (
            <div className="rounded-2xl border border-line-soft bg-ink-900/40 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-lavender/70">
                Verified packages
              </div>
              <div className="mt-2 space-y-2">
                {staged.map((item) => (
                  <div key={item.releaseId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-slate-300">
                      {item.version} · {item.fileName}
                    </span>
                    <span className="text-muted">{formatDate(item.downloadedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <ExternalLink className="h-3 w-3" />
              Feed: {status?.feedConfigured ? status.feedUrl : 'local update store'}
            </span>
            <span>Channel: {settings?.updateChannel ?? 'stable'}</span>
          </div>
        </div>
      </Modal>
    </UpdateContext.Provider>
  );
}

export function useUpdates(): UpdateContextValue {
  const context = React.useContext(UpdateContext);
  if (!context) throw new Error('useUpdates must be used inside UpdateProvider.');
  return context;
}
