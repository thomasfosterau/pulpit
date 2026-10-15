import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // Type-checks the emitted declarations; depends on the package's build
      // so `vp run check` at the root always exercises fresh `dist/` output.
      check: {
        command: "tsc -p tsconfig.json",
        dependsOn: ["@thomasfosterau/pulpit#build"],
        input: [
          { auto: true },
          "!node_modules/**",
          // `tsc` probes for `packages/pulpit/node_modules` while resolving
          // the emitted declarations' imports; vitest creates it (`.vite`),
          // so without this exact-path exclusion the check missed once after
          // every `test:unit` (pulpit#66). Only the directory entry is
          // dropped: the probes for packages beneath it stay tracked.
          { pattern: "!packages/pulpit/node_modules", base: "workspace" as const },
          { pattern: "packages/*/dist/**", base: "workspace" as const },
        ],
        output: [],
      },
    },
  },
});
