# PBBG Build Specification — For Claude Code

This document is a complete build plan for a persistent browser-based game (PBBG). Claude Code will implement it end to end, in ordered phases. Each phase has independently verifiable acceptance criteria. Design decisions are binding; anything listed under "non-goals" is explicitly out of scope for v1.

---

## 0. Project overview

- **Genre:** PBBG (persistent browser-based game), action-based, server-authoritative.
- **Theme:** Medieval / dragons / fantasy.
- **Core mechanic:** Every action is a fixed **6 seconds**. Actions are processed server-side.
- **Scale target:** ~1000 concurrent players comfortably; the architecture must be openable to horizontal scale later.
- **Reference games (for feel):** IQRPG, Manarion, Pendoria, Queslar.

---

## 1. Tech stack and repo structure

- **Backend:** Node.js + TypeScript, single process (v1).
- **Frontend:** React + TypeScript.
- **Database:** PostgreSQL — the **single source of truth**.
- **No Redis (v1).** Real-time modules (market engine, boss state, chat buffer) run in single-process memory; but each of these must sit behind an interface so that a later move to multi-process + Redis pub/sub does not require rewriting game logic.
- **Monorepo:** pnpm workspaces.
  - `packages/shared` — TypeScript types, formula functions, and the **type definitions** of balance constants. Both server and client read from here. Formulas are written once: the server runs them authoritatively, the client uses the same formula for smooth optimistic UI prediction.
  - `apps/server` — backend.
  - `apps/web` — React frontend.
- **Migration tooling:** Use a SQL migration tool (e.g. `node-pg-migrate` or `drizzle-kit`). All schema changes go through migration files.

---

## 2. Core architectural principles (binding)

These principles govern all subsystems. None may be violated.

1. **Postgres is the single source of truth.** All authoritative state lives in Postgres. No persistent/authoritative data is held in memory — memory holds only: per-tick scratch, the chat ring buffer (cache), the config snapshot (cache), and websocket connections. All of these are rebuildable from Postgres.

2. **Each tick = one atomic transaction.** Every iteration of the tick loop commits inside a single Postgres transaction. All-or-nothing. The world is therefore always exactly at a tick boundary, never at a "half tick".

3. **Crash resilience.** If the server crashes, at most one uncommitted tick is lost (≤6 seconds). On startup, the last committed state is read from `world_state` and execution resumes from there.

4. **Freeze on downtime.** Progress is driven by counters in `world_state`, not by wall-clock time. While the server is down nothing advances; when it comes back it resumes where it left off. Downtime is not "fast-forwarded". This applies to **all** timed systems: actions, the world boss timer, and housing upgrade timers included.

5. **Config / state separation.** Game-design knobs (config) and player progress (state) live in separate tables with separate lifecycles. See Section 4.

6. **Single heartbeat.** All timed systems hang off one tick loop. No scattered `setInterval`s.

7. **Data-driven design.** Activities, monsters, housing features, drop tables, and curve constants are **data**, not constants baked into code. Adding content means adding rows, not changing code.

---

## 3. Data model

The following tables will be created. Types are for PostgreSQL. `BIGINT GENERATED ALWAYS AS IDENTITY` is the default for primary keys. Apply appropriate `CHECK` constraints on all monetary/numeric fields.

### 3.1 Enums
- `market_side` = ('buy', 'sell')
- `order_status` = ('open', 'partial', 'filled', 'cancelled')
- `boss_status` = ('active', 'defeated', 'expired')
- `activity_archetype` = ('transform', 'combat')
- `upgrade_status` = ('in_progress', 'completed', 'cancelled')

