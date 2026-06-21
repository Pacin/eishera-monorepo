import { useGame } from '../useGame.js';
import { fmt } from '../format.js';

export function ActionsPanel() {
  const { me, catalog, battles, selectRecipe, battle } = useGame();
  if (!me || !catalog) return null;

  const activityName = (id: number) => catalog.activities.find((a) => a.id === id)?.name ?? '?';

  return (
    <>
      <section className="panel">
        <h2>Current action</h2>
        <p className="muted">
          {me.active_recipe_id !== null
            ? `Gathering/crafting: ${catalog.recipes.find((r) => r.id === me.active_recipe_id)?.name ?? '?'}`
            : me.active_monster_id !== null
              ? `Battling: ${catalog.monsters.find((m) => m.id === me.active_monster_id)?.name ?? '?'}`
              : 'Idle — pick a recipe or monster below.'}
        </p>
        {(me.active_recipe_id !== null || me.active_monster_id !== null) && (
          <button onClick={() => void selectRecipe(null)}>Stop</button>
        )}
      </section>

      <section className="panel">
        <h2>Gather &amp; craft</h2>
        <div className="list">
          {catalog.recipes.map((r) => (
            <div
              key={r.id}
              className={`card row ${me.active_recipe_id === r.id ? 'selected' : ''}`}
              style={{ justifyContent: 'space-between' }}
            >
              <div>
                <strong>{r.name}</strong>{' '}
                <span className="muted">
                  ({activityName(r.activity_id)} · req Lv {r.req_level})
                </span>
                {r.inputs.length > 0 && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    needs {r.inputs.map((i) => `${i.qty}× ${i.item}`).join(', ')}
                  </div>
                )}
              </div>
              <button
                className="primary"
                disabled={me.active_recipe_id === r.id}
                onClick={() => void selectRecipe(r.id)}
              >
                {me.active_recipe_id === r.id ? 'Active' : 'Start'}
              </button>
            </div>
          ))}
        </div>
      </section>

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
                <strong>{m.name}</strong>{' '}
                <span className="muted">
                  (T{m.tier} · {fmt(m.hp)} HP · {fmt(m.xp)} xp · {fmt(m.gold_min)}–{fmt(m.gold_max)}
                  g)
                </span>
              </div>
              <button
                className="primary"
                disabled={me.active_monster_id === m.id}
                onClick={() => void battle(m.id)}
              >
                {me.active_monster_id === m.id ? 'Fighting' : 'Fight'}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Recent fights</h2>
        {battles.length === 0 ? (
          <p className="muted">No fights yet. Battle results stream in live.</p>
        ) : (
          <div className="list">
            {battles.map((b, i) => (
              <div key={i} className="card">
                <span className={b.won ? 'good' : 'bad'}>{b.won ? 'WON' : 'LOST'}</span> vs{' '}
                <strong>{b.monster}</strong> — dealt {fmt(b.damage_dealt)} / took{' '}
                {fmt(b.damage_taken)} in {b.rounds} rounds
                {b.won && (
                  <span className="muted">
                    {' '}
                    · +{fmt(b.xp)} xp · +{fmt(b.gold)}g
                    {b.loot.length > 0 &&
                      ` · loot: ${b.loot.map((l) => `${l.qty}× ${l.item}`).join(', ')}`}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
