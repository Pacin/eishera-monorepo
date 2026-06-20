# Eishera

A persistent browser-based game (PBBG) — server-authoritative, with **PostgreSQL as the single source of truth**. Built in ordered phases per [`SPEC.md`](./SPEC.md); starting content and balance live in [`SEED.md`](./SEED.md).

> **Status: Phase 3 (tick core).** A single heartbeat advances the world one
> tick at a time, each tick a single atomic Postgres transaction (`world_state`
> locked `FOR UPDATE`, `tick_number++`, live clock per SPEC §5). On crash the
> world resumes from the last committed tick — at most the in-flight tick is lost
> — and downtime **freezes** the live clock (no wall-clock fast-forward). The
> active-set / boss / housing tick steps are present as structure but carry no
> game logic yet (Phases 4–6). Builds on Phase 2's hardened cookie auth.

### HTTP / WS surface (Phase 2)

| Method | Route            | Auth                  | Purpose                                                   |
| ------ | ---------------- | --------------------- | --------------------------------------------------------- |
| GET    | `/health`        | —                     | liveness probe                                            |
| GET    | `/auth/csrf`     | —                     | issue a CSRF token (+ sets the secret cookie)             |
| POST   | `/auth/register` | —                     | create account → sets cookies, returns `{ player }` (201) |
| POST   | `/auth/login`    | —                     | sets cookies, returns `{ player }` (200) / 401            |
| POST   | `/auth/refresh`  | refresh cookie + CSRF | rotate refresh token, reissue access cookie               |
| POST   | `/auth/logout`   | CSRF                  | revoke refresh token, clear cookies                       |
| GET    | `/me`            | access cookie         | current player summary                                    |
| WS     | `/ws`            | access cookie         | hello + ping/pong skeleton; registers the connection      |

Auth tokens are delivered as **httpOnly cookies** (never in the response body or
`localStorage`, per SPEC §13). The websocket authenticates from the access cookie
at handshake — no token in the URL. In dev the Vite server proxies `/auth`, `/me`,
`/health`, and `/ws` to the backend so the SPA and API share an origin (keeps
`SameSite=Strict` working without HTTPS).

Smoke-test the whole surface against a running server:

```bash
pnpm --filter @eishera/server smoke
```

## Layout

```
packages/shared   Types, formula functions, and balance-constant types.
                  Used by BOTH server (authoritative) and client (prediction).
apps/server       Node + TypeScript backend (Postgres connection, migrations).
apps/web          React + TypeScript frontend (Vite).
```

## Prerequisites

- **Docker + Docker Compose** (primary path — runs server + database in containers)
- **Node.js ≥ 22** and **pnpm 10** (`corepack enable`) — for the host-native dev path and tooling
- **PostgreSQL 14+** — only if you run the database natively instead of via Docker

## Run with Docker (recommended)

Server and database, fully containerized:

```bash
docker compose up --build
```

This starts Postgres, waits for it to be healthy, applies migrations, **seeds
content** (idempotent), then runs the server. The server logs `config loaded …`
and stays up. Stop with `docker compose down` (add `-v` to also drop the volume).

- Server: `http://localhost:4000` (HTTP + websocket; see the surface table above)
- Database: published on host port **5433** (to avoid colliding with a local
  Postgres on 5432); inside the network the server reaches it at `db:5432`.

### Hybrid: dockerized DB + host server (for hot reload)

```bash
docker compose up -d db                 # database only
cp .env.example .env                    # DATABASE_URL points at localhost:5433
pnpm install
pnpm --filter @eishera/shared build
pnpm dev:server                         # tsx watch, reloads on change
pnpm dev:web                            # http://localhost:5173
```

## Run host-native (no Docker)

```bash
pnpm install
cp .env.example .env                    # switch DATABASE_URL to Option B (localhost:5432)
createdb eishera
pnpm --filter @eishera/shared build
pnpm migrate:up                         # create all tables
pnpm seed                               # load SEED.md content (idempotent)
pnpm dev:server                         # loads config snapshot, then stays up
pnpm dev:web
```

