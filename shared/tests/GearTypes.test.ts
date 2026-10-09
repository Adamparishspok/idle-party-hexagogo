import { describe, expect, it } from 'vitest';
import { compareEquip, describeItemStats, itemsForSlot, previewEquip, slotAccepts } from '../src/systems/GearTypes';
import type { ItemDefinition } from '../src/systems/ItemTypes';

const ITEMS: Record<string, ItemDefinition> = {
  sword: { id: 'sword', name: 'Sword', rarity: 'common', equipSlot: 'mainhand', attributes: { strength: 3 } },
  axe: { id: 'axe', name: 'Axe', rarity: 'rare', equipSlot: 'twohanded', classRestriction: ['Knight'], bonusAttackMin: 3, bonusAttackMax: 6 },
  shield: { id: 'shield', name: 'Shield', rarity: 'common', equipSlot: 'offhand', damageReductionMin: 1, damageReductionMax: 1 },
  wand: { id: 'wand', name: 'Wand', rarity: 'epic', equipSlot: 'mainhand', classRestriction: ['Mage'] },
  pelt: { id: 'pelt', name: 'Pelt', rarity: 'janky' },
  sack: { id: 'sack', name: 'Sack', rarity: 'common', bagSlots: 8 },
  heir: { id: 'heir', name: 'Heir', rarity: 'heirloom', equipSlot: 'ring', attributes: { stamina: 2 }, bonusAttackMin: 0, bonusAttackMax: 1 },
};

describe('itemsForSlot', () => {
  const inventory = { sword: 1, axe: 1, shield: 2, wand: 1, pelt: 5 };

  it('lists usable items for the slot, two-handers in either hand, best rarity first', () => {
    expect(itemsForSlot('mainhand', inventory, ITEMS, 'Knight').map(c => c.itemId)).toEqual(['axe', 'sword']);
    expect(itemsForSlot('offhand', inventory, ITEMS, 'Knight').map(c => c.itemId)).toEqual(['axe', 'shield']);
    expect(itemsForSlot('mainhand', inventory, ITEMS, 'Mage').map(c => c.itemId)).toEqual(['wand', 'sword']);
    expect(itemsForSlot('head', inventory, ITEMS, 'Mage')).toEqual([]);
  });

  it('knows which slot keys accept which item slots', () => {
    expect(slotAccepts('offhand', 'twohanded')).toBe(true);
    expect(slotAccepts('head', 'twohanded')).toBe(false);
    expect(slotAccepts('head', undefined)).toBe(false);
  });
});

describe('previewEquip', () => {
  it('fills both hands for a two-hander and clears both when replacing one', () => {
    const withShield = { mainhand: 'sword', offhand: 'shield' };
    expect(previewEquip(withShield, 'axe', ITEMS)).toEqual({ mainhand: 'axe', offhand: 'axe' });
    expect(previewEquip({ mainhand: 'axe', offhand: 'axe' }, 'shield', ITEMS)).toEqual({ mainhand: null, offhand: 'shield' });
    expect(withShield).toEqual({ mainhand: 'sword', offhand: 'shield' });
  });
});

describe('compareEquip', () => {
  it('reports what changes if the item is worn', () => {
    const lines = compareEquip({ className: 'Knight', level: 1, equipment: { mainhand: null, offhand: 'shield' }, items: ITEMS }, 'axe');
    const byKey = Object.fromEntries(lines.map(l => [l.key, l]));
    expect(byKey.attackBonus).toMatchObject({ before: '0', after: '3–6', delta: 4.5 });
    expect(byKey.armor).toMatchObject({ before: '1', after: '0', delta: -1 });
    expect(byKey.maxHp).toBeUndefined();
  });

  it('shows primary-attribute gains as damage', () => {
    const lines = compareEquip({ className: 'Knight', level: 5, equipment: { mainhand: null }, items: ITEMS }, 'sword');
    expect(lines.find(l => l.key === 'damage')).toMatchObject({ before: '5', after: '6', delta: 1 });
    expect(lines.find(l => l.key === 'strength')?.delta).toBe(3);
  });
});

describe('describeItemStats', () => {
  it('returns structured lines with the class primary marked', () => {
    const lines = describeItemStats(ITEMS.sword, { className: 'Knight' });
    expect(lines).toEqual([
      { kind: 'slot', text: 'Main Hand', slot: 'mainhand' },
      { kind: 'attribute', text: '+3 Strength', attribute: 'strength', primary: true },
    ]);
    expect(describeItemStats(ITEMS.sword, { className: 'Mage' })[1].primary).toBe(false);
  });

  it('scales heirlooms to the viewer’s level', () => {
    const texts = describeItemStats(ITEMS.heir, { level: 10 }).map(l => l.text);
    expect(texts).toEqual(['Ring', '+20 Stamina', '+0–10 Attack', 'Grows stronger with your level']);
  });

  it('labels bags, materials and class restrictions', () => {
    expect(describeItemStats(ITEMS.sack).map(l => l.kind)).toEqual(['bag']);
    expect(describeItemStats(ITEMS.pelt).map(l => l.kind)).toEqual(['material']);
    expect(describeItemStats(ITEMS.axe).map(l => l.text)).toEqual(['Two-Handed', '+3–6 Attack', 'Classes: Knight']);
  });
});
