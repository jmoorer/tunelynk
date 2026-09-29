# Tunelynk Monorepo Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an empty-but-runnable TypeScript monorepo that proves web → API → Postgres wiring end to end, with shared types, local tooling, and tests.

**Architecture:** pnpm workspaces + Turborepo. Internal packages (`@tunelynk/config`, `shared`, `db`) are consumed as TypeScript source (no build step). `apps/api` is a Hono server with dependency injection (`createApp({ db })`) so tests pass a fake db; `apps/web` is a Vite React SPA that imports the API's `AppType` (type-only) for a typed `hono/client`.

**Tech Stack:** Node 22, pnpm, Turborepo, TypeScript, Hono + @hono/node-server, Vite + React + Tailwind v4, Postgres 17 (docker compose), Drizzle ORM + drizzle-kit + postgres.js, zod 4, Biome 2, Vitest + Testing Library + jsdom, tsx, tsup.

**Spec:** `docs/superpowers/specs/2026-09-29-monorepo-scaffold-design.md`

## Global Constraints

- Node 22 LTS: `.nvmrc` contains `22`; root `engines.node` is `>=22`.
- Package scope `@tunelynk/*`; internal packages exported as TS source (`"exports": { ".": "./src/index.ts" }`), no lib build step.
- Every package is ESM (`"type": "module"`) and extends a tsconfig from `@tunelynk/config`.
- API port 3000, web port 5173, Postgres port 5432.
- Credentials everywhere: `postgres://tunelynk:tunelynk@localhost:5432/tunelynk`.
- `GET /api/health` always returns HTTP 200 while the process is alive: `{ ok: true, db: "up" | "down" }`.
- Unhandled errors → `500 { "error": "Internal Server Error" }`.
- Web states' exact copy: loading `Checking API…`, success `API: up / DB: up` or `API: up / DB: down`, failure `API unreachable`.
- No product features, no auth, no CI, no deploy config (spec "Out of scope").
- Install dependencies with `pnpm add` (latest versions); do not hand-write version numbers.

## Review Focus

1. **Postgres down or unreachable** — API still starts, `/api/health` answers `db: "down"` within seconds (not a 30 s postgres.js connect hang). Pinned in Task 3 (`ping` rejects on unreachable host; `connect_timeout: 5`) and Task 4 (fake ping rejects → `db: "down"`, 200).
2. **No `.env` file** (fresh clone, forgot to copy) — `pnpm dev` must not crash with a cryptic Node flag error; the API exits 1 naming `DATABASE_URL`. Pinned by `--env-file-if-exists` in Task 4 scripts and the `parseEnv({})` test in Task 4.
3. **Bad `PORT`** (`abc`, `0`, `70000`) — validation fails naming `PORT`. Pinned in Task 4 env tests.
4. **API down while web is up** — Vite proxy returns a 500/HTML error page; web shows `API unreachable`, never crashes or renders garbage. Pinned in Task 5 (500 text response and network rejection tests).
5. **Health payload with wrong shape** (API/web version skew) — web shows `API unreachable` rather than `DB: undefined`. Pinned in Task 5 (web validates with shared `HealthResponse.parse`).

---

## File Map

