import { migrateDb } from "@tunelynk/db";
import { loadMigrateEnv } from "./env";
import { resolveRuntimePaths } from "./paths";

// Runs before the server in the deploy start command; a non-zero exit
// stops the server from starting, so the deploy fails and the old container stays.
const env = loadMigrateEnv();
const { migrationsDir } = resolveRuntimePaths(import.meta.url);

try {
  await migrateDb(env.DATABASE_URL, migrationsDir);
  console.log("Migrations applied");
} catch (err) {
  console.error("Migration failed:", err);
  process.exit(1);
}
