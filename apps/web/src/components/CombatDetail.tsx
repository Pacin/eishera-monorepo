import { useGame } from '../useGame.js';
import { fmt } from '../format.js';
import { ratePerHour } from '../tracker.js';

// Combat detail: the latest battle's report (HP bars, hit/miss breakdown, outcome,
// gains) plus the persistent Action Tracker. Renders once an action has resolved.
export function CombatDetail({ onChange }: { onChange: () => void }) {
  const { me, catalog, battles, combatTracker, resetCombatTracker } = useGame();
  if (!me || !catalog) return null;
  const r = battles[0];
  // Active but no action resolved yet (first tick pending) — show a placeholder.
  if (!r) {
    return (
      <section className="panel">
        <div className="detail-head">
          <h2>Battle report</h2>
          <button onClick={onChange}>Change</button>
        </div>
        <p className="muted">Engaging… the first result lands next tick.</p>
      </section>
    );
  }

  const itemName = (code: string) => catalog.items.find((i) => i.code === code)?.name ?? code;
  const combatLevel = me.skills.find((s) => s.code === 'combat')?.level ?? 1;
  const playerPct = r.player_max_hp > 0 ? (r.player_hp / r.player_max_hp) * 100 : 0;
  const foePct = r.monster_max_hp > 0 ? (r.monster_hp / r.monster_max_hp) * 100 : 0;
  const perHit = (dmg: number, hits: number) => (hits > 0 ? Math.round(dmg / hits) : 0);

  const total = combatTracker.wins + combatTracker.losses;
  const winPct = total > 0 ? ((combatTracker.wins / total) * 100).toFixed(2) : '0.00';
  const now = Date.now();
  const goldRate = ratePerHour(combatTracker.gold, combatTracker.since, now);

  return (
    <section className="panel">
      <div className="detail-head">
        <h2>Battle report</h2>
        <button onClick={onChange}>Change</button>
      </div>

      <div className="duel-head">
        <div className="duel-side">
          <div>
            <strong>{me.username}</strong> <span className="muted">Lv {combatLevel}</span>
          </div>
          <div className="bar duel mine">
            <span style={{ width: `${playerPct}%` }} />
            <div className="bar-label">
              {fmt(r.player_hp)} / {fmt(r.player_max_hp)}
            </div>
          </div>
        </div>
        <span className="muted vs">VS</span>
        <div className="duel-side">
          <div>
            <strong>{r.monster}</strong>
          </div>
          <div className="bar duel foe">
            <span style={{ width: `${foePct}%` }} />
            <div className="bar-label">
              {fmt(r.monster_hp)} / {fmt(r.monster_max_hp)}
            </div>
          </div>
        </div>
      </div>

      <p>
        You hit {r.monster} <b>{fmt(r.player_hits)}</b> time(s) dealing{' '}
        <b>{fmt(perHit(r.damage_dealt, r.player_hits))}</b> damage per hit. You missed{' '}
        <b>{fmt(r.player_misses)}</b> time(s).
      </p>
      <p>
        {r.monster} hit you <b>{fmt(r.monster_hits)}</b> time(s) dealing{' '}
        <b>{fmt(perHit(r.damage_taken, r.monster_hits))}</b> damage per hit. {r.monster} missed{' '}
        <b>{fmt(r.monster_misses)}</b> time(s).
      </p>
      <p className={`outcome ${r.won ? 'win' : 'loss'}`}>
        {r.won ? 'You were victorious!' : 'You were defeated.'}
      </p>

      <div className="gains muted">
        {r.boosted && <div className="boost">Bonus active</div>}
        <div>+{fmt(r.xp)} [Battling Exp]</div>
        <div>+{fmt(r.gold)} [Gold]</div>
        {r.levels_gained > 0 && (
          <div className="level-up">
            {r.levels_gained === 1
              ? 'You gained a level!'
              : `You gained ${r.levels_gained} levels!`}
          </div>
        )}
        {r.loot.map((l) => (
          <div key={l.item}>
            +{fmt(l.qty)} [{itemName(l.item)}]
          </div>
        ))}
      </div>

      <div className="tracker">
        <h3>Action Tracker</h3>
        <div className="tracker-row">
          <span>Wins / Losses</span>
          <b>
            {fmt(combatTracker.wins)} / {fmt(combatTracker.losses)} ({winPct}%)
          </b>
        </div>
        <div className="tracker-row">
          <span>Gold Gained</span>
          <b>
            {fmt(combatTracker.gold)} ({fmt(goldRate)} per hour)
          </b>
        </div>
        <button onClick={resetCombatTracker}>Reset</button>
      </div>
    </section>
  );
}
