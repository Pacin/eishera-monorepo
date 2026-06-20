// Idempotent seed runner (SEED §How to apply). Upserts on the natural key so
// re-running is safe, ordered by FK dependency. Runs in ONE transaction with
// app.suppress_config_events='on', so the bulk load doesn't spam config_audit
// or trigger a reload storm. Run after migrations: `pnpm seed`.

import type { PoolClient } from 'pg';
import { withTransaction, closePool } from '../db/pool.js';
import * as data from './data.js';

const json = (v: unknown): string | null =>
  v === null || v === undefined ? null : JSON.stringify(v);

async function upsertMany<T>(
  client: PoolClient,
  label: string,
  sql: string,
  rows: T[],
  toParams: (row: T) => unknown[],
): Promise<void> {
  for (const row of rows) {
    await client.query(sql, toParams(row));
  }
  console.log(`[seed] ${label}: ${rows.length} rows`);
}

async function run(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("SELECT set_config('app.suppress_config_events', 'on', true)");

    await upsertMany(
      client,
      'skills',
      `INSERT INTO skills (id, code, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name`,
      data.skills,
      (s) => [s.id, s.code, s.name],
    );

    await upsertMany(
      client,
      'items',
      `INSERT INTO items (id, code, name, tradable, equip_slot, base_stats, req_level, salvage_yield)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code, name = EXCLUDED.name, tradable = EXCLUDED.tradable,
         equip_slot = EXCLUDED.equip_slot, base_stats = EXCLUDED.base_stats,
         req_level = EXCLUDED.req_level, salvage_yield = EXCLUDED.salvage_yield`,
      data.items,
      (i) => [
        i.id,
        i.code,
        i.name,
        i.tradable,
        i.equip_slot,
        json(i.base_stats),
        i.req_level,
        json(i.salvage_yield),
      ],
    );

    await upsertMany(
      client,
      'rarities',
      `INSERT INTO rarities (tier, code, name, weight, roll_min, roll_max, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tier) DO UPDATE SET
         code = EXCLUDED.code, name = EXCLUDED.name, weight = EXCLUDED.weight,
         roll_min = EXCLUDED.roll_min, roll_max = EXCLUDED.roll_max, color = EXCLUDED.color`,
      data.rarities,
      (r) => [r.tier, r.code, r.name, r.weight, r.roll_min, r.roll_max, r.color],
    );

    await upsertMany(
      client,
      'activities',
      `INSERT INTO activities (id, code, name, skill_id, archetype)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code, name = EXCLUDED.name, skill_id = EXCLUDED.skill_id, archetype = EXCLUDED.archetype`,
      data.activities,
      (a) => [a.id, a.code, a.name, a.skill_id, a.archetype],
    );

    await upsertMany(
      client,
      'recipes',
      `INSERT INTO recipes (id, activity_id, code, name, req_level, base_xp, inputs, outputs)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         activity_id = EXCLUDED.activity_id, code = EXCLUDED.code, name = EXCLUDED.name,
         req_level = EXCLUDED.req_level, base_xp = EXCLUDED.base_xp,
         inputs = EXCLUDED.inputs, outputs = EXCLUDED.outputs`,
      data.recipes,
      (r) => [
        r.id,
        r.activity_id,
        r.code,
        r.name,
        r.req_level,
        r.base_xp,
        json(r.inputs),
        json(r.outputs),
      ],
    );

    await upsertMany(
      client,
      'monsters',
      `INSERT INTO monsters (id, tier, name, hp, attack, accuracy, evasion, xp, gold_min, gold_max, loot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         tier = EXCLUDED.tier, name = EXCLUDED.name, hp = EXCLUDED.hp, attack = EXCLUDED.attack,
         accuracy = EXCLUDED.accuracy, evasion = EXCLUDED.evasion, xp = EXCLUDED.xp,
         gold_min = EXCLUDED.gold_min, gold_max = EXCLUDED.gold_max, loot = EXCLUDED.loot`,
      data.monsters,
      (m) => [
        m.id,
        m.tier,
        m.name,
        m.hp,
        m.attack,
        m.accuracy,
        m.evasion,
        m.xp,
        m.gold_min,
        m.gold_max,
        json(m.loot),
      ],
    );

    await upsertMany(
      client,
      'housing_features',
      `INSERT INTO housing_features
         (id, code, name, bonus_type, max_level, cost_base, cost_growth,
          duration_base, duration_growth, bonus_base, bonus_growth, cost_resources)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code, name = EXCLUDED.name, bonus_type = EXCLUDED.bonus_type,
         max_level = EXCLUDED.max_level, cost_base = EXCLUDED.cost_base, cost_growth = EXCLUDED.cost_growth,
         duration_base = EXCLUDED.duration_base, duration_growth = EXCLUDED.duration_growth,
         bonus_base = EXCLUDED.bonus_base, bonus_growth = EXCLUDED.bonus_growth,
         cost_resources = EXCLUDED.cost_resources`,
      data.housingFeatures,
      (h) => [
        h.id,
        h.code,
        h.name,
        h.bonus_type,
        h.max_level,
        h.cost_base,
        h.cost_growth,
        h.duration_base,
        h.duration_growth,
        h.bonus_base,
        h.bonus_growth,
        json(h.cost_resources),
      ],
    );

    await upsertMany(
      client,
      'global_boosts',
      `INSERT INTO global_boosts (id, code, name, effect_type, magnitude, duration_seconds, default_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code, name = EXCLUDED.name, effect_type = EXCLUDED.effect_type,
         magnitude = EXCLUDED.magnitude, duration_seconds = EXCLUDED.duration_seconds,
         default_source = EXCLUDED.default_source`,
      data.globalBoosts,
      (b) => [
        b.id,
        b.code,
        b.name,
        b.effect_type,
        b.magnitude,
        b.duration_seconds,
        b.default_source,
      ],
    );

    await upsertMany(
      client,
      'game_config',
      `INSERT INTO game_config (key, value, description) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description`,
      data.gameConfig,
      (g) => [g.key, json(g.value), g.description],
    );
  });
  console.log('[seed] done.');
}

run()
  .catch((err: unknown) => {
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
