// The application write path for game_config (SPEC §4.5–4.6). It validates the
// value, then performs the UPDATE inside a transaction with app.changed_by set
// so the DB trigger attributes the audit row and emits the config_changed
// notification. (Direct admin edits in psql bypass this validation but are still
// audited + reload-signaled by the trigger.)

import { withTransaction } from '../db/pool.js';
import { validateGameConfig } from './validate.js';

/**
 * Update one game_config key. Validates bounds, writes inside a transaction
 * tagged with `changedBy`, and relies on the DB trigger for audit + notify.
 * Throws if the key does not exist or the value is invalid.
 */
export async function updateGameConfig(
  key: string,
  value: unknown,
  changedBy: string,
): Promise<void> {
  validateGameConfig(key, value);

  await withTransaction(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.changed_by', changedBy]);
    const result = await client.query('UPDATE game_config SET value = $1::jsonb WHERE key = $2', [
      JSON.stringify(value),
      key,
    ]);
    if (result.rowCount === 0) {
      throw new Error(`game_config key not found: ${key}`);
    }
  });
}
