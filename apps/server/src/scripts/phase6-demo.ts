// Phase 6 acceptance check (SPEC §12, §14). Proves:
//   1. two concurrent upgrades cannot start (service + DB unique-index guarantee);
//   2. downtime FREEZES the timer (an outage tick advances uptime by only one
//      interval, so a job whose live-clock deadline hasn't been reached does NOT
//      complete despite a large wall-clock gap); normal progress does complete it;
//   3. cancel refunds (1 − cancel_penalty) of the paid_snapshot — even after the
//      cost config changes live;
//   4. housing bonuses feed the formula layer (gather / rare / craft / combat).

import { initConfig, getConfig, reloadConfig, shutdownConfig } from '../config/store.js';
import { ensureWorldState, runTick } from '../tick/loop.js';
import { createPlayer } from '../players/service.js';
import { startUpgrade, cancelUpgrade, computeUpgradeCost } from '../housing/service.js';
import { computeProductionModifiers } from '../actions/modifiers.js';
import { effectiveStatsForPlayer } from '../combat/stats.js';
import { query, withTransaction, closePool } from '../db/pool.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const F_MINE = 1;
const F_WORKSHOP = 3;
const F_TREASURY = 4;
const F_TRAINING = 5;
const ORE = 100;
const STONE = 101;

const one = async <T = any>(sql: string, p: unknown[] = []): Promise<T | undefined> =>
  (await query(sql, p)).rows[0] as T | undefined;
const setLevel = (pid: number, fid: number, lvl: number) =>
  query('UPDATE player_housing SET level=$3 WHERE player_id=$1 AND feature_id=$2', [pid, fid, lvl]);

