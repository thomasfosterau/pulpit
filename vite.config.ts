import { defineConfig } from "vite-plus";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";

// Every package `release` may publish; list a new package here.
const releaseBuilds = [
  "@thomasfosterau/pulpit#build",
  "@thomasfosterau/pulpit-wordpress#build",
  "@thomasfosterau/pulpit-drizzle-pg#build",
];

export default defineConfig({
  // Lint without fixes, so no type-aware autofix lands unverified.
  staged: {
    "*.{js,ts,css,json,md}": [
      "vp check --fix --no-lint",
      "vp check --no-fmt --no-error-on-unmatched-pattern",
    ],
  },
  fmt: {
    ignorePatterns: ["**/dist/**", "packages/*/docs/**", "**/coverage/**"],
    overrides: [
      {
        files: ["**/*.md"],
        options: {
          proseWrap: "never",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "packages/*/docs/**", "**/coverage/**", "**/node_modules/**"],
    extends: [recommended, effect.configs.recommended],
    // oxlint's default plugins plus `import`, `promise`, `vitest` and `jsdoc`.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest", "jsdoc"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      "eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "eslint/prefer-const": "error",
      // `_tag` is the discriminant of every Effect tagged value and error;
      // `_links` and `_embedded` are the WordPress REST API's own (HAL) wire
      // members, which pulpit-wordpress must emit under exactly those names.
      "eslint/no-underscore-dangle": ["error", { allow: ["_tag", "_links", "_embedded"] }],
      "unicorn/consistent-function-scoping": "error",
      "eslint/no-shadow": "error",
      // The suites assert through helpers named `expect…` (`expectAgreement`
      // in tests/subtype.test.ts) as well as `expect` itself.
      // `@effect/vitest`'s `it.effect` (and its `.prop`) registers a test like `it` does.
      "vitest/expect-expect": [
        "error",
        {
          assertFunctionNames: ["expect", "expect*"],
          additionalTestBlockFunctions: [
            "it.effect",
            "it.live",
            "it.prop",
            "it.effect.prop",
            "it.live.prop",
          ],
        },
      ],
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: [
            "it.effect",
            "it.effect.each",
            "it.live",
            "it.live.each",
            "it.prop",
            "it.effect.prop",
            "it.live.prop",
          ],
        },
      ],
      // The `Buffer` global is typed `any` wherever a consumer loads
      // @cloudflare/workers-types next to @types/node (every application this
      // library serves), so every call on it is unchecked there. The library
      // never reaches for it: bytes are `Uint8Array`.
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "The `Buffer` global is typed `any` wherever @cloudflare/workers-types is loaded. Use Uint8Array/DataView.",
        },
      ],
      // In no enabled category, so raised by name.
      "typescript/no-explicit-any": "error",
      "typescript/no-empty-object-type": "error",
      "typescript/ban-ts-comment": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      // The registry's member projections return a tuple computed by a
      // conditional type over the caller's entries (`PickResources<T, Flag>`,
      // `PickChildren<T, Parents>`, `Identifiers<Members>`). TypeScript cannot
      // relate any value to a conditional type over an unresolved type
      // parameter, and the tuple exists only at the type level, so there is
      // nothing to decode into: the array built from the same entries, in
      // the same order, is narrowed with a `// SAFETY:`-commented `as`
      // (audited by `effect/require-safety-comment-for-type-assertion`).
      {
        files: ["packages/pulpit/src/Registry.ts"],
        rules: {
          "effect/casting-awareness": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
      // pulpit-drizzle-pg's `makeVersionChains` is the type-erasure seam
      // between effect-drizzle-ext `-pg/Chain`'s per-leaf typed chains and
      // the kernel's untyped `VersionChain` port. Each leaf's chain is typed
      // by conditional types over the application's unresolved tree (`S`,
      // `T`: `ChainState<S, T, K>`, `LeafOf<S>`), and its inputs are
      // contravariant in them, so TypeScript can relate it to the kernel's
      // `ChainState` neither way, and the result record's keys exist only at
      // the type level. The two `// SAFETY:`-commented assertions (the
      // erased chains, and the ports under the tree's leaf names) are the
      // whole crossing; `-pg/Chain` crosses the same seam the other way.
      // pulpit-drizzle-pg's unit suites drive each store over a stand-in for
      // Drizzle's transaction (`tests/fixtures/canned.ts`): an Effect of
      // canned rows whose builder methods return itself. A real
      // `PgTransaction` needs a driver session, and the stand-in shares no
      // type with it, so the one `// SAFETY:`-commented assertion is the
      // fixture's whole reason to exist; the SQL it stands in for runs on
      // PostgreSQL in `tests/integration/`.
      // Both name `casting-awareness` beside `no-unsafe-type-assertion`: the
      // same assertions, for the same reason, prompt both.
      {
        files: ["packages/pulpit-drizzle-pg/tests/fixtures/canned.ts"],
        rules: {
          "typescript/no-unsafe-type-assertion": "off",
          "effect/casting-awareness": "off",
          "effect/no-chained-type-assertions": "off",
          "effect/avoid-any": "off",
        },
      },
      {
        files: ["packages/pulpit-drizzle-pg/src/VersionChain.ts"],
        rules: {
          "typescript/no-unsafe-type-assertion": "off",
          "effect/casting-awareness": "off",
          "effect/no-chained-type-assertions": "off",
          "effect/avoid-any": "off",
        },
      },
      // The type-level test slot: an expected-error directive IS the assertion
      // there (each paired with its positive control), so the rule that bans
      // suppressions has nothing to protect in these files.
      {
        files: ["**/tests/**/*.types.ts"],
        rules: {
          "effect/avoid-ts-ignore": "off",
        },
      },
      // Two runtime boundaries `effect-run-in-body` asks for ("entrypoint/test
      // harness") that `@effect/vitest`'s `it.effect` can't stand in for:
      // vitest's global setup, which runs before any test, and the drizzle
      // integration run of the kernel's `versionChainConformance`, whose
      // harness takes Promises. Its fault-injection helper takes whatever
      // effect the case hands it, and the setup provides its own layers.
      {
        files: [
          "packages/pulpit-drizzle-pg/tests/integration/global-setup.ts",
          "packages/pulpit-drizzle-pg/tests/integration/version-chain.test.ts",
        ],
        rules: {
          "effect/effect-run-in-body": "off",
          "effecttsgo/strict-effect-provide": "off",
          "effecttsgo/any-unknown-in-error-context": "off",
        },
      },
      // pulpit-drizzle-pg's integration global setup is vitest's own entry
      // point, before any Effect runtime exists: `-pg/testing`'s
      // `provisionTestDatabase` takes `process.env` itself (its PG* and
      // DATABASE_URL_TEST resolution), and the setup hands the provisioned
      // URL to the suites the only way vitest offers, through `process.env`.
      // Its whole job is the PostgreSQL driver and the Node platform, both of
      // which the pinned Effect marks unstable.
      {
        files: ["packages/pulpit-drizzle-pg/tests/integration/global-setup.ts"],
        rules: {
          "effect/avoid-process-env": "off",
          "effecttsgo/unstable-api-usage": "off",
        },
      },
      // `@effect/vitest` is how a test runs an Effect (`it.effect`,
      // `beforeAll`), and the pinned version marks it unstable as a whole; it
      // moves with `effect` in the catalog.
      {
        files: ["**/tests/**/*.ts"],
        rules: {
          "effecttsgo/unstable-api-usage": "off",
        },
      },
      // The adapter's HTTP surface is `effect/http`, which the pinned Effect
      // marks unstable as a whole; there is no stable module to serve a
      // request with. `@effect/tsgo`'s `unstable-api-usage` would report
      // every use of the module the file exists to wrap.
      {
        files: [
          "packages/pulpit-wordpress/src/Http.ts",
          "packages/pulpit-wordpress/tests/http.test.ts",
          "tests/dist-consumer/src/wordpress.ts",
        ],
        rules: {
          "effecttsgo/unstable-api-usage": "off",
        },
      },
      // The WordPress adapter's bindings are application callbacks whose
      // failures it cannot name: each binding's error channel is `unknown`
      // by contract (a published type), and `internal` turns every such
      // failure into a 500 `WpRestError` before it leaves the adapter, so
      // the `unknown` never reaches a caller.
      {
        files: ["packages/pulpit-wordpress/src/Api.ts"],
        rules: {
          "effecttsgo/any-unknown-in-error-context": "off",
        },
      },
      // Build/test configs are evaluated by Vite and Vitest in bare Node,
      // before any Effect runtime exists — there is no `Config` provider to
      // read from and no `FileSystem` service to call, so `process.env` and
      // `node:*` are the only things that work there. The Effect preset's
      // service rules have no satisfiable fix in these files (nor in
      // `vite.package.ts`, the config the packages' `vite.config.ts` share).
      {
        files: ["**/vite.config.ts", "**/vitest.config.ts", "vite.package.ts"],
        rules: {
          "effect/avoid-process-env": "off",
        },
      },
    ],
    // Type-aware linting through tsrs (bundled with Vite+, patched by
    // `effect-tsgo patch --tsrs`): `typeAware` turns on the rules that need
    // type information. `typeCheck` stays off: tsrs reports the Effect
    // plugin's warnings (`unstableApiUsage`, `asyncFunction`, ...) as errors,
    // bypassing the per-file `effecttsgo/*` overrides above. The `check` tasks
    // (native, Effect-patched tsc) are the type gate and report those
    // diagnostics at their configured severity. tsrs types a file with its
    // nearest `tsconfig.json`; each package's covers `src/` and `tests/`, and
    // the package names resolve through `exports` to `src/`, so no build is
    // needed first.
    options: {
      typeAware: true,
      typeCheck: false,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  run: {
    tasks: {
      // Everything CI runs, in order; the integration suite needs a PostgreSQL (`PG*` or `DATABASE_URL_TEST`).
      ci: {
        command: [
          "vp check",
          "vp run check",
          "vp run -r test:unit",
          "vp run -r build",
          "vp run -r docgen",
          "pnpm audit --audit-level high",
          "vp run -r test:coverage",
          "vp run --filter ./packages/pulpit-drizzle-pg test:integration",
        ],
        cache: false,
      },
      // Every package's `check` and the dist-consumer declaration check; list a new package here.
      // Then the root configs (tsconfig.config.json), which no package covers.
      check: {
        command: "tsc -p tsconfig.config.json",
        dependsOn: [
          "@thomasfosterau/pulpit#check",
          "@thomasfosterau/pulpit-wordpress#check",
          "@thomasfosterau/pulpit-drizzle-pg#check",
          "@pulpit/dist-consumer#check",
        ],
        cache: false,
      },
      // The change-set audit, run by the pre-commit hook; fallow reads the coverage map.
      "fallow:audit": {
        command: "vp exec fallow audit --base origin/trunk --quiet",
        dependsOn: ["test:coverage"],
        cache: false,
      },
      fallow: {
        command: "vp exec fallow --summary",
        cache: false,
      },
      // The release job's publish script (.github/workflows/release.yml),
      // after every package's build: pnpm publishes each public package whose
      // version is not on npm yet, in dependency order, under OIDC trusted
      // publishing, rewriting `catalog:` / `workspace:` specifiers; then
      // `changeset git-tag` tags each version not tagged yet and reports the
      // tags to `changesets/action` through `CHANGESETS_OUTPUT`, which pushes
      // them and creates the GitHub releases. Uncached, so it sees the full
      // environment; a failed publish stops before tagging.
      release: {
        command: [
          "vp pm publish -r --access public --no-git-checks -- --ignore-scripts",
          "changeset git-tag",
        ],
        dependsOn: releaseBuilds,
        cache: false,
      },
      // What `release` would publish, without publishing or tagging.
      "release:dry-run": {
        command: "vp pm publish -r --access public --dry-run --no-git-checks -- --ignore-scripts",
        dependsOn: releaseBuilds,
        cache: false,
      },
      // One Istanbul map at coverage/coverage-final.json for fallow; thresholds are per package.
      "test:coverage": {
        command: "vp test run --coverage",
        cache: false,
      },
    },
  },
  test: {
    // One entry per package: each package's own vite.config.ts is a vitest
    // project, so the root run and the root coverage map cover them all.
    projects: ["packages/*/vite.config.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
