import { defineConfig } from 'vitest/config';

// End-to-end tests against anvil and the compiled contracts (needs Foundry and `forge build`).
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
