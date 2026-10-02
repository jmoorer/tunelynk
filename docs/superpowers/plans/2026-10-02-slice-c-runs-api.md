# Slice C: Runs API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guest can `POST /api/runs` with a prompt, then poll `GET /api/runs/:id` until a playlist of real Apple tracks appears. The API persists runs in Postgres, runs the slice B engine in-process, records LLM cost, enforces the daily budget cap, and marks runs interrupted by a restart as failed.

**Architecture:**
- **Persistence:** Drizzle schema in `packages/db`, two generated migrations. API contracts are zod schemas in `packages/shared`.
- **API (`apps/api/src/runs/`):** three pieces.
  - `repo.ts` holds every SQL query, including race-free run creation behind a per-user advisory lock.
  - `executor.ts` runs the engine fire-and-forget with an overall deadline. It records usage and maps errors to user-safe messages.
  - `routes.ts` is a Hono sub-app with the signed `tl_guest` cookie.
- **Wiring:** `index.ts` connects the real Apple catalog, LLM provider and engine, and runs boot recovery before listening.

**Tech Stack:** Hono 4.13 (`hono/cookie` signed cookies), Drizzle ORM 0.45 + drizzle-kit 0.31, postgres-js, zod 4, Vitest 5, `@tunelynk/engine` and `@tunelynk/connectors` from slices A/B.

**Spec:** `docs/superpowers/specs/2026-10-01-engine-guest-generate-design.md` (sections "Data model", "API", "Error handling", "Testing → C"). Earlier plans: slice A `2026-10-01-slice-a-apple-catalog-connector.md`, slice B `2026-10-01-slice-b-engine.md`.

## Global Constraints

