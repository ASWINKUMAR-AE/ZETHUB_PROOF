import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Common                                                              */
/* ------------------------------------------------------------------ */

export const IsoDateSchema = z.string().datetime({ offset: true });
export const IdSchema = z.string().min(1).max(64);

export const TestKindSchema = z.enum([
  'lint',
  'typecheck',
  'format',
  'unit',
  'integration',
  'build',
  'browser',
  'api',
  'database',
  'security',
  'performance',
  'dependency-audit',
  'secret-scan',
  'static-analysis',
]);
export type TestKind = z.infer<typeof TestKindSchema>;

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'blocked',
  'cancelled',
  'timeout',
  'error',
  'unverified',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Status of an individual check/assertion. */
export const ResultStatusSchema = z.enum([
  'passed',
  'failed',
  'blocked',
  'cancelled',
  'timeout',
  'error',
  'skipped',
  'unverified',
]);
export type ResultStatus = z.infer<typeof ResultStatusSchema>;

export const EvidenceKindSchema = z.enum([
  'stdout',
  'stderr',
  'screenshot',
  'trace',
  'video',
  'json',
  'html',
  'junit',
  'diff',
  'log',
  'report',
  'capsule',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceArtifactSchema = z.object({
  id: z.string().optional(),
  kind: EvidenceKindSchema,
  name: z.string(),
  /** Relative path inside the managed artifact directory. Never an absolute user path. */
  relativePath: z.string(),
  mimeType: z.string().default('application/octet-stream'),
  sizeBytes: z.number().int().nonnegative().default(0),
  sha256: z.string().length(64),
  createdAt: IsoDateSchema.optional(),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

export const AssertionResultSchema = z.object({
  name: z.string(),
  status: ResultStatusSchema,
  expected: z.string().optional(),
  actual: z.string().optional(),
  message: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

export const EcosystemSchema = z.object({
  language: z.string(),
  version: z.string().optional(),
  framework: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.array(z.string()).default([]),
});
export type Ecosystem = z.infer<typeof EcosystemSchema>;

export const DetectedToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: TestKindSchema,
  available: z.boolean(),
  version: z.string().optional(),
  executable: z.string().optional(),
  reason: z.string().optional(),
  configFile: z.string().optional(),
});
export type DetectedTool = z.infer<typeof DetectedToolSchema>;

export const DetectedSubprojectSchema = z.object({
  name: z.string(),
  relPath: z.string(),
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
  packageManager: z.string().optional(),
  manifests: z.array(z.string()).default([]),
});
export type DetectedSubproject = z.infer<typeof DetectedSubprojectSchema>;

export const DetectionResultSchema = z.object({
  rootPath: z.string(),
  scannedAt: IsoDateSchema,
  ecosystems: z.array(EcosystemSchema),
  packageManagers: z.array(z.string()),
  manifests: z.array(z.string()),
  lockfiles: z.array(z.string()),
  testTools: z.array(z.string()),
  buildTools: z.array(z.string()),
  tools: z.array(DetectedToolSchema),
  isMonorepo: z.boolean(),
  subprojects: z.array(DetectedSubprojectSchema),
  docker: z.object({ detected: z.boolean(), files: z.array(z.string()) }),
  database: z.object({
    detected: z.boolean(),
    engines: z.array(z.string()),
    configFiles: z.array(z.string()),
    migrationDirs: z.array(z.string()),
  }),
  api: z.object({ detected: z.boolean(), specFiles: z.array(z.string()) }),
  git: z.object({
    isRepo: z.boolean(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    dirty: z.boolean().optional(),
  }),
  runtime: z.object({
    node: z.string().optional(),
    python: z.string().optional(),
    rust: z.string().optional(),
    go: z.string().optional(),
    dotnet: z.string().optional(),
    java: z.string().optional(),
    php: z.string().optional(),
  }),
  warnings: z.array(z.string()).default([]),
  unsupported: z.array(z.string()).default([]),
});
export type DetectionResult = z.infer<typeof DetectionResultSchema>;

/* ------------------------------------------------------------------ */
/* Locators & browser scenarios                                        */
/* ------------------------------------------------------------------ */

export const LocatorSchema = z.object({
  strategy: z.enum(['role', 'label', 'text', 'testId', 'css', 'placeholder', 'altText', 'title']),
  value: z.string().min(1),
  /** ARIA role when strategy=role */
  role: z.string().optional(),
  exact: z.boolean().optional(),
});
export type Locator = z.infer<typeof LocatorSchema>;

export const BrowserStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string().url().optional(), path: z.string().optional() }),
  z.object({
    action: z.literal('expectTitle'),
    value: z.string(),
    mode: z.enum(['contains', 'equals']).default('contains'),
  }),
  z.object({
    action: z.literal('expectUrl'),
    value: z.string(),
    mode: z.enum(['contains', 'equals']).default('contains'),
  }),
  z.object({ action: z.literal('click'), locator: LocatorSchema, description: z.string().optional() }),
  z.object({ action: z.literal('fill'), locator: LocatorSchema, value: z.string(), secret: z.boolean().optional() }),
  z.object({ action: z.literal('press'), locator: LocatorSchema, key: z.string().min(1) }),
  z.object({ action: z.literal('select'), locator: LocatorSchema, value: z.string() }),
  z.object({ action: z.literal('check'), locator: LocatorSchema, checked: z.boolean().default(true) }),
  z.object({
    action: z.literal('waitForVisible'),
    locator: LocatorSchema,
    timeoutMs: z.number().int().positive().max(120000).optional(),
  }),
  z.object({
    action: z.literal('waitForHidden'),
    locator: LocatorSchema,
    timeoutMs: z.number().int().positive().max(120000).optional(),
  }),
  z.object({
    action: z.literal('expectVisible'),
    locator: LocatorSchema,
    timeoutMs: z.number().int().positive().max(120000).optional(),
  }),
  z.object({
    action: z.literal('expectText'),
    locator: LocatorSchema,
    text: z.string(),
    mode: z.enum(['contains', 'equals', 'regex']).default('contains'),
  }),
  z.object({ action: z.literal('expectValue'), locator: LocatorSchema, value: z.string() }),
  z.object({ action: z.literal('expectCount'), locator: LocatorSchema, count: z.number().int().nonnegative() }),
  z.object({ action: z.literal('expectNoConsoleErrors') }),
  z.object({ action: z.literal('expectNoFailedRequests') }),
  z.object({
    action: z.literal('waitForResponse'),
    urlContains: z.string(),
    status: z.number().int().optional(),
    timeoutMs: z.number().int().positive().max(120000).optional(),
  }),
  z.object({ action: z.literal('screenshot'), name: z.string().min(1) }),
  z.object({
    action: z.literal('expectScreenshot'),
    name: z.string().min(1),
    maxDiffPixelRatio: z.number().min(0).max(1).default(0.01),
  }),
  z.object({ action: z.literal('upload'), locator: LocatorSchema, filePath: z.string().min(1) }),
  z.object({ action: z.literal('expectDownload'), locator: LocatorSchema }),
  z.object({ action: z.literal('expectAccessible'), locator: LocatorSchema }),
]);
export type BrowserStep = z.infer<typeof BrowserStepSchema>;

export const BrowserScenarioSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  startUrl: z.string().url().optional(),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  viewport: z
    .object({ width: z.number().int().positive().max(5120), height: z.number().int().positive().max(4320) })
    .default({ width: 1440, height: 900 }),
  timeoutMs: z.number().int().positive().max(600000).default(60000),
  trace: z.boolean().default(false),
  steps: z.array(BrowserStepSchema).min(1),
  tags: z.array(z.string()).default([]),
});
export type BrowserScenario = z.infer<typeof BrowserScenarioSchema>;

