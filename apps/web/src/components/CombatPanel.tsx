import { useState } from 'react';
import { useGame } from '../useGame.js';
import { fmt } from '../format.js';
import { CombatDetail } from './CombatDetail.js';

// Combat screen: pick a monster to battle. While a battle is running it shows only
// the live battle report (with a Change button to reveal the targets again);
// otherwise it lists monsters with their combat-relevant stats (tier, HP, attack,
// and the XP/gold payout) so the choice is informed.
export function CombatPanel() {
  const { me, catalog, battle } = useGame();
  const [changing, setChanging] = useState(false);
  if (!me || !catalog) return null;

  // A battle is active and not switching → show the detail; "Change" reveals targets.
  if (me.active_monster_id !== null && !changing) {
    return <CombatDetail onChange={() => setChanging(true)} />;
  }
  const pick = (monsterId: number) => {
    void battle(monsterId);
    setChanging(false);
  };

  return (
    <>
      <section className="panel">
        <h2>Battle</h2>
        <div className="list">
          {catalog.monsters.map((m) => (
            <div
              key={m.id}
              className={`card row ${me.active_monster_id === m.id ? 'selected' : ''}`}
              style={{ justifyContent: 'space-between' }}
            >
              <div>
                <strong>{m.name}</strong> <span className="muted">Tier {m.tier}</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {fmt(m.hp)} HP · {fmt(m.attack)} ATK · {fmt(m.xp)} xp · {fmt(m.gold_min)}–
                  {fmt(m.gold_max)} gold
                </div>
              </div>
              <button
                className="primary"
                disabled={me.active_monster_id === m.id}
                onClick={() => pick(m.id)}
              >
                {me.active_monster_id === m.id ? 'Fighting' : 'Fight'}
              </button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
