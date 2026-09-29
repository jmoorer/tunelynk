import { serve } from "@hono/node-server";
import { createDb } from "@tunelynk/db";
import { createApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();
const app = createApp({ db: createDb(env.DATABASE_URL) });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
