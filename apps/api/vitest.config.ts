import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // All test files share one database, so run them one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
