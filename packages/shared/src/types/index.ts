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

// ── Catalog DTO (GET /config) ────────────────────────────────────────────────
// A read-only projection of the config snapshot the client needs to render
// content and run the shared formulas (smooth prediction, SPEC §13). It carries
// only display + the formula constants — never RNG or authoritative state.

export interface CatalogActivity {
  id: number;
  code: string;
  name: string;
  skill_id: number;
  archetype: ActivityArchetype;
}

export interface CatalogRecipe {
  id: number;
  code: string;
  name: string;
  activity_id: number;
  req_level: number;
  inputs: { item: string; qty: number }[];
  outputs: { item: string; qty: number; chance?: number }[];
}

export interface CatalogMonster {
  id: number;
  name: string;
  tier: number;
  hp: number;
  attack: number;
  xp: number;
  gold_min: number;
  gold_max: number;
}

export interface CatalogItem {
  id: number;
  code: string;
  name: string;
  equip_slot: EquipSlot | null;
  tradable: boolean;
}

export interface CatalogHousing {
  id: number;
  code: string;
  name: string;
  bonus_type: string;
  max_level: number;
}

export interface CatalogRarity {
  tier: number;
  name: string;
  color: string;
}

export interface CatalogBoost {
  code: string;
  name: string;
  effect_type: string;
  magnitude: number;
  duration_seconds: number | null;
  /** Token cost if purchasable, else null. */
  cost: number | null;
}

export interface GameCatalog {
  /** Formula constants the client reuses for smooth prediction (SPEC §8/§13). */
  tick_seconds: number;
  xp_curve: { B: number; p: number };
  xp_per_action: number;
  yield_slope: number;
  rare: { base: number; step: number; cap: number };
  chat: { channels: string[]; max_length: number };
  skills: Skill[];
  activities: CatalogActivity[];
  recipes: CatalogRecipe[];
  monsters: CatalogMonster[];
  items: CatalogItem[];
  housing: CatalogHousing[];
  rarities: CatalogRarity[];
  boosts: CatalogBoost[];
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
  /** The current selection (exactly one set, or both null = idle). SPEC §3.3. */
  active_recipe_id: number | null;
  active_monster_id: number | null;
}

// ── Inventory DTOs (SPEC §3.2) ───────────────────────────────────────────────

/** A stackable holding (materials, potions) from the `inventory` table. */
export interface InventoryStack {
  /** Item code, resolved against the catalog for display. */
  item: string;
  qty: number;
}

/** A unique equipment instance the player owns; `equipped_slot` is set when worn. */
export interface InventoryInstance {
  instance_id: number;
  /** Item code, resolved against the catalog for display. */
  item: string;
  rarity: number;
  rolls: Record<string, number>;
  equipped_slot: EquipSlot | null;
}

/** Everything the player holds: stackables + unique gear (SPEC §3.2). */
export interface InventoryView {
  stacks: InventoryStack[];
  equipment: InventoryInstance[];
}

/** JWT claims carried in the auth token. */
export interface AuthTokenPayload {
  playerId: number;
  username: string;
}

// ── Market DTOs (SPEC §10) ───────────────────────────────────────────────────

export type MarketSide = 'buy' | 'sell';
export type OrderStatus = 'open' | 'partial' | 'filled' | 'cancelled';

export interface Fill {
  qty: number;
  price: number;
  counter_order_id: number;
}

/** Result of placing a fungible order-book order. */
export interface OrderResult {
  order_id: number;
  status: OrderStatus;
  filled_qty: number;
  fills: Fill[];
  /** Gold returned to a taker buy that filled below its limit price. */
  refunded_gold: number;
}

export interface BookLevel {
  price: number;
  qty: number;
}

/** Aggregated order book for one item. */
export interface OrderBook {
  item: string;
  buys: BookLevel[];
  sells: BookLevel[];
}

/** A live auction-style listing for a unique equipment instance. */
export interface Listing {
  id: number;
  instance_id: number;
  item: string;
  rarity: number;
  rolls: Record<string, number>;
  price: number;
  seller_id: number;
}

export interface SalvageResult {
  instance_id: number;
  materials: Record<string, number>;
}

// ── World boss DTO (SPEC §9) ─────────────────────────────────────────────────

