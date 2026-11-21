# Testing

ZetHub Proof is tested at four layers: unit tests for pure logic, integration tests against a real HTTP server and a
real MySQL-compatible database, security tests for secret/path handling, and Playwright end-to-end tests against the
built application. There are no mocked API responses in the integration or E2E layers.

## Prerequisites

- Node.js 20.11 or newer (the workspace is verified on Node 24).
- A MySQL/MariaDB server. The application database and a disposable test database must be migrated.
- Chromium for Playwright (`npx playwright install chromium`; add `--with-deps` on Linux).
- A local `.env` derived from `.env.example` with `SESSION_SECRET` and database credentials.

Unit tests need no database. Integration, security and E2E tests do.

### Prepare the disposable test database

Tests derive the test database from `DATABASE_URL` by appending `_test` (for example `zethub_proof` becomes
`zethub_proof_test`). It must already exist and have the committed migrations applied. The safest way is the same setup
command used for the application, pointed at the test database:

```powershell
npm run db:setup -- --database zethub_proof_test --create-user
```

This creates the database only if missing, grants the application account access to it, deploys migrations and runs the
health check. It does not drop, reset or copy application data, and it does not rewrite `.env` unless you pass
`--write-env`. Never point tests at the application database; the harness refuses names that do not end in `_test`.

The integration and E2E harnesses delete only `users` rows inside the `_test` database, then bootstrap their own owner
account. The application database is never touched.

## Test layers

| Layer       | Command                    | What it proves                                                                                                                                                                                                                                                  | Current count |
| ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Unit        | `npm run test:unit`        | Detection, planning/selection, output parsing, redaction, evidence/path rules, report signing, capsules, quality heuristics, schemas, backend security helpers and update signing/rollout logic. No network or database.                                        | 87 passed     |
| Integration | `npm run test:integration` | Real Fastify app, real MySQL test database, real local HTTP fixture: auth/CSRF, project CRUD, health, SQL guard, API runner assertions/mutation blocking, DB schema/constraint checks, write confirmation and the signed update feed/download/install boundary. | 33 passed     |
| Security    | `npm run test:security`    | High-confidence secret detection, env-file protection, evidence redaction, symlink escape and artifact-directory reporting.                                                                                                                                     | 12 passed     |
| End-to-end  | `npm run test:e2e`         | Built UI/API on `127.0.0.1:4100` against `_test`: login, project creation, database dashboard, device-token bearer auth, security headers, extension artifact contract and 404 handling.                                                                        | 10 passed     |

Recent regression tests added while self-verifying this repository cover:

- interrupted-run recovery that must not overwrite a concurrently created run, and stale `errorMessage` clearing on later
  success,
- chained Vitest summaries and Playwright/pytest output classification (command failures are never reported as clean),
- secret-scan suppression comments, template-literal database URLs and nested monorepo artifact directories,
- lint file counting across every linted file rather than only files with messages,
- deferred artifact inspection and the sequential default.

`npm test` runs unit, integration and security in that order. `npm run test:e2e` builds the workspace first; it does not
need a separate manual build.

These counts were produced by the commands above on **2026-10-28** in this workspace (Windows, Node 24, MariaDB 10.4.32).
They are not estimates, and a skipped or unavailable test is never counted as passed.

## Full verification

```powershell
npm run verify:all
```

This runs, in order: strict typecheck (five workspaces), ESLint, Prettier check, unit/integration/security tests, the
production build, and Playwright E2E. It stops at the end with a pass/fail summary and exits non-zero if any step failed.
Add `--skip-e2e` to omit the browser layer when Chromium is unavailable; the summary then explicitly reports E2E as
skipped.

