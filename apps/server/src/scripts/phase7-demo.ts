// Phase 7 acceptance check (SPEC §10, §10.1, §14). Proves:
//   1. order-book matching with escrow settles correctly (no overspend);
//   2. the concurrency test: two buys for one remaining unit → exactly one fills,
//      the item is NEVER transferred twice;
//   3. idempotency: a repeated idem_key does not create a second order/charge;
//   4. an instance listing is bought by AT MOST ONE buyer (the 2nd is rejected);
//   5. salvage deletes the instance and returns quality-scaled materials.

import { initConfig, getConfig, shutdownConfig } from '../config/store.js';
import { createPlayer } from '../players/service.js';
import { placeOrder } from '../market/orders.js';
import { listInstance, buyListing } from '../market/listings.js';
import { salvageInstance } from '../market/salvage.js';
import { query, closePool } from '../db/pool.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const ORE = 100;
const SWORD = 200;
const SCRAP = 402;

const gold = async (id: number): Promise<number> =>
  Number(((await query('SELECT gold FROM players WHERE id=$1', [id])).rows[0] as any).gold);
const inv = async (id: number, item: number): Promise<number> =>
  Number(
    (
      (await query('SELECT qty FROM inventory WHERE player_id=$1 AND item_id=$2', [id, item]))
        .rows[0] as any
    )?.qty ?? 0,
  );
const newInstance = async (owner: number, rolls: object): Promise<number> =>
  Number(
    (
      (
        await query(
          `INSERT INTO item_instances (item_id, owner_id, rarity, rolls) VALUES ($1,$2,3,$3::jsonb) RETURNING id`,
          [SWORD, owner, JSON.stringify(rolls)],
        )
      ).rows[0] as any
    ).id,
  );

