# Deploying to Dokploy

Tunelynk runs as one Dokploy application (API + built web SPA) plus a
Dokploy-managed Postgres, at https://tunelynk.bytmoor.com. Every push to
`main` deploys.

## How a deploy works

1. Docker builds the repo using `Dockerfile`, as the non-root `node` user:
   `pnpm fetch` (cached until `pnpm-lock.yaml` changes), then an offline
   `pnpm install` and `pnpm build`.
   (Not Nixpacks: its Node versions are too old for the lockfile's engine ranges.)
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
   - Build type: Dockerfile (path `Dockerfile`, context `.`).
   - Auto deploy: on.
3. **Environment.**
   ```
   DATABASE_URL=<internal Postgres URL from step 1>
   PORT=3000
   APP_URL=https://tunelynk.bytmoor.com
   EMAIL_PROVIDER=resend
   RESEND_API_KEY=<Resend API key, sending access>
   EMAIL_FROM=Tunelynk <login@bytmoor.com>
   APPLE_TEAM_ID=<Apple developer team id>
   APPLE_KEY_ID=<MusicKit key id>
   APPLE_PRIVATE_KEY=<base64 of the MusicKit .p8 file>
   SESSION_SECRET=<32+ random chars: openssl rand -base64 48>
   LLM_PROVIDER=anthropic
   ANTHROPIC_API_KEY=<key with credit>
   ```
   Optional, with defaults: `LLM_MODEL_GUEST` (`claude-haiku-4-5`; `gpt-4.1-mini` for openai), `LLM_MAX_TOKENS` (2000), `LLM_DAILY_BUDGET_USD` (2), `APPLE_STOREFRONT` (`us`), `APPLE_CATALOG_RPS` / `_BURST` / `_CONCURRENCY` (8 / 10 / 4). Leave `COOKIE_SECURE` unset; it defaults to `true`, which is right behind HTTPS.

   **Set these before a deploy that includes the runs API.** The server validates them at boot and exits if any are missing. The new container then never becomes healthy and the old one keeps serving, but the deploy fails. `migrate.js` needs only `DATABASE_URL`.

   **Resend (magic-link email).** Create a Resend account, add the sending domain `bytmoor.com` (Domains → Add), and create the DNS records Resend lists (an SPF `TXT` and the DKIM `TXT`/`CNAME` records; DMARC is optional) at the DNS provider. Wait until Resend shows the domain as **Verified**, then create an API key with **Sending access** and put it in `RESEND_API_KEY`. `EMAIL_FROM` must use the verified domain. `EMAIL_PROVIDER` is required in production (`COOKIE_SECURE` unset or `true`); the server exits at boot without it. `EMAIL_PROVIDER=console` logs sign-in links instead of sending them, so anyone with log access could use them. Use it only for local http.

   **Sign in with Apple (optional).** Leave `APPLE_SIGNIN_CLIENT_ID` unset to run without it: the server logs a warning, `/api/auth/providers` reports `apple: false`, and the web offers email sign-in only. It needs an active Apple Developer Program membership. To turn it on, in the Apple Developer portal (Certificates, Identifiers & Profiles):
   1. **Identifiers → + → App IDs → App**: description `Tunelynk`, Bundle ID (explicit) `com.bytmoor.tunelynk`, enable **Sign in with Apple**. Register.
   2. **Identifiers → + → Services IDs**: description `Tunelynk Web`, identifier `com.bytmoor.tunelynk.web`. Register, open it, tick **Sign in with Apple → Configure**: primary App ID `com.bytmoor.tunelynk`, domain `tunelynk.bytmoor.com`, return URL `https://tunelynk.bytmoor.com/api/auth/apple/callback`. Save, then Continue/Save.
   3. **Keys**: open the MusicKit key (`APPLE_KEY_ID`) → Edit → enable **Sign in with Apple** → Configure → primary App ID `com.bytmoor.tunelynk` → Save. If the portal won't edit that key, create a new key with only Sign in with Apple and set `APPLE_SIGNIN_KEY_ID` and `APPLE_SIGNIN_PRIVATE_KEY` (base64 of its `.p8`).
   4. Set `APPLE_SIGNIN_CLIENT_ID` to the Services ID. Apple does not allow `localhost` return URLs; local end-to-end tests need an HTTPS tunnel whose domain and return URL are added to the Services ID.

   No `NODE_ENV` is needed; the app does not read it. (The Dockerfile forces `NODE_ENV=development` for `pnpm install`, so the build is safe even if one is set.)
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
   (Durations are nanoseconds.) This uses `node` because the `node:22-slim` image has no `curl`.
6. Deploy. Check that https://tunelynk.bytmoor.com/api/health returns `{"ok":true,"db":"up"}`, then generate a playlist from the landing page.

## Operations

- **Logs:** Dokploy → app → Logs. A deploy logs `Migrations applied` and then `API listening`.
- **Rollback:** redeploy an earlier commit from Deployments, or revert on `main`.
  Migrations do not roll back, so write them to be backward compatible.
- **Postgres extensions:** the local `docker/postgres/init.sql` creates `pg_trgm`,
  but the Dokploy database does not run it. Any migration that relies on an
  extension must include `CREATE EXTENSION IF NOT EXISTS …` itself.
- **Replicas:** keep this at 1. Migrations run on container start and are not
  coordinated across instances.
- **LLM spend:** every run records its cost in `llm_usage`. New runs are refused with `503 budget_exceeded` once today's (UTC) spend plus a reservation for in-flight runs reaches `LLM_DAILY_BUDGET_USD`.
- **Stuck runs:** a sweeper fails `queued`/`running` runs older than 3 minutes at boot and every minute, so a redeploy mid-run never strands a guest.
- **Sessions:** guests and signed-in users carry an httpOnly `tl_session` cookie; the database stores only its SHA-256 (`sessions`). Old `tl_guest` cookies from before #11 are upgraded to a session on the next request. `SESSION_SECRET` still signs those legacy cookies (and, from #11 slice C, the short-lived Apple sign-in state cookie), so keep it unchanged.
- **Local image check:** `docker build -t tunelynk . && docker run --rm -p 3100:3000 --env-file .env -e DATABASE_URL=postgres://tunelynk:tunelynk@host.docker.internal:5432/tunelynk -e PORT=3000 tunelynk` (the server needs the full env from `.env`, not just `DATABASE_URL`)
