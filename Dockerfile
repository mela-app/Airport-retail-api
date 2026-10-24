# syntax=docker/dockerfile:1
#
# The backend image: REST + SSE API, simulation and decision engine (NestJS).
#   docker build -t arm-api .        docker run -p 8080:8080 arm-api      (embedded PostgreSQL, no other service)
# or `docker compose up` for the API with a PostgreSQL server (see compose.yaml).

# Every stage starts from the same pinned image (version and digest).

# ---- build everything ---------------------------------------------------------------------------------------
FROM node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/mockgen/package.json packages/mockgen/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm -r build

# ---- production dependencies of the API only -----------------------------------------------------------------
FROM node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS prod-deps
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/mockgen/package.json packages/mockgen/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter "@arm/api..."

# ---- runtime ------------------------------------------------------------------------------------------------
FROM node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data/generated \
    DATABASE_URL=pglite:/data/pglite \
    SIM_AUTOPLAY=true
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=prod-deps /app/packages/mockgen/node_modules ./packages/mockgen/node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/domain/package.json ./packages/domain/
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/packages/mockgen/package.json ./packages/mockgen/
COPY --from=build /app/packages/mockgen/dist ./packages/mockgen/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD ["node", "apps/api/dist/healthcheck.js"]
CMD ["node", "apps/api/dist/main.js"]
