import { serve } from "@hono/node-server";
import { createAppleCatalog } from "@tunelynk/connectors";
import { createDb } from "@tunelynk/db";
import { createLlmProvider, generate } from "@tunelynk/engine";
import { createApp } from "./app";
import { loadEnv } from "./env";
import { resolveRuntimePaths } from "./paths";
import { createRunExecutor } from "./runs/executor";
import { createRunRepo } from "./runs/repo";

const env = loadEnv();
const { webDir } = resolveRuntimePaths(import.meta.url);
const db = createDb(env.DATABASE_URL);
const repo = createRunRepo(db);

// One catalog per process: every run shares the Apple rate limiter.
const catalog = createAppleCatalog({
  teamId: env.APPLE_TEAM_ID,
  keyId: env.APPLE_KEY_ID,
  privateKey: env.APPLE_PRIVATE_KEY,
  storefront: env.APPLE_STOREFRONT,
  rps: env.APPLE_CATALOG_RPS,
  burst: env.APPLE_CATALOG_BURST,
  concurrency: env.APPLE_CATALOG_CONCURRENCY,
});
const llm = createLlmProvider({
  provider: env.LLM_PROVIDER,
  apiKey: env.LLM_API_KEY,
  model: env.LLM_MODEL_GUEST,
  maxTokens: env.LLM_MAX_TOKENS,
});
const executor = createRunExecutor({
  repo,
  engine: (input, onStage) => generate(input, { catalog, llm }, onStage),
});

const app = createApp({
  db,
  webDir,
  runs: {
    repo,
    executor,
    sessionSecret: env.SESSION_SECRET,
    secureCookies: env.COOKIE_SECURE,
    dailyBudgetMicros: Math.round(env.LLM_DAILY_BUDGET_USD * 1_000_000),
    model: env.LLM_MODEL_GUEST,
  },
});

// In-process runs die with the process; fail the ones a restart orphaned.
try {
  const failed = await repo.failStaleRuns(5 * 60_000);
  if (failed > 0) console.log(`Marked ${failed} interrupted run(s) as failed`);
} catch (err) {
  console.error("Boot recovery failed:", err);
}

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
