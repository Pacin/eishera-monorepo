# Eishera

A persistent browser-based game (PBBG) — server-authoritative, with **PostgreSQL as the single source of truth**. Built in ordered phases per [`SPEC.md`](./SPEC.md); starting content and balance live in [`SEED.md`](./SEED.md).

> **Status: Phase 10 (frontend).** A **React 19 + TypeScript SPA** (`apps/web`) is
> the playable client: register/login over httpOnly cookies (**no localStorage**,
> SPEC §13), then a dashboard with Actions, Character, Housing, Market, World boss,
> and Chat panels. The server stays authoritative; the client renders **smooth
> values via the shared formulas** — a ticking action bar, skill XP bars
> (`xpToNext`), a live housing countdown, and the boss HP bar. **Live updates over
> Socket.IO**: on connect the server sends a **`sync`** bootstrap (player, content
> catalog, housing, boss), then streams every update — `player:update`, battle
> results, market fills, chat, `housing:update`, `boss:update`. The SPA makes **no
> data GETs at all** (no `/me`, `/config`, `/housing`, `/boss`): auth status comes
> from the socket handshake, and mutations are HTTP POSTs whose responses carry the
> new state. Everything from Phases 4–9 still runs.

### HTTP / Realtime surface

| Method    | Route                     | Auth                  | Purpose                                                          |
| --------- | ------------------------- | --------------------- | ---------------------------------------------------------------- |
| GET       | `/health`                 | —                     | liveness probe                                                   |
| GET       | `/auth/csrf`              | —                     | issue a CSRF token (+ sets the secret cookie)                    |
| POST      | `/auth/register`          | —                     | create account → sets cookies, returns `{ player }` (201)        |
| POST      | `/auth/login`             | —                     | sets cookies, returns `{ player }` (200) / 401                   |
| POST      | `/auth/refresh`           | refresh cookie + CSRF | rotate refresh token, reissue access cookie                      |
| POST      | `/auth/logout`            | CSRF                  | revoke refresh token, clear cookies                              |
| GET       | `/me`                     | access cookie         | current player summary (incl. current activity)                  |
| GET       | `/config`                 | access cookie         | read-only content catalog + client formula constants             |
| POST      | `/actions/select`         | access cookie + CSRF  | choose a transform recipe (`{ recipeId }`, `null`=idle)          |
| POST      | `/actions/battle`         | access cookie + CSRF  | choose a monster to fight (`{ monsterId }`)                      |
| POST      | `/actions/refresh`        | access cookie + CSRF  | refill the action bar to `max_actions`                           |
| POST      | `/actions/consume`        | access cookie + CSRF  | drink a potion (`{ itemCode }`) → active effect                  |
| POST      | `/equipment/equip`        | access cookie + CSRF  | equip an owned instance (`{ instanceId }`)                       |
| POST      | `/equipment/unequip`      | access cookie + CSRF  | clear a slot (`{ slot }`)                                        |
| GET       | `/equipment`              | access cookie         | equipped items + current effective combat stats                  |
| POST      | `/housing/upgrade`        | access cookie + CSRF  | start a feature upgrade (`{ featureId }`)                        |
| POST      | `/housing/cancel`         | access cookie + CSRF  | cancel the active upgrade → partial refund                       |
| GET       | `/housing`                | access cookie         | features, levels, next cost, active job (lazy-completes)         |
| POST      | `/market/orders`          | access cookie + CSRF  | place a buy/sell order (`{side,item_id,price,qty,idem_key}`)     |
| POST      | `/market/orders/cancel`   | access cookie + CSRF  | cancel a resting order → release escrow                          |
| GET       | `/market/book`            | access cookie         | aggregated order book for `?item_id=`                            |
| POST      | `/market/listings`        | access cookie + CSRF  | list an instance (`{instance_id,price,idem_key}`)                |
| POST      | `/market/listings/buy`    | access cookie + CSRF  | buy a listing (`{listing_id}`) — single-buyer                    |
| POST      | `/market/listings/cancel` | access cookie + CSRF  | cancel your listing                                              |
| GET       | `/market/listings`        | access cookie         | active listings for `?item_id=`                                  |
| POST      | `/salvage`                | access cookie + CSRF  | salvage an instance (`{instance_id}`) → materials                |
| POST      | `/boss/join`              | access cookie + CSRF  | join the world boss (auto-spawns if none active)                 |
| GET       | `/boss`                   | access cookie         | boss state + your damage + ticks remaining                       |
| POST      | `/boosts/buy`             | access cookie + CSRF  | buy a global boost with tokens (`{boostCode}`)                   |
| Socket.IO | (connection)              | access cookie         | `hello` + ping/pong; receives `battle`, `market:fill`            |
| Socket.IO | `sync` (out)              | access cookie         | bootstrap on connect: `{ me, catalog, housing, boss }` (no GETs) |
| Socket.IO | `player:update` (out)     | access cookie         | per-tick player summary for active players (replaces `/me` poll) |
| Socket.IO | `housing:update` (out)    | access cookie         | full housing view when an upgrade completes                      |
| Socket.IO | `boss:update` (out)       | access cookie         | live boss view to all online players while a boss is active      |
| Socket.IO | `chat:send` (in)          | access cookie         | send a message (`{channel, body}`) — persisted + broadcast       |
| Socket.IO | `chat:message` (out)      | access cookie         | a broadcast message for a joined channel                         |
| Socket.IO | `chat:history` (out)      | access cookie         | recent history per channel, sent on connect (from buffer)        |
| Socket.IO | `chat:error` (out)        | access cookie         | definitive send rejection (`rate_limited`, validation, …)        |

