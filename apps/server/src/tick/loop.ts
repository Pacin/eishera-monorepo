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

    // 2. ACTIONS (active set). Phase 4: transform recipes only — lock the active
    //    transform players and run one action each. Combat (active_monster_id)
    //    arrives in Phase 5. Each player's writes are part of this one tick txn.
    const active = await client.query(
      `SELECT id, active_recipe_id FROM players
        WHERE actions_remaining > 0 AND active_recipe_id IS NOT NULL
        FOR UPDATE`,
    );
    for (const r of active.rows as { id: string; active_recipe_id: number }[]) {
      const recipe = snapshot.recipes.get(r.active_recipe_id);
      if (recipe) await processTransform(client, Number(r.id), recipe, snapshot);
    }
    const activeCount = active.rows.length;

    // 3. WORLD BOSS — Phase 8.   4. HOUSING COMPLETION — Phase 6.

    // 5. Advance tick_number + live clock. last_tick_at = the now() we just read.
    await client.query(
      'UPDATE world_state SET tick_number = $1, uptime_seconds = $2, last_tick_at = $3 WHERE id = TRUE',
      [newTick, newUptime, row.now],
    );

    return { tickNumber: newTick, uptimeSeconds: newUptime, outage, activeCount };
  });
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
    console.log(
      `[tick] #${r.tickNumber} uptime=${r.uptimeSeconds}s active=${r.activeCount}` +
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
