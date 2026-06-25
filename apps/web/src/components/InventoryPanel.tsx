import { useGame } from '../useGame.js';
import { fmt } from '../format.js';

// Player holdings: stackable items + unique equipment instances. Data arrives
// over the socket (sync bootstrap + inventory:update); names and rarity colors
// are resolved against the catalog the client already holds.
export function InventoryPanel() {
  const { inventory, catalog } = useGame();
  if (!inventory || !catalog) return null;

  const itemName = (code: string) => catalog.items.find((i) => i.code === code)?.name ?? code;
  const rarityColor = (tier: number) =>
    catalog.rarities.find((r) => r.tier === tier)?.color ?? undefined;
  const rarityName = (tier: number) =>
    catalog.rarities.find((r) => r.tier === tier)?.name ?? `T${tier}`;

  return (
    <>
      <section className="panel">
        <h2>Items</h2>
        {inventory.stacks.length === 0 ? (
          <p className="muted">No items yet — gather, craft, or trade to fill your pack.</p>
        ) : (
          <div className="stat-grid">
            {inventory.stacks.map((s) => (
              <div key={s.item} className="stat-chip">
                <span className="muted">{itemName(s.item)}</span>
                <b>{fmt(s.qty)}</b>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Equipment</h2>
        {inventory.equipment.length === 0 ? (
          <p className="muted">No gear yet — defeat monsters or buy listings to find equipment.</p>
        ) : (
          <div className="list">
            {inventory.equipment.map((e) => (
              <div
                key={e.instance_id}
                className="card row"
                style={{ justifyContent: 'space-between' }}
              >
                <div>
                  <strong style={{ color: rarityColor(e.rarity) }}>{itemName(e.item)}</strong>{' '}
                  <span className="muted">({rarityName(e.rarity)})</span>
                  {Object.keys(e.rolls).length > 0 && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {Object.entries(e.rolls)
                        .map(([k, v]) => `${k.toUpperCase()} ${fmt(v)}`)
                        .join(' · ')}
                    </div>
                  )}
                </div>
                {e.equipped_slot && <span className="muted">equipped · {e.equipped_slot}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
