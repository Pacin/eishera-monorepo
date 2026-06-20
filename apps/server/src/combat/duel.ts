// Per-action duel (SPEC §7.2). One 6s action = one full fight, resolved as an
// internal multi-round duel. The monster is fought fresh at full HP every action;
// HP does not persist between actions. Pure given (stats, monster, coeffs, rng) —
// the round-by-round log is not kept, only the summary.
//
// Formulas use combat_coeffs (all config-tunable, SEED §1):
//   player hit chance   = atkAcc / (atkAcc + monster.evasion), atkAcc = DEX·accuracy_per_dex
//   player crit chance  = crit_chance_base + DEX·crit_per_dex + LUCK·crit_per_luck
//   player damage       = STR·dmg_per_str  (×crit_multiplier on crit)
//   player dodge chance = dodgeVal / (dodgeVal + monster.accuracy), dodgeVal = EVA·dodge_per_eva
//   monster damage      = max(1, monster.attack − DEF·mitigation_per_def)
//   player fight-HP      = VIT·hp_per_vit

import type { Monster } from '@eishera/shared';
import type { GameConfig } from '@eishera/shared';
import type { EffectiveStats } from './stats.js';

export interface DuelSummary {
  rounds: number;
  damage_dealt: number;
  damage_taken: number;
  won: boolean;
  crit_count: number;
}

type Rng = () => number;
const clamp = (lo: number, hi: number, v: number): number => Math.max(lo, Math.min(hi, v));

export function simulateDuel(
  eff: EffectiveStats,
  monster: Monster,
  cfg: GameConfig,
  rng: Rng = Math.random,
): DuelSummary {
  const c = cfg.combat_coeffs;

  const atkAcc = eff.dex * c.accuracy_per_dex;
  const hitChance = clamp(0.05, 0.95, atkAcc / (atkAcc + monster.evasion));
  const critChance = clamp(
    0,
    0.95,
    cfg.crit_chance_base + eff.dex * c.crit_per_dex + eff.luck * c.crit_per_luck,
  );
  const hitDamage = Math.max(1, Math.round(eff.str * c.dmg_per_str));

  const dodgeVal = eff.eva * c.dodge_per_eva;
  const dodgeChance = clamp(0, 0.95, dodgeVal / (dodgeVal + monster.accuracy));
  const monsterDamage = Math.max(1, Math.round(monster.attack - eff.def * c.mitigation_per_def));

  let monsterHp = monster.hp;
  let playerHp = Math.max(1, Math.round(eff.vit * c.hp_per_vit));
  let damageDealt = 0;
  let damageTaken = 0;
  let critCount = 0;
  let won = false;
  let rounds = 0;

  for (let r = 0; r < cfg.max_rounds; r++) {
    rounds = r + 1;

    // Player attacks.
    if (rng() < hitChance) {
      let dmg = hitDamage;
      if (rng() < critChance) {
        dmg = Math.round(dmg * cfg.crit_multiplier);
        critCount++;
      }
      monsterHp -= dmg;
      damageDealt += dmg;
    }
    if (monsterHp <= 0) {
      won = true;
      break;
    }

    // Monster attacks (player may dodge).
    if (rng() >= dodgeChance) {
      playerHp -= monsterDamage;
      damageTaken += monsterDamage;
    }
    if (playerHp <= 0) {
      won = false;
      break;
    }
  }

  // Reaching max_rounds without a kill is a loss (SPEC §7.2).
  return {
    rounds,
    damage_dealt: damageDealt,
    damage_taken: damageTaken,
    won,
    crit_count: critCount,
  };
}
