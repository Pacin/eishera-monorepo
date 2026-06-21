// World boss (SPEC §9). The boss is processed INSIDE the tick transaction as a
// separate block: each tick rolls per-participant damage (base stats + crit),
// applies it to the boss, and durably writes boss state. On death the tier
// escalates and HP refills (the event continues). The event window is tick-based
// (started_tick..ends_tick) so it FREEZES on downtime — tick_number only advances
// while the server is up. When the window closes the boss expires and rewards are
// distributed by total_damage (gold share + a global boost grant).

import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import { getConfig } from '../config/store.js';
import { grantGlobalBoost } from '../effects/boosts.js';
import type { ConfigSnapshot } from '../config/snapshot.js';
import type { BossView } from '@eishera/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface BossConfig {
  window_minutes: number;
  max_hp: number;
  reward_gold: number;
  reward_boost: string;
}

const bossConfig = (): BossConfig => getConfig().raw.get('boss') as BossConfig;
const windowTicks = (cfg: ConfigSnapshot): number =>
  Math.max(1, Math.round((bossConfig().window_minutes * 60) / cfg.gameConfig.tick_seconds));

const clamp = (lo: number, hi: number, v: number): number => Math.max(lo, Math.min(hi, v));

async function currentTick(client: PoolClient): Promise<number> {
  const r = await client.query('SELECT tick_number FROM world_state WHERE id = TRUE');
  return Number((r.rows[0] as { tick_number: string }).tick_number);
}

/** Spawn a fresh boss inside the caller's transaction. */
async function spawnBoss(client: PoolClient, cfg: ConfigSnapshot): Promise<number> {
  const bc = bossConfig();
  const started = await currentTick(client);
  const ins = await client.query(
    `INSERT INTO world_boss (tier, hp, max_hp, started_tick, ends_tick, status)
     VALUES (1, $1, $1, $2, $3, 'active') RETURNING id`,
    [bc.max_hp, started, started + windowTicks(cfg)],
  );
  return Number((ins.rows[0] as { id: string }).id);
}

/** Join the active boss (auto-spawning one if none is active). */
export async function joinBoss(playerId: number, cfg: ConfigSnapshot): Promise<BossView> {
  await withTransaction(async (client) => {
    const active = await client.query(
      "SELECT id FROM world_boss WHERE status = 'active' FOR UPDATE",
    );
    const bossId = active.rows[0]
      ? Number((active.rows[0] as { id: string }).id)
      : await spawnBoss(client, cfg);
    const joinedTick = await currentTick(client);
    await client.query(
      `INSERT INTO world_boss_participants (boss_id, player_id, joined_tick, total_damage)
       VALUES ($1, $2, $3, 0) ON CONFLICT (boss_id, player_id) DO NOTHING`,
      [bossId, playerId, joinedTick],
    );
  });
  return getBoss(playerId);
}

export async function getBoss(playerId: number): Promise<BossView> {
  const res = await query(
    `SELECT b.id, b.tier, b.hp, b.max_hp, b.ends_tick,
            (SELECT count(*)::int FROM world_boss_participants p WHERE p.boss_id = b.id) AS participants,
            (SELECT total_damage FROM world_boss_participants p WHERE p.boss_id = b.id AND p.player_id = $1) AS your_damage,
            (SELECT tick_number FROM world_state WHERE id = TRUE) AS current_tick
       FROM world_boss b WHERE b.status = 'active'`,
    [playerId],
  );
  const b = res.rows[0] as any;
  if (!b) return { active: false };
  const currentTickNum = Number(b.current_tick);
  return {
    active: true,
    tier: b.tier,
    hp: Number(b.hp),
    max_hp: Number(b.max_hp),
    ends_tick: Number(b.ends_tick),
    current_tick: currentTickNum,
    ticks_remaining: Math.max(0, Number(b.ends_tick) - currentTickNum),
    participants: b.participants,
    your_damage: b.your_damage === null ? 0 : Number(b.your_damage),
    joined: b.your_damage !== null,
  };
}

