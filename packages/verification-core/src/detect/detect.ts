import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DetectionResult, DetectedSubproject, DetectedTool, Ecosystem, TestKind } from '@zethub/shared-types';
import { normalizeUserPath, toPosix, validateProjectPath } from '../utils/paths.js';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
  'artifacts',
  'tmp',
  'temp',
]);

const MAX_FILES = 12_000;

export interface DetectOptions {
  probeTools?: boolean;
  maxDepth?: number;
  /** Pre-resolved runtime paths, used by tests to stay hermetic. */
  executableProbe?: (name: string) => string | null;
}

interface ScanFile {
  rel: string;
  name: string;
  ext: string;
}

function scanFiles(root: string, maxDepth: number): ScanFile[] {
  const files: ScanFile[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || files.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        const rel = toPosix(path.relative(root, abs));
        files.push({ rel, name: entry.name, ext: path.extname(entry.name).toLowerCase() });
      }
    }
  };
  walk(root, 0);
  return files;
}

function readJson(abs: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readText(abs: string, limit = 200_000): string {
  try {
    const stat = fs.statSync(abs);
    if (stat.size > limit) return fs.readFileSync(abs, 'utf8').slice(0, limit);
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function depsOf(pkg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const value = pkg[key];
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = String(v);
    }
  }
  return out;
}

export function resolveExecutable(name: string): string | null {
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = isWin ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
  }
  void exts;
  return null;
}

