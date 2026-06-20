// Holds the active config snapshot and swaps it atomically (SPEC §4.2–4.4).
// Game logic calls getConfig() and never touches the DB on the hot path. A
// reload fully builds the new snapshot, then activates it with a single
// assignment — a reader never sees a half-updated snapshot.

import { buildSnapshot, type ConfigSnapshot } from './snapshot.js';
import { startConfigListener, stopConfigListener } from './listener.js';

let current: ConfigSnapshot | null = null;

/** The active snapshot. Throws if accessed before initConfig(). */
export function getConfig(): ConfigSnapshot {
  if (current === null) {
    throw new Error('Config snapshot not initialized — call initConfig() first.');
  }
  return current;
}

/** Rebuild the snapshot from the DB and activate it (atomic reference swap). */
export async function reloadConfig(reason: string): Promise<void> {
  const next = await buildSnapshot();
  current = next; // single assignment = atomic swap
  console.log(
    `[config] snapshot ${reason} — ${next.gameConfig ? Object.keys(next.gameConfig).length : 0} knobs, ` +
      `${next.items.size} items, ${next.recipes.size} recipes, ${next.monsters.size} monsters`,
  );
}

/** Load the snapshot once and start listening for live changes. */
export async function initConfig(): Promise<void> {
  await reloadConfig('loaded');
  await startConfigListener(() => reloadConfig('reloaded'));
}

export async function shutdownConfig(): Promise<void> {
  await stopConfigListener();
}
