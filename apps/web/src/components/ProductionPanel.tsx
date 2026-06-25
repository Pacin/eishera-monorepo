import { useState } from 'react';
import { useGame } from '../useGame.js';
import { recipesForCategory, activeRecipeCategory, type ActivityCategory } from '../activities.js';
import { TransformDetail } from './TransformDetail.js';

// Production screen shared by Crafting and Alchemy: both consume inputs to make an
// output. While a recipe of this category is running it shows only the live detail
// (with a Change button to reveal the options again); otherwise it lists the
// recipes, leading with the inputs needed and what they make.
export function ProductionPanel({
  category,
  verb,
}: {
  category: ActivityCategory;
  verb: string;
}) {
  const { me, catalog, inventory, selectRecipe } = useGame();
  const [changing, setChanging] = useState(false);
  if (!me || !catalog) return null;

  // A recipe of this category is active and not switching → show the detail.
  if (activeRecipeCategory(catalog, me.active_recipe_id) === category && !changing) {
    return <TransformDetail onChange={() => setChanging(true)} />;
  }
  const pick = (recipeId: number) => {
    void selectRecipe(recipeId);
    setChanging(false);
  };

  const recipes = recipesForCategory(catalog, category);
  const itemName = (code: string) => catalog.items.find((i) => i.code === code)?.name ?? code;
  const held = (code: string) => inventory?.stacks.find((s) => s.item === code)?.qty ?? 0;

  return (
    <>
      <section className="panel">
        <h2>{verb}</h2>
        <div className="list">
          {recipes.map((r) => (
            <div
              key={r.id}
              className={`card row ${me.active_recipe_id === r.id ? 'selected' : ''}`}
              style={{ justifyContent: 'space-between' }}
            >
              <div>
                <strong>{r.name}</strong> <span className="muted">(req Lv {r.req_level})</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  Needs{' '}
                  {r.inputs
                    .map((i) => `${i.qty}× ${itemName(i.item)} (have ${held(i.item)})`)
                    .join(', ')}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Makes {r.outputs.map((o) => `${o.qty}× ${itemName(o.item)}`).join(', ')}
                </div>
              </div>
              <button
                className="primary"
                disabled={me.active_recipe_id === r.id}
                onClick={() => pick(r.id)}
              >
                {me.active_recipe_id === r.id ? 'Active' : verb}
              </button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
