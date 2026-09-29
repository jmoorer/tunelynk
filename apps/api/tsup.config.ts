import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/migrate.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  // Workspace packages ship as TS source, so they must be bundled in.
  noExternal: [/^@tunelynk\//],
  clean: true,
});