- Branch `feat/10-slice-c-runs-api`, stacked on `feat/10-slice-b-engine` (PR #24). Its PR is stacked on #24.
- Run commands with Node 22.23.3. If the shell still resolves 22.19, prefix `PATH="$HOME/Library/Application Support/Herd/config/nvm/versions/node/v22.23.3/bin:$PATH"`.
- Local Postgres must be up (`pnpm db:up`). Integration tests each create a throwaway database, migrate it, and drop it.
- Ids are `uuid` with `defaultRandom()`. Timestamps are `timestamptz`. Enums are the full spec enums (`run_status`: queued, running, draft, published, failed, expired; and so on).
- Guest playlist length is **20**. The prompt is trimmed and 1–280 characters, counted as UTF-16 code units (zod `max`; slice D's counter must count the same way).
- Cookie `tl_guest`: Hono `setSignedCookie` (HMAC-SHA256, value = user id), `httpOnly`, `sameSite: "Lax"`, `path: "/"`, `maxAge` 30 days, `secure` from `COOKIE_SECURE` (default `true`; local `.env` sets `false`).
- Budget: today's (UTC) `SUM(llm_usage.cost_micros)` ≥ `round(LLM_DAILY_BUDGET_USD × 1e6)` → `503 { error: "budget_exceeded" }` before any playlist row is written.
- One active (`queued` | `running`) run per user, enforced inside one transaction holding `pg_advisory_xact_lock(hashtext(user_id))`.
- Run deadline **120 s**. Stale-run recovery at boot: `queued` / `running` runs older than **5 min** → `failed`.
- User-facing run errors are exactly:
  - refusal: "That doesn't look like a playlist request."
  - not enough tracks: "Couldn't find enough tracks for that prompt."
  - timeout: "Generation took too long. Try again."
  - interrupted: "Generation was interrupted. Try again."
  - anything else: "Something went wrong generating this playlist."
- `apps/api` declares `@anthropic-ai/sdk@^0.131.0` and `openai@~7.25.0` as dependencies. tsup bundles `@tunelynk/*` source but leaves npm packages external, so the bundled engine must be able to resolve its SDKs from `apps/api/node_modules`.
- `drizzle-kit generate` cannot drop and add tables in one run without a TTY. Generate the drop and the new tables as **two** named migrations.
- Format with Biome per package (`pnpm --filter <pkg> exec biome check --write .`) before each commit.

## Review Focus

1. **Two POSTs at the same moment with the same cookie** (double-click, two tabs). Expected: exactly one `202`, the other `409 run_in_progress` with the first run's ids. Pinned in Task 6.
2. **A cookie whose user row no longer exists** (DB reset, future guest cleanup). Expected: treated like no cookie; POST creates a fresh guest and replaces the cookie, and GET still works. Pinned in Task 6.
3. **An engine call that never settles** (a hung provider despite SDK timeouts). Expected: the run fails with the timeout message after the deadline, a late result never overwrites it, and late usage is still recorded. Pinned in Task 5.
4. **A server restart mid-run.** Expected: at boot, old `queued`/`running` runs become `failed` with the interrupted message, and recent ones are left alone. Pinned in Task 4.
5. **Bad bodies** (empty prompt, 281 characters, non-JSON body, missing `prompt`). Expected: `400 { error: "invalid_prompt" }`, and no user or playlist rows written. Pinned in Task 6.

---

## File Structure

```
packages/shared/src/
  runs.ts                  CreateRunRequest, CreateRunResponse, RunStatus, RunStage, RunTrack, RunResponse, ApiError (new)
  runs.test.ts             (new)
  music.ts                 (delete: unused placeholder)
  index.ts                 export runs instead of music (modify)
packages/db/
  src/schema.ts            domain tables + enums (replace app_meta)
  src/migrate.integration.test.ts   assert domain tables exist, app_meta gone (modify)
  migrations/0001_drop_app_meta.sql, 0002_domain_schema.sql, meta/*   (generated)
apps/api/
  package.json             add deps (modify)
  src/env.ts               full env schema + parseMigrateEnv (modify)
  src/env.test.ts          (modify)
  src/migrate.ts           use loadMigrateEnv (modify)
  src/test/db.ts           createTestDatabase() helper for integration tests (new)
  src/runs/messages.ts     RUN_ERRORS (new)
  src/runs/repo.ts         createRunRepo(db) (new)
  src/runs/repo.integration.test.ts (new)
  src/runs/executor.ts     createRunExecutor (new)
  src/runs/executor.test.ts (new)
  src/runs/routes.ts       runsRoutes(deps) (new)
  src/runs/routes.integration.test.ts (new)
  src/app.ts               mount /api/runs (modify)
  src/app.test.ts, src/app.web.test.ts, src/app.integration.test.ts   pass runs stub (modify)
  src/index.ts             wire catalog, LLM, engine, executor, boot recovery (modify)
.env.example               SESSION_SECRET, COOKIE_SECURE (modify)
```

---

### Task 1: Shared run contracts

**Files:**
- Create: `packages/shared/src/runs.ts`, `packages/shared/src/runs.test.ts`
- Delete: `packages/shared/src/music.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: zod schemas plus same-named types:
  - `PROMPT_MAX_LENGTH = 280`
  - `CreateRunRequest { prompt: string }`, trimmed, 1–280 characters
  - `CreateRunResponse { runId: string; playlistId: string }`
  - `RunStatus` (6 values); `RunStage` ("taste" | "llm" | "matching")
  - `RunTrack { position: number; appleSongId: string; title: string; artistName: string; album: string; artworkUrl: string | null; previewUrl: string | null; durationMs: number; explicit: boolean; source: "llm" | "backfill" }`
  - `RunResponse { id; status: RunStatus; stage: RunStage | null; error: string | null; playlist: { id; name; prompt }; tracks: RunTrack[]; unmatched: { title; artist }[] }`
  - `ApiError { error: "invalid_prompt" | "budget_exceeded" | "run_in_progress" | "not_found"; runId?: string; playlistId?: string }`

- [ ] **Step 1: Confirm the branch**

Run: `git branch --show-current`
Expected: `feat/10-slice-c-runs-api` (created from `feat/10-slice-b-engine` with the plan commit).

- [ ] **Step 2: Write the failing test**

`packages/shared/src/runs.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ApiError, CreateRunRequest, PROMPT_MAX_LENGTH, RunResponse } from "./runs";

describe("CreateRunRequest", () => {
  it("trims the prompt", () => {
    expect(CreateRunRequest.parse({ prompt: "  road trip  " })).toEqual({
      prompt: "road trip",
    });
  });

  it("accepts exactly 280 characters", () => {
    const prompt = "x".repeat(PROMPT_MAX_LENGTH);
    expect(CreateRunRequest.parse({ prompt }).prompt).toHaveLength(280);
  });

  it.each([
    ["empty", { prompt: "" }],
    ["whitespace only", { prompt: "   " }],
    ["281 characters", { prompt: "x".repeat(281) }],
    ["missing", {}],
    ["not a string", { prompt: 42 }],
  ])("rejects %s", (_label, body) => {
    expect(CreateRunRequest.safeParse(body).success).toBe(false);
  });
});

describe("RunResponse", () => {
  it("parses a draft run", () => {
    const run = {
      id: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
      status: "draft",
      stage: null,
      error: null,
      playlist: {
        id: "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
        name: "90s Road Trip",
        prompt: "upbeat 90s road trip",
      },
      tracks: [
        {
          position: 1,
          appleSongId: "1109715168",
          title: "Weird Fishes / Arpeggi",
          artistName: "Radiohead",
          album: "In Rainbows",
          artworkUrl: "https://example.com/300x300bb.jpg",
          previewUrl: null,
          durationMs: 318187,
          explicit: false,
          source: "llm",
        },
      ],
      unmatched: [{ title: "Beautiful", artist: "Suede" }],
    };
    expect(RunResponse.parse(run)).toEqual(run);
  });
});

describe("ApiError", () => {
  it("allows run ids on run_in_progress", () => {
    expect(
      ApiError.parse({
        error: "run_in_progress",
        runId: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
        playlistId: "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
      }).error,
    ).toBe("run_in_progress");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/shared test`
Expected: FAIL with `Cannot find module './runs'`.

- [ ] **Step 4: Implement**

`packages/shared/src/runs.ts`:
```ts
import { z } from "zod";

export const PROMPT_MAX_LENGTH = 280;

export const CreateRunRequest = z.object({
  prompt: z.string().trim().min(1).max(PROMPT_MAX_LENGTH),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const CreateRunResponse = z.object({
  runId: z.uuid(),
  playlistId: z.uuid(),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

export const RunStatus = z.enum([
  "queued",
  "running",
  "draft",
  "published",
  "failed",
  "expired",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunStage = z.enum(["taste", "llm", "matching"]);
export type RunStage = z.infer<typeof RunStage>;

export const RunTrack = z.object({
  position: z.number().int(),
  appleSongId: z.string(),
  title: z.string(),
  artistName: z.string(),
  album: z.string(),
  artworkUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  durationMs: z.number().int(),
  explicit: z.boolean(),
  source: z.enum(["llm", "backfill"]),
});
export type RunTrack = z.infer<typeof RunTrack>;

export const RunResponse = z.object({
  id: z.uuid(),
  status: RunStatus,
  stage: RunStage.nullable(),
  error: z.string().nullable(),
  playlist: z.object({ id: z.uuid(), name: z.string(), prompt: z.string() }),
  tracks: z.array(RunTrack),
  unmatched: z.array(z.object({ title: z.string(), artist: z.string() })),
});
export type RunResponse = z.infer<typeof RunResponse>;

export const ApiError = z.object({
  error: z.enum([
    "invalid_prompt",
    "budget_exceeded",
    "run_in_progress",
    "not_found",
  ]),
  runId: z.uuid().optional(),
  playlistId: z.uuid().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
```

Delete `packages/shared/src/music.ts` (it is unused; check with `grep -rn "music" apps packages --include=*.ts`).

`packages/shared/src/index.ts` (replace the whole file):
```ts
export * from "./health";
export * from "./runs";
```

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/shared exec biome check --write . && pnpm --filter @tunelynk/shared test && pnpm --filter @tunelynk/shared typecheck && pnpm --filter @tunelynk/shared lint && pnpm --filter @tunelynk/web typecheck`
Expected: shared tests PASS (8 new + existing health tests); typecheck and lint clean. The web typecheck passes too, proving nothing imported the removed placeholders.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add run API contracts; drop placeholder music types"
```

---

### Task 2: Database schema and migrations

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/migrate.integration.test.ts`
- Create (generated): `packages/db/migrations/0001_drop_app_meta.sql`, `packages/db/migrations/0002_domain_schema.sql`, `packages/db/migrations/meta/0001_snapshot.json`, `packages/db/migrations/meta/0002_snapshot.json`; `meta/_journal.json` updated

**Interfaces:**
- Consumes: nothing.
- Produces (exported from `@tunelynk/db`):
  - pgEnums `playlistKind`, `playlistStatus`, `runTrigger`, `runStatus`, `runStage`, `trackSource`, `usageKind`
  - tables `users`, `playlists`, `generationRuns`, `tracks`, `runTracks`, `llmUsage`
  - `type RunCandidate = { title: string; artist: string; status: "matched" | "unmatched" | "duplicate" | "error"; appleSongId?: string }`

- [ ] **Step 1: Write the failing test**

In `packages/db/src/migrate.integration.test.ts`, replace the `app_meta` check (the `const [table] = …` query and its `expect`) with:
```ts
      const tables = await check<{ t: string | null }[]>`
        select to_regclass(name)::text as t from unnest(array[
          'public.users', 'public.playlists', 'public.generation_runs',
          'public.tracks', 'public.run_tracks', 'public.llm_usage',
          'public.app_meta'
        ]) as name`;
      expect(tables.map((r) => r.t)).toEqual([
        "users",
        "playlists",
        "generation_runs",
        "tracks",
        "run_tracks",
        "llm_usage",
        null,
      ]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/db test:integration`
Expected: FAIL. The domain tables come back `null` and `app_meta` comes back `"app_meta"`.

- [ ] **Step 3: Generate the drop migration**

Replace `packages/db/src/schema.ts` with this temporary content:
```ts
// Domain tables are added in the next migration.
export {};
```

Run: `pnpm --filter @tunelynk/db exec drizzle-kit generate --name drop_app_meta`
Expected: `packages/db/migrations/0001_drop_app_meta.sql` containing `DROP TABLE "app_meta" CASCADE;`, with no prompt.

- [ ] **Step 4: Write the domain schema and generate its migration**

`packages/db/src/schema.ts` (replace the whole file):
```ts
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const playlistKind = pgEnum("playlist_kind", [
  "one_off",
  "recurring",
  "triggered",
]);
export const playlistStatus = pgEnum("playlist_status", [
  "draft",
  "active",
  "paused",
  "deleted",
]);
export const runTrigger = pgEnum("run_trigger", ["manual", "schedule", "event"]);
export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "draft",
  "published",
  "failed",
  "expired",
]);
export const runStage = pgEnum("run_stage", ["taste", "llm", "matching"]);
export const trackSource = pgEnum("track_source", ["llm", "backfill"]);
export const usageKind = pgEnum("usage_kind", ["guest", "user", "scheduled"]);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  isGuest: boolean("is_guest").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: createdAt(),
});

export const playlists = pgTable(
  "playlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    length: integer("length").notNull(),
    discovery: integer("discovery").notNull().default(50),
    kind: playlistKind("kind").notNull().default("one_off"),
    status: playlistStatus("status").notNull().default("draft"),
    // No FK: playlists ↔ runs would be circular. The run executor sets it.
    currentRunId: uuid("current_run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("playlists_user_id_idx").on(t.userId)],
);

export type RunCandidate = {
  title: string;
  artist: string;
  status: "matched" | "unmatched" | "duplicate" | "error";
  appleSongId?: string;
};

export const generationRuns = pgTable(
  "generation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    trigger: runTrigger("trigger").notNull().default("manual"),
    status: runStatus("status").notNull().default("queued"),
    stage: runStage("stage"),
    error: text("error"),
    llmModel: text("llm_model").notNull(),
    candidates: jsonb("candidates")
      .$type<RunCandidate[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("generation_runs_playlist_id_idx").on(t.playlistId),
    index("generation_runs_status_idx").on(t.status),
  ],
);

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  appleSongId: text("apple_song_id").notNull().unique(),
  isrc: text("isrc"),
  title: text("title").notNull(),
  artistName: text("artist_name").notNull(),
  album: text("album").notNull(),
  durationMs: integer("duration_ms").notNull(),
  explicit: boolean("explicit").notNull(),
  artworkUrl: text("artwork_url"),
  previewUrl: text("preview_url"),
});

export const runTracks = pgTable(
  "run_tracks",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => generationRuns.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id),
    source: trackSource("source").notNull(),
    removed: boolean("removed").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.runId, t.position] })],
);

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    kind: usageKind("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("llm_usage_created_at_idx").on(t.createdAt)],
);
```

Run: `pnpm --filter @tunelynk/db exec drizzle-kit generate --name domain_schema`
Expected: `packages/db/migrations/0002_domain_schema.sql` containing seven `CREATE TYPE … AS ENUM`, six `CREATE TABLE` statements, the FKs, the `run_tracks` composite primary key, the `tracks_apple_song_id_unique` constraint, and the three indexes. There is no `DROP` and no prompt. Read the SQL and confirm `candidates` has `DEFAULT '[]'::jsonb` and `cost_micros` is `bigint`.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/db exec biome check --write . && pnpm --filter @tunelynk/db test && pnpm --filter @tunelynk/db test:integration && pnpm --filter @tunelynk/db typecheck && pnpm --filter @tunelynk/db lint`
Expected: unit and integration tests PASS. The fresh database gets all three migrations, and a second run is a no-op. Typecheck and lint are clean (Biome ignores `migrations/`).

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): add users, playlists, runs, tracks, and llm_usage schema"
```

---

### Task 3: API env and dependencies

**Files:**
- Modify: `apps/api/package.json`, `apps/api/src/env.ts`, `apps/api/src/env.test.ts`, `apps/api/src/migrate.ts`, `.env.example`

**Interfaces:**
- Consumes: `assertPricedModel` (`@tunelynk/engine`).
- Produces:
  - `type Env = { DATABASE_URL: string; PORT: number; APPLE_TEAM_ID: string; APPLE_KEY_ID: string; APPLE_PRIVATE_KEY: string; APPLE_STOREFRONT: string; APPLE_CATALOG_RPS: number; APPLE_CATALOG_BURST: number; APPLE_CATALOG_CONCURRENCY: number; SESSION_SECRET: string; COOKIE_SECURE: boolean; LLM_PROVIDER: "anthropic" | "openai"; LLM_MODEL_GUEST: string; LLM_API_KEY: string; LLM_MAX_TOKENS: number; LLM_DAILY_BUDGET_USD: number }`
  - `parseEnv(source): Env`, `loadEnv(): Env`
  - `parseMigrateEnv(source): { DATABASE_URL: string }`, `loadMigrateEnv()`
  - Rules:
    - Empty strings count as unset.
    - `LLM_MODEL_GUEST` defaults per provider: anthropic → `claude-haiku-4-5`, openai → `gpt-4.1-mini`.
    - The key matching the provider is required and exposed as `LLM_API_KEY`.
    - An unpriced model is rejected.
    - RPS must be a positive number; burst, concurrency and max tokens must be positive integers.
    - `SESSION_SECRET` needs ≥ 32 characters.

- [ ] **Step 1: Add the dependencies**

In `apps/api/package.json` `dependencies`, add:
```json
    "@anthropic-ai/sdk": "^0.131.0",
    "@tunelynk/connectors": "workspace:*",
    "@tunelynk/engine": "workspace:*",
    "drizzle-orm": "^0.45.3",
    "openai": "~7.25.0",
```
Keep the keys sorted. Run: `pnpm install`
Expected: lockfile updated. `pnpm-workspace.yaml` stays unchanged (both SDK versions are already outside the release-age window). If pnpm adds a `minimumReleaseAgeExclude` entry, revert it and pin an older version instead.

- [ ] **Step 2: Write the failing tests**

`apps/api/src/env.test.ts` (replace the whole file):
```ts
import { describe, expect, it } from "vitest";
import { parseEnv, parseMigrateEnv } from "./env";

const DATABASE_URL = "postgres://tunelynk:tunelynk@localhost:5432/tunelynk";
const SESSION_SECRET = "s".repeat(32);
const base = {
  DATABASE_URL,
  APPLE_TEAM_ID: "TEAM",
  APPLE_KEY_ID: "KEY",
  APPLE_PRIVATE_KEY: "PRIVATE",
  SESSION_SECRET,
  ANTHROPIC_API_KEY: "sk-ant",
};

describe("parseEnv", () => {
  it("parses a minimal environment with defaults", () => {
    expect(parseEnv(base)).toEqual({
      DATABASE_URL,
      PORT: 3000,
      APPLE_TEAM_ID: "TEAM",
      APPLE_KEY_ID: "KEY",
      APPLE_PRIVATE_KEY: "PRIVATE",
      APPLE_STOREFRONT: "us",
      APPLE_CATALOG_RPS: 8,
      APPLE_CATALOG_BURST: 10,
      APPLE_CATALOG_CONCURRENCY: 4,
      SESSION_SECRET,
      COOKIE_SECURE: true,
      LLM_PROVIDER: "anthropic",
      LLM_MODEL_GUEST: "claude-haiku-4-5",
      LLM_API_KEY: "sk-ant",
      LLM_MAX_TOKENS: 2000,
      LLM_DAILY_BUDGET_USD: 2,
    });
  });

  it("coerces PORT and treats empty strings as unset", () => {
    const env = parseEnv({ ...base, PORT: "4000", APPLE_STOREFRONT: "" });
    expect(env.PORT).toBe(4000);
    expect(env.APPLE_STOREFRONT).toBe("us");
    expect(parseEnv({ ...base, PORT: "" }).PORT).toBe(3000);
  });

  it("uses the OpenAI key and default model for LLM_PROVIDER=openai", () => {
    const env = parseEnv({
      ...base,
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-oai",
    });
    expect(env.LLM_MODEL_GUEST).toBe("gpt-4.1-mini");
    expect(env.LLM_API_KEY).toBe("sk-oai");
  });

  it("parses COOKIE_SECURE=false", () => {
    expect(parseEnv({ ...base, COOKIE_SECURE: "false" }).COOKIE_SECURE).toBe(
      false,
    );
  });

  it.each([
    ["DATABASE_URL", { ...base, DATABASE_URL: "not-a-url" }],
    ["APPLE_TEAM_ID", { ...base, APPLE_TEAM_ID: undefined }],
    ["SESSION_SECRET", { ...base, SESSION_SECRET: "short" }],
    ["OPENAI_API_KEY", { ...base, LLM_PROVIDER: "openai" }],
    ["LLM_MODEL_GUEST", { ...base, LLM_MODEL_GUEST: "gpt-5-mini" }],
    ["LLM_PROVIDER", { ...base, LLM_PROVIDER: "gemini" }],
    ["APPLE_CATALOG_RPS", { ...base, APPLE_CATALOG_RPS: "abc" }],
    ["APPLE_CATALOG_CONCURRENCY", { ...base, APPLE_CATALOG_CONCURRENCY: "1.5" }],
    ["LLM_DAILY_BUDGET_USD", { ...base, LLM_DAILY_BUDGET_USD: "0" }],
    ["COOKIE_SECURE", { ...base, COOKIE_SECURE: "yes" }],
  ])("fails naming %s", (name, source) => {
    expect(() => parseEnv(source)).toThrow(name);
  });

  it.each(["abc", "0", "70000", "3000.5"])("fails naming PORT for %s", (PORT) => {
    expect(() => parseEnv({ ...base, PORT })).toThrow(/PORT/);
  });
});

describe("parseMigrateEnv", () => {
  it("needs only DATABASE_URL", () => {
    expect(parseMigrateEnv({ DATABASE_URL })).toEqual({ DATABASE_URL });
  });

  it("fails naming DATABASE_URL", () => {
    expect(() => parseMigrateEnv({})).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/api test env`
Expected: FAIL. `parseMigrateEnv` is not exported, and the new fields are missing from the parsed output.

- [ ] **Step 4: Implement**

`apps/api/src/env.ts` (replace the whole file):
```ts
import { assertPricedModel } from "@tunelynk/engine";
import { z } from "zod";

const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
} as const;

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);
const positiveNumber = (fallback: number) =>
  z.coerce.number().positive().default(fallback);

const EnvSchema = z
  .object({
    DATABASE_URL: z.url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APPLE_TEAM_ID: z.string().min(1),
    APPLE_KEY_ID: z.string().min(1),
    APPLE_PRIVATE_KEY: z.string().min(1),
    APPLE_STOREFRONT: z.string().default("us"),
    APPLE_CATALOG_RPS: positiveNumber(8),
    APPLE_CATALOG_BURST: positiveInt(10),
    APPLE_CATALOG_CONCURRENCY: positiveInt(4),
    SESSION_SECRET: z.string().min(32),
    COOKIE_SECURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
    LLM_MODEL_GUEST: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    LLM_MAX_TOKENS: positiveInt(2000),
    LLM_DAILY_BUDGET_USD: positiveNumber(2),
  })
  .transform((env, ctx) => {
    const keyName =
      env.LLM_PROVIDER === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const apiKey = env[keyName];
    if (!apiKey) {
      ctx.addIssue({
        code: "custom",
        path: [keyName],
        message: `required when LLM_PROVIDER=${env.LLM_PROVIDER}`,
      });
      return z.NEVER;
    }
    const model = env.LLM_MODEL_GUEST ?? DEFAULT_MODELS[env.LLM_PROVIDER];
    try {
      assertPricedModel(model);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_MODEL_GUEST"],
        message: err instanceof Error ? err.message : String(err),
      });
      return z.NEVER;
    }
    const { ANTHROPIC_API_KEY: _anthropic, OPENAI_API_KEY: _openai, ...rest } = env;
    return { ...rest, LLM_MODEL_GUEST: model, LLM_API_KEY: apiKey };
  });

const MigrateEnvSchema = z.object({ DATABASE_URL: z.url() });

export type Env = z.infer<typeof EnvSchema>;

// `NAME=` in .env arrives as ""; treat it as unset so defaults apply.
function withoutEmpty(source: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ""),
  );
}

function parseWith<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(withoutEmpty(source));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  return parseWith(EnvSchema, source);
}

export function parseMigrateEnv(source: Record<string, string | undefined>) {
  return parseWith(MigrateEnvSchema, source);
}

function loadOrExit<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export function loadEnv(): Env {
  return loadOrExit(() => parseEnv(process.env));
}

export function loadMigrateEnv() {
  return loadOrExit(() => parseMigrateEnv(process.env));
}
```

In `apps/api/src/migrate.ts`, change `import { loadEnv } from "./env";` to `import { loadMigrateEnv } from "./env";` and `const env = loadEnv();` to `const env = loadMigrateEnv();`. The migration step must not need Apple or LLM secrets.

Append to `.env.example`:
```
# Guest cookie signing (32+ chars): openssl rand -base64 48
SESSION_SECRET=
# false for local http; production default is true
COOKIE_SECURE=false
```

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/api exec biome check --write . && pnpm --filter @tunelynk/api test env && pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api lint`
Expected: 20 env tests PASS (4 parse + 10 failure rows + 4 PORT rows + 2 migrate). Typecheck and lint are clean. The root `.env` needs `SESSION_SECRET` before `pnpm dev` works. Tell the user; never write secrets into `.env` yourself.

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json apps/api/src/env.ts apps/api/src/env.test.ts apps/api/src/migrate.ts .env.example pnpm-lock.yaml
git commit -m "feat(api): validate Apple, LLM, cookie, and budget env"
```

---

### Task 4: Run repository

**Files:**
- Create: `apps/api/src/test/db.ts`, `apps/api/src/runs/messages.ts`, `apps/api/src/runs/repo.ts`
- Test: `apps/api/src/runs/repo.integration.test.ts`

**Interfaces:**
- Consumes: `Db`, `createDb`, `migrateDb`, tables, `RunCandidate` (`@tunelynk/db`); `GeneratedTrack`, `LlmUsage`, `Stage` (`@tunelynk/engine`); `RunResponse` (`@tunelynk/shared`).
- Produces:
  - `createTestDatabase(): Promise<{ db: Db; drop(): Promise<void> }>` (test-only)
  - `RUN_ERRORS = { refusal, notEnough, timeout, interrupted, generic }` (strings from Global Constraints)
  - `createRunRepo(db: Db)` → `RunRepo` with:
    - `createGuest(): Promise<string>`
    - `findUser(id: string): Promise<{ id: string } | undefined>`
    - `touchUser(id: string): Promise<void>`: bumps `last_seen_at` only if it is older than 1 minute
    - `todaysCostMicros(): Promise<number>`: UTC day
    - `createRun(args: { userId: string; prompt: string; length: number; model: string }): Promise<{ created: boolean; runId: string; playlistId: string }>`: `created: false` returns the existing active run
    - `markRunning(runId): Promise<boolean>`: queued → running
    - `setStage(runId, stage: Stage): Promise<void>`: only while running
    - `completeRun(runId, result: { name: string; tracks: GeneratedTrack[]; candidates: RunCandidate[] }): Promise<boolean>`: only while running; upserts tracks, writes `run_tracks` at positions 1..n, sets the playlist name and `current_run_id`
    - `failRun(runId, error: string, candidates?: RunCandidate[]): Promise<boolean>`: only while queued or running
    - `recordUsage(args: { userId: string | null; usage: LlmUsage; costMicros: number; kind: "guest" | "user" | "scheduled" }): Promise<void>`
    - `getRun(runId): Promise<RunResponse | undefined>`
    - `failStaleRuns(olderThanMs: number): Promise<number>`

- [ ] **Step 1: Write the test helper and the failing test**

`apps/api/src/test/db.ts`:
```ts
import { fileURLToPath } from "node:url";
import { createDb, type Db, migrateDb } from "@tunelynk/db";
import postgres from "postgres";

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

// A throwaway, fully migrated database per test file. Needs DATABASE_URL.
export async function createTestDatabase(): Promise<{
  db: Db;
  drop(): Promise<void>;
}> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is required");
  const name = `tunelynk_api_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await migrateDb(url.toString(), migrationsFolder);
  const db = createDb(url.toString());
  return {
    db,
    async drop() {
      await db.$client.end();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}
```

`apps/api` needs `postgres` for the helper. Add `"postgres": "^3.4.9"` to `apps/api/package.json` `devDependencies` and run `pnpm install`.

`apps/api/src/runs/repo.integration.test.ts`:
```ts
import { generationRuns, llmUsage, users } from "@tunelynk/db";
import type { GeneratedTrack } from "@tunelynk/engine";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/db";
import { RUN_ERRORS } from "./messages";
import { createRunRepo, type RunRepo } from "./repo";

const track = (id: string, title: string, extra: Partial<GeneratedTrack> = {}): GeneratedTrack => ({
  appleSongId: id,
  isrc: `ISRC${id}`,
  title,
  artistName: "Fleetwood Mac",
  artistIds: [],
  album: "Rumours",
  durationMs: 200_000,
  explicit: false,
  artworkUrl: `https://img/${id}.jpg`,
  previewUrl: `https://audio/${id}.m4a`,
  source: "llm",
  ...extra,
});

const usage = { model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 200 };

describe.skipIf(!process.env.DATABASE_URL)("run repository", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let repo: RunRepo;

  beforeAll(async () => {
    handle = await createTestDatabase();
    repo = createRunRepo(handle.db);
  });
  afterAll(() => handle.drop());

  const newRun = async () => {
    const userId = await repo.createGuest();
    const run = await repo.createRun({ userId, prompt: "road trip", length: 20, model: "claude-haiku-4-5" });
    return { userId, ...run };
  };

  it("creates a guest, a draft playlist, and a queued run", async () => {
    const { userId, created, runId, playlistId } = await newRun();
    expect(created).toBe(true);
    expect(await repo.findUser(userId)).toEqual({ id: userId });
    expect(await repo.getRun(runId)).toEqual({
      id: runId,
      status: "queued",
      stage: null,
      error: null,
      playlist: { id: playlistId, name: "road trip", prompt: "road trip" },
      tracks: [],
      unmatched: [],
    });
  });

  it("returns the existing run instead of creating a second active one", async () => {
    const first = await newRun();
    const second = await repo.createRun({ userId: first.userId, prompt: "again", length: 20, model: "claude-haiku-4-5" });
    expect(second).toEqual({ created: false, runId: first.runId, playlistId: first.playlistId });
  });

  it("serializes concurrent creation for one user", async () => {
    const userId = await repo.createGuest();
    const args = { userId, prompt: "p", length: 20, model: "claude-haiku-4-5" };
    const results = await Promise.all([repo.createRun(args), repo.createRun(args)]);
    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
  });

  it("runs the lifecycle: running → stage → draft with tracks", async () => {
    const { runId, playlistId } = await newRun();
    expect(await repo.markRunning(runId)).toBe(true);
    expect(await repo.markRunning(runId)).toBe(false);
    await repo.setStage(runId, "matching");
    expect((await repo.getRun(runId))?.stage).toBe("matching");

    const done = await repo.completeRun(runId, {
      name: "Sunday Drive",
      tracks: [track("1", "Dreams"), track("2", "Landslide", { source: "backfill", previewUrl: undefined, artworkUrl: undefined })],
      candidates: [
        { title: "Dreams", artist: "Fleetwood Mac", status: "matched", appleSongId: "1" },
        { title: "Nope", artist: "Nobody", status: "unmatched" },
      ],
    });

    expect(done).toBe(true);
    const run = await repo.getRun(runId);
    expect(run).toMatchObject({
      status: "draft",
      stage: null,
      playlist: { id: playlistId, name: "Sunday Drive" },
      unmatched: [{ title: "Nope", artist: "Nobody" }],
    });
    expect(run?.tracks).toEqual([
      { position: 1, appleSongId: "1", title: "Dreams", artistName: "Fleetwood Mac", album: "Rumours", artworkUrl: "https://img/1.jpg", previewUrl: "https://audio/1.m4a", durationMs: 200_000, explicit: false, source: "llm" },
      { position: 2, appleSongId: "2", title: "Landslide", artistName: "Fleetwood Mac", album: "Rumours", artworkUrl: null, previewUrl: null, durationMs: 200_000, explicit: false, source: "backfill" },
    ]);
  });

  it("upserts tracks shared across runs", async () => {
    const a = await newRun();
    await repo.markRunning(a.runId);
    await repo.completeRun(a.runId, { name: "A", tracks: [track("77", "Old Title")], candidates: [] });
    const b = await newRun();
    await repo.markRunning(b.runId);
    await repo.completeRun(b.runId, { name: "B", tracks: [track("77", "New Title")], candidates: [] });
    expect((await repo.getRun(a.runId))?.tracks[0]?.title).toBe("New Title");
  });

  it("does not complete or fail a run that already finished", async () => {
    const { runId } = await newRun();
    await repo.markRunning(runId);
    expect(await repo.failRun(runId, RUN_ERRORS.timeout)).toBe(true);
    expect(await repo.completeRun(runId, { name: "late", tracks: [track("9", "Late")], candidates: [] })).toBe(false);
    expect(await repo.failRun(runId, RUN_ERRORS.generic)).toBe(false);
    expect(await repo.getRun(runId)).toMatchObject({ status: "failed", error: RUN_ERRORS.timeout, tracks: [] });
  });

  it("stores candidates on failure", async () => {
    const { runId } = await newRun();
    await repo.markRunning(runId);
    await repo.failRun(runId, RUN_ERRORS.notEnough, [{ title: "X", artist: "Y", status: "unmatched" }]);
    expect((await repo.getRun(runId))?.unmatched).toEqual([{ title: "X", artist: "Y" }]);
  });

  it("sums only today's usage", async () => {
    const before = await repo.todaysCostMicros();
    const userId = await repo.createGuest();
    await repo.recordUsage({ userId, usage, costMicros: 1100, kind: "guest" });
    await handle.db.insert(llmUsage).values({
      userId,
      model: "claude-haiku-4-5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 999_999,
      kind: "guest",
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });
    expect(await repo.todaysCostMicros()).toBe(before + 1100);
  });

  it("touches last_seen_at at most once a minute", async () => {
    const userId = await repo.createGuest();
    await handle.db.update(users).set({ lastSeenAt: sql`now() - interval '2 minutes'` }).where(eq(users.id, userId));
    const read = async () => (await handle.db.select({ t: users.lastSeenAt }).from(users).where(eq(users.id, userId)))[0]?.t.getTime() ?? 0;
    const stale = await read();
    await repo.touchUser(userId);
    const fresh = await read();
    expect(fresh).toBeGreaterThan(stale);
    await repo.touchUser(userId);
    expect(await read()).toBe(fresh);
  });

  it("fails only stale active runs at boot", async () => {
    const old = await newRun();
    const recent = await newRun();
    await handle.db.update(generationRuns).set({ createdAt: sql`now() - interval '10 minutes'` }).where(eq(generationRuns.id, old.runId));
    expect(await repo.failStaleRuns(5 * 60_000)).toBeGreaterThanOrEqual(1);
    expect(await repo.getRun(old.runId)).toMatchObject({ status: "failed", error: RUN_ERRORS.interrupted });
    expect((await repo.getRun(recent.runId))?.status).toBe("queued");
  });

  it("returns undefined for an unknown run", async () => {
    expect(await repo.getRun("00000000-0000-4000-8000-000000000000")).toBe(undefined);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/api test:integration repo`
Expected: FAIL with `Cannot find module './messages'` / `'./repo'`.

- [ ] **Step 3: Implement**

`apps/api/src/runs/messages.ts`:
```ts
// User-facing run errors. Full details go to the server log, never the client.
export const RUN_ERRORS = {
  refusal: "That doesn't look like a playlist request.",
  notEnough: "Couldn't find enough tracks for that prompt.",
  timeout: "Generation took too long. Try again.",
  interrupted: "Generation was interrupted. Try again.",
  generic: "Something went wrong generating this playlist.",
} as const;
```

`apps/api/src/runs/repo.ts`:
```ts
import {
  type Db,
  generationRuns,
  llmUsage,
  playlists,
  type RunCandidate,
  runTracks,
  tracks,
  users,
} from "@tunelynk/db";
import type { GeneratedTrack, LlmUsage, Stage } from "@tunelynk/engine";
import type { RunResponse } from "@tunelynk/shared";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { RUN_ERRORS } from "./messages";

const ACTIVE: ("queued" | "running")[] = ["queued", "running"];
const NAME_FROM_PROMPT_LENGTH = 60;

export type CompletedRun = {
  name: string;
  tracks: GeneratedTrack[];
  candidates: RunCandidate[];
};

export function createRunRepo(db: Db) {
  return {
    async createGuest(): Promise<string> {
      const [row] = await db
        .insert(users)
        .values({ isGuest: true })
        .returning({ id: users.id });
      if (!row) throw new Error("guest insert returned no row");
      return row.id;
    },

    async findUser(id: string): Promise<{ id: string } | undefined> {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, id));
      return row;
    },

    async touchUser(id: string): Promise<void> {
      await db
        .update(users)
        .set({ lastSeenAt: sql`now()` })
        .where(
          and(
            eq(users.id, id),
            lt(users.lastSeenAt, sql`now() - interval '1 minute'`),
          ),
        );
    },

    async todaysCostMicros(): Promise<number> {
      const [row] = await db
        .select({
          total: sql<string>`coalesce(sum(${llmUsage.costMicros}), 0)`,
        })
        .from(llmUsage)
        .where(
          gte(
            llmUsage.createdAt,
            sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`,
          ),
        );
      return Number(row?.total ?? 0);
    },

    // One active run per user. The advisory lock serializes concurrent POSTs
    // for the same user so both can't pass the check.
    async createRun(args: {
      userId: string;
      prompt: string;
      length: number;
      model: string;
    }): Promise<{ created: boolean; runId: string; playlistId: string }> {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${args.userId}))`,
        );
        const [active] = await tx
          .select({
            runId: generationRuns.id,
            playlistId: generationRuns.playlistId,
          })
          .from(generationRuns)
          .innerJoin(playlists, eq(playlists.id, generationRuns.playlistId))
          .where(
            and(
              eq(playlists.userId, args.userId),
              inArray(generationRuns.status, ACTIVE),
            ),
          )
          .limit(1);
        if (active) return { created: false, ...active };

        const [playlist] = await tx
          .insert(playlists)
          .values({
            userId: args.userId,
            name: args.prompt.slice(0, NAME_FROM_PROMPT_LENGTH),
            prompt: args.prompt,
            length: args.length,
          })
          .returning({ id: playlists.id });
        if (!playlist) throw new Error("playlist insert returned no row");
        const [run] = await tx
          .insert(generationRuns)
          .values({ playlistId: playlist.id, llmModel: args.model })
          .returning({ id: generationRuns.id });
        if (!run) throw new Error("run insert returned no row");
        return { created: true, runId: run.id, playlistId: playlist.id };
      });
    },

    async markRunning(runId: string): Promise<boolean> {
      const rows = await db
        .update(generationRuns)
        .set({ status: "running", startedAt: sql`now()` })
        .where(
          and(eq(generationRuns.id, runId), eq(generationRuns.status, "queued")),
        )
        .returning({ id: generationRuns.id });
      return rows.length > 0;
    },

    async setStage(runId: string, stage: Stage): Promise<void> {
      await db
        .update(generationRuns)
        .set({ stage })
        .where(
          and(
            eq(generationRuns.id, runId),
            eq(generationRuns.status, "running"),
          ),
        );
    },

    // Only a running run can complete: a run the deadline already failed
    // stays failed even if the engine finishes late.
    async completeRun(runId: string, result: CompletedRun): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [run] = await tx
          .update(generationRuns)
          .set({
            status: "draft",
            stage: null,
            candidates: result.candidates,
            finishedAt: sql`now()`,
          })
          .where(
            and(
              eq(generationRuns.id, runId),
              eq(generationRuns.status, "running"),
            ),
          )
          .returning({ playlistId: generationRuns.playlistId });
        if (!run) return false;

        if (result.tracks.length > 0) {
          const saved = await tx
            .insert(tracks)
            .values(
              result.tracks.map((t) => ({
                appleSongId: t.appleSongId,
                isrc: t.isrc ?? null,
                title: t.title,
                artistName: t.artistName,
                album: t.album,
                durationMs: t.durationMs,
                explicit: t.explicit,
                artworkUrl: t.artworkUrl ?? null,
                previewUrl: t.previewUrl ?? null,
              })),
            )
            .onConflictDoUpdate({
              target: tracks.appleSongId,
              set: {
                isrc: sql`excluded.isrc`,
                title: sql`excluded.title`,
                artistName: sql`excluded.artist_name`,
                album: sql`excluded.album`,
                durationMs: sql`excluded.duration_ms`,
                explicit: sql`excluded.explicit`,
                artworkUrl: sql`excluded.artwork_url`,
                previewUrl: sql`excluded.preview_url`,
              },
            })
            .returning({ id: tracks.id, appleSongId: tracks.appleSongId });
          const idBySong = new Map(saved.map((r) => [r.appleSongId, r.id]));
          await tx.insert(runTracks).values(
            result.tracks.map((t, i) => ({
              runId,
              position: i + 1,
              trackId: idBySong.get(t.appleSongId) as string,
              source: t.source,
            })),
          );
        }

        await tx
          .update(playlists)
          .set({ name: result.name, currentRunId: runId })
          .where(eq(playlists.id, run.playlistId));
        return true;
      });
    },

    async failRun(
      runId: string,
      error: string,
      candidates?: RunCandidate[],
    ): Promise<boolean> {
      const rows = await db
        .update(generationRuns)
        .set({
          status: "failed",
          error,
          finishedAt: sql`now()`,
          ...(candidates ? { candidates } : {}),
        })
        .where(
          and(
            eq(generationRuns.id, runId),
            inArray(generationRuns.status, ACTIVE),
          ),
        )
        .returning({ id: generationRuns.id });
      return rows.length > 0;
    },

    async recordUsage(args: {
      userId: string | null;
      usage: LlmUsage;
      costMicros: number;
      kind: "guest" | "user" | "scheduled";
    }): Promise<void> {
      await db.insert(llmUsage).values({
        userId: args.userId,
        model: args.usage.model,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        costMicros: args.costMicros,
        kind: args.kind,
      });
    },

    async getRun(runId: string): Promise<RunResponse | undefined> {
      const [row] = await db
        .select({
          id: generationRuns.id,
          status: generationRuns.status,
          stage: generationRuns.stage,
          error: generationRuns.error,
          candidates: generationRuns.candidates,
          playlistId: playlists.id,
          name: playlists.name,
          prompt: playlists.prompt,
        })
        .from(generationRuns)
        .innerJoin(playlists, eq(playlists.id, generationRuns.playlistId))
        .where(eq(generationRuns.id, runId));
      if (!row) return undefined;

      const trackRows = await db
        .select({
          position: runTracks.position,
          appleSongId: tracks.appleSongId,
          title: tracks.title,
          artistName: tracks.artistName,
          album: tracks.album,
          artworkUrl: tracks.artworkUrl,
          previewUrl: tracks.previewUrl,
          durationMs: tracks.durationMs,
          explicit: tracks.explicit,
          source: runTracks.source,
        })
        .from(runTracks)
        .innerJoin(tracks, eq(tracks.id, runTracks.trackId))
        .where(and(eq(runTracks.runId, runId), eq(runTracks.removed, false)))
        .orderBy(asc(runTracks.position));

      return {
        id: row.id,
        status: row.status,
        stage: row.stage,
        error: row.error,
        playlist: { id: row.playlistId, name: row.name, prompt: row.prompt },
        tracks: trackRows,
        unmatched: row.candidates
          .filter((c) => c.status === "unmatched")
          .map(({ title, artist }) => ({ title, artist })),
      };
    },

    async failStaleRuns(olderThanMs: number): Promise<number> {
      const rows = await db
        .update(generationRuns)
        .set({
          status: "failed",
          error: RUN_ERRORS.interrupted,
          finishedAt: sql`now()`,
        })
        .where(
          and(
            inArray(generationRuns.status, ACTIVE),
            lt(
              generationRuns.createdAt,
              sql`now() - make_interval(secs => ${olderThanMs / 1000})`,
            ),
          ),
        )
        .returning({ id: generationRuns.id });
      return rows.length;
    },
  };
}

export type RunRepo = ReturnType<typeof createRunRepo>;
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/api exec biome check --write . && pnpm --filter @tunelynk/api test:integration repo && pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api lint`
Expected: 11 repo tests PASS against a fresh migrated database; typecheck and lint clean.
- If `make_interval(secs => $1)` errors on the parameter type, cast it as `${olderThanMs / 1000}::double precision`.
- If `as string` on the map lookup is flagged, keep it: the upsert returns every inserted song.
- Ledger any other change as a ruling.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/test apps/api/src/runs apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add run repository with race-free run creation"
```

---

### Task 5: Run executor

**Files:**
- Create: `apps/api/src/runs/executor.ts`
- Test: `apps/api/src/runs/executor.test.ts`

**Interfaces:**
- Consumes: `RunRepo` (Task 4), `RUN_ERRORS` (Task 4); `costMicros`, `EngineError`, `NotEnoughTracksError`, `RefusalError`, `GenerateInput`, `GenerateResult`, `LlmUsage`, `Stage` (`@tunelynk/engine`).
- Produces:
  - `type Engine = (input: GenerateInput, onStage: (stage: Stage) => void) => Promise<GenerateResult>`
  - `type RunJob = { runId: string; userId: string; prompt: string; length: number }`
  - `type ExecutorRepo = Pick<RunRepo, "markRunning" | "setStage" | "completeRun" | "failRun" | "recordUsage">`
  - `RUN_DEADLINE_MS = 120_000`
  - `createRunExecutor(options: { repo: ExecutorRepo; engine: Engine; deadlineMs?: number; logger?: Pick<Console, "error"> }): { start(job: RunJob): Promise<void> }`. `start` never rejects. Routes call it without awaiting; tests await it.

- [ ] **Step 1: Write the failing test**

`apps/api/src/runs/executor.test.ts`:
```ts
import {
  costMicros,
  type GenerateResult,
  NotEnoughTracksError,
  RefusalError,
} from "@tunelynk/engine";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor, type Engine, type ExecutorRepo } from "./executor";
import { RUN_ERRORS } from "./messages";

const usage = { model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 200 };
const job = { runId: "run-1", userId: "user-1", prompt: "road trip", length: 20 };
const result: GenerateResult = { name: "Road Trip", tracks: [], candidates: [], usage };

function fakeRepo(overrides: Partial<ExecutorRepo> = {}) {
  return {
    markRunning: vi.fn(async () => true),
    setStage: vi.fn(async () => {}),
    completeRun: vi.fn(async () => true),
    failRun: vi.fn(async () => true),
    recordUsage: vi.fn(async () => {}),
    ...overrides,
  } satisfies ExecutorRepo;
}

const quietLogger = () => ({ error: vi.fn() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createRunExecutor", () => {
  it("runs the engine, forwards stages, records usage, and completes", async () => {
    const repo = fakeRepo();
    const engine = vi.fn<Engine>(async (_input, onStage) => {
      onStage("llm");
      onStage("matching");
      return result;
    });

    await createRunExecutor({ repo, engine }).start(job);

    expect(repo.markRunning).toHaveBeenCalledWith("run-1");
    expect(engine.mock.calls[0]?.[0]).toEqual({ prompt: "road trip", length: 20 });
    expect(repo.setStage.mock.calls).toEqual([["run-1", "llm"], ["run-1", "matching"]]);
    expect(repo.recordUsage).toHaveBeenCalledWith({
      userId: "user-1",
      usage,
      costMicros: costMicros(usage),
      kind: "guest",
    });
    expect(repo.completeRun).toHaveBeenCalledWith("run-1", result);
    expect(repo.failRun).not.toHaveBeenCalled();
  });

  it("does nothing when the run is no longer queued", async () => {
    const repo = fakeRepo({ markRunning: vi.fn(async () => false) });
    const engine = vi.fn<Engine>(async () => result);
    await createRunExecutor({ repo, engine }).start(job);
    expect(engine).not.toHaveBeenCalled();
  });

  it("maps a refusal to the refusal message and records usage", async () => {
    const repo = fakeRepo();
    const engine: Engine = async () => {
      throw new RefusalError("not music", usage);
    };
    await createRunExecutor({ repo, engine, logger: quietLogger() }).start(job);
    expect(repo.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ usage }));
    expect(repo.failRun).toHaveBeenCalledWith("run-1", RUN_ERRORS.refusal, undefined);
  });

  it("stores candidates when there are not enough tracks", async () => {
    const repo = fakeRepo();
    const candidates = [{ title: "A", artist: "B", status: "unmatched" as const }];
    const engine: Engine = async () => {
      throw new NotEnoughTracksError(1, 10, candidates, usage);
    };
    await createRunExecutor({ repo, engine, logger: quietLogger() }).start(job);
    expect(repo.failRun).toHaveBeenCalledWith("run-1", RUN_ERRORS.notEnough, candidates);
  });

  it("uses the generic message for unexpected errors and logs them", async () => {
    const repo = fakeRepo();
    const logger = quietLogger();
    const engine: Engine = async () => {
      throw new Error("socket hang up");
    };
    await createRunExecutor({ repo, engine, logger }).start(job);
    expect(repo.recordUsage).not.toHaveBeenCalled();
    expect(repo.failRun).toHaveBeenCalledWith("run-1", RUN_ERRORS.generic, undefined);
    expect(logger.error).toHaveBeenCalled();
  });

  it("fails the run at the deadline and still records late usage", async () => {
    const repo = fakeRepo({ completeRun: vi.fn(async () => false) });
    const engine: Engine = async () => {
      await sleep(50);
      return result;
    };

    await createRunExecutor({ repo, engine, deadlineMs: 10, logger: quietLogger() }).start(job);

    expect(repo.failRun).toHaveBeenCalledWith("run-1", RUN_ERRORS.timeout);
    expect(repo.completeRun).not.toHaveBeenCalled();
    await sleep(80);
    expect(repo.recordUsage).toHaveBeenCalledTimes(1);
    expect(repo.completeRun).toHaveBeenCalledTimes(1); // late, and a no-op in the real repo
  });

  it("keeps going when a stage update fails", async () => {
    const repo = fakeRepo({ setStage: vi.fn(async () => Promise.reject(new Error("db blip"))) });
    const logger = quietLogger();
    const engine: Engine = async (_input, onStage) => {
      onStage("llm");
      return result;
    };
    await createRunExecutor({ repo, engine, logger }).start(job);
    await sleep(0);
    expect(repo.completeRun).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("never rejects, even when the repository is down", async () => {
    const repo = fakeRepo({
      markRunning: vi.fn(async () => Promise.reject(new Error("db down"))),
      failRun: vi.fn(async () => Promise.reject(new Error("db down"))),
    });
    const engine = vi.fn<Engine>(async () => result);
    await expect(
      createRunExecutor({ repo, engine, logger: quietLogger() }).start(job),
    ).resolves.toBeUndefined();
    expect(engine).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/api test executor`
Expected: FAIL with `Cannot find module './executor'`.

- [ ] **Step 3: Implement**

`apps/api/src/runs/executor.ts`:
```ts
import {
  costMicros,
  EngineError,
  type GenerateInput,
  type GenerateResult,
  type LlmUsage,
  NotEnoughTracksError,
  RefusalError,
  type Stage,
} from "@tunelynk/engine";
import { RUN_ERRORS } from "./messages";
import type { RunRepo } from "./repo";

export type Engine = (
  input: GenerateInput,
  onStage: (stage: Stage) => void,
) => Promise<GenerateResult>;

export type RunJob = {
  runId: string;
  userId: string;
  prompt: string;
  length: number;
};

export type ExecutorRepo = Pick<
  RunRepo,
  "markRunning" | "setStage" | "completeRun" | "failRun" | "recordUsage"
>;

// Bounds a whole run. SDK timeouts and the schema-repair retry can otherwise
// stack up to about 4 minutes.
export const RUN_DEADLINE_MS = 120_000;

function messageFor(err: unknown): string {
  if (err instanceof RefusalError) return RUN_ERRORS.refusal;
  if (err instanceof NotEnoughTracksError) return RUN_ERRORS.notEnough;
  return RUN_ERRORS.generic;
}

export function createRunExecutor({
  repo,
  engine,
  deadlineMs = RUN_DEADLINE_MS,
  logger = console,
}: {
  repo: ExecutorRepo;
  engine: Engine;
  deadlineMs?: number;
  logger?: Pick<Console, "error">;
}) {
  const recordUsage = (userId: string, usage: LlmUsage) =>
    repo.recordUsage({
      userId,
      usage,
      costMicros: costMicros(usage),
      kind: "guest",
    });

  async function execute(job: RunJob): Promise<void> {
    try {
      const result = await engine(
        { prompt: job.prompt, length: job.length },
        (stage) => {
          repo
            .setStage(job.runId, stage)
            .catch((err) =>
              logger.error(`run ${job.runId}: stage update failed`, err),
            );
        },
      );
      await recordUsage(job.userId, result.usage);
      await repo.completeRun(job.runId, result);
    } catch (err) {
      logger.error(`run ${job.runId} failed`, err);
      if (err instanceof EngineError && err.usage) {
        await recordUsage(job.userId, err.usage);
      }
      await repo.failRun(
        job.runId,
        messageFor(err),
        err instanceof NotEnoughTracksError ? err.candidates : undefined,
      );
    }
  }

  return {
    async start(job: RunJob): Promise<void> {
      try {
        if (!(await repo.markRunning(job.runId))) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), deadlineMs);
        });
        // After the deadline the work keeps going: it still records usage, and
        // the repo refuses to complete a run that is no longer running.
        const work = execute(job).catch((err) =>
          logger.error(`run ${job.runId}: executor error`, err),
        );
        const outcome = await Promise.race([
          work.then(() => "done" as const),
          deadline,
        ]);
        clearTimeout(timer);
        if (outcome === "deadline") {
          await repo.failRun(job.runId, RUN_ERRORS.timeout);
        }
      } catch (err) {
        logger.error(`run ${job.runId}: executor error`, err);
        await repo.failRun(job.runId, RUN_ERRORS.generic).catch(() => {});
      }
    },
  };
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/api exec biome check --write . && pnpm --filter @tunelynk/api test executor && pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api lint`
Expected: 8 executor tests PASS; typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runs/executor.ts apps/api/src/runs/executor.test.ts
git commit -m "feat(api): add in-process run executor with deadline and usage recording"
```

---

### Task 6: Runs routes, guest cookie, app wiring

**Files:**
- Create: `apps/api/src/runs/routes.ts`
- Test: `apps/api/src/runs/routes.integration.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/app.test.ts`, `apps/api/src/app.web.test.ts`, `apps/api/src/app.integration.test.ts`

**Interfaces:**
- Consumes: `RunRepo`, `createRunRepo` (Task 4); `RunJob`, `createRunExecutor`, `Engine` (Task 5); `CreateRunRequest`, `CreateRunResponse`, `ApiError`, `RunResponse` (`@tunelynk/shared`); `getSignedCookie`, `setSignedCookie` (`hono/cookie`).
- Produces:
  - `type RunsDeps = { repo: RunRepo; executor: { start(job: RunJob): Promise<void> }; sessionSecret: string; secureCookies: boolean; dailyBudgetMicros: number; model: string }`
  - `GUEST_COOKIE = "tl_guest"`, `GUEST_LENGTH = 20`
  - `runsRoutes(deps: RunsDeps)`: Hono app with `POST /` and `GET /:id`
  - `AppDeps = { db: Db; webDir?: string; runs: RunsDeps }`. `createApp` mounts the routes at `/api/runs`, and `AppType` includes them for slice D's RPC client.

- [ ] **Step 1: Pass a runs stub to existing app tests**

The app now requires `runs`. In `apps/api/src/app.test.ts`, `apps/api/src/app.web.test.ts`, and `apps/api/src/app.integration.test.ts`:
- add `import type { RunsDeps } from "./runs/routes";`
- add `const runs = {} as RunsDeps; // health/static tests never hit /api/runs`
- in every `createApp({ … })` call, add `runs,`. There are 5 calls: app.test.ts ×3, app.web.test.ts ×2, app.integration.test.ts ×1.

- [ ] **Step 2: Write the failing integration test**

`apps/api/src/runs/routes.integration.test.ts`:
```ts
import { llmUsage, playlists, users } from "@tunelynk/db";
import { type GenerateResult, RefusalError } from "@tunelynk/engine";
import type { RunResponse } from "@tunelynk/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createTestDatabase } from "../test/db";
import { createRunExecutor, type Engine, type RunJob } from "./executor";
import { RUN_ERRORS } from "./messages";
import { createRunRepo } from "./repo";

const SECRET = "test-secret-test-secret-test-secret!";
const usage = { model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 200 };
const okResult: GenerateResult = {
  name: "Sunday Drive",
  tracks: [
    {
      appleSongId: "1",
      isrc: "ISRC1",
      title: "Dreams",
      artistName: "Fleetwood Mac",
      artistIds: [],
      album: "Rumours",
      durationMs: 257_000,
      explicit: false,
      artworkUrl: "https://img/1.jpg",
      previewUrl: "https://audio/1.m4a",
      source: "llm",
    },
  ],
  candidates: [
    { title: "Dreams", artist: "Fleetwood Mac", status: "matched", appleSongId: "1" },
    { title: "Nope", artist: "Nobody", status: "unmatched" },
  ],
  usage,
};

const cookieFrom = (res: Response) =>
  res.headers.get("set-cookie")?.split(";")[0] ?? "";

describe.skipIf(!process.env.DATABASE_URL)("/api/runs", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  let engine: Engine;
  let pending: Promise<void>[];
  let secureCookies: boolean;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });
  afterAll(() => handle.drop());

  beforeEach(async () => {
    await handle.db.execute(sql`truncate users, llm_usage, tracks cascade`);
    engine = async () => okResult;
    pending = [];
    secureCookies = false;
    const repo = createRunRepo(handle.db);
    const real = createRunExecutor({
      repo,
      engine: (input, onStage) => engine(input, onStage),
      logger: { error: () => {} },
    });
    const build = () =>
      createApp({
        db: handle.db,
        runs: {
          repo,
          executor: {
            start: (job: RunJob) => {
              const p = real.start(job);
              pending.push(p);
              return p;
            },
          },
          sessionSecret: SECRET,
          get secureCookies() {
            return secureCookies;
          },
          dailyBudgetMicros: 2_000_000,
          model: "claude-haiku-4-5",
        },
      });
    app = build();
  });

  const post = (body: unknown, cookie = "") =>
    app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (id: string, cookie = "") =>
    app.request(`/api/runs/${id}`, { headers: cookie ? { cookie } : {} });
  const count = async (table: typeof users | typeof playlists) =>
    (await handle.db.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n ?? 0;

  it("creates a run, sets the guest cookie, and serves the finished playlist", async () => {
    const res = await post({ prompt: "  sunday drive  " });
    expect(res.status).toBe(202);
    const { runId, playlistId } = (await res.json()) as { runId: string; playlistId: string };

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^tl_guest=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Max-Age=2592000/);
    expect(setCookie).not.toMatch(/Secure/);

    await Promise.all(pending);
    const run = (await (await get(runId)).json()) as RunResponse;
    expect(run).toEqual({
      id: runId,
      status: "draft",
      stage: null,
      error: null,
      playlist: { id: playlistId, name: "Sunday Drive", prompt: "sunday drive" },
      tracks: [
        {
          position: 1,
          appleSongId: "1",
          title: "Dreams",
          artistName: "Fleetwood Mac",
          album: "Rumours",
          artworkUrl: "https://img/1.jpg",
          previewUrl: "https://audio/1.m4a",
          durationMs: 257_000,
          explicit: false,
          source: "llm",
        },
      ],
      unmatched: [{ title: "Nope", artist: "Nobody" }],
    });
    const [spent] = await handle.db.select({ c: llmUsage.costMicros, k: llmUsage.kind }).from(llmUsage);
    expect(spent).toEqual({ c: 1100, k: "guest" });
  });

  it("sets Secure on the cookie when configured", async () => {
    secureCookies = true;
    const res = await post({ prompt: "p" });
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);
    await Promise.all(pending);
  });

  it("reports a refusal as a failed run with the user-safe message", async () => {
    engine = async () => {
      throw new RefusalError("not music", usage);
    };
    const { runId } = (await (await post({ prompt: "write python" })).json()) as { runId: string };
    await Promise.all(pending);
    expect(await (await get(runId)).json()).toMatchObject({
      status: "failed",
      error: RUN_ERRORS.refusal,
      tracks: [],
    });
    expect(await count(users)).toBe(1);
  });

  it.each([
    ["empty prompt", { prompt: "" }],
    ["281 characters", { prompt: "x".repeat(281) }],
    ["missing prompt", {}],
    ["non-JSON body", "not json"],
  ])("rejects %s with 400 and writes nothing", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_prompt" });
    expect(await count(users)).toBe(0);
    expect(await count(playlists)).toBe(0);
  });

  it("returns 409 with the active run while one is in progress", async () => {
    let release: (r: GenerateResult) => void = () => {};
    engine = () => new Promise((resolve) => (release = resolve));
    const first = await post({ prompt: "one" });
    const cookie = cookieFrom(first);
    const ids = await first.json();

    const second = await post({ prompt: "two" }, cookie);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "run_in_progress", ...ids });

    release(okResult);
    await Promise.all(pending);
    expect((await post({ prompt: "three" }, cookie)).status).toBe(202);
    await Promise.all(pending);
  });

  it("allows exactly one of two simultaneous POSTs with the same cookie", async () => {
    engine = () => new Promise(() => {});
    const seed = await post({ prompt: "seed" });
    const cookie = cookieFrom(seed);
    await handle.db.execute(sql`update generation_runs set status = 'failed'`);
    const statuses = (await Promise.all([post({ prompt: "a" }, cookie), post({ prompt: "b" }, cookie)])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([202, 409]);
  });

  it("returns 503 when today's budget is spent, before writing a playlist", async () => {
    await handle.db.insert(llmUsage).values({
      userId: null,
      model: "claude-haiku-4-5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 2_000_000,
      kind: "guest",
    });
    const res = await post({ prompt: "p" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "budget_exceeded" });
    expect(await count(playlists)).toBe(0);
  });

  it("reuses the guest across runs with the same cookie", async () => {
    const first = await post({ prompt: "one" });
    const cookie = cookieFrom(first);
    await Promise.all(pending);
    const second = await post({ prompt: "two" }, cookie);
    expect(second.status).toBe(202);
    expect(second.headers.get("set-cookie")).toBe(null);
    await Promise.all(pending);
    expect(await count(users)).toBe(1);
  });

  it("creates a new guest for a tampered cookie", async () => {
    const first = await post({ prompt: "one" });
    await Promise.all(pending);
    const tampered = `${cookieFrom(first).slice(0, -3)}abc`;
    const second = await post({ prompt: "two" }, tampered);
    expect(second.headers.get("set-cookie")).toMatch(/^tl_guest=/);
    await Promise.all(pending);
    expect(await count(users)).toBe(2);
  });

  it("creates a new guest when the cookie's user no longer exists", async () => {
    const first = await post({ prompt: "one" });
    const cookie = cookieFrom(first);
    const ids = (await first.json()) as { runId: string };
    await Promise.all(pending);
    expect((await get(ids.runId, cookie)).status).toBe(200);
    await handle.db.delete(users);

    const second = await post({ prompt: "two" }, cookie);
    expect(second.status).toBe(202);
    expect(second.headers.get("set-cookie")).toMatch(/^tl_guest=/);
    await Promise.all(pending);
    expect(await count(users)).toBe(1);
  });

  it("GET never creates users and 404s unknown or malformed ids", async () => {
    expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const malformed = await get("not-a-uuid");
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: "not_found" });
    expect(await count(users)).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @tunelynk/api test:integration routes`
Expected: FAIL with `Cannot find module './routes'`. The unit suite (`pnpm --filter @tunelynk/api test`) also fails to typecheck the stub import until `routes.ts` exists; that's expected.

- [ ] **Step 4: Implement the routes and mount them**

`apps/api/src/runs/routes.ts`:
```ts
import {
  type ApiError,
  CreateRunRequest,
  type CreateRunResponse,
  type RunResponse,
} from "@tunelynk/shared";
import { type Context, Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import type { RunJob } from "./executor";
import type { RunRepo } from "./repo";

export const GUEST_COOKIE = "tl_guest";
export const GUEST_LENGTH = 20;
const GUEST_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunsDeps = {
  repo: RunRepo;
  executor: { start(job: RunJob): Promise<void> };
  sessionSecret: string;
  secureCookies: boolean;
  dailyBudgetMicros: number;
  model: string;
};

async function readGuest(
  c: Context,
  deps: RunsDeps,
): Promise<string | undefined> {
  const value = await getSignedCookie(c, deps.sessionSecret, GUEST_COOKIE);
  if (!value || !UUID.test(value)) return undefined;
  return (await deps.repo.findUser(value)) ? value : undefined;
}

async function ensureGuest(c: Context, deps: RunsDeps): Promise<string> {
  const existing = await readGuest(c, deps);
  if (existing) {
    await deps.repo.touchUser(existing);
    return existing;
  }
  const id = await deps.repo.createGuest();
  await setSignedCookie(c, GUEST_COOKIE, id, deps.sessionSecret, {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.secureCookies,
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE,
  });
  return id;
}

export function runsRoutes(deps: RunsDeps) {
  return new Hono()
    .post("/", async (c) => {
      const body = CreateRunRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!body.success) {
        return c.json({ error: "invalid_prompt" } satisfies ApiError, 400);
      }
      const prompt = body.data.prompt;

      if ((await deps.repo.todaysCostMicros()) >= deps.dailyBudgetMicros) {
        return c.json({ error: "budget_exceeded" } satisfies ApiError, 503);
      }

      const userId = await ensureGuest(c, deps);
      const run = await deps.repo.createRun({
        userId,
        prompt,
        length: GUEST_LENGTH,
        model: deps.model,
      });
      if (!run.created) {
        return c.json(
          {
            error: "run_in_progress",
            runId: run.runId,
            playlistId: run.playlistId,
          } satisfies ApiError,
          409,
        );
      }

      // Fire and forget: the client polls GET /api/runs/:id.
      void deps.executor.start({
        runId: run.runId,
        userId,
        prompt,
        length: GUEST_LENGTH,
      });
      return c.json(
        { runId: run.runId, playlistId: run.playlistId } satisfies CreateRunResponse,
        202,
      );
    })
    .get("/:id", async (c) => {
      const id = c.req.param("id");
      const guest = await readGuest(c, deps);
      if (guest) await deps.repo.touchUser(guest);
      const run = UUID.test(id) ? await deps.repo.getRun(id) : undefined;
      if (!run) return c.json({ error: "not_found" } satisfies ApiError, 404);
      return c.json(run satisfies RunResponse, 200);
    });
}
```

The budget check runs before `ensureGuest`, so a request rejected for budget writes no user row. This is a deliberate reorder of the spec's list; ledger it as a ruling.

In `apps/api/src/app.ts`:
- add `import { type RunsDeps, runsRoutes } from "./runs/routes";`
- change `AppDeps` to add `runs: RunsDeps;`
- change the signature to `createApp({ db, webDir, runs }: AppDeps)`
- chain the route onto the existing `api` builder, right after the `.get("/health", …)` call: `.route("/runs", runsRoutes(runs))`

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/api exec biome check --write . && pnpm --filter @tunelynk/api test && pnpm --filter @tunelynk/api test:integration && pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api lint`
Expected: unit tests (existing + env + executor) PASS. Integration tests PASS: 1 health, 11 repo, and 14 routes (10 tests plus 4 rows for the 400 case). Typecheck and lint clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): add POST/GET /api/runs with signed guest cookie and budget cap"
```

---

### Task 7: Production wiring, boot recovery, end-to-end check

**Files:**
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `loadEnv` (Task 3); `createRunRepo` (Task 4); `createRunExecutor` (Task 5); `createApp` (Task 6); `createAppleCatalog` (`@tunelynk/connectors`); `createLlmProvider`, `generate` (`@tunelynk/engine`).
- Produces: a running API where `POST /api/runs` generates real playlists, and stale runs are failed at boot.

- [ ] **Step 1: Wire the real dependencies**

In `apps/api/src/index.ts`, replace everything from `const env = loadEnv();` through `const app = createApp({ db, webDir });` with:
```ts
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
```

Add the imports at the top:
```ts
import { createAppleCatalog } from "@tunelynk/connectors";
import { createLlmProvider, generate } from "@tunelynk/engine";
import { createRunExecutor } from "./runs/executor";
import { createRunRepo } from "./runs/repo";
```

- [ ] **Step 2: Typecheck, lint, full suite**

Run: `pnpm --filter @tunelynk/api exec biome check --write . && pnpm --filter @tunelynk/api typecheck && pnpm --filter @tunelynk/api lint && pnpm check`
Expected: all turbo tasks succeed.

- [ ] **Step 3: Build and run the bundle end to end (calls Apple and the LLM; about $0.005)**

This needs, in the root `.env`: `SESSION_SECRET` (32+ chars), `COOKIE_SECURE=false`, `LLM_PROVIDER` and `LLM_MODEL_GUEST` for a provider with credit (currently `anthropic` / `claude-haiku-4-5`), and the matching key. If any are missing, stop and ask the user to add them; do not write secrets yourself.

Run:
```bash
pnpm build
node --env-file=.env apps/api/dist/migrate.js
PORT=3999 node --env-file=.env apps/api/dist/index.js &
sleep 2
curl -s -c /tmp/tl.jar -X POST localhost:3999/api/runs -H 'content-type: application/json' -d '{"prompt":"upbeat 90s road trip"}'
```
Expected: `{"runId":"…","playlistId":"…"}`. This proves the bundled engine resolves `@anthropic-ai/sdk` and `openai` from `apps/api`.

Then poll: `curl -s -b /tmp/tl.jar localhost:3999/api/runs/<runId>`, repeating until `status` is `draft` (or `failed`).
Expected: `draft` with 20 tracks within about 30 s; `stage` moves `llm` → `matching` along the way. A second POST while the first is running returns `409`. Stop the server afterwards (`kill %1`).

If the provider has no credit, record it in the ledger as an environment blocker and continue.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): wire Apple catalog, LLM engine, and boot recovery"
```
