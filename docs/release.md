# Release and packaging

ZetHub Proof releases are local, unsigned archives plus (optionally) a native Tauri build. Signed automatic updates are
available through a self-hosted feed; no hosted update service is provided. This document describes what the current
tooling actually produces and what it does not. Update signing, publishing and deployment are covered in
[updates.md](updates.md).

## Current release status

- Version: **0.1.0**.
- `npm run package` produces a platform-tagged ZIP with hashes and a build manifest. It was verified on Windows in this
  workspace: the archive extracts to `zethub-proof/`, the manifest reports no missing files, and `npm ci --dry-run`
  accepts the bundled workspace metadata.
- The archive is rebuilt after documentation changes. Its current SHA-256 is whatever the sibling `.sha256` file says;
  hashes embedded in prose would go stale on the next rebuild, so they are intentionally not copied into this document.
- No native Tauri binary has been built here (no Rust/MSVC toolchain).
- Linux and macOS builds are configured in CI only; no result is claimed until CI has run.
- Archives are **not code-signed or notarized**. Verify the published SHA-256 out of band before running an archive.
- Signed update manifests can be published to a self-hosted feed, but updates stay disabled until a public key is
  configured. See [updates.md](updates.md).

## Version locations

The version is duplicated by design. When bumping, update all of:

- root `package.json`,
- `apps/backend/package.json`, `apps/desktop/package.json`, `apps/browser-extension/package.json`,
- `packages/shared-types/package.json`, `packages/verification-core/package.json`,
- `apps/desktop/src-tauri/tauri.conf.json`,
- `apps/browser-extension/src/manifest.json`.

`scripts/package.mjs` reads the root `package.json` version for the archive name and manifest. There is no automated
version-bump command. Keep the Tauri and extension versions in sync with the root version.

## Pre-release checklist

Run these from a clean, committed tree:

```powershell
npm ci
npm run db:generate
npm run verify:all
npm run db:verify
npm run build
npm run package
```

`npm run verify:all` covers typecheck, lint, format, unit/integration/security tests, production build and E2E. E2E needs
the migrated `_test` database and Chromium. If the browser layer cannot run, use `npm run verify:all -- --skip-e2e` and
record the omission in the release notes; do not describe it as a full verification.

Before tagging, also:

- confirm no `.env`, `data/`, `artifacts/`, `backups/` or credentials are staged,
- run a real product self-verification (project scan → plan → run → report) and inspect the generated HTML/JSON/JUnit,
- update `README.md` and docs with any newly discovered limitations,
- record the exact OS, Node, database and browser versions used.

## Build the archive

```powershell
npm run package
```

This builds the workspace, then stages:

| Path                                 | Contents                                                    |
| ------------------------------------ | ----------------------------------------------------------- |
| `apps/backend/dist`                  | Compiled Fastify API                                        |
| `apps/desktop/dist`                  | Built React UI served by the API                            |
| `apps/browser-extension/dist`        | Unpacked MV3 extension                                      |
| `packages/*/dist`                    | Compiled shared packages                                    |
| `apps/*/src`, `packages/*/src`       | TypeScript source                                           |
| `apps/desktop/src-tauri`             | Tauri shell source (excluding `target/` and `gen/`)         |
| `scripts/`, `prisma/`                | Setup/verification tooling, schema and migrations           |
| `README.md`, `docs/`, `.env.example` | Documentation and configuration template                    |
| `package.json`, `package-lock.json`  | Workspace metadata for `npm ci`                             |
| `PACKAGE-NOTES.txt`                  | Exact run instructions for the archive                      |
| `BUILD-MANIFEST.json`                | Included paths, platform facts and SHA-256 for staged files |

It excludes `node_modules`, `.env`, databases, `data/`, `artifacts/`, `backups/`, test results and native binaries.

Outputs:

```text
release/
  zethub-proof-0.1.0-<platform>-<arch>.zip
  zethub-proof-0.1.0-<platform>-<arch>.zip.sha256
```

Use `--skip-build` only when the current `dist/` outputs are known to match the source.

The archive extracts to a `zethub-proof/` directory. `BUILD-MANIFEST.json` hashes every staged file except itself; the
ZIP hash is in the sibling `.sha256` file. Hashes prove integrity, not authorship — the archive itself is not signed.

## Verify the archive

Windows:

