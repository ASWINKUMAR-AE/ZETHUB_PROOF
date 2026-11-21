import * as React from 'react';
import { FileSearch, FlaskConical, ShieldAlert, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiUrl } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { formatBytes } from '../../lib/utils';
import type { QualityAudit } from '../../types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from '../../components/ui';
import type { ProjectTabProps } from '../ProjectDetailPage';

const SEVERITY_TONE: Record<string, 'negative' | 'warning' | 'accent' | 'default'> = {
  high: 'negative',
  medium: 'warning',
  low: 'accent',
  info: 'default',
};

export function QualityTab({ project }: ProjectTabProps) {
  const [result, setResult] = React.useState<QualityAudit | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function audit() {
    setLoading(true);
    setError(null);
    try {
      const auditResult = await api.post<QualityAudit>(`/api/v1/projects/${project.project.id}/quality/audit`, {});
      setResult(auditResult);
      toast.success(`Quality audit finished: ${auditResult.findings.length} finding(s).`);
    } catch (caught) {
      setError(errorMessage(caught));
      toast.error(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  const findings = result?.findings ?? [];
  const bySeverity = findings.reduce<Record<string, number>>(
    (acc, finding) => ({ ...acc, [finding.severity]: (acc[finding.severity] ?? 0) + 1 }),
    {},
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Test quality auditor"
          description="Static heuristics over test files, combined with recorded flaky history. Findings are labelled confirmed or heuristic."
          icon={<Sparkles className="h-4 w-4" />}
          actions={
            <Button size="sm" onClick={() => void audit()} loading={loading} disabled={!project.project.rootPath}>
              <FileSearch className="h-3.5 w-3.5" /> Run audit
            </Button>
          }
        />
        <CardBody>
          {!project.project.rootPath ? (
            <Alert tone="warning" title="No local source">
              Attach a local folder to audit test quality.
            </Alert>
          ) : !result ? (
            <EmptyState
              icon={<FlaskConical className="h-5 w-5" />}
              title="No audit has been run"
              description="The auditor reads test files under the project root, looks for weak assertions, empty tests, broad catches, fragile selectors and flaky history, then writes a hash-verified JSON artifact."
              action={
                <Button onClick={() => void audit()} loading={loading} disabled={!project.project.rootPath}>
                  Run quality audit
                </Button>
              }
            />
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-line-soft bg-ink-900/60 p-3">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-muted">Files analyzed</div>
                  <div className="mt-1 text-xl font-semibold text-white">{result.filesAnalyzed}</div>
                </div>
                <div className="rounded-xl border border-line-soft bg-ink-900/60 p-3">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-muted">Tests analyzed</div>
                  <div className="mt-1 text-xl font-semibold text-white">{result.testsAnalyzed}</div>
                </div>
                <div className="rounded-xl border border-line-soft bg-ink-900/60 p-3">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-muted">Findings</div>
                  <div className={`mt-1 text-xl font-semibold ${findings.length ? 'text-warning' : 'text-positive'}`}>
                    {findings.length}
                  </div>
                </div>
                <div className="rounded-xl border border-line-soft bg-ink-900/60 p-3">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-muted">Artifact</div>
                  <div className="mt-1 truncate font-mono text-[10px] text-slate-400" title={result.artifact.sha256}>
                    {result.artifact.sha256.slice(0, 16)}… · {formatBytes(result.artifact.sizeBytes)}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {Object.entries(bySeverity).map(([severity, count]) => (
                  <Badge key={severity} tone={SEVERITY_TONE[severity] ?? 'default'}>
                    {severity} · {count}
                  </Badge>
                ))}
                <a
                  className="link ml-auto text-[11px]"
                  href={apiUrl(`/api/v1/artifacts/${result.artifact.relativePath}`)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open raw audit artifact
                </a>
              </div>

              {findings.length === 0 ? (
                <Alert tone="success" title="No heuristic findings">
                  No weak assertions, empty tests or fragile patterns were detected by the static rules. This is not
                  proof of test quality; runtime evidence still matters.
                </Alert>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-line">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>Severity</th>
                        <th>Category</th>
                        <th>Location</th>
                        <th>Finding</th>
                        <th>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {findings.map((finding) => (
                        <tr key={finding.id}>
                          <td>
                            <Badge tone={SEVERITY_TONE[finding.severity] ?? 'default'}>{finding.severity}</Badge>
                          </td>
                          <td>
                            <span className="chip">{finding.category}</span>
                          </td>
                          <td>
                            <div className="font-mono text-[10.5px] text-slate-300">
                              {finding.file}
                              {finding.line ? `:${finding.line}` : ''}
                            </div>
                            {finding.testName ? (
                              <div className="text-[10px] text-slate-500">{finding.testName}</div>
                            ) : null}
                          </td>
                          <td className="max-w-[460px]">
                            <div className="text-[11.5px] text-slate-300">{finding.message}</div>
                            <div className="mt-1 text-[10.5px] text-slate-500">{finding.suggestion}</div>
                          </td>
                          <td>
                            <Badge tone={finding.confidence === 'confirmed' ? 'positive' : 'warning'}>
                              {finding.confidence}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {result.mutationTesting ? (
                <Alert
                  tone="warning"
                  title="Mutation testing is not available"
                  icon={<ShieldAlert className="h-4 w-4" />}
                >
                  {result.mutationTesting.reason}
                </Alert>
              ) : null}
            </div>
          )}
          {error ? (
            <div className="mt-3">
              <Alert tone="danger" title="Audit failed">
                {error}
              </Alert>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="What this audit can and cannot prove"
          description="Coverage boundaries are stated explicitly so findings are not over-interpreted."
          icon={<ShieldAlert className="h-4 w-4" />}
        />
        <CardBody>
          <ul className="list-disc space-y-1.5 pl-5 text-[11.5px] leading-relaxed text-slate-400">
            <li>
              Static rules identify common weak-test patterns in supported source files; they do not execute tests.
            </li>
            <li>Flaky findings require at least four recorded results with alternating outcomes.</li>
            <li>Mutation score is intentionally absent: this build does not ship a generic mutation engine.</li>
            <li>
              Use a verification run to determine whether behaviour actually holds. Auditor output is guidance, not
              evidence of correctness.
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
