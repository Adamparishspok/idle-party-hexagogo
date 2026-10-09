import { describe, expect, it } from 'vitest';
import {
  CLASS_ATTRIBUTE_PROFILES,
  MAX_ATTRIBUTE_CRIT,
  classBaseAttributes,
  computeDerivedStats,
  computeSetAttributes,
  derivedToEquipmentBonuses,
  equipmentAttributes,
  itemAttributes,
  suggestedAttributeBudget,
  validateAttributes,
} from '../src/systems/AttributeTypes';
import { ALL_CLASS_NAMES, calculateBaseDamage, calculateMaxHp } from '../src/systems/CharacterStats';
import type { ItemDefinition } from '../src/systems/ItemTypes';
import type { SetDefinition } from '../src/systems/SetTypes';

const ITEMS: Record<string, ItemDefinition> = {
  helm: { id: 'helm', name: 'Helm', rarity: 'common', equipSlot: 'head', attributes: { stamina: 5, strength: 10 } },
  old_vest: { id: 'old_vest', name: 'Old Vest', rarity: 'common', equipSlot: 'chest', damageReductionMin: 1, damageReductionMax: 2 },
  bow: { id: 'bow', name: 'Bow', rarity: 'rare', equipSlot: 'twohanded', attributes: { agility: 4 }, bonusAttackMin: 2, bonusAttackMax: 5 },
  heir: { id: 'heir', name: 'Heir', rarity: 'heirloom', equipSlot: 'ring', attributes: { intellect: 1 } },
};

const naked = { head: null, chest: null, mainhand: null, offhand: null, ring: null };

describe('class base attributes', () => {
  it('reproduce today’s HP and damage for every class at every level', () => {
    for (const className of ALL_CLASS_NAMES) {
      for (let level = 1; level <= 60; level++) {
        const stats = computeDerivedStats({ className, level, equipment: naked, items: ITEMS });
        expect(stats.maxHp).toBe(calculateMaxHp(level, className));
        expect(stats.damage).toBe(calculateBaseDamage(level, className));
      }
    }
  });

  it('put only Stamina and the primary attribute on a naked class', () => {
    expect(classBaseAttributes(10, 'Archer')).toEqual({ strength: 0, agility: 33, intellect: 0, stamina: 17 });
    expect(classBaseAttributes(20, 'Knight')).toEqual({ strength: 40, agility: 0, intellect: 0, stamina: 72 });
    expect(CLASS_ATTRIBUTE_PROFILES.Bard.primary).toBe('intellect');
    expect(classBaseAttributes(10, 'Bard')).toEqual({ strength: 0, agility: 0, intellect: 20, stamina: 19 });
  });
});