```powershell
Get-FileHash .\release\zethub-proof-0.1.0-win32-x64.zip -Algorithm SHA256
Get-Content .\release\zethub-proof-0.1.0-win32-x64.zip.sha256
Expand-Archive .\release\zethub-proof-0.1.0-win32-x64.zip -DestinationPath .\release\check
```

Linux/macOS:

```bash
sha256sum -c zethub-proof-0.1.0-linux-x64.zip.sha256
unzip zethub-proof-0.1.0-linux-x64.zip
```

Compare the printed hash with the `.sha256` file. Then read `zethub-proof/BUILD-MANIFEST.json` and confirm that
`missing` is empty, `desktop.webUiIncluded` is true, and `desktop.nativeBinaryIncluded` is false. The manifest hashes
every staged file except itself, so changing any bundled source or built file will show up there.

Finally, from the extracted `zethub-proof/` directory, run `npm ci --dry-run`. This checks that the bundled
`package.json`/`package-lock.json` and workspace layout can be resolved without modifying the extracted files or
contacting a running database. It does not prove the archive runs; the steps below do.

## Run the archive

```powershell
cd release\check\zethub-proof
npm ci
Copy-Item .env.example .env
# set SESSION_SECRET (32+ characters) and database settings
npm run db:setup -- --create-user --write-env
npm run start
```

The archive contains source and built output, so `npm run build` also works, but requires the workspace dev dependencies
installed by `npm ci`. A native desktop window still requires a separate Tauri build.

## Native Tauri build

Prerequisites:

- **Windows:** Rust (MSVC toolchain), Visual Studio Build Tools with the C++ workload, WebView2 runtime.
- **Linux:** Rust, `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, build tools.
- **macOS:** Rust and Xcode command-line tools. Not verified here.

```bash
npm run tauri:build
```

Artifacts are written under `apps/desktop/src-tauri/target/release/bundle/` (installer/MSI on Windows, AppImage/deb/rpm
on Linux, app/dmg on macOS depending on targets and host tooling). Tauri's `targets: "all"` setting asks for all bundle
formats supported by the host; missing platform tooling can make individual bundles fail.

Tauri's built-in updater plugin, Windows Authenticode and Apple notarization are **not configured**. ZetHub Proof uses
its own signed update feed instead (see [updates.md](updates.md)); the native install/restart handoff has not been
executed here. Do not describe a native build as signed or production-distributable without adding and verifying those
steps.

Configuration notes:

- `frontendDist` is `../dist`, built by `npm run build`.
- The shell CSP allows only the local API on port 4000 and `ipc:` origins. If you change `API_PORT`, update the CSP.
- The API remains a separate loopback process; the shell does not embed the verification engine.

## Browser extension

```bash
npm run extension:build
```

Load `apps/browser-extension/dist` as an unpacked extension in a Chromium-based browser. The manifest requests only
`activeTab`, `storage`, `scripting` and `contextMenus`, with loopback-only host permissions. Store publication, signing,
update URLs and Firefox-specific packaging are not configured. The E2E suite checks the built manifest/bundle, not a live
extension installation.

## CI release workflow

`.github/workflows/release.yml` is triggered by a `v*` tag or manual dispatch. For each enabled runner it installs
dependencies, generates Prisma, builds, packages, verifies the `.sha256` file and uploads the ZIP, checksum and manifest.
On a tag it also attaches those files to the GitHub release using the repository token.

The matrix is intentionally limited to Ubuntu and Windows. macOS packaging is not configured. Workflow success is not
claimed until it has run in the repository; local Windows verification is the only executed packaging result so far.

## Rollback

- Keep the previous archive and its `.sha256`; releases are not overwritten in place.
- Prisma migrations are forward-only. There are no down migrations. To roll back an application version with a schema
  change, restore the database from a verified backup that predates the upgrade (with explicit confirmation), then run
  the older archive.
- Rotating `SESSION_SECRET` invalidates sessions and report signatures. Existing evidence keeps its hashes, but signature
  verification with the new secret will fail; preserve the old secret if old reports must remain verifiable.
- Do not delete `artifacts/`, `backups/` or `data/` as part of a rollback.

## Known release limitations

- No code signing, notarization, SBOM or reproducible-build guarantee.
- Automatic updates require a self-hosted HTTPS feed, a deployed public key and published artifacts; none of those are
  bundled. Native install/restart is unverified here.
- No published container image or package registry artifact.
- No Linux/macOS package result from this environment.
- The archive includes source and built files but not dependencies; `npm ci` is required.
- Native Tauri binaries, store-published extensions and mobile targets are not produced.
