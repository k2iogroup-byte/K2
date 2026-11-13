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
    include: ['apps/api/test/integration/**/*.test.ts'],
    fileParallelism: false,
    hookTimeout: 20_000,
    testTimeout: 20_000,
  },
});
