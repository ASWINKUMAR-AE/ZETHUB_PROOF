import type {
  BrowserScenario,
  DbScenario,
  ApiScenario,
  TestCasePlan,
  TestPlan,
  DetectionResult,
} from '@zethub/shared-types';
import { BrowserScenarioSchema, DbScenarioSchema, ApiScenarioSchema } from '@zethub/shared-types';
import { buildVerificationPlan, selectTests } from '@zethub/verification-core';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Project, TestCase } from '@prisma/client';
import { prisma } from '../db.js';
import { config as appConfig } from '../config.js';
import { badRequest } from '../lib/http.js';
import { getSettings } from '../lib/audit.js';
import { toJson } from '../lib/json.js';

export function parseDetection(project: Project) {
  if (!project.detectionJson) return null;
  try {
    return project.detectionJson as unknown as DetectionResult;
  } catch {
    return null;
  }
}

export function savedCaseToPlan(testCase: TestCase): TestCasePlan | null {
  const caseConfig = testCase.configJson as Record<string, unknown> | null;
  if (!caseConfig) return null;
  try {
    if (testCase.kind === 'browser') {
      const scenario = BrowserScenarioSchema.parse(caseConfig.scenario ?? caseConfig);
      return {
        key: testCase.key,
        title: testCase.title,
        kind: testCase.kind as TestCasePlan['kind'],
        adapterId: testCase.adapterId,
        source: testCase.source === 'AI' ? 'ai' : testCase.source === 'USER' ? 'user' : 'detected',
        reason: testCase.reason ?? 'User-configured browser workflow.',
        browser: scenario,
        timeoutMs: scenario.timeoutMs,
        requiresApproval: false,
        mappedFiles: (testCase.mappedFiles as string[]) ?? [],
        tags: (testCase.tags as string[]) ?? [],
        priority: testCase.priority,
      };
    }
    if (testCase.kind === 'api') {
      const scenario = ApiScenarioSchema.parse(caseConfig.scenario ?? caseConfig);
      return {
        key: testCase.key,
        title: testCase.title,
        kind: testCase.kind as TestCasePlan['kind'],
        adapterId: testCase.adapterId,
        source: testCase.source === 'AI' ? 'ai' : testCase.source === 'USER' ? 'user' : 'detected',
        reason: testCase.reason ?? 'User-configured API contract.',
        api: scenario,
        timeoutMs: scenario.request.timeoutMs + 5_000,
        requiresApproval: scenario.request.allowMutation,
        mappedFiles: [],
        tags: (testCase.tags as string[]) ?? [],
        priority: testCase.priority,
      };
    }
    if (testCase.kind === 'database') {
      const scenario = DbScenarioSchema.parse(caseConfig.scenario ?? caseConfig);
      return {
        key: testCase.key,
        title: testCase.title,
        kind: testCase.kind as TestCasePlan['kind'],
        adapterId: testCase.adapterId,
        source: testCase.source === 'AI' ? 'ai' : testCase.source === 'USER' ? 'user' : 'detected',
        reason: testCase.reason ?? 'User-configured database verification.',
        database: scenario,
        timeoutMs: 120_000,
        requiresApproval: scenario.allowWrites,
        mappedFiles: [],
        tags: (testCase.tags as string[]) ?? [],
        priority: testCase.priority,
      };
    }
    if (caseConfig.command) {
      return {
        key: testCase.key,
        title: testCase.title,
        kind: testCase.kind as TestCasePlan['kind'],
        adapterId: testCase.adapterId,
        source: testCase.source === 'AI' ? 'ai' : testCase.source === 'USER' ? 'user' : 'detected',
        reason: testCase.reason ?? 'User-configured command.',
        command: caseConfig.command as TestCasePlan['command'],
        timeoutMs: (caseConfig.timeoutMs as number | undefined) ?? appConfig.defaultCommandTimeoutMs,
        requiresApproval: true,
        mappedFiles: (testCase.mappedFiles as string[]) ?? [],
        tags: (testCase.tags as string[]) ?? [],
        priority: testCase.priority,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function getGitChangeSummary(rootPath: string): {
  changedFiles: string[];
  commit?: string;
  branch?: string;
  diff?: string;
  error?: string;
} {
  if (!rootPath || !fs.existsSync(path.join(rootPath, '.git')))
    return { changedFiles: [], error: 'Not a git repository' };
  const run = (args: string[]) =>
    spawnSync('git', args, { cwd: rootPath, timeout: 10_000, encoding: 'utf8', windowsHide: true, shell: false });
  try {
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim();
    const commit = run(['rev-parse', '--short=12', 'HEAD']).stdout?.trim();
    const status = run(['status', '--porcelain']).stdout ?? '';
    const diffNames = run(['diff', '--name-only', 'HEAD']).stdout ?? '';
    const changed = new Set<string>();
    for (const line of `${status}\n${diffNames}`.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^[ MADRCU?!]{2}\s/.test(line)) changed.add(line.slice(3).trim().replace(/^"|"$/g, ''));
      else changed.add(trimmed);
    }
    return { changedFiles: [...changed].filter(Boolean), commit: commit || undefined, branch: branch || undefined };
  } catch (error) {
    return { changedFiles: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export interface PreparedPlan {
  plan: TestPlan;
  selection: { fallbackRequired: boolean; fallbackReason?: string; reasons: Record<string, string[]> };
  changedFiles: string[];
  git: { commit?: string; branch?: string; diff?: string };
}

export async function preparePlan(input: {
  project: Project;
  strategy?: 'full' | 'changed' | 'selected';
  changedFiles?: string[];
  forceFull?: boolean;
  caseKeys?: string[];
  includeBrowser?: boolean;
}): Promise<PreparedPlan> {
  const { project } = input;
  const detection = parseDetection(project);
  const settings = await getSettings(project.ownerId);
  const saved = await prisma.testCase.findMany({ where: { projectId: project.id, enabled: true } });
  const extraCases = saved.map(savedCaseToPlan).filter((c): c is TestCasePlan => Boolean(c));

  let plan: TestPlan;
  let selection: PreparedPlan['selection'] = { fallbackRequired: false, reasons: {} };
  if (!detection) {
    if (project.sourceType !== 'URL') {
      throw badRequest('This project has not been scanned yet. Run a scan before creating a verification plan.');
    }
    if (extraCases.length === 0) {
      throw badRequest(
        'URL projects have no local commands to detect. Add a browser or API scenario before creating a plan.',
      );
    }
    plan = {
      id: crypto.randomUUID(),
      projectId: project.id,
      createdAt: new Date().toISOString(),
      strategy: 'selected',
      cases: extraCases,
      notes: [
        'URL-only project: the plan contains only the browser/API scenarios configured by the user.',
        'No source-level lint, typecheck or unit tests can be planned without a local checkout.',
      ],
      coverageConfidence: 'low',
      unverifiedAreas: [
        'Local source code is not attached, so static checks and repository tests are unverified.',
        'Only the explicitly configured website flows are covered.',
      ],
    };
    if (input.caseKeys && input.caseKeys.length > 0) {
      const wanted = new Set(input.caseKeys);
      plan.cases = plan.cases.filter((c) => wanted.has(c.key));
      if (plan.cases.length === 0) throw badRequest('None of the requested test case keys exist in the current plan.');
    }
    return { plan, selection, changedFiles: [], git: {} };
  }
  plan = buildVerificationPlan({
    projectId: project.id,
    detection,
    strategy: input.strategy ?? 'full',
    extraCases,
    maxTimeoutMs: settings.defaultTimeoutMs,
  });
  if (input.caseKeys && input.caseKeys.length > 0) {
    const wanted = new Set(input.caseKeys);
    plan.cases = plan.cases.filter((c) => wanted.has(c.key));
    if (plan.cases.length === 0) throw badRequest('None of the requested test case keys exist in the current plan.');
  }

  let changedFiles = input.changedFiles ?? [];
  const git = getGitChangeSummary(project.rootPath ?? '');
  if (changedFiles.length === 0 && git.changedFiles.length > 0) changedFiles = git.changedFiles;

  if (input.strategy === 'changed' && !input.forceFull) {
    const result = selectTests(plan, project.rootPath ?? '.', { changedFiles, forceFull: input.forceFull });
    plan.cases = result.plan.cases;
    plan.strategy = result.plan.strategy;
    plan.notes = result.plan.notes;
    selection = {
      fallbackRequired: result.fallbackRequired,
      fallbackReason: result.fallbackReason,
      reasons: Object.fromEntries(result.selections.map((s) => [s.key, s.reasons])),
    };
  }
  return { plan, selection, changedFiles, git };
}

export async function persistPlan(projectId: string, plan: TestPlan): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  const planId = plan.id || randomUUID();
  await prisma.testPlan.create({
    data: {
      id: planId,
      projectId,
      strategy: plan.strategy.toUpperCase() as 'FULL' | 'CHANGED' | 'SELECTED',
      coverageConfidence: plan.coverageConfidence,
      planJson: toJson(plan),
      notesJson: toJson(plan.notes),
      unverifiedJson: toJson(plan.unverifiedAreas),
    },
  });
  for (const testCase of plan.cases) {
    const config: Record<string, unknown> = {};
    if (testCase.browser) config.scenario = testCase.browser;
    else if (testCase.api) config.scenario = testCase.api;
    else if (testCase.database) config.scenario = testCase.database;
    else if (testCase.command) {
      config.command = testCase.command;
      config.timeoutMs = testCase.timeoutMs;
    }
    await prisma.testCase.upsert({
      where: { projectId_key: { projectId, key: testCase.key } },
      create: {
        projectId,
        key: testCase.key,
        title: testCase.title,
        kind: testCase.kind as TestCasePlan['kind'],
        adapterId: testCase.adapterId,
        source: testCase.source === 'ai' ? 'AI' : testCase.source === 'user' ? 'USER' : 'DETECTED',
        reason: testCase.reason,
        configJson: toJson(config),
        requiresApproval: testCase.requiresApproval,
        mappedFiles: toJson(testCase.mappedFiles),
        tags: toJson(testCase.tags),
        priority: testCase.priority,
      },
      update: {
        title: testCase.title,
        reason: testCase.reason,
        requiresApproval: testCase.requiresApproval,
        mappedFiles: testCase.mappedFiles,
        tags: testCase.tags,
        priority: testCase.priority,
      },
    });
  }
}

export function scenarioFromBody(
  kind: 'browser' | 'api' | 'database',
  body: unknown,
): { scenario: BrowserScenario | ApiScenario | DbScenario; adapterId: string; requiresApproval: boolean } {
  if (kind === 'browser') {
    const scenario = BrowserScenarioSchema.parse(body);
    return { scenario, adapterId: 'browser-playwright', requiresApproval: false };
  }
  if (kind === 'api') {
    const scenario = ApiScenarioSchema.parse(body);
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(scenario.request.method);
    return { scenario, adapterId: 'api-http', requiresApproval: mutating };
  }
  const scenario = DbScenarioSchema.parse(body);
  return { scenario, adapterId: 'database-mysql', requiresApproval: scenario.allowWrites };
}

export function assertWebsiteUrl(value: string | undefined | null): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('Website URL must be an absolute http(s) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('Website URL must use http or https.');
  if (url.username || url.password) throw badRequest('Website URLs must not embed credentials.');
}

export function artifactRoot(): string {
  return appConfig.artifactsDir;
}
