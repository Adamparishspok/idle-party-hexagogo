import { describe, it, expect } from 'vitest';
import type { SetDefinition } from '@idle-party-rpg/shared';

const { validateSetDefinition } = await import('../src/game/ContentStore.js');

function set(attributes: Record<string, unknown>): SetDefinition {
  return {
    id: 'set', name: 'Set', itemIds: ['a', 'b'],
    breakpoints: [{ piecesRequired: 2, bonuses: { attributes } as SetDefinition['breakpoints'][number]['bonuses'] }],
  };
}

describe('validateSetDefinition', () => {
  it('accepts whole, non-negative attribute points', () => {
    expect(validateSetDefinition(set({ strength: 5, stamina: 0 }))).toBeNull();
    expect(validateSetDefinition({ id: 's', name: 'S', itemIds: ['a'], breakpoints: [{ piecesRequired: 1, bonuses: {} }] })).toBeNull();
  });

  it('rejects negative, fractional and unknown attributes', () => {
    expect(validateSetDefinition(set({ strength: -1 }))).toMatch(/strength can't be negative/);
    expect(validateSetDefinition(set({ agility: 1.5 }))).toMatch(/whole number/);
    expect(validateSetDefinition(set({ charisma: 2 }))).toMatch(/Unknown attribute/);
  });
});
