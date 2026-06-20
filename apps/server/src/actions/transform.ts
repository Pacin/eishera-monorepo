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
import { yieldMult, pRare, gainXp } from '@eishera/shared';
import type { Recipe } from '@eishera/shared';
import type { ConfigSnapshot } from '../config/snapshot.js';
import { rollRarity, rollStats, scaleQty } from './rolls.js';

export type TransformResult = 'processed' | 'stalled';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function processTransform(
  client: PoolClient,
  playerId: number,
  recipe: Recipe,
  cfg: ConfigSnapshot,
): Promise<TransformResult> {
  const activity = cfg.activities.get(recipe.activity_id);
  if (!activity) return 'stalled';
  const skillId = activity.skill_id;

  // Skill level/xp for this recipe's skill.
  const skRes = await client.query(
    'SELECT level, xp FROM player_skills WHERE player_id = $1 AND skill_id = $2 FOR UPDATE',
    [playerId, skillId],
  );
  const sk = skRes.rows[0] as { level: number; xp: string } | undefined;
  if (!sk) return 'stalled';
  const level = sk.level;
  const xp = Number(sk.xp);

  if (level < recipe.req_level) return 'stalled';

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
      if (id == null || (have.get(id) ?? 0) < inp.qty) return 'stalled';
    }
    for (const inp of recipe.inputs) {
      const id = cfg.itemsByCode.get(inp.item)!.id;
      await client.query(
        'UPDATE inventory SET qty = qty - $3 WHERE player_id = $1 AND item_id = $2',
        [playerId, id, inp.qty],
      );
    }
  }

  // Outputs.
  const g = cfg.gameConfig;
  for (const out of recipe.outputs) {
    const item = cfg.itemsByCode.get(out.item);
    if (!item) continue;
    const chance = out.chance ?? 1;

    let qty: number;
    if (chance >= 1) {
      // Guaranteed base yield. Equippable pieces are unique (no qty scaling);
      // stackables scale with level via yieldMult.
      qty = item.equip_slot ? out.qty : scaleQty(out.qty, yieldMult(level, g.yield_slope));
    } else {
      // Rare/secondary output: listed chance boosted by pRare (housing/effects = 0 in Phase 4).
      const eff = Math.min(1, chance + pRare(level, g.rare));
      qty = Math.random() < eff ? out.qty : 0;
    }
    if (qty <= 0) continue;

    if (item.equip_slot) {
      // craft_quality = this skill's level (Phase 4: no workshop/effect bonus yet).
      for (let k = 0; k < qty; k++) {
        const rarity = rollRarity([...cfg.rarities.values()], g.rarity_quality_shift, level);
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
  }

  // XP + level-ups for this skill.
  const gained = gainXp(level, xp, recipe.base_xp, g.xp_curve);
  await client.query(
    'UPDATE player_skills SET level = $3, xp = $4 WHERE player_id = $1 AND skill_id = $2',
    [playerId, skillId, gained.level, gained.xp],
  );

  // Consume the action.
  await client.query('UPDATE players SET actions_remaining = actions_remaining - 1 WHERE id = $1', [
    playerId,
  ]);

  return 'processed';
}
