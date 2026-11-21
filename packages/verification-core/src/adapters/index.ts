import fs from 'node:fs';
import path from 'node:path';
import type { TestCasePlan } from '@zethub/shared-types';
import { makeCase, pmRunScript, type AdapterContext, type VerificationAdapter } from './types.js';

function hasTool(ctx: AdapterContext, id: string): boolean {
  return ctx.detection.tools.find((t) => t.id === id)?.available === true;
}

function nodeFiles(ctx: AdapterContext): string[] {
  return ctx.testFiles.filter((f) => /\.(test|spec)\.(t|j)sx?$|__tests__\//.test(f));
}

function localBin(ctx: AdapterContext, name: string): string | null {
  const bin = path.join(ctx.projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  return fs.existsSync(bin) ? bin : null;
}

function depsInstalled(ctx: AdapterContext): boolean {
  return fs.existsSync(path.join(ctx.projectRoot, 'node_modules'));
}

function scriptCases(ctx: AdapterContext, adapterId: string): TestCasePlan[] {
  const rootPkg = path.join(ctx.projectRoot, 'package.json');
  if (!fs.existsSync(rootPkg)) return [];
  let scripts: Record<string, string> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(rootPkg, 'utf8')) as { scripts?: Record<string, string> };
    scripts = parsed.scripts ?? {};
  } catch {
    return [];
  }
  const pm = ctx.settings.packageManager ?? ctx.detection.packageManagers[0] ?? 'npm';
  const cases: TestCasePlan[] = [];
  const commandFor = (script: string): TestCasePlan['command'] => {
    const { executable, args } = pmRunScript(pm, script);
    return { executable, args, cwd: ctx.projectRoot };
  };

  if (scripts.test) {
    cases.push(
      makeCase({
        key: 'js:test',
        title: 'JavaScript test suite',
        kind: 'unit',
        adapterId,
        command: commandFor('test'),
        reason: depsInstalled(ctx)
          ? 'package.json defines a "test" script; ZetHub runs the project-native runner without installing anything.'
          : 'package.json defines a "test" script, but dependencies are not installed. ZetHub does not install packages automatically.',
        mappedFiles: nodeFiles(ctx),
        priority: 90,
        timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 600_000),
        tags: depsInstalled(ctx) ? ['tests'] : ['tests', 'blocked'],
      }),
    );
  }
  for (const [script, kind, title, priority] of [
    ['test:unit', 'unit', 'Unit tests', 92],
    ['test:integration', 'integration', 'Integration tests', 85],
    ['test:e2e', 'browser', 'End-to-end tests', 80],
    ['build', 'build', 'Production build', 75],
    ['lint', 'lint', 'Lint checks', 60],
    ['typecheck', 'typecheck', 'Type checking', 65],
    ['format:check', 'format', 'Format verification', 40],
  ] as const) {
    if (!scripts[script]) continue;
    cases.push(
      makeCase({
        key: `js:${script}`,
        title,
        kind,
        adapterId,
        command: commandFor(script),
        reason: `Detected "${script}" script in package.json.`,
        mappedFiles: kind === 'unit' || kind === 'integration' || kind === 'browser' ? nodeFiles(ctx) : [],
        priority,
        timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 600_000),
        tags: depsInstalled(ctx) ? [script] : [script, 'blocked'],
      }),
    );
  }
  return cases;
}

