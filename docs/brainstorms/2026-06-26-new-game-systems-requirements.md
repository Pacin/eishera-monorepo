---
date: 2026-06-26
topic: new-game-systems
---

# New Game Systems — Portfolio Requirements

## Summary

Five new systems for Eishera, the tick-based idle MMORPG, each chosen to compound with existing mechanics rather than bolt on: **Contracts & Quests** (directed goals + economy engine), **Skill Mastery** (per-skill perk trees), **Expeditions** (multi-tick PvE runs), **Guilds** (cooperative social layer), and **Pets/Companions** (passive helpers). Recommended build order: Contracts → Mastery → Expeditions → Guilds → Pets. This doc captures each as a brief so planning can sequence and spec them without re-deriving product behavior.

## Problem Frame

Eishera has deep individual systems — gathering, crafting, alchemy, combat, an order-book market, housing, a shared world boss, boosts, and social/chat — but three structural gaps limit retention and depth:

- **No directed goals.** A player picks an activity, but nothing in the game asks them to do anything. A new player has no answer to "what should I do next?" beyond grinding the activity they happened to open.
- **The economy is dormant.** The market exists with `market_fee = 0` and no systemic demand. Materials circulate only when one player happens to want what another happens to gather. There is no faucet/sink the designer controls.
- **Progression is flat and solitary.** Leveling a skill grants linear yield/XP scaling with no choices. There is a *shared* world boss but no *team* — chat exists, but no group identity. Maxed players have no endgame.

The five systems target these gaps from different angles. Contracts answers "what next" and turns on the economy; Mastery and Expeditions add depth and endgame to the solo loop; Guilds and Pets add social and automation axes.

## Key Decisions

- **Portfolio brief, not five specs.** Each system is captured at brief depth — enough for planning to scope and sequence, not a full design. Tuning numbers, data models, and UI layouts are deferred to planning per system.
- **Sequence by dependency and leverage, not size.** Contracts first because it has zero dependency on the other new systems, delivers day-1 value, and activates the market. Each later system can assume the earlier ones exist (e.g. Guild contracts assume Contracts; combat contracts assume Expeditions).
- **Reuse over rebuild.** Every system is anchored to existing infrastructure (the duel engine, the modifier-aggregation pipeline, the live-clock/tick model, the order book, the world-boss damage-share logic). New net infrastructure is minimized; where a system needs significant new infra (Pets), it is sequenced last.
- **Preserve the idle/async model.** Nothing requires two players to be online simultaneously. Competitive or cooperative interactions resolve against snapshots or aggregate over ticks, consistent with the existing single-heartbeat design.

## Actors

- A1. **Player** — the individual account; the primary actor for every system.
- A2. **Guild** — a player-formed group with a roster, shared resources, and collective goals (Guilds system).
- A3. **System/Designer** — the server-driven authority that issues contracts, rotates expeditions, distributes seasonal rewards, and tunes faucets/sinks via `game_config`.

---

## System 1 — Contracts & Quests

**Core outcome:** At any time a player has a board of time-boxed objectives ("deliver 50 ore", "craft 5 swords", "slay 10 orcs") that pay gold/tokens/XP on completion, giving every session a goal and creating designer-controlled demand in the market.

### Requirements

**Contract structure**
- R1. A contract names an objective (deliver an item quantity, perform N actions of an activity, or kill N of a monster), a reward, and an expiry tied to the live clock.
- R2. Contracts come in recurring cadences (at minimum daily and weekly) that refresh on a fixed window measured against the live clock, so refresh freezes during downtime like other timed mechanics.
- R3. A player holds a bounded number of active contracts at once; completing or abandoning one frees a slot.

**Completion and economy**
- R4. Delivery contracts consume the delivered items from inventory on turn-in; progress contracts (actions/kills) track passively as the player performs qualifying actions each tick.
- R5. Rewards draw from gold, tokens, and skill XP; the reward mix per contract is a designer-tunable faucet via `game_config`.
- R6. Delivery objectives create real market demand: a player who lacks the items can buy them from the order book rather than gather them, with no special-casing — the contract simply needs the items in inventory.

### Scope boundaries
- In: daily/weekly cadence, the three objective types above, gold/token/XP rewards, a turn-in flow.
- Deferred for later: branching/story quests, NPC dialogue, contract chains, reputation tiers.

### Leverage points
- `apps/server/src/market/orders.ts` — delivery objectives drive buy demand into the existing order book.
- The transform/combat action paths (`apps/server/src/actions/`, `apps/server/src/combat/`) — progress tracking hooks into action resolution.
- The live-clock/tick model (`apps/server/src/tick/`) — refresh windows and expiry reuse the downtime-aware clock.

