// Read-only projection of the config snapshot for the client (GET /config).
// The SPA needs content (to render selection lists, names, prices) and the
// formula constants (to predict smooth values via @eishera/shared — SPEC §13).
// This deliberately exposes display + constants only: no RNG, no per-player or
// authoritative state ever flows through here.

import { getConfig } from './store.js';
import type { GameCatalog } from '@eishera/shared';

export function buildCatalog(): GameCatalog {
  const cfg = getConfig();
  const chat = cfg.raw.get('chat') as { channels: string[]; max_length: number };
  const tokenCosts = (cfg.raw.get('boost_token_costs') ?? {}) as Record<string, number>;

  return {
    tick_seconds: cfg.gameConfig.tick_seconds,
    xp_curve: cfg.gameConfig.xp_curve,
    xp_per_action: cfg.gameConfig.xp_per_action,
    yield_slope: cfg.gameConfig.yield_slope,
    rare: cfg.gameConfig.rare,
    chat: { channels: chat.channels, max_length: chat.max_length },
    skills: [...cfg.skills.values()],
    activities: [...cfg.activities.values()].map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      skill_id: a.skill_id,
      archetype: a.archetype,
    })),
    recipes: [...cfg.recipes.values()].map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      activity_id: r.activity_id,
      req_level: r.req_level,
      inputs: r.inputs.map((i) => ({ item: i.item, qty: i.qty })),
      outputs: r.outputs.map((o) =>
        o.chance === undefined
          ? { item: o.item, qty: o.qty }
          : { item: o.item, qty: o.qty, chance: o.chance },
      ),
    })),
    monsters: [...cfg.monsters.values()].map((m) => ({
      id: m.id,
      name: m.name,
      tier: m.tier,
      hp: m.hp,
      attack: m.attack,
      xp: m.xp,
      gold_min: m.gold_min,
      gold_max: m.gold_max,
    })),
    items: [...cfg.items.values()].map((i) => ({
      id: i.id,
      code: i.code,
      name: i.name,
      equip_slot: i.equip_slot,
      tradable: i.tradable,
    })),
    housing: [...cfg.housingFeatures.values()].map((h) => ({
      id: h.id,
      code: h.code,
      name: h.name,
      bonus_type: h.bonus_type,
      max_level: h.max_level,
    })),
    rarities: [...cfg.rarities.values()].map((r) => ({
      tier: r.tier,
      name: r.name,
      color: r.color,
    })),
    boosts: [...cfg.globalBoosts.values()].map((b) => ({
      code: b.code,
      name: b.name,
      effect_type: b.effect_type,
      magnitude: b.magnitude,
      duration_seconds: b.duration_seconds,
      cost: tokenCosts[b.code] ?? null,
    })),
  };
}
