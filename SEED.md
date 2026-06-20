# PBBG Seed Plan — Initial Content & Balance

Companion to `SPEC.md`. This file defines the **starting content data** (skills, items, activities, monsters, housing features) and **starting balance numbers** (`game_config`) that the spec deliberately left empty. Everything here is config — meant to be tuned freely, live, via the configurability system (SPEC Section 4). The numbers below are a *starting point* chosen to feel reasonable; calibrate after playtesting.

## How to apply

- Run the seed **after** migrations create the tables.
- Make seed inserts **idempotent** (upsert on the natural key: `code`, `tier`, or config `key`), so re-running is safe.
- Order by FK dependency: `skills` and `items` first, then `activities` (reference skills/items) and `monsters`, then `housing_features`, then `game_config` (independent).
- Treat the seed itself as data: ideally a set of JSON/SQL files the seed runner reads, not hardcoded inserts — consistent with "content is data" (SPEC Section 2.7).

---

## 1. `game_config` (scalar knobs)

| key | value | meaning |
|---|---|---|
| `tick_seconds` | `6` | action / tick duration |
| `starting_max_actions` | `1800` | default `max_actions` for new players |
| `xp_curve` | `{ "B": 60, "p": 1.4 }` | `xpToNext(L) = round(B * L^p)` |
| `xp_per_action` | `10` | flat XP granted per action (per activity may override via `base_xp`) |
| `yield_slope` | `0.02` | `yieldMult(L) = 1 + L * slope` |
| `rare` | `{ "base": 0.005, "step": 0.0005, "cap": 0.10 }` | `pRare(L) = min(cap, base + L*step)` — deliberately scarce |
| `crit_chance_base` | `0.05` | base combat crit chance before stats/gear/housing |
| `crit_multiplier` | `2` | per-round crit damage multiplier in the duel |
| `max_rounds` | `200` | per-fight round cap; reaching it without a kill = loss |
| `combat_coeffs` | `{ "dmg_per_str": 1.0, "hp_per_vit": 10, "mitigation_per_def": 0.5, "dodge_per_eva": 0.4, "accuracy_per_dex": 0.5, "crit_per_dex": 0.001, "crit_per_luck": 0.002 }` | how effective stats map to duel values (all tunable) |
| `rarity_luck_shift` | `0.02` | bounded upward re-weight of the rarity roll per point of effective LUCK (on drops) |
| `rarity_quality_shift` | `0.03` | bounded upward re-weight of the rarity roll per unit of effective craft_quality (on crafts) |
| `stat_per_level` | `{ "str": 2, "vit": 2, "def": 1, "eva": 1, "dex": 1, "luck": 1 }` | base-stat points granted per combat level-up |
| `random_stat_gain_chance` | `0.002` | chance per battle action to gain one random base-stat point |
| `cancel_penalty` | `0.15` | fixed housing-upgrade cancel penalty (refund = 1 − this) |
| `outage_threshold_seconds` | `30` | live-clock gap above which time is treated as downtime and frozen |
| `market_fee` | `0` | market transaction fee fraction (0 = none for v1) |

---

## 2. `skills`

| id | code | name |
|---|---|---|
| 1 | `mining` | Mining |
| 2 | `quarrying` | Quarrying |
| 3 | `hunting` | Hunting |
| 4 | `crafting` | Crafting |
| 5 | `alchemy` | Alchemy |
| 6 | `combat` | Combat |

---

## 3. `items`

| id | code | name | tradable | category |
|---|---|---|---|---|
| 100 | `ore` | Iron ore | true | raw (mining) |
| 101 | `stone` | Stone | true | raw (quarrying) |
| 102 | `food` | Food | true | raw (hunting) |
| 103 | `hide` | Hide | true | raw (hunting, secondary) |
| 200 | `sword` | Sword | true | equipment (weapon) |
| 201 | `armor` | Armor | true | equipment (armor) |
| 202 | `tool` | Tool | true | equipment (gathering aid) |
| 300 | `power_potion` | Power potion | true | consumable (combat buff) |
| 301 | `yield_potion` | Yield potion | true | consumable (gather buff) |
| 400 | `monster_bone` | Monster bone | true | monster drop (craft mat) |
| 401 | `dragon_scale` | Dragon scale | true | monster drop (rare craft mat) |
| 402 | `iron_scrap` | Iron scrap | true | monster drop (craft mat) |

Equippable items (`sword`/`armor`/`tool`) carry the extra config fields below; stackable items leave them NULL.

### 3.1 Equippable item stats

