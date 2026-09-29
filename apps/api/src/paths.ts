import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// moduleUrl is import.meta.url of apps/api/src/*.ts (dev) or apps/api/dist/*.js
// (prod). Both are two levels below apps/, so the same relative paths work.
export function resolveRuntimePaths(moduleUrl: string) {
  const migrationsDir = fileURLToPath(
    new URL("../../../packages/db/migrations", moduleUrl),
  );
  const webDist = fileURLToPath(new URL("../../web/dist", moduleUrl));
  const webDir = existsSync(join(webDist, "index.html")) ? webDist : undefined;
  return { migrationsDir, webDir };
}