---

## System 2 — Skill Mastery

**Core outcome:** Leveling a skill stops being purely linear — at milestones a player earns a mastery point to spend in a small per-skill perk tree, turning flat progression into meaningful build choices that feed the bonuses already aggregated for gathering, crafting, and combat.

### Requirements

- R7. A player earns a mastery point at fixed skill-level milestones (e.g. every N levels) per skill, independently per skill.
- R8. Each skill has a small perk tree; spending a point grants a passive bonus scoped to that skill's activities (e.g. rare-drop chance while mining, chance to not consume inputs when crafting, crit bonus vs. higher-tier monsters in combat).
- R9. Perk bonuses feed the existing modifier aggregation as an additional source, alongside equipment, active effects, and housing — they do not introduce a parallel bonus path.
- R10. Mastery allocation is viewable and, at minimum, respec-able under a designer-defined rule (free, cost, or locked — resolved in planning).

### Scope boundaries
- In: per-skill milestone points, a small perk tree per skill, bonuses routed through the existing modifier pipeline.
- Deferred for later: cross-skill synergies, prestige interaction, active (non-passive) abilities.

### Leverage points
- `apps/server/src/actions/modifiers.ts` — already merges `gatherYield`, `foodYield`, `craftQuality`, `rareDrop`, `combat_all` from three sources; perks plug in as a fourth.
- The per-skill XP/level system (`packages/shared/src/formulas/`) — milestones key off existing skill levels.

---

## System 3 — Expeditions

**Core outcome:** Combat stops being an infinite grind against one monster — an Expedition is a structured run where successive ticks auto-resolve a chain of encounters culminating in a mini-boss, with loot and rare-gear odds that escalate toward the finish.

### Requirements

- R11. An expedition is a selectable combat target composed of an ordered sequence of encounters (multiple monsters ending in a tougher final encounter).
- R12. Each tick advances the run by one encounter, resolved by the existing duel engine; the run occupies the player's single active-target slot like any other activity.
- R13. Reward scales along the chain: finishing the full run pays meaningfully more (including elevated rare/legendary gear odds) than the sum of its individual encounters.
- R14. Failure is defined: losing an encounter (or hitting the round cap) ends the run early with a partial reward proportional to progress, not a total loss.
- R15. Expeditions gate by combat level and/or required gear so a tier is a goal to reach, not immediately farmable.

### Scope boundaries
- In: single-player sequenced runs, partial-on-fail rewards, level/gear gating, escalating loot.
- Deferred for later: group/guild expeditions, persistent HP across encounters, consumable use mid-run, branching routes.

### Leverage points
- `apps/server/src/combat/duel.ts` and `combat/handler.ts` — encounter resolution reuses the duel/stat engine verbatim.
- The active-set tick processing (`apps/server/src/tick/loop.ts`) — a run is a multi-step active target.
- The rarity/loot-roll tables (`apps/server/src/config/catalog.ts`, `packages/shared/src/formulas/`) — escalating drops reuse the existing rarity curve and LUCK nudges.

---

## System 4 — Guilds

**Core outcome:** Players form persistent groups with a shared identity — a roster, a shared bank, a guild chat channel, and collective goals (notably aggregated world-boss contribution) — making the game's social ties durable rather than ephemeral chat.

### Requirements

**Membership and communication**
- R16. A player can create or join exactly one guild; a guild has a roster with at least a leader role and member role, and join/leave/kick operations.
- R17. A guild has its own chat channel, added to the existing channel set.

**Shared resources and goals**
- R18. A guild has a shared bank that members can deposit gold/items into and authorized roles can withdraw from, with the same atomic, lock-ordered safety as existing gold transfers.
- R19. World-boss participation aggregates by guild: per-participant damage is summed into a guild total, producing a guild leaderboard for the event and a guild-scoped reward (e.g. a shared boost) in addition to individual rewards.
- R20. Guilds expose at least one collective goal beyond the boss — guild contracts (assuming the Contracts system) where members contribute toward a shared objective for a guild-wide reward.

### Scope boundaries
- In: single-guild membership, basic roles, guild chat, shared bank, guild boss aggregation, guild contracts.
- Deferred for later: guild-vs-guild PvP, guild halls/upgrades, fine-grained permission tiers, alliances.

### Leverage points
- `apps/server/src/chat/service.ts` — guild channel is an extension of the existing channel model.
- `apps/server/src/social/service.ts` (gold `/wire`, lock-ordered transfers) — the shared-bank deposit/withdraw reuses the atomic-transfer pattern.
- `apps/server/src/boss/service.ts` — already tracks `total_damage` per participant; guild aggregation sums over members.
- Boost/effect plumbing (`apps/server/src/effects/`) — guild-scoped rewards can be granted as global boosts.

