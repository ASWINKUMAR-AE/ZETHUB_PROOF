import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prisma } from '../db.js';
import { authenticate, requireOwner } from '../auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { jsonArray, toJson } from '../lib/json.js';
import { activeRuns, getRunDetail, startRun } from '../services/runs.js';
import { preparePlan } from '../services/plan.js';
import { relatedFiles } from '../services/reports.js';

const DIFF_PATH = /^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+)$/gm;

function validateDiff(diff: string): { files: string[]; error?: string } {
  if (!diff.trim()) return { files: [], error: 'A patch is required before a repair can be applied.' };
  if (diff.length > 500_000) return { files: [], error: 'Patch is too large (limit 500 KB).' };
  if (/GIT binary patch/i.test(diff)) return { files: [], error: 'Binary patches are not supported.' };
  const files = new Set<string>();
  for (const match of diff.matchAll(DIFF_PATH)) {
    const raw = match[1]?.trim();
    if (!raw || raw === '/dev/null') continue;
    if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw))
      return { files: [], error: 'Absolute paths are not allowed in a patch.' };
    const normalized = raw.replace(/\\/g, '/');
    if (normalized.split('/').includes('..'))
      return { files: [], error: 'Parent-directory traversal is not allowed in a patch.' };
    files.add(normalized);
  }
  if (files.size === 0) return { files: [], error: 'The patch does not contain a recognizable unified diff header.' };
  return { files: [...files] };
}

function causesFor(classification: string, message: string | null): string[] {
  const base: Record<string, string[]> = {
    'assertion-failure': [
      'The implementation does not satisfy the expected behavior.',
      'The assertion or fixture may encode an outdated expectation.',
    ],
    'test-failure': ['A test asserted an unexpected value.', 'Shared state or ordering may be affecting the result.'],
    'type-error': [
      'A type contract changed without updating all call sites.',
      'Generated types are stale; regenerate the client.',
    ],
    'lint-error': ['Style or correctness rules are violated.', 'A rule changed and the code was not updated.'],
    'build-failure': [
      'The project does not compile or bundle.',
      'A dependency or environment prerequisite is missing.',
    ],
    timeout: [
      'The operation exceeded its time budget.',
      'A network or external service dependency is slow or unavailable.',
    ],
    'missing-prerequisite': ['A required executable, package or configuration file is absent.'],
    'network-failure': ['A service is unreachable or refused the connection.'],
    'permission-denied': ['The process lacks permission to access a file or port.'],
    'assertion-mismatch': ['Observed behavior differs from the recorded expectation.'],
  };
  const causes = base[classification] ?? [
    'Inspect the captured stdout/stderr and the failing assertion before changing code.',
  ];
  if (message && /ECONNREFUSED|ENOTFOUND/i.test(message))
    causes.push('Check that the target service is running and listening on the configured host/port.');
  return causes;
}

