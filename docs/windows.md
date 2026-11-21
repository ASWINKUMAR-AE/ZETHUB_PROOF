# Windows guide

This guide covers a local Windows install with XAMPP (MariaDB/MySQL) or a standalone MySQL-compatible server. The
workspace was verified on Windows with Node **24.12.0** and XAMPP MariaDB **10.4.32**.

## Prerequisites

| Requirement            | Notes                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Windows 10/11 x64      | PowerShell 5 is sufficient.                                                                |
| Node.js 20.11+         | `node --version`; npm is included.                                                         |
| XAMPP or MySQL/MariaDB | XAMPP is auto-detected; a standalone server works if it is reachable on `DB_HOST:DB_PORT`. |
| Chromium for E2E       | `npx playwright install chromium`. Only needed for browser verification and tests.         |
| Rust + MSVC            | Optional. Required only for a native Tauri binary; the web UI and API do not need it.      |

The API and UI bind to loopback only. Do not expose port 4000, MySQL or Apache to the network.

## Install

```powershell
npm install
Copy-Item .env.example .env
```

Set a session secret in `.env`. It must be at least 32 characters:

```powershell
node -e "const fs=require('fs');const f='.env';let s=fs.readFileSync(f,'utf8');s=s.replace(/^SESSION_SECRET=.*$/m,'SESSION_SECRET='+require('crypto').randomBytes(48).toString('base64url'));fs.writeFileSync(f,s)"
```

If you skip this step, `npm run db:setup -- --write-env` generates one for you when it is missing.

Start MySQL from the XAMPP Control Panel (or let setup start it, see below), then bootstrap the database:

```powershell
npm run db:setup -- --create-user --write-env
```

`--start-service` can start a stopped XAMPP MySQL instance without opening the control panel:

```powershell
npm run db:setup -- --create-user --write-env --start-service
```

Setup is idempotent. It:

1. detects XAMPP and reports the server type/version,
2. checks TCP reachability,
3. connects with the administrative account (defaults to `root`, empty password),
4. creates `DB_NAME` only if it does not exist, with `utf8mb4`/`utf8mb4_unicode_ci`,
5. creates the application account only when `--create-user` is passed,
6. grants schema-scoped privileges on that database,
7. updates `.env` only when `--write-env` is passed,
8. applies committed Prisma migrations with `migrate deploy`,
9. verifies all required tables and foreign keys,
10. performs a self-cleaning read/write health check.

It never drops, truncates or resets an existing database. If it cannot authenticate as the administrative user, it prints
the exact SQL to run in phpMyAdmin and exits without changing data.

### XAMPP discovery

Discovery checks `XAMPP_HOME` first, then common locations (`<drive>:\xampp`, `<drive>:\xampp_new`,
`<drive>:\tools\xampp`, Program Files) and root-level directories whose names contain "xampp". If your install is
elsewhere, set:

```dotenv
XAMPP_HOME=D:\path\to\xampp
```

The port is read from `mysql\bin\my.ini`/`properties.ini` when available. `--start-service` runs `mysqld` directly with
the configured data directory and writes a log to `mysql\data\zethub-start.log`. It does not stop, restart or reconfigure
an existing server.

## Run

Production-style local run:

```powershell
npm run build
npm run start
```

Open <http://127.0.0.1:4000>. The first visit asks you to create the local owner account. The built UI is served by the
API, so a separate web server is not required.

Development with hot reload:

```powershell
npm run dev
```

This starts the API on `http://127.0.0.1:4000` and Vite on `http://127.0.0.1:5173`. If you change `API_PORT` or the Vite
port, keep `ALLOWED_ORIGINS` in sync or the browser requests will be rejected by CORS.

## Database operations

- **Verify** — `npm run db:verify` prints JSON for connection, schema, migrations and a temporary-table read/write probe.
  The Database page runs the same checks through the API.
- **Migrations** — normal upgrades use `npm run db:deploy` (`migrate deploy`). Do not use `migrate reset`; it destroys
  data and is not part of any script.
