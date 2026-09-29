import { type Db, ping } from "@tunelynk/db";
import type { HealthResponse } from "@tunelynk/shared";
import { Hono } from "hono";

export type AppDeps = { db: Db };

export function createApp({ db }: AppDeps) {
  const api = new Hono().get("/health", async (c) => {
    let dbStatus: HealthResponse["db"] = "up";
    try {
      await ping(db);
    } catch {
      dbStatus = "down";
    }
    return c.json({ ok: true, db: dbStatus } satisfies HealthResponse);
  });

  const app = new Hono().route("/api", api);

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
