// Builds the immutable config snapshot (SPEC §4). All config tables are read in
// one REPEATABLE READ transaction so the snapshot is a consistent point-in-time
// view, then assembled into frozen maps. NUMERIC/BIGINT columns arrive from pg
// as strings and are parsed to numbers here.

import { pool } from '../db/pool.js';
import { GAME_CONFIG_KEYS, type GameConfig } from '@eishera/shared';
import type {
  Skill,
  Item,
  Rarity,
  Activity,
  Recipe,
  Monster,
  HousingFeature,
  GlobalBoost,
} from '@eishera/shared';

export interface ConfigSnapshot {
  readonly gameConfig: GameConfig;
  /** Every game_config key→value, including keys not in the typed GameConfig. */
  readonly raw: ReadonlyMap<string, unknown>;
  readonly skills: ReadonlyMap<number, Skill>;
  readonly items: ReadonlyMap<number, Item>;
  readonly itemsByCode: ReadonlyMap<string, Item>;
  readonly rarities: ReadonlyMap<number, Rarity>;
  readonly activities: ReadonlyMap<number, Activity>;
  readonly recipes: ReadonlyMap<number, Recipe>;
  readonly monsters: ReadonlyMap<number, Monster>;
  readonly housingFeatures: ReadonlyMap<number, HousingFeature>;
  /** Keyed by boost code. */
  readonly globalBoosts: ReadonlyMap<string, GlobalBoost>;
  readonly loadedAt: number;
}

const num = (v: unknown): number => Number(v);

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export async function buildSnapshot(): Promise<ConfigSnapshot> {
  const client = await pool.connect();
  try {
    // One consistent MVCC view. Queries run sequentially on the single client
    // (concurrent queries on one connection are deprecated in pg).
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const cfg = await client.query('SELECT key, value FROM game_config');
    const skills = await client.query('SELECT id, code, name FROM skills');
    const items = await client.query(
      'SELECT id, code, name, tradable, equip_slot, base_stats, req_level, salvage_yield FROM items',
    );
    const rarities = await client.query(
      'SELECT tier, code, name, weight, roll_min, roll_max, color FROM rarities',
    );
    const activities = await client.query(
      'SELECT id, code, name, skill_id, archetype FROM activities',
    );
    const recipes = await client.query(
      'SELECT id, activity_id, code, name, req_level, base_xp, inputs, outputs FROM recipes',
    );
    const monsters = await client.query(
      'SELECT id, tier, name, hp, attack, accuracy, evasion, xp, gold_min, gold_max, loot FROM monsters',
    );
    const housing = await client.query('SELECT * FROM housing_features');
    const boosts = await client.query(
      'SELECT id, code, name, effect_type, magnitude, duration_seconds, default_source FROM global_boosts',
    );
    await client.query('COMMIT');

    const raw = new Map<string, unknown>();
    for (const r of cfg.rows as Row[]) raw.set(r.key, r.value);
    const missing = GAME_CONFIG_KEYS.filter((k) => !raw.has(k));
    if (missing.length > 0) {
      throw new Error(`game_config is missing required keys: ${missing.join(', ')}`);
    }
    const gameConfig = Object.freeze(
      Object.fromEntries(GAME_CONFIG_KEYS.map((k) => [k, raw.get(k)])),
    ) as unknown as GameConfig;

    const skillsMap = new Map<number, Skill>();
    for (const r of skills.rows as Row[]) {
      skillsMap.set(r.id, { id: r.id, code: r.code, name: r.name });
    }

    const itemsMap = new Map<number, Item>();
    const itemsByCode = new Map<string, Item>();
    for (const r of items.rows as Row[]) {
      const item: Item = {
        id: r.id,
        code: r.code,
        name: r.name,
        tradable: r.tradable,
        equip_slot: r.equip_slot,
        base_stats: r.base_stats,
        req_level: r.req_level,
        salvage_yield: r.salvage_yield,
      };
      itemsMap.set(item.id, item);
      itemsByCode.set(item.code, item);
    }

    const raritiesMap = new Map<number, Rarity>();
    for (const r of rarities.rows as Row[]) {
      raritiesMap.set(r.tier, {
        tier: r.tier,
        code: r.code,
        name: r.name,
        weight: num(r.weight),
        roll_min: num(r.roll_min),
        roll_max: num(r.roll_max),
        color: r.color,
      });
    }

    const activitiesMap = new Map<number, Activity>();
    for (const r of activities.rows as Row[]) {
      activitiesMap.set(r.id, {
        id: r.id,
        code: r.code,
        name: r.name,
        skill_id: r.skill_id,
        archetype: r.archetype,
      });
    }

    const recipesMap = new Map<number, Recipe>();
    for (const r of recipes.rows as Row[]) {
      recipesMap.set(r.id, {
        id: r.id,
        activity_id: r.activity_id,
        code: r.code,
        name: r.name,
        req_level: r.req_level,
        base_xp: r.base_xp,
        inputs: r.inputs,
        outputs: r.outputs,
      });
    }

    const monstersMap = new Map<number, Monster>();
    for (const r of monsters.rows as Row[]) {
      monstersMap.set(r.id, {
        id: r.id,
        tier: r.tier,
        name: r.name,
        hp: num(r.hp),
        attack: num(r.attack),
        accuracy: num(r.accuracy),
        evasion: num(r.evasion),
        xp: r.xp,
        gold_min: r.gold_min,
        gold_max: r.gold_max,
        loot: r.loot,
      });
    }

    const housingMap = new Map<number, HousingFeature>();
    for (const r of housing.rows as Row[]) {
      housingMap.set(r.id, {
        id: r.id,
        code: r.code,
        name: r.name,
        bonus_type: r.bonus_type,
        max_level: r.max_level,
        cost_base: num(r.cost_base),
        cost_growth: num(r.cost_growth),
        duration_base: num(r.duration_base),
        duration_growth: num(r.duration_growth),
        bonus_base: num(r.bonus_base),
        bonus_growth: num(r.bonus_growth),
        cost_resources: r.cost_resources,
      });
    }

    const boostsMap = new Map<string, GlobalBoost>();
    for (const r of boosts.rows as Row[]) {
      boostsMap.set(r.code, {
        id: r.id,
        code: r.code,
        name: r.name,
        effect_type: r.effect_type,
        magnitude: num(r.magnitude),
        duration_seconds: r.duration_seconds,
        default_source: r.default_source,
      });
    }

    return {
      gameConfig,
      raw,
      skills: skillsMap,
      items: itemsMap,
      itemsByCode,
      rarities: raritiesMap,
      activities: activitiesMap,
      recipes: recipesMap,
      monsters: monstersMap,
      housingFeatures: housingMap,
      globalBoosts: boostsMap,
      loadedAt: Date.now(),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
