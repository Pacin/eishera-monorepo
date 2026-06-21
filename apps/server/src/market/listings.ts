// Auction-style market for unique equipment instances (SPEC §10 second mode).
// A non-fungible instance can't enter the fungible order book, so it sells via a
// fixed-price listing (qty always 1). Buying is a single atomic transaction with
// the listing row locked FOR UPDATE → a listing is bought by AT MOST ONE buyer;
// the second buyer gets a definitive "no longer available". An equipped or
// already-listed instance can't be listed.

import { withTransaction, query } from '../db/pool.js';
import type { ConfigSnapshot } from '../config/snapshot.js';
import type { Listing } from '@eishera/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ListError =
  | 'bad_price'
  | 'unknown_instance'
  | 'not_owner'
  | 'equipped'
  | 'already_listed';
export type BuyError = 'not_found' | 'no_longer_available' | 'own_listing' | 'insufficient_gold';

export async function listInstance(
  playerId: number,
  instanceId: number,
  price: number,
  idemKey: string,
): Promise<{ ok: true; listing_id: number } | { error: ListError }> {
  if (!Number.isInteger(price) || price <= 0) return { error: 'bad_price' };

  try {
    return await withTransaction(async (client) => {
      // Idempotent re-list returns the original listing.
      const dup = await client.query('SELECT id FROM instance_listings WHERE idem_key = $1', [
        idemKey,
      ]);
      if (dup.rows[0])
        return { ok: true as const, listing_id: Number((dup.rows[0] as { id: string }).id) };

      const inst = await client.query(
        'SELECT owner_id FROM item_instances WHERE id = $1 FOR UPDATE',
        [instanceId],
      );
      const owner = (inst.rows[0] as { owner_id: string } | undefined)?.owner_id;
      if (owner === undefined) return { error: 'unknown_instance' as const };
      if (Number(owner) !== playerId) return { error: 'not_owner' as const };

      const equipped = await client.query('SELECT 1 FROM player_equipment WHERE instance_id = $1', [
        instanceId,
      ]);
      if (equipped.rowCount && equipped.rowCount > 0) return { error: 'equipped' as const };

      const active = await client.query(
        "SELECT 1 FROM instance_listings WHERE instance_id = $1 AND status = 'active'",
        [instanceId],
      );
      if (active.rowCount && active.rowCount > 0) return { error: 'already_listed' as const };

      const ins = await client.query(
        `INSERT INTO instance_listings (instance_id, seller_id, price, status, idem_key)
         VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
        [instanceId, playerId, price, idemKey],
      );
      return { ok: true as const, listing_id: Number((ins.rows[0] as { id: string }).id) };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return { error: 'already_listed' };
    throw err;
  }
}

export async function buyListing(
  playerId: number,
  listingId: number,
): Promise<{ ok: true; already?: boolean } | { error: BuyError }> {
  return withTransaction(async (client) => {
    const res = await client.query(
      `SELECT l.instance_id, l.seller_id, l.price, l.status, ii.owner_id
         FROM instance_listings l JOIN item_instances ii ON ii.id = l.instance_id
        WHERE l.id = $1 FOR UPDATE`,
      [listingId],
    );
    const l = res.rows[0] as
      | { instance_id: string; seller_id: string; price: string; status: string; owner_id: string }
      | undefined;
    if (!l) return { error: 'not_found' as const };

    if (l.status !== 'active') {
      // Already settled: idempotent success if it's already ours, else taken.
      if (l.status === 'sold' && Number(l.owner_id) === playerId) {
        return { ok: true as const, already: true };
      }
      return { error: 'no_longer_available' as const };
    }
    if (Number(l.seller_id) === playerId) return { error: 'own_listing' as const };

    const price = Number(l.price);
    const buyer = await client.query('SELECT gold FROM players WHERE id = $1 FOR UPDATE', [
      playerId,
    ]);
    if (Number((buyer.rows[0] as { gold: string }).gold) < price) {
      return { error: 'insufficient_gold' as const };
    }

    await client.query('UPDATE players SET gold = gold - $2 WHERE id = $1', [playerId, price]);
    await client.query('UPDATE players SET gold = gold + $2 WHERE id = $1', [
      Number(l.seller_id),
      price,
    ]);
    await client.query('UPDATE item_instances SET owner_id = $2 WHERE id = $1', [
      Number(l.instance_id),
      playerId,
    ]);
    await client.query("UPDATE instance_listings SET status = 'sold' WHERE id = $1", [listingId]);
    return { ok: true as const };
  });
}

export async function cancelListing(
  playerId: number,
  listingId: number,
): Promise<{ ok: true } | { error: 'not_found' | 'not_owner' | 'not_active' }> {
  return withTransaction(async (client) => {
    const res = await client.query(
      'SELECT seller_id, status FROM instance_listings WHERE id = $1 FOR UPDATE',
      [listingId],
    );
    const l = res.rows[0] as { seller_id: string; status: string } | undefined;
    if (!l) return { error: 'not_found' as const };
    if (Number(l.seller_id) !== playerId) return { error: 'not_owner' as const };
    if (l.status !== 'active') return { error: 'not_active' as const };
    await client.query("UPDATE instance_listings SET status = 'cancelled' WHERE id = $1", [
      listingId,
    ]);
    return { ok: true as const };
  });
}

export async function getListings(itemId: number, cfg: ConfigSnapshot): Promise<Listing[]> {
  const res = await query(
    `SELECT l.id, l.instance_id, l.seller_id, l.price, ii.item_id, ii.rarity, ii.rolls
       FROM instance_listings l JOIN item_instances ii ON ii.id = l.instance_id
      WHERE l.status = 'active' AND ii.item_id = $1
      ORDER BY l.price ASC`,
    [itemId],
  );
  return (res.rows as any[]).map((r) => ({
    id: Number(r.id),
    instance_id: Number(r.instance_id),
    item: cfg.items.get(r.item_id)?.code ?? `item:${r.item_id}`,
    rarity: r.rarity,
    rolls: r.rolls,
    price: Number(r.price),
    seller_id: Number(r.seller_id),
  }));
}
