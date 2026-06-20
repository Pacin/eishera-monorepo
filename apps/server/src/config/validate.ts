// Bounds checking for game_config writes (SPEC §4.5). Every write through the
// config service is validated before commit; invalid values are rejected. Known
// scalar knobs (SEED §1) get strict shape + range checks; unknown keys are
// accepted as long as they are well-formed JSON (already guaranteed by the
// JSONB column).

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const fail = (key: string, why: string): never => {
  throw new ConfigValidationError(`Invalid value for "${key}": ${why}`);
};

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isFiniteNumber(v) && Number.isInteger(v);
const isProb = (v: unknown): v is number => isFiniteNumber(v) && v >= 0 && v <= 1;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function requireNumbers(key: string, obj: Record<string, unknown>, fields: string[]): void {
  for (const f of fields) {
    if (!isFiniteNumber(obj[f])) fail(key, `field "${f}" must be a finite number`);
  }
}

const validators: Record<string, (v: unknown) => void> = {
  tick_seconds: (v) => {
    if (!isFiniteNumber(v) || v <= 0 || v > 3600)
      fail('tick_seconds', 'must be a number in (0, 3600]');
  },
  starting_max_actions: (v) => {
    if (!isInt(v) || v < 0) fail('starting_max_actions', 'must be a non-negative integer');
  },
  xp_curve: (v) => {
    if (!isObj(v)) fail('xp_curve', 'must be an object {B, p}');
    requireNumbers('xp_curve', v as Record<string, unknown>, ['B', 'p']);
    if ((v as { B: number }).B <= 0 || (v as { p: number }).p <= 0)
      fail('xp_curve', 'B and p must be > 0');
  },
  xp_per_action: (v) => {
    if (!isFiniteNumber(v) || v < 0) fail('xp_per_action', 'must be a non-negative number');
  },
  yield_slope: (v) => {
    if (!isFiniteNumber(v) || v < 0) fail('yield_slope', 'must be a non-negative number');
  },
  rare: (v) => {
    if (!isObj(v)) fail('rare', 'must be an object {base, step, cap}');
    const o = v as Record<string, unknown>;
    requireNumbers('rare', o, ['base', 'step', 'cap']);
    if (!isProb(o.base)) fail('rare', 'base must be in [0,1]');
    if ((o.step as number) < 0) fail('rare', 'step must be >= 0');
    if (!isProb(o.cap)) fail('rare', 'cap must be in [0,1]');
    if ((o.base as number) > (o.cap as number)) fail('rare', 'base must be <= cap');
  },
  crit_chance_base: (v) => {
    if (!isProb(v)) fail('crit_chance_base', 'must be in [0,1]');
  },
  crit_multiplier: (v) => {
    if (!isFiniteNumber(v) || v < 1) fail('crit_multiplier', 'must be >= 1');
  },
  max_rounds: (v) => {
    if (!isInt(v) || v < 1) fail('max_rounds', 'must be an integer >= 1');
  },
  combat_coeffs: (v) => {
    if (!isObj(v)) fail('combat_coeffs', 'must be an object');
    requireNumbers('combat_coeffs', v as Record<string, unknown>, [
      'dmg_per_str',
      'hp_per_vit',
      'mitigation_per_def',
      'dodge_per_eva',
      'accuracy_per_dex',
      'crit_per_dex',
      'crit_per_luck',
    ]);
  },
  rarity_luck_shift: (v) => {
    if (!isFiniteNumber(v) || v < 0) fail('rarity_luck_shift', 'must be a non-negative number');
  },
  rarity_quality_shift: (v) => {
    if (!isFiniteNumber(v) || v < 0) fail('rarity_quality_shift', 'must be a non-negative number');
  },
  stat_per_level: (v) => {
    if (!isObj(v)) fail('stat_per_level', 'must be an object');
    const o = v as Record<string, unknown>;
    for (const s of ['str', 'vit', 'def', 'eva', 'dex', 'luck']) {
      if (!isInt(o[s]) || (o[s] as number) < 0)
        fail('stat_per_level', `"${s}" must be a non-negative integer`);
    }
  },
  random_stat_gain_chance: (v) => {
    if (!isProb(v)) fail('random_stat_gain_chance', 'must be in [0,1]');
  },
  cancel_penalty: (v) => {
    if (!isProb(v)) fail('cancel_penalty', 'must be in [0,1]');
  },
  outage_threshold_seconds: (v) => {
    if (!isFiniteNumber(v) || v <= 0) fail('outage_threshold_seconds', 'must be > 0');
  },
  market_fee: (v) => {
    if (!isProb(v)) fail('market_fee', 'must be in [0,1]');
  },
};

/** Validate a game_config value, throwing ConfigValidationError if out of bounds. */
export function validateGameConfig(key: string, value: unknown): void {
  const validator = validators[key];
  if (validator) validator(value);
  // Unknown keys: no specific bounds — JSONB already guarantees well-formedness.
}
