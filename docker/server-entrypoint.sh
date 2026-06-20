#!/bin/sh
# Container startup: apply migrations, seed content (idempotent), then run the
# server. Run from apps/server so node-pg-migrate finds ./migrations. The server
# requires a complete game_config to boot, so the seed must precede it.
# DATABASE_URL comes from the container environment (compose).
set -e

cd /app/apps/server

echo "[entrypoint] applying migrations (node-pg-migrate up)..."
pnpm exec node-pg-migrate up

echo "[entrypoint] seeding content (idempotent)..."
node dist/seed/run.js

echo "[entrypoint] starting server..."
exec node dist/index.js