export interface BossTickResult {
  active: boolean;
  expired: boolean;
  deaths: number;
  /** Participant player IDs (so the tick loop can push boss:update to them). */
  participants: number[];
}

/** Process the active boss for one tick (called inside the tick transaction). */
export async function processBossTick(
  client: PoolClient,
  tickNumber: number,
  uptimeSeconds: number,
  cfg: ConfigSnapshot,
): Promise<BossTickResult> {
  const boss = await client.query(
    "SELECT id, tier, hp, max_hp, ends_tick FROM world_boss WHERE status = 'active' FOR UPDATE",
  );
  const b = boss.rows[0] as
    | { id: string; tier: number; hp: string; max_hp: string; ends_tick: string }
    | undefined;
  if (!b) return { active: false, expired: false, deaths: 0, participants: [] };
  const bossId = Number(b.id);

  // Window closed → expire and distribute rewards by total_damage.
  if (tickNumber >= Number(b.ends_tick)) {
    const ended = await client.query(
      'SELECT player_id FROM world_boss_participants WHERE boss_id = $1',
      [bossId],
    );
    await distributeRewards(client, bossId, uptimeSeconds, cfg);
    await client.query("UPDATE world_boss SET status = 'expired' WHERE id = $1", [bossId]);
    return {
      active: true,
      expired: true,
      deaths: 0,
      participants: (ended.rows as { player_id: string }[]).map((r) => Number(r.player_id)),
    };
  }

  const g = cfg.gameConfig;
  const c = g.combat_coeffs;
  const maxHp = Number(b.max_hp);
  let hp = Number(b.hp);
  let tier = b.tier;
  let deaths = 0;

  // Per-participant damage roll (base stats — kept lightweight, SPEC §9).
  const parts = await client.query(
    `SELECT p.player_id, pl.str, pl.dex, pl.luck
       FROM world_boss_participants p JOIN players pl ON pl.id = p.player_id
      WHERE p.boss_id = $1`,
    [bossId],
  );
  for (const p of parts.rows as { player_id: string; str: number; dex: number; luck: number }[]) {
    let dmg = Math.max(1, Math.round(p.str * c.dmg_per_str));
    const critChance = clamp(
      0,
      0.95,
      g.crit_chance_base + p.dex * c.crit_per_dex + p.luck * c.crit_per_luck,
    );
    if (Math.random() < critChance) dmg = Math.round(dmg * g.crit_multiplier);

    await client.query(
      'UPDATE world_boss_participants SET total_damage = total_damage + $3 WHERE boss_id = $1 AND player_id = $2',
      [bossId, Number(p.player_id), dmg],
    );
    hp -= dmg;
    while (hp <= 0) {
      tier += 1;
      hp += maxHp;
      deaths += 1;
    }
  }

  await client.query('UPDATE world_boss SET hp = $2, tier = $3 WHERE id = $1', [bossId, hp, tier]);
  const participants = (parts.rows as { player_id: string }[]).map((r) => Number(r.player_id));
  return { active: true, expired: false, deaths, participants };
}

async function distributeRewards(
  client: PoolClient,
  bossId: number,
  uptimeSeconds: number,
  cfg: ConfigSnapshot,
): Promise<void> {
  const bc = bossConfig();
  const res = await client.query(
    'SELECT player_id, total_damage FROM world_boss_participants WHERE boss_id = $1',
    [bossId],
  );
  const rows = res.rows as { player_id: string; total_damage: string }[];
  const total = rows.reduce((s, r) => s + Number(r.total_damage), 0);
  if (total <= 0) return;

  for (const r of rows) {
    const dmg = Number(r.total_damage);
    if (dmg <= 0) continue;
    const playerId = Number(r.player_id);
    const goldShare = Math.floor(bc.reward_gold * (dmg / total));
    if (goldShare > 0) {
      await client.query('UPDATE players SET gold = gold + $2 WHERE id = $1', [
        playerId,
        goldShare,
      ]);
    }
    await grantGlobalBoost(client, playerId, bc.reward_boost, 'world_boss', cfg, uptimeSeconds);
  }
}
