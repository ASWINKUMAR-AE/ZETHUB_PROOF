import * as React from 'react';
import { Link } from 'react-router-dom';
import { Download, FileArchive, FileCheck2, FileJson, Import, ShieldCheck, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiUrl, downloadFile } from '../lib/api';
import { errorMessage, useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDate, timeAgo } from '../lib/utils';
import type { RunSummary } from '../types';
import { CodeBlock, ErrorState, LoadingCard, PageHeader } from '../components/common';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Modal,
  StatusBadge,
  Textarea,
} from '../components/ui';

interface ImportedCapsule {
  capsule: {
    id: string;
    createdAt: string;
    project: { name: string; sourceType: string; gitCommit: string | null; gitBranch: string | null };
    test: { key: string; title: string; kind: string };
    environment: { os: string; arch: string; hostname: string; node: string };
    failure: {
      status: string;
      classification: string;
      message?: string;
      expected?: string;
      actual?: string;
      logExcerpt?: string;
    };
    diff?: string;
    changedFiles: string[];
    reproduction: { steps: string[]; command?: string };
    evidenceHashes: Record<string, string>;
    redactionsApplied: number;
  };
  warnings: string[];
  note: string;
}

export function EvidencePage() {
  useDocumentTitle('Evidence passports');
  const [importOpen, setImportOpen] = React.useState(false);
  const [raw, setRaw] = React.useState('');
  const [importing, setImporting] = React.useState(false);
  const [importError, setImportError] = React.useState<string | null>(null);
  const [imported, setImported] = React.useState<ImportedCapsule | null>(null);
  const [generating, setGenerating] = React.useState<string | null>(null);

  const { data, error, loading, reload } = useAsync<{ items: RunSummary[]; total: number }>(
    (signal) => api.get<{ items: RunSummary[]; total: number }>('/api/v1/runs?pageSize=100', signal),
    [],
  );
  const runs = data?.items ?? [];

  async function importCapsule(event: React.FormEvent) {
    event.preventDefault();
    setImporting(true);
    setImportError(null);
    setImported(null);
    try {
      const result = await api.post<ImportedCapsule>('/api/v1/capsules/import', { raw });
      setImported(result);
      toast.success('Capsule validated. Nothing was executed or modified.');
    } catch (caught) {
      setImportError(errorMessage(caught));
    } finally {
      setImporting(false);
    }
  }

  async function readFile(file: File) {
    try {
      setRaw(await file.text());
      toast.success(`Loaded ${file.name}.`);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function generate(run: RunSummary) {
    setGenerating(run.id);
    try {
      await api.post(`/api/v1/runs/${run.id}/reports`);
      toast.success('Evidence passport generated.');
      reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setGenerating(null);
    }
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="Evidence passports"
        description="Portable, hash-verified proof generated from stored runs. Passports exist in HTML, JSON and JUnit; capsules capture individual failures."
        icon={<ShieldCheck className="h-5 w-5" />}
        actions={
          <Button
            onClick={() => {
              setImportOpen(true);
              setImported(null);
              setImportError(null);
            }}
          >
            <Import className="h-4 w-4" /> Import capsule
          </Button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card className="p-3.5">
          <div className="label">Runs available</div>
          <div className="mt-1 text-xl font-semibold text-white">{data?.total ?? '—'}</div>
          <div className="text-[10.5px] text-slate-500">Most recent 100 shown</div>
        </Card>
        <Card className="p-3.5">
          <div className="label">Passports generated</div>
          <div className="mt-1 text-xl font-semibold text-positive">{runs.filter((run) => run.reportId).length}</div>
          <div className="text-[10.5px] text-slate-500">Across the listed runs</div>
        </Card>
        <Card className="p-3.5">
          <div className="label">Integrity</div>
          <div className="mt-1 text-[12px] font-medium text-slate-200">SHA-256 + signed manifest</div>
          <div className="text-[10.5px] text-slate-500">Every artifact is hashed and linked</div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Report library"
          description="Generate a passport for any finished run, then open or download its formats."
          icon={<FileCheck2 className="h-4 w-4" />}
          actions={
            <Button variant="outline" size="sm" onClick={reload}>
              Refresh
            </Button>
          }
        />
        <CardBody className="p-0">
          {loading ? (
            <LoadingCard label="Loading runs…" />
          ) : error ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={reload} />
            </div>
          ) : runs.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<FileCheck2 className="h-5 w-5" />}
                title="No runs to report"
                description="Execute a verification run first. Evidence can only be generated from stored results."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Run</th>
                    <th>Project</th>
                    <th>Passport</th>
                    <th>Started</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <StatusBadge status={run.status} />
                      </td>
                      <td>
                        <Link
                          to={`/runs/${run.id}`}
                          className="font-mono text-[10.5px] text-slate-300 hover:text-accent-soft"
                        >
                          {run.id.slice(0, 12)}
                        </Link>
                        <div className="text-[9.5px] text-slate-600">
                          {run.counts.passed}/{run.counts.total} passed
                        </div>
                      </td>
                      <td>
                        <Link
                          to={`/projects/${run.projectId}`}
                          className="text-[11.5px] text-slate-300 hover:text-accent-soft"
                        >
                          {run.projectName}
                        </Link>
                      </td>
                      <td>{run.reportId ? <Badge tone="positive">generated</Badge> : <Badge>not generated</Badge>}</td>
                      <td className="text-[10.5px] text-muted" title={formatDate(run.startedAt)}>
                        {timeAgo(run.startedAt)}
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {run.reportId ? (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  window.open(apiUrl(`/api/v1/runs/${run.id}/report?format=html`), '_blank', 'noopener')
                                }
                              >
                                <FileCheck2 className="h-3.5 w-3.5" /> Open
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Download JSON passport"
                                onClick={() =>
                                  void downloadFile(
                                    `/api/v1/runs/${run.id}/report?format=json`,
                                    `evidence-passport-${run.id}.json`,
                                  ).catch((caught) => toast.error(errorMessage(caught)))
                                }
                              >
                                <FileJson className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Download JUnit XML"
                                onClick={() =>
                                  void downloadFile(
                                    `/api/v1/runs/${run.id}/report?format=junit`,
                                    `evidence-passport-${run.id}.xml`,
                                  ).catch((caught) => toast.error(errorMessage(caught)))
                                }
                              >
                                <Download className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void generate(run)}
                              loading={generating === run.id}
                              disabled={['running', 'queued'].includes(run.status)}
                            >
                              <FileCheck2 className="h-3.5 w-3.5" /> Generate
                            </Button>
                          )}
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="What a passport contains"
            description="Built by the verification engine, not by the UI."
            icon={<ShieldCheck className="h-4 w-4" />}
          />
          <CardBody>
            <ul className="list-disc space-y-1.5 pl-5 text-[11.5px] leading-relaxed text-slate-400">
              <li>Run identity, project, commit, branch, strategy and execution environment.</li>
              <li>Per-check status, duration, assertions, classified failure reason and evidence hashes.</li>
              <li>Plan snapshot, coverage confidence, limitations and verified scope.</li>
              <li>An HMAC-signed manifest and SHA-256 for every artifact, enabling offline integrity checks.</li>
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="What it does not prove"
            description="Boundaries are part of the evidence."
            icon={<FileArchive className="h-4 w-4" />}
          />
          <CardBody>
            <ul className="list-disc space-y-1.5 pl-5 text-[11.5px] leading-relaxed text-slate-400">
              <li>A passport covers only the checks that actually executed in that run.</li>
              <li>It does not attest other machines, production traffic or untested code paths.</li>
              <li>AI-generated scenarios are not trusted evidence until they execute and produce results.</li>
              <li>Reports from different commits are independent evidence, not a regression proof.</li>
            </ul>
          </CardBody>
        </Card>
      </div>

      <Modal
        open={importOpen}
        onOpenChange={setImportOpen}
        title="Import failure capsule"
        description="Validate a capsule shared from another machine. Import displays and validates only; it never executes commands or edits source."
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              Close
            </Button>
            <Button type="submit" form="capsule-import-form" loading={importing} disabled={!raw.trim()}>
              Validate capsule
            </Button>
          </>
        }
      >
        <form id="capsule-import-form" className="space-y-4" onSubmit={importCapsule}>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-ink-900 px-3 py-2 text-xs text-slate-300 hover:border-line-strong">
              <Upload className="h-3.5 w-3.5" /> Load JSON file
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                }}
              />
            </label>
            <span className="text-[10.5px] text-slate-500">or paste capsule JSON below (max 5 MB).</span>
          </div>
          <Field label="Capsule JSON">
            <Textarea
              className="min-h-[220px]"
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              placeholder='{"formatVersion":1,...}'
              spellCheck={false}
            />
          </Field>
          {importError ? (
            <Alert tone="danger" title="Invalid capsule">
              {importError}
            </Alert>
          ) : null}
          {imported ? (
            <div className="space-y-3">
              <Alert tone="success" title="Capsule validated">
                {imported.note}
              </Alert>
              <div className="rounded-xl border border-line bg-ink-900/40 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">v1</Badge>
                  <StatusBadge status={imported.capsule.failure.status} />
                  <Badge>{imported.capsule.failure.classification}</Badge>
                  <span className="ml-auto text-[10px] text-slate-500">{formatDate(imported.capsule.createdAt)}</span>
                </div>
                <div className="mt-2 text-[12px] font-semibold text-slate-200">
                  {imported.capsule.project.name} · {imported.capsule.test.key}
                </div>
                <div className="text-[11px] text-slate-500">{imported.capsule.test.title}</div>
                <div className="mt-1 font-mono text-[9.5px] text-slate-600">
                  {imported.capsule.environment.os} / {imported.capsule.environment.arch} / node{' '}
                  {imported.capsule.environment.node}
                </div>
                {imported.capsule.failure.message ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{imported.capsule.failure.message}</p>
                ) : null}
                {imported.capsule.reproduction.command ? (
                  <CodeBlock className="mt-2 max-h-[120px]">{imported.capsule.reproduction.command}</CodeBlock>
                ) : null}
                <div className="mt-2 text-[10.5px] text-slate-500">
                  {imported.capsule.reproduction.steps.length} reproduction step(s) ·{' '}
                  {imported.capsule.changedFiles.length} changed file(s) · {imported.capsule.redactionsApplied}{' '}
                  redaction(s)
                </div>
              </div>
              {imported.warnings.length > 0 ? (
                <Alert tone="warning" title="Warnings">
                  <ul className="list-disc pl-4">
                    {imported.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              {imported.capsule.diff ? (
                <div>
                  <div className="label mb-1">Diff snapshot</div>
                  <CodeBlock className="max-h-[220px]">{imported.capsule.diff}</CodeBlock>
                </div>
              ) : null}
            </div>
          ) : null}
        </form>
      </Modal>
    </div>
  );
}
