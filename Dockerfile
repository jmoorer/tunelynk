FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN NODE_ENV=development pnpm install --frozen-lockfile && pnpm build
EXPOSE 3000
CMD ["sh", "-c", "node apps/api/dist/migrate.js && exec node apps/api/dist/index.js"]