/* ------------------------------------------------------------------ */
/* API scenarios                                                       */
/* ------------------------------------------------------------------ */

export const HttpHeaderSchema = z.object({
  name: z.string(),
  /** Value may reference a secret by ${secret.NAME}; never store plaintext secrets. */
  value: z.string(),
  secret: z.boolean().optional(),
});

export const ApiRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  url: z.string().min(1),
  headers: z.array(HttpHeaderSchema).default([]),
  query: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  bodyType: z.enum(['json', 'text', 'form', 'none']).default('none'),
  timeoutMs: z.number().int().positive().max(120000).default(15000),
  /** Opt-in to state-changing requests. POST/PUT/PATCH/DELETE require this. */
  allowMutation: z.boolean().default(false),
});
export type ApiRequest = z.infer<typeof ApiRequestSchema>;

export const ApiExpectationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), equals: z.number().int().min(100).max(599) }),
  z.object({ type: z.literal('statusClass'), value: z.enum(['1xx', '2xx', '3xx', '4xx', '5xx']) }),
  z.object({
    type: z.literal('header'),
    name: z.string(),
    contains: z.string().optional(),
    equals: z.string().optional(),
  }),
  z.object({
    type: z.literal('jsonPath'),
    path: z.string(),
    exists: z.boolean().optional(),
    equals: z.unknown().optional(),
    valueType: z.enum(['string', 'number', 'boolean', 'array', 'object', 'null']).optional(),
  }),
  z.object({ type: z.literal('jsonSchema'), schema: z.record(z.unknown()) }),
  z.object({ type: z.literal('bodyContains'), value: z.string() }),
  z.object({ type: z.literal('responseTime'), maxMs: z.number().int().positive() }),
  z.object({ type: z.literal('matchOpenApi'), specPath: z.string(), operationId: z.string() }),
]);
export type ApiExpectation = z.infer<typeof ApiExpectationSchema>;

