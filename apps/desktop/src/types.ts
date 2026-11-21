import type { UserSettings, UpdateReleaseView } from '@zethub/shared-types';

export type {
  UpdateCheckResponse,
  UpdateDownloadJob,
  UpdateReleaseView,
  UpdateStagedRelease,
  UpdateSystemStatus,
} from '@zethub/shared-types';

export interface UpdateAdminBundle {
  items: Array<UpdateReleaseView & { status: 'published' | 'paused'; served: boolean }>;
  publicKeyConfigured: boolean;
  keyId: string | null;
  installMode: 'manual' | 'windows-installer';
  platform: string | null;
  arch: string | null;
}

export interface UpdateInstallResult {
  status: 'manual-required' | 'installer-started' | 'blocked';
  message: string;
  version: string;
  path: string | null;
  confirmationRequired: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface Ecosystem {
  language: string;
  framework?: string;
  confidence: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  sourceType: string;
  rootPath: string | null;
  repoUrl: string | null;
  websiteUrl: string | null;
  defaultBranch: string | null;
  pinned: boolean;
  archived: boolean;
  health: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  scanned: boolean;
  ecosystems: Ecosystem[];
  counts?: { runs: number; cases: number; environments: number };
  lastRun?: { id: string; status: string; startedAt: string; passed: number; total: number } | null;
}

export interface DetectionTool {
  id: string;
  name: string;
  kind: string;
  available: boolean;
  version?: string;
  executable?: string;
  reason?: string;
  configFile?: string;
}

export interface DetectionResult {
  rootPath: string;
  scannedAt: string;
  ecosystems: Array<{ language: string; version?: string; framework?: string; confidence: string; evidence: string[] }>;
  packageManagers: string[];
  manifests: string[];
  lockfiles: string[];
  testTools: string[];
  buildTools: string[];
  tools: DetectionTool[];
  isMonorepo: boolean;
  subprojects: Array<{
    name: string;
    relPath: string;
    languages: string[];
    frameworks: string[];
    packageManager?: string;
    manifests: string[];
  }>;
  docker: { detected: boolean; files: string[] };
  database: { detected: boolean; engines: string[]; configFiles: string[]; migrationDirs: string[] };
  api: { detected: boolean; specFiles: string[] };
  git: { isRepo: boolean; branch?: string; commit?: string; dirty?: boolean };
  runtime: Record<string, string | undefined>;
  warnings: string[];
  unsupported: string[];
}

export interface ProjectEnvironment {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  variables: Record<string, unknown>;
  secretKeys: string[];
  isDefault: boolean;
  createdAt: string;
}

export interface TestCase {
  id: string;
  key: string;
  title: string;
  kind: string;
  adapterId: string;
  source: string;
  reason: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  requiresApproval: boolean;
  mappedFiles: string[];
  tags: string[];
  priority: number;
  updatedAt: string;
}

export interface ProjectRunSummary {
  id: string;
  status: string;
  strategy: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  counts: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    unverified: number;
    skipped?: number;
    durationMs?: number;
  };
}

export interface ProjectDetailResponse {
  project: ProjectSummary;
  detection: DetectionResult | null;
  environments: ProjectEnvironment[];
  cases: TestCase[];
  runs: ProjectRunSummary[];
  integrations: Array<{ id: string; type: string; name: string; enabled: boolean; status: string }>;
}

export interface RunSummary {
  id: string;
  projectId: string;
  projectName: string;
  planId: string | null;
  trigger: string;
  status: string;
  strategy: string;
  gitCommit: string | null;
  gitBranch: string | null;
  environment: {
    os: string;
    arch: string;
    platform: string;
    node: string;
    hostname: string;
    appVersion: string;
    toolVersions: Record<string, string>;
  };
  counts: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    unverified: number;
    skipped: number;
    durationMs: number;
  };
  startedAt: string;
  finishedAt: string | null;
  reportId: string | null;
  verifiedScope?: string;
  remainingLimitations: string[];
  errorMessage?: string | null;
}

export interface EvidenceArtifact {
  id?: string;
  kind: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt?: string;
}

export interface AssertionResult {
  name: string;
  status: string;
  expected?: string;
  actual?: string;
  message?: string;
  durationMs?: number;
}

