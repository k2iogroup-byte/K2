import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@k2/shared': path.join(root, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'apps/api/test/unit/**/*.test.ts',
      'packages/shared/test/**/*.test.ts',
      'apps/web/lib/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: ['apps/api/src/**/*.ts', 'packages/shared/src/**/*.ts', 'apps/web/lib/**/*.ts'],
      exclude: [
        'apps/api/src/index.ts',
        'apps/api/src/worker.ts',
        'apps/api/src/infrastructure/db/migrate-cli.ts',
      ],
    },
  },
});
