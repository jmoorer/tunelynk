# Tunelynk Product Flow Map — Design

**Date:** 2026-09-30
**Status:** Draft (pending review)

## Goal

Map Tunelynk's product flow, core features, shared domain model, and architecture seams, then decompose the work into sub-projects. Each sub-project later gets its own spec → plan → build cycle. This document fixes the decisions that cut across sub-projects; it details only what the v1 sub-projects need.

### Brief

Tunelynk v1 is AI playlist generation. A user (or guest) describes a playlist ("upbeat 90s road trip"). An LLM, informed by the user's taste profile when available, proposes tracks. The tracks are resolved against the **Apple Music catalog**, which is canonical. The playlist lives in Tunelynk, where it can be previewed (30-second clips, or full playback for Apple Music subscribers) and exported to Apple Music or Spotify. Playlists can be one-off or recurring (refreshed on a schedule), and later triggered by events. Transfer (Spotify ↔ Apple Music) comes after and reuses the matcher and connector layer.

Audience: portfolio project first, public later. The app must be demo-able by anyone, including visitors who are not signed in.

### Success criteria (v1)

- A guest can enter a prompt and get a playable preview of real tracks within about a minute.
- A signed-in user can keep a generated playlist and export it to Apple Music, or copy it into Spotify.
- A recurring playlist refreshes on its schedule with no user action and does not repeat recent tracks.

## Decisions

| Area | Choice | Reason |
|------|--------|--------|
| First pillar | Generate, then Transfer | Shortest path to a demo-able loop; Transfer reuses the matcher and connectors |
| Background generation | Recurring (scheduled) first, then triggered; async one-off comes along with the job pipeline | One engine, three triggers: now, on a schedule, on an event |
| Canonical catalog | **Apple Music catalog** (developer token) | No user cap, ISRCs, 30s previews, no user auth needed. Spotify dev mode is capped at 5 users and has lost ISRCs (see Platform constraints) |
| Generation inputs | Prompt + taste profile; optional seeds later | Taste makes recurring playlists personal and avoids repeats |
| Generation engine | Hybrid: LLM proposes tracks, the catalog verifies them, backfill fills gaps | LLM-quality vibe matching plus a guaranteed full playlist of real tracks |
| Playlist home | **Hosted in Tunelynk**; export is optional | Apple's web API is add-only, so recurring replace must happen in Tunelynk |
| Recurring update mode | Replace (default) or rolling, applied to the hosted playlist; applied in place on Spotify-full exports | Matches Discover Weekly habits; rolling is a cheap variant |
| Apple export | New library playlist snapshot per export | API cannot remove tracks or delete playlists |
| Spotify export | Paste-links for everyone (client credentials); full OAuth for ≤5 allowlisted users | Dev-mode cap; paste-links has zero quota risk |
| Sign-in | Email magic link + Sign in with Apple; guests as anonymous users | Login identity is separate from music connections |
| One-off flow | Preview → Keep → optional Export | First playlist earns trust; nothing lands in a library unseen |
| Previews | Apple catalog `previews[0].url`; MusicKit JS full playback for subscribers | Spotify removed `preview_url` for new apps |
| Model choice | No user-facing picker; `LlmProvider` interface with models configured per tier (`guest`, `user`, `scheduled`) | Predictable cost and tuneable quality; each run records `llm_model` for comparison |
| Job queue | pg-boss (Postgres-backed) | No Redis; single instance on Dokploy |
| Abuse controls | Minimal in v1 (see Deferred) | Portfolio scale; revisit before public launch |

## Platform constraints (verified 2026-09-30)

**Spotify, Development Mode:**
- 5 allowlisted users per app. The app owner must have Premium.
- Extended quota requires a registered business with ≥250k MAU.
- Feb 2026 removals: `external_ids` (no ISRC), `GET /artists/{id}/top-tracks`, `GET /browse/new-releases`, batch `GET /tracks`, `POST /users/{id}/playlists`. Search `limit` max is 10.
- `/playlists/{id}/tracks` was renamed to `/playlists/{id}/items`.
- Refresh tokens expire 6 months after consent, and refreshing does not reset the clock.
- Quota is pooled per developer account across up to 25 client IDs. **Do not** use multiple client IDs to multiply the user cap; that circumvents a restriction and risks the account.
- Recommendations, Related Artists, and Audio Features are unavailable to new apps.

