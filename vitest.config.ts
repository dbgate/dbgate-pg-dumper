/**
 * Defines a deterministic Node.js test environment. Integration tests live in
 * a separate folder but use the same runner so they can later be enabled by
 * environment-specific setup without changing test technology.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
