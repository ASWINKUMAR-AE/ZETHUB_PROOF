# Security

## Threat model

ZetHub Proof runs on a developer workstation and executes local commands, browser journeys and database queries. The
primary assets are source code, local credentials, database contents and the integrity of verification evidence. The
primary threats are:

- another local process or malicious web page reaching the API,
- credential leakage through logs, evidence, reports or capsules,
- destructive database actions,
- unauthorized state changes through CSRF,
- tampered evidence,
- over-privileged database or browser automation.

## Implemented controls

### Network exposure

- The API refuses non-loopback binds (`127.0.0.1`, `localhost`, `::1`).
- CORS allows configured local origins, Tauri webview origins and browser-extension origins. Credentials are allowed
  only for authenticated requests.
- Helmet sets CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, referrer policy and related headers.
- Rate limiting is enabled (600 requests/minute by default).

### Authentication and sessions

- Passwords are hashed with scrypt; plaintext passwords are never stored.
- Sessions are database-backed; the session cookie is HTTP-only and `SameSite` protected.
- State-changing cookie requests require the `X-CSRF-Token` returned by `/api/v1/auth/me`.
- Bearer device tokens are hashed at rest and shown once. Bearer requests do not use ambient cookies, so CSRF does not
  apply; authorization and approval checks still do.
- The owner role is required for sensitive mutations.

### Secrets and evidence

- Integration credentials are encrypted at rest using a key derived from `SESSION_SECRET` and stored in a restricted
  local file.
- Evidence/log redaction covers bearer tokens, common key/value credentials and provider token patterns.
- API secrets are referenced as `${secret.NAME}` and resolved server-side; plaintext is not persisted in scenarios.
- The built-in secret scanner skips the contents of local `.env*` files but verifies that `.gitignore` (and
  `.git/info/exclude`) protects them; an unprotected env file is a high-severity finding. Only ignore status is recorded,
  never env values.
- Capsules exclude source/secrets and are validated on import.
- Report manifests are HMAC-SHA256 signed with `SESSION_SECRET`; every artifact carries SHA-256.

### Update integrity

- Manifest signatures use Ed25519; artifact bytes are checked against a signed SHA-256 digest and a size cap.
- The client reads only the public key. Private keys are release-machine/CI-only and are never served, logged or bundled.
- Missing key, bad signature, unsafe path, wrong platform, incompatible or downgraded version, interrupted download and
  oversized artifacts fail closed. No unverified package is staged or launched.
- Installation requires explicit consent and is refused while a verification run is active. `manual` mode never executes
  the package.
- Beta channels require a server-side token; public history defaults to stable releases only.
- Checks and downloads perform no telemetry and do not disturb runs, migrations, reports or the database schema.

### Execution boundaries

- Project paths are normalized and validated; traversal, NUL and control characters are rejected.
- Evidence reads are confined to the artifact root.
- Commands run with timeouts, captured output and cancellation; no shell interpolation of scenario values where a spawn
  spec can be used.
- Browser mutations are driven only by explicit scenario steps.
- API scenarios block state-changing HTTP methods unless `allowMutation` is set.
- Database scenarios block writes unless `allowWrites` is set **and** the run request confirms writes. Read-only SQL is
  enforced by a parser/guard; destructive statements are rejected.
- Restore drops/replaces data only after explicit confirmation and an existing verified backup.
- Repairs are validated with `git apply --check`; there is no automatic apply.

### AI boundary

AI is disabled by default and requires explicit configuration plus consent to send code. Suggestions are returned for
review and are never executed or saved automatically. AI failures do not affect deterministic verification results.

## Local-only assumptions

- The workstation and its user account are trusted.
- `SESSION_SECRET` and `.env` are not committed.
- The API is not exposed through a reverse proxy or tunnel.
- The database account has only the privileges needed by the application; `db:setup -- --create-user` creates a
  least-privilege account.
- Browser profiles used for verification should not contain unrelated personal sessions.

## Dependency advisories

`npm audit` on the committed lockfile reports **9 advisories: 2 critical, 4 high and 3 moderate**. They are real
findings and are not suppressed in this repository. The nine advisory records map to the affected packages below
(some advisories share a package). Their scope differs:

| Package                     | Severity | Scope       | Advisory theme                                          | Fix available                   |
| --------------------------- | -------- | ----------- | ------------------------------------------------------- | ------------------------------- |
| `vitest` / `tinypool`       | critical | development | Prototype pollution gadget leading to RCE               | Vitest 5.0.5 (major)            |
| `vitest` / `@vitest/mocker` | moderate | development | Path traversal / arbitrary file read, mock registration | Vitest 5.0.5 (major)            |
| `prisma` / `@prisma/config` | high     | development | `deepmerge-ts` stack exhaustion during config merging   | Prisma 7.10.1 (major)           |
| `deepmerge-ts` (via Prisma) | high     | development | Stack exhaustion on recursive object graphs             | Prisma 7.10.1 (major)           |
| `zod`                       | high     | production  | Memory exhaustion on oversized constrained collections  | Zod 4.6.7 (major)               |
| `react-router-dom`          | moderate | production  | Open redirect and SSR hydration constructor injection   | React Router DOM 7.18.5 (major) |

`npm audit --omit=dev` therefore reports **3 advisories** (1 high, 2 moderate): zod and react-router. The development
advisories matter because this tool executes project tooling locally; they are still a local-workstation risk rather
than a remotely reachable service risk.

The fixes require major upgrades (Zod 3 → 4, React Router 6 → 7, Prisma 6 → 7, Vitest 3 → 5). They were not applied in
this build because each needs a migration and re-verification that has not been performed; silently bumping majors and
claiming a clean audit would be false. The full verification plan's `js:audit` case fails until these are addressed, and
the self-verification result quoted elsewhere deliberately excludes that case. Treat the audit as an open item.

Mitigations in the current build:

- Zod validates local request/scenario payloads; oversized-collection inputs are not accepted from untrusted remote
  clients because the API is loopback-only.
- React Router routes are author-controlled; no user-supplied URL is fed to `useNavigate` or `<Link>` redirects.
- Prisma/Vitest tooling runs as the local developer account, and project commands already execute with that account's
  privileges by design.
- Dependency review should be repeated after any major upgrade; do not assume this table stays current.

## Known gaps

- Release archives are not code-signed or notarized.
- Update manifests are Ed25519-signed and artifacts are SHA-256-verified, but updates stay disabled until a public key
  is deployed. The native Tauri install/restart handoff has not been executed here.
- Native Tauri hardening has not been validated because no Rust build was performed here.
- Linux/macOS sandboxing and packaging have not been executed in this environment.
- Extension CORS allows any `chrome-extension://`/`moz-extension://` origin; a stronger deployment could pin the exact
  extension ID. Authentication is still required.
- Global Git excludes are not consulted by the env-file protection check.
- The dependency advisories listed above remain open; no major upgrade migration has been performed.
- PostgreSQL is unsupported by the database runner.
- The offline queue is local and single-user; there is no remote multi-device sync or conflict resolution.

## Incident guidance

1. Stop the API and close the desktop UI.
2. Rotate `SESSION_SECRET` (invalidates sessions and report signatures) and database passwords.
3. Revoke device tokens in Settings.
4. Inspect `data/logs`, the audit log in Settings, and `artifacts/` for unexpected activity.
5. Restore from a verified backup only after confirming the target database and with explicit approval.

## Reporting

This is a private project. Report security issues to the repository owner privately; do not open a public issue with
secrets or exploit details.
