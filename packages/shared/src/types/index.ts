// Shared TypeScript types for the config / reference tables (SPEC §3.2).
// Both server and client read content from these shapes. JSONB columns are
// typed here; NUMERIC/BIGINT columns are represented as `number` (the loader
// parses the pg string form into numbers).

export type EquipSlot = 'weapon' | 'armor' | 'tool' | 'accessory';
export type ActivityArchetype = 'transform' | 'combat';
export type BoostSource = 'token' | 'event' | 'world_boss';

export interface Skill {
  id: number;
  code: string;
  name: string;
}

export interface Item {
  id: number;
  code: string;
  name: string;
  tradable: boolean;
  equip_slot: EquipSlot | null;
  base_stats: Record<string, number> | null;
  req_level: number | null;
  salvage_yield: Record<string, number> | null;
}

export interface Rarity {
  tier: number;
  code: string;
  name: string;
  weight: number;
  roll_min: number;
  roll_max: number;
  color: string;
}

export interface Activity {
  id: number;
  code: string;
  name: string;
  skill_id: number;
  archetype: ActivityArchetype;
}

/** Recipe input/output entry. Inputs omit `chance`; outputs carry it. */
export interface RecipeIO {
  item: string;
  qty: number;
  chance?: number;
}

export interface Recipe {
  id: number;
  activity_id: number;
  code: string;
  name: string;
  req_level: number;
  base_xp: number;
  inputs: RecipeIO[];
  outputs: RecipeIO[];
}

export interface LootEntry {
  item: string;
  qty?: number;
  chance: number;
}

export interface Monster {
  id: number;
  tier: number;
  name: string;
  hp: number;
  attack: number;
  accuracy: number;
  evasion: number;
  xp: number;
  gold_min: number;
  gold_max: number;
  loot: LootEntry[];
}

export interface HousingFeature {
  id: number;
  code: string;
  name: string;
  bonus_type: string;
  max_level: number;
  cost_base: number;
  cost_growth: number;
  duration_base: number;
  duration_growth: number;
  bonus_base: number;
  bonus_growth: number;
  cost_resources: Record<string, number>;
}

export interface GlobalBoost {
  id: number;
  code: string;
  name: string;
  effect_type: string;
  magnitude: number;
  duration_seconds: number | null;
  default_source: BoostSource;
}

// ── Player-facing DTOs ───────────────────────────────────────────────────────

/** The six base combat stats (SPEC §3.3). */
export interface PlayerStats {
  str: number;
  vit: number;
  def: number;
  eva: number;
  dex: number;
  luck: number;
}

export interface SkillProgress {
  code: string;
  level: number;
  xp: number;
}

export interface HousingProgress {
  code: string;
  level: number;
}

/** What the client gets for "the current player" (GET /me, auth responses). */
export interface PlayerSummary {
  id: number;
  username: string;
  gold: number;
  tokens: number;
  actions_remaining: number;
  max_actions: number;
  stats: PlayerStats;
  skills: SkillProgress[];
  housing: HousingProgress[];
}

/** JWT claims carried in the auth token. */
export interface AuthTokenPayload {
  playerId: number;
  username: string;
}

/** Response body for register/login. The access + refresh tokens are delivered
 *  as httpOnly cookies (not in the body), so only the player is returned. */
export interface AuthResponse {
  player: PlayerSummary;
}
