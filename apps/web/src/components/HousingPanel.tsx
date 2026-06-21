import { useEffect, useState } from 'react';
import { useGame } from '../useGame.js';
import { fmt, duration } from '../format.js';

export function HousingPanel() {
  const { housing, catalog, startUpgrade, cancelUpgrade } = useGame();
  // Local 1s countdown of the active upgrade, re-synced whenever the server
  // snapshot changes (a housing:update push / mutation response). The live clock
  // is authoritative; this just animates between updates.
  const [remaining, setRemaining] = useState(0);
  const serverRemaining = housing?.active?.remaining_seconds ?? null;

  useEffect(() => {
    if (serverRemaining === null) return;
    setRemaining(serverRemaining);
    const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(id);
  }, [serverRemaining]);

  if (!housing || !catalog) return <section className="panel muted">Loading housing…</section>;

  const featureId = (code: string) => catalog.housing.find((h) => h.code === code)?.id;

  const start = (code: string) => {
    const id = featureId(code);
    if (id !== undefined) void startUpgrade(id);
  };
  const cancel = () => void cancelUpgrade();

  return (
    <>
      {housing.active && (
        <section className="panel">
          <h2>Upgrade in progress</h2>
          <p>
            <strong>{housing.active.feature}</strong> → Lv {housing.active.target_level}
          </p>
          <div className="bar">
            <span
              style={{
                width: `${
                  housing.active.completes_live > housing.active.start_live
                    ? Math.min(
                        100,
                        (1 -
                          remaining / (housing.active.completes_live - housing.active.start_live)) *
                          100,
                      )
                    : 100
                }%`,
              }}
            />
          </div>
          <p className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">{duration(remaining)} remaining</span>
            <button onClick={() => void cancel()}>Cancel (partial refund)</button>
          </p>
        </section>
      )}

      <section className="panel">
        <h2>House features</h2>
        <div className="list">
          {housing.features.map((f) => (
            <div key={f.code} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <strong>{catalog.housing.find((h) => h.code === f.code)?.name ?? f.code}</strong>{' '}
                  <span className="muted">({f.bonus_type})</span>
                </div>
                <span className="muted">
                  Lv {f.level}/{f.max_level}
                </span>
              </div>
              {f.next_cost ? (
                <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    next: {fmt(f.next_cost.gold)}g
                    {Object.entries(f.next_cost.resources).map(([r, q]) => `, ${fmt(q)} ${r}`)} ·{' '}
                    {duration(f.next_cost.duration)}
                  </span>
                  <button
                    className="primary"
                    disabled={!!housing.active}
                    title={housing.active ? 'one upgrade at a time' : undefined}
                    onClick={() => void start(f.code)}
                  >
                    Upgrade
                  </button>
                </div>
              ) : (
                <p className="muted" style={{ marginTop: 6 }}>
                  Max level reached.
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
