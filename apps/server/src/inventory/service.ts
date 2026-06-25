// Player inventory (SPEC §3.2): stackable holdings (the `inventory` table) plus
// unique equipment instances (`item_instances`), with the equipped slot joined in
// so the client can mark which pieces are worn. Delivered over Socket.IO in the
// `sync` bootstrap and pushed as `inventory:update` wherever holdings change
// (crafting/loot each tick, market fills off-tick).

import { query } from '../db/pool.js';
import type { ConfigSnapshot } from '../config/snapshot.js';
import type { InventoryView, EquipSlot } from '@eishera/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Assemble one player's inventory (stackables + unique gear). */
export async function getInventory(playerId: number, cfg: ConfigSnapshot): Promise<InventoryView> {
  return (await getInventories([playerId], cfg)).get(playerId) ?? { stacks: [], equipment: [] };
}

/**
 * Batch variant: build inventories for many players in a fixed 2 queries (not
 * 2×N), mirroring getPlayerSummaries. The tick loop uses this to push
 * `inventory:update` to active online players without a per-player query storm.
 */
export async function getInventories(
  ids: number[],
  cfg: ConfigSnapshot,
): Promise<Map<number, InventoryView>> {
  const out = new Map<number, InventoryView>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, { stacks: [], equipment: [] });

  const itemCode = (itemId: number) => cfg.items.get(itemId)?.code ?? `item:${itemId}`;

  const stacks = await query(
    `SELECT player_id, item_id, qty FROM inventory
      WHERE player_id = ANY($1::bigint[]) AND qty > 0
      ORDER BY item_id`,
    [ids],
  );
  for (const row of stacks.rows as any[]) {
    out.get(Number(row.player_id))?.stacks.push({
      item: itemCode(row.item_id),
      qty: Number(row.qty),
    });
  }

  const instances = await query(
    `SELECT ii.owner_id, ii.id, ii.item_id, ii.rarity, ii.rolls, pe.slot
       FROM item_instances ii
       LEFT JOIN player_equipment pe ON pe.instance_id = ii.id
      WHERE ii.owner_id = ANY($1::bigint[])
      ORDER BY ii.id`,
    [ids],
  );
  for (const row of instances.rows as any[]) {
    out.get(Number(row.owner_id))?.equipment.push({
      instance_id: Number(row.id),
      item: itemCode(row.item_id),
      rarity: row.rarity,
      rolls: row.rolls,
      equipped_slot: (row.slot as EquipSlot | null) ?? null,
    });
  }

  return out;
}