export const javascriptAdapter: VerificationAdapter = {
  id: 'javascript',
  name: 'Node.js / JavaScript / TypeScript',
  version: '1.0.0',
  supports: ['unit', 'integration', 'build', 'lint', 'typecheck', 'format', 'browser', 'dependency-audit'],
  prerequisites: ['Node.js', 'project dependencies installed'],
  detect(ctx) {
    return ctx.detection.ecosystems.some((e) => ['JavaScript', 'TypeScript'].includes(e.language));
  },
  plan(ctx) {
    const cases = scriptCases(ctx, 'javascript');
    const tscBin = localBin(ctx, 'tsc');
    if (hasTool(ctx, 'node-tsc')) {
      if (fs.existsSync(path.join(ctx.projectRoot, 'tsconfig.json'))) {
        cases.push(
          makeCase({
            key: 'js:typecheck:tsc',
            title: 'TypeScript type check (tsc --noEmit)',
            kind: 'typecheck',
            adapterId: 'javascript',
            command: { executable: 'npx', args: ['--no-install', 'tsc', '--noEmit'], cwd: ctx.projectRoot },
            reason: tscBin
              ? 'tsconfig.json detected. --noEmit guarantees this check does not rewrite sources.'
              : 'tsconfig.json is present but the local TypeScript package is not installed. ZetHub does not download packages during verification.',
            priority: 72,
            timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 300_000),
            tags: tscBin ? ['types'] : ['types', 'blocked'],
          }),
        );
      }
    }
    const eslintBin = localBin(ctx, 'eslint');
    if (hasTool(ctx, 'node-eslint') && !cases.some((c) => c.kind === 'lint')) {
      cases.push(
        makeCase({
          key: 'js:eslint',
          title: 'ESLint',
          kind: 'lint',
          adapterId: 'javascript',
          command: {
            executable: 'npx',
            args: ['--no-install', 'eslint', '.', '--max-warnings=0'],
            cwd: ctx.projectRoot,
          },
          reason: eslintBin
            ? 'ESLint is installed in the project.'
            : 'ESLint is declared but not installed; install dependencies first.',
          priority: 55,
          timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 300_000),
          tags: eslintBin ? ['lint'] : ['lint', 'blocked'],
        }),
      );
    }
    const prettierBin = localBin(ctx, 'prettier');
    if (hasTool(ctx, 'node-prettier')) {
      cases.push(
        makeCase({
          key: 'js:prettier',
          title: 'Prettier format check',
          kind: 'format',
          adapterId: 'javascript',
          command: { executable: 'npx', args: ['--no-install', 'prettier', '--check', '.'], cwd: ctx.projectRoot },
          reason: prettierBin
            ? 'Prettier is installed; --check never modifies files.'
            : 'Prettier is declared but not installed.',
          priority: 35,
          timeoutMs: 180_000,
          tags: prettierBin ? ['format'] : ['format', 'blocked'],
        }),
      );
    }
    if (
      hasTool(ctx, 'node-audit') &&
      ctx.detection.lockfiles.some((l) => /package-lock|yarn\.lock|pnpm-lock/.test(l))
    ) {
      cases.push(
        makeCase({
          key: 'js:audit',
          title: 'Dependency vulnerability audit (npm audit)',
          kind: 'dependency-audit',
          adapterId: 'javascript',
          command: { executable: 'npm', args: ['audit', '--json'], cwd: ctx.projectRoot },
          reason: 'A JavaScript lockfile is present. Audit output is parsed into vulnerability counts.',
          priority: 30,
          timeoutMs: 180_000,
          tags: ['security'],
        }),
      );
    }
    return cases;
  },
};

export const pythonAdapter: VerificationAdapter = {
  id: 'python',
  name: 'Python',
  version: '1.0.0',
  supports: ['unit', 'static-analysis', 'lint', 'typecheck'],
  prerequisites: ['Python', 'pytest (for test cases)'],
  detect(ctx) {
    return ctx.detection.ecosystems.some((e) => e.language === 'Python');
  },
  plan(ctx) {
    const cases: TestCasePlan[] = [];
    const pytest = ctx.detection.tools.find((t) => t.id === 'python-pytest');
    const pythonTool = ctx.detection.tools.find((t) => t.id === 'python-compile');
    const pythonExe = pythonTool?.executable ?? 'python';
    if (pytest?.available) {
      cases.push(
        makeCase({
          key: 'python:pytest',
          title: 'pytest suite',
          kind: 'unit',
          adapterId: 'python',
          command: { executable: pythonExe, args: ['-m', 'pytest', '-q'], cwd: ctx.projectRoot },
          reason: 'Python project with pytest configuration detected.',
          mappedFiles: ctx.testFiles.filter((f) => /(^test_.*|_test)\.py$/.test(path.basename(f))),
          priority: 90,
          timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 600_000),
          tags: ['tests'],
        }),
      );
    }
    cases.push(
      makeCase({
        key: 'python:compile',
        title: 'Python syntax compile check',
        kind: 'static-analysis',
        adapterId: 'python',
        command: { executable: pythonExe, args: ['-m', 'compileall', '-q', '.'], cwd: ctx.projectRoot },
        reason: 'compileall validates syntax without executing project code.',
        priority: 45,
        timeoutMs: 180_000,
        tags: ['syntax'],
      }),
    );
    const pyproject = ctx.detection.manifests.includes('pyproject.toml');
    if (pyproject && hasTool(ctx, 'python-pytest')) {
      cases.push(
        makeCase({
          key: 'python:ruff',
          title: 'Ruff lint (if configured)',
          kind: 'lint',
          adapterId: 'python',
          command: { executable: pythonExe, args: ['-m', 'ruff', 'check', '.'], cwd: ctx.projectRoot },
          reason: 'Ruff is commonly configured in pyproject.toml; the case is blocked if the module is missing.',
          priority: 40,
          timeoutMs: 180_000,
          tags: ['lint'],
        }),
      );
    }
    return cases;
  },
};

