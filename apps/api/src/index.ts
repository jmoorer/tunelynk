import { serve } from "@hono/node-server";
import { createDb } from "@tunelynk/db";
import { createApp } from "./app";
import { loadEnv } from "./env";
import { resolveRuntimePaths } from "./paths";

const env = loadEnv();
const { webDir } = resolveRuntimePaths(import.meta.url);
const db = createDb(env.DATABASE_URL);
const app = createApp({ db, webDir });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  if (webDir) console.log(`Serving web build from ${webDir}`);
});

// Dokploy stops the old container with SIGTERM on redeploy.
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await db.$client.end({ timeout: 5 });
    process.exit(0);
  });
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