export async function repairRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/projects/:id/repairs', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await prisma.project.findFirst({ where: { id, ownerId: request.auth!.user.id } });
    if (!project) throw notFound('Project');
    const items = await prisma.repairProposal.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { items: items.map(serializeRepair) };
  });

  app.get('/api/v1/runs/:id/repairs', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await prisma.testRun.findFirst({ where: { id, project: { ownerId: request.auth!.user.id } } });
    if (!run) throw notFound('Verification run');
    const items = await prisma.repairProposal.findMany({ where: { runId: id }, orderBy: { createdAt: 'desc' } });
    return { items: items.map(serializeRepair) };
  });

  app.post('/api/v1/runs/:id/repairs', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        testKey: z.string().min(1).max(190),
        diff: z.string().max(500_000).optional(),
        notes: z.string().max(4000).optional(),
      })
      .parse(request.body);
    if (activeRuns.has(id)) throw conflict('Wait for the run to finish before proposing a repair.');
    const run = await getRunDetail(id, auth.user.id);
    const result = run.results.find((r) => r.key === body.testKey);
    if (!result) throw notFound('Test result');
    if (result.status === 'passed')
      throw conflict('This check passed. A repair proposal is only meaningful for a failure.');
    const project = await prisma.project.findFirst({ where: { id: run.projectId, ownerId: auth.user.id } });
    if (!project) throw notFound('Project');

    const diff = body.diff ?? '';
    let files: string[] = [];
    if (diff.trim()) {
      const validation = validateDiff(diff);
      if (validation.error) throw badRequest(validation.error);
      files = validation.files;
      if (project.rootPath) {
        const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
          cwd: project.rootPath,
          input: diff,
          timeout: 15_000,
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
        });
        if (check.error) throw badRequest(`Could not validate the patch: ${check.error.message}`);
        if (check.status !== 0)
          throw badRequest(`The patch does not apply cleanly: ${(check.stderr ?? '').slice(0, 2000)}`);
      }
    } else {
      files = relatedFiles(result, run.planSnapshot);
    }

    const proposal = await prisma.repairProposal.create({
      data: {
        projectId: project.id,
        runId: id,
        userId: auth.user.id,
        testKey: body.testKey,
        classification: result.classification ?? 'unclassified',
        causesJson: toJson(causesFor(result.classification ?? 'unclassified', result.message ?? null)),
        diff,
        filesJson: toJson(files),
        notes: body.notes ?? null,
        status: 'PROPOSED',
      },
    });
    await audit({
      userId: auth.user.id,
      action: 'REPAIR_PROPOSE',
      entityType: 'repair-proposal',
      entityId: proposal.id,
      metadata: { runId: id, testKey: body.testKey, hasPatch: Boolean(diff.trim()) },
      ip: request.ip,
    });
    reply.code(201);
    return { repair: serializeRepair(proposal) };
  });

  app.get('/api/v1/repairs/:id', { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const repair = await prisma.repairProposal.findFirst({
      where: { id, project: { ownerId: request.auth!.user.id } },
    });
    if (!repair) throw notFound('Repair proposal');
    return { repair: serializeRepair(repair) };
  });

  app.post('/api/v1/repairs/:id/approve', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const repair = await prisma.repairProposal.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!repair) throw notFound('Repair proposal');
    if (repair.status !== 'PROPOSED' && repair.status !== 'REJECTED')
      throw conflict(`Cannot approve a proposal in ${repair.status.toLowerCase()} state.`);
    const updated = await prisma.repairProposal.update({ where: { id }, data: { status: 'APPROVED' } });
    await audit({
      userId: auth.user.id,
      action: 'REPAIR_APPLY',
      entityType: 'repair-proposal',
      entityId: id,
      metadata: { step: 'approve' },
      ip: request.ip,
    });
    return { repair: serializeRepair(updated) };
  });

  app.post('/api/v1/repairs/:id/reject', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const repair = await prisma.repairProposal.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!repair) throw notFound('Repair proposal');
    if (['APPLIED', 'VERIFIED'].includes(repair.status))
      throw conflict('An applied repair cannot be rejected. Revert the patch in Git instead.');
    const updated = await prisma.repairProposal.update({ where: { id }, data: { status: 'REJECTED' } });
    return { repair: serializeRepair(updated) };
  });

  app.post('/api/v1/repairs/:id/apply', { preHandler: authenticate }, async (request) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ confirm: z.literal(true) }).parse(request.body ?? {});
    void body;
    const repair = await prisma.repairProposal.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!repair) throw notFound('Repair proposal');
    if (repair.status !== 'APPROVED') throw conflict('Approve the proposal before applying it.');
    if (!repair.diff.trim())
      throw badRequest('This proposal has no patch. Add a diff generated by you or an approved AI provider first.');
    const project = await prisma.project.findFirst({ where: { id: repair.projectId, ownerId: auth.user.id } });
    if (!project?.rootPath) throw badRequest('The project has no local folder.');
    if (!fs.existsSync(path.join(project.rootPath, '.git')))
      throw badRequest('Patching requires a Git repository so changes can be reviewed and reverted.');

    const validation = validateDiff(repair.diff);
    if (validation.error) throw badRequest(validation.error);
    const apply = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: project.rootPath,
      input: repair.diff,
      timeout: 20_000,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    if (apply.status !== 0) {
      throw badRequest(`git apply failed (exit ${apply.status}): ${(apply.stderr ?? '').slice(0, 2000)}`);
    }
    const updated = await prisma.repairProposal.update({
      where: { id },
      data: { status: 'APPLIED', appliedAt: new Date() },
    });
    await audit({
      userId: auth.user.id,
      action: 'REPAIR_APPLY',
      entityType: 'repair-proposal',
      entityId: id,
      metadata: { files: jsonArray(repair.filesJson) },
      ip: request.ip,
    });
    return {
      repair: serializeRepair(updated),
      note: 'Patch applied to the working tree. Review it with git diff before committing.',
    };
  });

  app.post('/api/v1/repairs/:id/retest', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireOwner(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const repair = await prisma.repairProposal.findFirst({ where: { id, project: { ownerId: auth.user.id } } });
    if (!repair) throw notFound('Repair proposal');
    if (!['APPLIED', 'FAILED', 'VERIFIED'].includes(repair.status))
      throw conflict('Apply the repair before retesting it.');
    const project = await prisma.project.findFirst({ where: { id: repair.projectId, ownerId: auth.user.id } });
    if (!project) throw notFound('Project');
    if (activeRuns.size > 0) throw conflict('Another verification run is active. Wait for it to finish.');
    const prepared = await preparePlan({ project, strategy: 'selected', caseKeys: [repair.testKey] });
    if (prepared.plan.cases.length === 0)
      throw badRequest('The repaired check is no longer present in the plan. Re-scan the project.');
    const started = await startRun({
      project,
      userId: auth.user.id,
      trigger: 'REPAIR_RETEST',
      plan: prepared.plan,
      approvals: 'all',
      ip: request.ip,
      retestOf: repair.runId,
      repairProposalId: repair.id,
    });
    reply.code(202);
    return {
      runId: started.runId,
      planId: started.planId,
      repairId: repair.id,
      note: 'Retest started. The proposal is marked verified only if this run passes.',
    };
  });
}

function serializeRepair(repair: {
  id: string;
  projectId: string;
  runId: string;
  testKey: string;
  classification: string;
  causesJson: unknown;
  diff: string;
  filesJson: unknown;
  status: string;
  retestRunId: string | null;
  notes: string | null;
  createdAt: Date;
  appliedAt: Date | null;
  verifiedAt: Date | null;
}) {
  return {
    id: repair.id,
    projectId: repair.projectId,
    runId: repair.runId,
    testKey: repair.testKey,
    classification: repair.classification,
    possibleCauses: jsonArray(repair.causesJson),
    diff: repair.diff,
    files: jsonArray(repair.filesJson),
    status: repair.status.toLowerCase(),
    retestRunId: repair.retestRunId,
    notes: repair.notes,
    createdAt: repair.createdAt.toISOString(),
    appliedAt: repair.appliedAt?.toISOString() ?? null,
    verifiedAt: repair.verifiedAt?.toISOString() ?? null,
  };
}
