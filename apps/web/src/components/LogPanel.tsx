import { useGame } from '../useGame.js';
import { fmt } from '../format.js';

// Right column: a persistent, live activity log of recent battle results
// (newest first). Capped upstream at MAX_BATTLES, and the column itself does not
// scroll — older entries fall off the bottom, newest stay pinned at the top.
export function LogPanel() {
  const { battles } = useGame();

  return (
    <aside className="logcol">
      <section className="panel log-panel">
        <h2>Activity log</h2>
        {battles.length === 0 ? (
          <p className="muted">No fights yet. Battle results stream in live.</p>
        ) : (
          <div className="log-list">
            {battles.map((b, i) => (
              <div key={i} className="log-line">
                <span className={b.won ? 'good' : 'bad'}>{b.won ? 'WON' : 'LOST'}</span>{' '}
                vs <strong>{b.monster}</strong>
                <div className="muted log-detail">
                  dealt {fmt(b.damage_dealt)} / took {fmt(b.damage_taken)} · {b.rounds} rounds
                  {b.won && (
                    <>
                      {' '}
                      · +{fmt(b.xp)} xp · +{fmt(b.gold)}g
                      {b.loot.length > 0 &&
                        ` · loot: ${b.loot.map((l) => `${l.qty}× ${l.item}`).join(', ')}`}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
