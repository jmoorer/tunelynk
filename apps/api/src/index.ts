import { serve } from "@hono/node-server";
import { createAppleCatalog } from "@tunelynk/connectors";
import { createDb } from "@tunelynk/db";
import { costMicros, createLlmProvider, generate } from "@tunelynk/engine";
import { createApp } from "./app";
import { createLoginTokenRepo } from "./auth/loginTokens";
import { createMailer } from "./auth/mailer";
import { createSessionRepo } from "./auth/sessions";
import { loadEnv } from "./env";
import { resolveRuntimePaths } from "./paths";
import { createRunExecutor, RUN_DEADLINE_MS } from "./runs/executor";
import { createRunRepo } from "./runs/repo";
import { startStaleRunSweeper } from "./runs/sweeper";

const env = loadEnv();
if (env.EMAIL.provider === "console") {
  console.warn("EMAIL_PROVIDER=console: sign-in links are logged, not sent");
}
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
  auth: {
    sessions: createSessionRepo(db),
    sessionSecret: env.SESSION_SECRET,
    secureCookies: env.COOKIE_SECURE,
  },
  email: {
    loginTokens: createLoginTokenRepo(db),
    mailer: createMailer(env.EMAIL),
    appUrl: env.APP_URL,
  },
  runs: {
    repo,
    executor,
    dailyBudgetMicros: Math.round(env.LLM_DAILY_BUDGET_USD * 1_000_000),
    // Worst case per run: two LLM attempts, each up to ~2k input tokens and
    // LLM_MAX_TOKENS output.
    reservePerRunMicros: costMicros({
      model: env.LLM_MODEL_GUEST,
      inputTokens: 2 * 2_000,
      outputTokens: 2 * env.LLM_MAX_TOKENS,
    }),
    model: env.LLM_MODEL_GUEST,
  },
});

// No run outlives the executor deadline; fail orphans at boot and every minute.
startStaleRunSweeper({
  repo,
  olderThanMs: RUN_DEADLINE_MS + 60_000,
  intervalMs: 60_000,
});

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