**Apple Music:**
- The developer token (ES256 JWT from the MusicKit key) allows catalog access with no user auth.
- Catalog songs support `filter[isrc]` with up to 25 values per call, and include preview URLs.
- The Music User Token (MusicKit JS) lasts about 6 months with no refresh.
- The web API can create library playlists and add tracks, but **cannot remove tracks or delete playlists**. Native MusicKit (Swift) can edit playlists the app created.
- Users need an Apple Music subscription for library writes and full playback.

Sources: [Spotify Feb 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [Spotify Jul 2026 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates), [Spotify extended access criteria](https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access), [Apple forums: removing library playlist tracks](https://developer.apple.com/forums/thread/707759).

## Sub-projects

v1 = sub-projects 1–7.

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| 1 | **Engine on Apple catalog + guest** | Apple developer-token catalog connector (search, ISRC lookup, previews, artist top songs), `LlmProvider`, matcher, backfill; `POST /api/runs` executed in-process with polling; preview with ▶ clips; anonymous guest users; `llm_usage` + daily budget cap | — |
| 2 | **Accounts** | Magic link + Sign in with Apple, sessions, guest claim on sign-in | 1 |
| 3 | **Apple Music connector** | MusicKit JS authorize, export snapshot to library, taste from heavy rotation / recently played | 2 |
| 4 | **Spotify connectors** | Paste-links export (client credentials, everyone); full OAuth for allowlisted users: export (replace/rolling) + taste. Spike first | 2 |
| 5 | **Last.fm taste** | Username → top artists/tracks snapshot | 2 |
| 6 | **Jobs + async runs** | pg-boss replaces in-process execution; async "generating…" UI; cleanup jobs | 1 |
| 7 | **Recurring** | Schedules, no-repeat history, run history, auto-export, pause rules, MusicKit JS full-playback player | 3, 6 |
| 8 | Triggered | New releases from seed/taste artists (Apple catalog) → rolling append | 7 |
| 9 | Seeds | Artist/playlist seeds as generation inputs | 1 |
| 10 | Transfer | Playlist copy between connections using the matcher; unmatched-track review | 3, 4 |
| — | Abuse hardening | See Deferred | 1, 2 |

### Spikes (before the sub-project that needs them)

- **Before 4:** Spotify dev-mode playlist creation. Which endpoint replaced `POST /users/{id}/playlists`, and do add/replace items work under the 5-user cap?
- **Before 7:** MusicKit JS full playback on web; actual Music User Token lifetime and expiry behavior.
- **Before 1:** Apple catalog rate limits under ~50 searches per run.

## Screens

| Route | Screen | Contents |
|---|---|---|
| `/` (signed out) | Landing | Pitch, pre-generated example playlists (free to open), prompt box (guest generate), sign in |
| `/` (signed in) | Dashboard | Playlist cards: name, prompt, kind, status (`draft` / `active` / `paused` from the playlist, overlaid with `generating` / `failed` from its latest run), last run, next run. Reconnect banners. **New playlist**. |
| `/new` | Create | Prompt (≤280 chars), length (20/30/50), discovery slider (hidden without taste), taste source, schedule (one-off / daily / weekly + time), update mode (if recurring), auto-export targets (if recurring) |
| `/playlists/:id` | Detail | Live tracklist with player, **Regenerate now**, Export (Apple / Spotify / Copy links), edit prompt/schedule, pause/resume, run history, delete |
| `/playlists/:id/runs/:runId` | Run view | Stage progress (taste → AI → matching), then preview: tracks with ▶, remove track (optional backfill), unmatched candidates, **Keep** |
| `/settings` | Settings | Login methods, connections (Apple Music, Spotify, Last.fm) with status and reconnect, delete account |

## User flows

1. **Guest generate.** Landing prompt → run view with progress → preview with clips → Keep is replaced by **Sign in to keep**, plus **Copy links** / **Open in Spotify**. Signing in claims the guest's drafts.
2. **Sign in.** Magic link or Sign in with Apple. First login creates a `user` and an `auth_identity`. Music services are connected separately in Settings or from an Export prompt.
3. **One-off generate (signed in).** `/new` → run → preview → remove/regenerate → **Keep** (run becomes `published`, playlist becomes `active`) → optional Export.
4. **Create recurring.** Same form with a schedule. The first run executes immediately and auto-publishes. Auto-export targets are pushed on each run.
5. **Scheduled refresh (no user present).** `schedule-tick` enqueues the due playlist → engine runs with the no-repeat list (last 4 published runs) → run is published → auto-exports: Apple = new snapshot playlist, Spotify-full = replace/rolling in place.
6. **Connection expires or is revoked.** Connection becomes `needs_reauth` → dependent schedules and auto-exports pause → dashboard banner → reconnecting resumes them.
7. **Export.** Apple: create a library playlist with the tracks (snapshot). Spotify-full: resolve via search (cached in `track_links`), then create/replace. Copy links: resolve via client-credentials search and return `open.spotify.com/track/...` links for pasting into a Spotify desktop playlist. Unmatched tracks are listed.
8. **Delete playlist.** Soft-delete in Tunelynk. Exported playlists are left untouched: Apple can't delete them via API, and for Spotify the user is told to remove it in Spotify.

Notifications are in-app only in v1 (card status and badges). Email comes later.

## Architecture

### Module layout

```
packages/connectors   interfaces + adapters: apple/, spotify/, lastfm/
packages/engine       generation pipeline; pure, takes dependencies, no HTTP/DB
packages/db           Drizzle schema + migrations (replaces placeholder app_meta)
packages/shared       zod API contracts (replaces placeholder Track/Playlist)
apps/api              routes, auth, persistence, job worker (same process for now)
apps/web              pages, player (MusicKit JS + <audio> clips)
```

### Connector interfaces (split by role, not by provider)

```ts
interface CatalogSource {            // Apple only (canonical)
  search(query: string): Promise<CatalogTrack[]>;
  lookupByIsrc(isrcs: string[]): Promise<CatalogTrack[]>;
  artistTopSongs(artistId: string): Promise<CatalogTrack[]>;
}

interface TasteSource {              // Apple history | Spotify (allowlisted) | Last.fm
  snapshot(connection: Connection): Promise<TasteProfile>; // { artists[], tracks[] }, normalized
}

interface ExportTarget {             // Apple library | Spotify full | Spotify paste-links
  capabilities: { create: boolean; append: boolean; replace: boolean; remove: boolean };
  resolve(tracks: CatalogTrack[]): Promise<ResolvedTrack[]>; // Apple: direct; Spotify: search + verify, cached
  write(args: { connection?: Connection; playlistRef?: string; tracks: ResolvedTrack[];
                mode: "snapshot" | "replace" | "rolling" }): Promise<ExportResult>;
}

interface LlmProvider {
  generateCandidates(input: { prompt: string; taste?: TasteProfile; exclude: TrackKey[];
                              count: number }): Promise<{ name: string; plan: Plan; candidates: Candidate[] }>;
}
```

`capabilities` drives the options the UI offers and what the scheduler does (Apple: snapshot only; Spotify-full: replace/rolling). Code never branches on the provider name.

### Engine pipeline

`generate(input, deps, onStage)` is a pure function:

1. **Build prompt:** user prompt wrapped as data, compressed taste (~40 artists + 40 tracks), exclude list, discovery ratio.
2. **LLM:** ask for ≈1.6× the target length. Output is validated with zod. Refusal (not a music request) → error.
3. **Match:** each candidate → Apple `search`, verified by normalized title/artist similarity above a threshold. Live, karaoke, and cover versions are penalized unless requested. Dedupe by ISRC and drop excluded tracks. Concurrency 4.
4. **Backfill:** fill any shortfall from `artistTopSongs` of the plan's artists, then from taste tracks.
5. **Order + tag:** keep the LLM's order and interleave backfill. Tag `llm`/`backfill` and `taste`/`discovery`.
6. **Return** `{ name, tracks[], candidates[] with match status }`. Persistence and export live outside the engine.

### Run execution

API contract from day one: `POST /api/runs` → `{ runId }`, and the client polls `GET /api/runs/:id` for status and stage.

- Sub-project 1: the run executes in-process after the insert (fire and forget).
- Sub-project 6: pg-boss replaces it without changing the contract. Queues: `generate-run`, `export-run`, `schedule-tick` (cron every 5 min; enqueues playlists with `next_run_at <= now`), `cleanup` (drafts expire after 7 days; guests with no activity for 7 days are removed).

### Apple auth

- Developer token: an ES256 JWT signed with the MusicKit key (env: `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`). Cached server-side and re-signed before expiry. Served at `GET /api/apple/token` for MusicKit JS.
- Music User Token: from MusicKit JS `authorize()`, stored encrypted in `connections`.

### Secrets

Connection tokens are encrypted with AES-GCM using `ENCRYPTION_KEY`. LLM, Apple, and Spotify credentials come from env, validated in `apps/api/src/env.ts`.

## Domain model

```
-- Identity
users            id uuid, display_name?, is_guest bool, last_seen_at, created_at
auth_identities  user_id, method ('email'|'apple'), subject      UNIQUE(method, subject)
login_tokens     token_hash, email, expires_at, used_at
sessions         id (httpOnly cookie), user_id, expires_at

-- Music connections (not login)
connections      id, user_id, provider ('apple_music'|'spotify'|'lastfm'),
                 provider_user_id?, external_username?,
                 access_token_enc?, refresh_token_enc?, consented_at, expires_at?,
                 status ('active'|'needs_reauth'|'revoked'), created_at

-- Catalog cache (shared across users)
tracks           id, apple_song_id UNIQUE, isrc?, title, artists text[], album,
                 duration_ms, explicit, artwork_url, preview_url?
track_links      track_id, provider ('spotify'), provider_track_id?, uri?,
                 status ('matched'|'not_found'), confidence, matched_at
taste_snapshots  id, connection_id, captured_at, data jsonb       -- reused if < 24h old

-- Playlists + runs
playlists        id, user_id, name, prompt, length, discovery (0–100),
                 kind ('one_off'|'recurring'|'triggered'), taste_connection_id?,
                 schedule_cron?, timezone?, update_mode ('replace'|'rolling'), rolling_count?,
                 status ('draft'|'active'|'paused'|'deleted'), paused_reason?,
                 current_run_id?, next_run_at?, last_run_at?, created_at
generation_runs  id, playlist_id, trigger ('manual'|'schedule'|'event'),
                 status ('queued'|'running'|'draft'|'published'|'failed'|'expired'),
                 stage ('taste'|'llm'|'matching')?, error?, llm_model,
                 candidates jsonb, started_at, finished_at, expires_at?
run_tracks       run_id, position, track_id, source ('llm'|'backfill'),
                 familiarity ('taste'|'discovery'), removed bool

-- Exports
playlist_exports id, playlist_id, connection_id, target ('apple_music'|'spotify'),
                 mode ('snapshot'|'replace'|'rolling'), auto bool, rolling_count?,
                 provider_playlist_id?
exports          id, run_id, playlist_export_id, status, provider_playlist_id?,
                 unmatched_count, error?, created_at

-- Cost
llm_usage        id, user_id?, model, input_tokens, output_tokens, cost_micros,
                 kind ('guest'|'user'|'scheduled'), created_at
```

Rules:
- The live tracklist of a playlist is `run_tracks` of `current_run_id`. With `update_mode = 'rolling'`, a new run keeps the newest `length - rolling_count` tracks of the current list and adds `rolling_count` fresh ones.
- No-repeat list = tracks from the playlist's last 4 `published` runs.
- One-off draft: playlist `draft` + run `draft` → **Keep** → run `published`, playlist `active`.
- Paste-links export is computed on request and stores no rows.
- Apple exports are always `snapshot`; `capabilities` enforces it.
- Recurring decay: auto-pause after 4 consecutive runs with no visit (`users.last_seen_at`).
- Budget cap (sub-project 1): the sum of today's `cost_micros` is checked against `LLM_DAILY_BUDGET_USD` before a run is created.

## Error handling

| Failure | Behavior |
|---|---|
| LLM timeout (60s) or invalid schema | 1 retry (schema error → retry with a repair message), then run `failed` |
| LLM refusal | Run `failed` with reason; counts toward usage |
| Budget exceeded | Rejected before the run is created, with a clear error |
| Low match rate | Publish if matched + backfill ≥ 50% of target length; otherwise `failed` ("couldn't find enough tracks"). Unmatched candidates are shown either way. |
| Apple catalog 429/5xx | Exponential backoff, 3 tries per call. Expired developer token → re-sign. |
| Taste fetch fails | Continue without taste; the run is flagged "generated without your listening history" |
| Apple user token 401/403; Spotify refresh failure or 6-month expiry | Connection → `needs_reauth`; dependent schedules and auto-exports pause; banner |
| Spotify 429 `QUOTA_EXCEEDED` | Export `failed` with the reason, retried later; not reauth |
| Partial Spotify export | Misses are skipped, `unmatched_count` and the list are recorded, and the export succeeds |
| Restart mid-run (in-process era) | On boot, `running` runs older than 5 min → `failed` |
| Scheduled run fails 3× in a row | Playlist → `paused` with `paused_reason` |
| No preview URL | No ▶ on that row |

## Testing

- **Engine:** unit tests with fake `CatalogSource` and `LlmProvider`: thresholds, dedupe, exclude, backfill, ordering, refusal, the 50% rule.
- **Matcher:** table-driven fixtures for title variants ("Remastered 2011", "feat.", live, karaoke, cover, multiple artists).
- **Connectors:** contract tests per interface against recorded HTTP responses (msw). Live smoke tests are opt-in via env keys and excluded from CI.
- **API:** Postgres integration tests following `app.integration.test.ts`: run lifecycle, auth and guest claim, budget cap.
- **Web:** Vitest + Testing Library for run-view states, preview remove/keep, and player fallback.
- **LLM quality eval:** a script, not CI. 20 fixed prompts → match rate, duplicate rate, refusal accuracy per model. Re-run on any prompt or model change.
- TDD within each sub-project.

## Deferred

- **Abuse hardening** (before public launch): Turnstile on guest generate and signup; per-IP token bucket (`rate_limits` table); quotas (guest 3/day, user 15/day, 3 recurring per user, daily as the most frequent cadence); tiered circuit breaker on the daily budget (guests off at 70%, manual generation off at 100%, scheduled runs keep priority); prompt ≤280 chars and `max_tokens` cap (both v1); 24h cache of normalized guest prompts; disposable-email blocklist; playlist-name profanity filter.
- **Model choice:** a "Quick / Deep" toggle; bring-your-own API key with a model picker, exempt from quotas.
- **Native iOS app:** MusicKit Swift can edit app-created playlists, which would enable true replace/rolling on Apple.
- **Spotify "house account"** (public playlists that users follow): rejected for now. Everything becomes public, names need moderation, and Spotify may treat it as spam.
- Email notifications, collaborative playlists, in-app embeds for Spotify playback.

## Out of scope for this spec

Implementation detail for each sub-project: exact prompts, similarity thresholds, API route shapes beyond `/api/runs`, UI visual design, and model/pricing choices. Each belongs in its sub-project's spec.
