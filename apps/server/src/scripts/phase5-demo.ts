// Phase 5 acceptance check (SPEC §7.2, §8, §14). Proves:
//   1. a battle action returns rounds + damage dealt/taken;
//   2. equipping a higher-rolled sword measurably raises damage dealt;
//   3. a potion raises effective stats (combat_all);
//   4. winning grants XP + gold (+ possible loot); losing grants nothing;
//   5. a combat level-up grants base-stat points per stat_per_level.

import { initConfig, getConfig, shutdownConfig } from '../config/store.js';
import { ensureWorldState } from '../tick/loop.js';
import { createPlayer } from '../players/service.js';
import { effectiveStatsForPlayer } from '../combat/stats.js';
import { simulateDuel } from '../combat/duel.js';
import { processCombat } from '../combat/handler.js';
import { equipInstance } from '../equipment/service.js';
import { consumePotion } from '../effects/service.js';
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

const SKILL_COMBAT = 6;
const ITEM_SWORD = 200;
const POWER_POTION = 300;

async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await query(sql, params);
  return r.rows[0] as T | undefined;
}

async function main(): Promise<void> {
  await initConfig();
  await ensureWorldState();
  const cfg = getConfig();
  const goblin = cfg.monsters.get(1)!;
  const dragon = cfg.monsters.get(5)!;
  const ts = Date.now();

  // ── 1. A battle returns rounds + damage ────────────────────────────────────
  console.log('[demo] battle returns a result summary');
  const fighter = await createPlayer(`p5f_${ts}`, 'password123');
  // Tanky enough to land several hits before the fight ends.
  await query('UPDATE players SET str=30, vit=100, def=50, dex=50 WHERE id=$1', [fighter]);
  const battle = await withTransaction((c) => processCombat(c, fighter, goblin, cfg, 0));
  check('result has rounds > 0', battle.rounds > 0, battle.rounds);
  check('damage_dealt > 0', battle.damage_dealt > 0, battle.damage_dealt);
  check(
    'summary shape (won/taken/crit/loot)',
    typeof battle.won === 'boolean' && Array.isArray(battle.loot),
  );
  console.log(
    `     → "${battle.monster}": ${battle.damage_dealt} dealt / ${battle.damage_taken} taken in ${battle.rounds} rounds, won=${battle.won}`,
  );

  // ── 2. Equipping a higher-rolled sword raises damage dealt ─────────────────
  console.log('[demo] equipping a sword raises damage dealt (avg of 300 duels)');
  const swordsman = await createPlayer(`p5s_${ts}`, 'password123');
  const effBefore = await effectiveStatsForPlayer(swordsman, cfg);

  const inst = await one<{ id: string }>(
    `INSERT INTO item_instances (item_id, owner_id, rarity, rolls)
     VALUES ($1, $2, 4, '{"str":1.5,"dex":1.2}'::jsonb) RETURNING id`,
    [ITEM_SWORD, swordsman],
  );
  const equipResult = await equipInstance(swordsman, Number(inst!.id), cfg);
  check('equip succeeded', 'ok' in equipResult, equipResult);
  const effAfter = await effectiveStatsForPlayer(swordsman, cfg);
  check('effective STR rose from equipment', effAfter.str > effBefore.str, {
    before: effBefore.str,
    after: effAfter.str,
  });

  const avgDamage = (eff: typeof effBefore): number => {
    let total = 0;
    const N = 300;
    for (let i = 0; i < N; i++) total += simulateDuel(eff, goblin, cfg.gameConfig).damage_dealt;
    return total / N;
  };
  const dmgNoSword = avgDamage(effBefore);
  const dmgWithSword = avgDamage(effAfter);
  check('avg damage dealt rises with sword', dmgWithSword > dmgNoSword * 1.2, {
    dmgNoSword,
    dmgWithSword,
  });
  console.log(
    `     → avg damage: ${dmgNoSword.toFixed(1)} (base) → ${dmgWithSword.toFixed(1)} (sword)`,
  );

  // ── 3. A potion raises effective stats ─────────────────────────────────────
  console.log('[demo] power potion raises effective stats (combat_all +20%)');
  const drinker = await createPlayer(`p5p_${ts}`, 'password123');
  await query(`INSERT INTO inventory (player_id, item_id, qty) VALUES ($1, $2, 1)`, [
    drinker,
    POWER_POTION,
  ]);
  const before = await effectiveStatsForPlayer(drinker, cfg);
  const consume = await consumePotion(drinker, 'power_potion', cfg);
  check('potion consumed → effect created', !('error' in consume), consume);
  const after = await effectiveStatsForPlayer(drinker, cfg);
  check('effective STR ×1.2 after potion', Math.abs(after.str - before.str * 1.2) < 1e-6, {
    before: before.str,
    after: after.str,
  });

  // ── 4. Win grants XP + gold; loss grants nothing ───────────────────────────
  console.log('[demo] win grants xp + gold; loss grants nothing');
  // Deterministic win: one-shot + rng=0.5 (hit, no crit, no loot, no random gain).
  const winner = await createPlayer(`p5w_${ts}`, 'password123');
  await query('UPDATE players SET str=100000, dex=100000 WHERE id=$1', [winner]);
  const winRes = await withTransaction((c) => processCombat(c, winner, goblin, cfg, 0, () => 0.5));
  const wp = await one<{ gold: string }>('SELECT gold FROM players WHERE id=$1', [winner]);
  const wskill = await one<{ xp: string }>(
    'SELECT xp FROM player_skills WHERE player_id=$1 AND skill_id=$2',
    [winner, SKILL_COMBAT],
  );
  check('won the fight', winRes.won === true, winRes);
  check('xp granted = monster.xp', winRes.xp === goblin.xp, winRes.xp);
  check(
    'gold within monster range',
    winRes.gold >= goblin.gold_min && winRes.gold <= goblin.gold_max,
    winRes.gold,
  );
  check('player.gold increased', Number(wp?.gold) === winRes.gold, wp);
  check('combat skill xp increased', Number(wskill?.xp) === goblin.xp, wskill);

  // Deterministic loss: base stats vs dragon, rng=0.5 (always miss, monster one-shots).
  const loser = await createPlayer(`p5l_${ts}`, 'password123');
  const lossRes = await withTransaction((c) => processCombat(c, loser, dragon, cfg, 0, () => 0.5));
  const lp = await one<{ gold: string }>('SELECT gold FROM players WHERE id=$1', [loser]);
  const lskill = await one<{ xp: string }>(
    'SELECT xp FROM player_skills WHERE player_id=$1 AND skill_id=$2',
    [loser, SKILL_COMBAT],
  );
  check('lost the fight', lossRes.won === false, lossRes);
  check('no xp on loss', lossRes.xp === 0, lossRes.xp);
  check('no gold on loss', lossRes.gold === 0 && Number(lp?.gold) === 0, {
    result: lossRes.gold,
    db: lp?.gold,
  });
  check('no combat xp on loss', Number(lskill?.xp) === 0, lskill);

  // ── 5. Combat level-up grants base-stat points ─────────────────────────────
  console.log('[demo] combat level-up grants base stats per stat_per_level');
  const veteran = await createPlayer(`p5v_${ts}`, 'password123');
  await query('UPDATE players SET str=100000, dex=100000 WHERE id=$1', [veteran]);
  // xpToNext(1)=60; set combat xp to 55 so one goblin win (xp 12) levels to L2.
  await query('UPDATE player_skills SET level=1, xp=55 WHERE player_id=$1 AND skill_id=$2', [
    veteran,
    SKILL_COMBAT,
  ]);
  const baseBefore = await one<any>('SELECT str,vit,def,eva,dex,luck FROM players WHERE id=$1', [
    veteran,
  ]);
  await withTransaction((c) => processCombat(c, veteran, goblin, cfg, 0, () => 0.5));
  const lvl = await one<{ level: number }>(
    'SELECT level FROM player_skills WHERE player_id=$1 AND skill_id=$2',
    [veteran, SKILL_COMBAT],
  );
  const baseAfter = await one<any>('SELECT str,vit,def,eva,dex,luck FROM players WHERE id=$1', [
    veteran,
  ]);
  const dist = cfg.gameConfig.stat_per_level;
  check('combat level → 2', lvl?.level === 2, lvl);
  check('str += stat_per_level.str', baseAfter.str - baseBefore.str === dist.str, {
    d: baseAfter.str - baseBefore.str,
    exp: dist.str,
  });
  check('vit += stat_per_level.vit', baseAfter.vit - baseBefore.vit === dist.vit, {
    d: baseAfter.vit - baseBefore.vit,
    exp: dist.vit,
  });
  check('def += stat_per_level.def', baseAfter.def - baseBefore.def === dist.def);
  check('luck += stat_per_level.luck', baseAfter.luck - baseBefore.luck === dist.luck);

  console.log(
    failures === 0 ? '\n[demo] PHASE 5 ACCEPTANCE PASSED' : `\n[demo] FAILED (${failures})`,
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
