import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The end-to-end suites boot the whole application on an embedded database and run in parallel.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Each end-to-end file builds a whole airport day; more than three at once starves the CPU.
    maxWorkers: 3,
  },
});