If the server can't connect, check `DATABASE_URL` in `.env` and that Postgres is running.
The server requires a complete `game_config`, so **seed before first start** (the
Docker entrypoint does this automatically).

### Verify live config (Phase 1 acceptance)

```bash
pnpm --filter @eishera/server config:demo
```

Loads the snapshot + `LISTEN/NOTIFY` listener, updates `tick_seconds` through the
config service, and confirms the change surfaces in the in-memory snapshot within
~0.2s without a restart — plus that an out-of-bounds write is rejected and the
change is audited. Editing any `game_config` row directly in psql triggers the
same live reload.

### Verify the tick core (Phase 3 acceptance)

```bash
pnpm --filter @eishera/server tick:demo
```

Drives the tick transaction directly to prove each tick is atomic and advances
`tick_number` by 1, the live clock tracks real elapsed time during normal
operation, **downtime freezes** the clock (a long gap adds only one interval, not
the gap), and the resume point is the last committed `world_state`. The real
crash-resume is also observable by killing and restarting the server (or
`docker compose restart server`): it logs `resuming world at tick #N` and
continues — `tick_number` never resets.

## Database migrations

Schema changes go through SQL migration files (`node-pg-migrate`, run from `apps/server/migrations/`). Phase 1 adds all tables from SPEC §3 (enums, config/reference, state) plus the audit/notify triggers.

```bash
pnpm migrate:create <name>   # scaffold a new SQL migration (Phase 1+)
pnpm migrate:up              # apply pending migrations
pnpm migrate:down            # roll back the last migration
```

Host migration commands read `DATABASE_URL` from the repo-root `.env`. Under
Docker, the server container applies pending migrations on startup
(`docker/server-entrypoint.sh`).

## Workspace scripts

| Command             | What it does                      |
| ------------------- | --------------------------------- |
| `pnpm build`        | Build every package/app           |
| `pnpm typecheck`    | Type-check every package/app      |
| `pnpm lint`         | ESLint across the workspace       |
| `pnpm format`       | Prettier write                    |
| `pnpm format:check` | Prettier check (used in CI)       |
| `pnpm migrate:up`   | Apply DB migrations               |
| `pnpm seed`         | Load SEED.md content (idempotent) |

## Key decisions (Phase 0)

- **Migration tool: `node-pg-migrate` (SQL-first) over drizzle-kit.** The spec's
  integrity guarantees live in hand-written SQL — `FOR UPDATE` row locks, partial
  and partial-unique indexes, `LISTEN/NOTIFY`, `CHECK` constraints, and
  single-transaction ticks. SQL-first migrations plus a raw `pg` query layer keep
  that SQL explicit and reviewable, where an ORM/query-builder would abstract it
  away. `packages/shared` owns the hand-maintained TypeScript row types.
- **Dockerized server + database** via `docker-compose.yml` and a multi-stage
  `Dockerfile`. The server container applies migrations then runs the compiled
  build; the db is `postgres:16-alpine` with a healthcheck the server waits on.
- **Package manager: pnpm workspaces** (per spec) — `packages/*` + `apps/*`.
- **ESM + TypeScript strict everywhere**, with one shared `tsconfig.base.json`.
- **No Redis, no in-memory order book, no guild/event systems** — explicit v1
  non-goals (SPEC §15). Real-time modules will sit behind interfaces so a later
  multi-process move doesn't require rewriting game logic.

## Key decisions (Phase 1)

- **`rarities` PK = numeric `tier` (1..6).** SPEC §3.2 left this as "TEXT PK or
  ordered id"; SEED §3.2 uses concrete tiers 1–6 and the reweighting needs
  ordering, so tier is the PK (with `code`/`name` alongside).
- **Audit + reload via one generic DB trigger** on every config table, not in app
  code. It writes `config_audit` and `pg_notify('config_changed', …)` for any
  writer — the app's config service AND direct psql admin edits alike. Two session
  GUCs cooperate: `app.changed_by` (audit attribution) and
  `app.suppress_config_events` (the seed bulk-loads without audit/notify spam).
- **Validation in the app config service**, layered over natural DB `CHECK`
  constraints. Direct admin edits bypass app validation but are still audited and
  reload-signaled — a deliberate "admins can do anything, but it's recorded" stance.
