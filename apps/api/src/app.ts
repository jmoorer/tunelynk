import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Db, ping } from "@tunelynk/db";
import type { HealthResponse } from "@tunelynk/shared";
import { Hono } from "hono";
import { type AppleDeps, appleRoutes } from "./auth/appleRoutes";
import { type EmailDeps, emailRoutes } from "./auth/email";
import {
  type AuthDeps,
  type AuthEnv,
  sessionMiddleware,
} from "./auth/middleware";
import { authRoutes, meRoutes } from "./auth/routes";
import { type RunsDeps, runsRoutes } from "./runs/routes";

export type AppDeps = {
  db: Db;
  // Built web SPA (must contain index.html). Unset in dev and tests.
  webDir?: string;
  auth: AuthDeps;
  email: EmailDeps;
  apple: AppleDeps;
  runs: RunsDeps;
};

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");
// Last segment has a dot: a file request, so a miss is a real 404, not a client route.
const looksLikeFile = (path: string) => /\.[^/]*$/.test(path);
// Vite content-hashes everything under /assets, so those never change. Anything
// else (index.html above all) must be revalidated, or a redeploy leaves browsers
// on an old index.html that points at assets which no longer exist.
const cacheControl = (path: string) =>
  path.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";

export function createApp({ db, webDir, auth, email, apple, runs }: AppDeps) {
  const api = new Hono<AuthEnv>()
    .use("*", sessionMiddleware(auth))
    .get("/health", async (c) => {
      let dbStatus: HealthResponse["db"] = "up";
      try {
        await ping(db);
      } catch {
        dbStatus = "down";
      }
      return c.json({ ok: true, db: dbStatus } satisfies HealthResponse);
    })
    .route("/me", meRoutes(auth))
    .route(
      "/auth",
      authRoutes(auth, { email: true, apple: apple.client !== null }),
    )
    .route("/auth/email", emailRoutes({ ...email, db, auth }))
    .route("/auth/apple", appleRoutes({ ...apple, db, auth }))
    .route("/runs", runsRoutes(runs, auth));

  const app = new Hono().route("/api", api);

  const indexHtml = webDir
    ? readFileSync(join(webDir, "index.html"), "utf8")
    : undefined;

  if (webDir) {
    const assets = serveStatic({ root: webDir });
    app.use("*", async (c, next) => {
      if (isApiPath(c.req.path)) return next();
      const res = await assets(c, next);
      res?.headers.set("Cache-Control", cacheControl(c.req.path));
      return res;
    });
  }

  app.notFound((c) => {
    const { method, path } = c.req;
    const spaRoute =
      (method === "GET" || method === "HEAD") &&
      !isApiPath(path) &&
      !looksLikeFile(path);
    if (indexHtml && spaRoute) {
      return c.html(indexHtml, 200, { "Cache-Control": "no-cache" });
    }
    return c.json({ error: "Not Found" }, 404);
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
