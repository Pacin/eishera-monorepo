// Market over HTTP + Socket.IO fill push. Registers a seller and a buyer, places
// a resting sell, connects the seller's socket, then has the buyer place a
// crossing buy over HTTP — the seller (maker) must receive a `market:fill` push.
// Also exercises list → buy and salvage endpoints. Start the server first.
import { io as ioClient } from 'socket.io-client';
import { query, closePool } from '../db/pool.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PORT = Number(process.env.PORT ?? 4000);
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const check = (label: string, cond: boolean, detail?: unknown): void => {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
};

function makeClient() {
  const jar = new Map<string, string>();
  let csrf = '';
  const store = (res: Response): void => {
    for (const c of ((res.headers as any).getSetCookie?.() ?? []) as string[]) {
      const pair = c.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /max-age=0/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
  };
  const cookie = (): string => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const api = async (path: string, opts: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (jar.size) headers.cookie = cookie();
    if (csrf) headers['csrf-token'] = csrf;
    const res = await fetch(`${BASE}${path}`, { ...opts, headers });
    store(res);
    return res;
  };
  const post = (path: string, body: unknown) =>
    api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const register = async (username: string): Promise<number> => {
    csrf = ((await api('/auth/csrf').then((r) => r.json())) as any).csrfToken;
    const reg = (await post('/auth/register', { username, password: 'password123' }).then((r) =>
      r.json(),
    )) as any;
    return reg.player.id;
  };
  return { api, post, cookie, register };
}

async function main(): Promise<void> {
  const ts = Date.now();
  const seller = makeClient();
  const buyer = makeClient();
  const sellerId = await seller.register(`m7s_${ts}`);
  const buyerId = await buyer.register(`m7b_${ts}`);

  // Fund via the DB (same connection pool).
  await query('INSERT INTO inventory (player_id,item_id,qty) VALUES ($1,100,100)', [sellerId]);
  await query('UPDATE players SET gold=100000 WHERE id=$1', [buyerId]);

  // Seller posts a resting sell.
  const sell = (await seller
    .post('/market/orders', { side: 'sell', item_id: 100, price: 10, qty: 5, idem_key: `s_${ts}` })
    .then((r) => r.json())) as any;
  check('seller sell order rests', sell.status === 'open', sell);

  // Seller connects; buyer's crossing buy must push a fill to the seller.
  const fill = await new Promise<any>((resolve, reject) => {
    const socket = ioClient(BASE, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Cookie: seller.cookie() },
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('no market:fill push within timeout'));
    }, 8000);
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(new Error(`connect_error: ${e.message}`));
    });
    socket.on('market:fill', (payload: any) => {
      clearTimeout(timer);
      socket.close();
      resolve(payload);
    });
    socket.on('hello', async () => {
      const buy = (await buyer
        .post('/market/orders', {
          side: 'buy',
          item_id: 100,
          price: 10,
          qty: 5,
          idem_key: `b_${ts}`,
        })
        .then((r) => r.json())) as any;
      check('buy order filled over HTTP', buy.filled_qty === 5, buy);
    });
  });
  check(
    'seller (maker) received market:fill push',
    fill?.qty === 5 && fill?.price === 10 && fill?.side === 'sell',
    fill,
  );

  // Book reflects no resting orders now.
  const book = (await seller.api('/market/book?item_id=100').then((r) => r.json())) as any;
  check(
    'book has no resting sells left',
    Array.isArray(book.sells) && book.sells.length === 0,
    book,
  );

  // List → buy an instance over HTTP.
  const instId = Number(
    (
      (
        await query(
          `INSERT INTO item_instances (item_id,owner_id,rarity,rolls) VALUES (200,$1,3,'{"str":1.2}'::jsonb) RETURNING id`,
          [sellerId],
        )
      ).rows[0] as any
    ).id,
  );
  const listed = (await seller
    .post('/market/listings', { instance_id: instId, price: 500, idem_key: `l_${ts}` })
    .then((r) => r.json())) as any;
  check('instance listed over HTTP', typeof listed.listing_id === 'number', listed);
  const bought = (await buyer
    .post('/market/listings/buy', { listing_id: listed.listing_id })
    .then((r) => r.json())) as any;
  check('listing bought over HTTP', bought.ok === true, bought);
  const owner = Number(
    ((await query('SELECT owner_id FROM item_instances WHERE id=$1', [instId])).rows[0] as any)
      .owner_id,
  );
  check('instance transferred to buyer', owner === buyerId, { owner, buyerId });

  // Salvage over HTTP.
  const salvInst = Number(
    (
      (
        await query(
          `INSERT INTO item_instances (item_id,owner_id,rarity,rolls) VALUES (200,$1,3,'{"str":1.0,"dex":1.0}'::jsonb) RETURNING id`,
          [buyerId],
        )
      ).rows[0] as any
    ).id,
  );
  const salv = (await buyer
    .post('/salvage', { instance_id: salvInst })
    .then((r) => r.json())) as any;
  check('salvage over HTTP returns materials', salv?.materials?.iron_scrap >= 1, salv);

  console.log(failures === 0 ? '\n[sio-market] PASSED' : `\n[sio-market] FAILED (${failures})`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error('[sio-market] error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
