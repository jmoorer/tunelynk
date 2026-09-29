import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Db, ping } from "@tunelynk/db";
import type { HealthResponse } from "@tunelynk/shared";
import { Hono } from "hono";

export type AppDeps = {
  db: Db;
  // Built web SPA (must contain index.html). Unset in dev and tests.
  webDir?: string;
};

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");
// Last segment has a dot: a file request, so a miss is a real 404, not a client route.
const looksLikeFile = (path: string) => /\.[^/]*$/.test(path);

export function createApp({ db, webDir }: AppDeps) {
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

  const indexHtml = webDir
    ? readFileSync(join(webDir, "index.html"), "utf8")
    : undefined;

  if (webDir) {
    const assets = serveStatic({ root: webDir });
    app.use("*", (c, next) =>
      isApiPath(c.req.path) ? next() : assets(c, next),
    );
  }

  app.notFound((c) => {
    const { method, path } = c.req;
    const spaRoute =
      (method === "GET" || method === "HEAD") &&
      !isApiPath(path) &&
      !looksLikeFile(path);
    if (indexHtml && spaRoute) return c.html(indexHtml);
    return c.json({ error: "Not Found" }, 404);
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
