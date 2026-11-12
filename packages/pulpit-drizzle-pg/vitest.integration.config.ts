import { defineConfig } from "vite-plus";

// The integration suite (`vp run test:integration`): `tests/integration/`
// against a real PostgreSQL that the global setup provisions. Not part of
// the gates (AGENTS.md → Verification: they need no database), so neither
// `test:unit` nor `test:coverage` reads these files. One file at a time: the
// suites share one database, and each case truncates it.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
