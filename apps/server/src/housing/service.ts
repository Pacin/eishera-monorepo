// Housing upgrades (SPEC §12). Starting an upgrade is an INSTANT atomic resource
// spend (not a tick action): check max level + funds → deduct → snapshot what was
// paid → create the job. The job's timer runs on the live clock (uptime_seconds),
// so it FREEZES on downtime; completion happens in the tick loop (§6 step 4) and
// lazily when the housing screen is opened. At most one active upgrade per player
// is guaranteed by the `uniq_active_upgrade` partial unique index. Cancelling
// refunds (1 − cancel_penalty) of the SNAPSHOT — never of current config — so a
// live cost change can't corrupt the refund.

import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import type { ConfigSnapshot } from '../config/snapshot.js';
import type {
  HousingFeature,
  HousingView,
  HousingFeatureState,
  UpgradeCost,
} from '@eishera/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type StartError =
  | 'unknown_feature'
  | 'upgrade_in_progress'
  | 'max_level'
  | 'insufficient_gold'
  | 'insufficient_resources'
  | 'unknown_resource';

interface PaidSnapshot {
  gold: number;
  resources: Record<string, number>;
}

/** Cost + duration to go from `level` to `level + 1` (SPEC §12.2, SEED §6).
 *  Note: at level 0 every term is x·0^growth = 0, so the first level is free +
 *  instant with the seed curves — tune cost_base/curves (pure config) to change. */
export function computeUpgradeCost(feature: HousingFeature, level: number): UpgradeCost {
  const gold = Math.round(feature.cost_base * Math.pow(level, feature.cost_growth));
  const resources: Record<string, number> = {};
  for (const [res, base] of Object.entries(feature.cost_resources)) {
    resources[res] = Math.round(base * Math.pow(level, feature.cost_growth));
  }
  const duration = Math.round(feature.duration_base * Math.pow(level, feature.duration_growth));
  return { gold, resources, duration };
}

export async function startUpgrade(
  playerId: number,
  featureId: number,
  cfg: ConfigSnapshot,
): Promise<{ ok: true } | { error: StartError }> {
  const feature = cfg.housingFeatures.get(featureId);
  if (!feature) return { error: 'unknown_feature' };

  try {
    return await withTransaction(async (client) => {
      // One upgrade at a time (graceful pre-check; the unique index is the hard guarantee).
      const existing = await client.query(
        "SELECT 1 FROM housing_upgrade_jobs WHERE player_id = $1 AND status = 'in_progress'",
        [playerId],
      );
      if (existing.rowCount && existing.rowCount > 0)
        return { error: 'upgrade_in_progress' as const };

      const lvRes = await client.query(
        'SELECT level FROM player_housing WHERE player_id = $1 AND feature_id = $2 FOR UPDATE',
        [playerId, featureId],
      );
      const level = (lvRes.rows[0] as { level: number } | undefined)?.level ?? 0;
      if (level >= feature.max_level) return { error: 'max_level' as const };

      const cost = computeUpgradeCost(feature, level);

      const pRes = await client.query('SELECT gold FROM players WHERE id = $1 FOR UPDATE', [
        playerId,
      ]);
      if (Number((pRes.rows[0] as { gold: string }).gold) < cost.gold) {
        return { error: 'insufficient_gold' as const };
      }
      for (const [res, qty] of Object.entries(cost.resources)) {
        if (qty <= 0) continue;
        const item = cfg.itemsByCode.get(res);
        if (!item) return { error: 'unknown_resource' as const };
        const inv = await client.query(
          'SELECT qty FROM inventory WHERE player_id = $1 AND item_id = $2 FOR UPDATE',
          [playerId, item.id],
        );
        if (Number((inv.rows[0] as { qty: string } | undefined)?.qty ?? 0) < qty) {
          return { error: 'insufficient_resources' as const };
        }
      }

      // Deduct.
      if (cost.gold > 0) {
        await client.query('UPDATE players SET gold = gold - $2 WHERE id = $1', [
          playerId,
          cost.gold,
        ]);
      }
      for (const [res, qty] of Object.entries(cost.resources)) {
        if (qty <= 0) continue;
        const item = cfg.itemsByCode.get(res)!;
        await client.query(
          'UPDATE inventory SET qty = qty - $3 WHERE player_id = $1 AND item_id = $2',
          [playerId, item.id, qty],
        );
      }

      const ws = await client.query('SELECT uptime_seconds FROM world_state WHERE id = TRUE');
      const startLive = Number((ws.rows[0] as { uptime_seconds: string }).uptime_seconds);
      const paid: PaidSnapshot = { gold: cost.gold, resources: cost.resources };

      await client.query(
        `INSERT INTO housing_upgrade_jobs
           (player_id, feature_id, target_level, start_live, completes_live, paid_snapshot, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'in_progress')`,
        [
          playerId,
          featureId,
          level + 1,
          startLive,
          startLive + cost.duration,
          JSON.stringify(paid),
        ],
      );
      return { ok: true as const };
    });
  } catch (err) {
    // Lost the race for the single active-upgrade slot.
    if ((err as { code?: string }).code === '23505') return { error: 'upgrade_in_progress' };
    throw err;
  }
}

