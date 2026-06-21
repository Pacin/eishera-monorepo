// Fungible order book (SPEC §10). Every order is serialized through the market
// queue, then processed in its own Postgres transaction with FOR UPDATE locks —
// so matching is deterministic and double-spend is impossible.
//
// Escrow model: placement reserves up front (a SELL reserves its items, a BUY
// reserves price×qty gold). Fills settle the escrow at the MAKER (resting) price;
// a taker BUY that fills below its limit is refunded the difference. This is how
// "debit at fill" is realized without overspend or phantom liquidity. Cancelling
// returns the unfilled escrow.

import { marketQueue } from './queue.js';
import { withTransaction } from '../db/pool.js';
import { query } from '../db/pool.js';
import { pushToPlayer, isPlayerOnline } from '../ws/registry.js';
import { getPlayerSummaries } from '../players/service.js';
import { getConfig } from '../config/store.js';
import type { OrderResult, Fill, OrderBook, BookLevel, MarketSide } from '@eishera/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type OrderError =
  | 'unknown_item'
  | 'not_tradable'
  | 'bad_price'
  | 'bad_qty'
  | 'insufficient_gold'
  | 'insufficient_items'
  | 'not_found'
  | 'not_owner'
  | 'not_open';

interface MakerPush {
  playerId: number;
  payload: { order_id: number; side: MarketSide; qty: number; price: number };
}

export async function placeOrder(
  playerId: number,
  side: MarketSide,
  itemId: number,
  price: number,
  qty: number,
  idemKey: string,
): Promise<OrderResult | { error: OrderError }> {
  return marketQueue.enqueue(async () => {
    const cfg = getConfig();
    const item = cfg.items.get(itemId);
    if (!item) return { error: 'unknown_item' as const };
    if (!item.tradable) return { error: 'not_tradable' as const };
    if (!Number.isInteger(price) || price <= 0) return { error: 'bad_price' as const };
    if (!Number.isInteger(qty) || qty <= 0) return { error: 'bad_qty' as const };

    const makerPushes: MakerPush[] = [];
    const outcome = await withTransaction(async (client) => {
      // Idempotency: a retry with the same key returns the original order.
      const dup = await client.query(
        'SELECT id, status, qty_total, qty_remaining FROM market_orders WHERE idem_key = $1',
        [idemKey],
      );
      if (dup.rows[0]) {
        const o = dup.rows[0] as {
          id: string;
          status: any;
          qty_total: string;
          qty_remaining: string;
        };
        return {
          result: {
            order_id: Number(o.id),
            status: o.status,
            filled_qty: Number(o.qty_total) - Number(o.qty_remaining),
            fills: [],
            refunded_gold: 0,
          } as OrderResult,
        };
      }

      // Escrow at placement.
      if (side === 'sell') {
        const inv = await client.query(
          'SELECT qty FROM inventory WHERE player_id = $1 AND item_id = $2 FOR UPDATE',
          [playerId, itemId],
        );
        if (Number((inv.rows[0] as { qty: string } | undefined)?.qty ?? 0) < qty) {
          return { result: { error: 'insufficient_items' as const } };
        }
        await client.query(
          'UPDATE inventory SET qty = qty - $3 WHERE player_id = $1 AND item_id = $2',
          [playerId, itemId, qty],
        );
      } else {
        const cost = price * qty;
        const p = await client.query('SELECT gold FROM players WHERE id = $1 FOR UPDATE', [
          playerId,
        ]);
        if (Number((p.rows[0] as { gold: string }).gold) < cost) {
          return { result: { error: 'insufficient_gold' as const } };
        }
        await client.query('UPDATE players SET gold = gold - $2 WHERE id = $1', [playerId, cost]);
      }

      const ins = await client.query(
        `INSERT INTO market_orders (player_id, side, item_id, price, qty_total, qty_remaining, status, idem_key)
         VALUES ($1, $2, $3, $4, $5, $5, 'open', $6) RETURNING id`,
        [playerId, side, itemId, price, qty, idemKey],
      );
      const orderId = Number((ins.rows[0] as { id: string }).id);

      // Match against crossing resting orders, price-time priority (idx_orders_match).
      const opp: MarketSide = side === 'buy' ? 'sell' : 'buy';
      const priceCmp = side === 'buy' ? 'price <= $2' : 'price >= $2';
      const priceOrder = side === 'buy' ? 'price ASC' : 'price DESC';
      const resting = await client.query(
        `SELECT id, player_id, price, qty_remaining FROM market_orders
          WHERE item_id = $1 AND side = $3 AND status IN ('open','partial') AND ${priceCmp}
          ORDER BY ${priceOrder}, created_at ASC
          FOR UPDATE`,
        [itemId, price, opp],
      );

      let remaining = qty;
      let refundedGold = 0;
      const fills: Fill[] = [];

      for (const r of resting.rows as {
        id: string;
        player_id: string;
        price: string;
        qty_remaining: string;
      }[]) {
        if (remaining <= 0) break;
        const restingId = Number(r.id);
        const restingPlayer = Number(r.player_id);
        const restingPrice = Number(r.price);
        const restingRem = Number(r.qty_remaining);
        const fillQty = Math.min(remaining, restingRem);
        const fillPrice = restingPrice; // maker price

        // Identify the buy/sell sides of this fill.
        const buyOrderId = side === 'buy' ? orderId : restingId;
        const sellOrderId = side === 'buy' ? restingId : orderId;
        const buyerPlayer = side === 'buy' ? playerId : restingPlayer;
        const sellerPlayer = side === 'buy' ? restingPlayer : playerId;
        const buyLimit = side === 'buy' ? price : restingPrice; // the buy order's escrow price

        // Settle: items (from seller's escrow) → buyer; gold (from buyer's escrow) → seller.
        await client.query(
          `INSERT INTO inventory (player_id, item_id, qty) VALUES ($1, $2, $3)
           ON CONFLICT (player_id, item_id) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`,
          [buyerPlayer, itemId, fillQty],
        );
        await client.query('UPDATE players SET gold = gold + $2 WHERE id = $1', [
          sellerPlayer,
          fillQty * fillPrice,
        ]);
        const refund = (buyLimit - fillPrice) * fillQty; // >0 only for a taker buy below limit
        if (refund > 0) {
          await client.query('UPDATE players SET gold = gold + $2 WHERE id = $1', [
            buyerPlayer,
            refund,
          ]);
          refundedGold += refund;
        }

        // Update the resting order.
        const restingNewRem = restingRem - fillQty;
        await client.query(
          'UPDATE market_orders SET qty_remaining = $2, status = $3 WHERE id = $1',
          [restingId, restingNewRem, restingNewRem === 0 ? 'filled' : 'partial'],
        );

        await client.query(
          'INSERT INTO trades (item_id, buy_order_id, sell_order_id, qty, price) VALUES ($1, $2, $3, $4, $5)',
          [itemId, buyOrderId, sellOrderId, fillQty, fillPrice],
        );

        fills.push({ qty: fillQty, price: fillPrice, counter_order_id: restingId });
        makerPushes.push({
          playerId: restingPlayer,
          payload: { order_id: restingId, side: opp, qty: fillQty, price: fillPrice },
        });
        remaining -= fillQty;
      }

      const status = remaining === 0 ? 'filled' : remaining < qty ? 'partial' : 'open';
      await client.query('UPDATE market_orders SET qty_remaining = $2, status = $3 WHERE id = $1', [
        orderId,
        remaining,
        status,
      ]);

      const result: OrderResult = {
        order_id: orderId,
        status,
        filled_qty: qty - remaining,
        fills,
        refunded_gold: refundedGold,
      };
      return { result };
    });

    if (!('error' in outcome.result)) {
      for (const push of makerPushes) pushToPlayer(push.playerId, 'market:fill', push.payload);
      // Gold/inventory changed for the placer and every maker → push fresh
      // summaries so clients update without a /me GET (market runs off-tick).
      const affected = [playerId, ...makerPushes.map((m) => m.playerId)].filter(
        (id, i, a) => a.indexOf(id) === i && isPlayerOnline(id),
      );
      if (affected.length > 0) {
        const summaries = await getPlayerSummaries(affected);
        for (const [id, summary] of summaries) pushToPlayer(id, 'player:update', summary);
      }
    }
    return outcome.result;
  });
}

