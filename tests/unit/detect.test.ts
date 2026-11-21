import { describe, expect, it } from 'vitest';
import { detectProject } from '@zethub/verification-core';
import { tempDir, writeFile } from '../helpers';

describe('project detection', () => {
  const root = tempDir('zethub-detect-');
  writeFile(
    root,
    'package.json',
    JSON.stringify({
      name: 'fixture',
      scripts: { test: 'vitest run', build: 'vite build' },
      dependencies: { react: '18.3.1', fastify: '5.0.0' },
      devDependencies: { vitest: '3.2.4', typescript: '5.8.3', eslint: '9.0.0', prettier: '3.0.0' },
    }),
  );
  writeFile(root, 'package-lock.json', '{}');
  writeFile(root, 'tsconfig.json', '{}');
  writeFile(root, 'apps/api/package.json', JSON.stringify({ name: 'api' }));
  writeFile(root, 'docker-compose.yml', 'services: {}');
  writeFile(root, 'prisma/schema.prisma', 'datasource db { provider = "mysql" }');
  writeFile(root, 'openapi.yaml', 'openapi: 3.1.0');
  writeFile(root, 'prisma/migrations/001_init/migration.sql', 'CREATE TABLE x (id INT);');

  const result = detectProject(root, { probeTools: false });

  it('identifies the JavaScript ecosystem, framework and package manager', () => {
    expect(result.rootPath).toBe(root);
    expect(result.packageManagers).toContain('npm');
    expect(result.ecosystems.some((e) => e.language === 'TypeScript')).toBe(true);
    expect(result.ecosystems.some((e) => e.framework === 'React' || e.framework === 'Fastify')).toBe(true);
    expect(result.testTools).toEqual(expect.arrayContaining(['Vitest', 'ESLint', 'Prettier']));
    expect(result.buildTools).toContain('npm run build');
  });

  it('detects monorepo subprojects without inventing languages', () => {
    expect(result.isMonorepo).toBe(true);
    expect(result.subprojects.some((s) => s.relPath === 'apps/api')).toBe(true);
  });

  it('detects docker, database, migrations and API specs', () => {
    expect(result.docker.detected).toBe(true);
    expect(result.docker.files).toContain('docker-compose.yml');
    expect(result.database.detected).toBe(true);
    expect(result.database.configFiles).toContain('prisma/schema.prisma');
    expect(result.database.migrationDirs.length).toBeGreaterThan(0);
    expect(result.api.detected).toBe(true);
    expect(result.api.specFiles).toContain('openapi.yaml');
  });

  it('does not invent tool versions when probing is disabled', () => {
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools.every((t) => t.version === undefined)).toBe(true);
  });

  it('rejects a missing or non-directory path', () => {
    expect(() => detectProject(`${root}-missing`)).toThrow('does not exist');
  });
});
