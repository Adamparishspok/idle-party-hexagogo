import { SEED_ITEMS, SEED_RECIPES, SEED_TUTORIAL_STEPS, SEED_BAG_ITEMS, SEED_JEWEL_ITEMS, STARTER_BAG_ITEM } from '@idle-party-rpg/shared';
import type { ItemDefinition, RecipeDefinition, TutorialStepDefinition } from '@idle-party-rpg/shared';

export const SEED_IMPORT_KINDS = ['tutorial', 'items'] as const;
export type SeedImportKind = (typeof SEED_IMPORT_KINDS)[number];

export interface SeedCatalog {
  tutorialSteps: TutorialStepDefinition[];
  items: ItemDefinition[];
  recipes: RecipeDefinition[];
}

export type SeedImportCounts = { [K in keyof SeedCatalog]: number };

export function seedCatalog(): SeedCatalog {
  return {
    tutorialSteps: SEED_TUTORIAL_STEPS,
    items: [...Object.values(SEED_ITEMS), STARTER_BAG_ITEM, ...SEED_BAG_ITEMS, ...SEED_JEWEL_ITEMS],
    recipes: Object.values(SEED_RECIPES),
  };
}

const KIND_COLLECTIONS: Record<SeedImportKind, (keyof SeedCatalog)[]> = {
  tutorial: ['tutorialSteps'],
  items: ['items', 'recipes'],
};

export function collectionsForKinds(kinds: readonly SeedImportKind[]): (keyof SeedCatalog)[] {
  return [...new Set(kinds.flatMap(k => KIND_COLLECTIONS[k]))];
}

export function parseSeedImportKinds(raw: unknown): SeedImportKind[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.every(k => (SEED_IMPORT_KINDS as readonly string[]).includes(k)) ? raw as SeedImportKind[] : null;
}

/** Seed entries whose id is absent from `existing`. Never touches entries that already exist. */
export function missingById<T extends { id: string }>(existing: Iterable<string>, seed: readonly T[] | readonly { id: string }[]): T[] {
  const have = new Set(existing);
  return (seed as readonly T[]).filter(e => !have.has(e.id));
}
