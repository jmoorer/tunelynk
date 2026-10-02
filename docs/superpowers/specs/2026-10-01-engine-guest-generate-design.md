# Engine on Apple Catalog + Guest Generate — Design

**Date:** 2026-10-01
**Status:** Draft (pending review)
**Issue:** #10 (sub-project 1 of the [product flow map](2026-09-30-product-flow-map-design.md))
**Inputs:** [Apple catalog rate-limit spike](../spikes/2026-09-30-apple-catalog-rate-limits.md)

## Goal

A guest enters a prompt and gets a playable preview of real Apple Music tracks within about a minute.

### Brief

The flow map fixes the shape: the LLM proposes tracks, the Apple catalog verifies them, backfill fills gaps. `POST /api/runs` runs in-process and the client polls `GET /api/runs/:id`. Guests are anonymous users. Cost is bounded by `llm_usage`, `LLM_DAILY_BUDGET_USD`, a 280-character prompt, and a `max_tokens` cap. The spike fixes the catalog limiter: 8 req/s, burst 10, 4 in flight, jittered backoff on 429.

### In scope

- Apple developer-token catalog connector: search, ISRC lookup, artist top songs, previews.
- `LlmProvider` with Anthropic and OpenAI adapters, chosen by env.
- Matcher, backfill, and the `generate()` pipeline.
- Minimal `users` table and an anonymous guest cookie.
- `POST /api/runs`, `GET /api/runs/:id`, in-process execution, boot recovery.
- `llm_usage` and the daily budget cap.
- Landing prompt, run view with stage progress, preview list with 30-second clips.

### Out of scope

