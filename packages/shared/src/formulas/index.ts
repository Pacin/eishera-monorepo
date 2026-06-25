// Pure formula functions shared by server (authoritative) and client (smooth
// prediction) — SPEC §8. Each takes its constants from the config snapshot as
// parameters; no numbers are hardcoded here. No RNG lives in this module: random
// rolls (rarity selection, per-stat rolls) are server-authoritative and can't be
// predicted, so they live in the server, not here.

import type { XpCurve, RareCurve } from '../constants/index.js';

/** XP required to go from `level` to `level + 1` (no cap). SPEC §8. */
export function xpToNext(level: number, curve: XpCurve): number {
  return Math.round(curve.B * Math.pow(level, curve.p));
}

/** Production output multiplier from skill level (e.g. 2× at L50 with slope 0.02). */
export function yieldMult(level: number, slope: number): number {
  return 1 + level * slope;
}

/** XP-gain multiplier from skill level (e.g. 2× at L50 with slope 0.02). Mirrors
 *  yieldMult but tuned separately via xp_slope, so XP and output can scale apart. */
export function xpScale(level: number, slope: number): number {
  return 1 + level * slope;
}

/** Probability that an activity yields a rare output at all — deliberately scarce. */
export function pRare(level: number, rare: RareCurve): number {
  return Math.min(rare.cap, rare.base + level * rare.step);
}

/** Housing bonus for a feature at a given level: bonus_base + level * bonus_growth. */
export function housingBonus(bonusBase: number, bonusGrowth: number, level: number): number {
  return bonusBase + level * bonusGrowth;
}

/**
 * Apply `amount` XP to a (level, xp) pair, rolling over level-ups using the
 * polynomial curve. Deterministic, so the client can predict levels too.
 */
export function gainXp(
  level: number,
  xp: number,
  amount: number,
  curve: XpCurve,
): { level: number; xp: number } {
  let l = Math.max(1, level);
  let x = xp + amount;
  let next = xpToNext(l, curve);
  while (x >= next) {
    x -= next;
    l += 1;
    next = xpToNext(l, curve);
  }
  return { level: l, xp: x };
}

/**
 * Re-weighted rarity weight for one tier (SPEC §7.1 "re-weighted upward, bounded
 * by rarity_quality_shift / rarity_luck_shift"). Linear in `quality` so higher
 * `quality` (craft level on crafts, LUCK on drops) lifts the upper tiers, while
 * mythic — whose base weight is tiny — stays extremely scarce. `tierIndex` is
 * tier − 1, so common (index 0) is never boosted.
 */
export function rarityWeight(
  baseWeight: number,
  tierIndex: number,
  shift: number,
  quality: number,
): number {
  return baseWeight * (1 + shift * quality * tierIndex);
}