Auth tokens are delivered as **httpOnly cookies** (never in the response body or
`localStorage`, per SPEC §13). Realtime is **Socket.IO**, which authenticates the
access cookie at the connection handshake — no token in the URL. In dev the Vite
server proxies the API routes (`/auth`, `/me`, `/config`, `/actions`,
`/equipment`, `/housing`, `/market`, `/salvage`, `/boss`, `/boosts`, `/health`)
and `/socket.io` to the backend so the SPA and API share an origin (keeps
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

- Server: `http://localhost:4000` (HTTP + Socket.IO; see the surface table above)
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

### Verify transform actions (Phase 4 acceptance)

```bash
pnpm --filter @eishera/server phase4:demo
```

Sets players gathering/crafting and drives ticks directly (no websocket → genuine
offline processing) to prove an offline player's banked actions process down to 0,
XP/level and yield are correct, and crafting a sword produces an `item_instances`
row whose per-stat rolls land inside the chosen rarity's band — with inputs
consumed and XP granted.

### Verify combat (Phase 5 acceptance)

```bash
pnpm --filter @eishera/server phase5:demo
```

Proves a battle returns rounds + damage dealt/taken; **equipping a higher-rolled
sword measurably raises damage dealt** (averaged over many duels); a potion raises
effective stats (`combat_all`); winning grants XP + gold (losing grants nothing);
and a combat level-up grants base-stat points per `stat_per_level`.

### Verify housing (Phase 6 acceptance)

```bash
pnpm --filter @eishera/server phase6:demo
```

Proves **two concurrent upgrades can't start** (service pre-check + DB unique
index), **downtime freezes the timer** (an outage tick advances the live clock by
only one interval, so a job past its wall-clock deadline still doesn't complete
until the live clock reaches it), and **cancel refunds `(1 − cancel_penalty)` of
the `paid_snapshot`** even after the cost config changes live — plus that housing
bonuses feed yield / rare-drop / craft-quality / combat stats.

### Verify market + salvage (Phase 7 acceptance)

```bash
pnpm --filter @eishera/server phase7:demo
```

