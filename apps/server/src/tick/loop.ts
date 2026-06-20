// The single heartbeat (SPEC §6). Every tick_seconds, one atomic transaction
// advances the world by exactly one tick: read world_state FOR UPDATE, advance
// the live clock (§5), run the per-tick steps, increment tick_number, commit.
// The world is therefore always exactly at a tick boundary. On crash, at most
// the in-flight (uncommitted) tick is lost; on restart we resume from the last
// committed world_state.
//
// Phase 3 is the tick CORE: the active-set / boss / housing steps are present as
// structure but carry no game logic yet (that arrives in Phases 4–6).

import { pool, withTransaction } from '../db/pool.js';
import { getConfig } from '../config/store.js';
import { liveClockStep } from './clock.js';
import { processTransform } from '../actions/transform.js';
import { processCombat } from '../combat/handler.js';
import { completeUpgradeJobs } from '../housing/service.js';
import { pushToPlayer } from '../ws/registry.js';
import type { BattleResult } from '@eishera/shared';

export interface WorldState {
  tick_number: number;
  uptime_seconds: number;
  last_tick_at: Date | null;
}

export interface TickResult {
  tickNumber: number;
  uptimeSeconds: number;
  outage: boolean;
  activeCount: number;
  housingCompleted: number;
  battles: { playerId: number; result: BattleResult }[];
}

/** Create the singleton world_state row if it doesn't exist yet. */
export async function ensureWorldState(): Promise<void> {
  await pool.query('INSERT INTO world_state (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING');
}

export async function readWorldState(): Promise<WorldState> {
  const res = await pool.query(
    'SELECT tick_number, uptime_seconds, last_tick_at FROM world_state WHERE id = TRUE',
  );
  const row = res.rows[0] as
    | { tick_number: string; uptime_seconds: string; last_tick_at: Date | null }
    | undefined;
  if (!row) throw new Error('world_state row missing — call ensureWorldState() first');
  return {
    tick_number: Number(row.tick_number),
    uptime_seconds: Number(row.uptime_seconds),
    last_tick_at: row.last_tick_at,
  };
}

/**
 * Execute exactly one tick inside a single transaction. Returns the new state.
 * Uses the DB's now() (the transaction time) for the live-clock delta so app and
 * DB clocks can't drift apart.
 */
export async function runTick(): Promise<TickResult> {
  const snapshot = getConfig();
  const cfg = snapshot.gameConfig;
  const tickSeconds = cfg.tick_seconds;
  const outageThreshold = cfg.outage_threshold_seconds;

  return withTransaction(async (client) => {
    // 1. Lock + read world_state; measure elapsed since the last tick in-DB.
    const sel = await client.query(
      `SELECT tick_number, uptime_seconds,
              now() AS now,
              EXTRACT(EPOCH FROM (now() - last_tick_at))::float8 AS delta_sec
         FROM world_state
        WHERE id = TRUE
          FOR UPDATE`,
    );
    const row = sel.rows[0] as {
      tick_number: string;
      uptime_seconds: string;
      now: Date;
      delta_sec: number | null;
    };

    const deltaSec = row.delta_sec === null ? null : Number(row.delta_sec);
    const { uptimeDelta, outage } = liveClockStep(deltaSec, tickSeconds, outageThreshold);
    const newUptime = Number(row.uptime_seconds) + uptimeDelta;
    const newTick = Number(row.tick_number) + 1;

    // 2. ACTIONS (active set). Lock the active players and run one action each:
    //    a transform recipe (Phase 4) or a battle (Phase 5). Exactly one target
    //    is set per player (DB CHECK). All writes are part of this one tick txn.
    const battles: { playerId: number; result: BattleResult }[] = [];
    const active = await client.query(
      `SELECT id, active_recipe_id, active_monster_id FROM players
        WHERE actions_remaining > 0
          AND (active_recipe_id IS NOT NULL OR active_monster_id IS NOT NULL)
        FOR UPDATE`,
    );
    for (const r of active.rows as {
      id: string;
      active_recipe_id: number | null;
      active_monster_id: number | null;
    }[]) {
      const playerId = Number(r.id);
      if (r.active_recipe_id !== null) {
        const recipe = snapshot.recipes.get(r.active_recipe_id);
        if (recipe) await processTransform(client, playerId, recipe, snapshot, newUptime);
      } else if (r.active_monster_id !== null) {
        const monster = snapshot.monsters.get(r.active_monster_id);
        if (monster) {
          const result = await processCombat(client, playerId, monster, snapshot, newUptime);
          battles.push({ playerId, result });
        }
      }
    }
    const activeCount = active.rows.length;

    // 3. WORLD BOSS — Phase 8.
    // 4. HOUSING COMPLETION: apply any upgrade jobs whose live-clock timer is due.
    //    Measured against uptime_seconds, so downtime freezes them (§5, §12.3).
    const housingCompleted = await completeUpgradeJobs(client, newUptime);

    // 5. Advance tick_number + live clock. last_tick_at = the now() we just read.
    await client.query(
      'UPDATE world_state SET tick_number = $1, uptime_seconds = $2, last_tick_at = $3 WHERE id = TRUE',
      [newTick, newUptime, row.now],
    );

    return {
      tickNumber: newTick,
      uptimeSeconds: newUptime,
      outage,
      activeCount,
      housingCompleted,
      battles,
    };
  });
}

/** Push each battle's result to the player's room (after the tick commits). */
function pushBattleResults(battles: { playerId: number; result: BattleResult }[]): void {
  for (const b of battles) {
    pushToPlayer(b.playerId, 'battle', b.result);
  }
}

// ── heartbeat scheduling ─────────────────────────────────────────────────────
// One setTimeout chain (not setInterval) so a slow tick can never overlap the
// next. The interval reads tick_seconds from the live config snapshot each time,
// so retuning it takes effect without a restart.

let stopped = true;
let timer: ReturnType<typeof setTimeout> | null = null;

async function tickOnce(): Promise<void> {
  if (stopped) return;
  try {
    const r = await runTick();
    // Side effects (websocket pushes) happen AFTER the tick commits.
    pushBattleResults(r.battles);
    console.log(
      `[tick] #${r.tickNumber} uptime=${r.uptimeSeconds}s active=${r.activeCount}` +
        (r.battles.length > 0 ? ` battles=${r.battles.length}` : '') +
        (r.housingCompleted > 0 ? ` housing=${r.housingCompleted}` : '') +
        (r.outage ? ' (outage — clock frozen)' : ''),
    );
  } catch (err) {
    console.error('[tick] error (will retry next interval):', err);
  }
  if (!stopped) {
    const tickSeconds = getConfig().gameConfig.tick_seconds;
    timer = setTimeout(() => void tickOnce(), tickSeconds * 1000);
  }
}

export function startTickLoop(): void {
  if (!stopped) return;
  stopped = false;
  timer = setTimeout(() => void tickOnce(), 0);
}

export function stopTickLoop(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