- Keep, remove track, regenerate (need accounts, #2).
- `sessions` table, magic link, guest claim (#2).
- Export, taste, seeds, pg-boss, recurring.
- Abuse hardening beyond the prompt length, `max_tokens`, budget cap, and one-active-run guard.
- Pre-generated example playlists on the landing page.
- A durable search cache (an in-memory LRU is enough for now).

## Decisions

| Area | Choice | Reason |
|---|---|---|
| Delivery | Four slices, one PR each: A connector, B engine, C runs API, D guest web | Each slice is testable and demo-able on its own |
| LLM provider | `LLM_PROVIDER=anthropic\|openai`; Anthropic first (Haiku 4.5 for `guest`) | Switchable without code changes; Haiku keeps latency and cost low |
| Structured output | Anthropic Messages `output_config.format` (`zodOutputFormat`); OpenAI Responses `text.format` (`zodTextFormat`); both sent with the SDK's `create()`, and one zod schema validates the raw text in a shared core | Same contract regardless of provider. `.parse()` is not used because it throws on a mismatch and drops token usage (verified 2026-10-01) |
| Cost | `pricing.ts` table of per-model token prices; unknown model fails startup | Cost can never be silently untracked |
| Guest identity | `users` row with `is_guest = true`; HMAC-signed httpOnly cookie `tl_guest=<userId>.<sig>` keyed by `SESSION_SECRET` | Stays inside #10; #2 adds `sessions` and converts the guest cookie on claim |
| Guest length | Fixed at 20 tracks (32 candidates) | ~32 searches ≈ 4 s of catalog time; well under a minute with the LLM call |
| Matching | `search("<artist> <title>")` + similarity verification; ISRC lookup not used for matching | LLM-produced ISRCs are unreliable; lookup still exists in the connector |
| Search cache | In-memory LRU in the connector, query → results, 24 h TTL | Cheap repeat savings without a table; the `tracks` table caches final run tracks |
| Storefront | `APPLE_STOREFRONT`, default `us` | |
| Run visibility | `GET /api/runs/:id` readable by anyone with the uuid | Preview links are shareable; no private data exposed |
| Routing (web) | `react-router` v7 | More screens follow in later sub-projects |

## Architecture

### Packages

```
packages/connectors   types.ts     CatalogSource, CatalogTrack
                      apple/devToken.ts  sign ES256 JWT, cache, re-sign at 50 min
                      apple/limiter.ts   token bucket (rps, burst), max in flight, drain on 429
                      apple/client.ts    fetch + retry (jittered backoff 250 ms → 4 s, 4 retries; 401 → re-sign once)
                      apple/catalog.ts   AppleCatalog implements CatalogSource
packages/engine       matcher.ts   normalize, similarity, variant penalty, pickBest
                      llm/types.ts LlmProvider, LlmOutput schema
                      llm/anthropic.ts, llm/openai.ts, llm/prompt.ts, llm/pricing.ts
                      generate.ts  pipeline; deps { catalog, llm }; onStage callback
                      bin/generate.ts  CLI: prompt → printed tracklist
packages/db           schema: users, playlists, generation_runs, run_tracks, tracks, llm_usage
packages/shared       zod: CreateRunRequest, CreateRunResponse, RunResponse, RunTrack, RunStatus, RunStage
apps/api              guest cookie middleware, routes/runs.ts, runExecutor.ts, budget.ts, boot recovery
apps/web              Landing, RunView, TrackRow, useRun, usePreviewPlayer
packages/engine/src/bin/eval.ts   20 fixed prompts → match / duplicate / refusal rates (not CI)
```

- The engine is pure. It receives `{ catalog, llm }` and does no DB or HTTP work itself.
- `generate()` returns `{ name, tracks, candidates, usage }`. The API persists it and writes `llm_usage`.
- I/O lives only in `connectors` and the LLM adapters, both injected.
- The API builds one `AppleCatalog` per process, so every concurrent run shares the limiter (the budget belongs to the token, not the run).

### Interfaces

```ts
interface CatalogTrack {
  appleSongId: string;
  isrc?: string;
  title: string;
  artistName: string;     // attributes.artistName, raw ("Mumford & Sons", "Calvin Harris & Dua Lipa")
  artistIds: string[];    // relationships.artists; empty on search and top-songs results
  album: string;
  durationMs: number;
  explicit: boolean;      // attributes.contentRating === "explicit"
  artworkUrl?: string;    // template resolved to 300x300
  previewUrl?: string;    // attributes.previews[0].url
}

interface CatalogSource {
  search(query: string, opts?: { limit?: number }): Promise<CatalogTrack[]>;
  lookupByIsrc(isrcs: string[]): Promise<CatalogTrack[]>;   // ≤25 per call; chunks above that
  lookupByIds(ids: string[]): Promise<CatalogTrack[]>;      // ≤300 per call; hydrates artistIds
  artistTopSongs(artistId: string): Promise<CatalogTrack[]>;
}

interface LlmProvider {
  readonly model: string;
  generateCandidates(input: {
    prompt: string;
    count: number;
    exclude: TrackKey[];
  }): Promise<{ output: LlmOutput; usage: { model: string; inputTokens: number; outputTokens: number } }>;
}

// LlmOutput (zod)
{ refusal: string | null;            // null when it is a music request (structured outputs need every field)
  name: string;                       // ≤60 chars
  plan: { artists: string[]; vibe: string };   // artists ≤10
  candidates: { title: string; artist: string }[] }
```

`taste` is not part of `generateCandidates` until a taste sub-project needs it.

## Apple connector

- **Developer token:** ES256 JWT (`iss = APPLE_TEAM_ID`, `kid = APPLE_KEY_ID`, 1 h expiry), signed with `node:crypto`. `APPLE_PRIVATE_KEY` accepts base64 of the `.p8` PEM, a bare base64 PKCS#8 body, or raw PEM, the same as the spike. Cached and re-signed after 50 minutes or on a 401.
- **Limiter:** one instance per process. Token bucket at `APPLE_CATALOG_RPS` (8) refill, `APPLE_CATALOG_BURST` (10) capacity, at most `APPLE_CATALOG_CONCURRENCY` (4) requests in flight. A 429 empties the bucket so parallel callers back off together.
- **Retry:** on 429 and 5xx, exponential backoff with full jitter, base 250 ms, cap 4 s, up to 4 retries. On 401, re-sign the token and retry once. Other 4xx responses throw immediately.
- **Search:** `GET /v1/catalog/{sf}/search?types=songs&limit=5&term=…`. Verified 2026-10-01: search results carry no `relationships`, with or without `include=artists` / `relate=artists`, so `artistIds` is empty on search results.
- **Songs by id:** `GET /v1/catalog/{sf}/songs?ids=a,b,…` in chunks of 300. These responses include `relationships.artists` by default, so the engine hydrates artist ids for all matched tracks with one call.
- **ISRC lookup:** `GET /v1/catalog/{sf}/songs?filter[isrc]=a,b,…` in chunks of 25.
- **Top songs:** `GET /v1/catalog/{sf}/artists/{id}/view/top-songs`.
- **Cache:** in-memory LRU (500 entries, 24 h TTL) for search (keyed by limit + normalized query) and top songs (keyed by artist id). Batch lookups are not cached.
- **Artist names stay raw.** `artistName` is not split in the connector because band names contain `&` ("Mumford & Sons"). The matcher splits and compares against both the full name and the parts.

## Engine

### Prompt

- The system prompt tells the model to act as a music curator and return only structured output. The user's text is wrapped in `<request>…</request>` and labelled as data, not instructions.
- It asks for `count = ceil(1.6 × length)` candidates that are mostly findable on Apple Music, at most 3 per artist unless the request asks otherwise, and no live, cover, or karaoke versions unless requested.
- It asks for `refusal` when the request is not a playlist request.
- Each adapter sets a 60 s timeout and `max_tokens = LLM_MAX_TOKENS`. The SDK client (`maxRetries: 1`) retries once on timeout, network error, 429, or 5xx. On a schema validation failure the shared core retries once with a repair message that includes the validation error, and sums usage across both attempts.
- `pricing.ts` converts usage to `costMicros`. If `LLM_MODEL_GUEST` is not in the table, startup fails.

### Matcher

- `normalize`: lowercase; NFKD and strip diacritics; remove `(feat. …)`, `[…]`, `- 2011 Remaster`, `(Remastered …)`, `(Radio Edit)` and similar suffixes; `&` → `and`; drop punctuation; collapse whitespace.
- Title score: Dice coefficient on character bigrams of normalized titles.
- Artist score: best Dice score between the candidate artist and the catalog `artistName`, both as a whole and split on `,`, `&`, `feat.`, `x`, `with`.
- Variant penalty: −0.3 when the catalog title or album contains live, karaoke, cover, tribute, instrumental, "made famous", or "originally performed" and the candidate title does not.
- Accept when title ≥ 0.85 and artist ≥ 0.8 after the penalty. These are starting thresholds, tuned with the fixtures and the eval script. Among accepted results, take the highest combined score.

### Pipeline: `generate(input, deps, onStage)`

1. `onStage("llm")`. Call `llm.generateCandidates`. A set `refusal` throws `RefusalError` (usage is still returned on the error).
2. `onStage("matching")`. Search every candidate in parallel; the connector's limiter throttles. A search that throws marks that candidate `error`, not the run.
3. Dedupe by ISRC (falling back to `appleSongId`), then by normalized (title, primary artist) to catch re-releases. Drop tracks in `exclude`. Keep LLM order and cut to `length`.
4. **Backfill** when short:
   - Pick artists: one `catalog.lookupByIds(matched song ids)` call hydrates `artistIds`. Keep artist ids whose track's `artistName` matches a `plan.artists` entry (matcher artist score ≥ 0.8), ordered by match count.
   - Add `artistTopSongs(id)` round-robin, at most 2 per artist, skipping duplicates and excludes, until the list is full or the pool runs out.
   - Spread backfill tracks evenly through the list. Tag each track `source: "llm" | "backfill"`.
5. **50% rule:** fewer than `ceil(length / 2)` tracks throws `NotEnoughTracksError`.
6. Return `{ name, tracks, candidates: [{ title, artist, status: "matched" | "unmatched" | "duplicate" | "error", appleSongId? }], usage }`.

Errors thrown after the LLM call carry `usage` so the API can still record cost.

## Data model (this issue)

Columns follow the flow map spec. Enums are the full spec enums so later sub-projects do not need migrations just to add values. The placeholder `app_meta` table is dropped.

```
users           id uuid, display_name?, is_guest bool, last_seen_at, created_at
playlists       id, user_id → users, name, prompt, length, discovery (default 50),
                kind ('one_off'|'recurring'|'triggered') = 'one_off',
                status ('draft'|'active'|'paused'|'deleted') = 'draft',
                current_run_id?, created_at
generation_runs id, playlist_id → playlists, trigger ('manual'|'schedule'|'event') = 'manual',
                status ('queued'|'running'|'draft'|'published'|'failed'|'expired'),
                stage ('taste'|'llm'|'matching')?, error?, llm_model,
                candidates jsonb, started_at?, finished_at?, created_at
tracks          id, apple_song_id UNIQUE, isrc?, title, artist_name, album,
                duration_ms, explicit, artwork_url?, preview_url?
run_tracks      run_id → generation_runs, position, track_id → tracks,
                source ('llm'|'backfill'), removed bool = false    PK(run_id, position)
llm_usage       id, user_id? → users, model, input_tokens, output_tokens, cost_micros bigint,
                kind ('guest'|'user'|'scheduled'), created_at
```

The flow map's `artists text[]` on `tracks` becomes `artist_name text` because Apple returns one display string. The spec's `familiarity` column on `run_tracks` waits for taste. `expires_at` on runs waits for the cleanup job (#6).

## API

### Guest middleware (on `/api/runs*`)

- Valid `tl_guest` cookie → load the user, bump `last_seen_at` (at most once per minute).
- Missing or invalid → on `POST` only, insert a guest user and set `tl_guest=<userId>.<hmac>` (httpOnly, SameSite=Lax, Secure in production, 30-day max age). `GET` does not create users.

### `POST /api/runs`

Body `{ prompt }`: trimmed, 1–280 characters (zod). Then:

1. Budget: if today's (UTC) `SUM(llm_usage.cost_micros)` ≥ `LLM_DAILY_BUDGET_USD × 1e6`, return `503 { error: "budget_exceeded" }`.
2. One active run: if the user has a `queued` or `running` run, return `409 { error: "run_in_progress", runId, playlistId }`.
3. Insert the playlist (`name` = prompt truncated to 60 characters, `length` = 20) and the run (`queued`, `llm_model` = configured guest model). Return `202 { runId, playlistId }`.
4. `runExecutor.start(runId)`, fire and forget:
   - Run → `running`, `started_at`; stage updates from `onStage`.
   - Call `generate()`.
   - Success, in one transaction: upsert `tracks` by `apple_song_id`, insert `run_tracks`, run → `draft` with `candidates` and `finished_at`, playlist `name` and `current_run_id` set.
   - Insert `llm_usage` (`kind = 'guest'`) whenever usage exists, on success or failure.
   - Failure: run → `failed` with a user-safe `error`; the full error is logged.

### `GET /api/runs/:id`

Returns `RunResponse`:

```ts
{ id, status, stage, error,
  playlist: { id, name, prompt },
  tracks: [{ position, appleSongId, title, artistName, album, artworkUrl, previewUrl, durationMs, explicit, source }],
  unmatched: [{ title, artist }] }
```

404 for unknown or malformed ids.

### Boot recovery

On startup, `queued` or `running` runs created more than 5 minutes ago → `failed` with "interrupted".

### Env additions (`apps/api/src/env.ts`)

| Var | Default | Notes |
|---|---|---|
| `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | required | |
| `APPLE_STOREFRONT` | `us` | |
| `APPLE_CATALOG_RPS` / `_BURST` / `_CONCURRENCY` | 8 / 10 / 4 | From the spike |
| `SESSION_SECRET` | required | ≥32 characters |
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `openai` |
| `LLM_MODEL_GUEST` | `claude-haiku-4-5` | Must exist in `pricing.ts` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | The one matching `LLM_PROVIDER` is required |
| `LLM_MAX_TOKENS` | 2000 | |
| `LLM_DAILY_BUDGET_USD` | 2 | |

## Web

- `/` **Landing:** short pitch, prompt textarea with a 280-character counter, **Generate**.
  - Success → navigate to the run view.
  - 409 → "You already have a playlist generating" with a link to it.
  - 503 → "Daily generation limit reached, try again tomorrow."
- `/playlists/:playlistId/runs/:runId` **Run view:** `useRun(runId)` polls every 1 s until `draft` or `failed`.
  - `queued` / `llm`: "Asking the AI…". `matching`: "Finding tracks on Apple Music…". An elapsed-seconds counter throughout.
  - `failed`: error message and **Try again** (back to landing with the prompt prefilled).
  - `draft`: playlist name, prompt, track rows (artwork, title, artists, duration, ▶/⏸). No ▶ when `previewUrl` is missing. Collapsible "N suggestions not found on Apple Music". Footer has a disabled **Sign in to keep (coming soon)**.
- **Player:** `usePreviewPlayer()` owns one shared `<audio>`. Only one clip plays at a time; playback stops at the end of the clip.

## Error handling

| Failure | Behavior |
|---|---|
| LLM timeout (60 s) or network error | 1 retry, then run `failed` |
| LLM schema error | 1 retry with a repair message, then run `failed` |
| LLM refusal | Run `failed`: "That doesn't look like a playlist request." Usage recorded |
| Budget exceeded | 503 before any rows are created |
| Run already in progress | 409 with the existing run |
| Fewer than 50% of target tracks | Run `failed`: "Couldn't find enough tracks for that prompt." Unmatched candidates still stored |
| Apple 429 / 5xx | Jittered backoff, 4 retries; shared bucket drained on 429 |
| Apple 401 | Re-sign developer token, retry once |
| Single search fails after retries | That candidate is `error`; the run continues |
| Restart mid-run | Boot recovery marks it `failed` ("interrupted") |
| No preview URL | No ▶ on that row |
| Anything else | Run `failed`: "Something went wrong generating this playlist." Full error logged |

## Testing

TDD within each slice.

- **A (connector):** limiter with fake timers (burst, refill, max in flight, drain on 429); retry/backoff and 401 re-sign; `devToken` signs and verifies with a generated P-256 key; contract tests against recorded Apple JSON fixtures (search, songs by id, top songs) through an injected `fetch`, not msw; live smoke behind `APPLE_LIVE=1`, excluded from CI.
- **B (engine):** matcher table fixtures (remaster, feat., live, karaoke, cover, multi-artist, diacritics); `generate()` with fake catalog and LLM (dedupe, exclude, cut, backfill and interleave, 50% rule, refusal, per-candidate search error, usage on error); adapter tests with an injected `fetch` (request shape, structured-output parsing, retry); CLI and the eval script (`pnpm --filter @tunelynk/engine eval`) run by hand.
- **C (API):** unit tests for env parsing, cookie sign/verify, budget math. Postgres integration tests with a fake engine: create → poll → draft, failure path, 409, budget 503, cookie reuse, `GET` does not create users, boot recovery.
- **D (web):** Vitest + Testing Library for landing submit and error states, run view per status with mocked fetch, single-player behavior.
- **Done when:** a local run with real Apple and LLM keys produces a playable preview in under a minute; then the same on Dokploy after its env vars are added (`docs/deploy.md` updated).

## Slices

| Slice | PR delivers | Checkpoint |
|---|---|---|
| A | `packages/connectors` (Apple) | Live smoke returns real songs and artist ids via `lookupByIds` |
| B | `packages/engine` + CLI + eval script | `pnpm --filter @tunelynk/engine generate "90s road trip"` prints 20 real tracks |
| C | DB schema, env, guest cookie, runs API, executor, budget, boot recovery | `curl` create → poll → tracks |
| D | Landing, run view, preview player, deploy env docs | Issue #10 done-when, locally and on Dokploy |
