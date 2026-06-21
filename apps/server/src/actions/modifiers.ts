// Production modifiers (SPEC §8): the gather / rare / craft-quality bonuses that
// multiply the base (skill-level) production formulas. Aggregated from the same
// three sources as combat stats — equipment, active effects, and housing:
//   gather_yield  → tool base_stats, yield_potion, mine_shaft
//   food_yield    → pantry (applies to food output specifically)
//   rare_drop     → treasury, rare_drop effects
//   craft_quality → workshop, craft_quality effects
// Housing bonuses use housingBonus(bonus_base, bonus_growth, level) per feature.

import type { PoolClient } from 'pg';
import { housingBonus } from '@eishera/shared';
import type { ConfigSnapshot } from '../config/snapshot.js';

export interface ProductionModifiers {
  gatherYield: number;
  foodYield: number;
  rareDrop: number;
  craftQuality: number;
}

export async function computeProductionModifiers(
  client: PoolClient,
  playerId: number,
  uptimeSeconds: number,
  cfg: ConfigSnapshot,
): Promise<ProductionModifiers> {
  const mods: ProductionModifiers = { gatherYield: 0, foodYield: 0, rareDrop: 0, craftQuality: 0 };

  // Equipment: only gather_yield is a production stat (e.g. the tool).
  const eq = await client.query(
    `SELECT ii.item_id, ii.rolls FROM player_equipment pe
       JOIN item_instances ii ON ii.id = pe.instance_id WHERE pe.player_id = $1`,
    [playerId],
  );
  for (const row of eq.rows as { item_id: number; rolls: Record<string, number> }[]) {
    const item = cfg.items.get(row.item_id);
    const base = item?.base_stats?.gather_yield;
    const roll = row.rolls.gather_yield;
    if (base != null && roll != null) mods.gatherYield += base * roll;
  }

  // Active effects (non-expired).
  const ef = await client.query(
    `SELECT effect_type, magnitude FROM player_active_effects
      WHERE player_id = $1 AND (expires_live IS NULL OR expires_live > $2)`,
    [playerId, uptimeSeconds],
  );
  for (const row of ef.rows as { effect_type: string; magnitude: string }[]) {
    const m = Number(row.magnitude);
    if (row.effect_type === 'gather_yield') mods.gatherYield += m;
    else if (row.effect_type === 'rare_drop') mods.rareDrop += m;
    else if (row.effect_type === 'craft_quality') mods.craftQuality += m;
  }

  // Housing (per-feature bonus by bonus_type).
  const hs = await client.query(
    'SELECT feature_id, level FROM player_housing WHERE player_id = $1 AND level > 0',
    [playerId],
  );
  for (const row of hs.rows as { feature_id: number; level: number }[]) {
    const feature = cfg.housingFeatures.get(row.feature_id);
    if (!feature) continue;
    const bonus = housingBonus(feature.bonus_base, feature.bonus_growth, row.level);
    switch (feature.bonus_type) {
      case 'gather_yield':
        mods.gatherYield += bonus;
        break;
      case 'food_yield':
        mods.foodYield += bonus;
        break;
      case 'rare_drop':
        mods.rareDrop += bonus;
        break;
      case 'craft_quality':
        mods.craftQuality += bonus;
        break;
    }
  }

  return mods;
}
