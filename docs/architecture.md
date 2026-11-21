# Architecture

## System shape

```text
┌──────────────────────────────┐        ┌────────────────────────────────────┐
│ React UI (Vite)              │        │ Browser extension (MV3)            │
│ apps/desktop                 │        │ apps/browser-extension             │
│ - routes, auth provider      │        │ - capture metadata                 │
│ - real API calls only        │        │ - save scenario via bearer token   │
└──────────────┬───────────────┘        └─────────────────┬──────────────────┘
               │ HTTP + cookie/CSRF                       │ HTTP + bearer
               ▼                                          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Fastify API (loopback only) — apps/backend                                │
│ auth · projects · plans · runs · evidence · repairs · database · analytics│
│ integrations · AI (optional) · offline queue · OpenAPI docs               │
└──────────────┬───────────────────────────────┬────────────────────────────┘
               │ Prisma                         │ in-process calls
               ▼                                ▼
┌──────────────────────────┐      ┌──────────────────────────────────────────┐
│ MySQL / MariaDB          │      │ verification-core                        │
│ 24 Prisma models         │      │ detect · plan · select · execute         │
│ migrations + audit       │      │ browser · api · db · evidence · report   │
└──────────────────────────┘      │ security · quality · repair · capsule    │
                                  └──────────────────────────────────────────┘
```

The Tauri 2 crate in `apps/desktop/src-tauri` is a thin shell that hosts the built UI. Verification never runs in Rust;
it runs in the TypeScript engine so the same code is used by the API, tests and packaging.

## Workspaces

