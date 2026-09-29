# Tunelynk Monorepo Scaffold — Design

**Date:** 2026-09-29
**Status:** Draft, pending review

## Goal

Stand up an empty-but-runnable TypeScript monorepo for Tunelynk (playlist create / generate / cross-platform transfer) that proves the full wiring end to end: web → API → Postgres, with shared types, local tooling, and tests. No product features.

### Success criteria

- `pnpm install && pnpm db:up && pnpm db:migrate && pnpm dev` starts API and web; the web page shows API and DB status from `/health`.
- `pnpm check` passes: typecheck, Biome lint/format, Vitest across all packages.
- Types flow from API to web through `hono/client` with no codegen.

## Decisions

| Area | Choice | Reason |
|------|--------|--------|
| Apps in v1 | API + web (no mobile yet) | User choice; mobile added later |
| Language | TypeScript everywhere | Shared types API↔web; MusicKit JS and Spotify/LLM SDKs are JS-first; YouTube Music reachable via youtubei.js or thin InnerTube port. Python worker possible later if YouTube spike requires it |
| Monorepo | pnpm workspaces + Turborepo | Standard, cached task pipeline |
| Runtime | Node 22 LTS | Widest hosting support |
| API | Hono on `@hono/node-server` | Light, TS-first, typed RPC client |
| Web | Vite + React SPA + Tailwind v4 | Clean API boundary, simple dev |
| Database | Postgres 17 | Relational data (users, playlists, ordered items, cross-platform track mappings); `pg_trgm` for fuzzy matching; `jsonb` for raw payloads. MongoDB considered and rejected |
| DB access | Drizzle ORM + drizzle-kit | Schema as TS code, easy raw SQL |
| Validation | zod | Shared schemas, env validation |
| Lint/format | Biome | One tool, minimal config |
| Tests | Vitest (+ Testing Library in web) | Fast, TS-native |
| Package scope | `@tunelynk/*` | Internal packages consumed as TS source, no lib build step |

## Out of scope

- CI (GitHub Actions) — add later
- App user authentication
- Streaming-platform integrations (Spotify, Apple Music, YouTube Music OAuth/clients)
- AI playlist generation
- Real domain schema (only a placeholder table)
- Mobile app
- Deployment config

## Repo layout

```
tunelynk/
├── apps/
│   ├── api/                 Hono API, port 3000
│   └── web/                 Vite + React SPA, port 5173
├── packages/
│   ├── shared/              zod schemas + inferred types
│   ├── db/                  Drizzle schema, client factory, migrations
│   └── config/              shared tsconfig bases (base, node, react)
├── docker/
│   └── postgres/init.sql    CREATE EXTENSION IF NOT EXISTS pg_trgm;
├── docker-compose.yml       Postgres 17, port 5432, named volume
├── turbo.json
├── pnpm-workspace.yaml
├── package.json             root scripts
├── biome.json
├── .env.example             DATABASE_URL, PORT
├── .gitignore
├── .nvmrc                   22
└── README.md                existing; add "Getting started" section
```

## Components

### `packages/config`
tsconfig bases only: `tsconfig.base.json` (strict, ES2022, `moduleResolution: bundler`), `tsconfig.node.json`, `tsconfig.react.json`. Every other package extends one of these.

### `packages/shared`
- `HealthResponse` zod schema: `{ ok: boolean, db: "up" | "down" }` and its inferred type.
- Placeholder `Track` and `Playlist` schemas (minimal fields: id, title / name) to establish the pattern.
- Depends on: zod.

### `packages/db`
- `createDb(url: string)` returns a Drizzle client (driver: `postgres` / postgres.js).
- `schema.ts` with one placeholder table `app_meta (key text primary key, value text not null)`, so the first migration is real.
- `drizzle.config.ts` pointing at `schema.ts`, output `packages/db/migrations`.
- `ping(db)` helper running `select 1`, used by `/health`.
- Depends on: drizzle-orm, postgres.

### `apps/api`
- `src/env.ts`: zod-validated env (`DATABASE_URL` required, `PORT` default 3000). On failure, log which variable is invalid and exit 1.
- `src/app.ts`: builds the Hono app with injected dependencies (`{ db }`) so tests can pass a fake. Routes mounted under `/api`. Exports `type AppType`.
- `GET /api/health`: calls `ping(db)`; returns `HealthResponse` — `{ ok: true, db: "up" }` or `{ ok: true, db: "down" }` when the ping throws. Always HTTP 200 while the API process is alive.
- Global `onError`: logs the error, returns `500 { error: "Internal Server Error" }`.
- `src/index.ts`: reads env, creates db, serves via `@hono/node-server`.
- Dev: `tsx watch --env-file=../../.env src/index.ts`.
- Build: `tsup` bundles `src/index.ts` plus workspace packages (`@tunelynk/*` inlined) into `dist/`.
- Depends on: hono, @hono/node-server, @tunelynk/db, @tunelynk/shared, zod.

### `apps/web`
- Vite + React + TS, Tailwind v4 via `@tailwindcss/vite`.
- Vite dev server proxies `/api` → `http://localhost:3000`.
- `src/api.ts`: `hc<AppType>("/")` typed client (type-only import from `@tunelynk/api`).
- `HealthStatus` component: fetches `/api/health` on mount; renders loading, "API: up / DB: up|down", or "API unreachable" on fetch failure or non-OK response.
- Depends on: react, react-dom, hono (client), @tunelynk/shared; dev: @tunelynk/api (types only).

## Root scripts

| Script | Action |
|--------|--------|
| `pnpm dev` | `turbo dev` — api + web in parallel, watch mode |
| `pnpm build` | `turbo build` |
| `pnpm check` | `turbo typecheck lint test` |
| `pnpm format` | `biome format --write .` |
| `pnpm db:up` / `db:down` | `docker compose up -d` / `docker compose down` |
| `pnpm db:generate` / `db:migrate` | drizzle-kit generate / migrate in `packages/db` |

Turbo tasks: `dev` (persistent, no cache), `build` (depends on `^build`), `typecheck`, `lint`, `test`.

## Data flow

1. Web loads, `HealthStatus` calls `client.api.health.$get()`.
2. Vite proxies `/api/*` to the API on `:3000`.
3. API runs `ping(db)` via `@tunelynk/db`.
4. API returns `HealthResponse`; web renders status.

## Configuration

Root `.env` (gitignored), copied from `.env.example`:

```
DATABASE_URL=postgres://tunelynk:tunelynk@localhost:5432/tunelynk
PORT=3000
```

docker-compose uses matching credentials. drizzle-kit and the API both read `DATABASE_URL`: the API via `--env-file`, `drizzle.config.ts` via `dotenv` loading the root `.env`.

## Testing

- **shared:** `HealthResponse` accepts valid and rejects invalid payloads.
- **api (unit):** `app.request("/api/health")` with fake db — ping resolves → `db: "up"`; ping rejects → `db: "down"`, still 200. Unknown error in a route → 500 JSON via `onError`.
- **api (integration):** `/api/health` against real Postgres returns `db: "up"`. Skipped when `DATABASE_URL` is unset.
- **web:** `HealthStatus` renders up/down/unreachable states with `fetch` mocked (Vitest + jsdom + Testing Library).
- **env:** missing `DATABASE_URL` fails validation.

## Future hooks (not built now)

- `apps/mobile` (Expo) slots into `apps/`.
- `packages/providers` for Spotify / Apple Music / YouTube Music clients.
- `packages/matching` for ISRC + `pg_trgm` fuzzy track matching.
- Optional Python worker under `services/` if the YouTube Music spike requires ytmusicapi.
- CI workflow running `pnpm check`.