export const ApiScenarioSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  baseUrl: z.string().url().optional(),
  request: ApiRequestSchema,
  expectations: z.array(ApiExpectationSchema).min(1),
  tags: z.array(z.string()).default([]),
});
export type ApiScenario = z.infer<typeof ApiScenarioSchema>;

/* ------------------------------------------------------------------ */
/* Database scenarios                                                  */
/* ------------------------------------------------------------------ */

export const DbCheckSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('query'),
    sql: z.string().min(1),
    params: z.array(z.unknown()).default([]),
    expectRowsAtLeast: z.number().int().nonnegative().optional(),
    expectFirstRow: z.record(z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('schemaTable'),
    table: z.string().min(1),
    expectColumns: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal('constraint'),
    table: z.string().min(1),
    column: z.string().min(1),
    expectNullable: z.boolean(),
  }),
  z.object({ type: z.literal('transactionRollback'), sql: z.array(z.string()).min(1) }),
]);
export type DbCheck = z.infer<typeof DbCheckSchema>;

export const DbScenarioSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  /** Reference to a saved DB integration. Credentials never live in a scenario. */
  integrationId: z.string().min(1),
  checks: z.array(DbCheckSchema).min(1),
  /** Writes require explicit confirmation at run time. */
  allowWrites: z.boolean().default(false),
});
export type DbScenario = z.infer<typeof DbScenarioSchema>;

/* ------------------------------------------------------------------ */
/* Test plan                                                           */
/* ------------------------------------------------------------------ */

export const CommandSpecSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  /** Only ZETHUB_* env vars are honoured; everything else is rejected by the runner. */
  env: z.record(z.string()).optional(),
});
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export const TestCasePlanSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  kind: TestKindSchema,
  adapterId: z.string().min(1),
  source: z.enum(['detected', 'user', 'ai']).default('detected'),
  reason: z.string().default(''),
  command: CommandSpecSchema.optional(),
  browser: BrowserScenarioSchema.optional(),
  api: ApiScenarioSchema.optional(),
  database: DbScenarioSchema.optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
  requiresApproval: z.boolean().default(false),
  mappedFiles: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  priority: z.number().int().min(0).max(100).default(50),
});
export type TestCasePlan = z.infer<typeof TestCasePlanSchema>;

export const TestPlanSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  createdAt: IsoDateSchema,
  strategy: z.enum(['full', 'changed', 'selected']),
  cases: z.array(TestCasePlanSchema),
  notes: z.array(z.string()).default([]),
  coverageConfidence: z.enum(['high', 'medium', 'low']),
  unverifiedAreas: z.array(z.string()).default([]),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

/* ------------------------------------------------------------------ */
/* Run + report                                                        */
/* ------------------------------------------------------------------ */

