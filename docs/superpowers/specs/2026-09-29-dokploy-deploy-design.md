# Tunelynk Dokploy Deployment — Design

**Date:** 2026-09-29
**Status:** Implemented (PR #5)

> **As built:** the build uses the Dockerfile, not Nixpacks. Nixpacks 1.41 pins Node 22.19 / 24.10 from a stale Nix snapshot, below `jsdom@30`'s engine range (`^22.22.2 || ^24.15.0`), and `engineStrict` makes `pnpm install` fail. `NODE_ENV` is not set in Dokploy (the app does not read it). Migrations run as a separate `migrate.js` entry in the start command rather than inside `index.ts`, so `pnpm dev` still boots with the DB down. Current setup: `docs/deploy.md`.

## Goal

Deploy Tunelynk to the user's existing Dokploy instance so that every push to `main` builds and runs the app from the GitHub repo, backed by a Dokploy-managed Postgres, at `https://tunelynk.bytmoor.com`.

### Success criteria

- A push to `main` triggers a Dokploy deploy with no manual steps.
- `https://tunelynk.bytmoor.com` serves the web app, and the health page shows API `ok` and DB `up`.
- Pending Drizzle migrations are applied automatically before the new API starts serving; a failed migration fails the deploy and leaves the previous container running.
- Local dev (`pnpm dev`, Vite proxy) and `pnpm check` behave exactly as before.

## Decisions

| Area | Choice | Reason |
|------|--------|--------|
| Topology | One Dokploy application: the API serves `/api/*` and the built web SPA | Single domain, no CORS, relative `/api` calls work unchanged; web is static so no FE runtime needed. Two-app split (API + static site) rejected as premature |
| Build | Dockerfile (`node:22-slim`, non-root, cached `pnpm fetch` layer) | Nixpacks was preferred but its Node is too old for the lockfile's engine ranges (see *As built*) |
| Database | Dokploy-managed Postgres 17 service, same project, internal network | User choice; Dokploy handles credentials and backups |
| Migrations | Run at API startup via drizzle-orm's `migrate()` | No drizzle-kit in prod; failure blocks the deploy. Safe with a single instance |
| Domain | `tunelynk.bytmoor.com`, HTTPS via Let's Encrypt | User choice; `tunelynk.com` not registered yet |

## Code changes

### 1. `packages/db`: `migrateDb`

Add and export:

```ts
export async function migrateDb(url: string, migrationsFolder: string): Promise<void>
```

- Opens its own `postgres(url, { max: 1 })` client, runs `migrate(drizzle(client), { migrationsFolder })` from `drizzle-orm/postgres-js/migrator`, and always closes the client in `finally`.
- Separate from `createDb` so the migration connection never lingers in the app pool.

### 2. `apps/api/src/app.ts`: optional static web serving

`createApp({ db, webDir? })`:

- When `webDir` is unset (tests, dev), behaviour is unchanged.
- When set, after the `/api` route:
  - Unmatched `/api/*` requests return a JSON 404, not the SPA page.
  - `serveStatic({ root: webDir })` from `@hono/node-server/serve-static` serves built assets.
  - Any other GET falls back to `webDir/index.html` (SPA routing).
- `AppType` stays the typed `/api` routes only, so the web's `hono/client` types are unaffected.

### 3. `apps/api/src/index.ts`: startup sequence

1. `loadEnv()` (unchanged).
2. Resolve paths relative to the bundle (`import.meta.url` → `apps/api/dist/index.js`):
   - migrations: `../../../packages/db/migrations`
   - web: `../../web/dist`
3. `await migrateDb(env.DATABASE_URL, migrationsDir)`; on error log and `process.exit(1)`.
4. `webDir` is passed to `createApp` only if `apps/web/dist/index.html` exists, so a local `pnpm build && pnpm start` serves the full app too.
5. `serve(...)` as today.
6. On `SIGTERM`/`SIGINT`: close the HTTP server, end the DB client, exit 0. (Requires `createDb` to expose the underlying client or a `close` function.)

Path resolution relies on the repo layout being preserved at runtime. It is, because the Dockerfile copies the whole repo to `/app` and the start command runs the bundle in place.

### 4. Tests

- `packages/db`: integration test that `migrateDb` against the local DB succeeds and is idempotent (second run is a no-op). Runs under the existing uncached `test:integration` task.
- `apps/api`: unit tests with a temp `webDir` containing `index.html` and one asset:
  - `GET /` and `GET /some/client/route` → `index.html`.
  - `GET /assets/x.js` → the asset.
  - `GET /api/health` → JSON (unchanged).
  - `GET /api/nope` → 404 JSON, not HTML.
  - Without `webDir`, `GET /` → 404 (current behaviour preserved).

## Build config

> **Superseded:** kept as the original design record. The shipped build is the `Dockerfile` (see *As built* at the top).

`nixpacks.toml` at repo root:

```toml
[variables]
NIXPACKS_NODE_VERSION = "22"

[phases.install]
cmds = ["corepack enable", "pnpm install --frozen-lockfile"]

[phases.build]
cmds = ["pnpm build"]

[start]
cmd = "node apps/api/dist/index.js"
```

- Dev dependencies stay installed (the build needs them); image slimming is deferred.
- `pnpm build` runs turbo, which builds `@tunelynk/api` (tsup bundle) and `@tunelynk/web` (Vite) in dependency order.

### Build verification (first implementation step)

Confirm Nixpacks + corepack installs `pnpm@11.5.1` and `pnpm build` succeeds: run `nixpacks build .` locally if available, otherwise the first Dokploy deploy is the test. On failure, replace `nixpacks.toml` with a multi-stage Dockerfile (`node:22`, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm build`, same start command, same repo layout) and switch the Dokploy build type to Dockerfile. Nothing else in this design changes.

## Dokploy setup (manual)

Documented as a checklist in `docs/deploy.md`, linked from the README:

1. **Postgres service**: create Postgres 17 in the Tunelynk project; let Dokploy generate credentials; do not expose it externally; copy the internal connection URL. Enable scheduled backups if a backup destination is configured.
2. **Application**: GitHub provider, repo `jmoorer/tunelynk`, branch `main`, build type Dockerfile, auto-deploy on.
3. **Environment**: `DATABASE_URL=<internal Postgres URL>`, `PORT=3000`.
4. **Domain**: `tunelynk.bytmoor.com` → container port `3000`, HTTPS with Let's Encrypt. DNS: A record (or existing wildcard) for the subdomain pointing at the Dokploy host.
5. **Health check**: in the app's Swarm settings, a health check hitting `http://localhost:3000/api/health`, so a container that fails to boot never replaces a healthy one.

## Error handling

| Failure | Result |
|---------|--------|
| Missing/invalid env | `loadEnv` exits 1 → deploy fails, old container keeps serving |
| Migration error | `migrateDb` throws → exit 1 → same as above |
| DB unreachable after boot | `/api/health` reports `db: "down"`; process stays up |
| Web build missing | API still serves `/api` and the Swarm health check passes; `/` returns 404. Only possible if the build step is changed, since `pnpm build` fails the deploy otherwise |

## Out of scope

- Staging / PR preview environments
- CI gating deploys on `pnpm check` (Dokploy deploys every push to `main`)
- Multiple replicas (startup migrations assume a single instance)
- Image size optimisation (`pnpm deploy --prod`, pruning dev deps)
- Registering `tunelynk.com`
