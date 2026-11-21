import * as React from 'react';
import type { UserSettings } from '@zethub/shared-types';
import {
  ArrowDownToLine,
  CirclePause,
  CirclePlay,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage, useAsync } from '../lib/hooks';
import { formatDate } from '../lib/utils';
import { useAuth } from '../providers/AuthProvider';
import { useUpdates } from '../providers/UpdateProvider';
import type { UpdateAdminBundle } from '../types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, Select, Switch, Textarea } from './ui';
import { KeyValue, ProgressBar } from './common';

interface Props {
  draft: UserSettings;
  setDraft: (settings: UserSettings) => void;
  saving: boolean;
  saveError: string | null;
  onSave: (event: React.FormEvent) => Promise<void>;
}

export function UpdatesSettingsTab({ draft, setDraft, saving, saveError, onSave }: Props) {
  const { user, applySettings } = useAuth();
  const { status, check, job, checking, busy, error, checkNow, startDownload, cancelDownload, installNow, openPanel } =
    useUpdates();
  const isOwner = user?.role.toUpperCase() === 'OWNER';

  async function skipVersion(version: string | undefined) {
    if (!version) return;
    try {
      const next = { ...draft, updateSkippedVersion: version };
      const result = await api.put<{ settings: UserSettings }>('/api/v1/settings', next);
      applySettings(result.settings);
      setDraft(result.settings);
      toast.info(`Version ${version} will not be offered again unless it becomes mandatory.`);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Update status"
            description="Every value comes from the update service. No version is reported as installed until the API returns it."
            icon={<ArrowDownToLine className="h-4 w-4" />}
            actions={
              <Button variant="outline" size="sm" onClick={() => void checkNow(true)} loading={checking}>
                <RefreshCw className="h-3.5 w-3.5" /> Check now
              </Button>
            }
          />
          <CardBody className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <KeyValue label="Installed version" stacked>
                {status?.currentVersion ?? check?.currentVersion ?? '—'}
              </KeyValue>
              <KeyValue label="Latest version" stacked>
                {check?.latestVersion ?? '—'}
              </KeyValue>
              <KeyValue label="Channel" stacked>
                {status?.channel ?? draft.updateChannel}
              </KeyValue>
              <KeyValue label="Platform" stacked>
                {status ? `${status.platform} / ${status.arch}` : '—'}
              </KeyValue>
              <KeyValue label="Update feed" stacked>
                {status?.feedConfigured ? status.feedUrl : 'Local update store only'}
              </KeyValue>
              <KeyValue label="Install mode" stacked>
                {status?.installMode ?? 'manual'}
              </KeyValue>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={status?.publicKeyConfigured ? 'positive' : 'negative'}>
                {status?.publicKeyConfigured ? 'Signature key configured' : 'No signature key'}
              </Badge>
              {check?.updateAvailable ? <Badge tone="accent">Update available</Badge> : null}
              {check?.mandatory ? <Badge tone="warning">Mandatory</Badge> : null}
              {status && status.activeRuns > 0 ? <Badge tone="warning">{status.activeRuns} active run(s)</Badge> : null}
            </div>

            {error ? (
              <Alert tone="danger" title="Update error">
                {error}
              </Alert>
            ) : null}
            {!status?.publicKeyConfigured ? (
              <Alert tone="warning" title="Updates are disabled for safety">
                Configure UPDATE_SIGNING_PUBLIC_KEY_PATH with the public key that matches your signing key. The
                application never installs an unverified package.
              </Alert>
            ) : null}
            {check && !check.updateAvailable ? (
              <p className="text-xs leading-relaxed text-muted">{check.message}</p>
            ) : null}

            {check?.release ? (
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-white">Version {check.release.version}</span>
                  <Badge tone="positive">Signature verified</Badge>
                  <Badge tone="default">
                    {check.release.platform}/{check.release.arch}
                  </Badge>
                </div>
                <div className="mt-2 grid gap-1 text-[11.5px] text-muted sm:grid-cols-2">
                  <span>Published {formatDate(check.release.publishedAt)}</span>
                  <span>Rollout {check.release.rolloutPercent}%</span>
                  <span>{check.release.fileName}</span>
                  <span>{Math.round(check.release.sizeBytes / 1024 / 1024)} MB</span>
                </div>
                {check.release.notes ? (
                  <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/20 p-3 font-sans text-[12px] leading-relaxed text-slate-300">
                    {check.release.notes}
                  </pre>
                ) : null}
                {job ? (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[11.5px] text-muted">
                      <span>{job.status}</span>
                      <span>{Math.round(job.progress * 100)}%</span>
                    </div>
                    <ProgressBar completed={Math.round(job.progress * 100)} total={100} className="mt-1.5" />
                    {job.error ? <p className="mt-1 text-[11.5px] text-negative">{job.error}</p> : null}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {check.updateAvailable && (!job || job.status === 'failed' || job.status === 'cancelled') ? (
                    <Button size="sm" onClick={() => void startDownload()} loading={busy && !job}>
                      Download update
                    </Button>
                  ) : null}
                  {job && ['queued', 'downloading', 'verifying'].includes(job.status) ? (
                    <Button size="sm" variant="outline" onClick={() => void cancelDownload()}>
                      Cancel download
                    </Button>
                  ) : null}
                  {job?.status === 'ready' ? (
                    <Button
                      size="sm"
                      onClick={() => void installNow()}
                      loading={busy}
                      disabled={(status?.activeRuns ?? 0) > 0}
                    >
                      Install verified update
                    </Button>
                  ) : null}
                  {check.updateAvailable && !check.mandatory ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void skipVersion(check.latestVersion ?? undefined)}
                    >
                      Skip this version
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={openPanel}>
                    Open update panel
                  </Button>
                </div>
              </div>
            ) : null}

            {status?.staged.length ? (
              <div className="space-y-1.5">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-lavender/65">
                  Verified staged packages
                </div>
                {status.staged.map((item) => (
                  <div key={item.releaseId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-slate-300">
                      {item.version} · {item.fileName}
                    </span>
                    <span className="text-muted">{formatDate(item.downloadedAt)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </CardBody>
        </Card>

        <form onSubmit={onSave}>
          <Card>
            <CardHeader
              title="Update preferences"
              description="Stored in the existing local settings document. No database migration is required."
              icon={<Save className="h-4 w-4" />}
              actions={
                <Button type="submit" size="sm" loading={saving}>
                  <Save className="h-3.5 w-3.5" /> Save preferences
                </Button>
              }
            />
            <CardBody className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Release channel" hint="Beta feeds require the server-side beta token.">
                  <Select
                    value={draft.updateChannel}
                    onChange={(event) =>
                      setDraft({ ...draft, updateChannel: event.target.value as UserSettings['updateChannel'] })
                    }
                  >
                    <option value="stable">Stable</option>
                    <option value="beta">Beta</option>
                  </Select>
                </Field>
                <Field label="Automatic check interval (minutes)" hint="Minimum 15 minutes; default 6 hours.">
                  <Input
                    type="number"
                    min={15}
                    max={10080}
                    value={draft.updateCheckIntervalMinutes}
                    onChange={(event) => setDraft({ ...draft, updateCheckIntervalMinutes: Number(event.target.value) })}
                  />
                </Field>
              </div>
              <Switch
                checked={draft.updateAutoCheck}
                onCheckedChange={(checked) => setDraft({ ...draft, updateAutoCheck: checked })}
                label="Check for updates automatically"
                description="A single delayed check runs after startup, then the configured interval. The application stays fully usable offline."
              />
              <Switch
                checked={draft.telemetry}
                onCheckedChange={(checked) => setDraft({ ...draft, telemetry: checked })}
                label="Consent to update telemetry"
                description="No update telemetry is collected in this build even when this preference is on. Version adoption is never inferred from personal data."
                disabled
              />
              {saveError ? (
                <Alert tone="danger" title="Could not save">
                  {saveError}
                </Alert>
              ) : null}
            </CardBody>
          </Card>
        </form>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader
            title="How updates are verified"
            description="Updates are treated as security-critical, not as a download convenience."
            icon={<ShieldCheck className="h-4 w-4" />}
          />
          <CardBody className="space-y-2 text-[12px] leading-relaxed text-slate-300">
            <p>
              1. Releases are fetched over HTTPS by the local API, then validated against the deployed Ed25519 public
              key.
            </p>
            <p>2. The package SHA-256 digest is checked against signed metadata before and after download.</p>
            <p>
              3. Installation is refused while verification runs are active, and never happens without your consent.
            </p>
            <p>4. Success is reported only after the API itself reports the new application version.</p>
            <p className="text-muted">
              Private signing keys never exist in the desktop client, release package, logs or this interface.
            </p>
          </CardBody>
        </Card>

        {isOwner ? <AdminReleasesPanel /> : null}
      </div>
    </div>
  );
}

function AdminReleasesPanel() {
  const { status, refreshStatus } = useUpdates();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [rollout, setRollout] = React.useState<Record<string, number>>({});
  const [publishing, setPublishing] = React.useState(false);
  const [form, setForm] = React.useState({
    artifactPath: '',
    version: '',
    platform: 'windows',
    arch: 'x86_64',
    format: 'nsis',
    channel: 'stable',
    notes: '',
    mandatory: false,
    rolloutPercent: 100,
    draft: false,
  });

  const { data, error, loading, reload } = useAsync<UpdateAdminBundle>(
    (signal) => api.get<UpdateAdminBundle>('/api/v1/updates/admin/releases', signal),
    [],
  );
  const events = useAsync<{ items: Array<Record<string, unknown>> }>(
    (signal) => api.get<{ items: Array<Record<string, unknown>> }>('/api/v1/updates/events?limit=500', signal),
    [],
  );

  async function changeState(id: string, action: 'pause' | 'resume') {
    setBusyId(id);
    try {
      await api.post(`/api/v1/updates/admin/releases/${encodeURIComponent(id)}/${action}`);
      toast.success(
        action === 'pause' ? 'Release paused. Clients stop receiving it on their next check.' : 'Release resumed.',
      );
      reload();
      void refreshStatus();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function applyRollout(id: string) {
    setBusyId(id);
    try {
      await api.post(`/api/v1/updates/admin/releases/${encodeURIComponent(id)}/state`, {
        rolloutPercent: rollout[id],
      });
      toast.success(`Rollout updated to ${rollout[id]}%.`);
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function publish(event: React.FormEvent) {
    event.preventDefault();
    setPublishing(true);
    try {
      await api.post('/api/v1/updates/admin/publish', {
        artifactPath: form.artifactPath,
        version: form.version,
        platform: form.platform,
        arch: form.arch,
        format: form.format,
        channel: form.channel,
        notes: form.notes,
        mandatory: form.mandatory,
        rolloutPercent: form.rolloutPercent,
        draft: form.draft,
        minimumSupportedVersion: null,
        minimumOsVersion: null,
      });
      toast.success(form.draft ? 'Draft release written to the update store.' : 'Release published and signed.');
      reload();
      void refreshStatus();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPublishing(false);
    }
  }

  const failedDownloads = (events.data?.items ?? []).filter((event) => event.event === 'download-failed').length;
  const checks = (events.data?.items ?? []).filter((event) => event.event === 'check').length;

  return (
    <>
      <Card>
        <CardHeader
          title="Release management"
          description="Owner-only. Publishing requires the private signing key on this machine; it is never returned by the API."
          icon={<UploadCloud className="h-4 w-4" />}
          actions={
            <Button variant="outline" size="sm" onClick={reload} loading={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          }
        />
        <CardBody className="space-y-3">
          <div className="grid gap-2 text-[11.5px] sm:grid-cols-2">
            <KeyValue label="Signing key" stacked>
              {data?.publicKeyConfigured ? (data.keyId ?? 'configured') : 'not configured'}
            </KeyValue>
            <KeyValue label="Install mode" stacked>
              {data?.installMode ?? status?.installMode ?? 'manual'}
            </KeyValue>
            <KeyValue label="Check events (recent)" stacked>
              {checks}
            </KeyValue>
            <KeyValue label="Failed downloads (recent)" stacked>
              {failedDownloads}
            </KeyValue>
          </div>
          <Alert tone="info" title="Adoption statistics">
            Consent-based adoption telemetry is not implemented in this build. No update telemetry leaves this machine.
          </Alert>

          {error ? (
            <Alert tone="danger" title="Could not load releases">
              {error}
            </Alert>
          ) : null}
          {data?.items.length === 0 ? (
            <p className="text-xs text-muted">No published releases exist in the local update store.</p>
          ) : null}
          <div className="space-y-2">
            {data?.items.map((release) => (
              <div key={release.id} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-white">{release.version}</span>
                  <Badge tone="default">{release.channel}</Badge>
                  <Badge tone="default">
                    {release.platform}/{release.arch}
                  </Badge>
                  <Badge tone={release.status === 'paused' ? 'warning' : 'positive'}>{release.status}</Badge>
                  {release.mandatory ? <Badge tone="warning">mandatory</Badge> : null}
                </div>
                <div className="mt-1.5 break-all font-mono text-[10px] text-slate-500">{release.id}</div>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void changeState(release.id, release.status === 'paused' ? 'resume' : 'pause')}
                    loading={busyId === release.id}
                  >
                    {release.status === 'paused' ? (
                      <CirclePlay className="h-3.5 w-3.5" />
                    ) : (
                      <CirclePause className="h-3.5 w-3.5" />
                    )}
                    {release.status === 'paused' ? 'Resume' : 'Pause'}
                  </Button>
                  <div className="flex items-end gap-1.5">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      className="w-20"
                      value={rollout[release.id] ?? release.rolloutPercent}
                      onChange={(event) =>
                        setRollout((current) => ({ ...current, [release.id]: Number(event.target.value) }))
                      }
                      aria-label={`Rollout percentage for ${release.version}`}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void applyRollout(release.id)}
                      loading={busyId === release.id}
                    >
                      Apply %
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Publish a release"
          description="The artifact must already exist on the machine running this API. Publishing copies it into the update store and signs the metadata."
          icon={<ShieldAlert className="h-4 w-4" />}
        />
        <CardBody>
          <form onSubmit={publish} className="space-y-3">
            <Field label="Artifact path" hint="Absolute path to a built .exe, .msi, .AppImage, .deb, .rpm or .zip.">
              <Input
                value={form.artifactPath}
                onChange={(event) => setForm({ ...form, artifactPath: event.target.value })}
                placeholder="D:\release\ZetHub-Proof-1.0.1-win.exe"
                spellCheck={false}
                required
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Version">
                <Input
                  value={form.version}
                  onChange={(event) => setForm({ ...form, version: event.target.value })}
                  placeholder="1.0.1"
                  required
                />
              </Field>
              <Field label="Release channel">
                <Select value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value })}>
                  <option value="stable">Stable</option>
                  <option value="beta">Beta</option>
                </Select>
              </Field>
              <Field label="Platform">
                <Select value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value })}>
                  <option value="windows">Windows</option>
                  <option value="linux">Linux</option>
                </Select>
              </Field>
              <Field label="Architecture">
                <Select value={form.arch} onChange={(event) => setForm({ ...form, arch: event.target.value })}>
                  <option value="x86_64">x86_64</option>
                  <option value="aarch64">aarch64</option>
                </Select>
              </Field>
              <Field label="Package format">
                <Select value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value })}>
                  <option value="nsis">NSIS installer</option>
                  <option value="msi">MSI installer</option>
                  <option value="appimage">AppImage</option>
                  <option value="deb">Debian package</option>
                  <option value="rpm">RPM package</option>
                  <option value="portable">Portable ZIP</option>
                </Select>
              </Field>
              <Field label="Rollout percentage">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.rolloutPercent}
                  onChange={(event) => setForm({ ...form, rolloutPercent: Number(event.target.value) })}
                />
              </Field>
            </div>
            <Field label="Release notes">
              <Textarea
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                placeholder="What changed in this release?"
              />
            </Field>
            <Switch
              checked={form.mandatory}
              onCheckedChange={(checked) => setForm({ ...form, mandatory: checked })}
              label="Mandatory update"
              description="Reserve this for security or compatibility fixes. Mandatory releases still require signature checks and user consent."
            />
            <Switch
              checked={form.draft}
              onCheckedChange={(checked) => setForm({ ...form, draft: checked })}
              label="Save as draft"
              description="Drafts are never served to clients."
            />
            <Button type="submit" loading={publishing} className="w-full">
              <UploadCloud className="h-4 w-4" /> {form.draft ? 'Save draft' : 'Sign and publish'}
            </Button>
          </form>
        </CardBody>
      </Card>
    </>
  );
}
