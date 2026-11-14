import { describe, expect, it } from 'vitest';
import {
  carryRollHistory,
  makeRolledItemId,
  parseRolledItemId,
  resolveItem,
  rollItemStats,
  rollNewItemId,
  templateIdOf,
  validateRollTable,
  withRolledItems,
} from '../src/systems/ItemRolls';
import type { ItemRollTable } from '../src/systems/ItemRolls';
import { computeEquipmentBonuses, equipItem, addItemToInventory } from '../src/systems/ItemTypes';
import type { ItemDefinition } from '../src/systems/ItemTypes';
import { computeActiveSetBonuses, getSetsForItem } from '../src/systems/SetTypes';
import type { SetDefinition } from '../src/systems/SetTypes';
import { canAddToInventory, usedInventorySlots } from '../src/systems/BagTypes';
import { bankDeposit, emptyBank, toClientBankState } from '../src/systems/BankTypes';
import { getEquippedItemIds } from '../src/systems/InventoryView';
import { socketCapacity } from '../src/systems/SocketTypes';
import { describeItemStats } from '../src/systems/GearTypes';

const V1: ItemRollTable = { version: 1, stats: { bonusAttackMin: { min: 1, max: 3 }, bonusAttackMax: { min: 4, max: 8 }, strength: { min: 0, max: 5 } } };

const sword: ItemDefinition = {
  id: 'sword', name: 'Sword', rarity: 'common', equipSlot: 'mainhand',
  bonusAttackMin: 2, bonusAttackMax: 5, value: 10, sockets: 2, rolls: V1,
};
const plain: ItemDefinition = { id: 'plain', name: 'Plain Hat', rarity: 'common', equipSlot: 'head', damageReductionMin: 1, damageReductionMax: 1 };

function items(...defs: ItemDefinition[]): Record<string, ItemDefinition> {
  return Object.fromEntries(defs.map(d => [d.id, d]));
}

describe('rolled item ids', () => {
  it('round-trips through parse and maps back to the template', () => {
    const id = makeRolledItemId('sword', 1, 123456);
    expect(parseRolledItemId(id)).toEqual({ templateId: 'sword', version: 1, seed: 123456 });
    expect(templateIdOf(id)).toBe('sword');
    expect(templateIdOf('sword')).toBe('sword');
  });

  it('rejects malformed ids', () => {
    for (const bad of ['sword', 'sword~1', 'sword~0~abc', 'sword~x~abc', '~1~abc', 'sword~1~ABC', 'sword~1~zzzzzzz', 'a~1~b~c']) {
      expect(parseRolledItemId(bad)).toBeNull();
    }
  });

  it('only templates with a roll table get rolled ids', () => {
    expect(rollNewItemId(plain)).toBe('plain');
    expect(rollNewItemId(sword, () => 0.5)).toMatch(/^sword~1~[0-9a-z]+$/);
  });
});

describe('rollItemStats', () => {
  it('is deterministic for the same template, table and seed', () => {
    expect(rollItemStats('sword', V1, 42)).toEqual(rollItemStats('sword', V1, 42));
  });

  it('stays inside the ranges and keeps max >= min', () => {
    const qualities = new Set<number>();
    for (let seed = 0; seed < 500; seed++) {
      const { stats, quality } = rollItemStats('sword', V1, seed);
      expect(stats.bonusAttackMin).toBeGreaterThanOrEqual(1);
      expect(stats.bonusAttackMin).toBeLessThanOrEqual(3);
      expect(stats.bonusAttackMax).toBeLessThanOrEqual(8);
      expect(stats.bonusAttackMax!).toBeGreaterThanOrEqual(stats.bonusAttackMin!);
      expect(stats.strength).toBeGreaterThanOrEqual(0);
      expect(stats.strength).toBeLessThanOrEqual(5);
      qualities.add(quality);
    }
    expect(qualities.size).toBeGreaterThan(5);
  });
});

describe('resolveItem', () => {
  const all = items(sword, plain);

  it('returns templates unchanged and rolled ids with rolled stats over the template', () => {
    expect(resolveItem('sword', all)).toBe(sword);
    const id = makeRolledItemId('sword', 1, 7);
    const def = resolveItem(id, all)!;
    const { stats, quality } = rollItemStats('sword', V1, 7);
    expect(def.id).toBe(id);
    expect(def.templateId).toBe('sword');
    expect(def.bonusAttackMin).toBe(stats.bonusAttackMin);
    expect(def.attributes?.strength).toBe(stats.strength);
    expect(def.rollQuality).toBe(quality);
    expect(def.value).toBe(10);
    expect(def.sockets).toBe(2);
    expect(def.rolls).toBeUndefined();
    expect(resolveItem(id, all)).toBe(def);
  });

  it('fails safe on unknown templates, unknown versions and malformed ids', () => {
    expect(resolveItem('nope~1~a', all)).toBeUndefined();
    expect(resolveItem('sword~9~a', all)).toBeUndefined();
    expect(resolveItem('plain~1~a', all)).toBeUndefined();
    expect(resolveItem('sword~1', all)).toBeUndefined();
  });

  it('withRolledItems resolves on index and `in`, but iterates templates only', () => {
    const proxied = withRolledItems(all);
    const id = makeRolledItemId('sword', 1, 99);
    expect(proxied[id]?.templateId).toBe('sword');
    expect(id in proxied).toBe(true);
    expect('sword~1~' in proxied).toBe(false);
    expect(Object.keys(proxied)).toEqual(['sword', 'plain']);
    expect(JSON.parse(JSON.stringify(proxied))).toEqual(all);
  });
});

