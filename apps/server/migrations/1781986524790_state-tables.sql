-- Up Migration
-- State tables (SPEC §3.3) — written by gameplay. Surrogate PKs use
-- BIGINT GENERATED ALWAYS AS IDENTITY per SPEC §3. Monetary/quantity fields
-- carry CHECK constraints. Critical indexes from the spec are created here.

-- ── players ────────────────────────────────────────────────────────────────
CREATE TABLE players (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  gold              BIGINT NOT NULL DEFAULT 0 CHECK (gold >= 0),
  tokens            BIGINT NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  actions_remaining INTEGER NOT NULL DEFAULT 0 CHECK (actions_remaining >= 0),
  max_actions       INTEGER NOT NULL DEFAULT 1800 CHECK (max_actions >= 0),
  active_recipe_id  INTEGER REFERENCES recipes (id),
  active_monster_id INTEGER REFERENCES monsters (id),
  str               INTEGER NOT NULL DEFAULT 5 CHECK (str >= 0),
  vit               INTEGER NOT NULL DEFAULT 5 CHECK (vit >= 0),
  def               INTEGER NOT NULL DEFAULT 5 CHECK (def >= 0),
  eva               INTEGER NOT NULL DEFAULT 5 CHECK (eva >= 0),
  dex               INTEGER NOT NULL DEFAULT 5 CHECK (dex >= 0),
  luck              INTEGER NOT NULL DEFAULT 5 CHECK (luck >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ,
  -- Exactly one selection (transform XOR combat), or both NULL = idle.
  CONSTRAINT players_single_selection
    CHECK (NOT (active_recipe_id IS NOT NULL AND active_monster_id IS NOT NULL))
);

-- The tick loop's "active set" (SPEC §3.3).
CREATE INDEX idx_players_active ON players (id)
  WHERE actions_remaining > 0
    AND (active_recipe_id IS NOT NULL OR active_monster_id IS NOT NULL);

-- ── player_skills ──────────────────────────────────────────────────────────
CREATE TABLE player_skills (
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  skill_id  SMALLINT NOT NULL REFERENCES skills (id),
  level     INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp        BIGINT NOT NULL DEFAULT 0 CHECK (xp >= 0),
  PRIMARY KEY (player_id, skill_id)
);

-- ── inventory (stackable items only) ───────────────────────────────────────
CREATE TABLE inventory (
  player_id BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES items (id),
  qty       BIGINT NOT NULL CHECK (qty >= 0),
  PRIMARY KEY (player_id, item_id)
);

-- ── item_instances (unique equipment; effective = items.base_stats × rolls) ─
CREATE TABLE item_instances (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items (id),
  owner_id   BIGINT NOT NULL REFERENCES players (id),
  rarity     SMALLINT NOT NULL REFERENCES rarities (tier),
  rolls      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_item_instances_owner ON item_instances (owner_id);
CREATE INDEX idx_item_instances_owner_item ON item_instances (owner_id, item_id);

-- ── player_equipment (one instance per slot) ───────────────────────────────
CREATE TABLE player_equipment (
  player_id   BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  slot        TEXT NOT NULL CHECK (slot IN ('weapon', 'armor', 'tool', 'accessory')),
  instance_id BIGINT NOT NULL REFERENCES item_instances (id),
  PRIMARY KEY (player_id, slot),
  -- An instance can be equipped in at most one slot anywhere.
  CONSTRAINT player_equipment_instance_unique UNIQUE (instance_id)
);

-- ── instance_listings (auction-style market for non-fungible gear) ─────────
CREATE TABLE instance_listings (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instance_id BIGINT NOT NULL REFERENCES item_instances (id),
  seller_id   BIGINT NOT NULL REFERENCES players (id),
  price       BIGINT NOT NULL CHECK (price > 0),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
  idem_key    TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one active listing per instance.
CREATE UNIQUE INDEX uniq_active_listing ON instance_listings (instance_id)
  WHERE status = 'active';

-- ── player_housing (completed levels only) ─────────────────────────────────
CREATE TABLE player_housing (
  player_id  BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  feature_id SMALLINT NOT NULL REFERENCES housing_features (id),
  level      INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  PRIMARY KEY (player_id, feature_id)
);

-- ── housing_upgrade_jobs ───────────────────────────────────────────────────
CREATE TABLE housing_upgrade_jobs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id      BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  feature_id     SMALLINT NOT NULL REFERENCES housing_features (id),
  target_level   INTEGER NOT NULL CHECK (target_level >= 1),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  start_live     BIGINT NOT NULL,
  completes_live BIGINT NOT NULL,
  paid_snapshot  JSONB NOT NULL,
  status         upgrade_status NOT NULL DEFAULT 'in_progress'
);
-- At most one active upgrade per player (DB-level guarantee, SPEC §12.4).
CREATE UNIQUE INDEX uniq_active_upgrade ON housing_upgrade_jobs (player_id)
  WHERE status = 'in_progress';
CREATE INDEX idx_upgrade_completes ON housing_upgrade_jobs (completes_live)
  WHERE status = 'in_progress';

-- ── world_state (singleton; the live clock) ────────────────────────────────
CREATE TABLE world_state (
  id             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  tick_number    BIGINT NOT NULL DEFAULT 0,
  last_tick_at   TIMESTAMPTZ,
  uptime_seconds BIGINT NOT NULL DEFAULT 0
);

-- ── world_boss ─────────────────────────────────────────────────────────────
CREATE TABLE world_boss (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tier         SMALLINT NOT NULL,
  hp           BIGINT NOT NULL CHECK (hp >= 0),
  max_hp       BIGINT NOT NULL CHECK (max_hp > 0),
  started_tick BIGINT NOT NULL,
  ends_tick    BIGINT NOT NULL,
  status       boss_status NOT NULL DEFAULT 'active'
);

CREATE TABLE world_boss_participants (
  boss_id      BIGINT NOT NULL REFERENCES world_boss (id) ON DELETE CASCADE,
  player_id    BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  joined_tick  BIGINT NOT NULL,
  total_damage BIGINT NOT NULL DEFAULT 0 CHECK (total_damage >= 0),
  PRIMARY KEY (boss_id, player_id)
);

-- ── market_orders ──────────────────────────────────────────────────────────
CREATE TABLE market_orders (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id     BIGINT NOT NULL REFERENCES players (id),
  side          market_side NOT NULL,
  item_id       INTEGER NOT NULL REFERENCES items (id),
  price         BIGINT NOT NULL CHECK (price > 0),
  qty_total     BIGINT NOT NULL CHECK (qty_total > 0),
  qty_remaining BIGINT NOT NULL CHECK (qty_remaining >= 0),
  status        order_status NOT NULL DEFAULT 'open',
  idem_key      TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Price-time priority matching (SPEC §10).
CREATE INDEX idx_orders_match ON market_orders (item_id, side, price, created_at)
  WHERE status IN ('open', 'partial');

-- ── trades ─────────────────────────────────────────────────────────────────
CREATE TABLE trades (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES items (id),
  buy_order_id  BIGINT NOT NULL REFERENCES market_orders (id),
  sell_order_id BIGINT NOT NULL REFERENCES market_orders (id),
  qty           BIGINT NOT NULL CHECK (qty > 0),
  price         BIGINT NOT NULL CHECK (price > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── chat_messages ──────────────────────────────────────────────────────────
CREATE TABLE chat_messages (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel    TEXT NOT NULL,
  player_id  BIGINT REFERENCES players (id),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_channel_time ON chat_messages (channel, created_at DESC);

-- ── player_active_effects (unified potions + global boosts) ────────────────
CREATE TABLE player_active_effects (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  effect_type  TEXT NOT NULL,
  magnitude    NUMERIC NOT NULL,
  source       TEXT NOT NULL,
  source_ref   TEXT,
  expires_live BIGINT,
  stacking     TEXT NOT NULL CHECK (stacking IN ('sum', 'highest', 'unique')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_active_effects_player ON player_active_effects (player_id);

-- ── global_boost_log (admin audit of grants) ───────────────────────────────
CREATE TABLE global_boost_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    BIGINT NOT NULL REFERENCES players (id),
  boost_code   TEXT NOT NULL,
  effect_type  TEXT NOT NULL,
  magnitude    NUMERIC NOT NULL,
  source       TEXT NOT NULL,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_live BIGINT
);

-- Down Migration
DROP TABLE IF EXISTS global_boost_log;
DROP TABLE IF EXISTS player_active_effects;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS trades;
DROP TABLE IF EXISTS market_orders;
DROP TABLE IF EXISTS world_boss_participants;
DROP TABLE IF EXISTS world_boss;
DROP TABLE IF EXISTS world_state;
DROP TABLE IF EXISTS housing_upgrade_jobs;
DROP TABLE IF EXISTS player_housing;
DROP TABLE IF EXISTS instance_listings;
DROP TABLE IF EXISTS player_equipment;
DROP TABLE IF EXISTS item_instances;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS player_skills;
DROP TABLE IF EXISTS players;