function probeVersion(executable: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(executable, args, {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
      shell: false,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    if (!text) return undefined;
    const match = text.match(/\d+\.\d+(?:\.\d+)?/);
    return match ? match[0] : text.split(/\r?\n/)[0]?.slice(0, 60);
  } catch {
    return undefined;
  }
}

function tool(
  id: string,
  name: string,
  kind: TestKind,
  available: boolean,
  extra: Partial<DetectedTool> = {},
): DetectedTool {
  return { id, name, kind, available, ...extra };
}

/**
 * Find a Python interpreter that actually runs. The Windows Store alias on PATH
 * reports a configuration error instead of a version, so candidates are probed.
 */
export function findPython(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [resolveExecutable('py'), resolveExecutable('python3'), resolveExecutable('python')]
      : [resolveExecutable('python3'), resolveExecutable('python')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const result = spawnSync(candidate, ['--version'], {
      timeout: 5000,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (/Python\s+\d+\.\d+/i.test(text)) return candidate;
  }
  return null;
}

function detectRuntime(probe: boolean): DetectionResult['runtime'] {
  if (!probe) return { node: process.version.replace(/^v/, '') };
  const runtime: DetectionResult['runtime'] = { node: process.version.replace(/^v/, '') };
  const python = findPython();
  if (python) runtime.python = probeVersion(python, ['--version']);
  const rust = resolveExecutable('cargo');
  if (rust) runtime.rust = probeVersion(rust, ['--version']);
  const go = resolveExecutable('go');
  if (go) runtime.go = probeVersion(go, ['version']);
  const dotnet = resolveExecutable('dotnet');
  if (dotnet) runtime.dotnet = probeVersion(dotnet, ['--version']);
  const java = resolveExecutable('java');
  if (java) runtime.java = probeVersion(java, ['-version']);
  const php = resolveExecutable('php');
  if (php) runtime.php = probeVersion(php, ['--version']);
  return runtime;
}

interface PackageJsonShape {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: unknown;
}

function parsePackage(abs: string): PackageJsonShape | null {
  const json = readJson(abs);
  if (!json) return null;
  const out: PackageJsonShape = {};
  if (typeof json.name === 'string') out.name = json.name;
  if (json.scripts && typeof json.scripts === 'object') out.scripts = json.scripts as Record<string, string>;
  if (json.workspaces) out.workspaces = json.workspaces;
  return out;
}

function detectGit(root: string): DetectionResult['git'] {
  if (!fs.existsSync(path.join(root, '.git'))) return { isRepo: false };
  const git = resolveExecutable('git');
  if (!git) return { isRepo: true };
  const run = (args: string[]) =>
    spawnSync(git, args, {
      cwd: root,
      timeout: 5000,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    }).stdout?.trim();
  const commit = run(['rev-parse', '--short=12', 'HEAD']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(['status', '--porcelain', '--untracked-files=no']);
  return {
    isRepo: true,
    branch: branch || undefined,
    commit: commit || undefined,
    dirty: status ? status.split('\n').length > 0 : false,
  };
}

function detectTools(root: string, files: ScanFile[], ecosystems: Ecosystem[], probe: boolean): DetectedTool[] {
  const tools: DetectedTool[] = [];
  const pkgPath = path.join(root, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;
  const pkgDeps = pkg ? depsOf(pkg) : {};
  const scripts = (pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, string>;
  const has = (name: string) => Boolean(pkgDeps[name]);
  const npm = probe ? resolveExecutable('npm') : 'npm';
  const npx = probe ? resolveExecutable('npx') : 'npx';

  if (pkg) {
    const isTs = fs.existsSync(path.join(root, 'tsconfig.json')) || pkgDeps['typescript'];
    if (scripts.test) {
      tools.push(
        tool('node-npm-test', 'npm test', 'unit', Boolean(npm), {
          executable: npm ?? undefined,
          version: probe ? probeVersion(npm ?? 'npm', ['--version']) : undefined,
          configFile: 'package.json',
        }),
      );
    }
    if (has('vitest')) {
      tools.push(
        tool('node-vitest', 'Vitest', 'unit', Boolean(npx), {
          executable: npx ?? undefined,
          configFile: files.find((f) => /vitest\.config\./.test(f.name))?.rel,
        }),
      );
    }
    if (has('jest')) {
      tools.push(
        tool('node-jest', 'Jest', 'unit', Boolean(npx), {
          executable: npx ?? undefined,
          configFile: files.find((f) => /jest\.config\./.test(f.name))?.rel,
        }),
      );
    }
    if (has('@playwright/test')) {
      tools.push(
        tool('node-playwright', 'Playwright Test', 'browser', Boolean(npx), {
          executable: npx ?? undefined,
          configFile: files.find((f) => /playwright\.config\./.test(f.name))?.rel,
        }),
      );
    }
    if (scripts.build) {
      tools.push(tool('node-build', 'npm run build', 'build', Boolean(npm), { executable: npm ?? undefined }));
    }
    if (scripts.lint) {
      tools.push(tool('node-lint', 'npm run lint', 'lint', Boolean(npm), { executable: npm ?? undefined }));
    }
    if (isTs) {
      const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
      tools.push(
        tool('node-tsc', 'TypeScript compiler', 'typecheck', fs.existsSync(tsc) || Boolean(npx), {
          executable: fs.existsSync(tsc) ? tsc : (npx ?? undefined),
          reason: fs.existsSync(tsc)
            ? undefined
            : 'TypeScript is declared but not installed locally; npx may download it',
        }),
      );
    }
    if (has('prettier')) {
      tools.push(tool('node-prettier', 'Prettier', 'format', Boolean(npx), { executable: npx ?? undefined }));
    }
    if (has('eslint')) {
      tools.push(tool('node-eslint', 'ESLint', 'lint', Boolean(npx), { executable: npx ?? undefined }));
    }
    if (has('@playwright/test') || has('playwright')) {
      tools.push(tool('node-audit', 'npm audit', 'dependency-audit', Boolean(npm), { executable: npm ?? undefined }));
    }
  }

  const hasPython = ecosystems.some((e) => e.language === 'Python');
  if (hasPython) {
    const python = probe ? findPython() : 'python';
    const pytestConfig =
      files.some((f) => /^(pytest\.ini|tox\.ini)$/.test(f.name)) || files.some((f) => f.name === 'pyproject.toml');
    tools.push(
      tool('python-pytest', 'pytest', 'unit', Boolean(python) && pytestConfig, {
        executable: python ?? undefined,
        version: probe && python ? probeVersion(python, ['--version']) : undefined,
        reason: !python
          ? 'No functional Python interpreter was found on PATH'
          : pytestConfig
            ? undefined
            : 'No pytest configuration found',
      }),
    );
    tools.push(
      tool('python-compile', 'Python bytecode compile', 'static-analysis', Boolean(python), {
        executable: python ?? undefined,
      }),
    );
  }

  if (ecosystems.some((e) => e.language === 'Rust')) {
    const cargo = probe ? resolveExecutable('cargo') : 'cargo';
    tools.push(tool('rust-cargo-test', 'cargo test', 'unit', Boolean(cargo), { executable: cargo ?? undefined }));
    tools.push(tool('rust-cargo-build', 'cargo build', 'build', Boolean(cargo), { executable: cargo ?? undefined }));
  }

  if (ecosystems.some((e) => e.language === 'Go')) {
    const go = probe ? resolveExecutable('go') : 'go';
    tools.push(tool('go-test', 'go test', 'unit', Boolean(go), { executable: go ?? undefined }));
    tools.push(tool('go-build', 'go build', 'build', Boolean(go), { executable: go ?? undefined }));
  }

  if (ecosystems.some((e) => e.language === 'C#' || e.language === '.NET')) {
    const dotnet = probe ? resolveExecutable('dotnet') : 'dotnet';
    tools.push(tool('dotnet-test', 'dotnet test', 'unit', Boolean(dotnet), { executable: dotnet ?? undefined }));
    tools.push(tool('dotnet-build', 'dotnet build', 'build', Boolean(dotnet), { executable: dotnet ?? undefined }));
  }

  if (ecosystems.some((e) => e.language === 'Java' || e.language === 'Kotlin')) {
    const hasMaven = files.some((f) => f.name === 'pom.xml');
    const mvn = probe ? resolveExecutable('mvn') : 'mvn';
    const gradleWrapper = files.find((f) => f.name === (process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'));
    tools.push(
      tool(
        'java-test',
        hasMaven ? 'mvn test' : 'Gradle test',
        'unit',
        hasMaven ? Boolean(mvn) : Boolean(gradleWrapper) || Boolean(probe ? resolveExecutable('gradle') : 'gradle'),
        {
          executable: hasMaven ? (mvn ?? undefined) : (gradleWrapper?.rel ?? 'gradle'),
        },
      ),
    );
  }

  if (ecosystems.some((e) => e.language === 'PHP')) {
    const php = probe ? resolveExecutable('php') : 'php';
    const phpunit =
      files.some((f) => /phpunit\.xml(\.dist)?$/.test(f.name)) ||
      fs.existsSync(path.join(root, 'vendor', 'bin', 'phpunit'));
    tools.push(
      tool('php-phpunit', 'PHPUnit', 'unit', Boolean(php) && phpunit, {
        executable: php ?? undefined,
        reason: phpunit ? undefined : 'No phpunit.xml or vendor/bin/phpunit detected',
      }),
    );
  }

  return tools;
}

export function detectProject(inputPath: string, options: DetectOptions = {}): DetectionResult {
  const root = validateProjectPath(normalizeUserPath(inputPath));
  if (!fs.existsSync(root)) throw new Error(`Project path does not exist: ${root}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Project path is not a directory: ${root}`);

  const probe = options.probeTools ?? true;
  const files = scanFiles(root, options.maxDepth ?? 4);
  const fileNames = new Set(files.map((f) => f.name));
  const rels = files.map((f) => f.rel);
  const ecosystems: Ecosystem[] = [];
  const manifests: string[] = [];
  const lockfiles: string[] = [];
  const testTools: string[] = [];
  const buildTools: string[] = [];
  const warnings: string[] = [];
  const unsupported: string[] = [];
  const packageManagers = new Set<string>();

  const addEcosystem = (eco: Ecosystem) => {
    if (!ecosystems.some((e) => e.language === eco.language && e.framework === eco.framework)) ecosystems.push(eco);
  };

  /* ---------------- JavaScript / TypeScript ---------------- */
  const pkgFiles = files.filter((f) => f.name === 'package.json');
  const rootPkgPath = path.join(root, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    const pkg = readJson(rootPkgPath) ?? {};
    const pkgDeps = depsOf(pkg);
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, string>;
    manifests.push('package.json');
    if (fileNames.has('tsconfig.json')) manifests.push('tsconfig.json');
    for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']) {
      if (fileNames.has(lock)) {
        lockfiles.push(lock);
        packageManagers.add(
          lock === 'package-lock.json'
            ? 'npm'
            : lock === 'pnpm-lock.yaml'
              ? 'pnpm'
              : lock === 'yarn.lock'
                ? 'yarn'
                : 'bun',
        );
      }
    }
    if (packageManagers.size === 0) packageManagers.add('npm');
    const isTs =
      fileNames.has('tsconfig.json') ||
      Boolean(pkgDeps['typescript']) ||
      files.some((f) => f.ext === '.ts' || f.ext === '.tsx');
    const frameworks: string[] = [];
    if (pkgDeps['next']) frameworks.push('Next.js');
    if (pkgDeps['react'] || pkgDeps['react-dom']) frameworks.push(pkgDeps['react-native'] ? 'React Native' : 'React');
    if (pkgDeps['vue']) frameworks.push('Vue');
    if (pkgDeps['@angular/core']) frameworks.push('Angular');
    if (pkgDeps['svelte'] || pkgDeps['@sveltejs/kit']) frameworks.push('Svelte');
    if (pkgDeps['express'] || pkgDeps['fastify'] || pkgDeps['koa'] || pkgDeps['@nestjs/core']) {
      frameworks.push(
        pkgDeps['@nestjs/core'] ? 'NestJS' : pkgDeps['fastify'] ? 'Fastify' : pkgDeps['express'] ? 'Express' : 'Koa',
      );
    }
    if (frameworks.length === 0) frameworks.push(isTs ? 'TypeScript library / web' : 'Node.js');
    for (const fw of frameworks) {
      addEcosystem({
        language: isTs ? 'TypeScript' : 'JavaScript',
        framework: fw,
        confidence: 'high',
        evidence: ['package.json'],
      });
    }
    for (const [dep, label] of [
      ['vitest', 'Vitest'],
      ['jest', 'Jest'],
      ['mocha', 'Mocha'],
      ['@playwright/test', 'Playwright Test'],
      ['cypress', 'Cypress'],
      ['eslint', 'ESLint'],
      ['prettier', 'Prettier'],
    ] as const) {
      if (pkgDeps[dep]) testTools.push(label);
    }
    for (const name of Object.keys(scripts)) {
      if (/^(build|compile|bundle)/.test(name)) buildTools.push(`npm run ${name}`);
      if (/^(test|test:|lint|typecheck|check)/.test(name) && !testTools.includes(`npm run ${name}`))
        testTools.push(`npm run ${name}`);
    }
    if (pkg.workspaces) {
      // detected as monorepo below
    }
  } else if (pkgFiles.length > 0) {
    warnings.push(
      'Found nested package.json files but no root package.json; treating the repository as a mixed/monorepo project.',
    );
  }

  /* ---------------- Python ---------------- */
  const pythonManifests = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'environment.yml'].filter((f) =>
    fileNames.has(f),
  );
  if (pythonManifests.length > 0) {
    manifests.push(...pythonManifests);
    for (const lock of ['poetry.lock', 'Pipfile.lock', 'uv.lock']) if (fileNames.has(lock)) lockfiles.push(lock);
    packageManagers.add(
      fileNames.has('poetry.lock')
        ? 'poetry'
        : fileNames.has('uv.lock')
          ? 'uv'
          : fileNames.has('Pipfile')
            ? 'pipenv'
            : 'pip',
    );
    const reqText = fileNames.has('requirements.txt') ? readText(path.join(root, 'requirements.txt')) : '';
    const pyproject = fileNames.has('pyproject.toml') ? readText(path.join(root, 'pyproject.toml')) : '';
    const combined = `${reqText}\n${pyproject}`.toLowerCase();
    const fw = combined.includes('fastapi')
      ? 'FastAPI'
      : combined.includes('django')
        ? 'Django'
        : combined.includes('flask')
          ? 'Flask'
          : 'Python';
    addEcosystem({ language: 'Python', framework: fw, confidence: 'high', evidence: pythonManifests });
    if (combined.includes('pytest')) testTools.push('pytest');
    if (combined.includes('ruff')) testTools.push('Ruff');
    if (combined.includes('mypy')) testTools.push('mypy');
  }

  /* ---------------- PHP ---------------- */
  if (fileNames.has('composer.json')) {
    manifests.push('composer.json');
    if (fileNames.has('composer.lock')) lockfiles.push('composer.lock');
    packageManagers.add('composer');
    const composer = readText(path.join(root, 'composer.json')).toLowerCase();
    const fw = composer.includes('laravel') ? 'Laravel' : composer.includes('symfony') ? 'Symfony' : 'PHP';
    addEcosystem({ language: 'PHP', framework: fw, confidence: 'high', evidence: ['composer.json'] });
    if (composer.includes('phpunit')) testTools.push('PHPUnit');
  }

  /* ---------------- Java / Kotlin ---------------- */
  if (fileNames.has('pom.xml')) {
    manifests.push('pom.xml');
    packageManagers.add('maven');
    const pom = readText(path.join(root, 'pom.xml')).toLowerCase();
    addEcosystem({
      language: pom.includes('kotlin') ? 'Kotlin' : 'Java',
      framework: pom.includes('spring-boot') ? 'Spring Boot' : 'Java/JVM',
      confidence: 'high',
      evidence: ['pom.xml'],
    });
    testTools.push('Maven Surefire');
  }
  if (fileNames.has('build.gradle') || fileNames.has('build.gradle.kts')) {
    manifests.push(fileNames.has('build.gradle') ? 'build.gradle' : 'build.gradle.kts');
    packageManagers.add('gradle');
    const gradle = readText(
      path.join(root, fileNames.has('build.gradle') ? 'build.gradle' : 'build.gradle.kts'),
    ).toLowerCase();
    addEcosystem({
      language: gradle.includes('kotlin') ? 'Kotlin' : 'Java',
      framework: gradle.includes('org.springframework.boot') ? 'Spring Boot' : 'Java/JVM',
      confidence: 'high',
      evidence: ['build.gradle'],
    });
  }

  /* ---------------- Go ---------------- */
  if (fileNames.has('go.mod')) {
    manifests.push('go.mod');
    if (fileNames.has('go.sum')) lockfiles.push('go.sum');
    packageManagers.add('go modules');
    const mod = readText(path.join(root, 'go.mod'));
    addEcosystem({
      language: 'Go',
      framework: mod.includes('gin-gonic') ? 'Gin' : 'Go',
      confidence: 'high',
      evidence: ['go.mod'],
    });
    testTools.push('go test');
  }

  /* ---------------- Rust ---------------- */
  if (fileNames.has('Cargo.toml')) {
    manifests.push('Cargo.toml');
    if (fileNames.has('Cargo.lock')) lockfiles.push('Cargo.lock');
    packageManagers.add('cargo');
    const cargo = readText(path.join(root, 'Cargo.toml')).toLowerCase();
    addEcosystem({
      language: 'Rust',
      framework: cargo.includes('tauri')
        ? 'Tauri'
        : cargo.includes('actix') || cargo.includes('axum')
          ? 'Rust web'
          : 'Rust',
      confidence: 'high',
      evidence: ['Cargo.toml'],
    });
    testTools.push('cargo test');
    buildTools.push('cargo build');
  }

  /* ---------------- .NET ---------------- */
  const dotnetFiles = files.filter((f) => f.ext === '.csproj' || f.ext === '.sln' || f.ext === '.fsproj');
  if (dotnetFiles.length > 0) {
    manifests.push(...dotnetFiles.slice(0, 5).map((f) => f.rel));
    packageManagers.add('nuget');
    const csprojText = dotnetFiles
      .filter((f) => f.ext === '.csproj')
      .map((f) => readText(path.join(root, f.rel)))
      .join('\n');
    addEcosystem({
      language: 'C#',
      framework: csprojText.includes('Microsoft.NET.Sdk.Web') ? 'ASP.NET Core' : '.NET',
      confidence: 'high',
      evidence: dotnetFiles.map((f) => f.rel).slice(0, 3),
    });
    testTools.push('dotnet test');
    buildTools.push('dotnet build');
  }

  /* ---------------- Flutter / Dart ---------------- */
  if (fileNames.has('pubspec.yaml')) {
    manifests.push('pubspec.yaml');
    if (fileNames.has('pubspec.lock')) lockfiles.push('pubspec.lock');
    packageManagers.add('pub');
    const pubspec = readText(path.join(root, 'pubspec.yaml')).toLowerCase();
    if (pubspec.includes('flutter')) {
      addEcosystem({ language: 'Dart', framework: 'Flutter', confidence: 'high', evidence: ['pubspec.yaml'] });
      testTools.push('flutter test');
      warnings.push(
        'Flutter/Dart projects are detected but automated execution is not yet implemented; tests will show as blocked.',
      );
    }
  }

  /* ---------------- C / C++ ---------------- */
  if (fileNames.has('CMakeLists.txt') || fileNames.has('Makefile')) {
    manifests.push(fileNames.has('CMakeLists.txt') ? 'CMakeLists.txt' : 'Makefile');
    const cFiles = files.filter((f) => ['.c', '.cc', '.cpp', '.h', '.hpp'].includes(f.ext));
    if (cFiles.length > 0) {
      addEcosystem({
        language: 'C/C++',
        framework: 'Native',
        confidence: 'medium',
        evidence: [fileNames.has('CMakeLists.txt') ? 'CMakeLists.txt' : 'Makefile'],
      });
      buildTools.push(fileNames.has('CMakeLists.txt') ? 'cmake' : 'make');
      warnings.push(
        'C/C++ projects are detected; build execution requires an approved command and is not auto-proposed.',
      );
    }
  }

  if (ecosystems.length === 0) {
    const sourceCount = files.filter((f) =>
      ['.js', '.ts', '.py', '.go', '.rs', '.java', '.php', '.cs', '.c', '.cpp'].includes(f.ext),
    ).length;
    if (sourceCount > 0) {
      warnings.push(
        'Source files were found but no known manifest was detected. Add a manifest or define commands manually.',
      );
      addEcosystem({
        language: 'Unknown',
        framework: undefined,
        confidence: 'low',
        evidence: [`${sourceCount} source files`],
      });
    } else {
      unsupported.push('No supported project manifest or source files were detected in this directory.');
    }
  }

  /* ---------------- Docker / DB / API ---------------- */
  const dockerFiles = rels.filter((r) => /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(r));
  const dbConfigFiles = rels.filter((r) =>
    /(schema\.prisma|alembic\.ini|knexfile\.(js|ts)|ormconfig\.(js|ts|json)|sequelize.*\.(js|ts)|doctrine.*\.(yaml|php)|flyway\.conf|liquibase.*)$/i.test(
      r,
    ),
  );
  const migrationDirs = [
    ...new Set(
      rels.filter((r) => /(^|\/)(migrations|migrate)\//i.test(r)).map((r) => r.split('/').slice(0, -1).join('/')),
    ),
  ];
  const dbText =
    `${fileNames.has('.env.example') ? readText(path.join(root, '.env.example')) : ''}\n${dbConfigFiles.map((f) => readText(path.join(root, f))).join('\n')}`.toLowerCase();
  const engines = ['mysql', 'mariadb', 'postgres', 'postgresql', 'mongodb', 'sqlite', 'redis'].filter((e) =>
    dbText.includes(e),
  );
  const apiSpecs = rels.filter((r) => /(openapi|swagger).*\.(json|ya?ml)$/i.test(r));

  const subprojects: DetectedSubproject[] = [];
  const subManifestFiles = pkgFiles.filter((f) => f.rel !== 'package.json' && f.rel.split('/').length <= 3);
  for (const manifest of subManifestFiles.slice(0, 30)) {
    const dir = path.dirname(manifest.rel);
    const sub = parsePackage(path.join(root, manifest.rel));
    const subDeps = readJson(path.join(root, manifest.rel));
    const deps = subDeps ? depsOf(subDeps) : {};
    const frameworks: string[] = [];
    if (deps['react']) frameworks.push('React');
    if (deps['vue']) frameworks.push('Vue');
    if (deps['@angular/core']) frameworks.push('Angular');
    if (deps['svelte']) frameworks.push('Svelte');
    if (deps['next']) frameworks.push('Next.js');
    subprojects.push({
      name: sub?.name ?? dir,
      relPath: dir,
      languages:
        Object.keys({ ...deps }).includes('typescript') || fs.existsSync(path.join(root, dir, 'tsconfig.json'))
          ? ['TypeScript']
          : ['JavaScript'],
      frameworks,
      packageManager: fs.existsSync(path.join(root, dir, 'package-lock.json')) ? 'npm' : undefined,
      manifests: ['package.json'],
    });
  }
  const rootPkg = fs.existsSync(rootPkgPath) ? parsePackage(rootPkgPath) : null;
  const isMonorepo =
    Boolean(rootPkg?.workspaces) ||
    fileNames.has('pnpm-workspace.yaml') ||
    fileNames.has('lerna.json') ||
    subprojects.length > 1 ||
    ['apps', 'packages', 'services'].some((dir) => {
      const abs = path.join(root, dir);
      return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
    });

  if (isMonorepo && subprojects.length === 0)
    warnings.push(
      'Monorepo layout detected, but nested package manifests could not be enumerated within the scan depth.',
    );

  const dashIndex = files.find((f) => f.ext === '.dash' || f.name === 'analysis_options.yaml');
  void dashIndex;

  const tools = detectTools(root, files, ecosystems, probe).map((t) => {
    if (!t.available && !t.reason) t.reason = 'Required runtime or package manager was not found on PATH';
    return t;
  });
  for (const t of tools) {
    if (!t.available && t.kind === 'unit') warnings.push(`${t.name} is detected but unavailable: ${t.reason}`);
  }

  return {
    rootPath: root,
    scannedAt: new Date().toISOString(),
    ecosystems,
    packageManagers: [...packageManagers],
    manifests: [...new Set(manifests)],
    lockfiles: [...new Set(lockfiles)],
    testTools: [...new Set(testTools)],
    buildTools: [...new Set(buildTools)],
    tools,
    isMonorepo,
    subprojects,
    docker: { detected: dockerFiles.length > 0, files: dockerFiles.slice(0, 10) },
    database: {
      detected: engines.length > 0 || dbConfigFiles.length > 0,
      engines,
      configFiles: dbConfigFiles.slice(0, 20),
      migrationDirs: migrationDirs.slice(0, 10),
    },
    api: { detected: apiSpecs.length > 0, specFiles: apiSpecs.slice(0, 10) },
    git: detectGit(root),
    runtime: detectRuntime(probe),
    warnings: [...new Set(warnings)],
    unsupported: [...new Set(unsupported)],
  };
}
