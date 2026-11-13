import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // All suites share one local PostgreSQL database: files must never overlap.
    // (vitest 5: sequential files via fileParallelism; poolOptions.singleFork no longer exists.)
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
