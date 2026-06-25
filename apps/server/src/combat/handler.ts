// Combat archetype handler (SPEC §7.2). Runs inside the tick transaction, once
// per active battling player per tick. Computes effective stats, resolves the
// duel, then applies outcomes:
//   win  → combat XP (+ base-stat points per level gained), gold, loot (equippable
//          loot is a LUCK-nudged item_instance; stackable loot stacks);
//   loss → nothing.
// Every action also has a small random_stat_gain_chance to grant one base point.
// Returns the BattleResult summary for the websocket (round log is not persisted).

import type { PoolClient } from 'pg';
import { gainXp, xpScale } from '@eishera/shared';
import type { Monster, BattleResult, LootDrop } from '@eishera/shared';
import type { ConfigSnapshot } from '../config/snapshot.js';
import { computeEffectiveStats, COMBAT_STATS, type CombatStat } from './stats.js';
import { simulateDuel } from './duel.js';
import { rollRarity, rollStats } from '../actions/rolls.js';
import { xpMultiplier } from '../effects/boosts.js';

type Rng = () => number;
const randInt = (min: number, max: number, rng: Rng): number =>
  min + Math.floor(rng() * (max - min + 1));

export async function processCombat(
  client: PoolClient,
  playerId: number,
  monster: Monster,
  cfg: ConfigSnapshot,
  uptimeSeconds: number,
  rng: Rng = Math.random,
): Promise<BattleResult> {
  const g = cfg.gameConfig;
  const eff = await computeEffectiveStats(client, playerId, uptimeSeconds, cfg);
  const duel = simulateDuel(eff, monster, g, rng);
  // Captured once so the result can flag whether a boost was active (the detail
  // view shows "Bonus active"), and reused for the win-path XP gain below.
  const xpMult = await xpMultiplier(client, playerId, uptimeSeconds);

  // Base-stat deltas (level-up distribution + random gain) and gold, applied in
  // one player UPDATE at the end. They affect FUTURE actions, not this one.
  const statDelta: Record<CombatStat, number> = { str: 0, vit: 0, def: 0, eva: 0, dex: 0, luck: 0 };
  let goldGain = 0;
  let xpGain = 0;
  let levelsGained = 0;
  const loot: LootDrop[] = [];

  if (duel.won) {
    // Combat XP + level-ups → base-stat points per stat_per_level. XP scales with
    // combat level (xpScale) and any active boost, mirroring transform XP.
    const combatSkill = [...cfg.skills.values()].find((s) => s.code === 'combat');
    if (combatSkill) {
      const skRes = await client.query(
        'SELECT level, xp FROM player_skills WHERE player_id = $1 AND skill_id = $2 FOR UPDATE',
        [playerId, combatSkill.id],
      );
      const sk = skRes.rows[0] as { level: number; xp: string } | undefined;
      if (sk) {
        xpGain = Math.round(monster.xp * xpScale(sk.level, g.xp_slope) * xpMult);
        const gained = gainXp(sk.level, Number(sk.xp), xpGain, g.xp_curve);
        levelsGained = gained.level - sk.level;
        await client.query(
          'UPDATE player_skills SET level = $3, xp = $4 WHERE player_id = $1 AND skill_id = $2',
          [playerId, combatSkill.id, gained.level, gained.xp],
        );
        if (levelsGained > 0) {
          const dist = g.stat_per_level;
          for (const stat of COMBAT_STATS) statDelta[stat] += levelsGained * (dist[stat] ?? 0);
        }
      }
    }

    // Gold.
    goldGain = randInt(monster.gold_min, monster.gold_max, rng);

    // Loot. Equippable → LUCK-nudged item_instance; stackable → inventory.
    for (const entry of monster.loot) {
      if (rng() >= entry.chance) continue;
      const item = cfg.itemsByCode.get(entry.item);
      if (!item) continue;
      const qty = entry.qty ?? 1;
      if (item.equip_slot) {
        for (let k = 0; k < qty; k++) {
          const rarity = rollRarity([...cfg.rarities.values()], g.rarity_luck_shift, eff.luck, rng);
          const rolls = rollStats(item.base_stats ?? {}, rarity, rng);
          await client.query(
            'INSERT INTO item_instances (item_id, owner_id, rarity, rolls) VALUES ($1, $2, $3, $4::jsonb)',
            [item.id, playerId, rarity.tier, JSON.stringify(rolls)],
          );
        }
      } else {
        await client.query(
          `INSERT INTO inventory (player_id, item_id, qty) VALUES ($1, $2, $3)
           ON CONFLICT (player_id, item_id) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`,
          [playerId, item.id, qty],
        );
      }
      loot.push({ item: entry.item, qty });
    }
  }

  // Random base-stat gain (every action, win or loss).
  if (rng() < g.random_stat_gain_chance) {
    const stat = COMBAT_STATS[Math.floor(rng() * COMBAT_STATS.length)]!;
    statDelta[stat] += 1;
  }

  // Single player write: gold, base-stat deltas, action consumed.
  await client.query(
    `UPDATE players SET
       gold = gold + $2,
       str = str + $3, vit = vit + $4, def = def + $5,
       eva = eva + $6, dex = dex + $7, luck = luck + $8,
       actions_remaining = actions_remaining - 1
     WHERE id = $1`,
    [
      playerId,
      goldGain,
      statDelta.str,
      statDelta.vit,
      statDelta.def,
      statDelta.eva,
      statDelta.dex,
      statDelta.luck,
    ],
  );

  return {
    monster: monster.name,
    rounds: duel.rounds,
    damage_dealt: duel.damage_dealt,
    damage_taken: duel.damage_taken,
    won: duel.won,
    crit_count: duel.crit_count,
    gold: goldGain,
    xp: xpGain,
    loot,
    player_hits: duel.player_hits,
    player_misses: duel.player_misses,
    monster_hits: duel.monster_hits,
    monster_misses: duel.monster_misses,
    player_hp: duel.player_hp,
    player_max_hp: duel.player_max_hp,
    monster_hp: duel.monster_hp,
    monster_max_hp: duel.monster_max_hp,
    boosted: xpMult > 1,
    levels_gained: levelsGained,
  };
}