Proves order-book matching settles with escrow (no overspend), the **concurrency
test** (two buys for one remaining unit → exactly one fills, the unit is never
transferred twice), **idempotency** (a repeated `idem_key` doesn't double-charge),
an instance listing is **bought by at most one buyer**, and salvage deletes the
instance while returning quality-scaled materials. `pnpm --filter @eishera/server
sio:market` additionally checks the HTTP order → **`market:fill` Socket.IO push** to
the resting order's owner.

### Verify world boss + boosts (Phase 8 acceptance)

```bash
pnpm --filter @eishera/server phase8:demo
```

Proves boss damage accrues per tick and the **tier escalates** on each kill, the
**window freezes on downtime** (an outage tick advances it by one tick, never by
the wall-clock gap), and on expiry **rewards are distributed by total damage**
(gold share + a global-boost grant → `player_active_effects` + `global_boost_log`).
It also buys a boost with tokens and confirms an **XP boost multiplies XP gains**.

### Verify chat (Phase 9 acceptance)

```bash
pnpm --filter @eishera/server phase9:demo   # service layer (no socket)
pnpm --filter @eishera/server sio:chat      # over the wire (server must be running)
```

`phase9:demo` proves every message **persists to `chat_messages`**, the **ring
buffer** serves recent history and is **rebuildable from Postgres** after cache
loss (capped at `buffer_size`, newest kept), the **rate limit** returns a
definitive `rate_limited` error, and validation rejects unknown channels / empty /
over-length bodies. `sio:chat` connects two sockets and confirms a `chat:send`
**broadcasts** as `chat:message` to the other, a fresh socket gets **history on
connect**, and flooding yields a `chat:error` (`rate_limited`).

### Run the frontend (Phase 10)

```bash
pnpm --filter @eishera/server start   # or: dev — backend on :4000
pnpm --filter @eishera/web dev        # SPA on http://localhost:5173 (proxies to :4000)
```

Open `http://localhost:5173`, register, and the dashboard loads: pick a recipe or
monster (the action bar **ticks** toward the next action), watch skill **XP bars**
(`xpToNext`), start a housing upgrade (**live countdown**), join the **world boss**
(**HP bar**), trade on the market, and chat. Battle results, market fills, and chat
arrive **live over Socket.IO**; `/me`, `/housing`, `/boss` re-sync on a short poll.
No state is kept in `localStorage` — auth rides httpOnly cookies (SPEC §13).

A real-browser (Chromium/Playwright) render test drives the live SPA end to end —
register → every panel renders → select an activity → join the boss → place an
order → send chat — asserting on the rendered DOM and capturing a screenshot:

```bash
pnpm --filter @eishera/web exec playwright install chromium   # one-time
# with the backend (:4000) and `pnpm --filter @eishera/web dev` (:5173) running:
pnpm --filter @eishera/web test:browser
```

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

- **Fastify v5** for HTTP, chosen for first-class TS, built-in JSON-schema
  validation, and auth hooks the action/market/chat routes reuse.
- **Realtime via Socket.IO** (attached to the same HTTP server/port). The
  connection handshake authenticates the httpOnly access cookie by reusing
  Fastify's own cookie parser + JWT verify (one auth path, not a parallel one).
  Each connection joins a per-player room (`player:<id>`); the tick pushes
  `battle` results with `io.to(room).emit(...)`. `SameSite=Strict` on the access
  cookie blocks cross-site handshakes from carrying it. (The `ws`/`@fastify/websocket`
  approach was swapped out for Socket.IO's rooms + client reconnect ergonomics; a
  Redis adapter is the later multi-process path, still a v1 non-goal.)
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

## Key decisions (Phase 4)

- **Formulas in `packages/shared`, RNG in the server.** `xpToNext`, `yieldMult`,
  `pRare`, `gainXp`, and the rarity-weight math are pure and shared (server runs
  them authoritatively; the client will use them for prediction). Random rolls
  (which rarity, which stat multipliers, fractional-yield rounding) are
  server-only — the client can't predict RNG.
- **Bounded rarity reweight = linear** (resolving the gap flagged in Phase 0):
  `weight'(tier) = base_weight × (1 + shift × quality × (tier−1))`. Higher
  `quality` (craft level on crafts, LUCK on drops) lifts uncommon→unique
  meaningfully, while mythic's tiny base weight keeps it extremely scarce. `shift`
  is `rarity_quality_shift` / `rarity_luck_shift` — all config-tunable.
- **Equippable outputs don't scale in quantity** — crafting always yields the
  listed count of unique `item_instances` (quality scales via the rarity roll, not
  count); only stackable outputs scale by `yieldMult`.
- **Fractional yield is probabilistic** — `floor(expected)` plus a chance for the
  remainder, so expected output is exact over many actions without fractional rows.
- **Stall = no consumption.** If `req_level` isn't met or inputs are missing, the
  action doesn't progress and no action is spent (the player is simply stuck until
  they level up or acquire materials) — gathering recipes never stall.
- **One transform per active player per tick**, all inside the single tick
  transaction (atomic with the clock advance). Bulk-processing is a future
  optimization; correctness-first per-player for now.

## Key decisions (Phase 5)

- **Effective stats = `(base + equipment) × (1 + combat_all%)`.** Equipment adds
  `items.base_stats[S] × rolls[S]` per equipped instance; `combat_all` (potions/
  globals) is a multiplier on all six; housing joins in Phase 6. Per-stat flat
  effects (e.g. `combat_str`) would add into the flat term.
