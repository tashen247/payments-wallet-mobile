# Build context: repository root.
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @wallet/api... \
 && pnpm --filter @wallet/api build \
 && pnpm --filter @wallet/api deploy --legacy --prod /out

FROM node:20-alpine
ENV NODE_ENV=production MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/packages/db/drizzle ./drizzle
USER node
EXPOSE 3000
# Migrations are idempotent; running them on start keeps deploys to one step.
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/src/index.js"]
