# Deploying to Dokploy

Tunelynk runs as one Dokploy application (API + built web SPA) plus a
Dokploy-managed Postgres, at https://tunelynk.bytmoor.com. Every push to
`main` deploys.

## How a deploy works

1. Docker builds the repo using `Dockerfile`: `pnpm install`, then `pnpm build`.
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
   (Durations are nanoseconds.) This uses `node` because the `node:22-slim` image has no `curl`.
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
- **Local image check:** `docker build -t tunelynk . && docker run --rm -p 3100:3000 -e DATABASE_URL=postgres://tunelynk:tunelynk@host.docker.internal:5432/tunelynk tunelynk`
