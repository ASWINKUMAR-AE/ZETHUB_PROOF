#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const skipBuild = process.argv.includes('--skip-build');
const releaseDir = path.join(root, 'release');
const stageRoot = path.join(root, '.tmp', 'package');
const stageDir = path.join(stageRoot, 'zethub-proof');
const platform = process.platform;
const archiveName = `zethub-proof-${pkg.version}-${platform}-${process.arch}.zip`;
const archivePath = path.join(releaseDir, archiveName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: true, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function copyDir(source, destination, filter) {
  if (!fs.existsSync(source)) return false;
  fs.cpSync(source, destination, { recursive: true, filter });
  return true;
}

function copyFile(source, destination) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return true;
}

function hashTree(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(dir);
  files.sort();
  return files.map((file) => ({
    path: path.relative(dir, file).split(path.sep).join('/'),
    bytes: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  }));
}

try {
  if (!skipBuild) {
    run('npm', ['run', 'build']);
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });

  const included = [];
  const missing = [];
  const add = (source, destination, options = {}) => {
    const stat = fs.statSync(source, { throwIfNoEntry: false });
    const copied = stat?.isDirectory()
      ? copyDir(source, path.join(stageDir, destination), options.filter)
      : copyFile(source, path.join(stageDir, destination));
    if (copied) included.push(destination);
    else missing.push(destination);
  };

  // Built output (what `npm run start` serves).
  add(path.join(root, 'apps', 'desktop', 'dist'), 'apps/desktop/dist');
  add(path.join(root, 'apps', 'backend', 'dist'), 'apps/backend/dist');
  add(path.join(root, 'apps', 'browser-extension', 'dist'), 'apps/browser-extension/dist');
  for (const workspace of ['shared-types', 'verification-core']) {
    add(path.join(root, 'packages', workspace, 'dist'), `packages/${workspace}/dist`);
  }

  // Source and configuration, so the archive can be rebuilt or audited.
  for (const workspace of ['shared-types', 'verification-core']) {
    add(path.join(root, 'packages', workspace, 'src'), `packages/${workspace}/src`);
    add(path.join(root, 'packages', workspace, 'tsconfig.json'), `packages/${workspace}/tsconfig.json`);
    add(path.join(root, 'packages', workspace, 'package.json'), `packages/${workspace}/package.json`);
  }
  for (const app of ['backend', 'desktop', 'browser-extension']) {
    add(path.join(root, 'apps', app, 'src'), `apps/${app}/src`);
    add(path.join(root, 'apps', app, 'package.json'), `apps/${app}/package.json`);
  }
  for (const file of ['index.html', 'postcss.config.js', 'tailwind.config.js', 'tsconfig.json', 'vite.config.ts']) {
    add(path.join(root, 'apps', 'desktop', file), `apps/desktop/${file}`);
  }
  add(path.join(root, 'apps', 'backend', 'tsconfig.json'), 'apps/backend/tsconfig.json');
  add(path.join(root, 'apps', 'browser-extension', 'tsconfig.json'), 'apps/browser-extension/tsconfig.json');
  add(path.join(root, 'apps', 'browser-extension', 'build.mjs'), 'apps/browser-extension/build.mjs');
  const tauriRoot = path.join(root, 'apps', 'desktop', 'src-tauri');
  add(tauriRoot, 'apps/desktop/src-tauri', {
    filter: (source) => {
      const relative = path.relative(tauriRoot, source);
      return !/^(target|gen)([\\/]|$)/.test(relative);
    },
  });

  // Runtime, tooling and documentation.
  add(path.join(root, 'scripts'), 'scripts');
  add(path.join(root, 'prisma'), 'prisma');
  add(path.join(root, 'docs'), 'docs');
  add(path.join(root, 'README.md'), 'README.md');
  add(path.join(root, '.env.example'), '.env.example');
  add(path.join(root, 'tsconfig.base.json'), 'tsconfig.base.json');
  add(path.join(root, 'package.json'), 'package.json');
  add(path.join(root, 'package-lock.json'), 'package-lock.json');

  const cargo = spawnSync('cargo', ['--version'], { shell: true, encoding: 'utf8' });
  const rustAvailable = cargo.status === 0;

  const packageNotes = `ZetHub Proof ${pkg.version} — ${platform}/${process.arch}
Generated ${new Date().toISOString()}

This archive contains the built application, its TypeScript source, Prisma migrations,
tooling scripts and documentation. It does not contain node_modules, a database, a .env
file, verification artifacts or a native Tauri binary.

Requirements: Node.js 20.11+ and a MySQL/MariaDB server.

1. npm ci
2. Copy .env.example to .env and set SESSION_SECRET (32+ characters).
   On Windows: Copy-Item .env.example .env
   On Linux/macOS: cp .env.example .env
3. npm run db:setup -- --create-user --write-env
   Add --start-service only if a detected XAMPP MySQL instance is stopped.
4. npm run start
5. Open http://127.0.0.1:4000 and create the local owner account.

The first visit prompts for the owner account; there is no default password.
See README.md, docs/windows.md, docs/linux.md and docs/testing.md for details.

A native desktop binary requires Rust and the platform WebView toolchain:
  npm run tauri:build
No native binary is included or claimed to be tested.
`;
  fs.writeFileSync(path.join(stageDir, 'PACKAGE-NOTES.txt'), packageNotes, 'utf8');

  const manifest = {
    product: 'ZetHub Proof',
    version: pkg.version,
    createdAt: new Date().toISOString(),
    platform,
    arch: process.arch,
    node: process.version,
    archive: archiveName,
    included,
    missing,
    sourceIncluded: included.includes('apps/backend/src') && included.includes('packages/verification-core/src'),
    desktop: {
      webUiIncluded: included.includes('apps/desktop/dist'),
      tauriSourceIncluded: included.includes('apps/desktop/src-tauri'),
      nativeBinaryIncluded: false,
      rustToolchainAvailableAtPackaging: rustAvailable,
      note: 'The archive contains the desktop web UI and Rust shell source. A native Tauri binary is only produced by a separate Rust build and is not fabricated here.',
    },
    browserExtension: {
      included: included.includes('apps/browser-extension/dist'),
      note: 'Load the unpacked extension directory in a Chromium-based browser; signing/store publication is not performed.',
    },
    database: {
      migrationsIncluded: fs.existsSync(path.join(stageDir, 'prisma', 'migrations')),
      credentialsIncluded: false,
      note: 'A MariaDB/MySQL server must be configured separately; credentials are not packaged.',
    },
    hashes: hashTree(stageDir),
    hashScope:
      'SHA-256 for every staged file except BUILD-MANIFEST.json itself. The archive hash is in the sibling .sha256 file.',
  };

  fs.writeFileSync(path.join(stageDir, 'BUILD-MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');

  fs.rmSync(archivePath, { force: true });
  if (platform === 'win32') {
    run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${stageDir}' -DestinationPath '${archivePath}' -Force`,
    ]);
  } else {
    const zip = spawnSync('zip', ['-r', '-q', archivePath, 'zethub-proof'], {
      cwd: stageRoot,
      stdio: 'inherit',
    });
    if (zip.status !== 0) {
      throw new Error('zip is not available. Install zip or use a platform-specific packager.');
    }
  }

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  fs.writeFileSync(`${archivePath}.sha256`, `${sha256}  ${archiveName}\n`, 'utf8');

  console.log(`\nPackaged ${archiveName}`);
  console.log(`  archive : ${archivePath}`);
  console.log(`  bytes   : ${fs.statSync(archivePath).size}`);
  console.log(`  sha256  : ${sha256}`);
  console.log(`  included: ${included.length} path(s); missing: ${missing.length}`);
  console.log(`  native Tauri binary included: no (Rust available: ${rustAvailable ? 'yes' : 'no'})`);
  if (missing.length > 0) {
    console.log(`  missing paths: ${missing.join(', ')}`);
  }
} catch (error) {
  console.error(`\nPackaging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
