import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // Type-checks the emitted declarations of both workspace packages;
      // depends on each package's build so `vp run check` at the root always
      // exercises fresh `dist/` output.
      check: {
        command: "tsc -p tsconfig.check.json",
        dependsOn: ["@thomasfosterau/pulpit#build", "@thomasfosterau/pulpit-wordpress#build"],
        cache: {
          input: [
            { auto: true },
            "!node_modules/**",
            // `tsc` probes for `packages/*/node_modules` while resolving
            // the emitted declarations' imports; vitest creates it (`.vite`),
            // so without this exact-path exclusion the check missed once after
            // every `test:unit` (pulpit#66). Only the directory entry is
            // dropped, and when the cache was recorded without that directory
            // the entry was the only signal of a package appearing in it, so
            // the exclusion relies on the lockfile input below to catch a
            // dependency change.
            { pattern: "!packages/pulpit/node_modules", base: "workspace" as const },
            { pattern: "!packages/pulpit-wordpress/node_modules", base: "workspace" as const },
            { pattern: "packages/*/dist/**", base: "workspace" as const },
            { pattern: "pnpm-lock.yaml", base: "workspace" as const },
          ],
          output: [],
        },
      },
    },
  },
});