| Path | Responsibility | Task |
|------|----------------|------|
| `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `biome.json`, `.gitignore`, `.nvmrc`, `.env.example` | Root tooling and scripts | 1 |
| `packages/config/{package.json,tsconfig.base.json,tsconfig.node.json,tsconfig.react.json}` | Shared tsconfig bases | 1 |
| `packages/shared/src/{health.ts,music.ts,index.ts,health.test.ts}` | zod schemas + inferred types | 2 |
| `docker-compose.yml`, `docker/postgres/init.sql` | Local Postgres 17 + `pg_trgm` | 3 |
| `packages/db/src/{schema.ts,client.ts,index.ts,client.test.ts}`, `packages/db/drizzle.config.ts`, `packages/db/migrations/*` | Drizzle schema, client factory, `ping`, migrations | 3 |
| `apps/api/src/{env.ts,app.ts,index.ts}` + tests, `apps/api/{tsup.config.ts,vitest.config.ts}` | Hono API | 4 |
| `apps/web/{index.html,vite.config.ts}`, `apps/web/src/{main.tsx,App.tsx,index.css,api.ts,HealthStatus.tsx}` + tests | React SPA | 5 |
| `README.md` | Getting started section | 6 |

---

### Task 1: Root tooling and `@tunelynk/config`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `biome.json`, `.gitignore`, `.nvmrc`, `.env.example`
- Create: `packages/config/package.json`, `packages/config/tsconfig.base.json`, `packages/config/tsconfig.node.json`, `packages/config/tsconfig.react.json`

**Interfaces:**
- Consumes: nothing.
- Produces: tsconfig bases at `@tunelynk/config/tsconfig.node.json` and `@tunelynk/config/tsconfig.react.json`; per-package script convention `typecheck` = `tsc --noEmit`, `lint` = `biome check .`, `test` = `vitest run`; root scripts from spec.

- [ ] **Step 1: Write root files**

`package.json`:
```json
{
  "name": "tunelynk",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "check": "turbo typecheck lint test",
    "format": "biome format --write .",
    "db:up": "docker compose up -d --wait",
    "db:down": "docker compose down",
    "db:generate": "pnpm --filter @tunelynk/db db:generate",
    "db:migrate": "pnpm --filter @tunelynk/db db:migrate"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - apps/*
  - packages/*
```

`turbo.json`:
```json
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "dev": { "cache": false, "persistent": true },
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": {},
    "lint": {},
    "test": {
      "env": ["DATABASE_URL"],
      "inputs": ["$TURBO_DEFAULT$", "$TURBO_ROOT$/.env"]
    }
  }
}
```

`biome.json`:
```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/migrations"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

`.gitignore`:
```
node_modules/
dist/
.turbo/
coverage/
*.tsbuildinfo
.env
.DS_Store
```

`.nvmrc`:
```
22
```

`.env.example`:
```
DATABASE_URL=postgres://tunelynk:tunelynk@localhost:5432/tunelynk
PORT=3000
```

- [ ] **Step 2: Write `packages/config`**

`packages/config/package.json`:
```json
{
  "name": "@tunelynk/config",
  "version": "0.0.0",
  "private": true
}
```

`packages/config/tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  }
}
```

`packages/config/tsconfig.node.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  }
}
```

`packages/config/tsconfig.react.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  }
}
```

- [ ] **Step 3: Install root dev tools**

Run: `pnpm add -Dw turbo @biomejs/biome typescript`
Expected: install succeeds; `pnpm-lock.yaml` created. If pnpm prints an "Ignored build scripts" warning (e.g. for `esbuild`), allow those packages using the exact setting pnpm's message names (pnpm version-dependent; written into `pnpm-workspace.yaml`), then re-run `pnpm install` and confirm the warning is gone.

- [ ] **Step 4: Verify tooling**

Run: `pnpm exec biome check . && pnpm check`
Expected: Biome reports no errors (if it rejects the config schema, run `pnpm exec biome migrate --write` and re-run). `pnpm check` succeeds with "No tasks were executed" or equivalent — no packages have scripts yet.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json biome.json .gitignore .nvmrc .env.example packages/config
git commit -m "chore: add monorepo root tooling and tsconfig bases"
```

---

### Task 2: `@tunelynk/shared` schemas

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `packages/shared/src/health.ts`, `packages/shared/src/music.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/health.test.ts`

**Interfaces:**
- Consumes: `@tunelynk/config/tsconfig.node.json`.
- Produces (from `@tunelynk/shared`):
  - `HealthResponse` — zod schema `z.object({ ok: z.boolean(), db: z.enum(["up", "down"]) })`, and `type HealthResponse = { ok: boolean; db: "up" | "down" }` (same name for value and type).
  - `Track` — schema `{ id: string; title: string }` + type.
  - `Playlist` — schema `{ id: string; name: string }` + type.

- [ ] **Step 1: Package scaffolding**

`packages/shared/package.json`:
```json
{
  "name": "@tunelynk/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "vitest run"
  }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "@tunelynk/config/tsconfig.node.json",
  "include": ["src"]
}
```

Run: `pnpm --filter @tunelynk/shared add zod && pnpm --filter @tunelynk/shared add -D vitest typescript @types/node "@tunelynk/config@workspace:*"`
Expected: install succeeds.

- [ ] **Step 2: Write the failing test**

`packages/shared/src/health.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { HealthResponse } from "./index";

describe("HealthResponse", () => {
  it.each([
    { ok: true, db: "up" },
    { ok: true, db: "down" },
  ])("accepts %o", (payload) => {
    expect(HealthResponse.parse(payload)).toEqual(payload);
  });

  it.each([
    {},
    { ok: true },
    { ok: "yes", db: "up" },
    { ok: true, db: "sideways" },
    null,
    "ok",
  ])("rejects %o", (payload) => {
    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tunelynk/shared test`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 4: Implement**

`packages/shared/src/health.ts`:
```ts
import { z } from "zod";

export const HealthResponse = z.object({
  ok: z.boolean(),
  db: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
```

`packages/shared/src/music.ts`:
```ts
import { z } from "zod";

// Placeholders that establish the schema-plus-type pattern; real fields come with the domain model.
export const Track = z.object({
  id: z.string(),
  title: z.string(),
});
export type Track = z.infer<typeof Track>;

export const Playlist = z.object({
  id: z.string(),
  name: z.string(),
});
export type Playlist = z.infer<typeof Playlist>;
```

`packages/shared/src/index.ts`:
```ts
export * from "./health";
export * from "./music";
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @tunelynk/shared test && pnpm check`
Expected: 8 tests PASS; typecheck, lint, test all green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): add HealthResponse, Track, Playlist schemas"
```

---

### Task 3: Postgres + `@tunelynk/db`

**Files:**
- Create: `docker-compose.yml`, `docker/postgres/init.sql`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`
- Generated: `packages/db/migrations/*`
- Test: `packages/db/src/client.test.ts`

**Interfaces:**
- Consumes: `@tunelynk/config/tsconfig.node.json`; root `.env` (`DATABASE_URL`).
- Produces (from `@tunelynk/db`):
  - `createDb(url: string): Db` — Drizzle client over postgres.js; lazy, does not connect or throw at construction; `connect_timeout: 5` seconds.
  - `type Db = ReturnType<typeof createDb>`; underlying pool closable with `db.$client.end()`.
  - `ping(db: Db): Promise<void>` — runs `select 1`; rejects when the DB is unreachable.
  - `appMeta` table: `app_meta (key text primary key, value text not null)`.
  - package scripts `db:generate`, `db:migrate`.

- [ ] **Step 1: Docker Postgres**

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: tunelynk
      POSTGRES_PASSWORD: tunelynk
      POSTGRES_DB: tunelynk
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tunelynk -d tunelynk"]
      interval: 2s
      timeout: 3s
      retries: 15

volumes:
  pgdata:
```

`docker/postgres/init.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Run: `cp .env.example .env && pnpm db:up`
Expected: container reports healthy (`--wait` blocks until healthcheck passes). If port 5432 is taken by a local Postgres, stop it or report back — do not change the port silently.

- [ ] **Step 2: Package scaffolding**

`packages/db/package.json`:
```json
{
  "name": "@tunelynk/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

`packages/db/tsconfig.json`:
```json
{
  "extends": "@tunelynk/config/tsconfig.node.json",
  "include": ["src", "drizzle.config.ts"]
}
```

Run: `pnpm --filter @tunelynk/db add drizzle-orm postgres && pnpm --filter @tunelynk/db add -D drizzle-kit dotenv vitest typescript @types/node "@tunelynk/config@workspace:*"`
Expected: install succeeds.

- [ ] **Step 3: Write the failing test**

`packages/db/src/client.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createDb, ping } from "./index";

describe("ping", () => {
  it("rejects without throwing at construction when Postgres is unreachable", async () => {
    // Port 1 refuses connections; createDb must stay lazy so the API can boot with the DB down.
    const db = createDb("postgres://nobody:nobody@127.0.0.1:1/nothing");
    await expect(ping(db)).rejects.toThrow();
    await db.$client.end();
  }, 10_000);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @tunelynk/db test`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 5: Implement**

`packages/db/src/schema.ts`:
```ts
import { pgTable, text } from "drizzle-orm/pg-core";

// Placeholder so the first migration is real; replaced by the domain schema later.
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
```

`packages/db/src/client.ts`:
```ts
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(url: string) {
  // Short connect timeout so /health reports "down" quickly instead of hanging.
  const client = postgres(url, { connect_timeout: 5 });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;

export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
```

`packages/db/src/index.ts`:
```ts
export * from "./client";
export * from "./schema";
```

`packages/db/drizzle.config.ts`:
```ts
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "../../.env" });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env at the repo root.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url },
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @tunelynk/db test`
Expected: PASS in well under 10 s.

- [ ] **Step 7: Generate and apply the first migration**

Run: `pnpm db:generate && pnpm db:migrate`
Expected: `packages/db/migrations/0000_*.sql` created containing `CREATE TABLE "app_meta"`; migrate reports success.

Run: `docker compose exec postgres psql -U tunelynk -d tunelynk -c '\d app_meta' -c "select extname from pg_extension where extname = 'pg_trgm'"`
Expected: `app_meta` with `key text not null` (primary key) and `value text not null`; one row `pg_trgm`.

- [ ] **Step 8: Verify whole repo**

Run: `pnpm check`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml docker packages/db pnpm-lock.yaml
git commit -m "feat(db): add Postgres compose, Drizzle client, ping, first migration"
```

---

### Task 4: `apps/api` (Hono)

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsup.config.ts`, `apps/api/vitest.config.ts`
- Create: `apps/api/src/env.ts`, `apps/api/src/app.ts`, `apps/api/src/index.ts`
- Test: `apps/api/src/env.test.ts`, `apps/api/src/app.test.ts`, `apps/api/src/app.integration.test.ts`

**Interfaces:**
- Consumes: `createDb`, `ping`, `type Db` from `@tunelynk/db`; `type HealthResponse` from `@tunelynk/shared`.
- Produces:
  - `@tunelynk/api` package export (`./src/app.ts`) with `createApp(deps: AppDeps): Hono app` and `type AppType = ReturnType<typeof createApp>` — web imports `AppType` type-only.
  - `type AppDeps = { db: Db }`.
  - `parseEnv(source: Record<string, string | undefined>): Env` — throws `Error` whose message lists each invalid variable by name; `loadEnv(): Env` — logs that message and `process.exit(1)` on failure.
  - `type Env = { DATABASE_URL: string; PORT: number }`.
  - Route `GET /api/health`.

- [ ] **Step 1: Package scaffolding**

`apps/api/package.json`:
```json
{
  "name": "@tunelynk/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/app.ts" },
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=../../.env src/index.ts",
    "build": "tsup",
    "start": "node --env-file-if-exists=../../.env dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "vitest run"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "extends": "@tunelynk/config/tsconfig.node.json",
  "include": ["src", "tsup.config.ts", "vitest.config.ts"]
}
```

`apps/api/tsup.config.ts`:
```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  // Workspace packages ship as TS source, so they must be bundled in.
  noExternal: [/^@tunelynk\//],
  clean: true,
});
```

`apps/api/vitest.config.ts`:
```ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Load the root .env (if present) so the integration test can reach Postgres.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({});
```

Run: `pnpm --filter @tunelynk/api add hono @hono/node-server zod "@tunelynk/db@workspace:*" "@tunelynk/shared@workspace:*" && pnpm --filter @tunelynk/api add -D tsx tsup vitest typescript @types/node "@tunelynk/config@workspace:*"`
Expected: install succeeds.

- [ ] **Step 2: Write the failing env tests**

`apps/api/src/env.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const DATABASE_URL = "postgres://tunelynk:tunelynk@localhost:5432/tunelynk";

describe("parseEnv", () => {
  it("parses a valid environment and coerces PORT", () => {
    expect(parseEnv({ DATABASE_URL, PORT: "4000" })).toEqual({ DATABASE_URL, PORT: 4000 });
  });

  it("defaults PORT to 3000", () => {
    expect(parseEnv({ DATABASE_URL }).PORT).toBe(3000);
  });

  it("fails naming DATABASE_URL when it is missing", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("fails naming DATABASE_URL when it is not a URL", () => {
    expect(() => parseEnv({ DATABASE_URL: "not-a-url" })).toThrow(/DATABASE_URL/);
  });

  it.each(["abc", "0", "70000", "3000.5"])("fails naming PORT for %s", (PORT) => {
    expect(() => parseEnv({ DATABASE_URL, PORT })).toThrow(/PORT/);
  });
});
```

Run: `pnpm --filter @tunelynk/api test`
Expected: FAIL — cannot resolve `./env`.

- [ ] **Step 3: Implement env**

`apps/api/src/env.ts`:
```ts
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}

export function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
```

Run: `pnpm --filter @tunelynk/api test`
Expected: env tests PASS.

- [ ] **Step 4: Write the failing app tests**

`apps/api/src/app.test.ts`:
```ts
import type { Db } from "@tunelynk/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";

// ping(db) calls db.execute; a fake with only execute is enough.
function fakeDb(execute: () => Promise<unknown>): Db {
  return { execute } as unknown as Db;
}

describe("GET /api/health", () => {
  it("reports db up when ping succeeds", async () => {
    const app = createApp({ db: fakeDb(async () => []) });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up" });
  });

  it("reports db down, still 200, when ping fails", async () => {
    const app = createApp({ db: fakeDb(async () => Promise.reject(new Error("ECONNREFUSED"))) });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "down" });
  });
});

describe("onError", () => {
  it("returns 500 JSON for unhandled route errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ db: fakeDb(async () => []) });
    app.get("/api/boom", () => {
      throw new Error("boom");
    });
    const res = await app.request("/api/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

`apps/api/src/app.integration.test.ts`:
```ts
import { createDb } from "@tunelynk/db";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("GET /api/health against real Postgres", () => {
  const db = createDb(url ?? "");
  afterAll(() => db.$client.end());

  it("reports db up", async () => {
    const res = await createApp({ db }).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up" });
  });
});
```

Run: `pnpm --filter @tunelynk/api test`
Expected: FAIL — cannot resolve `./app`.

- [ ] **Step 5: Implement app and entrypoint**

`apps/api/src/app.ts`:
```ts
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
```

`apps/api/src/index.ts`:
```ts
import { serve } from "@hono/node-server";
import { createDb } from "@tunelynk/db";
import { createApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();
const app = createApp({ db: createDb(env.DATABASE_URL) });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @tunelynk/api test`
Expected: all PASS, including the integration test (Postgres up from Task 3, `.env` present). Then run `mv .env .env.bak && pnpm --filter @tunelynk/api test; mv .env.bak .env` — expected: integration test reported as skipped, others PASS.

- [ ] **Step 7: Smoke-test the running server**

Run (background): `pnpm --filter @tunelynk/api dev`, then `curl -s localhost:3000/api/health`
Expected: `{"ok":true,"db":"up"}`. Then `pnpm db:down`, curl again → `{"ok":true,"db":"down"}` within ~5 s. `pnpm db:up` afterwards. Stop the dev server.

Run: `mv .env .env.bak && (cd apps/api && timeout 10 pnpm exec tsx --env-file-if-exists=../../.env src/index.ts; echo "exit=$?"); mv .env.bak .env`
Expected: prints `Invalid environment variables:` with a `DATABASE_URL` line, `exit=1`. (If `timeout` is missing on macOS, omit it — the process exits on its own.)

- [ ] **Step 8: Build**

Run: `pnpm --filter @tunelynk/api build && ls apps/api/dist`
Expected: `index.js` present. Run `pnpm --filter @tunelynk/api start` in background, curl `/api/health` → `{"ok":true,"db":"up"}`, stop it.

- [ ] **Step 9: Verify whole repo and commit**

Run: `pnpm check`
Expected: all green.

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): add Hono API with health route, env validation, error handler"
```

---

### Task 5: `apps/web` (Vite + React + Tailwind)

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/index.css`, `apps/web/src/api.ts`, `apps/web/src/HealthStatus.tsx`, `apps/web/src/test/setup.ts`
- Test: `apps/web/src/HealthStatus.test.tsx`

**Interfaces:**
- Consumes: `type AppType` from `@tunelynk/api` (type-only); `HealthResponse` (schema + type) from `@tunelynk/shared`.
- Produces: `client` (typed `hc<AppType>`), `fetchHealth(): Promise<HealthResponse>` (rejects on network error, non-OK status, non-JSON body, or wrong shape), `<HealthStatus />`.

- [ ] **Step 1: Package scaffolding**

`apps/web/package.json`:
```json
{
  "name": "@tunelynk/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "vitest run"
  }
}
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "@tunelynk/config/tsconfig.react.json",
  "include": ["src"]
}
```

`apps/web/vite.config.ts`:
```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tunelynk</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
```

Run: `pnpm --filter @tunelynk/web add react react-dom hono "@tunelynk/shared@workspace:*" && pnpm --filter @tunelynk/web add -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite typescript @types/react @types/react-dom vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/dom "@tunelynk/api@workspace:*" "@tunelynk/config@workspace:*"`
Expected: install succeeds; `hono` resolves to the same version as in `apps/api` (check `pnpm why hono` shows one version — a mismatch breaks `AppType` inference).

- [ ] **Step 2: Write the failing test**

`apps/web/src/HealthStatus.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthStatus } from "./HealthStatus";

function stubFetch(result: Response | Error) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("HealthStatus", () => {
  it("shows loading first", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<HealthStatus />);
    expect(screen.getByText("Checking API…")).toBeInTheDocument();
  });

  it("shows API and DB up", async () => {
    stubFetch(Response.json({ ok: true, db: "up" }));
    render(<HealthStatus />);
    expect(await screen.findByText("API: up / DB: up")).toBeInTheDocument();
  });

  it("shows DB down", async () => {
    stubFetch(Response.json({ ok: true, db: "down" }));
    render(<HealthStatus />);
    expect(await screen.findByText("API: up / DB: down")).toBeInTheDocument();
  });

  it("shows unreachable when fetch rejects", async () => {
    stubFetch(new TypeError("Failed to fetch"));
    render(<HealthStatus />);
    expect(await screen.findByText("API unreachable")).toBeInTheDocument();
  });

  it("shows unreachable on a non-OK non-JSON response (proxy error)", async () => {
    stubFetch(new Response("<html>Bad Gateway</html>", { status: 500 }));
    render(<HealthStatus />);
    expect(await screen.findByText("API unreachable")).toBeInTheDocument();
  });

  it("shows unreachable when the payload has the wrong shape", async () => {
    stubFetch(Response.json({ status: "fine" }));
    render(<HealthStatus />);
    expect(await screen.findByText("API unreachable")).toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @tunelynk/web test`
Expected: FAIL — cannot resolve `./HealthStatus`.

- [ ] **Step 3: Implement**

`apps/web/src/api.ts`:
```ts
import type { AppType } from "@tunelynk/api";
import { HealthResponse } from "@tunelynk/shared";
import { hc } from "hono/client";

// Same-origin: Vite proxies /api to the API in dev.
export const client = hc<AppType>(window.location.origin);

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await client.api.health.$get();
  if (!res.ok) throw new Error(`Health check failed with status ${res.status}`);
  return HealthResponse.parse(await res.json());
}
```

`apps/web/src/HealthStatus.tsx`:
```tsx
import type { HealthResponse } from "@tunelynk/shared";
import { useEffect, useState } from "react";
import { fetchHealth } from "./api";

type State =
  | { status: "loading" }
  | { status: "ok"; health: HealthResponse }
  | { status: "unreachable" };

export function HealthStatus() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchHealth().then(
      (health) => {
        if (!cancelled) setState({ status: "ok", health });
      },
      () => {
        if (!cancelled) setState({ status: "unreachable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") return <p className="text-gray-500">Checking API…</p>;
  if (state.status === "unreachable") return <p className="text-red-600">API unreachable</p>;
  return <p className="text-green-700">{`API: up / DB: ${state.health.db}`}</p>;
}
```

`apps/web/src/App.tsx`:
```tsx
import { HealthStatus } from "./HealthStatus";

export function App() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-4 text-3xl font-bold">Tunelynk</h1>
      <HealthStatus />
    </main>
  );
}
```

`apps/web/src/index.css`:
```css
@import "tailwindcss";
```

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tunelynk/web test`
Expected: 6 tests PASS.

- [ ] **Step 5: Verify typed client and build**

Run: `pnpm --filter @tunelynk/web typecheck`
Expected: no errors. Sanity check that types flow: temporarily change `client.api.health.$get()` to `client.api.helth.$get()` — typecheck must FAIL; revert.

Run: `pnpm --filter @tunelynk/web build`
Expected: `apps/web/dist/index.html` and assets produced.

- [ ] **Step 6: Verify whole repo and commit**

Run: `pnpm check`
Expected: all green.

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add Vite React app with typed health status"
```

---

### Task 6: README and end-to-end verification

**Files:**
- Modify: `README.md` (append section at end)

**Interfaces:**
- Consumes: all root scripts.
- Produces: documented getting-started flow.

- [ ] **Step 1: Append "Getting started" to `README.md`**

````markdown
## Getting started

Requires Node 22 (`nvm use`), pnpm, and Docker.

```sh
pnpm install
cp .env.example .env
pnpm db:up        # Postgres 17 on :5432 (waits until healthy)
pnpm db:migrate
pnpm dev          # API on :3000, web on :5173
```

Open http://localhost:5173 — it shows API and DB status from `/api/health`.

| Script | Does |
|--------|------|
| `pnpm dev` | API + web in watch mode |
| `pnpm build` | Build all apps |
| `pnpm check` | Typecheck, lint, test (API integration test needs `pnpm db:up`) |
| `pnpm format` | Format with Biome |
| `pnpm db:up` / `pnpm db:down` | Start / stop Postgres |
| `pnpm db:generate` / `pnpm db:migrate` | Create / apply Drizzle migrations |

Layout: `apps/api` (Hono), `apps/web` (Vite + React), `packages/shared` (zod schemas), `packages/db` (Drizzle), `packages/config` (tsconfig bases).
````

- [ ] **Step 2: Fresh-clone end-to-end check (spec success criteria)**

Run:
```bash
pnpm db:down
rm -rf node_modules apps/*/node_modules packages/*/node_modules .turbo
pnpm install && pnpm db:up && pnpm db:migrate && pnpm check && pnpm build
```
Expected: every command succeeds.

Run `pnpm dev` in background; `curl -s localhost:5173/api/health` → `{"ok":true,"db":"up"}` (through the Vite proxy). Open http://localhost:5173 (or fetch it) and confirm the page shows `API: up / DB: up`. Stop dev.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add getting started section"
```