export const TestResultSchema = z.object({
  key: z.string(),
  title: z.string(),
  kind: TestKindSchema,
  adapterId: z.string(),
  status: ResultStatusSchema,
  durationMs: z.number().nonnegative(),
  exitCode: z.number().int().nullable().optional(),
  commandDisplay: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  assertions: z.array(AssertionResultSchema).default([]),
  evidence: z.array(EvidenceArtifactSchema).default([]),
  classification: z.string().optional(),
  message: z.string().optional(),
  stdoutTruncated: z.boolean().optional(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const RunCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  unverified: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});
export type RunCounts = z.infer<typeof RunCountsSchema>;

export const EnvironmentInfoSchema = z.object({
  os: z.string(),
  arch: z.string(),
  platform: z.string(),
  node: z.string(),
  hostname: z.string(),
  appVersion: z.string(),
  toolVersions: z.record(z.string()).default({}),
});
export type EnvironmentInfo = z.infer<typeof EnvironmentInfoSchema>;

export const VerificationRunSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string().optional(),
  planId: z.string().nullable(),
  trigger: z.enum(['manual', 'cli', 'ci', 'repair-retest', 'scheduled']),
  status: RunStatusSchema,
  strategy: z.enum(['full', 'changed', 'selected']).default('full'),
  gitCommit: z.string().nullable(),
  gitBranch: z.string().nullable(),
  environment: EnvironmentInfoSchema,
  counts: RunCountsSchema,
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  reportId: z.string().nullable(),
  verifiedScope: z.string().optional(),
  remainingLimitations: z.array(z.string()).default([]),
});
export type VerificationRunSummary = z.infer<typeof VerificationRunSummarySchema>;

export const VerificationRunDetailSchema = VerificationRunSummarySchema.extend({
  results: z.array(TestResultSchema),
  planSnapshot: TestPlanSchema.nullable(),
  logs: z.array(z.string()).default([]),
});
export type VerificationRunDetail = z.infer<typeof VerificationRunDetailSchema>;

/* ------------------------------------------------------------------ */
/* Failure capsule / repair                                            */
/* ------------------------------------------------------------------ */

export const FailureCapsuleSchema = z.object({
  formatVersion: z.literal(1).default(1),
  id: z.string(),
  createdAt: IsoDateSchema,
  project: z.object({
    name: z.string(),
    sourceType: z.string(),
    gitCommit: z.string().nullable(),
    gitBranch: z.string().nullable(),
  }),
  test: z.object({ key: z.string(), title: z.string(), kind: TestKindSchema }),
  environment: EnvironmentInfoSchema,
  failure: z.object({
    status: ResultStatusSchema,
    classification: z.string(),
    message: z.string().optional(),
    expected: z.string().optional(),
    actual: z.string().optional(),
    logExcerpt: z.string().optional(),
  }),
  diff: z.string().optional(),
  changedFiles: z.array(z.string()).default([]),
  reproduction: z.object({ steps: z.array(z.string()), command: z.string().optional() }),
  evidenceHashes: z.record(z.string()).default({}),
  redactionsApplied: z.number().int().nonnegative().default(0),
});
export type FailureCapsule = z.infer<typeof FailureCapsuleSchema>;

export const RepairProposalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  testKey: z.string(),
  createdAt: IsoDateSchema,
  classification: z.string(),
  possibleCauses: z.array(z.string()),
  diff: z.string(),
  files: z.array(z.string()),
  status: z.enum(['proposed', 'approved', 'applied', 'rejected', 'verified', 'failed']),
  appliedAt: IsoDateSchema.optional(),
  verifiedAt: IsoDateSchema.optional(),
  retestRunId: z.string().optional(),
  notes: z.string().optional(),
});
export type RepairProposal = z.infer<typeof RepairProposalSchema>;

/* ------------------------------------------------------------------ */
/* Quality auditor                                                     */
/* ------------------------------------------------------------------ */

export const TestQualityFindingSchema = z.object({
  id: z.string(),
  file: z.string(),
  line: z.number().int().positive().optional(),
  testName: z.string().optional(),
  category: z.enum([
    'missing-assertion',
    'weak-assertion',
    'empty-test',
    'skipped-test',
    'broad-catch',
    'hardcoded-timeout',
    'fragile-selector',
    'shared-state',
    'missing-negative-case',
    'duplicate-test',
    'mutation-survived',
    'flaky-history',
  ]),
  severity: z.enum(['high', 'medium', 'low', 'info']),
  confidence: z.enum(['confirmed', 'heuristic']),
  message: z.string(),
  suggestion: z.string(),
});
export type TestQualityFinding = z.infer<typeof TestQualityFindingSchema>;

/* ------------------------------------------------------------------ */
/* Database administration                                             */
/* ------------------------------------------------------------------ */