`base_stats` are the stat lines the type carries. When crafted/dropped, an instance first rolls a **rarity** (Section 3.2), then each stat line rolls a multiplier within that rarity's band; effective value = `base_stats[S] × rolls[S]`. `salvage_yield` is scaled by the instance's overall quality.

| item | equip_slot | base_stats | req_level | salvage_yield (base) |
|---|---|---|---|---|
| `sword` | weapon | `{ str: 12, dex: 5 }` | 1 | `iron_scrap` 2 |
| `armor` | armor | `{ def: 10, vit: 8 }` | 5 | `iron_scrap` 2, `hide` 1 |
| `tool` | tool | `{ gather_yield: 0.10 }` | 1 | `iron_scrap` 1 |

When `craft` produces one of these, the handler inserts an `item_instances` row: roll rarity (re-weighted upward by the crafter's effective `craft_quality`), then roll each stat within the rarity's band. A high-`craft_quality` crafter sees more uncommon/rare/unique pieces and higher in-band rolls — that quality gap is what gives crafted gear market value. Rolls are stored per-stat so the planned material-based re-roll is a single update.

### 3.2 `rarities` (equipment quality tiers)

A rarity is rolled by `weight`; effective LUCK (drops) / craft_quality (crafts) re-weight upward, bounded by `rarity_luck_shift` / `rarity_quality_shift`. The chosen tier's `[roll_min, roll_max]` is the band each stat rolls within. Weights below make mythic ~1 in 1,557 at base — deliberately scarce.

| tier | name | weight | roll_min | roll_max | color |
|---|---|---|---|---|---|
| 1 | `common` | 1000 | 0.75 | 0.95 | gray |
| 2 | `uncommon` | 400 | 0.90 | 1.10 | green |
| 3 | `rare` | 120 | 1.05 | 1.25 | blue |
| 4 | `unique` | 30 | 1.20 | 1.40 | purple |
| 5 | `legendary` | 6 | 1.35 | 1.55 | amber |
| 6 | `mythic` | 1 | 1.50 | 1.75 | red |

---

## 4. `activities` (verbs) + `recipes` (targets)

An **activity** is a generic verb (`mine`, `craft`, `brew`, `battle`…) — it only defines the skill and archetype. The specific thing produced or fought is a **target**:
- For transform verbs, the target is a **recipe** (which item, its inputs, its XP). All item-production details live in the recipe row.
- For the `battle` verb, the target is a **monster** referenced by `monster_id`.

The player selects a target, not just a verb: `battle` + `monster_id`, `craft` + recipe `sword`, `brew` + recipe `power_potion`, etc. The player row stores `active_recipe_id` (transform) or `active_monster_id` (combat); exactly one is set, or both NULL = idle.

### 4.1 `activities` (verbs)

| id | code | name | skill | archetype |
|---|---|---|---|---|
| 1 | `mine` | Mine | mining | transform |
| 2 | `quarry` | Quarry | quarrying | transform |
| 3 | `hunt` | Hunt | hunting | transform |
| 4 | `craft` | Craft | crafting | transform |
| 5 | `brew` | Brew | alchemy | transform |
| 6 | `battle` | Battle | combat | combat |

### 4.2 `recipes` (transform targets)

Convention: an output with `chance: 1.0` is the guaranteed base yield (quantity multiplied by `yieldMult(L)`). An output with `chance < 1.0` is a *rare* output; effective chance = listed chance boosted by `pRare(L)` plus any housing `rare_drop` bonus.

| id | code | name | activity | req_level | base_xp | inputs | outputs |
|---|---|---|---|---|---|---|---|
| 1 | `ore` | Mine ore | `mine` | 1 | 10 | — | `ore` ×1 (1.0) |
| 2 | `stone` | Quarry stone | `quarry` | 1 | 10 | — | `stone` ×1 (1.0) |
| 3 | `game` | Hunt game | `hunt` | 1 | 10 | — | `food` ×1 (1.0), `hide` ×1 (0.5) |
| 4 | `sword` | Craft sword | `craft` | 1 | 15 | `ore` ×3, `stone` ×1 | `sword` ×1 (1.0) |
| 5 | `armor` | Craft armor | `craft` | 5 | 18 | `ore` ×2, `hide` ×3 | `armor` ×1 (1.0) |
| 6 | `power_potion` | Brew power potion | `brew` | 1 | 15 | `food` ×2 | `power_potion` ×1 (1.0) |
| 7 | `yield_potion` | Brew yield potion | `brew` | 3 | 15 | `food` ×2, `ore` ×1 | `yield_potion` ×1 (1.0) |

### 4.3 Battle targets

`battle` has no recipes; its targets are the `monsters` rows (Section 5), selected by `monster_id`. XP/gold/loot come from the chosen monster. Battle is not gated by `req_level` — a weak player *can* select the dragon, they'll just lose most fights (and reach `max_rounds`). The monster choice is the player's risk/reward dial.

---

## 5. `monsters`

The player selects `battle` + a `monster_id` (= `monsters.id`). `tier` is just a difficulty grouping. Each fight is a per-action duel (SPEC 7.2): `hp` = damage to kill it, `attack` = its per-round damage, `accuracy`/`evasion` interact with your DEX/EVA. Values below assume `loot` chances roll on a win.

| id | tier | name | hp | attack | accuracy | evasion | xp | gold_min | gold_max | loot |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | Goblin | 100 | 8 | 70 | 10 | 12 | 5 | 10 | `monster_bone` (0.10) |
| 2 | 2 | Orc | 350 | 22 | 75 | 12 | 30 | 12 | 25 | `monster_bone` (0.15), `iron_scrap` (0.05) |
| 3 | 3 | Troll | 1000 | 55 | 80 | 15 | 70 | 30 | 60 | `iron_scrap` (0.12), `monster_bone` (0.20) |
| 4 | 4 | Wyvern | 2500 | 120 | 85 | 25 | 150 | 70 | 140 | `iron_scrap` (0.15), `dragon_scale` (0.03) |
| 5 | 5 | Dragon | 6000 | 280 | 90 | 30 | 300 | 150 | 400 | `dragon_scale` (0.08), `iron_scrap` (0.20) |

`loot` chances are base and roll on a win. Stackable loot (materials) drops at its listed chance, unaffected by LUCK. When a dropped item is equippable, LUCK nudges its **rarity** roll upward (bounded by `rarity_luck_shift`) — LUCK finds rarer gear, not more loot. Neither is affected by `pRare` (that governs activity rare outputs).

---

## 6. `housing_features`

Curves: `cost(L) = cost_base · L^cost_growth` (gold), resource amounts use the same growth on their base quantities, `duration(L) = duration_base · L^duration_growth` (seconds), `bonus(L) = bonus_base + L · bonus_growth`. `L` is the current level (going L→L+1 costs the level-L values).

| id | code | name | bonus_type | max_level | cost_base | cost_growth | duration_base | duration_growth | bonus_base | bonus_growth | cost_resources (base qty) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `mine_shaft` | Mine shaft | `gather_yield` | 50 | 100 | 1.6 | 300 | 1.7 | 0.00 | 0.01 | `ore` 5, `stone` 5 |
| 2 | `pantry` | Pantry | `food_yield` | 50 | 100 | 1.6 | 300 | 1.7 | 0.00 | 0.01 | `food` 8 |
| 3 | `workshop` | Workshop | `craft_quality` | 50 | 120 | 1.6 | 320 | 1.7 | 0.00 | 0.01 | `ore` 6, `stone` 4 |
| 4 | `treasury` | Treasury | `rare_drop` | 50 | 150 | 1.7 | 400 | 1.8 | 0.00 | 0.005 | `ore` 4, `stone` 4, `food` 4 |
| 5 | `training_hall` | Training hall | `combat_all` | 50 | 130 | 1.65 | 350 | 1.75 | 0.00 | 0.02 | `food` 6, `hide` 4 |

`bonus_type` strings map to the formula layer: `gather_yield`/`food_yield` add to `yieldMult`, `rare_drop` adds to `pRare`, `craft_quality` adds to the crafter quality/masterwork roll, and `combat_all` adds a % to all six effective combat stats (STR/VIT/DEF/EVA/DEX/LUCK).

---

## 7. Base stats (combat domain)

New players start with these base stats (combat only — production ignores them):

| stat | start | role in the duel |
|---|---|---|
| `str` | 5 | damage dealt per round |
| `vit` | 5 | fight HP (resets each action) |
| `def` | 5 | mitigates monster damage |
| `eva` | 5 | chance to dodge a round |
| `dex` | 5 | accuracy + crit |
| `luck` | 5 | crit + rarity-find (nudges equipment rarity up) |

Gains:
- On each **combat level-up**, grant points per `stat_per_level` config (default `str 2, vit 2, def 1, eva 1, dex 1, luck 1`) — a fixed distribution.
- On each **battle action**, a low `random_stat_gain_chance` (default 0.2%) grants one random base-stat point.
- Equipment, potions, and global boosts add on top as *effective* bonuses (not permanent base gains).

---

## 8. Global boosts & active effects

Potions and global boosts both flow through the **same runtime mechanism** (`player_active_effects`), but global boosts keep their **own catalog** (`global_boosts`) and every grant is written to **`global_boost_log`** for admin review. All durations are measured against the live clock (`uptime_seconds`) — they freeze on downtime, just like housing.

### 8.1 Potion → effect mapping (consuming a potion creates an effect)

| item | effect_type | magnitude | duration (s) |
|---|---|---|---|
| `power_potion` | `combat_all` | +0.20 | 1800 |
| `yield_potion` | `gather_yield` | +0.25 | 1800 |

### 8.2 `global_boosts` catalog (examples)

| id | code | name | effect_type | magnitude | duration_seconds | default_source |
|---|---|---|---|---|---|---|
| 1 | `xp_surge_24h` | XP surge (24h) | `xp` | +0.50 | 86400 | token |
| 2 | `harvest_boon_12h` | Harvest boon (12h) | `gather_yield` | +0.30 | 43200 | token |
| 3 | `battle_fury_1h` | Battle fury (1h) | `combat_all` | +0.25 | 3600 | event |
| 4 | `boss_fortune_2h` | Boss spoils: fortune | `rare_drop` | +0.10 | 7200 | world_boss |
| 5 | `veterans_edge` | Veteran's edge | `xp` | +0.10 | NULL (permanent) | token |

Stacking is per-effect config (`sum` / `highest` / `unique`); a sensible default is: same `effect_type` from different sources **sum**, an identical source **replaces** (refreshes duration).

---

## 9. Balance illustration (so the numbers are grounded)

### XP curve pacing
`xpToNext(L) = round(60 · L^1.4)`, at 10 XP/action, 6s/action:

| level → next | XP needed | actions | time |
|---|---|---|---|
| 1 → 2 | 60 | 6 | ~36 s |
| 5 → 6 | 571 | 57 | ~6 min |
| 10 → 11 | 1,506 | 151 | ~15 min |
| 25 → 26 | 5,462 | 546 | ~55 min |
| 50 → 51 | 14,443 | 1,444 | ~2.4 h |
| 100 → 101 | 37,857 | 3,786 | ~6.3 h |
| 200 → 201 | 99,923 | 9,992 | ~16.7 h |

No cap; high levels are long-haul prestige and accrue offline. Tune steepness with `p`, overall scale with `B`.

### Workshop upgrade curve (feature `workshop`)
`cost(L)=120·L^1.6` gold, `duration(L)=320·L^1.7` seconds, resources `ore 6·L^1.6`, `stone 4·L^1.6`, bonus `+1%/level`:

| level → next | gold | ore | stone | duration | cumulative bonus at target |
|---|---|---|---|---|---|
| 1 → 2 | 120 | 6 | 4 | ~5 min | +2% |
| 5 → 6 | ~1,580 | ~79 | ~53 | ~1.3 h | +6% |
| 11 → 12 | ~5,560 | ~278 | ~185 | ~4.9 h | +12% |
| 20 → 21 | ~12,500 | ~625 | ~417 | ~14.6 h | +21% |
| 50 (max) | ~72,000 | ~3,600 | ~2,400 | ~66 h | +50% |

The earlier "6h 13m 47s" was an illustrative number; the curve above produces ~4.9h for 11→12. Nudge `duration_base`/`duration_growth` to taste — it's live config.

---

## 10. Open items to resolve

The seed now fully wires the gathering/production/combat **loop** (per-action duel, base stats, active effects) **and equipment** (per-stat instanced rolls, equip slots, salvage sink, instance market). What remains is minor:

1. **Equipment stats + instancing. — RESOLVED.** Minimal `item_instances` (type + per-stat `rolls` JSONB; effective = `base_stats × rolls`), `player_equipment` slots, salvage/disenchant sink, and `instance_listings` (auction-style market for non-fungible gear). Per-stat rolls chosen to support the future material-based re-roll. See SPEC §3.2/§3.3/§7.1/§10.

2. **Potion buffs (active effects). — RESOLVED.** Handled by `player_active_effects` (SPEC §3.3) with the potion→effect mapping in §8.1.

3. **Rare-output vs item rarity. — RESOLVED.** `pRare` (scarce: base 0.005, cap 0.10) governs whether an *activity* yields a rare output. Item `rarity` (common→mythic) is the quality tier of an equipment instance, rolled on craft/drop and re-weighted upward by craft_quality (crafts) or LUCK (drops), bounded. The two are independent; LUCK affects rarity, not `pRare`; monster material loot drops at its listed chance.

**The v1 design is now complete** — every system across `SPEC.md` and this seed is specified end to end. Remaining work is content authoring (filling in more items/recipes/monsters/housing rows — all pure config) and balance calibration (tuning the numbers after playtest).
