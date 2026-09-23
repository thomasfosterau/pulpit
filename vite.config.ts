/**
 * @copyright Thomas Foster
 *
 * Root workspace config. Owns the repo-wide format/lint/staged passes (read
 * statically by `vp fmt` / `vp lint` / `vp staged`) and the root `check`
 * aggregate.
 *
 * Copied from the effect-drizzle-ext library (itself from the gardeneria
 * application's root config): every comment that explains a load-bearing
 * decision is part of the standard and travels with the config.
 */

import { defineConfig } from "vite-plus";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@mpsuesser/oxlint-plugin-effect";

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit).
  staged: {
    "*.{js,ts,css,json,md}": "vp check --fix",
  },
  fmt: {
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
    extends: [recommended, effect.configs.recommended],
    categories: {
      correctness: "error",
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

      // ---- Effect preset: ported-code allowances ---------------------------
      // The modules under packages/*/src port behaviour the applications
      // carry today, which predates the Effect oxlint preset. The rules below
      // sit at `warn` so a faithful port stays committable while each site
      // stays reported; a new site is a defect, not headroom.
      "effect/imperative-loops": "warn",
      "effect/avoid-native-object-helpers": "warn",
      "effect/avoid-non-null-assertion": "warn",
      "effect/avoid-any": "warn",
      "effect/avoid-untagged-errors": "warn",
      "effect/avoid-direct-json": "warn",
      "effect/prefer-arr-match": "warn",
      "effect/no-length-comparison": "warn",
      "effect/prefer-arr-sort": "warn",
      "effect/avoid-try-catch": "warn",
      "effect/yield-in-for-loop": "warn",
      "effect/prefer-effect-is": "warn",
      "effect/avoid-expect-in-if": "warn",
      "effect/effect-run-in-body": "warn",
      "effect/prefer-effect-fn": "warn",
      "effect/avoid-direct-tag-checks": "warn",
      "effect/avoid-option-getorthrow": "warn",
      "effect/no-barrel-imports": "warn",
      "effect/throw-in-effect-gen": "warn",
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
      // Build/test configs are evaluated by Vite and Vitest in bare Node,
      // before any Effect runtime exists — there is no `Config` provider to
      // read from and no `FileSystem` service to call, so `process.env` and
      // `node:*` are the only things that work there. The Effect preset's
      // service rules have no satisfiable fix in these files.
      {
        files: ["**/vite.config.ts", "**/vitest.config.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/avoid-native-fetch": "off",
          "effect/effect-promise-vs-trypromise": "off",
        },
      },
    ],
    // Type-aware linting is intentionally disabled: type checking stays the
    // `check` tasks' job (native tsc, Effect-patched).
    options: {
      typeAware: false,
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
      // The CI typecheck gate, as one task: the package's `check` (which also
      // type-checks its type-level tests), plus the dist-consumer check that
      // type-checks a consumer fixture against the EMITTED declarations (the
      // declaration-emit hazard only shows up there). A pure graph node.
      check: {
        command: "echo 'check: every type gate green'",
        dependsOn: ["@thomasfosterau/pulpit#check", "@pulpit/dist-consumer#check"],
        cache: false,
      },
    },
  },
});
