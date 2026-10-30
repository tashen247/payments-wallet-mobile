# Build context: repository root.
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @wallet/worker... \
 && pnpm --filter @wallet/worker build \
 && pnpm --filter @wallet/worker deploy --legacy --prod /out

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
USER node
CMD ["node", "dist/index.js"]