async function main(): Promise<void> {
  await initConfig();
  await ensureWorldState();
  const cfg = getConfig();
  const ts = Date.now();

  // ── 1. One upgrade at a time ───────────────────────────────────────────────
  console.log('[demo] one upgrade at a time');
  const p1 = await createPlayer(`p6a_${ts}`, 'password123');
  await query('UPDATE players SET gold=100000 WHERE id=$1', [p1]);
  await query(`INSERT INTO inventory (player_id,item_id,qty) VALUES ($1,$2,1000),($1,$3,1000)`, [
    p1,
    ORE,
    STONE,
  ]);
  // Level 1 so 1→2 has real cost + duration (0→1 is free+instant with seed curves).
  await setLevel(p1, F_WORKSHOP, 1);
  await setLevel(p1, F_MINE, 1);

  const start1 = await startUpgrade(p1, F_WORKSHOP, cfg);
  check('first upgrade starts', 'ok' in start1, start1);
  const start2 = await startUpgrade(p1, F_MINE, cfg);
  check(
    'second upgrade rejected (service)',
    'error' in start2 && start2.error === 'upgrade_in_progress',
    start2,
  );

  let dbBlocked = false;
  try {
    await query(
      `INSERT INTO housing_upgrade_jobs (player_id, feature_id, target_level, start_live, completes_live, paid_snapshot, status)
       VALUES ($1, 2, 2, 0, 100, '{}'::jsonb, 'in_progress')`,
      [p1],
    );
  } catch (e) {
    dbBlocked = (e as { code?: string }).code === '23505';
  }
  check('DB unique index blocks a 2nd in_progress job', dbBlocked);

  // ── 2. Downtime freezes the timer ──────────────────────────────────────────
  console.log('[demo] downtime freezes the upgrade timer');
  const job = await one<{ completes_live: string }>(
    "SELECT completes_live FROM housing_upgrade_jobs WHERE player_id=$1 AND status='in_progress'",
    [p1],
  );
  const completes = Number(job!.completes_live);
  const tick = cfg.gameConfig.tick_seconds;
  const threshold = cfg.gameConfig.outage_threshold_seconds;

  // Just before completion: a normal tick must NOT complete it.
  await query('UPDATE world_state SET uptime_seconds=$1, last_tick_at=now() WHERE id=TRUE', [
    completes - 10,
  ]);
  await runTick();
  let lvl = await one<{ level: number }>(
    'SELECT level FROM player_housing WHERE player_id=$1 AND feature_id=$2',
    [p1, F_WORKSHOP],
  );
  check('not completed before deadline', lvl?.level === 1, lvl);

  // Long outage (gap >> remaining): uptime advances by only one interval → frozen.
  await query(
    `UPDATE world_state SET last_tick_at = now() - ($1 || ' seconds')::interval WHERE id=TRUE`,
    [String(threshold * 5)],
  );
  const before = await one<{ uptime_seconds: string }>(
    'SELECT uptime_seconds FROM world_state WHERE id=TRUE',
  );
  const r = await runTick();
  const advanced = r.uptimeSeconds - Number(before!.uptime_seconds);
  check('outage detected', r.outage === true);
  check('uptime advanced by ONE interval only (frozen)', advanced === tick, { advanced, tick });
  lvl = await one('SELECT level FROM player_housing WHERE player_id=$1 AND feature_id=$2', [
    p1,
    F_WORKSHOP,
  ]);
  check('still not completed despite long wall-clock gap', (lvl as any)?.level === 1, lvl);

  // Now reach the deadline normally → completes.
  await query('UPDATE world_state SET uptime_seconds=$1, last_tick_at=now() WHERE id=TRUE', [
    completes,
  ]);
  await runTick();
  lvl = await one('SELECT level FROM player_housing WHERE player_id=$1 AND feature_id=$2', [
    p1,
    F_WORKSHOP,
  ]);
  check('completes when live-clock deadline reached → level 2', (lvl as any)?.level === 2, lvl);
  const doneJob = await one(
    'SELECT status FROM housing_upgrade_jobs WHERE player_id=$1 AND feature_id=$2 ORDER BY id DESC LIMIT 1',
    [p1, F_WORKSHOP],
  );
  check('job marked completed (slot freed)', (doneJob as any)?.status === 'completed', doneJob);

  // ── 3. Cancel refunds from paid_snapshot, even after cost config changes ────
  console.log('[demo] cancel refunds from paid_snapshot (immune to live cost change)');
  const p2 = await createPlayer(`p6c_${ts}`, 'password123');
  await query('UPDATE players SET gold=100000 WHERE id=$1', [p2]);
  await query(`INSERT INTO inventory (player_id,item_id,qty) VALUES ($1,$2,1000),($1,$3,1000)`, [
    p2,
    ORE,
    STONE,
  ]);
  await setLevel(p2, F_WORKSHOP, 1);
  const origCost = computeUpgradeCost(cfg.housingFeatures.get(F_WORKSHOP)!, 1);
  await startUpgrade(p2, F_WORKSHOP, cfg);
  const goldAfterStart = Number(
    (await one<{ gold: string }>('SELECT gold FROM players WHERE id=$1', [p2]))!.gold,
  );
  check('gold deducted by cost', goldAfterStart === 100000 - origCost.gold, {
    goldAfterStart,
    cost: origCost.gold,
  });

  // Change the workshop cost config LIVE (a new upgrade would now cost more).
  await query('UPDATE housing_features SET cost_base=99999 WHERE id=$1', [F_WORKSHOP]);
  await reloadConfig('phase6-test');
  const cfg2 = getConfig();
  const cancel = await cancelUpgrade(p2, cfg2);
  const factor = 1 - cfg2.gameConfig.cancel_penalty;
  const expectGold = Math.floor(origCost.gold * factor);
  check(
    'refund gold = floor(snapshot.gold × (1−penalty)), NOT new cost',
    'refund' in cancel && cancel.refund.gold === expectGold,
    cancel,
  );
  const goldAfterCancel = Number(
    (await one<{ gold: string }>('SELECT gold FROM players WHERE id=$1', [p2]))!.gold,
  );
  check('player gold credited with refund', goldAfterCancel === goldAfterStart + expectGold, {
    goldAfterCancel,
  });
  // restore config
  await query('UPDATE housing_features SET cost_base=$2 WHERE id=$1', [
    F_WORKSHOP,
    cfg.housingFeatures.get(F_WORKSHOP)!.cost_base,
  ]);
  await reloadConfig('phase6-restore');

  // ── 4. Bonuses feed the formula layer ──────────────────────────────────────
  console.log('[demo] housing bonuses feed yield / rare / craft / combat');
  const p3 = await createPlayer(`p6b_${ts}`, 'password123');
  await setLevel(p3, F_MINE, 10); // gather_yield +1%/lvl → +0.10
  await setLevel(p3, F_TREASURY, 10); // rare_drop +0.5%/lvl → +0.05
  await setLevel(p3, F_WORKSHOP, 10); // craft_quality +1%/lvl → +0.10
  await setLevel(p3, F_TRAINING, 10); // combat_all +2%/lvl → +0.20
  const cfg3 = getConfig();
  const mods = await withTransaction((c) => computeProductionModifiers(c, p3, 0, cfg3));
  check(
    'mine_shaft → gather_yield ≈ 0.10',
    Math.abs(mods.gatherYield - 0.1) < 1e-9,
    mods.gatherYield,
  );
  check('treasury → rare_drop ≈ 0.05', Math.abs(mods.rareDrop - 0.05) < 1e-9, mods.rareDrop);
  check(
    'workshop → craft_quality ≈ 0.10',
    Math.abs(mods.craftQuality - 0.1) < 1e-9,
    mods.craftQuality,
  );
  const eff = await effectiveStatsForPlayer(p3, cfg3);
  check(
    'training_hall → combat_all: effective STR = 5×1.20 = 6',
    Math.abs(eff.str - 6) < 1e-9,
    eff.str,
  );

  console.log(
    failures === 0 ? '\n[demo] PHASE 6 ACCEPTANCE PASSED' : `\n[demo] FAILED (${failures})`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error('[demo] error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void shutdownConfig().finally(() => closePool());
  });
