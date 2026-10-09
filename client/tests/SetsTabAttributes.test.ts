import { describe, expect, it } from 'vitest';
import { readSetAttributeInputs } from '../src/admin/tabs/SetsTab';

function row(values: Record<string, string>): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = Object.entries(values)
    .map(([attr, v]) => `<input class="sf-bp-attr" data-attr="${attr}" value="${v}">`).join('');
  return el;
}

describe('readSetAttributeInputs', () => {
  it('keeps positive whole numbers and skips blanks and zeros', () => {
    expect(readSetAttributeInputs(row({ strength: '3', agility: '', intellect: '0', stamina: '12' })))
      .toEqual({ attributes: { strength: 3, stamina: 12 } });
    expect(readSetAttributeInputs(row({ strength: '0' }))).toEqual({});
  });

  it('refuses negatives and fractions', () => {
    expect(readSetAttributeInputs(row({ strength: '-2' })).error).toBe('Strength must be a whole number of 0 or more.');
    expect(readSetAttributeInputs(row({ stamina: '1.5' })).error).toMatch(/Stamina/);
  });
});