export const rustAdapter: VerificationAdapter = {
  id: 'rust',
  name: 'Rust / Cargo',
  version: '1.0.0',
  supports: ['unit', 'build', 'lint'],
  prerequisites: ['Rust toolchain (cargo)'],
  detect(ctx) {
    return ctx.detection.ecosystems.some((e) => e.language === 'Rust');
  },
  plan(ctx) {
    return [
      makeCase({
        key: 'rust:cargo-test',
        title: 'cargo test',
        kind: 'unit',
        adapterId: 'rust',
        command: { executable: 'cargo', args: ['test', '--quiet'], cwd: ctx.projectRoot },
        reason: 'Cargo manifest detected. Compiling and running the native test suite is the strongest local evidence.',
        priority: 90,
        mappedFiles: ctx.testFiles.filter((f) => f.endsWith('.rs')),
        timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 900_000),
        tags: ['tests'],
      }),
      makeCase({
        key: 'rust:cargo-build',
        title: 'cargo build',
        kind: 'build',
        adapterId: 'rust',
        command: { executable: 'cargo', args: ['build'], cwd: ctx.projectRoot },
        reason: 'Build verification proves the crate compiles even if tests do not exist.',
        priority: 75,
        timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 900_000),
        tags: ['build'],
      }),
    ];
  },
};

export const goAdapter: VerificationAdapter = {
  id: 'go',
  name: 'Go',
  version: '1.0.0',
  supports: ['unit', 'build'],
  prerequisites: ['Go toolchain'],
  detect(ctx) {
    return ctx.detection.ecosystems.some((e) => e.language === 'Go');
  },
  plan(ctx) {
    return [
      makeCase({
        key: 'go:test',
        title: 'go test ./...',
        kind: 'unit',
        adapterId: 'go',
        command: { executable: 'go', args: ['test', './...'], cwd: ctx.projectRoot },
        reason: 'Go module detected.',
        priority: 90,
        timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 600_000),
        tags: ['tests'],
      }),
      makeCase({
        key: 'go:build',
        title: 'go build ./...',
        kind: 'build',
        adapterId: 'go',
        command: { executable: 'go', args: ['build', './...'], cwd: ctx.projectRoot },
        reason: 'Go build verification.',
        priority: 70,
        timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 600_000),
        tags: ['build'],
      }),
    ];
  },
};

export const dotnetAdapter: VerificationAdapter = {
  id: 'dotnet',
  name: '.NET / C#',
  version: '1.0.0',
  supports: ['unit', 'build'],
  prerequisites: ['.NET SDK'],
  detect(ctx) {
    return ctx.detection.ecosystems.some((e) => ['C#', '.NET'].includes(e.language));
  },
  plan(ctx) {
    return [
      makeCase({
        key: 'dotnet:test',
        title: 'dotnet test',
        kind: 'unit',
        adapterId: 'dotnet',
        command: { executable: 'dotnet', args: ['test', '--nologo'], cwd: ctx.projectRoot },
        reason: 'MSBuild project detected.',
        priority: 90,
        timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 900_000),
        tags: ['tests'],
      }),
      makeCase({
        key: 'dotnet:build',
        title: 'dotnet build',
        kind: 'build',
        adapterId: 'dotnet',
        command: { executable: 'dotnet', args: ['build', '--nologo'], cwd: ctx.projectRoot },
        reason: 'Build verification for the detected solution/project.',
        priority: 70,
        timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 900_000),
        tags: ['build'],
      }),
    ];
  },
};

