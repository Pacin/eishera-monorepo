// Effective combat stats (SPEC §8): effectiveS = (baseS + equipment(S)) × (1 +
// combat_all%), where equipment(S) = Σ items.base_stats[S] × rolls[S] over
// equipped instances, and combat_all comes from active effects (potions/global).
// Housing bonuses join here in Phase 6. Per-stat flat effects (e.g. combat_str)
// would add into the flat term; the seed only ships combat_all.

import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { ConfigSnapshot } from '../config/snapshot.js';

export const COMBAT_STATS = ['str', 'vit', 'def', 'eva', 'dex', 'luck'] as const;
export type CombatStat = (typeof COMBAT_STATS)[number];
export type EffectiveStats = Record<CombatStat, number>;

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function computeEffectiveStats(
  client: PoolClient,
  playerId: number,
  uptimeSeconds: number,
  cfg: ConfigSnapshot,
): Promise<EffectiveStats> {
  // Base stats from the player row.
  const pRes = await client.query(
    'SELECT str, vit, def, eva, dex, luck FROM players WHERE id = $1',
    [playerId],
  );
  const base = pRes.rows[0] as Record<CombatStat, number>;

  const flat: EffectiveStats = {
    str: base.str,
    vit: base.vit,
    def: base.def,
    eva: base.eva,
    dex: base.dex,
    luck: base.luck,
  };

  // Equipment: base_stats × rolls for each equipped instance, combat stats only.
  const eqRes = await client.query(
    `SELECT ii.item_id, ii.rolls
       FROM player_equipment pe
       JOIN item_instances ii ON ii.id = pe.instance_id
      WHERE pe.player_id = $1`,
    [playerId],
  );
  for (const row of eqRes.rows as { item_id: number; rolls: Record<string, number> }[]) {
    const item = cfg.items.get(row.item_id);
    if (!item?.base_stats) continue;
    for (const stat of COMBAT_STATS) {
      const baseVal = item.base_stats[stat];
      const roll = row.rolls[stat];
      if (baseVal != null && roll != null) flat[stat] += baseVal * roll;
    }
  }

  // Active effects: combat_all is a global percentage on all six stats. Only
  // non-expired effects apply (NULL expires_live = permanent).
  const efRes = await client.query(
    `SELECT effect_type, magnitude FROM player_active_effects
      WHERE player_id = $1 AND (expires_live IS NULL OR expires_live > $2)`,
    [playerId, uptimeSeconds],
  );
  let combatAll = 0;
  for (const row of efRes.rows as { effect_type: string; magnitude: string }[]) {
    if (row.effect_type === 'combat_all') combatAll += Number(row.magnitude);
  }

  const mult = 1 + combatAll;
  return {
    str: flat.str * mult,
    vit: flat.vit * mult,
    def: flat.def * mult,
    eva: flat.eva * mult,
    dex: flat.dex * mult,
    luck: flat.luck * mult,
  };
}

/** Read-path helper: acquire a client + the current uptime, then compute. */
export async function effectiveStatsForPlayer(
  playerId: number,
  cfg: ConfigSnapshot,
): Promise<EffectiveStats> {
  const client = await pool.connect();
  try {
    const ws = await client.query('SELECT uptime_seconds FROM world_state WHERE id = TRUE');
    const uptime = Number(
      (ws.rows[0] as { uptime_seconds: string } | undefined)?.uptime_seconds ?? 0,
    );
    return await computeEffectiveStats(client, playerId, uptime, cfg);
  } finally {
    client.release();
  }
}
