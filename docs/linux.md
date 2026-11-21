# Linux guide

ZetHub Proof is a Node.js application and runs on Linux. This guide uses a native MariaDB/MySQL server because that is
the least surprising setup for a local service. XAMPP for Linux (`/opt/lampp`) is also detectable, but starting it
normally requires root, so the application's `--start-service` option is less useful there.

> **Verification status:** the Linux workflow in this document has **not been executed in this environment**. The
> repository includes a Linux CI job, but no Linux run result is claimed until that job has actually completed on the
> hosting platform. Commands below are the intended, conventional steps.

## Prerequisites

- A 64-bit Linux distribution with systemd (Ubuntu/Debian, Fedora, Arch and similar).
- Node.js 20.11+ and npm.
- MariaDB 10.4+ or MySQL 8.x.
- Chromium and its system libraries for E2E/browser checks.
- Rust toolchain only if you want a native Tauri build.

Run the application as your normal user. Do not run the API, Node or Playwright as root.

## Install a database

### Ubuntu / Debian (MariaDB)

```bash
sudo apt update
sudo apt install -y mariadb-server
sudo systemctl enable --now mariadb
```

### Fedora / RHEL family

```bash
sudo dnf install -y mariadb-server
sudo systemctl enable --now mariadb
```

### Arch

```bash
sudo pacman -S --needed mariadb
sudo systemctl enable --now mariadb
sudo mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql
```

Verify the server is listening on loopback:

```bash
ss -ltnp | grep 3306
```

## Create the database and least-privilege account

Using the administrative socket account:

```bash
sudo mariadb
```

```sql
CREATE DATABASE IF NOT EXISTS zethub_proof
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'zethub_proof_app'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-password';
CREATE USER IF NOT EXISTS 'zethub_proof_app'@'localhost' IDENTIFIED BY 'replace-with-a-strong-password';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE TEMPORARY TABLES
  ON zethub_proof.* TO 'zethub_proof_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE TEMPORARY TABLES
  ON zethub_proof.* TO 'zethub_proof_app'@'localhost';

FLUSH PRIVILEGES;
```

The account is schema-scoped. Do not grant global privileges.

## Configure the application

```bash
npm install
cp .env.example .env
chmod 600 .env
node -e "const fs=require('fs');const f='.env';let s=fs.readFileSync(f,'utf8');s=s.replace(/^SESSION_SECRET=.*$/m,'SESSION_SECRET='+require('crypto').randomBytes(48).toString('base64url'));fs.writeFileSync(f,s)"
```

Set at least:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=zethub_proof
DB_USER=zethub_proof_app
DB_PASSWORD=replace-with-the-same-strong-password
SESSION_SECRET=<generated above>
```

Then apply migrations and verify. Because the account was created manually, do not pass `--create-user`:

```bash
npm run db:setup
```

`db:setup` detects XAMPP if present, checks connectivity with the application account path, deploys migrations, verifies
the schema and performs a self-cleaning read/write health check. It does **not** need root when the account and database
already exist.

If `DB_ADMIN_USER=root` cannot authenticate over TCP (common with `unix_socket` authentication), either leave the
administrative fields empty and rely on the manual SQL above, or configure a dedicated administrative account. Setup
prints phpMyAdmin-style SQL as a fallback; on a native server, run the equivalent in `sudo mariadb`.

### Using a container instead

A loopback-bound container is acceptable:

```bash
docker run --name zethub-mariadb \
  -e MARIADB_ROOT_PASSWORD='replace-me' \
  -p 127.0.0.1:3306:3306 \
  -v zethub-mariadb:/var/lib/mysql \
  -d mariadb:11
