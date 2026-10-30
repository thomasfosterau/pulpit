/**
 * @copyright Thomas Foster
 *
 * Root workspace config. Owns the repo-wide format/lint/staged passes (read
 * statically by `vp fmt` / `vp lint` / `vp staged`), the root `check`
 * aggregate and the root `test:coverage` map.
 *
 * Copied from the effect-drizzle-ext library (itself from the gardeneria
 * application's root config): every comment that explains a load-bearing
 * decision is part of the standard and travels with the config.
 */

import { defineConfig } from "vite-plus";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit): format with fixes,
  // then lint WITHOUT fixes. With type-aware lint on, `vp check --fix` would
  // silently apply type-aware autofixes (even of rules at `warn`) to the
  // staged files at commit time, so the commit would differ from the tree
  // that was verified. `--no-error-on-unmatched-pattern` keeps a commit that
  // stages only files the linter skips (Markdown, JSON) from failing.
  staged: {
    "*.{js,ts,css,json,md}": [
      "vp check --fix --no-lint",
      "vp check --no-fmt --no-error-on-unmatched-pattern",
    ],
  },
  fmt: {
    ignorePatterns: ["**/dist/**", "**/docs/**", "**/coverage/**"],
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
    ignorePatterns: ["**/dist/**", "**/docs/**", "**/coverage/**", "**/node_modules/**"],
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
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "eslint/prefer-const": "warn",
      // `_tag` is the discriminant of every Effect tagged value and error;
      // `_links` and `_embedded` are the WordPress REST API's own (HAL) wire
      // members, which pulpit-wordpress must emit under exactly those names.
      "eslint/no-underscore-dangle": ["error", { allow: ["_tag", "_links", "_embedded"] }],
      // Effect code builds its operations, handlers, layers and schema
      // transformations as closures over their factory's arguments, and the
      // tests build their fixtures inside the `describe` they read as part
      // of; hoisting each one would scatter one definition across a module
      // (94 sites when the category was turned on).
      "unicorn/consistent-function-scoping": "off",
      // The module-as-namespace convention (`Option`, `Schema`, `Effect`, …)
      // and the generic `R` / `A` / `E` parameters mean names deliberately
      // recur in nested scopes.
      "eslint/no-shadow": "off",
      // Matches every `.map` call, `Effect.map` / `Option.map` over a single
      // value included, and spreading into a fresh object is how this library
      // builds its immutable records; mutating in place would break the
      // readonly types the rule's fix needs.
      "oxc/no-map-spread": "off",
      // Reports every spread of `Schema.JsonObject` (a plain-object index
      // signature, never a class instance) in the WordPress body builders as
      // a class spread: a false positive with no code-level fix.
      "typescript/no-misused-spread": "off",
      // `return yield* new SomeError(…)` is Effect's early-failure idiom in an
      // `Effect.fn` generator; the rule reads its `never` as a returned value
      // and then demands one on the success path too, where the operation's
      // published success type is `void`.
      "typescript/consistent-return": "off",
      // Its "explicit `undefined` is unnecessary on an optional parameter"
      // check contradicts the workspace convention (AGENTS.md → Conventions):
      // an optional parameter is spelled `x?: T | undefined`, like an
      // optional field, so a caller can forward its own optional value.
      "typescript/no-duplicate-type-constituents": "off",
      // Every type assertion here carries a `// SAFETY:` comment stating its
      // invariant, which `effect/require-safety-comment-for-type-assertion`
      // enforces; this rule would report each audited one again.
      "typescript/no-unsafe-type-assertion": "off",
      // Reports the exact-type-identity idiom (`<X>() => X extends A ? 1 : 2`)
      // the type-level tests and the dist-consumer check are built on, and
      // `asMemberTuple`'s deliberate generic return target in registry.ts.
      "typescript/no-unnecessary-type-parameters": "off",
      // The suites assert through helpers named `expect…` (`expectAgreement`
      // in tests/subtype.test.ts) as well as `expect` itself.
      "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expect*"] }],
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
      // `casting-awareness` is an awareness prompt, not a defect rule — it
      // fires on every `as`, including the narrowings a generic seam
      // structurally requires. Stays visible as a warning.
      "effect/casting-awareness": "warn",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import * as Option from
      // "effect/Option"`) this library shares with its consumers.
      "effect/prefer-namespace-imports": "off",
      // Every former ported-code allowance (the preset rules this workspace
      // once held at `warn` while ported modules were paid down) is at zero
      // and back at the preset's `error`; a new site is a defect.
      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      // The type-level test slot: an expected-error directive IS the assertion
      // there (each paired with its positive control), so the rule that bans
      // suppressions has nothing to protect in these files.
      {
        files: ["**/tests/**/*.types.ts"],
        rules: {
          "effect/avoid-ts-ignore": "off",
        },
      },
      // A test file IS the runtime boundary `effect-run-in-body` asks for
      // ("entrypoint/test harness"): its `run` helper is where each case's
      // Effect meets the Promise vitest awaits.
      {
        files: ["**/tests/**/*.test.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
        },
      },
      // The same boundary, seen by `@effect/tsgo`'s rules (raised from the
      // preset's level by the `suspicious` category): a test is the entry
      // point where its layer is provided, a fault-injection helper takes
      // whatever effect the case hands it (its error is the case's, not the
      // helper's), and a fixture row is `Record<string, unknown>` whose
      // columns the test itself wrote as strings, so `String(row[…])` is a
      // read, not a stringification of an object.
      {
        files: ["**/tests/**/*.ts"],
        rules: {
          "effecttsgo/strict-effect-provide": "off",
          "effecttsgo/any-unknown-in-error-context": "off",
          "typescript/no-base-to-string": "off",
        },
      },
      // The WordPress adapter's bindings are application callbacks whose
      // failures it cannot name: each binding's error channel is `unknown`
      // by contract (a published type), and `internal` turns every such
      // failure into a 500 `WpRestError` before it leaves the adapter, so
      // the `unknown` never reaches a caller.
      {
        files: ["packages/pulpit-wordpress/src/api.ts"],
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
        // Only the rule with a site (2, `VITEST_MAX_WORKERS` in
        // vite.package.ts) stays off; the other service rules had none.
        rules: {
          "effect/avoid-process-env": "off",
        },
      },
    ],
    // Type-aware linting through oxlint-tsgolint (bundled with Vite+, patched
    // by `effect-tsgo patch --oxlint`): `typeAware` turns on the rules that
    // need type information, `typeCheck` reports TypeScript diagnostics in
    // `vp check` too. The `check` tasks (native, Effect-patched tsc) stay the
    // type gate of record and add the Effect diagnostics. tsgolint types a
    // file with its nearest `tsconfig.json`; each package's covers `src/` and
    // `tests/`, and the package names resolve through `exports` to `src/`, so
    // no build is needed first.
    options: {
      typeAware: true,
      typeCheck: true,
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
      // The CI typecheck gate, as one task: each package's `check` (which also
      // type-checks its type-level tests), plus the dist-consumer check that
      // type-checks consumer fixtures against the EMITTED declarations of both
      // packages (the declaration-emit hazard only shows up there). A pure
      // graph node: a new workspace package's `check` must be added here, or
      // `vp run check` (and CI) never runs it.
      check: {
        command: "echo 'check: every type gate green'",
        dependsOn: [
          "@thomasfosterau/pulpit#check",
          "@thomasfosterau/pulpit-wordpress#check",
          "@pulpit/dist-consumer#check",
        ],
        cache: false,
      },
      // Every package's unit suite under one Istanbul coverage map
      // (`coverage/coverage-final.json`), which `fallow audit` reads for exact
      // per-function CRAP scores (`health.coverage` in .fallowrc.json).
      // Without it fallow estimates every function as uncovered, and any
      // function with cyclomatic complexity ≥ 5 fails the gate on its own.
      // Run this before `fallow audit` (the PreToolUse fallow gate runs the
      // audit on `git commit` / `git push` but never refreshes this map). The
      // per-package thresholds stay on each package's own `test:coverage`.
      // Each package's `exports` point at `src/`, so no build edge is needed.
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