export async function cancelOrder(
  playerId: number,
  orderId: number,
): Promise<{ ok: true } | { error: OrderError }> {
  return marketQueue.enqueue(() =>
    withTransaction(async (client) => {
      const res = await client.query(
        'SELECT player_id, side, item_id, price, qty_remaining, status FROM market_orders WHERE id = $1 FOR UPDATE',
        [orderId],
      );
      const o = res.rows[0] as
        | {
            player_id: string;
            side: MarketSide;
            item_id: number;
            price: string;
            qty_remaining: string;
            status: string;
          }
        | undefined;
      if (!o) return { error: 'not_found' as const };
      if (Number(o.player_id) !== playerId) return { error: 'not_owner' as const };
      if (o.status !== 'open' && o.status !== 'partial') return { error: 'not_open' as const };

      const rem = Number(o.qty_remaining);
      if (o.side === 'sell') {
        await client.query(
          `INSERT INTO inventory (player_id, item_id, qty) VALUES ($1, $2, $3)
           ON CONFLICT (player_id, item_id) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`,
          [playerId, o.item_id, rem],
        );
      } else {
        await client.query('UPDATE players SET gold = gold + $2 WHERE id = $1', [
          playerId,
          rem * Number(o.price),
        ]);
      }
      await client.query("UPDATE market_orders SET status = 'cancelled' WHERE id = $1", [orderId]);
      return { ok: true as const };
    }),
  );
}

/** Aggregated resting book for one item (buys high→low, sells low→high). */
export async function getBook(itemId: number): Promise<OrderBook> {
  const item = getConfig().items.get(itemId);
  const res = await query(
    `SELECT side, price, SUM(qty_remaining)::bigint AS qty FROM market_orders
      WHERE item_id = $1 AND status IN ('open','partial')
      GROUP BY side, price`,
    [itemId],
  );
  const buys: BookLevel[] = [];
  const sells: BookLevel[] = [];
  for (const r of res.rows as { side: MarketSide; price: string; qty: string }[]) {
    (r.side === 'buy' ? buys : sells).push({ price: Number(r.price), qty: Number(r.qty) });
  }
  buys.sort((a, b) => b.price - a.price);
  sells.sort((a, b) => a.price - b.price);
  return { item: item?.code ?? `item:${itemId}`, buys, sells };
}
