# Dokploy Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tunelynk deployable as a single Nixpacks app on Dokploy: the API applies Drizzle migrations before it starts, serves the built web SPA alongside `/api`, and shuts down cleanly.

**Architecture:** `packages/db` gains `migrateDb()`. `apps/api` gets a second tsup entry (`migrate.ts`) that runs migrations, and `createApp` can optionally serve `apps/web/dist` with an SPA fallback. Nixpacks builds the whole repo and starts it with `node apps/api/dist/migrate.js && exec node apps/api/dist/index.js`. The Dokploy side (Postgres service, env, domain, health check) is a manual checklist in `docs/deploy.md`.

**Tech Stack:** pnpm 11 + Turborepo, Hono on `@hono/node-server` 2.1, drizzle-orm 0.45 (postgres-js), tsup, Vitest 5, Nixpacks 1.41, Dokploy.

**Spec:** `docs/superpowers/specs/2026-09-29-dokploy-deploy-design.md`

### Deviations from the spec (flagged for review)

1. **Migrations run as a separate entry point in the start command, not inside `index.ts`.** The spec's success criterion says local dev must behave exactly as before, and the scaffold lets the API boot with the DB down (see `packages/db/src/client.test.ts`). Migrating inside `index.ts` would make `pnpm dev` exit when Postgres is not running. A failed migration still stops the app from starting (`&&`), so the deploy still fails.
2. **No `NODE_ENV=production` env var.** Nixpacks/Dokploy expose env vars at build time, and pnpm skips `devDependencies` when `NODE_ENV=production`, which would break `tsup`/`vite`. The app does not read `NODE_ENV`. The install command also forces `NODE_ENV=development` as a guard.
3. **No change to `createDb`.** It already exposes the client as `db.$client`, which is enough for a clean shutdown.

## Global Constraints

