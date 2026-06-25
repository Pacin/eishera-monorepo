import { useGame } from '../useGame.js';
import { fmt } from '../format.js';
import { ratePerHour } from '../tracker.js';

// Gather/craft detail: the latest action's flavor + gains, your current items, and
// the persistent Action Tracker. Shared by the Gathering/Crafting/Alchemy tabs;
// renders once an action has resolved (gathers[0] exists).
const FLAVOR: Record<string, string> = {
  mine: 'You swing your pick…',
  quarry: 'You cut into the stone…',
  hunt: 'You stalk your quarry…',
  craft: 'You work at the anvil…',
  brew: 'You stir the cauldron…',
};

export function TransformDetail({ onChange }: { onChange: () => void }) {
  const { me, catalog, inventory, gathers, gatherTracker, resetGatherTracker } = useGame();
  if (!me || !catalog) return null;
  const r = gathers[0];
  // Active but no action resolved yet (first tick pending) — show a placeholder.
  if (!r) {
    return (
      <section className="panel">
        <div className="detail-head">
          <h2>Working…</h2>
          <button onClick={onChange}>Change</button>
        </div>
        <p className="muted">Your first result lands next tick.</p>
      </section>
    );
  }

  const itemName = (code: string) => catalog.items.find((i) => i.code === code)?.name ?? code;
  const skillName = catalog.skills.find((s) => s.code === r.skill)?.name ?? r.skill;
  const now = Date.now();
  const rate = ratePerHour(gatherTracker.resources, gatherTracker.since, now);

  return (
    <section className="panel">
      <div className="detail-head">
        <h2>{r.recipe}</h2>
        <button onClick={onChange}>Change</button>
      </div>
      <p className="muted">{FLAVOR[r.activity] ?? 'You set to work…'}</p>

      {r.stalled ? (
        <p className="outcome loss">Stalled — you&apos;re missing the materials for this.</p>
      ) : (
        <div className="gains muted">
          {r.boosted && <div className="boost">Bonus active</div>}
          <div>
            +{fmt(r.xp)} [{skillName} Exp]
          </div>
          {r.levels_gained > 0 && (
            <div className="level-up">
              {r.levels_gained === 1
                ? 'You gained a level!'
                : `You gained ${r.levels_gained} levels!`}
            </div>
          )}
          {r.outputs.map((o) => (
            <div key={o.item}>
              +{fmt(o.qty)} [{itemName(o.item)}]
            </div>
          ))}
        </div>
      )}

      {inventory && inventory.stacks.length > 0 && (
        <>
          <h3 style={{ margin: '0.8rem 0 0.4rem' }}>Your Items</h3>
          <div className="stat-grid">
            {inventory.stacks.map((s) => (
              <div key={s.item} className="stat-chip">
                <span className="muted">{itemName(s.item)}</span>
                <b>{fmt(s.qty)}</b>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="tracker">
        <h3>Action Tracker</h3>
        <div className="tracker-row">
          <span>Total Actions</span>
          <b>{fmt(gatherTracker.actions)}</b>
        </div>
        <div className="tracker-row">
          <span>Resources Gained</span>
          <b>
            {fmt(gatherTracker.resources)} ({fmt(rate)} per hour)
          </b>
        </div>
        <button onClick={resetGatherTracker}>Reset</button>
      </div>
    </section>
  );
}
