// Global boosts (SPEC §3.2/§3.3, §8; SEED §8.2). A boost from the `global_boosts`
// catalog can be granted by several sources — world-boss rewards, events, token
// purchases — and they all flow through grantGlobalBoost: it writes a runtime
// player_active_effects row (so the formula layer picks it up) AND an audit row
// in global_boost_log. Durations are on the live clock (freeze on downtime).
// Re-granting the same boost refreshes it; different sources of the same
// effect_type sum at read time.

import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool.js';
import { getConfig } from '../config/store.js';
import type { ConfigSnapshot } from '../config/snapshot.js';

export type BoostSourceKind = 'token' | 'event' | 'world_boss';

/** Grant a catalog boost to a player inside the caller's transaction. */
export async function grantGlobalBoost(
  client: PoolClient,
  playerId: number,
  boostCode: string,
  source: BoostSourceKind,
  cfg: ConfigSnapshot,
  uptimeSeconds: number,
): Promise<boolean> {
  const boost = cfg.globalBoosts.get(boostCode);
  if (!boost) return false;

  const expiresLive = boost.duration_seconds ? uptimeSeconds + boost.duration_seconds : null;

  // Refresh: replace any existing effect from this same boost.
  await client.query('DELETE FROM player_active_effects WHERE player_id = $1 AND source_ref = $2', [
    playerId,
    boostCode,
  ]);
  await client.query(
    `INSERT INTO player_active_effects
       (player_id, effect_type, magnitude, source, source_ref, expires_live, stacking)
     VALUES ($1, $2, $3, $4, $5, $6, 'sum')`,
    [playerId, boost.effect_type, boost.magnitude, source, boostCode, expiresLive],
  );
  await client.query(
    `INSERT INTO global_boost_log (player_id, boost_code, effect_type, magnitude, source, expires_live)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [playerId, boostCode, boost.effect_type, boost.magnitude, source, expiresLive],
  );
  return true;
}

export type BuyBoostError = 'unknown_boost' | 'not_purchasable' | 'insufficient_tokens';

/** Buy a global boost with premium tokens (SPEC §8). */
export async function buyBoost(
  playerId: number,
  boostCode: string,
  cfg: ConfigSnapshot,
): Promise<{ ok: true; cost: number } | { error: BuyBoostError }> {
  if (!cfg.globalBoosts.has(boostCode)) return { error: 'unknown_boost' };
  const costs = getConfig().raw.get('boost_token_costs') as Record<string, number> | undefined;
  const cost = costs?.[boostCode];
  if (cost === undefined) return { error: 'not_purchasable' };

  return withTransaction(async (client) => {
    const p = await client.query('SELECT tokens FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    if (Number((p.rows[0] as { tokens: string }).tokens) < cost) {
      return { error: 'insufficient_tokens' as const };
    }
    const ws = await client.query('SELECT uptime_seconds FROM world_state WHERE id = TRUE');
    const uptime = Number((ws.rows[0] as { uptime_seconds: string }).uptime_seconds);
    if (cost > 0) {
      await client.query('UPDATE players SET tokens = tokens - $2 WHERE id = $1', [playerId, cost]);
    }
    await grantGlobalBoost(client, playerId, boostCode, 'token', cfg, uptime);
    return { ok: true as const, cost };
  });
}

/** Multiplier on XP gains from active `xp` boosts (1 + Σ magnitudes). */
export async function xpMultiplier(
  client: PoolClient,
  playerId: number,
  uptimeSeconds: number,
): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(SUM(magnitude), 0) AS total FROM player_active_effects
      WHERE player_id = $1 AND effect_type = 'xp' AND (expires_live IS NULL OR expires_live > $2)`,
    [playerId, uptimeSeconds],
  );
  return 1 + Number((res.rows[0] as { total: string }).total);
}
