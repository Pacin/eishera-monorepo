// Consuming a potion → an active effect (SPEC §3.3, §8; SEED §8.1). The potion→
// effect mapping is config (`game_config.potion_effects`), not code. Durations are
// measured against the live clock (uptime_seconds) so they freeze on downtime.
// Re-consuming the same potion refreshes (replaces) its effect rather than
// double-stacking; different sources of the same effect_type still sum at read time.

import { withTransaction } from '../db/pool.js';
import { getConfig } from '../config/store.js';
import type { ConfigSnapshot } from '../config/snapshot.js';

interface PotionEffect {
  effect_type: string;
  magnitude: number;
  duration_seconds: number | null;
  stacking?: string;
}

export type ConsumeError = 'unknown_item' | 'not_a_potion' | 'none_in_inventory';

export interface ConsumeResult {
  effect_type: string;
  magnitude: number;
  expires_live: number | null;
}

export async function consumePotion(
  playerId: number,
  itemCode: string,
  cfg: ConfigSnapshot,
): Promise<ConsumeResult | { error: ConsumeError }> {
  const item = cfg.itemsByCode.get(itemCode);
  if (!item) return { error: 'unknown_item' };

  const potionMap = getConfig().raw.get('potion_effects') as
    | Record<string, PotionEffect>
    | undefined;
  const effect = potionMap?.[itemCode];
  if (!effect) return { error: 'not_a_potion' };

  return withTransaction(async (client) => {
    const dec = await client.query(
      'UPDATE inventory SET qty = qty - 1 WHERE player_id = $1 AND item_id = $2 AND qty >= 1',
      [playerId, item.id],
    );
    if (dec.rowCount === 0) return { error: 'none_in_inventory' as const };

    const wsRes = await client.query('SELECT uptime_seconds FROM world_state WHERE id = TRUE');
    const uptime = Number((wsRes.rows[0] as { uptime_seconds: string }).uptime_seconds);
    const expiresLive = effect.duration_seconds ? uptime + effect.duration_seconds : null;

    // Refresh: drop any existing effect from this same potion before adding.
    await client.query(
      "DELETE FROM player_active_effects WHERE player_id = $1 AND source = 'potion' AND source_ref = $2",
      [playerId, itemCode],
    );
    await client.query(
      `INSERT INTO player_active_effects
         (player_id, effect_type, magnitude, source, source_ref, expires_live, stacking)
       VALUES ($1, $2, $3, 'potion', $4, $5, $6)`,
      [
        playerId,
        effect.effect_type,
        effect.magnitude,
        itemCode,
        expiresLive,
        effect.stacking ?? 'highest',
      ],
    );

    return {
      effect_type: effect.effect_type,
      magnitude: effect.magnitude,
      expires_live: expiresLive,
    };
  });
}
