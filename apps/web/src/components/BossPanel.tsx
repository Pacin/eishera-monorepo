import { useGame } from '../useGame.js';
import { fmt, duration } from '../format.js';

export function BossPanel() {
  const { boss, catalog, joinBoss } = useGame();
  // Boss state arrives via the sync bootstrap and live boss:update pushes (sent
  // to all online players each tick while a boss is active), so there's nothing
  // to fetch on open — a newly-spawned boss appears on the next tick.
  if (!catalog) return null;

  const join = () => void joinBoss();

  if (!boss || !boss.active) {
    return (
      <section className="panel">
        <h2>World boss</h2>
        <p className="muted">No active boss. Joining spawns one.</p>
        <button className="primary" onClick={() => void join()}>
          Join the hunt
        </button>
      </section>
    );
  }

  const hpPct = boss.max_hp ? Math.max(0, (boss.hp! / boss.max_hp) * 100) : 0;
  const secsLeft = (boss.ticks_remaining ?? 0) * catalog.tick_seconds;

  return (
    <section className="panel">
      <h2>World boss — Tier {boss.tier}</h2>
      <div className="bar hp" style={{ height: 16 }}>
        <span style={{ width: `${hpPct}%` }} />
      </div>
      <p className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          {fmt(boss.hp ?? 0)} / {fmt(boss.max_hp ?? 0)} HP
        </span>
        <span className="muted">{duration(secsLeft)} left</span>
      </p>
      <div className="kv">
        <div className="card">
          <div className="muted">Participants</div>
          <div>{fmt(boss.participants ?? 0)}</div>
        </div>
        <div className="card">
          <div className="muted">Your damage</div>
          <div>{fmt(boss.your_damage ?? 0)}</div>
        </div>
      </div>
      {!boss.joined && (
        <button className="primary" style={{ marginTop: 10 }} onClick={() => void join()}>
          Join the hunt
        </button>
      )}
      {boss.joined && (
        <p className="muted" style={{ marginTop: 10 }}>
          You’re in the fight — your damage accrues every tick.
        </p>
      )}
    </section>
  );
}