export interface TestResult {
  key: string;
  title: string;
  kind: string;
  adapterId: string;
  status: string;
  durationMs: number;
  exitCode?: number | null;
  commandDisplay?: string;
  stdout?: string;
  stderr?: string;
  assertions: AssertionResult[];
  evidence: EvidenceArtifact[];
  classification?: string;
  message?: string;
  stdoutTruncated?: boolean;
}

export interface RunDetail extends RunSummary {
  results: TestResult[];
  planSnapshot: PlanSnapshot | null;
  logs: string[];
}

export interface RunDetailResponse {
  run: RunDetail;
  reports: Array<{ id: string; format: string; relativePath: string; sha256: string; generatedAt: string }>;
  active: boolean;
}

export interface PlanCase {
  key: string;
  title: string;
  kind: string;
  adapterId: string;
  source: string;
  reason: string;
  command?: { executable: string; args: string[]; cwd: string; env?: Record<string, string> };
  browser?: { name: string; steps: unknown[] };
  api?: { name: string; request: unknown; expectations: unknown[] };
  database?: { name: string; integrationId: string; checks: unknown[]; allowWrites: boolean };
  timeoutMs: number;
  requiresApproval: boolean;
  mappedFiles: string[];
  tags: string[];
  priority: number;
}

export interface PlanSnapshot {
  id: string;
  projectId: string;
  createdAt: string;
  strategy: string;
  cases: PlanCase[];
  notes: string[];
  coverageConfidence: string;
  unverifiedAreas: string[];
}

export interface PlanPreview {
  plan: PlanSnapshot;
  selection: { strategy?: string; reason?: string; selected?: number; total?: number; skipped?: number } | null;
  git: { isRepo?: boolean; branch?: string | null; commit?: string | null; dirty?: boolean } | null;
  changedFiles: string[];
  approvalRequired: Array<{ key: string; title: string; kind: string }>;
  summary: { total: number; byKind: Record<string, number>; requiresApproval: number };
}

export interface RepairProposal {
  id: string;
  projectId: string;
  runId: string;
  testKey: string;
  classification: string;
  possibleCauses: string[];
  diff: string;
  files: string[];
  status: string;
  retestRunId: string | null;
  notes: string | null;
  createdAt: string;
  appliedAt: string | null;
  verifiedAt: string | null;
}

export interface QualityFinding {
  id: string;
  file: string;
  line?: number;
  testName?: string;
  category: string;
  severity: string;
  confidence: string;
  message: string;
  suggestion: string;
}

export interface QualityAudit {
  findings: QualityFinding[];
  filesAnalyzed: number;
  testsAnalyzed: number;
  artifact: { relativePath: string; sha256: string; sizeBytes: number };
  mutationTesting: { available: boolean; reason: string };
  warnings?: string[];
}

export interface FlakyTest {
  testName: string;
  runs: number;
  passes: number;
  failures: number;
  alternations: number;
  flakeRate?: number;
}

export interface DashboardData {
  projects: { total: number; healthy: number; failing: number; unknown: number };
  runsThisWeek: { total: number; finished: number; passed: number; passRate: number | null };
  activeRuns: number;
  unreadNotifications: number;
  recentRuns: RunSummary[];
  database: {
    reachable: boolean;
    error: string | null;
    lastBackup: { fileName: string; createdAt: string; verified: boolean } | null;
  };
  offlineQueue: { pending: number; synced: number; total: number };
  ai: { enabled: boolean; configured: boolean };
}

export interface AnalyticsOverview {
  days: number;
  totals: {
    runs: number;
    finished: number;
    passed: number;
    failed: number;
    passRate: number | null;
    checks: number;
    checksPassed: number;
    checksFailed: number;
    avgDurationMs: number;
  };
  series: Array<{
    date: string;
    runs: number;
    passed: number;
    failed: number;
    blocked: number;
    unverified: number;
    durationMs: number;
    checks: number;
    checksPassed: number;
  }>;
  projects: Array<{
    projectId: string;
    name: string;
    runs: number;
    passed: number;
    failed: number;
    checks: number;
    checksPassed: number;
  }>;
  topFailures: Array<{ key: string; title: string; failures: number }>;
  byKind: Array<{ kind: string; total: number; failures: number }>;
}

