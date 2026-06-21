import { useCallback, useEffect, useState } from 'react';
import type { OrderBook, MarketSide } from '@eishera/shared';
import { useGame } from '../useGame.js';
import { getJson, postJson } from '../api.js';
import { fmt } from '../format.js';

export function MarketPanel() {
  const { catalog, lastFill } = useGame();
  const tradables = (catalog?.items ?? []).filter((i) => i.tradable && i.equip_slot === null);
  const [itemId, setItemId] = useState<number | null>(null);
  const [book, setBook] = useState<OrderBook | null>(null);
  const [side, setSide] = useState<MarketSide>('buy');
  const [price, setPrice] = useState('10');
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState<string | null>(null);

  const activeItem = itemId ?? tradables[0]?.id ?? null;

  const loadBook = useCallback(async (id: number) => {
    setBook(await getJson<OrderBook>(`/market/book?item_id=${id}`));
  }, []);

  useEffect(() => {
    if (activeItem !== null) void loadBook(activeItem).catch(() => undefined);
  }, [activeItem, loadBook]);

  // A fill arriving on the socket means the book moved — re-sync it live.
  useEffect(() => {
    if (lastFill && activeItem !== null) void loadBook(activeItem).catch(() => undefined);
  }, [lastFill, activeItem, loadBook]);

  if (!catalog) return null;
  if (activeItem === null) return <section className="panel muted">No tradable items.</section>;

  const place = async () => {
    setNote(null);
    const idem_key =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
    try {
      const res = (await postJson('/market/orders', {
        side,
        item_id: activeItem,
        price: Number(price),
        qty: Number(qty),
        idem_key,
      })) as { status: string; filled_qty: number };
      setNote(`Order ${res.status} — filled ${res.filled_qty}.`);
      // Gold/inventory update arrives via the server's player:update push.
      await loadBook(activeItem);
    } catch {
      setNote('Order rejected (check funds / inventory).');
    }
  };

  return (
    <section className="panel">
      <h2>Market</h2>
      <div className="row">
        <select value={activeItem} onChange={(e) => setItemId(Number(e.target.value))}>
          {tradables.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>

      <div className="row" style={{ alignItems: 'flex-start', marginTop: 10 }}>
        <table>
          <thead>
            <tr>
              <th>Buys</th>
              <th>qty</th>
            </tr>
          </thead>
          <tbody>
            {(book?.buys ?? []).slice(0, 6).map((l, i) => (
              <tr key={i}>
                <td className="good">{fmt(l.price)}</td>
                <td>{fmt(l.qty)}</td>
              </tr>
            ))}
            {(book?.buys.length ?? 0) === 0 && (
              <tr>
                <td className="muted" colSpan={2}>
                  none
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <table>
          <thead>
            <tr>
              <th>Sells</th>
              <th>qty</th>
            </tr>
          </thead>
          <tbody>
            {(book?.sells ?? []).slice(0, 6).map((l, i) => (
              <tr key={i}>
                <td className="bad">{fmt(l.price)}</td>
                <td>{fmt(l.qty)}</td>
              </tr>
            ))}
            {(book?.sells.length ?? 0) === 0 && (
              <tr>
                <td className="muted" colSpan={2}>
                  none
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <select value={side} onChange={(e) => setSide(e.target.value as MarketSide)}>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <input
          style={{ width: 80 }}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          inputMode="numeric"
          aria-label="price"
        />
        <span className="muted">×</span>
        <input
          style={{ width: 60 }}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          inputMode="numeric"
          aria-label="qty"
        />
        <button className="primary" onClick={() => void place()}>
          Place
        </button>
      </div>
      {note && <p className="muted">{note}</p>}
      <p className="muted" style={{ fontSize: 12 }}>
        Fills to your resting orders arrive live (the “live” dot above). Equipment instance listings
        &amp; salvage are available via the API.
      </p>
    </section>
  );
}
