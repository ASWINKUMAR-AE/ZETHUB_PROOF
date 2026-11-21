# Automatic updates

ZetHub Proof can check, verify, download and stage signed updates. Updates are **opt-in per client**, **verified before
use**, and **never installed silently**. The feature is additive: the verification engine, database schema, reports,
authentication and existing API contracts are unchanged, and everything still works fully offline when no update feed is
configured.

> Status of this build: `0.1.0`. Update checks and installs are disabled until a public signing key is deployed. The
> native Tauri install/restart handoff cannot be executed in this environment (no Rust/MSVC toolchain), so it is
> documented and tested only up to the verified-package/consent boundary.

## Contents

- [Trust model](#trust-model)
- [Where things live](#where-things-live)
- [Environment variables](#environment-variables)
- [Generate signing keys](#generate-signing-keys)
- [Publish a release](#publish-a-release)
- [Publish 1.0.1 (worked example)](#publish-101-worked-example)
- [Channels, rollout and pause](#channels-rollout-and-pause)
- [Run a central update service](#run-a-central-update-service)
- [API contract](#api-contract)
- [Client behavior](#client-behavior)
- [CI/CD](#cicd)
- [Key rotation](#key-rotation)
- [Rollback](#rollback)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## Trust model

1. A release manager hashes the artifact with SHA-256 and signs a canonical JSON manifest with an **Ed25519** private
   key. The artifact digest is signed as well.
2. The client ships with only the **public** key (`UPDATE_SIGNING_PUBLIC_KEY` or
   `UPDATE_SIGNING_PUBLIC_KEY_PATH`). It verifies the manifest signature, the key id, the artifact digest and the
   downloaded bytes before staging them.
3. Missing key, bad signature, digest mismatch, unsafe path, wrong platform, too-old version, oversized artifact or an
   interrupted download all fail closed. Nothing unverified is ever staged or launched.
4. Private keys are never read by the client, served by the feed, written into the update store, logged, or bundled in a
   release archive.
5. No telemetry is collected. The only network egress is the configured HTTPS feed and, after explicit consent, the
   artifact download.

## Where things live

`UPDATE_STORAGE_DIR` (default `./data/updates`) contains everything the updater owns. It is outside MySQL and is never
committed.

```text
data/updates/
  releases/<channel>/<platform>/<arch>/<version>.json   signed manifest (served)
  drafts/<channel>/<platform>/<arch>/<version>.json     signed manifest (never served)
  artifacts/<version>/<platform>/<arch>/<file>          artifact bytes
  downloads/<release-id>/                               staged, verified client packages
  downloads/<release-id>/staged.json                    staging record
  events.jsonl                                          append-only local update events
  install-id                                            random id used for rollout bucketing
```

Client runtime state (downloads, events, install id) resolves under the same directory, so pointing
`UPDATE_STORAGE_DIR` at a disposable folder fully isolates tests and deployments. The store is never part of the
database, so migrations, backups and reports are unaffected.

## Environment variables

| Variable                          | Default                                | Purpose                                                               |
| --------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `UPDATE_STORAGE_DIR`              | `./data/updates`                       | Manifest/artifact store plus client runtime state.                    |
| `UPDATE_FEED_URL`                 | empty                                  | Public HTTPS origin of the central feed. Empty = local store only.    |
| `UPDATE_PUBLIC_BASE_URL`          | empty                                  | Origin used in download URLs served by the standalone update server.  |
| `UPDATE_SIGNING_PUBLIC_KEY`       | empty                                  | Inline PEM public key (client verification).                          |
| `UPDATE_SIGNING_PUBLIC_KEY_PATH`  | `./secrets/update-signing-public.pem`  | File containing the public key.                                       |
| `UPDATE_SIGNING_PRIVATE_KEY_PATH` | `./secrets/update-signing-private.pem` | Release machine only. Never deploy to clients.                        |
| `UPDATE_BETA_FEED_TOKEN`          | empty                                  | Token required in `x-update-channel-token` to serve the beta channel. |
| `UPDATE_INSTALL_MODE`             | `manual`                               | `manual` or `windows-installer`.                                      |
| `UPDATE_CHECK_TIMEOUT_MS`         | `10000`                                | Feed request timeout. Downloads get at least 120 seconds.             |
| `UPDATE_MAX_ARTIFACT_MB`          | `512`                                  | Hard cap on a downloaded package.                                     |
| `UPDATE_SERVER_HOST`              | `127.0.0.1`                            | Standalone update server bind address.                                |
| `UPDATE_SERVER_PORT`              | `4010`                                 | Standalone update server port.                                        |

`.env.example` contains placeholders. Never put a private key in `.env`, `.env.example`, docs, CI logs or an installer.

## Generate signing keys

```powershell
npm run update:keys
```

Writes `secrets/update-signing-private.pem` (mode `0600` where supported) and `secrets/update-signing-public.pem`, and
prints the key id. `secrets/` and `*.pem` are gitignored. Back up the private key offline; losing it means existing
manifests can no longer be re-signed and a new key must be deployed to every client.

Deploy **only** the public key to clients:

```dotenv
UPDATE_SIGNING_PUBLIC_KEY_PATH=./secrets/update-signing-public.pem
```

Keep the private key on the release machine or in a CI secret; the release machine also needs the public key path for
`validate`.

## Publish a release

```powershell
npm run update:release -- publish `
  --artifact release/ZetHub-Proof-1.0.1-windows-x64.exe `
  --version 1.0.1 `
  --platform windows --arch x86_64 --format nsis `
  --channel stable `
  --notes-file release-notes/1.0.1.md `
  --rollout 25
```

Flags:

| Flag                          | Notes                                                               |
| ----------------------------- | ------------------------------------------------------------------- |
| `--artifact`                  | Required. `.exe`, `.msi`, `.appimage`, `.deb`, `.rpm` or `.zip`.    |
| `--version`                   | Required. Strict semantic version.                                  |
| `--platform`                  | `windows` or `linux`.                                               |
| `--arch`                      | `x86_64` or `aarch64`.                                              |
| `--format`                    | `nsis`, `msi`, `appimage`, `deb`, `rpm` or `portable`.              |
| `--channel`                   | `stable` (default) or `beta`.                                       |
| `--notes` / `--notes-file`    | Release notes shown in the UI.                                      |
| `--mandatory`                 | Cannot be skipped by the user.                                      |
| `--minimum-supported-version` | Below this version, clients must update.                            |
| `--minimum-os-version`        | Informational compatibility floor.                                  |
| `--rollout`                   | 0–100 percent staged rollout.                                       |
| `--draft`                     | Signed but stored under `drafts/` and never served.                 |
| `--allow-downgrade`           | Permit a version not newer than the latest for that target/channel. |

Other commands:

```powershell
npm run update:release -- list
npm run update:release -- validate
npm run update:release -- pause  --id stable-1.0.1-windows-x86_64
npm run update:release -- resume --id stable-1.0.1-windows-x86_64
npm run update:release -- rollout --id stable-1.0.1-windows-x86_64 --percent 100
```

`publish` refuses to overwrite an existing manifest, and `pause`/`resume`/`rollout` re-sign the manifest in place with the
current key. `validate` re-verifies every release against the configured public key; run it after publishing and before
uploading to the central feed.

## Publish 1.0.1 (worked example)

1. Bump the version everywhere listed in [release.md](release.md#version-locations), then build and package:

   ```powershell
   npm run verify:all
   npm run package
   ```

2. Build or obtain the platform artifacts you intend to serve (native installer/AppImage/DEB). Archives produced by
   `npm run package` are platform ZIPs; they are valid `portable` artifacts but are not native installers.

3. Make sure the release machine has the private key and public key configured:

   ```dotenv
   UPDATE_SIGNING_PRIVATE_KEY_PATH=./secrets/update-signing-private.pem
   UPDATE_SIGNING_PUBLIC_KEY_PATH=./secrets/update-signing-public.pem
   UPDATE_STORAGE_DIR=./data/updates
   ```

4. Sign and publish each target starting at a small rollout:

   ```powershell
   npm run update:release -- publish --artifact .\release\ZetHub-Proof-1.0.1-windows-x64.exe `
     --version 1.0.1 --platform windows --arch x86_64 --format nsis --channel stable `
     --notes-file release-notes/1.0.1.md --rollout 10
   npm run update:release -- validate
   ```

5. Serve `data/updates` with the standalone server behind HTTPS, or copy `releases/` and `artifacts/` to the central
   host and run the same server there. Point clients at it with `UPDATE_FEED_URL=https://updates.example/zethub-proof`.

6. Verify from a client: **Settings → Updates → Check now** shows `1.0.1`, the verified package appears in the update
   dialog, and the status remains “verified”. Increase rollout with `rollout --percent 100` after confirming.

7. A release is only “installed” when the running app reports the new version. Until then the UI keeps the previous
   version and the staged package remains available for retry.

## Channels, rollout and pause

- `stable` is the default channel and the only one served publicly without a token.
- `beta` requires the client to send `x-update-channel-token` matching `UPDATE_BETA_FEED_TOKEN`; otherwise the feed
  responds as if the release does not exist. The local authenticated API forwards the token only when configured.
- Staged rollout uses a deterministic bucket: `SHA-256(installId + ':' + releaseId)` mapped to 0–99. The same install
  makes the same decision until the rollout percentage changes, and no telemetry is needed.
- `pause` stops serving a release to new clients. A client already above the paused version is **not** offered a
  downgrade; a paused newer release simply falls back to the newest older published release for clients below it.
- `mandatory` updates ignore “remind me later”. Optional updates can be postponed or skipped for that exact version;
  they reappear if the release becomes mandatory.

## Run a central update service

The standalone server serves only the public feed and artifacts. It does not expose the database, admin routes,
authentication, events or staged downloads.

```powershell
$env:UPDATE_STORAGE_DIR = "D:\zethub-updates"
$env:UPDATE_PUBLIC_BASE_URL = "https://updates.example/zethub-proof"
$env:UPDATE_BETA_FEED_TOKEN = "<long random token>"
npm run update:server
```

It binds `127.0.0.1:4010` by default. Put it behind a TLS-terminating reverse proxy and set `UPDATE_PUBLIC_BASE_URL` to
the public origin so artifact URLs in manifests resolve. Example nginx location:

```nginx
location /zethub-proof/ {
  proxy_pass http://127.0.0.1:4010/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto https;
  proxy_read_timeout 300s;
  client_max_body_size 1m;
}
```

The client’s CSP is `connect-src 'self'`; the UI never calls the central feed directly. The local authenticated API is
the only updater client, which keeps CORS/CSP simple and keeps the browser away from artifacts.

Health check: `GET /api/updates/health` returns `ok`, whether a public key is configured, and the key id. Use it for
uptime monitoring. A non-loopback `UPDATE_FEED_URL` must use HTTPS; loopback HTTP is accepted only for local development.
Terminate TLS at the reverse proxy and keep the Node process on loopback.

## API contract

Public, no authentication (safe to expose through the reverse proxy):

| Method | Route                                   | Returns                                                             |
| ------ | --------------------------------------- | ------------------------------------------------------------------- |
| `GET`  | `/api/updates/health`                   | Service/key status.                                                 |
| `GET`  | `/api/updates/releases`                 | Published release history (`channel`, `platform`, `arch`, `limit`). |
| `GET`  | `/api/updates/releases/:version`        | Published entries for one version.                                  |
| `GET`  | `/api/updates/:platform/:arch/:channel` | Latest verified `{ release, envelope }` or 404.                     |
| `GET`  | `/api/updates/artifact/:id`             | Artifact bytes plus `x-update-sha256`.                              |

Authenticated local client API (cookie session or device token, CSRF for mutations):

| Method | Route                                  | Purpose                                       |
| ------ | -------------------------------------- | --------------------------------------------- |
| `GET`  | `/api/v1/updates/status`               | Current version, platform, feed, key, staged. |
| `GET`  | `/api/v1/updates/check?force=1`        | Check the feed (60s cache unless forced).     |
| `POST` | `/api/v1/updates/download`             | Start a verified download job.                |
| `GET`  | `/api/v1/updates/downloads/:id`        | Job progress/verification state.              |
| `POST` | `/api/v1/updates/downloads/:id/cancel` | Abort a download.                             |
| `GET`  | `/api/v1/updates/staged`               | Verified staged packages.                     |
| `POST` | `/api/v1/updates/install`              | Install with `{ releaseId, consent: true }`.  |
| `GET`  | `/api/v1/updates/events`               | Local update event log (bounded).             |
| `GET`  | `/api/v1/updates/releases`             | Release history for the signed-in user.       |

Owner-only administration (local API only):

| Method   | Route                                       | Purpose                            |
| -------- | ------------------------------------------- | ---------------------------------- |
| `GET`    | `/api/v1/updates/admin/releases`            | Store contents and key status.     |
| `POST`   | `/api/v1/updates/admin/publish`             | Sign and publish a local artifact. |
| `POST`   | `/api/v1/updates/admin/releases/:id/state`  | Pause/resume/rollout in one call.  |
| `POST`   | `/api/v1/updates/admin/releases/:id/pause`  | Pause.                             |
| `POST`   | `/api/v1/updates/admin/releases/:id/resume` | Resume.                            |
| `DELETE` | `/api/v1/updates/admin/staged/:id`          | Remove a staged package.           |

Admin publish requires the private key on the local machine and refuses versions not newer than the latest for the
target/channel unless `--draft` or an explicit downgrade is requested through the CLI. Admin actions are audited as
`SETTINGS_UPDATE`.

## Client behavior

- **Startup:** one delayed check after the UI is ready. **Periodic:** configurable interval, minimum 15 minutes, default 6
  hours. **Manual:** “Check now” forces a fresh check.
- Checks and downloads are asynchronous and do not interrupt active verification runs, migrations or report generation.
  Installation is refused with HTTP 409 while a run is `RUNNING`.
- If the feed is unreachable, the app keeps working offline and shows the real error. No cached “available” state is
  invented.
- `manual` mode (default) verifies and stages the package, then hands the verified file to the user. `windows-installer`
  additionally launches the package only after explicit consent; the window is never elevated silently.
- The UI never reports the new version as installed. Confirmation comes from the API after the app actually restarts on
  the new version.
- Preferences (`updateChannel`, `updateAutoCheck`, `updateIntervalMinutes`, `updateSkippedVersion`) live in the existing
  `UserSettings` JSON document. No database migration is required.

## CI/CD

Keep the private key in a protected CI secret and materialize it as a file only on the release job:

```yaml
- name: Write update signing key
  shell: bash
  run: |
    mkdir -p secrets
    printf '%s' "${{ secrets.UPDATE_SIGNING_PRIVATE_KEY }}" > secrets/update-signing-private.pem
    chmod 600 secrets/update-signing-private.pem
```

Then run `npm run update:release -- publish ...` and upload `data/updates/releases/` and `data/updates/artifacts/` to the
feed host. Never print the key, never cache `secrets/`, and delete it in a final step (`if: always()`). The public key can
be a repository variable or a committed file; it is not secret.

The existing `.github/workflows/release.yml` builds archives but does not publish updates. Add an explicit update job
only after the feed host exists; do not claim update publishing until that workflow has run.

## Key rotation

1. Generate a new pair with `npm run update:keys -- --out-dir secrets/next --force`.
2. Ship the new public key to clients **before** signing anything with it (client update or config deployment).
3. Re-sign every manifest with the new private key, including paused and older releases you still serve.
4. Keep the old public key only if clients that have not updated yet must still verify old metadata; otherwise retire it.
5. Rotating the key invalidates all manifests signed with the previous key. Clients with the old public key will reject
   the new manifests rather than install unverified packages — this is expected fail-closed behavior.

## Rollback

- Pause the bad release (`update:release -- pause --id ...`). Clients already on it are not downgraded automatically.
- Publish a new, higher version with the fix; never reuse a version number.
- To restore an older client build, stop the API and run the older verified archive/installer. Prisma migrations are
  forward-only; if the older build predates a schema change, restore a verified database backup first (with explicit
  confirmation).
- Keep the previous archive and its `.sha256`. Do not delete `artifacts/`, `backups/` or `data/`.
- Staged packages can be removed per release from **Settings → Updates** (owner) or with
  `DELETE /api/v1/updates/admin/staged/:id`.

## Troubleshooting

| Symptom                               | Cause / fix                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| “Updates are disabled for safety”     | No public key. Set `UPDATE_SIGNING_PUBLIC_KEY_PATH` and restart the API.                       |
| Check returns “No published release”  | Wrong channel/platform/arch, paused release, or empty store. Run `update:release -- list`.     |
| `401` on beta check                   | Missing or wrong `UPDATE_BETA_FEED_TOKEN` / `x-update-channel-token`.                          |
| Signature verification failed         | Manifest signed by another key, edited file, or stale public key. Re-run `validate`.           |
| Artifact hash mismatch                | Corrupt or truncated upload. Re-upload from `data/updates/artifacts/` and compare SHA-256.     |
| Download stuck / cancelled            | Check proxy timeouts and `UPDATE_CHECK_TIMEOUT_MS`; downloads allow at least 120 seconds.      |
| Install refused (409)                 | A verification run is active. Wait for it to finish; updates never interrupt runs.             |
| Installer not launching               | `UPDATE_INSTALL_MODE=manual`. Switch to `windows-installer` only if you intend to launch it.   |
| New UI assets 404 after upgrade       | Static assets are registered at startup; restart the API after rebuilding `apps/desktop`.      |
| Staged package under the wrong folder | `UPDATE_STORAGE_DIR` changed. Move/remove old staging; new downloads use the configured store. |

## Limitations

- Native Tauri install/restart handoff is not executed or verified here; only the verified-staging/consent boundary is.
- Linux packages are not built or executed in this environment.
- The release archive is not Authenticode-signed or notarized; update verification covers metadata and bytes, not the
  publisher’s OS-level identity.
- No adoption telemetry, no server-side install accounting, and no automatic rollback.
- The central server is a minimal static feed, not a full release-management service; publishing is a local/CLI action.