- **Duel formulas are config-driven** (`combat_coeffs`), documented in
  `combat/duel.ts`: hit/crit via DEX(+LUCK), dodge via EVA, mitigation via DEF,
  fight-HP via VIT, capped by `max_rounds`. `simulateDuel` is pure given an RNG —
  so it's reproducible and testable; the round log is never persisted.
- **Side effects after commit.** The tick collects `BattleResult`s inside the
  transaction and only pushes them to websockets _after_ the tick commits — no I/O
  inside the tick transaction (SPEC §6).
- **Potion→effect mapping lives in `game_config.potion_effects`** (config, not a
  new table) — resolving the Phase 1 deferral while keeping content-as-data.
  Durations are on the live clock (freeze on downtime); re-drinking refreshes.
- **Combat gains:** base-stat points on combat level-up (`stat_per_level`) plus a
  low per-action `random_stat_gain_chance`. Equipment/potions are _effective_
  bonuses, never permanent base gains. Loss = zero rewards.
- **LUCK nudges loot rarity, not loot quantity** — equippable drops roll rarity
  with `rarity_luck_shift × effective LUCK`; stackable loot drops at its flat
  chance, unaffected by LUCK.

## Key decisions (Phase 7)

- **HTTP commands, Socket.IO fills.** Placing/cancelling orders, listing, buying,
  and salvaging are HTTP (with `idem_key` for idempotent retries); a `market:fill`
  is **pushed over Socket.IO** to the resting (maker) order's owner. The market's
  correctness lives in the server queue + Postgres, not the transport.
- **Single sequential FIFO queue** (`market/queue.ts`) serializes order-book
  operations → deterministic "first in, first processed". It's behind a
  `MarketQueue` interface so a multi-process build can swap in a Redis sequencer
  without touching the matching logic.
- **Escrow at placement.** A sell reserves its items, a buy reserves `price×qty`
  gold, up front — preventing overspend and phantom liquidity. Fills settle at the
  **maker (resting) price**; a taker buy that fills below its limit is refunded the
  difference; cancel returns the unfilled escrow. (This is how "debit at fill" is
  realized safely.)
- **Listings use row-locking, not the queue.** Each listing is one specific row, so
  `SELECT … FOR UPDATE` gives the single-buyer guarantee directly; the second buyer
  gets a definitive `no_longer_available`. Buy is naturally idempotent via the
  terminal `sold` state + ownership.
- **Salvage scales by quality** = the average of the instance's per-stat rolls, ×
  the item's `salvage_yield`, then the row is **deleted** (the sink that bounds
  `item_instances` growth).

## Key decisions (Phase 8)

- **Boss runs inside the tick transaction** (a separate block after actions),
  written durably every tick — at most one in-flight tick is ever lost (§2/§9).
- **Tick-based window → free downtime freeze.** `started_tick..ends_tick` measure
  elapsed _ticks_, and ticks only happen while the server is up, so a long outage
  contributes zero ticks — the boss neither expires nor advances during downtime.
- **`max_hp` constant, tier escalates per kill** (HP refills) — the spec's
  "tier++, hp = max_hp; the event continues". Overkill rolls into further tiers.
- **Boss damage uses base combat stats** bulk-fetched per tick (the spec's
  "microsecond-scale per-player roll"), not a full effective-stat recompute per
  participant per tick.
- **Auto-spawn on join** — no admin role in v1, so the first joiner spawns the boss;
  bosses appear on demand. (A scheduled spawner is a later refinement.)
- **One grant path for all boosts.** `grantGlobalBoost` (used by boss rewards,
  token purchases, events) always writes both the runtime `player_active_effects`
  row _and_ the `global_boost_log` audit row; re-granting refreshes. Boost effects
  feed the existing formula layer — `combat_all`, `gather_yield`, `rare_drop`, and
  **`xp`** (now multiplying XP gains in transform + combat).

- **Upgrade start is atomic + instant** (not a tick action): check max/funds →
  deduct gold + resources → store `paid_snapshot` → insert the job, all in one
  transaction. If the job insert loses the race for the single slot, the whole
  thing rolls back (no partial charge).
- **One upgrade at a time = DB guarantee.** A graceful service pre-check returns
  `upgrade_in_progress`, but the real backstop is the `uniq_active_upgrade` partial
  unique index — a concurrent second insert fails and is mapped to the same error.
- **Timers on the live clock, so they freeze.** Jobs store `completes_live` on the
  `uptime_seconds` scale; the tick completes any due job (`completes_live <= uptime`),
  and `GET /housing` lazily completes the player's due jobs so the UI shows "done"
  immediately. Downtime doesn't fast-forward — the live clock proved frozen in §5.
