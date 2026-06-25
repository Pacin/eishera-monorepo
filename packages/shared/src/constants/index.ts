// Type definitions for the balance constants stored in `game_config` (SPEC §4,
// §8; values listed in SEED §1). The VALUES live in the DB and load as a live
// snapshot — these types only describe the shape that snapshot must satisfy, so
// server and client agree on what each knob means.

export interface XpCurve {
  B: number;
  p: number;
}

export interface RareCurve {
  base: number;
  step: number;
  cap: number;
}

export interface CombatCoeffs {
  dmg_per_str: number;
  hp_per_vit: number;
  mitigation_per_def: number;
  dodge_per_eva: number;
  accuracy_per_dex: number;
  crit_per_dex: number;
  crit_per_luck: number;
}

export interface StatPerLevel {
  str: number;
  vit: number;
  def: number;
  eva: number;
  dex: number;
  luck: number;
}

/** The known scalar knobs (SEED §1). Extra/unknown keys remain available via
 *  the snapshot's raw map but are not typed here. */
export interface GameConfig {
  tick_seconds: number;
  starting_max_actions: number;
  xp_curve: XpCurve;
  xp_per_action: number;
  yield_slope: number;
  xp_slope: number;
  rare: RareCurve;
  crit_chance_base: number;
  crit_multiplier: number;
  max_rounds: number;
  combat_coeffs: CombatCoeffs;
  rarity_luck_shift: number;
  rarity_quality_shift: number;
  stat_per_level: StatPerLevel;
  random_stat_gain_chance: number;
  cancel_penalty: number;
  outage_threshold_seconds: number;
  market_fee: number;
}

/** The full set of required keys — used by the loader to assert completeness. */
export const GAME_CONFIG_KEYS = [
  'tick_seconds',
  'starting_max_actions',
  'xp_curve',
  'xp_per_action',
  'yield_slope',
  'xp_slope',
  'rare',
  'crit_chance_base',
  'crit_multiplier',
  'max_rounds',
  'combat_coeffs',
  'rarity_luck_shift',
  'rarity_quality_shift',
  'stat_per_level',
  'random_stat_gain_chance',
  'cancel_penalty',
  'outage_threshold_seconds',
  'market_fee',
] as const satisfies ReadonlyArray<keyof GameConfig>;

export type GameConfigKey = (typeof GAME_CONFIG_KEYS)[number];
