import { xpToNext } from '@eishera/shared';
import { useGame } from '../useGame.js';
import { fmt } from '../format.js';

// Character profile: attributes + skills. Moved out of the left rail into a
// center-column tab (same data, laid out as full-width panels).
const STAT_LABELS: Record<string, string> = {
  str: 'STR',
  vit: 'VIT',
  def: 'DEF',
  eva: 'EVA',
  dex: 'DEX',
  luck: 'LUCK',
};

export function ProfilePanel() {
  const { me, catalog } = useGame();
  if (!me || !catalog) return null;
  const skillName = (code: string) => catalog.skills.find((s) => s.code === code)?.name ?? code;

  return (
    <>
      <section className="panel">
        <h2>Attributes</h2>
        <div className="stat-grid">
          {Object.entries(me.stats).map(([k, v]) => (
            <div key={k} className="stat-chip">
              <span className="muted">{STAT_LABELS[k] ?? k.toUpperCase()}</span>
              <b>{fmt(v)}</b>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Skills</h2>
        <div className="skill-list">
          {me.skills.map((s) => {
            // Shared formula: same curve the server uses, so the bar is exact.
            const need = xpToNext(s.level, catalog.xp_curve);
            const pct = need > 0 ? Math.min(100, (s.xp / need) * 100) : 0;
            return (
              <div key={s.code} className="skill-row">
                <div className="skill-top">
                  <strong>{skillName(s.code)}</strong>
                  <span className="muted">Lv {s.level}</span>
                </div>
                <div className="bar xp">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <div className="skill-xp muted">
                  {fmt(s.xp)} / {fmt(need)} xp
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