- **Cancel refunds from `paid_snapshot`, not current config.** The refund is
  `floor(snapshot × (1 − cancel_penalty))`, so a live cost change between start and
  cancel can't corrupt it (verified by mutating cost config mid-upgrade).
- **First level is free + instant** with the seed curves (`cost = cost_base·0^growth = 0`
  at level 0). It's pure config — bump `cost_base`/curves or seed starting levels if
  you want the first tier to cost. Flagged, not hidden.
- **Bonus integration is unified.** `computeProductionModifiers` aggregates
  gather/food/rare/craft bonuses from equipment (tool) + active effects + housing;
  `computeEffectiveStats` adds housing `combat_all`. **craft_quality is
  multiplicative** (`level × (1 + workshop + effects)`) so the workshop meaningfully
  shifts crafted-gear rarity; **`food_yield` applies to food output specifically**,
  `gather_yield` to all gathering. These are the spec's under-pinned points, resolved
  and documented.

## Key decisions (Phase 9)

- **Chat arrives over the socket, not HTTP.** The Phases 5/7 split sends mutations
  over HTTP (cookie + CSRF) and pushes updates over Socket.IO — but chat is
  _genuinely_ real-time, so an incoming message is a `chat:send` event on the
  **already-authenticated socket** (handshake verifies the access cookie + JWT;
  `SameSite=Strict` blocks cross-site handshakes). No separate CSRF token is needed
  for the socket, matching the existing `ping` event. The server **persists first**
  (the durable moderation record), then buffers, then broadcasts as `chat:message`.
- **Postgres is the source of truth; the ring buffer is a pure cache.** Every
  message is written to `chat_messages` (SPEC §11). The per-channel "last N" buffer
  is in-memory only — rebuilt from Postgres on startup (and on demand), so losing it
  loses nothing. It's **behind a `ChatBuffer` interface** so a later multi-process
  move can swap an in-memory impl for a Redis-backed one without touching the chat
  service or socket handlers (SPEC §2.1).
- **Bounded channels = bounded memory.** Allowed channels come from config
  (`global`, `trade`, `help`); a send to anything else is rejected. Arbitrary
  channel names would let the buffer map grow unbounded. Sockets auto-join all
  configured channels on connect and immediately receive each channel's history.
- **Rate limit is ephemeral anti-spam infra, so it uses wall-clock** — a per-player
  sliding window in memory (`rate_max` per `rate_window_seconds`). This is _not_ a
  game timer: it does **not** freeze on downtime (unlike housing/boss live-clock
  timers), and losing the map just resets the window. Exceeding it returns a
  definitive `chat:error` (`rate_limited`) to the sender — never a silent drop (the
  same "definitive rejection" principle the market uses, SPEC §10.4).
- **Chat config is data, read via the snapshot's `raw` map** (`game_config.chat`),
  the same pattern as `boss` / `potion_effects` / `boost_token_costs` — so channels,
  buffer size, rate limit, and max length are **live-tunable** without a typed
  `GameConfig` change. _Resolved gap:_ SPEC §11 requires a ring buffer "last N" and
  rate-limiting but SEED.md gives no numbers; chosen starting values
  (`buffer_size 50`, `rate_max 5 / 10s`, `max_length 500`) are documented here and
  tunable like all other balance config. Flagged, not hidden.
- **`username` is denormalized into the buffer/broadcast** for display; the
  `chat_messages` row stores only `player_id`, so the rebuild query joins `players`.

## Key decisions (Phase 10)

- **Server-authoritative, client-predicted (never client-owned).** The SPA holds
  the latest server snapshots and renders smooth values _between_ them using the
  **same `@eishera/shared` formulas the server runs** (`xpToNext` for XP bars, the
  `tick_seconds` cadence for the action ticker, server `remaining_seconds` for the
  housing countdown, `hp/max_hp` for the boss bar). Predictions are cosmetic; every
  authoritative number is re-synced and never invented locally.