describe('derived stats', () => {
  it('converts gear attributes at the class’s rates', () => {
    const knight = computeDerivedStats({ className: 'Knight', level: 10, equipment: { ...naked, head: 'helm' }, items: ITEMS });
    expect(knight.damage).toBe(10 + 5);
    expect(knight.maxHp).toBe(95 + 10);
    expect(knight.attributes.strength).toBe(30);
    expect(knight.armorMin).toBe(2);

    const mage = computeDerivedStats({ className: 'Mage', level: 10, equipment: { ...naked, head: 'helm' }, items: ITEMS });
    expect(mage.damage).toBe(calculateBaseDamage(10, 'Mage'));
    expect(mage.maxHp).toBe(17 + 5);
    expect(mage.armorMin).toBe(0);
    expect(mage.resistMin).toBe(2);
  });

  it('keeps legacy flat item stats working alongside attributes', () => {
    const stats = computeDerivedStats({ className: 'Knight', level: 1, equipment: { ...naked, chest: 'old_vest' }, items: ITEMS });
    expect(stats.armorMin).toBe(1);
    expect(stats.armorMax).toBe(2);
    expect(derivedToEquipmentBonuses(stats)).toMatchObject({ damageReductionMin: 1, damageReductionMax: 2 });
  });

  it('counts a two-handed weapon once', () => {
    const equipment = { ...naked, mainhand: 'bow', offhand: 'bow' };
    expect(equipmentAttributes(equipment, ITEMS).agility).toBe(4);
    const stats = computeDerivedStats({ className: 'Archer', level: 1, equipment, items: ITEMS });
    expect(stats.damage).toBe(19);
    expect(stats.attackBonusMax).toBe(5);
    expect(stats.critChance).toBeCloseTo(0.019);
    expect(stats.dodgeChance).toBeCloseTo(0.0095);
  });

  it('scales heirloom attributes by level', () => {
    expect(itemAttributes(ITEMS.heir, 12).intellect).toBe(12);
    expect(itemAttributes(ITEMS.helm, 12).strength).toBe(10);
  });

  it('caps attribute crit', () => {
    const items: Record<string, ItemDefinition> = { gem: { id: 'gem', name: 'Gem', rarity: 'epic', equipSlot: 'relic', attributes: { agility: 9999 } } };
    expect(computeDerivedStats({ className: 'Archer', level: 1, equipment: { relic: 'gem' }, items }).critChance).toBe(MAX_ATTRIBUTE_CRIT);
  });

  it('adds set attributes and set HP bonuses on top of Stamina', () => {
    const sets: Record<string, SetDefinition> = {
      s: { id: 's', name: 'S', itemIds: ['helm', 'old_vest'], breakpoints: [{ piecesRequired: 2, bonuses: { attributes: { stamina: 10 }, percentHp: 10 } }] },
    };
    const equipment = { ...naked, head: 'helm', chest: 'old_vest' };
    expect(computeSetAttributes(equipment, sets, 'Priest').stamina).toBe(10);
    const stats = computeDerivedStats({ className: 'Priest', level: 1, equipment, items: ITEMS, sets });
    expect(stats.maxHp).toBe(Math.floor((20 + 15 * 1.5) * 1.1));
  });
});

describe('healing', () => {
  const tome: Record<string, ItemDefinition> = { tome: { id: 'tome', name: 'Tome', rarity: 'rare', equipSlot: 'relic', attributes: { intellect: 36 } } };

  it('is unchanged naked', () => {
    for (const className of ALL_CLASS_NAMES) {
      expect(computeDerivedStats({ className, level: 20, equipment: {}, items: tome }).healingMultiplier).toBe(1);
    }
  });

  it('grows a Priest’s heals by the same percentage as its damage', () => {
    const naked = computeDerivedStats({ className: 'Priest', level: 20, equipment: {}, items: tome });
    const geared = computeDerivedStats({ className: 'Priest', level: 20, equipment: { relic: 'tome' }, items: tome });
    expect(geared.healingMultiplier).toBeCloseTo(geared.damage / naked.damage, 5);
  });

  it('comes from gear Intellect for any class', () => {
    const knight = computeDerivedStats({ className: 'Knight', level: 20, equipment: { relic: 'tome' }, items: tome });
    expect(knight.healingMultiplier).toBeCloseTo(1 + 18 / 20);
  });
});

describe('validateAttributes', () => {
  it('accepts whole numbers on known attributes only', () => {
    expect(validateAttributes(undefined)).toBeNull();
    expect(validateAttributes({ strength: 3, stamina: -1 })).toBeNull();
    expect(validateAttributes({ luck: 1 })).toMatch(/Unknown attribute/);
    expect(validateAttributes({ agility: 1.5 })).toMatch(/whole number/);
    expect(validateAttributes([1])).toMatch(/object/);
  });
});

describe('suggestedAttributeBudget', () => {
  it('grows with item level and rarity, doubled for two-handers', () => {
    expect(suggestedAttributeBudget(1, 'janky')).toBe(1);
    expect(suggestedAttributeBudget(10, 'uncommon')).toBe(3);
    expect(suggestedAttributeBudget(20, 'uncommon')).toBe(5);
    expect(suggestedAttributeBudget(20, 'uncommon', true)).toBe(10);
    expect(suggestedAttributeBudget(20, 'legendary')).toBe(10);
    expect(suggestedAttributeBudget(20, 'heirloom')).toBe(1);
  });
});