describe('roll table versioning', () => {
  it('archives the previous table when ranges change and keeps old items resolving', () => {
    const oldId = makeRolledItemId('sword', 1, 5);
    const before = resolveItem(oldId, items(sword))!;
    const rebalanced = carryRollHistory(sword, { ...sword, rolls: { version: 1, stats: { bonusAttackMin: { min: 10, max: 12 } } } });
    expect(rebalanced.rolls!.version).toBe(2);
    expect(rebalanced.rollHistory).toEqual([V1]);
    const after = resolveItem(oldId, items(rebalanced))!;
    expect(after.bonusAttackMin).toBe(before.bonusAttackMin);
    expect(after.attributes).toEqual(before.attributes);
    expect(rollNewItemId(rebalanced)).toMatch(/^sword~2~/);
  });

  it('keeps the version when ranges are unchanged and history when rolls are removed', () => {
    expect(carryRollHistory(sword, { ...sword, rolls: { version: 7, stats: { ...V1.stats } } }).rolls!.version).toBe(1);
    const removed = carryRollHistory(sword, { ...sword, rolls: undefined });
    expect(removed.rolls).toBeUndefined();
    expect(removed.rollHistory).toEqual([V1]);
    expect(resolveItem(makeRolledItemId('sword', 1, 5), items(removed))).toBeDefined();
  });

  it('bumps a colliding version authored independently (e.g. a draft)', () => {
    const live = carryRollHistory(sword, { ...sword, rolls: { version: 2, stats: { strength: { min: 1, max: 1 } } } });
    const draft = carryRollHistory(live, { ...sword, rolls: { version: 2, stats: { agility: { min: 1, max: 1 } } } });
    expect(draft.rolls!.version).toBe(3);
    expect(draft.rollHistory!.map(t => t.version)).toEqual([1, 2]);
  });

  it('validates table shape', () => {
    expect(validateRollTable(V1)).toBeNull();
    expect(validateRollTable({ version: 1, stats: { bogus: { min: 0, max: 1 } } } as unknown as ItemRollTable)).toMatch(/unknown stat/);
    expect(validateRollTable({ version: 1, stats: { strength: { min: 3, max: 1 } } })).toMatch(/greater/);
    expect(validateRollTable({ version: 1, stats: { strength: { min: 0.5, max: 1 } } })).toMatch(/whole/);
  });
});

describe('rolled items through game systems', () => {
  const all = withRolledItems(items(sword, plain));
  const a = makeRolledItemId('sword', 1, 1);
  const b = makeRolledItemId('sword', 1, 2);

  it('equips and contributes rolled stats to equipment bonuses', () => {
    const inventory: Record<string, number> = { [a]: 1 };
    const equipment: Record<string, string | null> = { mainhand: null };
    expect(equipItem(inventory, equipment, a, all).success).toBe(true);
    expect(equipment.mainhand).toBe(a);
    const bonuses = computeEquipmentBonuses(equipment, all);
    expect(bonuses.bonusAttackMin).toBe(all[a].bonusAttackMin);
    expect(bonuses.bonusAttackMax).toBe(all[a].bonusAttackMax);
  });

  it('shows its quality in the stat lines', () => {
    expect(describeItemStats(all[a]).some(l => l.kind === 'quality' && l.text === `Quality ${all[a].rollQuality}%`)).toBe(true);
    expect(describeItemStats(sword).some(l => l.kind === 'quality')).toBe(false);
  });

  it('inherits template sockets', () => {
    expect(socketCapacity({ mainhand: a }, 'mainhand', all)).toBe(2);
  });

  it('does not stack: each rolled copy takes its own backpack slot', () => {
    const inventory: Record<string, number> = {};
    addItemToInventory(inventory, a);
    addItemToInventory(inventory, b);
    expect(usedInventorySlots(inventory)).toBe(2);
    expect(canAddToInventory(inventory, 2, makeRolledItemId('sword', 1, 3), 1)).toBe(false);
    expect(canAddToInventory(inventory, 2, a, 1)).toBe(true);
  });

  it('counts toward sets by template id', () => {
    const set: SetDefinition = { id: 's', name: 'S', itemIds: ['sword', 'plain'], breakpoints: [{ piecesRequired: 2, bonuses: { flatHp: 10 } }] };
    const equipment = { mainhand: a, head: 'plain' };
    expect(getEquippedItemIds(equipment).has('sword')).toBe(true);
    expect(computeActiveSetBonuses(equipment, { s: set }).activeSetIds).toEqual(['s']);
    expect(getSetsForItem(a, { s: set })).toEqual([set]);
  });

  it('banks by exact id and ships the resolved definition to the client', () => {
    const bank = emptyBank();
    const inventory: Record<string, number> = { [a]: 1 };
    expect(bankDeposit(bank, inventory, a, 1).ok).toBe(true);
    expect(bankDeposit(bank, { [a]: 0 }, b, 1).ok).toBe(false);
    expect(toClientBankState(bank, all).itemDefinitions[a]?.templateId).toBe('sword');
  });
});