async function main(): Promise<void> {
  await initConfig();
  const cfg = getConfig();
  const ts = Date.now();

  // Isolate the order book for a deterministic run (prior runs leave resting
  // orders — that's correct in production, but it pollutes this self-contained
  // demo). trades references market_orders, so clear it first.
  await query('DELETE FROM trades');
  await query('DELETE FROM market_orders');

  // ── 1. Order-book match + escrow ───────────────────────────────────────────
  console.log('[demo] order book: a sell and a crossing buy settle with escrow');
  const seller = await createPlayer(`p7s_${ts}`, 'password123');
  const buyer = await createPlayer(`p7b_${ts}`, 'password123');
  await query('UPDATE players SET gold=0 WHERE id=$1', [seller]);
  await query('UPDATE players SET gold=1000 WHERE id=$1', [buyer]);
  await query('INSERT INTO inventory (player_id,item_id,qty) VALUES ($1,$2,100)', [seller, ORE]);

  const sell = await placeOrder(seller, 'sell', ORE, 10, 10, `s_${ts}`);
  check('sell order placed (escrowed 10 ore)', 'order_id' in sell, sell);
  check('seller ore escrowed → 90 left', (await inv(seller, ORE)) === 90);

  const buy = await placeOrder(buyer, 'buy', ORE, 10, 10, `b_${ts}`);
  check('buy order fully filled', 'filled_qty' in buy && buy.filled_qty === 10, buy);
  check('buyer received 10 ore', (await inv(buyer, ORE)) === 10);
  check('buyer paid 100 gold (1000→900)', (await gold(buyer)) === 900);
  check('seller received 100 gold', (await gold(seller)) === 100);
  const trades = Number(((await query('SELECT count(*)::int AS n FROM trades')).rows[0] as any).n);
  check('a trade row was written', trades >= 1, trades);

  // ── 2. No overspend ────────────────────────────────────────────────────────
  console.log('[demo] no overspend: a buy beyond gold is rejected, no escrow');
  const poor = await createPlayer(`p7p_${ts}`, 'password123');
  await query('UPDATE players SET gold=50 WHERE id=$1', [poor]);
  const over = await placeOrder(poor, 'buy', ORE, 10, 10, `o_${ts}`); // costs 100 > 50
  check('insufficient gold rejected', 'error' in over && over.error === 'insufficient_gold', over);
  check('no gold deducted on reject', (await gold(poor)) === 50);

  // ── 3. Concurrency test (SPEC §10) ─────────────────────────────────────────
  console.log('[demo] concurrency: two buys for ONE unit → exactly one fills');
  const s2 = await createPlayer(`p7cs_${ts}`, 'password123');
  const b1 = await createPlayer(`p7c1_${ts}`, 'password123');
  const b2 = await createPlayer(`p7c2_${ts}`, 'password123');
  await query('INSERT INTO inventory (player_id,item_id,qty) VALUES ($1,$2,1)', [s2, ORE]);
  await query('UPDATE players SET gold=1000 WHERE id IN ($1,$2)', [b1, b2]);
  await placeOrder(s2, 'sell', ORE, 5, 1, `cs_${ts}`); // one unit for sale

  const [r1, r2] = await Promise.all([
    placeOrder(b1, 'buy', ORE, 5, 1, `cb1_${ts}`),
    placeOrder(b2, 'buy', ORE, 5, 1, `cb2_${ts}`),
  ]);
  const filled = [r1, r2].filter((r) => 'filled_qty' in r && r.filled_qty === 1).length;
  const oreB1 = await inv(b1, ORE);
  const oreB2 = await inv(b2, ORE);
  check('exactly one buy filled', filled === 1, { r1, r2 });
  check('the single unit went to exactly one buyer (never duplicated)', oreB1 + oreB2 === 1, {
    oreB1,
    oreB2,
  });

  // ── 4. Idempotency ─────────────────────────────────────────────────────────
  console.log('[demo] idempotency: same idem_key does not double-charge');
  const idem = await createPlayer(`p7i_${ts}`, 'password123');
  await query('UPDATE players SET gold=1000 WHERE id=$1', [idem]);
  const first = await placeOrder(idem, 'buy', ORE, 7, 5, `idem_${ts}`);
  const goldAfterFirst = await gold(idem);
  const second = await placeOrder(idem, 'buy', ORE, 7, 5, `idem_${ts}`); // same key
  check(
    'retry returns the same order id',
    'order_id' in first && 'order_id' in second && first.order_id === second.order_id,
    { first, second },
  );
  check('retry did not deduct gold again', (await gold(idem)) === goldAfterFirst, {
    goldAfterFirst,
    now: await gold(idem),
  });

  // ── 5. Instance listing bought by at most one buyer ────────────────────────
  console.log('[demo] instance listing: bought by at most one buyer');
  const lseller = await createPlayer(`p7ls_${ts}`, 'password123');
  const lb1 = await createPlayer(`p7lb1_${ts}`, 'password123');
  const lb2 = await createPlayer(`p7lb2_${ts}`, 'password123');
  await query('UPDATE players SET gold=10000 WHERE id IN ($1,$2)', [lb1, lb2]);
  const instId = await newInstance(lseller, { str: 1.2, dex: 1.0 });
  const listed = await listInstance(lseller, instId, 1000, `list_${ts}`);
  check('instance listed', 'listing_id' in listed, listed);
  const listingId = (listed as any).listing_id;

  const [buy1, buy2] = await Promise.all([buyListing(lb1, listingId), buyListing(lb2, listingId)]);
  const oks = [buy1, buy2].filter(
    (r) => 'ok' in r && r.ok && !('already' in r && r.already),
  ).length;
  const ownerRow = (await query('SELECT owner_id FROM item_instances WHERE id=$1', [instId]))
    .rows[0] as any;
  const owner = Number(ownerRow.owner_id);
  check('exactly one buy succeeded', oks === 1, { buy1, buy2 });
  check('instance owned by exactly one of the buyers', owner === lb1 || owner === lb2, {
    owner,
    lb1,
    lb2,
  });
  check(
    'the other buyer got "no_longer_available"',
    [buy1, buy2].some((r) => 'error' in r && r.error === 'no_longer_available'),
    { buy1, buy2 },
  );
  check(
    'seller paid exactly once (gold=1000)',
    (await gold(lseller)) === 1000,
    await gold(lseller),
  );
  const lstatus = (await query('SELECT status FROM instance_listings WHERE id=$1', [listingId]))
    .rows[0] as any;
  check('listing marked sold', lstatus.status === 'sold', lstatus);

  // ── 6. Salvage (instance sink) ─────────────────────────────────────────────
  console.log('[demo] salvage: deletes the instance, returns quality-scaled materials');
  const salv = await createPlayer(`p7sv_${ts}`, 'password123');
  const sInst = await newInstance(salv, { str: 1.5, dex: 1.0 }); // avg quality 1.25
  const scrapBefore = await inv(salv, SCRAP);
  const result = await salvageInstance(salv, sInst, cfg);
  check('salvage returned materials', 'materials' in result, result);
  // sword salvage_yield iron_scrap 2 × quality 1.25 = round(2.5) = 3
  check(
    'iron_scrap = round(base 2 × quality 1.25) = 3',
    'materials' in result && result.materials.iron_scrap === 3,
    result,
  );
  check('materials credited to inventory', (await inv(salv, SCRAP)) === scrapBefore + 3);
  const gone = (await query('SELECT 1 FROM item_instances WHERE id=$1', [sInst])).rowCount;
  check('instance row deleted (sink)', gone === 0);

  console.log(
    failures === 0 ? '\n[demo] PHASE 7 ACCEPTANCE PASSED' : `\n[demo] FAILED (${failures})`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error('[demo] error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void shutdownConfig().finally(() => closePool());
  });