export const javaAdapter: VerificationAdapter = {
  id: 'java',
  name: 'Java / Kotlin (Maven & Gradle)',
  version: '1.0.0',
  supports: ['unit', 'build'],
  prerequisites: ['Maven or Gradle wrapper', 'JDK'],
  detect(ctx) {
    return ctx.detection.ecosystems.some((e) => ['Java', 'Kotlin'].includes(e.language));
  },
  plan(ctx) {
    if (ctx.detection.manifests.includes('pom.xml')) {
      return [
        makeCase({
          key: 'java:maven-test',
          title: 'mvn test',
          kind: 'unit',
          adapterId: 'java',
          command: { executable: 'mvn', args: ['-q', 'test'], cwd: ctx.projectRoot },
          reason: 'Maven project detected.',
          priority: 90,
          timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 900_000),
          tags: ['tests'],
        }),
      ];
    }
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    return [
      makeCase({
        key: 'java:gradle-test',
        title: 'Gradle test',
        kind: 'unit',
        adapterId: 'java',
        command: { executable: wrapper, args: ['test', '--console=plain'], cwd: ctx.projectRoot },
        reason: 'Gradle project detected. The project wrapper is used when present.',
        priority: 90,
        timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 900_000),
        tags: ['tests'],
      }),
    ];
  },
};

export const phpAdapter: VerificationAdapter = {
  id: 'php',
  name: 'PHP',
  version: '1.0.0',
  supports: ['unit', 'lint'],
  prerequisites: ['PHP', 'PHPUnit'],
  detect(ctx) {
    return ctx.detection.ecosystems.some((e) => e.language === 'PHP');
  },
  plan(ctx) {
    const phpunit = ctx.detection.tools.find((t) => t.id === 'php-phpunit');
    const cases: TestCasePlan[] = [];
    if (phpunit?.available) {
      const local = path.join(
        ctx.projectRoot,
        'vendor',
        'bin',
        process.platform === 'win32' ? 'phpunit.bat' : 'phpunit',
      );
      cases.push(
        makeCase({
          key: 'php:phpunit',
          title: 'PHPUnit',
          kind: 'unit',
          adapterId: 'php',
          command: {
            executable: fs.existsSync(local) ? local : 'php',
            args: fs.existsSync(local) ? [] : ['vendor/phpunit/phpunit/phpunit'],
            cwd: ctx.projectRoot,
          },
          reason: 'PHPUnit configuration detected.',
          priority: 90,
          timeoutMs: Math.min(ctx.settings.maxTimeoutMs, 600_000),
          tags: ['tests'],
        }),
      );
    }
    cases.push(
      makeCase({
        key: 'php:lint',
        title: 'PHP syntax lint',
        kind: 'lint',
        adapterId: 'php',
        command: { executable: 'php', args: ['-l', 'index.php'], cwd: ctx.projectRoot },
        reason: 'Basic syntax validation of the entry point.',
        priority: 30,
        timeoutMs: 60_000,
        tags: ['syntax'],
      }),
    );
    return cases;
  },
};

export const BROWSER_ADAPTER_ID = 'browser-playwright';
export const API_ADAPTER_ID = 'api-http';
export const DATABASE_ADAPTER_ID = 'database-mysql';
export const SECRET_SCAN_ADAPTER_ID = 'zethub-secret-scan';
export const BUILTIN_ADAPTER_ID = 'zethub-builtin';

export const commandAdapters: VerificationAdapter[] = [
  javascriptAdapter,
  pythonAdapter,
  rustAdapter,
  goAdapter,
  dotnetAdapter,
  javaAdapter,
  phpAdapter,
];

export const allAdapters: VerificationAdapter[] = [
  ...commandAdapters,
  {
    id: BROWSER_ADAPTER_ID,
    name: 'Playwright browser verification',
    version: '1.0.0',
    supports: ['browser'],
    prerequisites: ['Playwright Chromium browser'],
    detect: () => true,
    plan: () => [],
  },
  {
    id: API_ADAPTER_ID,
    name: 'HTTP API verification',
    version: '1.0.0',
    supports: ['api'],
    prerequisites: ['Reachable test API'],
    detect: () => true,
    plan: () => [],
  },
  {
    id: DATABASE_ADAPTER_ID,
    name: 'MySQL database verification',
    version: '1.0.0',
    supports: ['database'],
    prerequisites: ['Configured test database integration'],
    detect: () => true,
    plan: () => [],
  },
];