The same repository was also run through the product itself (project scan → plan → run → evidence report) as project
`cmvs8y26m000bvd80xuppk2zg`. The selected plan ran 8 cases sequentially and all 8 passed in 112 seconds; the resulting
Evidence Passport HTML, JSON and JUnit files matched the SHA-256 values returned by the API, and the manifest HMAC
matched. The plan deliberately excluded `js:audit` because the dependency advisories described in
[Security](security.md#dependency-advisories) fail it.

Verification cases execute sequentially by default (`MAX_PARALLEL_TESTS=1`). This is intentional: the workspace build and
test scripts rewrite shared `dist/` outputs, so parallel cases produced real races. Artifact inspection is also deferred
until the other cases have finished, so it observes final outputs rather than partial ones. Higher concurrency is
available only by explicit configuration and is not covered by the results above.

`npm run test:coverage` collects V8 coverage for `packages/verification-core/src` and `apps/backend/src/lib`. Coverage is
reported, not enforced with a threshold, so a green build is not a claim of complete coverage.

## What E2E covers

`tests/e2e/start-server.mjs` is the Playwright web server. It:

1. loads `.env` without printing it,
2. forces the database name to end in `_test` or refuses to start,
3. deletes only test users,
4. builds the Fastify app from `apps/backend/dist` and listens on port 4100,
5. bootstraps `e2e-owner@zethub.test` with a test-only password.

The specs then exercise the UI and API. The extension test checks the built MV3 manifest and bundle (permissions restricted
to loopback, no remote scripts). It does not drive the extension inside a real browser profile.

## CI

`.github/workflows/ci.yml` runs the full suite on Ubuntu against a MariaDB service and a Windows smoke job. The workflow:

- installs dependencies with `npm ci`,
- generates the Prisma client,
- creates and migrates the `_test` database,
- installs Chromium with system dependencies,
- runs `npm run verify:all`,
- uploads Playwright reports and test results on failure.

CI configuration is not proof of a successful run. A CI result is only claimed after the workflow has actually completed
on the hosting platform.

## Interpreting results

- `passed` means the check ran and its assertions held.
- `failed` means it ran and at least one assertion did not hold.
- `blocked` means a safety gate prevented execution (for example an unapproved mutation).
- `unverified` means the tool ran but produced output the parser could not confirm.
- `skipped` means it did not run.
- `unavailable` means the capability is not implemented or the prerequisite is missing.

`skipped`, `blocked` and `unverified` are never reported as passes. A run can therefore finish with no failures and still
carry limitations; the report lists them.

## Troubleshooting

| Symptom                                       | Likely cause                                               | Action                                                                |
| --------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `ZETHUB_TEST_DATABASE_URL was not derived`    | No `DATABASE_URL` in `.env` or environment                 | Complete `npm run db:setup`, then re-run                              |
| `Refusing to ... non-test database`           | The derived name does not end in `_test`                   | Use a database named `<app>_test`; do not rename the app database     |
| Integration tests fail at migration/schema    | Test database exists but has no migrations                 | `npm run db:setup -- --database zethub_proof_test --create-user`      |
| E2E times out waiting for `:4100/health`      | Build missing, database unreachable or port 4100 occupied  | Run `npm run build`, check the database, stop the conflicting process |
| Playwright cannot launch Chromium             | Browser or Linux libraries missing                         | `npx playwright install --with-deps chromium`                         |
| Security tests report an unprotected env file | `.env*` is not covered by `.gitignore`/`.git/info/exclude` | Add the pattern; do not add the secret to the ignore file             |
| `npm run format:check` fails                  | A new file is not formatted                                | `npm run format:check -- --write`                                     |

Artifacts from failed E2E runs are in `playwright-report/` and `test-results/` (both gitignored). Verification artifacts
and reports generated by the product itself are under `artifacts/` and are also gitignored.

## Not covered here

The following are intentionally not claimed as tested in this environment:

- native Tauri build/launch (no Rust/MSVC toolchain),
- Linux/macOS execution (CI configuration only; no local run),
- interactive browser-extension behavior in a real signed-in browser profile,
- external AI provider calls (AI is optional and disabled by default),
- PostgreSQL (the database runner is MySQL/MariaDB only),
- mutation testing and remote multi-device sync (reported unavailable by the product),
- code signing/notarization of release archives,
- native Tauri update install/restart and version confirmation (only verified staging and consent are tested),
- a production central update host (the standalone feed server is tested locally).
