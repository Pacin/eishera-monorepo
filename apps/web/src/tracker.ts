import type { BattleResult, GatherResult } from '@eishera/shared';

// Client-side "Action Tracker": running totals since the last Reset, persisted to
// localStorage per player so they survive reloads. The server is authoritative
// for game state; these are purely a local activity tally and never sent back.
export interface CombatTracker {
  wins: number;
  losses: number;
  gold: number;
  /** Epoch ms of the first action since reset, for the per-hour rate. */
  since: number | null;
}
export interface GatherTracker {
  actions: number;
  resources: number;
  since: number | null;
}

export const emptyCombat = (): CombatTracker => ({ wins: 0, losses: 0, gold: 0, since: null });
export const emptyGather = (): GatherTracker => ({ actions: 0, resources: 0, since: null });

export function addBattle(t: CombatTracker, r: BattleResult, now: number): CombatTracker {
  return {
    wins: t.wins + (r.won ? 1 : 0),
    losses: t.losses + (r.won ? 0 : 1),
    gold: t.gold + r.gold,
    since: t.since ?? now,
  };
}

export function addGather(t: GatherTracker, r: GatherResult, now: number): GatherTracker {
  if (r.stalled) return t; // a stalled action did no work — don't count it
  const got = r.outputs.reduce((sum, o) => sum + o.qty, 0);
  return {
    actions: t.actions + 1,
    resources: t.resources + got,
    since: t.since ?? now,
  };
}

/** Whole-number per-hour rate from a total and its start time. */
export function ratePerHour(total: number, since: number | null, now: number): number {
  if (since === null) return 0;
  const hours = (now - since) / 3_600_000;
  return hours > 0 ? Math.round(total / hours) : 0;
}

const key = (kind: string, playerId: number) => `eishera:tracker:${kind}:${playerId}`;

function load<T>(kind: string, playerId: number, fallback: T): T {
  try {
    const raw = localStorage.getItem(key(kind, playerId));
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(kind: string, playerId: number, value: unknown): void {
  try {
    localStorage.setItem(key(kind, playerId), JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota) — totals just won't persist */
  }
}

export const loadCombat = (playerId: number): CombatTracker =>
  load('combat', playerId, emptyCombat());
export const loadGather = (playerId: number): GatherTracker =>
  load('gather', playerId, emptyGather());
export const saveCombat = (playerId: number, t: CombatTracker): void => save('combat', playerId, t);
export const saveGather = (playerId: number, t: GatherTracker): void => save('gather', playerId, t);
