// Server-authoritative random rolls for transform outputs (SPEC §7.1). These are
// NOT in packages/shared because the client can't predict RNG. The deterministic
// weight math comes from shared (rarityWeight); the random selection happens here.

import { rarityWeight } from '@eishera/shared';
import type { Rarity } from '@eishera/shared';

export type Rng = () => number;

/**
 * Pick a rarity tier by weight, re-weighted upward by `quality` (craft level on
 * crafts, effective LUCK on drops) and `shift` (rarity_quality_shift /
 * rarity_luck_shift). Higher quality → more uncommon/rare/unique; mythic stays
 * extremely scarce.
 */
export function rollRarity(
  rarities: Rarity[],
  shift: number,
  quality: number,
  rng: Rng = Math.random,
): Rarity {
  const weighted = rarities.map((r) => ({
    r,
    w: rarityWeight(r.weight, r.tier - 1, shift, quality),
  }));
  const total = weighted.reduce((sum, x) => sum + x.w, 0);
  let roll = rng() * total;
  for (const { r, w } of weighted) {
    roll -= w;
    if (roll <= 0) return r;
  }
  return weighted[weighted.length - 1]!.r;
}

/** Roll a per-stat multiplier within the rarity's [roll_min, roll_max] band. */
export function rollStats(
  baseStats: Record<string, number>,
  rarity: Rarity,
  rng: Rng = Math.random,
): Record<string, number> {
  const rolls: Record<string, number> = {};
  const span = rarity.roll_max - rarity.roll_min;
  for (const key of Object.keys(baseStats)) {
    rolls[key] = Math.round((rarity.roll_min + rng() * span) * 10000) / 10000;
  }
  return rolls;
}

/**
 * Quantity for a scaled output: floor of the expected value, plus a probabilistic
 * extra for the fractional remainder (so expected yield is exact over time).
 */
export function scaleQty(base: number, mult: number, rng: Rng = Math.random): number {
  const expected = base * mult;
  const floor = Math.floor(expected);
  return floor + (rng() < expected - floor ? 1 : 0);
}