- Node 22 (`NIXPACKS_NODE_VERSION = "22"`; repo `engines.node` is `>=22.9`), pnpm `11.5.1` via corepack (`packageManager` field).
- Postgres 17, Dokploy-managed, internal network only.
- Domain `tunelynk.bytmoor.com` → container port `3000`, HTTPS via Let's Encrypt.
- Env vars in Dokploy: `DATABASE_URL`, `PORT=3000`. Nothing else.
- Start command: `node apps/api/dist/migrate.js && exec node apps/api/dist/index.js`.
- `AppType` (consumed by the web's `hono/client`) must not change.
- `pnpm dev` and `pnpm check` must behave as before; the API must still boot with the DB down in dev.
- Commit messages: conventional (`feat(db): …`, `feat(api): …`, `chore: …`, `docs: …`), ending with the `Co-Authored-By` line from the session.

## Review Focus

1. **Stale hashed asset after a redeploy** (`/assets/index-OLD.js`): must return 404, not `index.html` with a 200 (otherwise the browser hits a JS syntax error). Pinned in Task 2.
2. **Path traversal** (`/%2e%2e/secret.txt`): must not serve files outside `webDir`. Pinned in Task 2.
3. **Unknown API route** (`GET /api/nope`, or a POST to an SPA path): must return a JSON 404, never the SPA HTML. Pinned in Task 2.
4. **First deploy against an empty database**: every migration applies, and a second run is a no-op. Pinned in Task 1.
5. **Deploy with the DB unreachable, or the migrations folder missing from the image**: `migrateDb` must reject promptly (so the process exits 1) and not hang. Pinned in Task 1.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/db/src/migrate.ts` | Create | `migrateDb(url, folder)`: one-shot migration run on its own connection |
| `packages/db/src/migrate.test.ts` | Create | Unit: rejects fast on a bad folder or an unreachable DB |
| `packages/db/src/migrate.integration.test.ts` | Create | Integration: fresh temp DB → all migrations applied, idempotent |
| `packages/db/src/index.ts` | Modify | Re-export `migrate` |
| `packages/db/package.json` | Modify | Split `test` / `test:integration` scripts |
| `packages/db/vitest.config.ts` | Create | Load root `.env` for the integration test |
| `packages/db/tsconfig.json` | Modify | Include `vitest.config.ts` |
| `apps/api/src/app.ts` | Modify | Optional `webDir`: static assets, SPA fallback, JSON 404s |
| `apps/api/src/app.web.test.ts` | Create | Unit tests for web serving and 404 rules |
| `apps/api/src/paths.ts` | Create | `resolveRuntimePaths(moduleUrl)`: migrations dir and optional web dir |
| `apps/api/src/paths.test.ts` | Create | Unit tests for path resolution |
| `apps/api/src/migrate.ts` | Create | Entry point: load env → `migrateDb` → exit code |
| `apps/api/src/index.ts` | Modify | Pass `webDir`; graceful SIGTERM/SIGINT shutdown |
| `apps/api/tsup.config.ts` | Modify | Add `src/migrate.ts` entry |
| `apps/api/package.json` | Modify | Add `migrate` script |
| `nixpacks.toml` | Create | Build/start config |
| `.dockerignore` | Create | Keep host `node_modules`, `dist`, `.env` out of the image |
| `docs/deploy.md` | Create | Dokploy setup checklist and operations notes |
| `README.md` | Modify | Link to `docs/deploy.md` |

---

### Task 1: `migrateDb` in `packages/db`

**Files:**
- Create: `packages/db/src/migrate.ts`, `packages/db/src/migrate.test.ts`, `packages/db/src/migrate.integration.test.ts`, `packages/db/vitest.config.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/package.json`, `packages/db/tsconfig.json`

**Interfaces:**
- Consumes: nothing new. Migrations live in `packages/db/migrations` (journal at `migrations/meta/_journal.json`).
- Produces: `export async function migrateDb(url: string, migrationsFolder: string): Promise<void>`, exported from `@tunelynk/db`. Resolves when all pending migrations are applied; rejects on any error; always closes its connection.

- [ ] **Step 1: Split db test scripts and load `.env` for integration tests**

`packages/db/package.json`, `scripts` becomes:

```json
"scripts": {
  "typecheck": "tsc --noEmit",
  "lint": "biome check .",
  "test": "vitest run --exclude \"src/**/*.integration.test.ts\"",
  "test:integration": "vitest run integration",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate"
}
```

Create `packages/db/vitest.config.ts` (same pattern as `apps/api/vitest.config.ts`):

```ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Load the root .env (if present) so the integration test can reach Postgres.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({});
```

`packages/db/tsconfig.json`:

```json
{
  "extends": "@tunelynk/config/tsconfig.node.json",
  "include": ["src", "drizzle.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 2: Write the failing unit test**

Create `packages/db/src/migrate.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrateDb } from "./index";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
// Port 1 refuses connections immediately.
const deadUrl = "postgres://nobody:nobody@127.0.0.1:1/nothing";

describe("migrateDb", () => {
  it("rejects when the migrations folder is missing", async () => {
    await expect(migrateDb(deadUrl, "/nonexistent/migrations")).rejects.toThrow();
  });

  it("rejects promptly when Postgres is unreachable", async () => {
    await expect(migrateDb(deadUrl, migrationsFolder)).rejects.toThrow();
  }, 15_000);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @tunelynk/db test`
Expected: FAIL. `migrateDb` is not exported from `./index` (TypeError: migrateDb is not a function).

- [ ] **Step 4: Implement `migrateDb`**

Create `packages/db/src/migrate.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Own single connection, closed afterwards, so it never lingers in the app pool.
export async function migrateDb(
  url: string,
  migrationsFolder: string,
): Promise<void> {
  const client = postgres(url, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}
```

`packages/db/src/index.ts`:

```ts
export * from "./client";
export * from "./migrate";
export * from "./schema";
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `pnpm --filter @tunelynk/db test`
Expected: PASS. `migrate.test.ts` (2 tests) and `client.test.ts` (2 tests) both pass.

- [ ] **Step 6: Write the integration test (fresh DB + idempotence)**

Create `packages/db/src/migrate.integration.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDb } from "./index";

const url = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const journal = JSON.parse(
  readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"),
) as { entries: unknown[] };

// A throwaway database, so this proves a first deploy against an empty Postgres.
describe.skipIf(!url)("migrateDb against a fresh database", () => {
  const admin = postgres(url ?? "", { max: 1, onnotice: () => {} });
  const name = `tunelynk_migrate_test_${process.pid}_${Date.now()}`;
  let testUrl = "";

  beforeAll(async () => {
    await admin.unsafe(`create database "${name}"`);
    const u = new URL(url ?? "");
    u.pathname = `/${name}`;
    testUrl = u.toString();
  });

  afterAll(async () => {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  });

  it("applies every migration, and a second run is a no-op", async () => {
    await migrateDb(testUrl, migrationsFolder);
    await migrateDb(testUrl, migrationsFolder);

    const check = postgres(testUrl, { max: 1 });
    try {
      const [{ n }] = await check<{ n: number }[]>`
        select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(n).toBe(journal.entries.length);
      const [{ t }] = await check<{ t: string | null }[]>`
        select to_regclass('public.app_meta')::text as t`;
      expect(t).toBe("app_meta");
    } finally {
      await check.end();
    }
  });
});
```

- [ ] **Step 7: Run the integration test**

Run: `pnpm db:up && pnpm --filter @tunelynk/db test:integration`
Expected: PASS (1 test). If it fails with `permission denied to create database`, the local role lacks CREATEDB. The compose `POSTGRES_USER` is a superuser, so that means `.env` points somewhere else; fix `.env`, not the test.

- [ ] **Step 8: Typecheck, lint, commit**

Run: `pnpm --filter @tunelynk/db typecheck && pnpm --filter @tunelynk/db lint`
Expected: no errors (run `pnpm format` first if Biome reports formatting).

```bash
git add packages/db
git commit -m "feat(db): add migrateDb for applying migrations at deploy time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Serve the web build from the API

**Files:**
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/app.web.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export type AppDeps = { db: Db; webDir?: string }` and `createApp(deps: AppDeps)`. `webDir` is an absolute path to a directory that contains `index.html`; `createApp` reads that file synchronously and throws if it is missing. `AppType` is unchanged.

Behaviour when `webDir` is set:
- `/api` and `/api/*`: API routes only; unmatched → `404 {"error":"Not Found"}`.
- Other paths: a file in `webDir` is served if it exists (`/` → `index.html`).
- Otherwise, a `GET`/`HEAD` whose last path segment has no `.` → `index.html` (200).
- Everything else → `404 {"error":"Not Found"}`.

When `webDir` is unset, every unmatched path → `404 {"error":"Not Found"}` (previously Hono's plain-text 404).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/app.web.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@tunelynk/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

const fakeDb = { execute: async () => [] } as unknown as Db;
const INDEX = "<!doctype html><title>tunelynk</title>";

let root: string;
let webDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tunelynk-web-"));
  webDir = join(root, "dist");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), INDEX);
  writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)");
  // Outside webDir: must never be reachable.
  writeFileSync(join(root, "secret.txt"), "TOP SECRET");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("createApp with webDir", () => {
  const app = () => createApp({ db: fakeDb, webDir });

  it("serves index.html at /", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  });

  it("falls back to index.html for client-side routes", async () => {
    const res = await app().request("/playlists/123");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe(INDEX);
  });

  it("serves built assets with their content type", async () => {
    const res = await app().request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe("console.log(1)");
  });

  it("still serves the API", async () => {
    const res = await app().request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up" });
  });

  it("returns JSON 404 for unknown API routes, not the SPA", async () => {
    const res = await app().request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });

  it("returns 404 for a missing asset (stale hash after redeploy), not the SPA", async () => {
    const res = await app().request("/assets/index-OLD.js");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });

  it("does not fall back to the SPA for non-GET requests", async () => {
    const res = await app().request("/playlists", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });

  it("never serves files outside webDir", async () => {
    for (const path of ["/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/%2e%2e/%2e%2e/secret.txt"]) {
      const res = await app().request(path);
      expect(await res.text()).not.toContain("TOP SECRET");
    }
  });
});

describe("createApp without webDir", () => {
  it("returns JSON 404 for /", async () => {
    const res = await createApp({ db: fakeDb }).request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tunelynk/api test -- app.web`
Expected: FAIL. `/` returns 404 plain text, and a TS/type error on the `webDir` property.

- [ ] **Step 3: Implement**

Replace `apps/api/src/app.ts` with:

```ts
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
    app.use("*", (c, next) => (isApiPath(c.req.path) ? next() : assets(c, next)));
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
```

- [ ] **Step 4: Run all API unit tests**

Run: `pnpm --filter @tunelynk/api test`
Expected: PASS. The new `app.web.test.ts` (9 tests), plus the existing `app.test.ts` and `env.test.ts`, which are unchanged. The existing `onError` test registers `/api/boom` after `createApp`; that still works because no catch-all route is registered, only `notFound`.

- [ ] **Step 5: Confirm the web client types are unaffected**

Run: `pnpm --filter @tunelynk/web typecheck && pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/app.web.test.ts
git commit -m "feat(api): optionally serve the built web SPA with JSON 404s for API and missing files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Runtime entry points (paths, migrate entry, shutdown)

**Files:**
- Create: `apps/api/src/paths.ts`, `apps/api/src/paths.test.ts`, `apps/api/src/migrate.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/tsup.config.ts`, `apps/api/package.json`

**Interfaces:**
- Consumes: `migrateDb(url, migrationsFolder)` from `@tunelynk/db` (Task 1); `createApp({ db, webDir? })` (Task 2); existing `loadEnv()` and `createDb()` (whose return value has `$client.end()`).
- Produces: `resolveRuntimePaths(moduleUrl: string): { migrationsDir: string; webDir: string | undefined }`; build outputs `apps/api/dist/index.js` and `apps/api/dist/migrate.js`; script `pnpm --filter @tunelynk/api migrate`.

Both `src/*.ts` (tsx in dev) and `dist/*.js` (prod) sit two levels below `apps/`, so the same relative URLs work from either.

- [ ] **Step 1: Write the failing path tests**

Create `apps/api/src/paths.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimePaths } from "./paths";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

// Mimic the repo layout: <root>/apps/api/dist/index.js
function fakeRepo(withWebBuild: boolean) {
  tmp = mkdtempSync(join(tmpdir(), "tunelynk-paths-"));
  mkdirSync(join(tmp, "apps/api/dist"), { recursive: true });
  if (withWebBuild) {
    mkdirSync(join(tmp, "apps/web/dist"), { recursive: true });
    writeFileSync(join(tmp, "apps/web/dist/index.html"), "<!doctype html>");
  }
  return { root: tmp, moduleUrl: pathToFileURL(join(tmp, "apps/api/dist/index.js")).href };
}

describe("resolveRuntimePaths", () => {
  it("finds the real migrations folder from the api source directory", () => {
    const { migrationsDir } = resolveRuntimePaths(import.meta.url);
    expect(existsSync(join(migrationsDir, "meta/_journal.json"))).toBe(true);
  });

  it("returns webDir when apps/web/dist/index.html exists", () => {
    const { root, moduleUrl } = fakeRepo(true);
    const { webDir, migrationsDir } = resolveRuntimePaths(moduleUrl);
    expect(webDir).toBe(join(root, "apps/web/dist"));
    expect(migrationsDir).toBe(join(root, "packages/db/migrations"));
  });

  it("returns webDir undefined when there is no web build", () => {
    const { moduleUrl } = fakeRepo(false);
    expect(resolveRuntimePaths(moduleUrl).webDir).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tunelynk/api test -- paths`
Expected: FAIL. `Cannot find module './paths'`.

- [ ] **Step 3: Implement `paths.ts`**

Create `apps/api/src/paths.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @tunelynk/api test -- paths`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the migrate entry point**

Create `apps/api/src/migrate.ts`:

```ts
import { migrateDb } from "@tunelynk/db";
import { loadEnv } from "./env";
import { resolveRuntimePaths } from "./paths";

// Runs before the server in the deploy start command; a non-zero exit
// stops the server from starting, so the deploy fails and the old container stays.
const env = loadEnv();
const { migrationsDir } = resolveRuntimePaths(import.meta.url);

try {
  await migrateDb(env.DATABASE_URL, migrationsDir);
  console.log("Migrations applied");
} catch (err) {
  console.error("Migration failed:", err);
  process.exit(1);
}
```

`apps/api/tsup.config.ts`:

```ts
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
```

In `apps/api/package.json` `scripts`, add after `"start"`:

```json
"migrate": "node --env-file-if-exists=../../.env dist/migrate.js",
```

- [ ] **Step 6: Wire `webDir` and graceful shutdown into `index.ts`**

Replace `apps/api/src/index.ts` with:

```ts
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
```

- [ ] **Step 7: Smoke-test the production bundle locally**

Run:

```bash
pnpm db:up
pnpm build
ls apps/api/dist            # expect index.js and migrate.js (plus shared chunk files)
pnpm --filter @tunelynk/api migrate    # expect "Migrations applied"
pnpm --filter @tunelynk/api start &
sleep 2
curl -s localhost:3000/api/health      # expect {"ok":true,"db":"up"}
curl -s localhost:3000/ | head -c 200  # expect the Vite index.html (<!doctype html>…)
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/assets/nope.js  # expect 404
kill %1                                 # expect "SIGTERM received, shutting down" and prompt exit
```

Also confirm dev is unaffected: `pnpm db:down && pnpm dev`. The API must still start and log `API listening`, and the health page at :5173 shows DB down. Then `pnpm db:up`.

- [ ] **Step 8: Full check and commit**

Run: `pnpm check`
Expected: all tasks pass, including both integration tests.

```bash
git add apps/api
git commit -m "feat(api): add migrate entry point, serve web build, and shut down gracefully

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Nixpacks build config and container verification

**Files:**
- Create: `nixpacks.toml`, `.dockerignore`

**Interfaces:**
- Consumes: `pnpm build` producing `apps/api/dist/{index,migrate}.js` and `apps/web/dist` (Task 3).
- Produces: an image whose start command is `node apps/api/dist/migrate.js && exec node apps/api/dist/index.js`, listening on `$PORT`.

- [ ] **Step 1: Add the config files**

`nixpacks.toml`:

```toml
[variables]
NIXPACKS_NODE_VERSION = "22"

[phases.install]
# NODE_ENV=production (if set at build time) would make pnpm skip devDependencies,
# which the build needs (tsup, vite).
cmds = ["corepack enable", "NODE_ENV=development pnpm install --frozen-lockfile"]

[phases.build]
cmds = ["pnpm build"]

[start]
# Migrations first; exec replaces the shell so node itself receives SIGTERM.
cmd = "node apps/api/dist/migrate.js && exec node apps/api/dist/index.js"
```

`.dockerignore`:

```
.git
.turbo
**/node_modules
**/dist
.env
.superpowers
```

- [ ] **Step 2: Build the image locally**

Run:

```bash
command -v nixpacks || brew install nixpacks
nixpacks build . --name tunelynk-nixpacks
```

Expected: the build succeeds. The install phase log shows pnpm `11.5.1`, and the `pnpm build` phase builds `@tunelynk/api` and `@tunelynk/web`.

If it fails because of pnpm/corepack (e.g. pnpm 9/10 from Nix is used, `ERR_PNPM_BAD_PM_VERSION`, or corepack is missing), go to Step 5 (fallback). Do not work around it by changing `packageManager`.

- [ ] **Step 3: Run the container against local Postgres**

```bash
pnpm db:up
docker run -d --name tunelynk-smoke -p 3100:3000 -e PORT=3000 \
  -e DATABASE_URL=postgres://tunelynk:tunelynk@host.docker.internal:5432/tunelynk \
  tunelynk-nixpacks
sleep 3
docker logs tunelynk-smoke                # expect "Migrations applied" then "API listening"
curl -s localhost:3100/api/health         # expect {"ok":true,"db":"up"}
curl -s localhost:3100/ | head -c 100     # expect <!doctype html>
docker exec tunelynk-smoke node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; echo "healthcheck exit=$?"   # expect 0
time docker stop tunelynk-smoke           # expect well under 10s, logs show "SIGTERM received"
docker logs tunelynk-smoke | tail -2
docker rm tunelynk-smoke
```

Then the failure path: `docker run --rm -e DATABASE_URL=postgres://x:x@127.0.0.1:1/x tunelynk-nixpacks; echo "exit=$?"`. Expect `Migration failed:` and a non-zero exit, with no "API listening".

- [ ] **Step 4: Commit (Nixpacks path)**

```bash
git add nixpacks.toml .dockerignore
git commit -m "chore: add Nixpacks build config for Dokploy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip Step 5.

- [ ] **Step 5: Fallback only if Step 2 failed. Dockerfile instead of Nixpacks**

Delete `nixpacks.toml`, keep `.dockerignore`, and create `Dockerfile`:

```dockerfile
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN NODE_ENV=development pnpm install --frozen-lockfile && pnpm build
EXPOSE 3000
CMD ["sh", "-c", "node apps/api/dist/migrate.js && exec node apps/api/dist/index.js"]
```

Run `docker build -t tunelynk-nixpacks .` and repeat Step 3 exactly. Commit:

```bash
git add Dockerfile .dockerignore
git rm --cached nixpacks.toml 2>/dev/null || true
git commit -m "chore: add Dockerfile for Dokploy (Nixpacks cannot install pnpm 11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

In Task 5, write "Build type: Dockerfile" instead of "Nixpacks".

---

### Task 5: Deployment docs

**Files:**
- Create: `docs/deploy.md`
- Modify: `README.md` (Getting started section)

**Interfaces:**
- Consumes: the start command and build type from Task 4, and the health check command verified in Task 4 Step 3.
- Produces: the checklist the user follows in the Dokploy UI.

- [ ] **Step 1: Write `docs/deploy.md`**

```markdown
# Deploying to Dokploy

Tunelynk runs as one Dokploy application (API + built web SPA) plus a
Dokploy-managed Postgres, at https://tunelynk.bytmoor.com. Every push to
`main` deploys.

## How a deploy works

1. Nixpacks builds the repo using `nixpacks.toml`: `pnpm install`, then `pnpm build`.
2. The container starts with
   `node apps/api/dist/migrate.js && exec node apps/api/dist/index.js`.
   Pending Drizzle migrations apply first. If they fail, the process exits 1,
   the new container never becomes healthy, and the old one keeps serving.
3. The API serves `/api/*` and the web build (`apps/web/dist`) with an SPA fallback.

## One-time setup

1. **Postgres.** In the Tunelynk project: Create Service → Database → Postgres 17.
   Let Dokploy generate the credentials. Leave the external port unset. Copy the
   **internal** connection URL. If a backup destination is configured, enable
   scheduled backups.
2. **Application.** Create Service → Application.
   - Provider: GitHub, repo `jmoorer/tunelynk`, branch `main`.
   - Build type: Nixpacks.
   - Auto deploy: on.
3. **Environment.**
   ```
   DATABASE_URL=<internal Postgres URL from step 1>
   PORT=3000
   ```
   Do not set `NODE_ENV=production`. The build does not need it, and pnpm
   would skip the devDependencies the build requires.
4. **Domain.** Host `tunelynk.bytmoor.com`, container port `3000`, HTTPS on,
   certificate Let's Encrypt. In DNS, add an A record for `tunelynk.bytmoor.com`
   pointing at the Dokploy server (skip if a `*.bytmoor.com` wildcard already does).
5. **Health check.** Advanced → Swarm Settings → Health Check:
   ```json
   {
     "Test": ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
     "Interval": 10000000000,
     "Timeout": 5000000000,
     "StartPeriod": 30000000000,
     "Retries": 3
   }
   ```
   (Durations are nanoseconds.) This uses `node` because the image may not include `curl`.
6. Deploy. Check that https://tunelynk.bytmoor.com shows `API: up / DB: up`.

## Operations

- **Logs:** Dokploy → app → Logs. A deploy logs `Migrations applied` and then `API listening`.
- **Rollback:** redeploy an earlier commit from Deployments, or revert on `main`.
  Migrations do not roll back, so write them to be backward compatible.
- **Postgres extensions:** the local `docker/postgres/init.sql` creates `pg_trgm`,
  but the Dokploy database does not run it. Any migration that relies on an
  extension must include `CREATE EXTENSION IF NOT EXISTS …` itself.
- **Replicas:** keep this at 1. Migrations run on container start and are not
  coordinated across instances.
```

If Task 4 used the fallback, change "Nixpacks builds the repo using `nixpacks.toml`" to "Docker builds the repo using `Dockerfile`" and "Build type: Nixpacks" to "Build type: Dockerfile".

- [ ] **Step 2: Link it from the README**

In `README.md`, directly after the scripts table (before the `Layout:` line), add:

```markdown
Deployment: see [docs/deploy.md](docs/deploy.md) (Dokploy, `tunelynk.bytmoor.com`).
```

Do not add the api-level `migrate` script to the table; it lists root scripts only.

- [ ] **Step 3: Commit**

```bash
git add docs/deploy.md README.md
git commit -m "docs: add Dokploy deployment guide

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Hand-off (user, in Dokploy)

Not code. After the branch is merged to `main`:

- [ ] The user follows `docs/deploy.md` steps 1–6.
- [ ] Verify: `curl -s https://tunelynk.bytmoor.com/api/health` → `{"ok":true,"db":"up"}`; the page shows `API: up / DB: up`.
- [ ] Verify auto-deploy: push a trivial commit to `main` and confirm Dokploy starts a deploy on its own.