| Package                     | Responsibility                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@zethub/shared-types`      | Zod schemas, enums, API envelopes. Single source of truth for scenario and run shapes.                                                                                         |
| `@zethub/verification-core` | Detection, planning/selection, command/browser/API/DB runners, evidence store, report builder, capsule, repair validation, quality analysis, secret scanning, XAMPP discovery. |
| `@zethub/backend`           | Fastify app, auth/session/CSRF, Prisma access, route handlers, run orchestration, SSE events, offline queue, OpenAPI.                                                          |
| `@zethub/desktop`           | React 18 UI with React Router, Tailwind and shadcn-style primitives; Tauri 2 config and Rust shell source.                                                                     |
| `@zethub/browser-extension` | MV3 service worker, popup and page snapshot capture, bundled by esbuild.                                                                                                       |

Workspace packages export built `dist/` output. `npm run build` builds them before the API; `npm run dev` and the database
scripts build the two shared packages first. Vitest aliases the package names to source for fast tests.

## Verification flow

1. **Project creation** validates the path/URL and records the source type.
2. **Scan** walks the project, writes `DetectionResult`, and regenerates detected test cases. Detection reports evidence
   per ecosystem/tool and lists unsupported or unavailable capabilities.
3. **Plan** builds server-side from detection + saved cases + optional changed files. Cases carry `requiresApproval`
   where execution could mutate state.
4. **Run** persists the plan snapshot, streams progress over SSE, and executes selected cases sequentially by default
   (`MAX_PARALLEL_TESTS=1`). This avoids real races when project build/test scripts rewrite shared `dist/` outputs;
   higher concurrency is opt-in. Active runs can be cancelled; interrupted runs are marked on restart.
5. **Result recording** writes per-case status (`passed`, `failed`, `blocked`, `unverified`, `skipped`), assertions,
   classification, duration and evidence references.
6. **Artifacts** are written by `EvidenceStore` under `artifacts/runs/<sanitized-run-id>/`. File names are sanitized,
   reads are confined to the artifact root, and every artifact gets a SHA-256. Artifact inspection cases are deferred
   until all other selected cases have finished, so they inspect final outputs rather than a half-written tree.
7. **Reports** combine the run, plan snapshot, results and artifact hashes into HTML/JSON/JUnit, then sign the manifest
   with HMAC-SHA256 using `SESSION_SECRET`.
8. **Analytics** derives trends and flaky signals only from persisted runs. Missing history is shown as unavailable.

## Execution adapters

- **Command** — resolves a spawn spec, runs with a timeout/abort signal, captures stdout/stderr, classifies failures and
  parses common test summaries. Windows `.cmd/.bat` shims are handled through a Node CLI mapping rather than spawned
  directly.
- **Browser** — Playwright Chromium/Firefox/WebKit, locator strategies, console/network assertions, screenshots and PNG
  baseline comparison (`pngjs`).
- **API** — `fetch` with assertions, Ajv OpenAPI validation, secret substitution, redaction and explicit mutation
  approval.
- **Database** — `mysql2` only; read-only SQL guard, schema/constraint probes, rollback-only writes and confirmation-
  gated writes. PostgreSQL is not implemented.

## Data model (high level)

- `User`, `Session`, `AuditEvent`, `Setting`
- `Project`, `ProjectEnvironment`, `DetectedTool` (stored in detection JSON), `TestCase`
- `VerificationPlan`, `VerificationRun`, `RunResult`, `RunLog`
- `EvidenceArtifact`, `Report`, `FailureCapsule`
- `RepairProposal`, `Integration`, `AiSuggestion`, `OfflineQueueItem`, `Notification`

Sessions store token hashes, not raw tokens. Integration credentials are encrypted with a key derived from the session
secret and written to a mode-restricted file under `data/`.

## Backend route families

| Prefix                 | Responsibility                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| `/api/v1/auth`         | bootstrap, login/logout, status, profile, sessions, device tokens              |
| `/api/v1/projects`     | CRUD, scan, environments, cases, Git operations, quality/select                |
| `/api/v1/runs`         | plan preview, start/cancel, list/detail, SSE events, report, capsules, repairs |
| `/api/v1/evidence`     | artifact browsing and download                                                 |
| `/api/v1/db`           | dashboard, setup verify, migrations, query guard, backups/restore, XAMPP start |
| `/api/v1/integrations` | Git/GitHub/API/browser/AI integration configuration and checks                 |
| `/api/v1/offline`      | offline queue status and flush                                                 |
| `/api/v1/analytics`    | overview, flaky tests, cross-OS comparison                                     |
| `/api/v1/system`       | health and runtime information                                                 |
| `/api/v1/updates`      | authenticated update check/download/stage/install, status and owner admin      |
| `/api/updates`         | public signed feed, release history, artifact bytes and health (no auth/DB)    |

OpenAPI JSON and Swagger UI are served at `/api/docs`.

## Frontend structure

- `AuthProvider` bootstraps `/auth/status` and `/auth/me`, keeps cookie/CSRF auth, and exposes login/logout/bootstrap.
- `UpdateProvider` polls update status, drives the update dialog, and never reports an installed version until the API
  returns it.
- `lib/api.ts` attaches the CSRF header on state-changing requests and normalizes API errors.
- Routes are protected; unauthenticated users are redirected to `/login`.
- Toasts (Sonner), charts (Recharts), icons (Lucide) and Radix primitives are used consistently.
- React StrictMode can issue duplicate development fetches; the API is idempotent for reads and the UI tolerates aborted
  requests.

## Offline and failure handling

- The offline queue stores eligible payloads in `data/` and exposes status/flush endpoints. It is not a background daemon.
- Failure capsules contain command/assertion context and redacted logs. Import is validated before persistence.
- Repair proposals are user/AI supplied; the API validates them with `git apply --check`. No patch is generated or
  applied automatically.
- Global error handling returns structured errors; empty JSON bodies are treated as no payload.

## Design constraints

- Loopback binding is enforced at startup.
- No metrics or verdicts are synthesized. Unavailable capabilities are returned as `unavailable`/`unverified`.
- No secrets are written into evidence, reports, logs or capsules.
- Long-running work is cancellable and bounded by timeouts.
- Database operations that can destroy data require explicit confirmation and never run implicitly.
