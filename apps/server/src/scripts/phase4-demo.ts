// Phase 4 acceptance check (SPEC §7.1, §8, §14). Creates players, sets them an
// activity, and drives runTick() directly (no websocket → this IS offline
// processing) to prove:
//   1. an offline player's banked actions are processed down to 0;
//   2. output + XP are correct (deterministic XP/level, plausible yield);
//   3. crafting a sword produces an item_instances row with rolled stats inside
//      the chosen rarity's band, inputs consumed, XP granted.

import { initConfig, getConfig, shutdownConfig } from '../config/store.js';
import { ensureWorldState, runTick } from '../tick/loop.js';
import { createPlayer } from '../players/service.js';
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

const ORE = 100;
const STONE = 101;
const SKILL_MINING = 1;
const SKILL_CRAFTING = 4;
const RECIPE_ORE = 1;
const RECIPE_SWORD = 4;
const ITEM_SWORD = 200;

async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await query(sql, params);
  return r.rows[0] as T | undefined;
}

async function main(): Promise<void> {
  await initConfig();
  await ensureWorldState();
  const ts = Date.now();

  // ── 1. Offline gathering: 20 banked actions → processed down to 0 ──────────
  console.log('[demo] offline gathering (mine ore × 20 actions)');
  const gatherer = await createPlayer(`p4g_${ts}`, 'password123');
  await query('UPDATE players SET active_recipe_id = $2, actions_remaining = 20 WHERE id = $1', [
    gatherer,
    RECIPE_ORE,
  ]);

  let ticks = 0;
  for (let i = 0; i < 40; i++) {
    const before = await one<{ actions_remaining: number }>(
      'SELECT actions_remaining FROM players WHERE id = $1',
      [gatherer],
    );
    if (!before || before.actions_remaining === 0) break;
    await runTick();
    ticks++;
  }

  const gp = await one<{ actions_remaining: number }>(
    'SELECT actions_remaining FROM players WHERE id = $1',
    [gatherer],
  );
  check('offline player processed down to 0 actions', gp?.actions_remaining === 0, gp);
  check('took 20 ticks (1 action/tick)', ticks === 20, ticks);

  const mining = await one<{ level: number; xp: string }>(
    'SELECT level, xp FROM player_skills WHERE player_id = $1 AND skill_id = $2',
    [gatherer, SKILL_MINING],
  );
  // 20 actions × 10xp = 200. xpToNext(1)=60 → L2 after 6 actions; 140 left < xpToNext(2)=158.
  check('mining level = 2', mining?.level === 2, mining);
  check('mining xp = 140', Number(mining?.xp) === 140, mining);

  const ore = await one<{ qty: string }>(
    'SELECT qty FROM inventory WHERE player_id = $1 AND item_id = $2',
    [gatherer, ORE],
  );
  const oreQty = Number(ore?.qty ?? 0);
  // Expected ≈ 6×yieldMult(1) + 14×yieldMult(2) ≈ 20.7; probabilistic rounding.
  check('ore yield ≈ actions (level-scaled)', oreQty >= 20 && oreQty <= 26, oreQty);

  // ── 2. Crafting a sword → an item instance with rolled stats ───────────────
  console.log('[demo] craft a sword (equippable → item_instances)');
  const crafter = await createPlayer(`p4c_${ts}`, 'password123');
  await query(`INSERT INTO inventory (player_id, item_id, qty) VALUES ($1, $2, 10), ($1, $3, 5)`, [
    crafter,
    ORE,
    STONE,
  ]);
  await query('UPDATE players SET active_recipe_id = $2, actions_remaining = 1 WHERE id = $1', [
    crafter,
    RECIPE_SWORD,
  ]);
  await runTick();

  const cp = await one<{ actions_remaining: number }>(
    'SELECT actions_remaining FROM players WHERE id = $1',
    [crafter],
  );
  check('craft action consumed (1 → 0)', cp?.actions_remaining === 0, cp);

  const oreLeft = await one<{ qty: string }>(
    'SELECT qty FROM inventory WHERE player_id = $1 AND item_id = $2',
    [crafter, ORE],
  );
  const stoneLeft = await one<{ qty: string }>(
    'SELECT qty FROM inventory WHERE player_id = $1 AND item_id = $2',
    [crafter, STONE],
  );
  check('inputs consumed: ore 10 → 7', Number(oreLeft?.qty) === 7, oreLeft);
  check('inputs consumed: stone 5 → 4', Number(stoneLeft?.qty) === 4, stoneLeft);

  const crafting = await one<{ level: number; xp: string }>(
    'SELECT level, xp FROM player_skills WHERE player_id = $1 AND skill_id = $2',
    [crafter, SKILL_CRAFTING],
  );
  check('crafting xp = 15', Number(crafting?.xp) === 15, crafting);

  const inst = await one<{ item_id: number; rarity: number; rolls: any }>(
    'SELECT item_id, rarity, rolls FROM item_instances WHERE owner_id = $1',
    [crafter],
  );
  check(
    'one sword instance created (not stacked in inventory)',
    inst?.item_id === ITEM_SWORD,
    inst,
  );
  const swordInInventory = await one(
    'SELECT 1 FROM inventory WHERE player_id = $1 AND item_id = $2',
    [crafter, ITEM_SWORD],
  );
  check('sword NOT in stackable inventory', swordInInventory === undefined);

  if (inst) {
    const rarity = getConfig().rarities.get(inst.rarity);
    check('valid rarity tier (1..6)', !!rarity, inst.rarity);
    const rolls = inst.rolls as Record<string, number | undefined>;
    const strRoll = rolls.str;
    const dexRoll = rolls.dex;
    check(
      'rolls present for str & dex',
      typeof strRoll === 'number' && typeof dexRoll === 'number',
      rolls,
    );
    if (rarity && typeof strRoll === 'number' && typeof dexRoll === 'number') {
      const inBand = (v: number) => v >= rarity.roll_min && v <= rarity.roll_max;
      check(
        `str roll ${strRoll} within ${rarity.code} band [${rarity.roll_min}, ${rarity.roll_max}]`,
        inBand(strRoll),
      );
      check(`dex roll ${dexRoll} within band`, inBand(dexRoll));
      // Effective stat = base × roll (SPEC §3.3): sword base str 12.
      console.log(
        `     → effective STR = 12 × ${strRoll} = ${(12 * strRoll).toFixed(2)} (${rarity.name})`,
      );
    }
  }

  console.log(
    failures === 0 ? '\n[demo] PHASE 4 ACCEPTANCE PASSED' : `\n[demo] FAILED (${failures})`,
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
