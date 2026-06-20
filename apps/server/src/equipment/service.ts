// Equip / unequip unique gear (SPEC §3.3, §14 Phase 5). An instance maps to its
// item type's slot; one instance per slot. Equipping validates ownership, that
// the piece is equippable and not listed for sale, and the combat level meets the
// item's req_level. Everything atomic.

import { query, withTransaction } from '../db/pool.js';
import type { ConfigSnapshot } from '../config/snapshot.js';

export type EquipError =
  | 'not_owned'
  | 'not_equippable'
  | 'listed_for_sale'
  | 'level_too_low'
  | 'unknown_instance';

export interface EquippedItem {
  slot: string;
  instance_id: number;
  item: string;
  rarity: number;
  rolls: Record<string, number>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function equipInstance(
  playerId: number,
  instanceId: number,
  cfg: ConfigSnapshot,
): Promise<{ ok: true } | { error: EquipError }> {
  return withTransaction(async (client) => {
    const r = await client.query(
      'SELECT item_id, owner_id FROM item_instances WHERE id = $1 FOR UPDATE',
      [instanceId],
    );
    const inst = r.rows[0] as { item_id: number; owner_id: string } | undefined;
    if (!inst) return { error: 'unknown_instance' as const };
    if (Number(inst.owner_id) !== playerId) return { error: 'not_owned' as const };

    const item = cfg.items.get(inst.item_id);
    if (!item?.equip_slot) return { error: 'not_equippable' as const };

    const listed = await client.query(
      "SELECT 1 FROM instance_listings WHERE instance_id = $1 AND status = 'active'",
      [instanceId],
    );
    if (listed.rowCount && listed.rowCount > 0) return { error: 'listed_for_sale' as const };

    if (item.req_level && item.req_level > 1) {
      const combat = [...cfg.skills.values()].find((s) => s.code === 'combat');
      if (combat) {
        const lv = await client.query(
          'SELECT level FROM player_skills WHERE player_id = $1 AND skill_id = $2',
          [playerId, combat.id],
        );
        const level = (lv.rows[0] as { level: number } | undefined)?.level ?? 0;
        if (level < item.req_level) return { error: 'level_too_low' as const };
      }
    }

    await client.query(
      `INSERT INTO player_equipment (player_id, slot, instance_id) VALUES ($1, $2, $3)
       ON CONFLICT (player_id, slot) DO UPDATE SET instance_id = EXCLUDED.instance_id`,
      [playerId, item.equip_slot, instanceId],
    );
    return { ok: true as const };
  });
}

export async function unequipSlot(playerId: number, slot: string): Promise<void> {
  await query('DELETE FROM player_equipment WHERE player_id = $1 AND slot = $2', [playerId, slot]);
}

export async function getEquipment(playerId: number, cfg: ConfigSnapshot): Promise<EquippedItem[]> {
  const res = await query(
    `SELECT pe.slot, pe.instance_id, ii.item_id, ii.rarity, ii.rolls
       FROM player_equipment pe
       JOIN item_instances ii ON ii.id = pe.instance_id
      WHERE pe.player_id = $1
      ORDER BY pe.slot`,
    [playerId],
  );
  return (res.rows as any[]).map((row) => ({
    slot: row.slot,
    instance_id: Number(row.instance_id),
    item: cfg.items.get(row.item_id)?.code ?? `item:${row.item_id}`,
    rarity: row.rarity,
    rolls: row.rolls,
  }));
}
