/**
 * Docker-backed integration suite. It is intentionally excluded from the
 * ordinary `npm test` command so contributors do not need Docker for unit work.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
