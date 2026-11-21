import crypto from 'node:crypto';
import type { TestPlan, VerificationRunDetail } from '@zethub/shared-types';
import { signManifest } from '../evidence/store.js';

export interface ReportBuildInput {
  run: VerificationRunDetail;
  projectName: string;
  projectId: string;
  plan: TestPlan | null;
  /** HMAC key for the report manifest. */
  signingSecret: string;
  generatedBy?: string;
}

export interface ReportBundle {
  verificationId: string;
  json: string;
  html: string;
  junit: string;
  manifest: {
    verificationId: string;
    generatedAt: string;
    generator: string;
    artifactHashes: Record<string, string>;
    signed: { algorithm: 'sha256'; digest: string };
    disclaimer: string;
  };
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function xml(value: unknown): string {
  // Control characters are deliberately stripped so JUnit XML stays well-formed.
  // eslint-disable-next-line no-control-regex
  return esc(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export function buildReport(input: ReportBuildInput): ReportBundle {
  const { run, projectName, plan } = input;
  const generatedAt = new Date().toISOString();
  const artifactHashes: Record<string, string> = {};
  for (const result of run.results) {
    for (const artifact of result.evidence) artifactHashes[`${result.key}/${artifact.name}`] = artifact.sha256;
  }
  const disclaimer =
    'Hashes and the HMAC signature detect modification of collected artifacts after generation. They do not independently prove that the test environment, the project under test or the evidence source was trustworthy.';

  const manifestBase = {
    verificationId: run.id,
    generatedAt,
    generator: input.generatedBy ?? 'ZetHub Proof',
    artifactHashes,
  };
  const signed = signManifest(manifestBase, input.signingSecret);
  const manifest = { ...manifestBase, signed, disclaimer };

  const junit = renderJUnit(run);
  const html = renderHtml({ run, projectName, plan, generatedAt, manifest, disclaimer });
  const json = JSON.stringify(
    {
      schemaVersion: 1,
      verificationId: run.id,
      project: { id: input.projectId, name: projectName },
      run,
      plan,
      generatedAt,
      manifest,
      generatedFiles: {
        junitSha256: crypto.createHash('sha256').update(junit).digest('hex'),
        htmlSha256: crypto.createHash('sha256').update(html).digest('hex'),
      },
    },
    null,
    2,
  );

  return { verificationId: run.id, json, html, junit, manifest };
}

export function renderJUnit(run: VerificationRunDetail): string {
  const tests = run.results.length;
  const failures = run.results.filter((r) => r.status === 'failed').length;
  const errors = run.results.filter((r) => ['error', 'timeout'].includes(r.status)).length;
  const skipped = run.results.filter((r) =>
    ['blocked', 'unverified', 'cancelled', 'skipped'].includes(r.status),
  ).length;
  const totalTime = run.results.reduce((acc, r) => acc + r.durationMs, 0) / 1000;
  const cases = run.results
    .map((result) => {
      const time = (result.durationMs / 1000).toFixed(3);
      let body = '';
      if (result.status === 'failed') {
        body = `<failure message="${xml(result.message ?? 'Test failed')}">${xml(result.stdout?.slice(-8000) ?? '')}</failure>`;
      } else if (result.status === 'error' || result.status === 'timeout') {
        body = `<error message="${xml(result.message ?? result.status)}">${xml(result.stderr?.slice(-8000) ?? '')}</error>`;
      } else if (['blocked', 'unverified', 'cancelled', 'skipped'].includes(result.status)) {
        body = `<skipped message="${xml(result.message ?? result.status)}"/>`;
      }
      const assertions = result.assertions
        .map((a) => `${a.status}: ${a.name}${a.message ? ` - ${a.message}` : ''}`)
        .join('\n');
      return `<testcase classname="${xml(result.kind)}" name="${xml(result.title)}" time="${time}">${body}<system-out>${xml(assertions)}</system-out></testcase>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="ZetHub Proof ${xml(run.id)}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${totalTime.toFixed(3)}" timestamp="${xml(run.startedAt)}">
${cases}
  </testsuite>
</testsuites>`;
}

function renderHtml(input: {
  run: VerificationRunDetail;
  projectName: string;
  plan: TestPlan | null;
  generatedAt: string;
  manifest: ReportBundle['manifest'];
  disclaimer: string;
}): string {
  const { run, projectName, plan, manifest, disclaimer } = input;
  const statusColor =
    run.status === 'passed'
      ? '#34d399'
      : run.status === 'failed'
        ? '#f87171'
        : run.status === 'blocked'
          ? '#fbbf24'
          : '#a78bfa';
  const rows = run.results
    .map((r) => {
      const color =
        r.status === 'passed'
          ? '#34d399'
          : r.status === 'failed'
            ? '#f87171'
            : r.status === 'blocked'
              ? '#fbbf24'
              : '#a78bfa';
      const assertions = r.assertions
        .map(
          (a) =>
            `<li class="a-${esc(a.status)}"><span>${esc(a.status)}</span> ${esc(a.name)}${a.message ? ` — ${esc(a.message)}` : ''}${a.actual ? ` <em>(actual: ${esc(a.actual)})</em>` : ''}</li>`,
        )
        .join('');
      const evidence = r.evidence
        .map((e) => `<span class="chip">${esc(e.name)} <small>${esc(e.sha256.slice(0, 12))}…</small></span>`)
        .join(' ');
      return `<article class="card">
      <header><h3>${esc(r.title)}</h3><span class="badge" style="border-color:${color};color:${color}">${esc(r.status)}</span></header>
      <p class="meta">${esc(r.kind)} · ${esc(r.adapterId)} · ${(r.durationMs / 1000).toFixed(2)}s${r.exitCode !== undefined && r.exitCode !== null ? ` · exit ${r.exitCode}` : ''}</p>
      ${r.commandDisplay ? `<pre class="cmd">${esc(r.commandDisplay)}</pre>` : ''}
      ${r.message ? `<p class="message">${esc(r.message)}</p>` : ''}
      ${assertions ? `<ul class="assertions">${assertions}</ul>` : ''}
      ${evidence ? `<div class="evidence"><strong>Evidence</strong><br/>${evidence}</div>` : ''}
    </article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Evidence Passport — ${esc(projectName)} — ${esc(run.id)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#080b16;color:#e6e9f5;font:14px/1.55 'Segoe UI',system-ui,-apple-system,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#7c5cff,#3b82f6);display:grid;place-items:center;font-weight:800}
.tag{color:#8b93b0;font-size:12px;letter-spacing:.14em;text-transform:uppercase}
h1{font-size:28px;margin:18px 0 4px}
h2{font-size:16px;text-transform:uppercase;letter-spacing:.08em;color:#99a2c4;margin:34px 0 14px}
.hero{border:1px solid #232a45;background:linear-gradient(140deg,#111629,#0c1020 60%);border-radius:18px;padding:26px;margin-top:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:18px}
.stat{background:#0d1223;border:1px solid #1d2440;border-radius:12px;padding:14px}
.stat b{display:block;font-size:24px;margin-bottom:2px}
.stat span{color:#8b93b0;font-size:12px}
.card{background:#0d1223;border:1px solid #1d2440;border-radius:14px;padding:18px;margin-bottom:12px}
.card header{display:flex;justify-content:space-between;align-items:center;gap:12px}
.card h3{font-size:15px;margin:0}
.badge{border:1px solid;border-radius:999px;padding:2px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.meta{color:#7d86a6;font-size:12px;margin:6px 0}
.cmd{background:#080c18;border:1px solid #1b223a;border-radius:8px;padding:10px;overflow:auto;font:12px/1.5 Consolas,monospace;color:#b9c2e0}
.assertions{list-style:none;padding:0;margin:12px 0 0}
.assertions li{padding:6px 0;border-bottom:1px dashed #1b223a;font-size:13px}
.assertions li span{font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin-right:8px;color:#8b93b0}
.a-failed span{color:#f87171}.a-passed span{color:#34d399}.a-blocked span{color:#fbbf24}
.message{color:#fca5a5;background:#1b1017;border:1px solid #3a1b26;padding:10px;border-radius:8px}
.evidence{margin-top:12px;font-size:12px;color:#9aa3c0}
.chip{display:inline-block;background:#11182d;border:1px solid #222b49;border-radius:6px;padding:2px 8px;margin:3px 4px 0 0}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:9px 10px;border-bottom:1px solid #1b223a;text-align:left;vertical-align:top}
th{color:#8b93b0;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.note{border-left:3px solid #7c5cff;background:#0e1224;padding:12px 14px;border-radius:0 8px 8px 0;color:#a9b1cf;font-size:13px}
footer{margin-top:44px;color:#6f7897;font-size:12px}
code{font-family:Consolas,monospace}
</style></head><body><div class="wrap">
<div class="brand"><div class="logo">Z</div><div><div style="font-weight:700">ZetHub Proof</div><div class="tag">Evidence Passport</div></div></div>
<h1>${esc(projectName)}</h1>
<p class="meta">Verification <code>${esc(run.id)}</code> · ${esc(run.trigger)} · ${esc(run.strategy)} strategy</p>
<div class="hero">
  <div class="tag">Overall result</div>
  <div style="font-size:30px;font-weight:700;color:${statusColor};margin-top:4px">${esc(run.status.toUpperCase())}</div>
  <div class="grid">
    <div class="stat"><b>${run.counts.total}</b><span>Total checks</span></div>
    <div class="stat"><b style="color:#34d399">${run.counts.passed}</b><span>Passed</span></div>
    <div class="stat"><b style="color:#f87171">${run.counts.failed}</b><span>Failed</span></div>
    <div class="stat"><b style="color:#fbbf24">${run.counts.blocked}</b><span>Blocked</span></div>
    <div class="stat"><b style="color:#a78bfa">${run.counts.unverified}</b><span>Unverified</span></div>
    <div class="stat"><b>${(run.counts.durationMs / 1000).toFixed(1)}s</b><span>Duration</span></div>
  </div>
</div>
<h2>Source &amp; environment</h2>
<table>
<tr><th>Project</th><td>${esc(projectName)}</td></tr>
<tr><th>Git commit</th><td><code>${esc(run.gitCommit ?? 'not available')}</code> ${run.gitBranch ? `on <code>${esc(run.gitBranch)}</code>` : ''}</td></tr>
<tr><th>Operating system</th><td>${esc(run.environment.os)} (${esc(run.environment.arch)})</td></tr>
<tr><th>Node / host</th><td>${esc(run.environment.node)} · ${esc(run.environment.hostname)}</td></tr>
<tr><th>Started</th><td>${esc(run.startedAt)}${run.finishedAt ? ` → ${esc(run.finishedAt)}` : ''}</td></tr>
<tr><th>Tool versions</th><td>${esc(
    Object.entries(run.environment.toolVersions ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ') || 'not recorded',
  )}</td></tr>
</table>
<h2>Verification scope</h2>
<p class="note">${esc(run.verifiedScope ?? 'This report covers only the checks listed below. It does not assert that the whole application is verified.')}</p>
${run.remainingLimitations.length ? `<ul>${run.remainingLimitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
<h2>Checks (${run.results.length})</h2>
${rows || '<p class="note">No checks were executed in this run.</p>'}
${plan ? `<h2>Plan notes</h2><ul>${plan.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<h2>Evidence integrity</h2>
<table>
<tr><th>Verification ID</th><td><code>${esc(run.id)}</code></td></tr>
<tr><th>Generated</th><td>${esc(input.generatedAt)}</td></tr>
<tr><th>Artifacts hashed</th><td>${Object.keys(manifest.artifactHashes).length}</td></tr>
<tr><th>Manifest digest</th><td><code>${esc(manifest.signed.digest)}</code></td></tr>
</table>
<p class="note">${esc(disclaimer)}</p>
<footer>Generated by ZetHub Proof. “AI writes the code. ZetHub Proof proves it works.”</footer>
</div></body></html>`;
}