export const XamppDetectionSchema = z.object({
  found: z.boolean(),
  installPath: z.string().nullable(),
  mysqlBinDir: z.string().nullable(),
  serverExecutable: z.string().nullable(),
  clientExecutable: z.string().nullable(),
  dumpExecutable: z.string().nullable(),
  adminExecutable: z.string().nullable(),
  serverType: z.string().nullable(),
  serverVersion: z.string().nullable(),
  configuredPort: z.number().int().nullable(),
  dataDir: z.string().nullable(),
  phpMyAdminPath: z.string().nullable(),
  phpMyAdminUrl: z.string().nullable(),
  apacheRunning: z.boolean().default(false),
  mysqlProcessRunning: z.boolean().default(false),
  serviceName: z.string().nullable(),
  serviceState: z.string().nullable(),
  candidates: z.array(z.object({ path: z.string(), valid: z.boolean(), reason: z.string().optional() })),
  warnings: z.array(z.string()).default([]),
});
export type XamppDetection = z.infer<typeof XamppDetectionSchema>;

export const DbConnectionStatusSchema = z.object({
  reachable: z.boolean(),
  serverVersion: z.string().nullable(),
  serverType: z.enum(['mysql', 'mariadb', 'unknown']),
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  databaseExists: z.boolean(),
  schemaUpToDate: z.boolean().nullable(),
  pendingMigrations: z.array(z.string()).default([]),
  appliedMigrations: z.array(z.string()).default([]),
  tableCount: z.number().int().nonnegative().default(0),
  lastHealthCheck: IsoDateSchema.nullable(),
  lastBackup: z.object({ fileName: z.string(), createdAt: IsoDateSchema, verified: z.boolean() }).nullable(),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().nullable(),
  checkedAt: IsoDateSchema,
});
export type DbConnectionStatus = z.infer<typeof DbConnectionStatusSchema>;

export const MigrationStatusSchema = z.object({
  expected: z.array(z.string()),
  applied: z.array(z.string()),
  pending: z.array(z.string()),
  failed: z.array(z.string()).default([]),
  upToDate: z.boolean(),
  deploymentLocked: z.boolean().default(false),
  error: z.string().nullable(),
});
export type MigrationStatus = z.infer<typeof MigrationStatusSchema>;

export const BackupRecordSchema = z.object({
  fileName: z.string(),
  path: z.string(),
  sizeBytes: z.number().nonnegative(),
  sha256: z.string(),
  createdAt: IsoDateSchema,
  verified: z.boolean(),
  verificationMessage: z.string().optional(),
});
export type BackupRecord = z.infer<typeof BackupRecordSchema>;

export const DbSetupResultSchema = z.object({
  success: z.boolean(),
  steps: z.array(z.object({ step: z.string(), status: z.enum(['passed', 'failed', 'skipped']), message: z.string() })),
  connection: DbConnectionStatusSchema.nullable(),
  migrations: MigrationStatusSchema.nullable(),
  healthCheck: z
    .object({ read: z.boolean(), write: z.boolean(), cleanup: z.boolean(), message: z.string() })
    .nullable(),
  error: z.string().nullable(),
});
export type DbSetupResult = z.infer<typeof DbSetupResultSchema>;

/* ------------------------------------------------------------------ */
/* Settings / offline queue                                            */
/* ------------------------------------------------------------------ */

export const UserSettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  language: z.string().default('en'),
  defaultProjectDir: z.string().nullable().default(null),
  maxParallelTests: z.number().int().min(1).max(8).default(1),
  defaultTimeoutMs: z.number().int().min(5000).max(3_600_000).default(300_000),
  artifactRetentionDays: z.number().int().min(1).max(3650).default(30),
  offlineMode: z.enum(['auto', 'always', 'never']).default('auto'),
  aiEnabled: z.boolean().default(false),
  aiConsentSendCode: z.boolean().default(false),
  aiProvider: z.string().nullable().default(null),
  aiModel: z.string().nullable().default(null),
  telemetry: z.boolean().default(false),
  defaultBrowser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  screenshotOnFailureOnly: z.boolean().default(true),
  requireCommandApproval: z.boolean().default(true),
  updateChannel: z.enum(['stable', 'beta']).default('stable'),
  updateAutoCheck: z.boolean().default(true),
  updateCheckIntervalMinutes: z.number().int().min(15).max(10_080).default(360),
  updateSkippedVersion: z.string().max(64).nullable().default(null),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

