import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  root,
  resolve: {
    alias: {
      '@zethub/verification-core': path.join(root, 'packages', 'verification-core', 'src', 'index.ts'),
      '@zethub/shared-types': path.join(root, 'packages', 'shared-types', 'src', 'index.ts'),
      '@backend': path.join(root, 'apps', 'backend', 'src'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    setupFiles: [path.join(root, 'tests', 'setup.ts')],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['packages/verification-core/src/**/*.ts', 'apps/backend/src/lib/**/*.ts'],
      exclude: ['**/*.d.ts'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
