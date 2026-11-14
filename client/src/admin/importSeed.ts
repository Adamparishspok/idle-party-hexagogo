import type { AdminContext } from './AdminContext';
import type { ContentData } from './types';
import { postAdmin } from './api';

type SeedKind = 'tutorial' | 'items';

interface ImportResult extends Pick<ContentData, 'tutorialSteps' | 'items' | 'recipes'> {
  counts: { tutorialSteps: number; items: number; recipes: number };
}

/** Adds the default entries whose ids are missing; never overwrites existing ones. */
export async function importSeedDefaults(ctx: AdminContext, kind: SeedKind, label: string): Promise<void> {
  if (!confirm(`Add any missing default ${label}? Existing entries are left untouched.`)) return;
  try {
    const { counts, tutorialSteps, items, recipes } = await postAdmin<ImportResult>(
      `/api/admin/import-seed-defaults${ctx.versionQueryParam()}`, { kinds: [kind] });
    ctx.patchVersionContent(kind === 'tutorial' ? { tutorialSteps } : { items, recipes });
    ctx.rerenderTab();
    const parts = kind === 'tutorial' ? [`${counts.tutorialSteps} steps`] : [`${counts.items} items`, `${counts.recipes} recipes`];
    alert(`Added ${parts.join(', ')}.`);
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Network error');
  }
}