/* ------------------------------------------------------------------ */
/* Automatic updates                                                   */
/* ------------------------------------------------------------------ */

export const UPDATE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const UpdateChannelSchema = z.enum(['stable', 'beta']);
export const UpdatePlatformSchema = z.enum(['windows', 'linux']);
export const UpdateArchSchema = z.enum(['x86_64', 'aarch64']);
export const UpdateArtifactFormatSchema = z.enum(['nsis', 'msi', 'appimage', 'deb', 'rpm', 'portable']);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;
export type UpdatePlatform = z.infer<typeof UpdatePlatformSchema>;
export type UpdateArch = z.infer<typeof UpdateArchSchema>;
export type UpdateArtifactFormat = z.infer<typeof UpdateArtifactFormatSchema>;

export const UpdateArtifactSchema = z.object({
  fileName: z
    .string()
    .min(1)
    .max(220)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Artifact file names must be plain file names.'),
  format: UpdateArtifactFormatSchema,
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters.'),
  digestSignature: z.string().min(40).max(4096),
  path: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[A-Za-z0-9._/-]+$/, 'Artifact paths may contain only plain path segments.'),
});

export const UpdateReleasePayloadSchema = z.object({
  schemaVersion: z.literal(1),
  id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/),
  version: z.string().regex(UPDATE_VERSION_PATTERN),
  channel: UpdateChannelSchema,
  platform: UpdatePlatformSchema,
  arch: UpdateArchSchema,
  publishedAt: IsoDateSchema,
  notes: z.string().max(20_000),
  mandatory: z.boolean(),
  minimumSupportedVersion: z.string().regex(UPDATE_VERSION_PATTERN).nullable(),
  minimumOsVersion: z.string().max(120).nullable(),
  paused: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
  artifact: UpdateArtifactSchema,
});
export type UpdateReleasePayload = z.infer<typeof UpdateReleasePayloadSchema>;

export const UpdateManifestEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  keyId: z.string().min(1).max(200),
  payload: UpdateReleasePayloadSchema,
  signature: z.string().min(40).max(8192),
});
export type UpdateManifestEnvelope = z.infer<typeof UpdateManifestEnvelopeSchema>;

export type UpdateCheckState = 'available' | 'none' | 'paused' | 'incompatible' | 'unavailable' | 'error';

export interface UpdateReleaseView {
  id: string;
  version: string;
  channel: z.infer<typeof UpdateChannelSchema>;
  platform: z.infer<typeof UpdatePlatformSchema>;
  arch: z.infer<typeof UpdateArchSchema>;
  publishedAt: string;
  notes: string;
  mandatory: boolean;
  minimumSupportedVersion: string | null;
  minimumOsVersion: string | null;
  paused: boolean;
  rolloutPercent: number;
  format: z.infer<typeof UpdateArtifactFormatSchema>;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  artifactSignaturePresent: boolean;
  keyId: string;
  signatureVerified: boolean;
  verification: 'verified' | 'unverified' | 'failed' | 'unavailable';
  verificationMessage: string;
}

export interface UpdateCheckResponse {
  status: UpdateCheckState;
  currentVersion: string;
  latestVersion: string | null;
  release: UpdateReleaseView | null;
  message: string;
  checkedAt: string;
  source: 'local' | 'remote';
  cached: boolean;
  updateAvailable: boolean;
  mandatory: boolean;
}

