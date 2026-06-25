import { useState } from 'react';
import { useGame } from '../useGame.js';
import { recipesForCategory, activeRecipeCategory } from '../activities.js';
import { TransformDetail } from './TransformDetail.js';

// Gathering screen: raw extraction (mine, quarry, hunt). While a gather is running
// it shows only the live detail (with a Change button to reveal the options again);
// otherwise it lists the options grouped by activity, leading with what each node
// yields (gathering has no inputs).
export function GatheringPanel() {
  const { me, catalog, selectRecipe } = useGame();
  const [changing, setChanging] = useState(false);
  if (!me || !catalog) return null;

  // A gather is active and not switching → show the detail; "Change" reveals options.
  if (activeRecipeCategory(catalog, me.active_recipe_id) === 'gathering' && !changing) {
    return <TransformDetail onChange={() => setChanging(true)} />;
  }
  const pick = (recipeId: number) => {
    void selectRecipe(recipeId);
    setChanging(false);
  };

  const recipes = recipesForCategory(catalog, 'gathering');
  const itemName = (code: string) => catalog.items.find((i) => i.code === code)?.name ?? code;
  const skillName = (recipeActivityId: number) => {
    const act = catalog.activities.find((a) => a.id === recipeActivityId);
    return catalog.skills.find((s) => s.id === act?.skill_id)?.name ?? '';
  };
  // Preserve catalog order while grouping by activity (Mine, Quarry, Hunt …).
  const activityIds = [...new Set(recipes.map((r) => r.activity_id))];
  const activityName = (id: number) => catalog.activities.find((a) => a.id === id)?.name ?? '?';

  return (
    <>
      {activityIds.map((actId) => (
        <section key={actId} className="panel">
          <h2>{activityName(actId)}</h2>
          <div className="list">
            {recipes
              .filter((r) => r.activity_id === actId)
              .map((r) => (
                <div
                  key={r.id}
                  className={`card row ${me.active_recipe_id === r.id ? 'selected' : ''}`}
                  style={{ justifyContent: 'space-between' }}
                >
                  <div>
                    <strong>{r.name}</strong>{' '}
                    <span className="muted">
                      ({skillName(r.activity_id)} · req Lv {r.req_level})
                    </span>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Yields{' '}
                      {r.outputs
                        .map(
                          (o) =>
                            `${o.qty}× ${itemName(o.item)}` +
                            (o.chance !== undefined && o.chance < 1
                              ? ` (${Math.round(o.chance * 100)}%)`
                              : ''),
                        )
                        .join(', ')}
                    </div>
                  </div>
                  <button
                    className="primary"
                    disabled={me.active_recipe_id === r.id}
                    onClick={() => pick(r.id)}
                  >
                    {me.active_recipe_id === r.id ? 'Active' : 'Gather'}
                  </button>
                </div>
              ))}
          </div>
        </section>
      ))}
    </>
  );
}