### 3.2 Config / reference tables (edited by admins)
- **`skills`** — `id` (SMALLINT PK), `code` (UNIQUE), `name`.
- **`items`** — `id` (INTEGER PK), `code` (UNIQUE), `name`, `tradable` (BOOL), and equipment fields (NULL for non-equippable items like raw materials/potions): `equip_slot` (TEXT: 'weapon' | 'armor' | 'tool' | 'accessory'), `base_stats` (JSONB: the stat lines this type carries, e.g. `{str:10, dex:4}` or `{gather_yield:0.1}`), `req_level` (equip requirement), `salvage_yield` (JSONB: materials returned on salvage, scaled by quality). The per-stat roll *band* comes from the instance's `rarity` (see `rarities`), not from the item type.
- **`activities`** — the activity *types* (verbs only): `id`, `code` (UNIQUE), `name`, `skill_id` (FK skills), `archetype` (activity_archetype). An activity is a verb (`mine`, `quarry`, `hunt`, `craft`, `brew`, `battle`). It carries no inputs/outputs itself; the specific thing produced/fought lives in `recipes` (transform) or `monsters` (combat).
- **`recipes`** — transform targets (one row per producible thing): `id`, `activity_id` (FK activities), `code` (UNIQUE), `name`, `req_level`, `base_xp`, `inputs` (JSONB: `[{item, qty}]`, `[]` for gathering), `outputs` (JSONB: `[{item, qty, chance}]`). The output item and all its production details live here. E.g. activity `craft` has recipes `sword`, `armor`; `brew` has `power_potion`, `yield_potion`; `mine` has `ore`.
- **`monsters`** — combat targets, selected by `battle` + `monster_id`: `id` (INTEGER PK), `tier` (difficulty grouping), `name`, `hp` (damage needed to kill), `attack` (damage per round it deals), `accuracy`, `evasion`, `xp`, `gold_min`, `gold_max`, `loot` (JSONB drop table: `[{item, qty, chance}]`).
- **`housing_features`** — `id` (SMALLINT PK), `code` (UNIQUE), `name`, `bonus_type` (TEXT: which formula it affects, e.g. 'gather_yield', 'rare_drop', 'combat_all'), `max_level`, and curve constants: `cost_base`, `cost_growth`, `duration_base`, `duration_growth`, `bonus_base`, `bonus_growth`, `cost_resources` (JSONB: which resource types are required).
- **`global_boosts`** — catalog of available global boosts (kept separate from potions): `id`, `code` (UNIQUE), `name`, `effect_type` (TEXT: e.g. 'xp', 'gather_yield', 'combat_str', 'rare_drop'), `magnitude` (NUMERIC), `duration_seconds` (NULL = permanent), `default_source` (TEXT: 'token' | 'event' | 'world_boss'). Granting one to a player creates a row in `player_active_effects` (runtime) and a row in `global_boost_log` (audit).
- **`rarities`** — equipment rarity tiers (common → mythic): `tier` (TEXT PK or ordered `id`), `name`, `weight` (relative base chance in the rarity roll), `roll_min`, `roll_max` (the per-stat multiplier band for this tier), `color` (UI). The rarity roll picks a tier by weight; `rarity_luck_shift` / `rarity_quality_shift` (config) bound how far LUCK (on drops) or craft_quality (on crafts) re-weight it upward. Then each stat rolls within `[roll_min, roll_max]`. This is distinct from `pRare` (which governs whether an *activity* yields a rare output at all).
- **`game_config`** — key-value store for scalar knobs: `key` (TEXT PK), `value` (JSONB), `description`. Examples: `xp_curve` = `{B:60, p:1.4}`, `yield_slope` = `0.02`, `rare` = `{base:0.005, step:0.0005, cap:0.10}` (deliberately scarce — see §8), `crit_multiplier` = `2`, `cancel_penalty` = `0.15`, `outage_threshold_seconds` = `30`, `market_fee` = `0`, `tick_seconds` = `6`, `max_rounds` = `200` (per-fight round cap), `combat_coeffs` = `{ dmg_per_str, hp_per_vit, mitigation_per_def, dodge_per_eva, accuracy_per_dex, crit_per_dex, crit_per_luck }` (how stats map to duel values), `rarity_luck_shift` (bounded: how much effective LUCK re-weights the rarity roll upward on drops), `rarity_quality_shift` (bounded: how much effective craft_quality re-weights it upward on crafts), `stat_per_level` = `{ strength:2, vitality:2, defense:1, evasion:1, dexterity:1, luck:1 }` (base-stat points granted per combat level-up), `random_stat_gain_chance` = `0.002` (low chance per battle action to gain a random base-stat point).
- **`config_audit`** — audit trail for config changes: `id`, `table_name`, `key_or_id`, `old_value` (JSONB), `new_value` (JSONB), `changed_by`, `changed_at`. Every config UPDATE is recorded here (for rollback/review).

