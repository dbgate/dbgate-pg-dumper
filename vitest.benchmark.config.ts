import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/performance/**/*.benchmark.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
