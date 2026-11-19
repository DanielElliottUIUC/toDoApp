import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    globalSetup: ["packages/core/test/helpers/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