export async function cancelUpgrade(
  playerId: number,
  cfg: ConfigSnapshot,
): Promise<{ refund: PaidSnapshot } | { error: 'no_active_upgrade' }> {
  return withTransaction(async (client) => {
    const jobRes = await client.query(
      "SELECT id, paid_snapshot FROM housing_upgrade_jobs WHERE player_id = $1 AND status = 'in_progress' FOR UPDATE",
      [playerId],
    );
    const job = jobRes.rows[0] as { id: string; paid_snapshot: PaidSnapshot } | undefined;
    if (!job) return { error: 'no_active_upgrade' as const };

    const factor = 1 - cfg.gameConfig.cancel_penalty;
    const paid = job.paid_snapshot;
    const refundGold = Math.floor(paid.gold * factor);
    if (refundGold > 0) {
      await client.query('UPDATE players SET gold = gold + $2 WHERE id = $1', [
        playerId,
        refundGold,
      ]);
    }
    const refundResources: Record<string, number> = {};
    for (const [res, qty] of Object.entries(paid.resources ?? {})) {
      const refund = Math.floor(qty * factor);
      refundResources[res] = refund;
      const item = cfg.itemsByCode.get(res);
      if (refund > 0 && item) {
        await client.query(
          `INSERT INTO inventory (player_id, item_id, qty) VALUES ($1, $2, $3)
           ON CONFLICT (player_id, item_id) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`,
          [playerId, item.id, refund],
        );
      }
    }
    await client.query("UPDATE housing_upgrade_jobs SET status = 'cancelled' WHERE id = $1", [
      job.id,
    ]);
    return { refund: { gold: refundGold, resources: refundResources } };
  });
}

/** Apply all in-progress jobs whose timer is due (completes_live <= uptime).
 *  Runs inside the caller's transaction (the tick, or a lazy per-player check). */
export async function completeUpgradeJobs(
  client: PoolClient,
  uptime: number,
  playerId?: number,
): Promise<number> {
  const params: unknown[] = [uptime];
  let sql =
    "SELECT id, player_id, feature_id, target_level FROM housing_upgrade_jobs WHERE status = 'in_progress' AND completes_live <= $1";
  if (playerId !== undefined) {
    sql += ' AND player_id = $2';
    params.push(playerId);
  }
  sql += ' FOR UPDATE';
  const due = await client.query(sql, params);
  for (const job of due.rows as {
    id: string;
    player_id: string;
    feature_id: number;
    target_level: number;
  }[]) {
    await client.query(
      `INSERT INTO player_housing (player_id, feature_id, level) VALUES ($1, $2, $3)
       ON CONFLICT (player_id, feature_id) DO UPDATE SET level = EXCLUDED.level`,
      [job.player_id, job.feature_id, job.target_level],
    );
    await client.query("UPDATE housing_upgrade_jobs SET status = 'completed' WHERE id = $1", [
      job.id,
    ]);
  }
  return due.rowCount ?? 0;
}

export async function getHousing(playerId: number, cfg: ConfigSnapshot): Promise<HousingView> {
  // Lazy completion so the screen shows "done" immediately (SPEC §12.3).
  let uptime = 0;
  await withTransaction(async (client) => {
    const ws = await client.query('SELECT uptime_seconds FROM world_state WHERE id = TRUE');
    uptime = Number((ws.rows[0] as { uptime_seconds: string } | undefined)?.uptime_seconds ?? 0);
    await completeUpgradeJobs(client, uptime, playerId);
  });

  const levels = await query('SELECT feature_id, level FROM player_housing WHERE player_id = $1', [
    playerId,
  ]);
  const levelMap = new Map(
    (levels.rows as any[]).map((r) => [r.feature_id as number, r.level as number]),
  );

  const features: HousingFeatureState[] = [...cfg.housingFeatures.values()]
    .map((f) => {
      const level = levelMap.get(f.id) ?? 0;
      return {
        code: f.code,
        bonus_type: f.bonus_type,
        level,
        max_level: f.max_level,
        next_cost: level >= f.max_level ? null : computeUpgradeCost(f, level),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const jobRes = await query(
    `SELECT hf.code, j.target_level, j.start_live, j.completes_live
       FROM housing_upgrade_jobs j JOIN housing_features hf ON hf.id = j.feature_id
      WHERE j.player_id = $1 AND j.status = 'in_progress'`,
    [playerId],
  );
  const job = jobRes.rows[0] as
    | { code: string; target_level: number; start_live: string; completes_live: string }
    | undefined;
  const active = job
    ? {
        feature: job.code,
        target_level: job.target_level,
        start_live: Number(job.start_live),
        completes_live: Number(job.completes_live),
        remaining_seconds: Math.max(0, Number(job.completes_live) - uptime),
      }
    : null;

  return { features, active };
}
