// Transform archetype handler (SPEC §7.1): gathering + production. Runs INSIDE
// the tick transaction, once per active player per tick. Only pure CPU (RNG +
// computation) plus the player's own row writes — no slow async I/O.
//
// Per action: check req_level → check/consume inputs (stall if missing) → roll
// outputs (guaranteed scaled by yieldMult; rare boosted by pRare) → equippable
// outputs become item_instances with rolled rarity+stats, others stack in
// inventory → grant base_xp + level up → decrement actions_remaining.
//
// Phase 4 has no equipment/housing/active-effect bonuses yet (Phases 5/6/8), so
// the gather/rare bonus terms are the skill-level scaling only.

import type { PoolClient } from 'pg';
import { yieldMult, pRare, gainXp, xpScale } from '@eishera/shared';
import type { Recipe, LootDrop } from '@eishera/shared';
import type { ConfigSnapshot } from '../config/snapshot.js';
import { rollRarity, rollStats, scaleQty } from './rolls.js';
import { computeProductionModifiers } from './modifiers.js';
import { xpMultiplier } from '../effects/boosts.js';

/** Per-action result for the active transform player (drives the detail view). */
export interface TransformOutcome {
  status: 'processed' | 'stalled';
  xp: number;
  outputs: LootDrop[];
  boosted: boolean;
  levelsGained: number;
}

const STALLED: TransformOutcome = {
  status: 'stalled',
  xp: 0,
  outputs: [],
  boosted: false,
  levelsGained: 0,
};

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function processTransform(
  client: PoolClient,
  playerId: number,
  recipe: Recipe,
  cfg: ConfigSnapshot,
  uptimeSeconds: number,
): Promise<TransformOutcome> {
  const activity = cfg.activities.get(recipe.activity_id);
  if (!activity) return STALLED;
  const skillId = activity.skill_id;

  // Skill level/xp for this recipe's skill.
  const skRes = await client.query(
    'SELECT level, xp FROM player_skills WHERE player_id = $1 AND skill_id = $2 FOR UPDATE',
    [playerId, skillId],
  );
  const sk = skRes.rows[0] as { level: number; xp: string } | undefined;
  if (!sk) return STALLED;
  const level = sk.level;
  const xp = Number(sk.xp);

  if (level < recipe.req_level) return STALLED;

  // Inputs: verify all are available before consuming any (stall otherwise).
  if (recipe.inputs.length > 0) {
    const ids = recipe.inputs
      .map((i) => cfg.itemsByCode.get(i.item)?.id)
      .filter((x): x is number => x != null);
    const invRes = await client.query(
      'SELECT item_id, qty FROM inventory WHERE player_id = $1 AND item_id = ANY($2::int[]) FOR UPDATE',
      [playerId, ids],
    );
    const have = new Map((invRes.rows as any[]).map((r) => [r.item_id as number, Number(r.qty)]));
    for (const inp of recipe.inputs) {
      const id = cfg.itemsByCode.get(inp.item)?.id;
      if (id == null || (have.get(id) ?? 0) < inp.qty) return STALLED;
    }
    for (const inp of recipe.inputs) {
      const id = cfg.itemsByCode.get(inp.item)!.id;
      await client.query(
        'UPDATE inventory SET qty = qty - $3 WHERE player_id = $1 AND item_id = $2',
        [playerId, id, inp.qty],
      );
    }
  }

  // Production modifiers from equipment + active effects + housing (SPEC §8).
  const mods = await computeProductionModifiers(client, playerId, uptimeSeconds, cfg);
  // Effective craft_quality = skill level scaled by workshop/effect bonuses.
  const craftQuality = level * (1 + mods.craftQuality);

  // Outputs (also collected for the per-action detail view).
  const g = cfg.gameConfig;
  const outputs: LootDrop[] = [];
  for (const out of recipe.outputs) {
    const item = cfg.itemsByCode.get(out.item);
    if (!item) continue;
    const chance = out.chance ?? 1;

    let qty: number;
    if (chance >= 1) {
      // Guaranteed base yield. Equippable pieces are unique (no qty scaling);
      // stackables scale with level (yieldMult) and gather bonuses. food_yield
      // applies on top for food output.
      const gather = 1 + mods.gatherYield + (item.code === 'food' ? mods.foodYield : 0);
      qty = item.equip_slot ? out.qty : scaleQty(out.qty, yieldMult(level, g.yield_slope) * gather);
    } else {
      // Rare/secondary output: listed chance boosted by pRare + rare_drop bonuses.
      const eff = Math.min(1, chance + pRare(level, g.rare) + mods.rareDrop);
      qty = Math.random() < eff ? out.qty : 0;
    }
    if (qty <= 0) continue;

    if (item.equip_slot) {
      // craft_quality (skill level + workshop housing + effects) re-weights rarity.
      for (let k = 0; k < qty; k++) {
        const rarity = rollRarity([...cfg.rarities.values()], g.rarity_quality_shift, craftQuality);
        const rolls = rollStats(item.base_stats ?? {}, rarity);
        await client.query(
          'INSERT INTO item_instances (item_id, owner_id, rarity, rolls) VALUES ($1, $2, $3, $4::jsonb)',
          [item.id, playerId, rarity.tier, JSON.stringify(rolls)],
        );
      }
    } else {
      await client.query(
        `INSERT INTO inventory (player_id, item_id, qty) VALUES ($1, $2, $3)
         ON CONFLICT (player_id, item_id) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`,
        [playerId, item.id, qty],
      );
    }
    outputs.push({ item: out.item, qty });
  }

  // XP + level-ups for this skill. Scales with the skill level (xpScale) and any
  // active XP boost, mirroring how output scales with yieldMult.
  const xpMult = await xpMultiplier(client, playerId, uptimeSeconds);
  const xpAmount = Math.round(recipe.base_xp * xpScale(level, g.xp_slope) * xpMult);
  const gained = gainXp(level, xp, xpAmount, g.xp_curve);
  await client.query(
    'UPDATE player_skills SET level = $3, xp = $4 WHERE player_id = $1 AND skill_id = $2',
    [playerId, skillId, gained.level, gained.xp],
  );

  // Consume the action.
  await client.query('UPDATE players SET actions_remaining = actions_remaining - 1 WHERE id = $1', [
    playerId,
  ]);

  return {
    status: 'processed',
    xp: xpAmount,
    outputs,
    boosted: xpMult > 1,
    levelsGained: gained.level - level,
  };
}
