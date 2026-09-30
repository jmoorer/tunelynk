FROM node:22-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && chown node:node /app
USER node

# Download dependencies from the lockfile alone, so this layer stays cached
# until pnpm-lock.yaml changes instead of on every commit.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY --chown=node:node . .
# NODE_ENV=production (if passed at build time) would make pnpm skip the
# devDependencies the build needs (tsup, vite).
RUN NODE_ENV=development pnpm install --offline --frozen-lockfile && pnpm build

EXPOSE 3000
CMD ["sh", "-c", "node apps/api/dist/migrate.js && exec node apps/api/dist/index.js"]