export interface CrossOsData {
  platforms: Array<{
    platform: string;
    os: string;
    arch: string;
    runs: number;
    passed: number;
    failed: number;
    checks: number;
    checksPassed: number;
    passRate: number | null;
    checkPassRate: number | null;
  }>;
  runs: Array<{
    id: string;
    projectId: string;
    projectName: string;
    platform: string;
    status: string;
    startedAt: string;
    gitCommit: string | null;
    total: number;
    passed: number;
    failed: number;
  }>;
  limitations: string[];
}

export interface DbStatus {
  reachable: boolean;
  serverVersion: string | null;
  serverType: string;
  host: string;
  port: number;
  database: string;
  databaseExists: boolean;
  schemaUpToDate: boolean | null;
  pendingMigrations: string[];
  appliedMigrations: string[];
  tableCount: number;
  lastHealthCheck: string | null;
  lastBackup: { fileName: string; createdAt: string; verified: boolean } | null;
  latencyMs?: number;
  error: string | null;
  checkedAt: string;
}

export interface MigrationStatus {
  expected: string[];
  applied: string[];
  pending: string[];
  failed: string[];
  upToDate: boolean;
  deploymentLocked: boolean;
  error: string | null;
}

export interface XamppDetection {
  found: boolean;
  installPath: string | null;
  mysqlBinDir: string | null;
  serverExecutable: string | null;
  clientExecutable: string | null;
  dumpExecutable: string | null;
  adminExecutable: string | null;
  serverType: string | null;
  serverVersion: string | null;
  configuredPort: number | null;
  dataDir: string | null;
  phpMyAdminPath: string | null;
  phpMyAdminUrl: string | null;
  apacheRunning: boolean;
  mysqlProcessRunning: boolean;
  serviceName: string | null;
  serviceState: string | null;
  candidates: Array<{ path: string; valid: boolean; reason?: string }>;
  warnings: string[];
}

export interface BackupRecord {
  id: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  verified: boolean;
  verificationMessage?: string;
}

export interface DbDashboard {
  xampp: XamppDetection;
  connection: {
    ok: boolean;
    serverVersion?: string;
    serverType: string;
    latencyMs?: number;
    error?: string;
    host?: string;
    port?: number;
    database?: string;
  };
  migrations: MigrationStatus;
  tableCount: number;
  backups: BackupRecord[];
  backupDirectory: string;
  lastHealthCheck: { readOk: boolean; writeOk: boolean; latencyMs: number; checkedAt: string } | null;
  limits: { destructiveActions: string; postgres: string };
}

export interface DbTable {
  name: string;
  rows: number | null;
  dataBytes: number | null;
  indexBytes: number | null;
  engine: string | null;
  collation: string | null;
  columns: Array<{ name: string; type: string; nullable: boolean; key: string }>;
}

export interface Integration {
  id: string;
  projectId: string | null;
  type: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  status: string;
  lastCheckedAt: string | null;
  credentials: Array<{ keyName: string; storage: string; fingerprint: string; rotatedAt: string | null }>;
}

export interface OfflineQueueStats {
  pending: number;
  synced: number;
  total: number;
}

export interface OfflineQueueItem {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  syncedAt: string | null;
}

export interface SyncQueueItem {
  id: string;
  clientId: string;
  type: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  syncedAt: string | null;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface SessionItem {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export type UserRole = 'OWNER' | 'ADMIN' | 'VIEWER';

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  projectCount: number;
}

export interface UsersBundle {
  items: ManagedUser[];
  total: number;
  active: number;
}

export interface AuditItem {
  id: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface SystemInfo {
  version: string;
  node: string;
  platform: string;
  arch: string;
  os: string;
  hostname: string;
  cwd: string;
  artifactsDir: string;
  backupsDir: string;
  db: {
    reachable: boolean;
    error: string | null;
    schema: { tableCount: number; pending: string[]; appliedMigrations: string[] } | null;
  };
  ai: { enabled: boolean; provider: string | null; model: string | null; consentSendCode: boolean };
  config: {
    apiHost: string;
    apiPort: number;
    maxParallelTests: number;
    defaultCommandTimeoutMs: number;
    artifactRetentionDays: number;
    workspaceRoots: string[];
  };
  tauri: { available: boolean };
}

export interface AuthMe {
  user: User;
  csrfToken: string;
  settings: UserSettings;
  session: { expiresAt?: string; viaBearer: boolean };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AuthStatus {
  initialized: boolean;
  version: string;
  dbReachable: boolean;
}
