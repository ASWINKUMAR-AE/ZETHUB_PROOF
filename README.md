<div align="center">

# 🔬 ZetHub Proof

**Local-first developer verification platform — detect, plan, run, and prove.**

[![Node.js](https://img.shields.io/badge/Node.js-20.11%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Fastify](https://img.shields.io/badge/Fastify-API-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![MariaDB](https://img.shields.io/badge/MariaDB-10.4%2B-003545?logo=mariadb&logoColor=white)](https://mariadb.org)
[![License](https://img.shields.io/badge/License-UNLICENSED-red)](#license)

> ZetHub Proof detects your project's real stack, builds a dependency-aware verification plan, runs the checks on your machine, and records **signed evidence** showing what was actually verified — and what was not.

</div>

---

## 📋 Table of Contents

- [What is ZetHub Proof?](#what-is-zethub-proof)
- [Why Use ZetHub Proof?](#why-use-zethub-proof)
- [Who Uses This?](#who-uses-this)
- [What Problems Does It Solve?](#what-problems-does-it-solve)
- [How It Works — Workflow](#how-it-works--workflow)
- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Application](#running-the-application)
- [Browser Extension](#browser-extension)
- [Commands Reference](#commands-reference)
- [Example Workflow](#example-workflow)
- [Verified in This Workspace](#verified-in-this-workspace)
- [Safety & Privacy](#safety--privacy)
- [Known Limitations](#known-limitations)
- [Documentation](#documentation)
- [License](#license)

---

## What is ZetHub Proof?

**ZetHub Proof** is a **local-first, offline-capable developer verification platform** that runs entirely on your machine. It automatically:

1. **Detects** your project's technology stack (frameworks, tools, databases, APIs, Git state)
2. **Plans** a dependency-aware test suite tailored to what actually changed
3. **Executes** real checks — command runners, Playwright browser journeys, API contract tests, database integrity probes
4. **Records** cryptographically signed evidence (HTML passport, JSON, JUnit XML) proving what passed, what failed, and what was not tested

No cloud dependencies. No telemetry. Your code and results never leave your machine unless you explicitly push them.

---

## Why Use ZetHub Proof?

| Without ZetHub Proof | With ZetHub Proof |
|---|---|
| "Tests passed on my machine" — no proof | Signed evidence passport with hashes and manifest |
| Running the full test suite for a one-line change | Dependency-aware plan runs only relevant cases |
| Manually tracking what was and wasn't tested | Explicit "unverified" markers for everything skipped |
| Secrets leaking into test logs and screenshots | Automatic secret redaction from all evidence |
| Debugging failures with no context | Failure capsules — portable, reproducible failure bundles |
| "Did CI pass?" — slow feedback loop | Local execution in seconds, offline-capable |
| Trusting a CI green tick alone | Local proof + CI together = double verification |

**ZetHub Proof answers the hardest question in software verification: "How do I prove what was actually checked?"**

---

## Who Uses This?

| User | Use Case |
|---|---|
| **Solo developers** | Prove your own work — sign off a release with a verifiable evidence report |
| **Team leads / tech leads** | Require signed verification before code merges; catch coverage gaps before review |
| **QA engineers** | Capture browser scenarios from live pages via the extension; replay them in isolation |
| **Security-conscious teams** | Audit log every action; keep secrets encrypted; run behind a loopback-only API |
| **Freelancers / contractors** | Deliver a client a signed HTML passport proving what was tested and what wasn't |
| **Open-source maintainers** | Provide reproducible verification evidence alongside releases |
| **Students / learners** | Learn how professional verification pipelines work in practice |

---

## What Problems Does It Solve?

### ❌ Problem 1 — "It works on my machine"
Developers have no structured way to record and share proof of local verification. ZetHub Proof generates a signed **Evidence Passport** (HTML + JSON + JUnit + HMAC manifest) that travels alongside your code.

### ❌ Problem 2 — Running the full suite for tiny changes
Large test suites are slow. ZetHub Proof scans changed files and dependency graphs to select only the cases relevant to your change — cutting run time dramatically.

### ❌ Problem 3 — Secrets appearing in test logs
Integration credentials, tokens, and passwords routinely appear in test output and screenshots. ZetHub Proof automatically redacts secrets from all stored evidence and logs.

### ❌ Problem 4 — Failures with no reproduction context
When a test fails, reproducing it requires knowing the exact environment. ZetHub Proof creates **Failure Capsules** — portable bundles of the failure context (without secrets) that any team member can import and inspect.

### ❌ Problem 5 — Database changes without safety nets
Running write queries against a live database is dangerous. ZetHub Proof's SQL guard blocks writes unless a scenario explicitly allows them *and* the request confirms — no silent mutations.

### ❌ Problem 6 — "Green" checks that weren't actually run
Skipped, blocked, or unavailable checks are **explicitly marked** as such — never silently counted as passed. The report always states its verified scope and remaining limitations honestly.

### ❌ Problem 7 — Broken test coverage from AI-generated fixes
AI can suggest patches that look right but break subtly. The **Repair–Retest** flow validates a diff with `git apply --check` first — the tool never invents or applies a patch automatically.

---

## How It Works — Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Project Folder                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    1. DETECT STACK
                           │
           ┌───────────────▼──────────────────┐
           │  Scans manifests, lockfiles,     │
           │  source layout, installed tools,  │
           │  Docker, databases, APIs, Git     │
           └───────────────┬──────────────────┘
                           │
                    2. BUILD PLAN
                           │
           ┌───────────────▼──────────────────┐
           │  Dependency-aware case selection  │
           │  (changed files → relevant tests) │
           └───────────────┬──────────────────┘
                           │
                    3. EXECUTE CHECKS
                           │
           ┌───────────────▼──────────────────┐
           │  Commands · Browser (Playwright)  │
           │  API contracts · Database probes  │
           └───────────────┬──────────────────┘
                           │
                    4. RECORD EVIDENCE
                           │
           ┌───────────────▼──────────────────┐
           │  HTML Passport · JSON · JUnit     │
           │  HMAC-signed manifest · SHA-256   │
           └───────────────┬──────────────────┘
                           │
                    5. REVIEW & ACT
                           │
           ┌───────────────▼──────────────────┐
           │  Failure capsule export · Repair  │
           │  proposals · Quality analytics    │
           └─────────────────────────────────┘
```

---

## Features

### Core Verification
- 🔍 **Stack detection** — scans manifests, lockfiles, source layout, probes tools, detects Docker/DB/API/Git
- 📋 **Dependency-aware planning** — selects relevant test cases from changed files and dependency signals
- ▶️ **Real execution** — command, browser, API and database runners with timeouts, cancellation, captured output

### Test Types
- 🌐 **Browser checks** — Playwright journeys, locators, console/network assertions, screenshots, baseline comparison
- 🔗 **API checks** — HTTP contracts: status/header/JSON/body/timing assertions, OpenAPI schema validation
- 🗄️ **Database checks** — MySQL/MariaDB queries, schema/constraint inspection, rollback-only write probes
- ⚙️ **Command checks** — runs your own project's test and build tools through adapter adapters

### Evidence & Reporting
- 📜 **Evidence Passport** — self-contained HTML, machine-readable JSON, JUnit XML, HMAC-signed manifest
- 🔒 **SHA-256 hashes** on every artifact
- 🧩 **Failure Capsules** — export/import minimal reproducible failure context without source secrets
- 📊 **Quality auditor** — flaky-test analysis, coverage-gap signals, pass-rate trends, cross-OS comparison

### Safety
- 🛡️ **SQL guard** — blocks writes unless the scenario allows them and the request explicitly confirms
- 🔑 **Secret redaction** — integration credentials redacted from all evidence and logs
- 🔧 **Repair–Retest** — validates user/AI patches with `git apply --check`; never auto-applies

### Infrastructure
- 🔌 **Browser extension** — capture live pages as replayable test scenarios
- 🔄 **Offline queue** — queues eligible work when API is unreachable, flushes on reconnect
- 🔄 **Automatic updates** — Ed25519-signed feed, staged rollout, fail-closed, never interrupts active runs
- 🗂️ **XAMPP workflow** — non-destructive discovery, DB creation, migrations, backups with SHA-256 verification

---

## Architecture

```
zethub-proof/
├── apps/
│   ├── backend/             Fastify API, auth, routes, run orchestration (TypeScript)
│   ├── desktop/             React + Vite UI; Tauri 2 shell source
│   └── browser-extension/  MV3 capture extension (esbuild)
├── packages/
│   ├── shared-types/        Zod schemas and API types
│   └── verification-core/  Detection, planning, runners, evidence, reports, repairs
├── prisma/                  MySQL/MariaDB schema (27 models), migrations, seed
├── scripts/                 DB setup/verify/teardown, lint, format, package, icons
├── tests/                   Unit, integration, security and Playwright E2E
└── docs/                    Architecture, security, testing, platform, release guides
```

**Tech stack at a glance:**

| Layer | Technology |
|---|---|
| UI | React 19, Vite 6, TailwindCSS |
| Desktop shell | Tauri 2 (optional — Rust/MSVC required) |
| API | Fastify, TypeScript |
| Database | MySQL 8 / MariaDB 10.4+, Prisma ORM |
| Browser automation | Playwright |
| Build / bundler | esbuild (extension), Vite (UI), tsc (packages) |
| Testing | Vitest (unit/integration/security), Playwright (E2E) |
| Linting / formatting | ESLint 9, Prettier 3 |

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 20.11+ | LTS recommended |
| **npm** | bundled with Node | workspace support required |
| **MySQL or MariaDB** | 10.4+ | XAMPP (Windows), standalone, or Docker |
| **Git** | any | for change-based planning |
| **Rust + MSVC** | stable | **only** for native Tauri binary (optional) |

> **Windows users:** XAMPP is the easiest way to get MariaDB. See [docs/windows.md](docs/windows.md).  
> **Linux users:** See [docs/linux.md](docs/linux.md) for MariaDB standalone setup.

---

## Installation

### 1. Clone the repository

```powershell
git clone https://github.com/ASWINKUMAR-AE/ZETHUB_PROOF.git
cd ZETHUB_PROOF
```

### 2. Install dependencies

```powershell
npm install
```

### 3. Configure environment

```powershell
Copy-Item .env.example .env
```

Open `.env` and set at minimum:

```env
# Required: 32+ random characters
SESSION_SECRET=your_very_long_random_secret_here

# Database (adjust to your MySQL/MariaDB setup)
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=zethub_proof
DB_USER=zethub_proof_app
DB_PASSWORD=your_app_password

# Optional admin credentials used only during db:setup
DB_ADMIN_USER=root
DB_ADMIN_PASSWORD=your_root_password
```

### 4. Set up the database

```powershell
npm run db:setup -- --create-user --write-env
```

This command:
- Auto-detects XAMPP / standalone MySQL
- Creates the database and least-privilege application user (if `--create-user` is passed)
- Runs all Prisma migrations
- Verifies the schema
- Performs a self-cleaning read/write health check

> ⚠️ This command is **non-destructive** — it never drops or resets existing data.

### 5. Build the application

```powershell
npm run build
```

### 6. Start the application

```powershell
npm run start
```

Open **http://127.0.0.1:4000** in your browser.  
The first visit will prompt you to create the local owner account.

---

## Configuration

All configuration lives in `.env`. Key settings:

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | _(required)_ | 32+ char random string for session signing |
| `API_HOST` | `127.0.0.1` | API bind address (loopback only recommended) |
| `API_PORT` | `4000` | API port |
| `DB_HOST` | `127.0.0.1` | Database host |
| `DB_PORT` | `3306` | Database port |
| `DB_NAME` | `zethub_proof` | Database name |
| `MAX_PARALLEL_TESTS` | `1` | Parallel test runners (keep at 1 for most projects) |
| `ARTIFACTS_DIR` | `./artifacts` | Where evidence files are written |
| `AI_ENABLED` | `false` | Enable optional AI provider |
| `AI_API_KEY` | _(empty)_ | AI provider key (never committed) |
| `UPDATE_FEED_URL` | _(empty)_ | HTTPS feed URL for automatic updates |

See `.env.example` for the full reference with all options documented.

---

## Running the Application

### Development (hot reload)

```powershell
npm run dev
# API on http://127.0.0.1:4000
# Vite UI on http://localhost:5173
```

### Production

```powershell
npm run build
npm run start
# Serves built UI + API on http://127.0.0.1:4000
```

### Tauri desktop app (native binary — requires Rust + MSVC)

```powershell
npm run tauri:dev    # development
npm run tauri:build  # production binary
```

---

## Browser Extension

The browser extension lets you capture any live web page as a replayable test scenario.

### Setup

1. Build the extension:
   ```powershell
   npm run extension:build
   ```

2. Load it in Chrome/Edge:
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** → select `apps/browser-extension/dist`

3. Generate a device token in ZetHub Proof:
   - Open **Settings → Sessions & Tokens**
   - Click **Generate device token**
   - Copy the token

4. Configure the extension:
   - Click the extension icon
   - Enter `http://127.0.0.1:4000` as the API URL
   - Paste your device token

5. Navigate to any page → click **Capture** → assign to a project → save for review

> The extension only requests `activeTab`, `storage`, `scripting` and `contextMenus` permissions. Host permissions are restricted to loopback. It never captures passwords or file inputs, and never sends data outside your configured loopback API.

---

## Commands Reference

| Command | Purpose |
|---|---|
| `npm run dev` | API + Vite UI with hot reload |
| `npm run build` | Build all workspaces (types, core, API, UI, extension) |
| `npm run start` | Serve the production build on `127.0.0.1:4000` |
| `npm run typecheck` | Strict TypeScript check across all 5 workspaces |
| `npm run lint` | ESLint over the whole repository |
| `npm run format:check` | Prettier check (`-- --write` to auto-fix) |
| `npm test` | Unit → integration → security test suites |
| `npm run test:unit` | Unit tests only (Vitest) |
| `npm run test:integration` | Integration tests (real HTTP + MySQL) |
| `npm run test:security` | Security tests (secret scanning, path policy) |
| `npm run test:e2e` | Build + Playwright E2E against an isolated `_test` database |
| `npm run test:coverage` | Unit tests with V8 coverage report |
| `npm run verify:all` | Full suite: typecheck + lint + format + test + build + E2E |
| `npm run db:setup` | Non-destructive database discovery and setup |
| `npm run db:verify` | Standalone database verification |
| `npm run db:migrate` | Run pending Prisma migrations |
| `npm run db:status` | Show migration status |
| `npm run db:teardown-test` | Guarded removal of the disposable test database |
| `npm run extension:build` | Bundle the MV3 extension into `apps/browser-extension/dist` |
| `npm run package` | Build + create a hashed release archive |
| `npm run update:keys` | Generate an Ed25519 update signing key pair |
| `npm run update:release` | Sign, publish, pause, resume or validate releases |
| `npm run update:server` | Serve the signed update feed on `127.0.0.1:4010` |

---

## Example Workflow

Here's a complete end-to-end example verifying a typical JavaScript project:

### Step 1 — Register your project

1. Open `http://127.0.0.1:4000` and log in
2. Click **+ New Project**
3. Enter your project path (e.g. `C:\Users\dev\my-app`) and name it
4. Click **Scan** — ZetHub Proof detects the stack automatically

### Step 2 — Review the detection report

The scanner reports:
```
✔ Node.js detected (v20.x)
✔ TypeScript 5.x detected
✔ React 18 detected (Vite build)
✔ Vitest detected
✔ ESLint detected
✔ Git repository — 3 changed files since last run
```

### Step 3 — Build a verification plan

Click **Plan** → choose **Changed files** strategy.

ZetHub Proof selects:
- `js:typecheck` — TypeScript strict check
- `js:lint` — ESLint
- `js:test` — Vitest unit suite
- `js:build` — production build

It skips unrelated cases (database, browser) because none were detected.

### Step 4 — Run the plan

Click **Run** → approve the selected cases → click **Start**.

Watch live output stream as each case executes:
```
[12:03:01] js:typecheck   ✔ PASSED   (4.2s)
[12:03:05] js:lint        ✔ PASSED   (1.8s)
[12:03:07] js:test        ✔ PASSED   32/32 (9.1s)
[12:03:16] js:build       ✔ PASSED   (8.4s)

Run complete — 4/4 passed in 23.5s
```

### Step 5 — Export the Evidence Passport

Click **Generate Report** → download:
- `passport.html` — self-contained, shareable proof
- `report.json` — machine-readable evidence
- `report.xml` — JUnit XML for CI consumers
- `manifest.json` — HMAC-signed hash of every artifact

Share `passport.html` with your client, reviewer, or CI system. The hashes prove the report hasn't been tampered with.

### Step 6 — Investigate a failure (if any)

If a test fails:
1. Click the failed case → view captured stdout/stderr
2. Click **Export Capsule** — creates a portable failure bundle (secrets redacted)
3. Share the capsule with a team member or AI tool
4. If a fix is proposed, paste the diff into **Repair → Validate** — ZetHub Proof runs `git apply --check` without touching your repo

---

## Verified in This Workspace

Last verified on **2026-10-28** · Windows · Node **v24.12.0** · MariaDB **10.4.32** (XAMPP) · Chromium (Playwright)

| Area | Result |
|---|---|
| TypeScript strict typecheck (5 workspaces) | ✅ Passed |
| ESLint (116 files) | ✅ 0 errors, 0 warnings |
| Prettier check | ✅ Passed |
| Unit tests | ✅ 74 passed |
| Integration tests (real HTTP + MySQL) | ✅ 23 passed |
| Security tests (secret scanning, path policy) | ✅ 12 passed |
| Playwright E2E (isolated `_test` database) | ✅ 10 passed |
| Production build (API, UI, extension) | ✅ Passed |
| Live database setup/health/backup/restore | ✅ Passed against MariaDB 10.4.32 |
| Product self-verification of this repository | ✅ 8/8 cases passed |
| Evidence Passport (HTML/JSON/JUnit + manifest) | ✅ Generated; hashes matched |
| Dependency audit (`npm audit`) | ⚠️ 9 advisories (dev tools + react-router/zod) |
| Desktop package archive | ✅ Passed (`manifest: 0 missing`) |
| Native Tauri binary | ❌ Not built — no Rust/MSVC in this environment |
| Linux/macOS execution | ❌ Not executed — CI config only |

> **Note on audit advisories:** These are findings in dev tools (Prisma, Vitest/tinypool) and production deps (react-router, zod). Required fixes are major version upgrades not yet applied. The self-verification run excluded `js:audit` for this reason. See [Security](docs/security.md#dependency-advisories).

---

## Safety & Privacy

- **Loopback only** — API binds to `127.0.0.1`/`localhost` exclusively
- **scrypt** password hashing, database-backed sessions, HTTP-only cookies, CSRF protection
- **Device tokens** shown once; only the hash is stored
- **Credentials encrypted at rest**; secrets redacted from all evidence and logs
- **SQL guard** blocks writes unless the scenario explicitly allows them *and* the request confirms
- **Restore/reset** operations require explicit confirmation — no destructive "reset" button
- **No telemetry** — nothing leaves your machine
- **AI is optional**, disabled by default, requires explicit consent and opt-in per project

See [Security](docs/security.md) for the full threat model and known gaps.

---

## Known Limitations

- **Native Tauri binary** requires Rust + MSVC toolchain (not included); the app runs fine as a web UI
- **Linux/macOS** packaging and cross-OS verification not executed in this environment (CI configured)
- **Database adapter**: MySQL/MariaDB only — PostgreSQL documented as unimplemented
- **Mutation testing** and **remote multi-device sync** reported as unavailable
- **Mobile Tauri targets** not configured or tested
- **Release archives** not code-signed or notarized
- **Automatic updates** require a self-hosted signed feed and deployed public key

---

## Documentation

| Document | Description |
|---|---|
| [Architecture](docs/architecture.md) | System design, component boundaries, data flow |
| [Security](docs/security.md) | Threat model, auth design, known gaps, audit advisories |
| [Testing](docs/testing.md) | Exact test commands, boundaries, what each suite covers |
| [Windows guide](docs/windows.md) | XAMPP setup, DB workflow, Windows-specific notes |
| [Linux guide](docs/linux.md) | MariaDB standalone, permissions, service management |
| [Release & packaging](docs/release.md) | Build, package, archive, signing workflow |
| [Automatic updates](docs/updates.md) | Ed25519 signing keys, staged rollout, self-hosted feed |

---

## License

**UNLICENSED** — private project. All rights reserved. See `package.json`.