export interface BossView {
  active: boolean;
  tier?: number;
  hp?: number;
  max_hp?: number;
  /** Tick when the event window closes (tick-based, freezes on downtime). */
  ends_tick?: number;
  current_tick?: number;
  ticks_remaining?: number;
  participants?: number;
  your_damage?: number;
  joined?: boolean;
}

// ── Chat DTO (SPEC §11) ──────────────────────────────────────────────────────

/** A persisted chat message, as broadcast over Socket.IO and served from the
 *  per-channel ring buffer. `username` is denormalized for display (the
 *  `chat_messages` row stores only `player_id`; the buffer/history carry the name). */
export interface ChatMessage {
  id: number;
  channel: string;
  player_id: number;
  username: string;
  body: string;
  /** ISO timestamp. */
  created_at: string;
}

/** A private message (`/whisper`). Delivered live to both parties; the `from`/`to`
 *  usernames let the client render direction without extra lookups. */
export interface WhisperMessage {
  id: number;
  from: string;
  to: string;
  body: string;
  /** ISO timestamp. */
  created_at: string;
}

/** Confirmation of a completed `/wire` gold transfer, pushed to both parties. */
export interface WireReceipt {
  from: string;
  to: string;
  amount: number;
}

export type WireError = 'unknown_user' | 'self' | 'bad_amount' | 'insufficient_gold';
export type WhisperError = 'unknown_user' | 'self' | 'empty_message' | 'too_long' | 'rate_limited';

/** Response body for register/login. The access + refresh tokens are delivered
 *  as httpOnly cookies (not in the body), so only the player is returned. */
export interface AuthResponse {
  player: PlayerSummary;
}

/** Loot line in a battle result. */
export interface LootDrop {
  item: string;
  qty: number;
}

// ── Housing DTOs (SPEC §12) ──────────────────────────────────────────────────

export interface UpgradeCost {
  gold: number;
  resources: Record<string, number>;
  duration: number;
}

export interface HousingFeatureState {
  code: string;
  bonus_type: string;
  level: number;
  max_level: number;
  /** Cost to go to the next level, or null if at max. */
  next_cost: UpgradeCost | null;
}

export interface ActiveUpgrade {
  feature: string;
  target_level: number;
  start_live: number;
  completes_live: number;
  remaining_seconds: number;
}

export interface HousingView {
  features: HousingFeatureState[];
  active: ActiveUpgrade | null;
}

/** Per-action battle summary (SPEC §7.2). The round-by-round log is NOT persisted;
 *  this is what the client renders and receives over the websocket. Hit/miss
 *  counts and HP pools drive the combat detail view. */
export interface BattleResult {
  monster: string;
  rounds: number;
  damage_dealt: number;
  damage_taken: number;
  won: boolean;
  crit_count: number;
  gold: number;
  xp: number;
  loot: LootDrop[];
  /** How many of your swings landed / whiffed this action. */
  player_hits: number;
  player_misses: number;
  /** How many of the monster's swings landed / whiffed (whiff = you dodged). */
  monster_hits: number;
  monster_misses: number;
  /** Final HP pools for the duel (remaining out of max). */
  player_hp: number;
  player_max_hp: number;
  monster_hp: number;
  monster_max_hp: number;
  /** True when an XP boost/effect was active for this action. */
  boosted: boolean;
  /** Combat levels gained from this action (0 if none). */
  levels_gained: number;
}

/** Per-action gather/craft summary, pushed over the websocket each tick for an
 *  active transform player. Drives the gathering/crafting detail view. */
export interface GatherResult {
  /** Recipe display name, e.g. "Mine ore". */
  recipe: string;
  /** Activity code (mine/quarry/hunt/craft/brew) — picks the flavor line. */
  activity: string;
  /** Skill code (mining, crafting, …) — labels the XP gain. */
  skill: string;
  xp: number;
  /** Items produced this action (empty when stalled). */
  outputs: LootDrop[];
  /** True when inputs were missing and the action could not run. */
  stalled: boolean;
  /** True when an XP boost/effect was active for this action. */
  boosted: boolean;
  /** Skill levels gained from this action (0 if none). */
  levels_gained: number;
}
