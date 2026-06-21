import { xpToNext } from '@eishera/shared';
import { useGame } from '../useGame.js';
import { fmt } from '../format.js';

const STAT_LABELS: Record<string, string> = {
  str: 'STR',
  vit: 'VIT',
  def: 'DEF',
  eva: 'EVA',
  dex: 'DEX',
  luck: 'LUCK',
};

export function CharacterPanel() {
  const { me, catalog } = useGame();
  if (!me || !catalog) return null;
  const skillName = (code: string) => catalog.skills.find((s) => s.code === code)?.name ?? code;

  return (
    <>
      <section className="panel">
        <h2>Base stats</h2>
        <div className="kv">
          {Object.entries(me.stats).map(([k, v]) => (
            <div key={k} className="card">
              <div className="muted">{STAT_LABELS[k] ?? k.toUpperCase()}</div>
              <div style={{ fontSize: '1.3rem' }}>{fmt(v)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Skills</h2>
        <div className="list">
          {me.skills.map((s) => {
            // Shared formula: same curve the server uses, so the bar is exact.
            const need = xpToNext(s.level, catalog.xp_curve);
            const pct = need > 0 ? Math.min(100, (s.xp / need) * 100) : 0;
            return (
              <div key={s.code} className="card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{skillName(s.code)}</strong>
                  <span className="muted">
                    Lv {s.level} · {fmt(s.xp)}/{fmt(need)} xp
                  </span>
                </div>
                <div className="bar xp" style={{ marginTop: 4 }}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
