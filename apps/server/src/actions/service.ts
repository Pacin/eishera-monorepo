// Player-driven action controls (SPEC §6, §7). Selecting an activity sets the
// player's current target; refreshing refills the action bar. Neither is part of
// the tick loop — they're plain endpoints. The tick then processes whoever has a
// target and actions remaining.

import { query } from '../db/pool.js';

/** Select a transform recipe (clears any combat selection). Combat select is Phase 5. */
export async function selectRecipe(playerId: number, recipeId: number): Promise<void> {
  await query('UPDATE players SET active_recipe_id = $2, active_monster_id = NULL WHERE id = $1', [
    playerId,
    recipeId,
  ]);
}

/** Select a monster to battle (clears any transform selection). */
export async function selectMonster(playerId: number, monsterId: number): Promise<void> {
  await query('UPDATE players SET active_monster_id = $2, active_recipe_id = NULL WHERE id = $1', [
    playerId,
    monsterId,
  ]);
}

/** Stop the current activity (go idle). */
export async function clearActivity(playerId: number): Promise<void> {
  await query(
    'UPDATE players SET active_recipe_id = NULL, active_monster_id = NULL WHERE id = $1',
    [playerId],
  );
}

/** Refill the action bar to max_actions (SPEC §6 "action refresh"). */
export async function refreshActions(playerId: number): Promise<void> {
  await query('UPDATE players SET actions_remaining = max_actions WHERE id = $1', [playerId]);
}
