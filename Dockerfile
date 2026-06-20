# Server image for @eishera/server. Multi-stage: build the workspace, then run
# the compiled output. node-pg-migrate is kept in the runtime so the container
# can apply migrations on startup (see docker/server-entrypoint.sh).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# --- build stage -----------------------------------------------------------
FROM base AS build
# Copy only manifests first for better layer caching of the install step.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
# Bring in sources and build the two packages the server needs.
COPY . .
RUN pnpm --filter @eishera/shared build \
  && pnpm --filter @eishera/server build

# --- runtime stage ---------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# Copy the fully installed + built workspace. (Dev deps are retained so
# node-pg-migrate is available to run migrations at startup.)
COPY --from=build /app /app
WORKDIR /app/apps/server
EXPOSE 4000
CMD ["sh", "/app/docker/server-entrypoint.sh"]
