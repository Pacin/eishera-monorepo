import type { GameCatalog, CatalogRecipe } from '@eishera/shared';

// The center column splits the old single "Actions" surface into one tab per
// activity category. Categories are derived from the catalog (skill → category),
// with a structural fallback so an unmapped transform skill still lands somewhere
// sensible (no inputs ⇒ gathering, consumes inputs ⇒ crafting).
export type ActivityCategory = 'gathering' | 'crafting' | 'alchemy' | 'combat';

const SKILL_CATEGORY: Record<string, ActivityCategory> = {
  mining: 'gathering',
  quarrying: 'gathering',
  hunting: 'gathering',
  crafting: 'crafting',
  alchemy: 'alchemy',
  combat: 'combat',
};

/** Which tab a recipe belongs to (combat has no recipes — it uses monsters). */
export function categoryForRecipe(
  catalog: GameCatalog,
  recipe: CatalogRecipe,
): ActivityCategory | null {
  const activity = catalog.activities.find((a) => a.id === recipe.activity_id);
  if (!activity) return null;
  if (activity.archetype === 'combat') return 'combat';
  const skill = catalog.skills.find((s) => s.id === activity.skill_id);
  const mapped = skill ? SKILL_CATEGORY[skill.code] : undefined;
  if (mapped) return mapped;
  return recipe.inputs.length === 0 ? 'gathering' : 'crafting';
}

/** All recipes for a category, in catalog order. */
export function recipesForCategory(
  catalog: GameCatalog,
  category: ActivityCategory,
): CatalogRecipe[] {
  return catalog.recipes.filter((r) => categoryForRecipe(catalog, r) === category);
}

/** The category of the player's currently active recipe, or null if none. */
export function activeRecipeCategory(
  catalog: GameCatalog,
  activeRecipeId: number | null,
): ActivityCategory | null {
  if (activeRecipeId == null) return null;
  const recipe = catalog.recipes.find((r) => r.id === activeRecipeId);
  return recipe ? categoryForRecipe(catalog, recipe) : null;
}