- **Backups** — create one from the Database page (or the backup API). Files are written under `backups/` and are verified
  with SHA-256. Backups are not encrypted by the application; protect the folder.
- **Restore** — requires an existing verified backup and explicit confirmation. It replaces data in the target database;
  read the confirmation dialog and confirm the target before proceeding.
- **Queries** — the dashboard blocks write statements unless the scenario allows writes and the run request confirms
  them. Writes without both approvals are reported as blocked, not passed.
- **Test database** — `npm run db:teardown-test` removes only a database whose name ends in `_test`; it refuses anything
  else. The application database has no automated drop command.

### Manual phpMyAdmin fallback

If administrative credentials are unavailable, run the SQL printed by setup in phpMyAdmin's SQL tab, then set
`DB_PASSWORD` in `.env` and run:

```powershell
npm run db:migrate
```

For an upgrade, use `npm run db:deploy` instead. `db:migrate` is for development migration creation/deployment and may
prompt.

## Tests on Windows

```powershell
npm run db:setup -- --database zethub_proof_test --create-user
npx playwright install chromium
npm run verify:all
```

The test database must end in `_test`. Integration/E2E tests delete only test users and never touch the application
database. See [Testing](testing.md) for details.

## Windows-specific notes

- Commands in this guide use PowerShell. PowerShell 5 does not support `&&`; run commands one per line.
- npm scripts that need to build shared packages do so automatically (`predev:api`, `pretypecheck`, `predb:*`).
- Windows `.cmd` shims are resolved through a Node CLI mapping by the command runner; do not wrap project commands in
  `cmd /c` yourself.
- Long project paths can still hit Windows path limits in third-party tools. Keep the workspace near the drive root.
- If port 4000 or 3306 is occupied, `netstat -ano | findstr :4000` shows the owning PID.
- Windows Defender or corporate policy can block spawned test executables or local ports. Allow the workspace and
  loopback ports if commands fail with `EPERM`/`EACCES`.

## Automatic updates on Windows

Update checks are disabled until a public key is deployed. To enable them, copy the public key to the client and set:

```dotenv
UPDATE_SIGNING_PUBLIC_KEY_PATH=./secrets/update-signing-public.pem
```

Optional: point the client at a self-hosted feed with `UPDATE_FEED_URL=https://...`. Keep private signing keys off the
client machine. `UPDATE_INSTALL_MODE=manual` (default) stages a verified package and hands it to you; only
`windows-installer` launches it, and only after explicit consent. Installation is refused while a verification run is
active. Signing, publishing and feed deployment are described in [Automatic updates](updates.md).

If a rebuild changes the UI asset hashes, restart the API before loading the app; static assets are registered at
startup.

## Troubleshooting

| Symptom                                         | Action                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED 127.0.0.1:3306`                   | Start MySQL in XAMPP or pass `--start-service`; confirm `DB_PORT`.                                    |
| `Access denied for user 'root'`                 | Set `DB_ADMIN_USER`/`DB_ADMIN_PASSWORD` or use the phpMyAdmin fallback.                               |
| `Unknown database`                              | Run `npm run db:setup` (or create it and run `npm run db:deploy`).                                    |
| `SESSION_SECRET must be at least 32 characters` | Generate a secret as shown above; restart the API.                                                    |
| `DB_PASSWORD is empty`                          | Re-run setup with `--create-user --write-env`, or set the password of an existing account.            |
| UI loads but API calls fail                     | Check `ALLOWED_ORIGINS`, the API port and that you opened the same host (`127.0.0.1` vs `localhost`). |
| Playwright browser missing                      | `npx playwright install chromium`.                                                                    |
| XAMPP starts but setup cannot connect           | Check the port in `mysql\bin\my.ini`; XAMPP may use 3307.                                             |
| Setup reports a missing required table          | Migrations did not apply; run `npm run db:deploy` and inspect the Prisma error.                       |

## Uninstall

Stop the API and the XAMPP service. Remove the workspace folder if you no longer need it. Databases, backups, artifacts
and `data/` live outside version control; delete them deliberately, not as part of an upgrade. The application provides no
"reset everything" button.
