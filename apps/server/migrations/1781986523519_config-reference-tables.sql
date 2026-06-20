-- Up Migration
-- Enums (SPEC §3.1) and config / reference tables (SPEC §3.2).
-- These hold admin-assigned, data-driven content. Primary keys are explicit
-- (not GENERATED) because the seed assigns stable ids/codes/tiers.

-- ── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE market_side AS ENUM ('buy', 'sell');
CREATE TYPE order_status AS ENUM ('open', 'partial', 'filled', 'cancelled');
CREATE TYPE boss_status AS ENUM ('active', 'defeated', 'expired');
CREATE TYPE activity_archetype AS ENUM ('transform', 'combat');
CREATE TYPE upgrade_status AS ENUM ('in_progress', 'completed', 'cancelled');

-- ── skills ─────────────────────────────────────────────────────────────────
CREATE TABLE skills (
  id   SMALLINT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

-- ── items (types; instance rolls live in item_instances) ───────────────────
CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  tradable      BOOLEAN NOT NULL DEFAULT TRUE,
  -- Equipment fields (NULL for stackable items like materials/potions):
  equip_slot    TEXT CHECK (equip_slot IN ('weapon', 'armor', 'tool', 'accessory')),
  base_stats    JSONB,
  req_level     INTEGER CHECK (req_level >= 1),
  salvage_yield JSONB
);

-- ── rarities (equipment quality tiers; PK is the ordered tier) ─────────────
CREATE TABLE rarities (
  tier     SMALLINT PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  weight   NUMERIC NOT NULL CHECK (weight > 0),
  roll_min NUMERIC NOT NULL CHECK (roll_min >= 0),
  roll_max NUMERIC NOT NULL,
  color    TEXT NOT NULL,
  CONSTRAINT rarities_roll_band CHECK (roll_max >= roll_min)
);

-- ── activities (verbs) ─────────────────────────────────────────────────────
CREATE TABLE activities (
  id        SMALLINT PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  skill_id  SMALLINT NOT NULL REFERENCES skills (id),
  archetype activity_archetype NOT NULL
);

-- ── recipes (transform targets) ────────────────────────────────────────────
CREATE TABLE recipes (
  id          INTEGER PRIMARY KEY,
  activity_id SMALLINT NOT NULL REFERENCES activities (id),
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  req_level   INTEGER NOT NULL DEFAULT 1 CHECK (req_level >= 1),
  base_xp     INTEGER NOT NULL CHECK (base_xp >= 0),
  inputs      JSONB NOT NULL DEFAULT '[]'::jsonb,
  outputs     JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- ── monsters (combat targets) ──────────────────────────────────────────────
CREATE TABLE monsters (
  id       INTEGER PRIMARY KEY,
  tier     SMALLINT NOT NULL,
  name     TEXT NOT NULL,
  hp       BIGINT NOT NULL CHECK (hp > 0),
  attack   BIGINT NOT NULL CHECK (attack >= 0),
  accuracy NUMERIC NOT NULL CHECK (accuracy >= 0),
  evasion  NUMERIC NOT NULL CHECK (evasion >= 0),
  xp       INTEGER NOT NULL CHECK (xp >= 0),
  gold_min INTEGER NOT NULL CHECK (gold_min >= 0),
  gold_max INTEGER NOT NULL,
  loot     JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT monsters_gold_band CHECK (gold_max >= gold_min)
);

-- ── housing_features ───────────────────────────────────────────────────────
CREATE TABLE housing_features (
  id              SMALLINT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  bonus_type      TEXT NOT NULL,
  max_level       INTEGER NOT NULL CHECK (max_level >= 1),
  cost_base       NUMERIC NOT NULL CHECK (cost_base >= 0),
  cost_growth     NUMERIC NOT NULL CHECK (cost_growth >= 0),
  duration_base   NUMERIC NOT NULL CHECK (duration_base >= 0),
  duration_growth NUMERIC NOT NULL CHECK (duration_growth >= 0),
  bonus_base      NUMERIC NOT NULL,
  bonus_growth    NUMERIC NOT NULL,
  cost_resources  JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ── global_boosts (catalog; grants create player_active_effects rows) ──────
CREATE TABLE global_boosts (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  effect_type      TEXT NOT NULL,
  magnitude        NUMERIC NOT NULL,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  default_source   TEXT NOT NULL CHECK (default_source IN ('token', 'event', 'world_boss'))
);

-- ── game_config (scalar knobs) ─────────────────────────────────────────────
CREATE TABLE game_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT
);

-- Down Migration
DROP TABLE IF EXISTS game_config;
DROP TABLE IF EXISTS global_boosts;
DROP TABLE IF EXISTS housing_features;
DROP TABLE IF EXISTS monsters;
DROP TABLE IF EXISTS recipes;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS rarities;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS skills;
DROP TYPE IF EXISTS upgrade_status;
DROP TYPE IF EXISTS activity_archetype;
DROP TYPE IF EXISTS boss_status;
DROP TYPE IF EXISTS order_status;
DROP TYPE IF EXISTS market_side;