export interface UpdateDownloadJob {
  id: string;
  releaseId: string;
  version: string;
  status: 'queued' | 'downloading' | 'verifying' | 'ready' | 'failed' | 'cancelled';
  bytesReceived: number;
  totalBytes: number | null;
  progress: number;
  fileName: string | null;
  stagedPath: string | null;
  sha256: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface UpdateStagedRelease {
  releaseId: string;
  version: string;
  fileName: string;
  path: string;
  sha256: string;
  verified: boolean;
  downloadedAt: string;
}

export interface UpdateSystemStatus {
  currentVersion: string;
  feedConfigured: boolean;
  feedUrl: string | null;
  storageConfigured: boolean;
  publicKeyConfigured: boolean;
  keyId: string | null;
  installMode: 'manual' | 'windows-installer';
  platform: string;
  arch: string;
  channel: 'stable' | 'beta';
  activeRuns: number;
  staged: UpdateStagedRelease[];
  releases: number;
  message: string;
}

export interface UpdateAdminRelease extends UpdateReleaseView {
  status: 'published' | 'paused';
  served: boolean;
}

export interface UpdateEvent {
  at: string;
  event: 'check' | 'available' | 'download' | 'download-failed' | 'install-started' | 'manual-install' | 'error';
  currentVersion: string;
  latestVersion: string | null;
  platform: string;
  arch: string;
  releaseId: string | null;
  detail?: string;
}

export const OfflineQueueItemSchema = z.object({
  id: z.string(),
  type: z.enum(['run-result', 'audit-event', 'report']),
  payload: z.record(z.unknown()),
  createdAt: IsoDateSchema,
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().default(null),
  syncedAt: IsoDateSchema.nullable().default(null),
});
export type OfflineQueueItem = z.infer<typeof OfflineQueueItemSchema>;

/* ------------------------------------------------------------------ */
/* Project & environment input contracts                               */
/* ------------------------------------------------------------------ */

export const ProjectSourceTypeSchema = z.enum(['LOCAL', 'GIT', 'URL']);
export type ProjectSourceType = z.infer<typeof ProjectSourceTypeSchema>;

export const ProjectInputSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(4000).nullable().optional(),
  sourceType: ProjectSourceTypeSchema.default('LOCAL'),
  rootPath: z.string().max(1024).nullable().optional(),
  repoUrl: z.string().max(1024).nullable().optional(),
  websiteUrl: z.string().max(1024).nullable().optional(),
  defaultBranch: z.string().max(190).nullable().optional(),
});

export const EnvironmentKindSchema = z.enum(['LOCAL', 'TEST', 'STAGING', 'PRODUCTION']);
export type EnvironmentKind = z.infer<typeof EnvironmentKindSchema>;

export const IntegrationTypeSchema = z.enum(['GIT', 'GITHUB', 'BROWSER', 'AI', 'DATABASE', 'API', 'CI']);
export type IntegrationType = z.infer<typeof IntegrationTypeSchema>;

export const AuditActionSchema = z.enum([
  'LOGIN',
  'LOGOUT',
  'PROJECT_CREATE',
  'PROJECT_UPDATE',
  'PROJECT_DELETE',
  'SCAN',
  'PLAN_CREATE',
  'RUN_START',
  'RUN_CANCEL',
  'RUN_COMPLETE',
  'REPORT_GENERATE',
  'CAPSULE_EXPORT',
  'CAPSULE_IMPORT',
  'REPAIR_PROPOSE',
  'REPAIR_APPLY',
  'DB_SETUP',
  'DB_MIGRATE',
  'DB_BACKUP',
  'DB_RESTORE',
  'INTEGRATION_UPDATE',
  'SETTINGS_UPDATE',
  'SYNC',
  'SECURITY_DENIED',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const ProjectEnvironmentInputSchema = z.object({
  name: z.string().min(1).max(80),
  kind: EnvironmentKindSchema.default('LOCAL'),
  baseUrl: z.string().url().nullable().optional(),
  variables: z.record(z.string()).optional(),
  /** Secret values are encrypted at rest and never returned. */
  secrets: z.record(z.string()).optional(),
  isDefault: z.boolean().optional(),
});

export const TestCaseInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(190)
    .regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits, dots, colons, underscores or dashes'),
  title: z.string().min(1).max(255),
  kind: TestKindSchema,
  priority: z.number().int().min(0).max(100).default(50),
  reason: z.string().max(4000).optional(),
  tags: z.array(z.string().max(60)).max(20).default([]),
  mappedFiles: z.array(z.string().max(500)).max(200).default([]),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
  command: CommandSpecSchema.optional(),
  scenario: z.unknown().optional(),
});
export type TestCaseInput = z.infer<typeof TestCaseInputSchema>;

/* ------------------------------------------------------------------ */
/* API envelopes                                                       */
/* ------------------------------------------------------------------ */

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};

export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export function redactSecretsInText(text: string): string {
  return text
    .replace(
      /(password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*["']?[^\s"',;}]{3,}/gi,
      '$1=***REDACTED***',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer ***REDACTED***')
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])_[A-Za-z0-9_]{8,}\b/g, '***REDACTED***');
}