---

## System 5 — Pets/Companions

**Core outcome:** Players acquire companions that provide passive benefits — at minimum a steady passive bonus, optionally light automation (e.g. trickle gathering or combat assistance) — adding the idle-genre's collection-and-passive-income axis.

### Requirements

- R21. A player can acquire, own, and equip/activate at least one companion at a time; companions are a new ownable entity distinct from gear instances.
- R22. An active companion grants a passive effect routed through the existing modifier/effect aggregation, so its bonus stacks with equipment, perks, effects, and housing consistently.
- R23. Companion acquisition has at least one designer-controlled source (token purchase, expedition/boss drop, or contract reward — resolved in planning), giving it a place in the existing reward economy.
- R24. If companions level or grow, growth keys off player activity (actions performed, fights won) consistent with the tick model.

### Scope boundaries
- In: ownership, one active companion granting a passive bonus, an acquisition source, optional simple growth.
- Deferred for later: multiple simultaneous companions, companion-specific active abilities, breeding/fusion, companion gear.

### Leverage points
- `apps/server/src/actions/modifiers.ts` and `apps/server/src/effects/` — companion bonuses route through the existing aggregation rather than a new path.
- The catalog/config store (`apps/server/src/config/catalog.ts`, `game_config`) — companion definitions and acquisition odds live as tunable config.
- The instance/ownership patterns (`apps/server/src/inventory/`) — companion ownership mirrors existing owned-entity handling.

---

## Dependencies / Assumptions

- **Sequencing dependencies.** Guild contracts (R20) assume Contracts & Quests exists. Combat-objective contracts and companion-from-expedition drops are richer once Expeditions exists. Mastery, Expeditions, and the Contracts core have no dependency on each other and could be reordered.
- **Modifier pipeline is the shared spine.** Mastery (R9), Pets (R22), and any future bonus source assume `actions/modifiers.ts` remains the single aggregation point for player bonuses. If that assumption breaks, all three need rework.
- **Live-clock discipline.** Every time-boxed mechanic (contract refresh/expiry, expedition pacing) assumes the existing downtime-aware live clock so timers freeze during outages, matching housing/boost/boss behavior.
- **Population assumption.** Guilds' value (R19, R20) scales with concurrent population; if the active player base is very small at launch, Guilds delivers less and its sequencing position (fourth) reflects that.

## Success Criteria

- **Contracts:** a new player always has a visible next objective within their first session; market order volume rises measurably after launch (the dormant-economy gap closes).
- **Mastery:** players make non-trivial perk choices (allocation distributions are not uniform), indicating the trees present real decisions rather than obvious dominant picks.
- **Expeditions:** combat players run expeditions in preference to flat grinding for tier-appropriate goals; partial-reward-on-fail keeps failed runs from feeling punishing.
- **Guilds:** a meaningful share of active players join a guild; guild boss leaderboards drive repeat boss participation.
- **Pets:** companions are acquired and kept active by most players; the passive bonus is felt but not so strong it trivializes other systems.
- **Portfolio:** `ce-plan` can take any single system from this doc into an implementation plan without inventing product behavior, scope, or success signals.

## Outstanding Questions

### Resolve before planning (per system, when that system is planned)
- Contracts: token rewards — are contracts a deliberate token *faucet*, or gold/XP only with tokens reserved for purchase? This shapes monetization.
- Mastery: respec policy — free, gold/token cost, or locked (R10).
- Expeditions: is loot rolled per-encounter and banked, or only paid on run resolution (affects how partial-on-fail in R14 is computed)?
- Guilds: shared-bank withdrawal authority — leader-only, role-gated, or member-configurable (R18)?
- Pets: primary acquisition source and whether companions provide pure passive bonus or also light automation (R21, R23).

### Deferred to planning
- Exact tuning: milestone intervals, perk percentages, contract reward amounts, expedition chain lengths, companion bonus magnitudes.
- Data model and persistence shape for each new entity.
- Per-system UI/panel layout in `apps/web/src/components/`.

## Sources / Research

- Game systems map derived from: `apps/server/src/tick/loop.ts`, `apps/server/src/combat/duel.ts`, `apps/server/src/actions/transform.ts`, `apps/server/src/actions/modifiers.ts`, `apps/server/src/market/orders.ts`, `apps/server/src/boss/service.ts`, `apps/server/src/chat/service.ts`, `apps/server/src/social/service.ts`, `apps/server/src/effects/`, `apps/server/src/config/catalog.ts`, `apps/server/src/seed/data.ts`, `packages/shared/src/{types,constants,formulas}/index.ts`, and `apps/web/src/components/`.
