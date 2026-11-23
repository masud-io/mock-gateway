import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The integration tests boot an embedded Postgres and run migrations in beforeAll.
    // Hooks have their own timeout (default 10s), which is too tight when files boot in parallel on a busy machine.
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
