// Salvage / disenchant (SPEC §10.1) — the instance sink that bounds
// item_instances growth. Salvaging an owned, unequipped, unlisted instance is an
// instant atomic transaction: grant materials from the item type's salvage_yield
// (scaled by the instance's quality, i.e. its rolls), then DELETE the row.

import { withTransaction } from '../db/pool.js';
import type { ConfigSnapshot } from '../config/snapshot.js';
import type { SalvageResult } from '@eishera/shared';

export type SalvageError =
  | 'unknown_instance'
  | 'not_owner'
  | 'equipped'
  | 'listed'
  | 'not_salvageable';

/** Quality scalar = average of the instance's per-stat roll multipliers. */
function qualityFactor(rolls: Record<string, number>): number {
  const vals = Object.values(rolls);
  if (vals.length === 0) return 1;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

export async function salvageInstance(
  playerId: number,
  instanceId: number,
  cfg: ConfigSnapshot,
): Promise<SalvageResult | { error: SalvageError }> {
  return withTransaction(async (client) => {
    const inst = await client.query(
      'SELECT item_id, owner_id, rolls FROM item_instances WHERE id = $1 FOR UPDATE',
      [instanceId],
    );
    const row = inst.rows[0] as
      | { item_id: number; owner_id: string; rolls: Record<string, number> }
      | undefined;
    if (!row) return { error: 'unknown_instance' as const };
    if (Number(row.owner_id) !== playerId) return { error: 'not_owner' as const };

    const equipped = await client.query('SELECT 1 FROM player_equipment WHERE instance_id = $1', [
      instanceId,
    ]);
    if (equipped.rowCount && equipped.rowCount > 0) return { error: 'equipped' as const };

    const listed = await client.query(
      "SELECT 1 FROM instance_listings WHERE instance_id = $1 AND status = 'active'",
      [instanceId],
    );
    if (listed.rowCount && listed.rowCount > 0) return { error: 'listed' as const };

    const item = cfg.items.get(row.item_id);
    if (!item?.salvage_yield) return { error: 'not_salvageable' as const };

    const quality = qualityFactor(row.rolls);
    const materials: Record<string, number> = {};
    for (const [res, base] of Object.entries(item.salvage_yield)) {
      const qty = Math.max(1, Math.round(base * quality));
      const mat = cfg.itemsByCode.get(res);
      if (!mat) continue;
      materials[res] = qty;
      await client.query(
        `INSERT INTO inventory (player_id, item_id, qty) VALUES ($1, $2, $3)
         ON CONFLICT (player_id, item_id) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`,
        [playerId, mat.id, qty],
      );
    }

    await client.query('DELETE FROM item_instances WHERE id = $1', [instanceId]);
    return { instance_id: instanceId, materials };
  });
}