### 3.3 State tables (written by gameplay)
- **`players`** — `id`, `username` (UNIQUE), `password_hash`, `gold`, `tokens` (premium currency), `actions_remaining`, `max_actions` (DEFAULT 1800; raised via upgrades/tokens), `active_recipe_id` (FK recipes, NULLABLE), `active_monster_id` (FK monsters, NULLABLE), base combat stats `str`, `vit`, `def`, `eva`, `dex`, `luck` (INTEGER, starting values from seed), `created_at`, `last_seen_at`. These six are the *base* stats; effective stats = base + equipment + active effects + housing (Section 8). The current selection is exactly one of `active_recipe_id` (transform) or `active_monster_id` (combat); both NULL = idle. Add a `CHECK` ensuring they are not both set.
  - **Partial index (critical):** `CREATE INDEX idx_players_active ON players (id) WHERE actions_remaining > 0 AND (active_recipe_id IS NOT NULL OR active_monster_id IS NOT NULL);` — the tick loop's "active set".
- **`player_skills`** — PK (`player_id`, `skill_id`), `level`, `xp`.
- **`inventory`** — PK (`player_id`, `item_id`), `qty` (CHECK >= 0). Holds **stackable** items only (raw materials, potions, monster drops). Equippable gear is never stacked — it lives in `item_instances`.
- **`item_instances`** — per-instance equipment (each crafted piece is unique). Kept minimal: `id` (BIGINT PK), `item_id` (FK items — the type), `owner_id` (FK players, **indexed**), `rarity` (FK rarities), `rolls` (JSONB: per-stat roll multipliers, only the stats this type has, e.g. `{str:1.32, dex:0.91}`, each within the rarity's band), `created_at`. Effective stat value = `items.base_stats[S] × rolls[S]`, derived on read (base stats live in config, not duplicated per row → row stays ~tens of bytes). Index `owner_id` (and optionally `(owner_id, item_id)`); a per-player query is microseconds regardless of total table size.
  - **Re-roll ready:** the future "re-roll with materials" mechanic is a single `UPDATE item_instances SET rolls = …` — this is why rolls are per-stat.
- **`player_equipment`** — equipped slots: PK (`player_id`, `slot`), `instance_id` (FK item_instances). One instance per slot. The instance must be owned by the player and not listed for sale.
- **`instance_listings`** — auction-style market for unique gear (the fungible order book can't hold non-fungible instances): `id`, `instance_id` (FK item_instances, UNIQUE while active), `seller_id` (FK), `price` (CHECK > 0), `status` ('active' | 'sold' | 'cancelled'), `idem_key` (UNIQUE), `created_at`. Buying transfers instance ownership + gold atomically (one transaction, row-locked).
- **`player_housing`** — PK (`player_id`, `feature_id`), `level` (completed level). Holds only completed levels.
- **`housing_upgrade_jobs`** — active/historical upgrade jobs: `id`, `player_id`, `feature_id`, `target_level`, `started_at` (timestamptz, for UI), `start_live` (BIGINT, live-clock value), `completes_live` (BIGINT, live-clock value), `paid_snapshot` (JSONB: the gold + resources actually charged at start — refunds are computed from this), `status` (upgrade_status).
  - **Partial unique index (critical):** `CREATE UNIQUE INDEX uniq_active_upgrade ON housing_upgrade_jobs (player_id) WHERE status = 'in_progress';` — guarantees at most one active upgrade per player.
  - **Completion index:** index on `completes_live`.
- **`world_state`** — singleton row (`id BOOLEAN PK DEFAULT TRUE CHECK (id)`): `tick_number` (BIGINT), `last_tick_at` (timestamptz), `uptime_seconds` (BIGINT — the "live clock"; a seconds counter that only advances while the server is up; housing timers are measured against this).
- **`world_boss`** — `id`, `tier`, `hp`, `max_hp`, `started_tick`, `ends_tick`, `status` (boss_status).
- **`world_boss_participants`** — PK (`boss_id`, `player_id`), `joined_tick`, `total_damage`.
- **`market_orders`** — `id`, `player_id` (FK), `side`, `item_id` (FK), `price` (CHECK > 0), `qty_total`, `qty_remaining` (CHECK >= 0), `status`, `idem_key` (UNIQUE — retry safety), `created_at`.
  - **Matching index:** `CREATE INDEX idx_orders_match ON market_orders (item_id, side, price, created_at) WHERE status IN ('open','partial');`
- **`trades`** — `id`, `item_id`, `buy_order_id` (FK), `sell_order_id` (FK), `qty`, `price`, `created_at`.
- **`chat_messages`** — `id`, `channel`, `player_id` (FK), `body`, `created_at`. Index: (`channel`, `created_at DESC`).
- **`player_active_effects`** — unified runtime modifiers (covers BOTH consumed potions and granted global boosts): `id`, `player_id` (FK), `effect_type` (TEXT: 'xp' | 'gather_yield' | 'combat_str' | 'rare_drop' | 'craft_quality' | …), `magnitude` (NUMERIC), `source` (TEXT: 'potion' | 'token' | 'event' | 'world_boss'), `source_ref` (TEXT: item code / boost code), `expires_live` (BIGINT live-clock value, NULL = permanent), `stacking` (TEXT: 'sum' | 'highest' | 'unique'), `created_at`. The formula layer sums/selects applicable effects when computing effective stats and effective yield/rare/quality. Index on `(player_id)` (optionally partial on not-yet-expired).
- **`global_boost_log`** — admin-reviewable audit of every global-boost grant: `id`, `player_id` (FK), `boost_code`, `effect_type`, `magnitude`, `source`, `granted_at`, `expires_live`. Written whenever a global boost is granted (in addition to the `player_active_effects` row). Lets you review who received which boost, when, and from what source.

---

## 4. Configurability system (high priority)

Goal: every world setting (drops, rates, curve constants, housing costs/durations, penalty rate, etc.) must be tunable **live**, **without restarting the server**, **without rebuilding**, and **without touching anything else**.

Mechanism:
1. All tunable values live in the config tables from Section 3.2 (data, not baked into the binary → no rebuild needed).
2. On startup the server loads all config into memory as a single **immutable snapshot object**. Game logic reads from this snapshot (never from the DB on every call, never from hardcoded constants).
3. When a config row is UPDATEd, Postgres **`LISTEN/NOTIFY`** signals the server that config changed (channel e.g. `config_changed`). The server listens and reloads the snapshot from the DB.
4. The snapshot is swapped via an **atomic reference change** — a tick never sees half-updated config. (During reload the new snapshot is fully built, then activated with a single assignment.)
5. **Validation:** Every config write passes bounds checks before commit (e.g. probabilities in 0–1, costs ≥ 0, growth constants within a sane range). Invalid values are rejected.
6. **Audit:** Every config change is written to `config_audit` (who, when, old/new value).

Acceptance: On a running server, updating a `game_config` row (passing validation) must take effect in the tick loop within a few seconds; no restart/rebuild required; no other config affected.

---

## 5. Live clock (for housing timers)

Housing upgrades need second-precise durations (e.g. "6h 13m 47s") **and** must freeze on downtime. The "live clock" provides this:

- `world_state.uptime_seconds` = a seconds counter that advances only while the server is up.
- Each tick, measure real elapsed time: `delta = now() - last_tick_at`.
  - If `delta <= outage_threshold_seconds` (normal operation): `uptime_seconds += delta`.
  - If `delta > outage_threshold_seconds` (outage detected): `uptime_seconds += tick_seconds` (only the normal interval); the excess is **frozen** (not added).
- Update `last_tick_at = now()`.
- `outage_threshold_seconds` is a `game_config` knob.

Result: `uptime_seconds` equals the server's true uptime, at second precision, excluding downtime. Housing jobs are stored against this scale (`start_live`, `completes_live`).

Example: a 2-hour upgrade starts; 1 hour later the server crashes, stays down 1 hour, then comes back. On startup the large gap is treated as an outage, not added to `uptime_seconds`; the upgrade resumes where it left off (1 hour remaining).

---

## 6. Tick loop (core)

Every `tick_seconds` (default 6s), inside one atomic transaction:

```
TICK:
  BEGIN
    1. Read world_state (FOR UPDATE). Update tick_number and uptime_seconds per Section 5.
    2. ACTIONS: fetch the active set
       SELECT ... FROM players WHERE actions_remaining > 0
         AND (active_recipe_id IS NOT NULL OR active_monster_id IS NOT NULL) FOR UPDATE
       For each player: if active_recipe_id is set → transform handler on that recipe;
       if active_monster_id is set → combat handler on that monster (Section 7).
       actions_remaining--. Bulk UPDATE + necessary INSERTs (e.g. inventory).
    3. WORLD BOSS: if a boss is active, process participants (Section 9). Write boss state.
    4. HOUSING COMPLETION: via the indexed query, fetch jobs where completes_live <= uptime_seconds
       AND status='in_progress'; apply each (player_housing.level = target_level, job.status='completed',
       free the slot). (Usually 0 or a few rows.)
    5. tick_number++, write world_state.
  COMMIT
```

Rules:
- **No slow async I/O inside the tick transaction.** Only pure CPU (RNG, computation) between SELECT and UPDATE. Locks are held briefly.
- In v1 the active set is processed in one transaction (ms-scale for 1000 players). If it grows very large, chunking is a future lever; not for v1.
- **Offline progress:** Online/offline does not affect processing. Everyone with `actions_remaining > 0` and a recipe or monster selected is processed. Online/offline only determines whether a websocket update is sent.
- **Action refresh:** When the player clicks the action bar, a separate endpoint sets `actions_remaining = max_actions` (full refill). This is not part of the tick loop.

Acceptance: When the server is killed and restarted, the world must resume from the last committed tick; downtime must not be fast-forwarded; an offline player with banked actions must have their actions processed down to 0.

---

## 7. Actions and archetypes

The six verbs reduce to two archetypes. The tick loop is a thin dispatcher: read the player's selected target (a recipe or a monster) → call the matching archetype handler.

### 7.1 Transform archetype (gathering + production)
Verbs: `mine`, `quarry`, `hunt`, `craft`, `brew`. The player selects a specific **recipe** under a verb (e.g. `craft`→`sword`, `brew`→`power_potion`, `mine`→`ore`); the handler reads that recipe's `inputs`/`outputs`/`base_xp`/`req_level`.
- Gathering = a recipe with empty `inputs`.
- Per action: check the recipe's `req_level` → are `inputs` available? (if not, the activity stalls) → consume → roll `outputs` (each output by its own `chance`, including rare drops) → add → grant `base_xp` → level up if needed.
- Output quantity scales with level (Section 8 `yieldMult`).
- **Equippable outputs create an instance, not a stack.** If a recipe's output item has an `equip_slot`, the handler does NOT increment `inventory`; it inserts an `item_instances` row. Creation order: (1) **roll rarity** — a weighted pick over `rarities`, re-weighted upward (bounded by `rarity_quality_shift`) by the crafter's effective `craft_quality` (Crafting level + workshop housing + active effects); (2) **roll per-stat multipliers** within the chosen rarity's `[roll_min, roll_max]` band. So a high-`craft_quality` crafter sees more uncommon/rare/unique pieces (mythic stays extremely scarce), and within a tier the stats land high — that quality gap is what makes crafted gear market-valuable. Non-equippable outputs (potions, refined materials) stack in `inventory` as normal.

### 7.2 Combat archetype (Battling)
- Verb: `battle`. The player selects a **monster** (`active_monster_id`); the handler reads that `monsters` row.
- **No stamina/food consumption.** Combat consumes nothing.
- **Each 6s action = one full fight, resolved as an internal multi-round duel.** This preserves per-action full resolution: the monster is fully fought within the action and HP does NOT persist between actions — every action fights the monster fresh, at full HP. "Rounds" and HP live inside the single action.
  1. Player fight-HP is set from effective VIT (resets every action).
  2. Rounds repeat until one side's HP reaches 0, or `max_rounds` (config) is hit:
     - Player round: deals damage = f(effective STR); landing gated by accuracy (effective DEX vs monster `evasion`); crit chance from effective DEX+LUCK applies `crit_multiplier` to that round's damage.
     - Monster round: deals damage = f(`monster.attack`), mitigated by effective DEF; dodged with a chance from effective EVA (vs `monster.accuracy`).
  3. Outcome: win if monster HP hits 0 first; loss if player HP hits 0 first (or `max_rounds` reached without a kill).
  4. Rewards: win → `monster.xp` + gold (`gold_min..gold_max`) + loot rolls from `monster.loot`. When a dropped item is **equippable**, its `item_instances` row is created with a **rarity roll nudged upward by effective LUCK** (bounded by `rarity_luck_shift`) — LUCK helps you *find rarer* gear, not more of it. Stackable loot (materials) drops at its listed `chance`, unaffected by LUCK. Loss → **no XP and no rewards** (0).
  5. **Result summary** (returned to the client over websocket; the round-by-round log is NOT persisted): `{ rounds, damage_dealt, damage_taken, won, crit_count, gold, xp, loot }`. The battle UI shows the player HP bar and lines such as "You dealt 1,382,239 damage in 12 rounds" / "You took 789,322 damage in 12 rounds."
- **Base-stat gains from combat:** on a combat-skill level-up, grant base-stat points per `stat_per_level` (config distribution). Additionally, each battle action has a low `random_stat_gain_chance` to grant one random base-stat point. (Equipment/potion/global add on top as *effective* bonuses, not permanent base gains.)
- **Cost:** a duel of up to `max_rounds` per battling player per tick; sub-ms for 1000 players. `max_rounds` bounds compute and resolves stalemates as a loss.

Monster values (`hp`, `attack`, `accuracy`, `evasion`, `xp`, `gold`, `loot`) live in the `monsters` table (data). New monster = new row; `tier` just groups them by difficulty.

---

## 8. Formula / balance layer (`packages/shared`)

Formula **functions** live in `packages/shared`; **numeric constants** live in `game_config` (live-tunable). Functions take the constants from the config snapshot as parameters.

- **Level curve (no cap):** `xpToNext(L) = round(B * L^p)`. XP per action is flat per activity; per-level cost grows polynomially → leveling gradually takes a bit longer. Defaults `B=60, p=1.4`, xp/action ≈ 10. **There is no max level.**
- **Effective stat / effective modifier:** the unifying shape for both domains. For any combat stat `S`: `effectiveS = baseS + equipment(S) + activeEffects(S) + housing(S)`, where `equipment(S)` = sum over equipped instances of `items.base_stats[S] × rolls[S]`. There is no single scalar "combat power" — each effective stat (STR/VIT/DEF/EVA/DEX/LUCK) feeds the duel (Section 7.2) distinctly. Production has no base stats; its base is the skill level, modified the same way (a `tool`'s `base_stats` carries production lines like `gather_yield`).
- **Output scaling (production):** `yieldMult(L) = 1 + L * yield_slope` (default slope 0.02 → 2× at L50, 3× at L100), then multiplied by `(1 + equipment + activeEffects + housing + global)` gather bonuses.
- **Rare drop (`pRare`):** `pRare(L) = min(rare.cap, rare.base + L * rare.step)` — deliberately scarce: default `base 0.005, step 0.0005, cap 0.10`, so even at high level + treasury housing the chance of an activity yielding a rare output stays low (the cap is the hard limiter). Housing `rare_drop` and active effects add in, still capped. **This is distinct from item `rarity`:** `pRare` decides *whether an activity produces a rare output at all*; `rarity` (common→mythic) is the *quality tier of an equipment instance*. LUCK affects `rarity` (on drops), not `pRare`.
- **Active effects (potions + global boosts):** read from `player_active_effects`; expired rows (`expires_live <= uptime_seconds`) are ignored. Combined per `stacking` rule (sum / highest / unique). This is the single source feeding both `activeEffects(S)` above and production modifiers.
- **Housing bonus curve:** `housingBonus(feature, level) = bonus_base + level * bonus_growth` (config per feature).

Domain summary: **combat** base = the six stats; **production** (gather/craft/alch) base = skill level. Both are then modified by the same four sources — equipment, active effects (potions/global), and housing.

These functions are used both on the server (authoritative) and the client (smooth prediction) — hence they live in `shared`.

---

## 9. World boss

- Processed inside the tick loop, in the same transaction, as a separate logic block.
- **Per-player RNG:** Each tick, roll per participant (damage + crit). Apply damage to the boss; update `world_boss_participants.total_damage`.
- Boss state (`hp`, `tier`, `started_tick`, `ends_tick`, `status`) is written **durably** every tick.
- If the boss dies: `tier++`, `hp = max_hp` (refill), the event continues. Event window ~15 minutes (tick-based: `ends_tick`; freezes on downtime). When the window ends, `status='expired'`, rewards distributed by `total_damage`.
- When a player joins the boss, their normal action is unaffected; the two run in parallel.
- The boss tick is per-player, not aggregate; 1000 participants × tick is microsecond-scale, no problem.

---

## 10. Market (bulletproof, event-driven)

Runs **outside** the tick loop, event-driven. The design makes double-spend impossible and guarantees "first come, first served".

1. **Ordering:** All market orders pass through a single **sequential async queue** (FIFO) → deterministic "first in, first processed". (This queue sits behind an interface; it can later be replaced with a Redis-based sequencer for multi-process.)
2. **Atomicity:** Each order is processed in its own Postgres transaction. The matching counter-orders and the player's gold/inventory are locked with `SELECT ... FOR UPDATE`.
3. **Matching:** Price-time priority (`idx_orders_match`). Each fill atomically: debit the buyer's gold, credit the seller, transfer inventory, update `qty_remaining`, write a row to `trades`.
4. **The losing user:** Is processed but, if nothing remains to match, receives a **definitive error/rejection** (0 fills / "no longer available"). Never silently dropped.
5. **Idempotency:** A unique `idem_key` per order request. No duplication on retry.
6. **Persistence:** Orders and trades live in Postgres. Matching is done in-DB (no in-memory order book in v1; added later as an optimization if volume demands).

**Two market modes.** The order book above is for **stackable, fungible** items (raw materials, potions, monster drops — 100 ore are interchangeable). **Equipment is non-fungible** (each instance has unique rolls) and cannot enter a fungible order book; it sells via **`instance_listings`** (auction-style, qty always 1, one specific instance at a fixed price). Buying a listing is a single atomic transaction: lock the instance + buyer gold, transfer ownership, pay the seller, mark the listing `sold`. Idempotency key applies here too. An equipped or already-listed instance cannot be re-listed.

Acceptance: If two buy orders for the same single remaining unit arrive ~50ms apart, the first fills and the second gets a definitive error; under no condition is the item transferred twice (a concurrency test must be written). The same no-double-spend guarantee holds for `instance_listings` (a listing can be bought by at most one buyer).

### 10.1 Salvage / disenchant (the instance sink)
- A player can salvage an owned, un-equipped, un-listed `item_instances` row: an instant atomic transaction → grant materials from the item type's `salvage_yield` (scaled by the instance's quality, i.e. its rolls) → **delete the instance row**.
- This is the sink that bounds `item_instances` growth: without it the table grows forever. With it, the row count tracks "gear players actually keep". Recommended pattern: when a craft produces an instance, the UI offers "keep or salvage now", so junk gear never becomes a persisted row.
- Salvage is a resource source feeding crafting/housing and (later) the re-roll mechanic — keeping crafted-material demand alive.

---

## 11. Chat

- Websocket rooms + pub/sub. Rate-limiting applied.
- **Every message is written to Postgres (`chat_messages`)** (persistent record for moderation/reports).
- Memory holds only a per-channel "last N messages" ring buffer (a cache for speed; if lost, rebuilt from Postgres).
- A newly connecting player gets the last N messages quickly from the buffer.

---

## 12. Housing

### 12.1 Structure
- Every player has a house (1:1, `player_housing`). The house contains several upgradeable features (`housing_features`), each granting a permanent, personal bonus.
- Example features: Mine shaft (+ore/stone yield), Pantry (+food yield), Workshop (+craft quality), Treasury (+rare drop chance), Training hall (+combat power). All defined in config.
- Bonuses become permanent inputs to the formula layer (`yieldMult`, `pRare`, and effective combat stats include the housing bonus per `bonus_type`).
- **There is a max level** (per feature), but the cumulative cost + duration make reaching max a long-term goal.

### 12.2 Upgrade = resource spend, NOT a tick action
- Clicking "upgrade" is an instant operation (does not draw from the action pool).
- Cost is paid **up front**: `cost(level) = cost_base * level^cost_growth` (gold) + `cost_resources` (food/ore/stone, scaling with level). At start, an atomic transaction: check sufficiency → deduct → create the job.
- **Duration:** `duration(level) = duration_base * level^duration_growth` seconds (config constants separate from cost). Grows with level.

### 12.3 Timer = live clock, freezes
- The job stores `start_live` and `completes_live = start_live + duration` (on the live-clock scale, Section 5). Second precision; freezes on downtime.
- Completion is processed in the tick loop (Section 6, step 4): `completes_live <= uptime_seconds`. Additionally a lazy check when the player opens the housing screen (so the UI shows "done" immediately).

### 12.4 One upgrade at a time
- At most **one** active upgrade per player. Guaranteed at the DB level: the `uniq_active_upgrade` partial unique index. Attempting to start a second upgrade is rejected.

### 12.5 Cancellation + penalty
- An in-progress upgrade can be cancelled.
- **The penalty is a fixed config value** (`cancel_penalty`, default 15%). On cancel, `(1 - cancel_penalty)` of what was paid is refunded.
- **Critical:** The refund is computed from the job's `paid_snapshot` (the amounts actually charged at start) — NOT from current config. Because cost config can change live while the upgrade is running; without the snapshot the refund would be wrong or an exploit would arise.
- After cancel: job `status='cancelled'`, level unchanged, slot freed, partial refund issued.

### 12.6 Economic role
- Housing is the game's primary **gold + resource sink**. Because it continually consumes gold + food/ore/stone, it creates persistent buyers for gatherers and battlers; rare drops feed top-tier upgrades. It is the anchor that keeps the economy flowing.

---

## 13. Frontend (summary)

- React + TypeScript. The server is authoritative; the client renders values smoothly with `packages/shared` formulas (ticking action counter, market prices, boss HP bar, housing countdown).
- Housing countdown: the client counts down from the remaining time given by the server; on reconnect it re-syncs with the server.
- Live updates via websocket: active action result, market fills, chat, boss status.
- Do **not** use localStorage/sessionStorage (state flows via server + websocket).

---

## 14. Implementation order (phases)

Do not move to the next phase until the current one is complete and its acceptance criteria verified.

- **Phase 0 — Skeleton:** pnpm monorepo, TS configs, Postgres connection, migration tooling, lint/format, basic CI scripts. Empty `packages/shared` skeleton.
- **Phase 1 — Data model + config system:** All tables (Section 3) via migrations. Config snapshot loading, `LISTEN/NOTIFY` reload, validation, `config_audit`. *Acceptance:* a live config UPDATE takes effect without restart.
- **Phase 2 — Auth + player + scaffolding:** Register/login, player creation (initial skills/housing rows), basic HTTP + websocket server skeleton.
- **Phase 3 — Tick core:** `world_state`, atomic tick transaction, `tick_number`, live clock (Section 5), active-set skeleton (no game logic yet), crash-resume. *Acceptance:* kill/restart → resume from last tick; downtime freezes.
- **Phase 4 — Transform actions + formula layer:** `shared` formulas (`xpToNext`, `yieldMult`, `pRare`), gathering + production, action-refresh endpoint. Equippable recipe outputs create `item_instances` with per-stat rolls (rolls shifted by `craft_quality`). *Acceptance:* an offline player's actions are processed down to 0; output/XP correct; crafting a sword produces an instance with rolled stats.
- **Phase 5 — Combat + base stats + equipment + active effects:** `monsters` config (hp/attack/accuracy/evasion), player base stats + their gains (per-level distribution + low random battle gain), `player_equipment` (equip/unequip), the per-action duel (rounds, fight-HP from VIT, damage dealt/taken, crit, loot, no rewards on loss) returning a result summary for the UI, and the `player_active_effects` mechanism (potions consumed → effects). Effective stats = base + equipment (`base_stats × rolls`) + active effects + housing. *Acceptance:* a battle action returns rounds + damage-dealt/taken; equipping a higher-rolled sword measurably raises damage dealt.
- **Phase 6 — Housing:** `housing_features`, `player_housing`, `housing_upgrade_jobs`, live-clock timers, one-upgrade rule (partial unique index), cancel + penalty (paid_snapshot), integration of bonuses into formulas. *Acceptance:* two concurrent upgrades cannot start; downtime freezes the timer; cancel refunds correctly.
- **Phase 7 — Market + salvage:** Sequential queue, atomic in-DB matching, FOR UPDATE, idempotency (stackable order book); `instance_listings` (auction-style, qty 1) for equipment; salvage/disenchant (instance sink). *Acceptance:* the concurrency test (Section 10) passes; an instance is bought by at most one buyer; salvaging deletes the instance and returns materials.
- **Phase 8 — World boss + global boosts:** Tick-integrated boss (per-player RNG, tier escalation, 15-min window that freezes, reward distribution), plus the `global_boosts` catalog and granting flow (boss rewards / events / token purchases) that creates `player_active_effects` rows and writes `global_boost_log` for admin review.
- **Phase 9 — Chat:** Websocket rooms, persistence, ring buffer, rate-limit.
- **Phase 10 — Frontend:** React UI, smooth values via shared formulas, live websocket updates.

---

## 15. Non-goals (NOT in v1)

- **Guild system** and **Alliance system** — to be added later, with the same config-centric approach. Do not build now, but the data model and config system must not block adding them later.
- Event system (periodic events beyond the world boss) — later.
- Redis / horizontal scale — later (keep the interfaces ready).
- In-memory order book — later (if volume demands).
- Tier-gated activities — none; progression expresses through level-scaled output/quality, it does not unlock new activities.

---

## 16. General acceptance tests (smoke)

1. Server crash → restart → world resumes from the last tick, data loss ≤1 tick.
2. Downtime → housing timer, actions, and boss timer do not fast-forward (they freeze).
3. Live config change → takes effect without restart/rebuild, isolated, audited.
4. Market double-spend impossible (concurrency test).
5. One housing upgrade per player (DB guarantee).
6. Cancel penalty computed correctly from `paid_snapshot` (even if config changes mid-upgrade).
7. An offline player's actions are processed down to 0.
