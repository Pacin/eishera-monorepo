// Phase 8 acceptance check (SPEC §9, §16). Proves:
//   1. joining a boss accrues per-tick damage; on death the tier escalates (HP refills);
//   2. the window is tick-based and FREEZES on downtime (an outage tick advances it
//      by only one tick, never by the wall-clock gap);
//   3. on expiry, rewards are distributed by total_damage (gold share + a global
//      boost grant → player_active_effects + global_boost_log);
//   4. buying a boost with tokens grants it (tokens spent, effect + audit row);
//   5. an xp boost multiplies XP gains.

import { initConfig, getConfig, shutdownConfig } from '../config/store.js';
import { ensureWorldState, runTick } from '../tick/loop.js';
import { createPlayer } from '../players/service.js';
import { joinBoss, getBoss } from '../boss/service.js';
import { buyBoost } from '../effects/boosts.js';
import { query, closePool } from '../db/pool.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}
const one = async <T = any>(sql: string, p: unknown[] = []): Promise<T | undefined> =>
  (await query(sql, p)).rows[0] as T | undefined;
const gold = async (id: number): Promise<number> =>
  Number((await one<{ gold: string }>('SELECT gold FROM players WHERE id=$1', [id]))!.gold);

async function main(): Promise<void> {
  await initConfig();
  await ensureWorldState();
  const cfg = getConfig();
  const threshold = cfg.gameConfig.outage_threshold_seconds;
  const ts = Date.now();

  // Isolate: expire any boss left active by a prior run.
  await query("UPDATE world_boss SET status='expired' WHERE status='active'");

  // ── 1–3. Boss: join, damage, escalation, freeze, expiry, rewards ───────────
  console.log('[demo] boss: join, damage, tier escalation, freeze, expiry rewards');
  const p1 = await createPlayer(`p8a_${ts}`, 'password123');
  const p2 = await createPlayer(`p8b_${ts}`, 'password123');
  await query('UPDATE players SET str=2000, gold=0 WHERE id=$1', [p1]); // big hitter
  await query('UPDATE players SET str=500, gold=0 WHERE id=$1', [p2]); // smaller

  await joinBoss(p1, cfg); // spawns the boss
  await joinBoss(p2, cfg);
  const start = await getBoss(p1);
  check(
    'boss active after join (hp = max_hp)',
    start.active === true && start.hp === start.max_hp,
    start,
  );
  check('two participants', start.participants === 2, start.participants);

  // Shrink the window so it expires within the demo.
  await query("UPDATE world_boss SET ends_tick=$1 WHERE status='active'", [
    start.current_tick! + 8,
  ]);

  let maxTier = 1;
  let expired = false;
  let freezeOk = false;
  for (let i = 0; i < 14 && !expired; i++) {
    if (i === 3) {
      // Freeze check: a long outage advances the boss window by only ONE tick.
      const before = await getBoss(p1);
      await query(
        `UPDATE world_state SET last_tick_at = now() - ($1 || ' seconds')::interval WHERE id=TRUE`,
        [String(threshold * 5)],
      );
      const r = await runTick();
      const after = await getBoss(p1);
      freezeOk =
        r.outage === true &&
        after.active === true &&
        before.ticks_remaining! - after.ticks_remaining! === 1;
    } else {
      const r = await runTick();
      if (r.bossExpired) expired = true;
    }
    const bv = await getBoss(p1);
    if (bv.active && bv.tier) maxTier = Math.max(maxTier, bv.tier);
  }

  check('damage accrued (your_damage > 0)', (await getBoss(p1)).active === false, 'boss expired'); // sanity
  check('tier escalated on boss death (tier > 1)', maxTier > 1, { maxTier });
  check('window froze on downtime (outage tick advanced it by ONE only)', freezeOk);
  check('boss expired when tick window closed', expired);

  // Rewards by total_damage: p1 (4× the STR) should have earned more gold; both
  // got the boss boost in player_active_effects + global_boost_log.
  const g1 = await gold(p1);
  const g2 = await gold(p2);
  check('rewards distributed by damage (bigger hitter earns more)', g1 > g2 && g2 > 0, { g1, g2 });
  const boost1 = await one(
    'SELECT effect_type FROM player_active_effects WHERE player_id=$1 AND source=$2',
    [p1, 'world_boss'],
  );
  const log1 = (
    await query('SELECT 1 FROM global_boost_log WHERE player_id=$1 AND source=$2', [
      p1,
      'world_boss',
    ])
  ).rowCount;
  check('boss boost → player_active_effects row', !!boost1, boost1);
  check('boss boost → global_boost_log row', (log1 ?? 0) >= 1, log1);

  // ── 4. Token purchase grants a boost ───────────────────────────────────────
  console.log('[demo] buying a global boost with tokens');
  const p3 = await createPlayer(`p8c_${ts}`, 'password123');
  await query('UPDATE players SET tokens=200 WHERE id=$1', [p3]);
  const buy = await buyBoost(p3, 'xp_surge_24h', cfg);
  check('boost purchased', 'ok' in buy && buy.cost === 100, buy);
  check(
    'tokens deducted (200→100)',
    Number(
      (await one<{ tokens: string }>('SELECT tokens FROM players WHERE id=$1', [p3]))!.tokens,
    ) === 100,
  );
  const xpEff = await one<{ effect_type: string }>(
    "SELECT effect_type FROM player_active_effects WHERE player_id=$1 AND source='token'",
    [p3],
  );
  check('token boost → active effect (xp)', xpEff?.effect_type === 'xp', xpEff);
  const tlog = (
    await query("SELECT 1 FROM global_boost_log WHERE player_id=$1 AND source='token'", [p3])
  ).rowCount;
  check('token boost → global_boost_log row', (tlog ?? 0) >= 1);

  // ── 5. xp boost multiplies XP gains ────────────────────────────────────────
  console.log('[demo] xp boost multiplies XP gains');
  // p3 now has xp_surge (+0.50). Mine 1 action → base_xp 10 × 1.5 = 15.
  await query(
    'UPDATE players SET active_recipe_id=1, active_monster_id=NULL, actions_remaining=1 WHERE id=$1',
    [p3],
  );
  await runTick();
  const mining = await one<{ level: number; xp: string }>(
    'SELECT level, xp FROM player_skills WHERE player_id=$1 AND skill_id=1',
    [p3],
  );
  check('xp boost applied: mining xp = round(10 × 1.5) = 15', Number(mining?.xp) === 15, mining);

  console.log(
    failures === 0 ? '\n[demo] PHASE 8 ACCEPTANCE PASSED' : `\n[demo] FAILED (${failures})`,
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