- **Immutable snapshot, atomic swap.** All config loads in one REPEATABLE READ
  transaction into frozen maps; a reload builds the next snapshot fully, then
  activates it with a single reference assignment — a reader never sees a half
  update. A dedicated long-lived `LISTEN` connection drives debounced reloads.
- **Seed kept as typed data modules** (not raw INSERTs, not runtime-loaded JSON):
  satisfies SEED's "content is data" while staying type-checked and trivially
  available in the compiled Docker image.

> **Deferred (noted, not built):** the SEED §8.1 potion→effect mapping has no
> table in SPEC §3; it belongs to Phase 5/8 (active effects) and was intentionally
> not invented here.

## Key decisions (Phase 2)

- **Fastify v5** for HTTP + websockets on one port (`@fastify/websocket`),
  chosen for first-class TS, built-in JSON-schema validation, and auth hooks the
  later action/market/chat routes will reuse.
- **httpOnly-cookie auth, hardened** (`@fastify/jwt` + `@fastify/cookie` +
  `bcryptjs`):
  - **Access token** — short-lived JWT (15m) in an httpOnly cookie. Not readable
    by JS → XSS can't steal it; satisfies SPEC §13 (no localStorage).
  - **Refresh token** — opaque 256-bit random secret, stored **hashed** in
    Postgres (`auth_refresh_tokens`), in a path-scoped httpOnly cookie. Each use
    **rotates** (old revoked, new issued); replaying a revoked token is treated as
    **theft and revokes the whole token family**. `logout` revokes + clears.
    Revocation lives in Postgres, not Redis (a v1 non-goal). The refresh TTL
    (`REFRESH_TTL_DAYS`, default **30**) is how long "stay signed in" lasts; the
    access token silently rotates underneath it.
  - **CSRF** — `SameSite=Strict` as the primary defense, plus a CSRF token
    (`@fastify/csrf-protection`) required on state-changing routes.
  - **Rate limiting** — `@fastify/rate-limit` on the auth routes.
  - `JWT_SECRET`/`COOKIE_SECRET` are optional for DB-only scripts; the server
    warns when the insecure dev default is in use. `COOKIE_SECURE` defaults on in
    production.
- **Registration is one transaction**: the player row plus a `player_skills` row
  per seeded skill and a `player_housing` row per seeded feature — so an account
  never exists half-initialized. The skill/feature lists and the starting action
  cap come from the live config snapshot (data-driven, not hardcoded).
- **New players start with a full action bar** (`actions_remaining = max_actions`).
- **Websocket connection registry in memory** (player id → sockets), matching
  SPEC §2.1 (connections are memory-only, rebuildable). It's populated now so
  Phase 3+ can push live updates.

## Key decisions (Phase 3)

- **One heartbeat, `setTimeout`-chained** (not `setInterval`) — a slow tick can
  never overlap the next, and the interval re-reads `tick_seconds` from the live
  config snapshot each cycle, so retuning the tick rate needs no restart (SPEC §6
  "single heartbeat", §4 live config).
- **Each tick is one transaction.** `world_state` is locked `FOR UPDATE`; the
  active-set count, clock advance, and `tick_number++` all commit together — the
  world is always exactly at a tick boundary, never mid-tick.
- **Live clock measured in-DB.** The elapsed delta uses Postgres `now()` (the
  transaction time), not the app clock, so app/DB clock skew can't corrupt
  `uptime_seconds`. The clock math (`liveClockStep`) is a pure function:
  normal → add real elapsed; gap > `outage_threshold_seconds` → add only one
  interval and **freeze** the rest; first-ever tick → add 0.
- **Crash-resume for free.** Because every tick commits `world_state`, restart
  just reads the last committed row and continues; downtime is frozen by the same
  clock rule on the first tick back. No replay, no fast-forward.
- **Active-set / boss / housing steps are structural placeholders** in Phase 3 —
  the tick counts the active set but mutates nothing. Handlers + `actions_remaining--`
  arrive in Phase 4, housing completion in Phase 6, the boss in Phase 8.
