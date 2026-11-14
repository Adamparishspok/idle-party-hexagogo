import { describe, it, expect } from 'vitest';
import { SEED_MONSTERS, SEED_ITEMS } from '@idle-party-rpg/shared';
import { draftSimContent } from '../src/admin/simulatorRoutes.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { ContentSnapshot } from '../src/game/VersionStore.js';

const liveSkills = { live_skill: { id: 'live_skill' } };
const store = new Proxy({}, {
  get: (_t, name: string) => () => (name === 'getAllSkills' ? liveSkills : {}),
}) as unknown as ContentStore;

describe('draftSimContent', () => {
  it('uses the draft snapshot tables as records', () => {
    const monster = { ...SEED_MONSTERS[Object.keys(SEED_MONSTERS)[0]], id: 'draft_monster' };
    const snapshot = { monsters: [monster], items: Object.values(SEED_ITEMS).slice(0, 1), zones: [] } as unknown as ContentSnapshot;
    const content = draftSimContent(snapshot, store);
    expect(Object.keys(content.monsters)).toEqual(['draft_monster']);
    expect(Object.keys(content.items)).toHaveLength(1);
  });

  it('falls back to live tables the snapshot predates', () => {
    const content = draftSimContent({ monsters: [], items: [], zones: [] } as unknown as ContentSnapshot, store);
    expect(content.skills).toBe(liveSkills);
  });
});