```

Then create the application database/user as above. Do not publish the port on `0.0.0.0`.

### XAMPP on Linux

XAMPP is detected at `/opt/lampp`, `/opt/xampp`, `~/xampp` and `/usr/local/xampp`. If MySQL is already running, setup can
use it. Otherwise start it explicitly:

```bash
sudo /opt/lampp/lampp startmysql
```

Set `XAMPP_HOME=/opt/lampp` if detection fails. The app's `--start-service` spawns `mysqld` as the current user; that
usually fails for a root-owned XAMPP data directory, so prefer the command above.

## Run

```bash
npm run build
npm run start
```

Open <http://127.0.0.1:4000>. For development:

```bash
npm run dev
```

The API refuses non-loopback binds. If you need a different port, update `API_PORT` and `ALLOWED_ORIGINS` together.

## Tests on Linux

```bash
sudo npx playwright install-deps chromium   # once, if system libraries are missing
npx playwright install chromium
npm run db:setup -- --database zethub_proof_test --create-user
npm run verify:all
```

The test database must end in `_test`. The harness refuses to delete users in any other database. If the application
account cannot create the test database, create it and grant the same schema-scoped privileges manually, then run
`npm run db:setup -- --database zethub_proof_test` without `--create-user`.

On headless servers, Playwright runs headless by default. Do not run E2E as root; Chromium's sandbox may refuse to start.

## Native Tauri build (optional, unverified)

Install Rust and the WebKitGTK development packages. For Ubuntu/Debian:

```bash
sudo apt install -y build-essential curl wget file libssl-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Then:

```bash
npm run tauri:build
```

This produces platform-specific bundles under `apps/desktop/src-tauri/target/`. The repository's `npm run package` does
**not** include a native binary; it packages the web UI, API, migrations and metadata. No Linux Tauri build has been run
or verified here.

## Security and permissions

- Keep `.env` at mode `600`; it contains the session secret and database password.
- The application writes to `artifacts/`, `data/` and `backups/`. Restrict access if the workspace is shared.
- Use a firewall that does not expose 3306 or 4000 beyond loopback.
- Back up the database and `backups/` before upgrades. Restore requires explicit confirmation in the UI/API.
- `/etc/mysql` configuration and service management are outside the application; setup never stops or reconfigures the
  server.

## Automatic updates on Linux

Updates use the same signed feed as Windows. Deploy only the public key:

```dotenv
UPDATE_SIGNING_PUBLIC_KEY_PATH=./secrets/update-signing-public.pem
UPDATE_FEED_URL=https://updates.example/zethub-proof
```

`UPDATE_INSTALL_MODE=manual` is the default and hands the verified package to the user; no package manager or elevation
is invoked. Checks and downloads do not interrupt active runs, and installation is refused while a run is active.
Publishing, signing keys and the feed server are documented in [Automatic updates](updates.md). Linux update artifacts
(`appimage`, `deb`, `rpm`) can be published, but no Linux install has been executed in this environment.

## Troubleshooting

| Symptom                                         | Action                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED 127.0.0.1:3306`                   | `sudo systemctl status mariadb`; start it and check `DB_PORT`.                                                    |
| `Access denied for user ...`                    | Confirm the user/host pair (`127.0.0.1` vs `localhost`) and password.                                             |
| `Can't connect ... socket`                      | Use TCP (`DB_HOST=127.0.0.1`), not a socket path, or use the manual SQL route.                                    |
| `SESSION_SECRET must be at least 32 characters` | Generate it as shown and restart.                                                                                 |
| Playwright: missing `lib...so`                  | `sudo npx playwright install-deps chromium`.                                                                      |
| Chromium sandbox error in a container           | Run as a non-root user and pass the container the required sandbox settings; do not disable the sandbox globally. |
| `EACCES` on the project path                    | Ensure your user owns the workspace and the app has read access.                                                  |
| Port 4000 already in use                        | `ss -ltnp \| grep 4000`, stop the conflicting process or change `API_PORT`.                                       |

## Uninstall

Stop the API. Drop the database and user only after taking a backup and confirming the target. Remove the workspace
folder if it is no longer needed. `npm run db:teardown-test` removes only a database whose name ends in `_test`; there is
no automated command to drop the application database.
