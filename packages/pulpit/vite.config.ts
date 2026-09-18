import { defineConfig } from "vite-plus";

/**
 * Input fingerprint for this package's cached tasks: auto tracking minus
 * node_modules bookkeeping churn (pnpm rewrites `.modules.yaml` on every
 * install), with the lockfile back explicitly so a dependency upgrade still
 * invalidates a type-check or a test run.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

/**
 * `VITEST_MAX_WORKERS` caps the fork count when set (CI sets it to 2); the
 * property is added only when present so vitest keeps its own default
 * otherwise — an explicit `undefined` would not.
 */
interface WorkerCap {
  maxWorkers?: number;
}
const maxWorkers: WorkerCap = {};
if (process.env.VITEST_MAX_WORKERS !== undefined) {
  maxWorkers.maxWorkers = Number(process.env.VITEST_MAX_WORKERS);
}

export default defineConfig({
  run: {
    tasks: {
      // Type-checks `src/` AND `tests/` — the `*.types.ts` files under
      // `tests/` are the type-level test slot, whose expected-error
      // directives are the assertions.
      check: {
        command: "tsc -p tsconfig.json",
        input: cacheInputs,
        output: [],
      },
      // Emits `dist/` (JavaScript + declarations) with the native, Effect-
      // patched `tsc`. `rm -rf` first so a renamed module leaves no stale file.
      build: {
        command: "rm -rf dist && tsc -p tsconfig.build.json",
        input: cacheInputs,
        output: ["dist/**"],
      },
      "test:unit": {
        command: "vp test run tests",
        env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
        input: cacheInputs,
        output: [],
      },
      "test:coverage": {
        command: "vp test run tests --coverage",
        env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
        input: cacheInputs,
        output: ["coverage/**"],
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    ...maxWorkers,
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