- **Everything over the socket — the SPA makes no data GETs.** On connect the
  server emits a **`sync`** bootstrap (`{ me, catalog, housing, boss }`), so there's
  no load-time GET of `/me`, `/config`, `/housing`, or `/boss`. **Auth status is
  derived from the socket handshake**, not a `/me` probe: `sync` → authed. A
  `connect_error` (usually an expired 15-min access token, even on a fresh reload)
  first attempts a token **refresh** via the 30-day refresh cookie and reconnects
  with a fresh socket — only a genuinely failed refresh shows the login screen, so
  reloading after the access token expires keeps you signed in. Mutations are HTTP POSTs (cookie + CSRF, per the transport
  split) whose **responses carry the new state** — the client applies them directly
  instead of re-fetching. After each tick commits, the loop pushes (to **online**
  players only, bounded work):
  - **`player:update`** — the player summary to each online _active_ player (the
    per-tick heartbeat: actions/xp/gold). Idle players get nothing because nothing
    changes. Batched (`getPlayerSummaries`, a fixed 3 queries, not 3×N).
  - **`housing:update`** — the full housing view to players whose upgrade _completed_
    this tick. Housing otherwise only changes on the player's own mutation (applied
    from the POST response).
  - **`boss:update`** — the per-player boss view to **all online players** each tick
    while a boss is active (live HP/timer/your*damage \_and* discovery of a freshly
    spawned boss, SPEC §9/§13). Bounded to online players, only during boss windows.
  - Market fills also push a `player:update` to both parties (market runs off-tick),
    so gold updates without a `/me` GET.

  _On the `/config` confusion:_ that endpoint is **not** the server tuning system
  (`game_config`); it's a read-only content **catalog** + formula constants. It now
  ships inside `sync`, so the frontend never fetches it. (The GET routes still exist
  server-side for tests/tools; the SPA simply doesn't call them.)

- **Removed the redundant "Refill actions" button.** Clicking the action bar itself
  refills (SPEC §6), so the separate panel button was dropped.

- **New read-only `GET /config`.** The client needs content (recipes, monsters,
  housing, items, rarities, boosts) and the formula constants to render and predict.
  Rather than scatter this across endpoints, one catalog endpoint projects the config
  snapshot (display + constants only — never RNG or per-player state). `PlayerSummary`
  also now carries `active_recipe_id`/`active_monster_id` so the UI can show the
  current activity after a reload.
- **No `localStorage`/`sessionStorage` (SPEC §13).** Auth rides httpOnly cookies the
  browser attaches automatically; only the CSRF token lives in memory. The API client
  refreshes CSRF on a 403 and rotates the access cookie via `/auth/refresh` on a 401,
  retrying once — so a 15-minute access-token expiry is invisible to the player.
- **Socket auth via cookie, not URL.** The client opens the socket with no token;
  the cookie authenticates the handshake (same path as the HTTP API). In dev the Vite
  proxy makes `:5173` same-origin with the backend so `SameSite=Strict` holds without
  HTTPS. (Note: a headless Node `socket.io-client` must pass the cookie via
  `extraHeaders`, which is reliable on the polling handshake; a real browser sends it
  automatically on both transports.)
- **Scope kept tight.** The market panel surfaces the **fungible order book**
  (the spec's "smooth market prices" + live fills); equipment **instance listings**
  and **salvage** remain fully available via the API but aren't given dedicated UI in
  v1 — flagged, not hidden, to keep the first frontend focused.
- **Verified in a real browser; bugs caught + fixed.** The Chromium test exposed
  that bodyless POSTs (`/boss/join`, `/actions/refresh`, `/housing/cancel`,
  `/auth/logout`) were sent with `content-type: application/json` and an empty body,
  which Fastify rejects (`FST_ERR_CTP_EMPTY_JSON_BODY`, 400). The API client now sets
  that header only when a body is present.
- **Single-flight token refresh (fixes "UI freezes / reload logs out").** Refresh
  tokens rotate and reuse is treated as theft — the server revokes the **whole
  session** (`auth/refresh.ts`). The poll fires `/me`, `/housing`, `/boss` together,
  so once the 15-min access token expired all three 401'd and each fired its own
  `/auth/refresh` with the same cookie: the first rotated it, the others replayed the
  now-revoked token → session revoked → every request failed (UI frozen) and reload
  → login. Fix: concurrent refreshes now **share one in-flight promise** (`api.ts`),
  so expiry triggers exactly one clean rotation. The reload `/me` probe also attempts
  a refresh, so a reload restores the session via the 30-day refresh cookie. A poll
  `/me` that 401s even after refresh drops to the login screen instead of freezing.
  Both paths are covered by `test:browser` (reload check) and a session-expiry test
  run with `ACCESS_TTL=4s` (survives ~4 expiries without revoke).
