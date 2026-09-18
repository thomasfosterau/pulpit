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
          { pattern: "packages/*/dist/**", base: "workspace" as const },
        ],
        output: [],
      },
    },
  },
});
