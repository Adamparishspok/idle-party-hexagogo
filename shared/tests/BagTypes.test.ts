import { describe, expect, it } from 'vitest';
import {
  BACKPACK_BASE_SLOTS,
  LOST_AND_FOUND_SLOTS,
  STARTER_BAG_ITEM,
  canAddToInventory,
  grantStarterBag,
  claimFromPouch,
  equipBag,
  fitsInventoryChanges,
  inventoryCapacity,
  isBag,
  maxAddable,
  normalizeBagSlots,
  routeIncomingItems,
  unequipBag,
  usedInventorySlots,
  validateBagItem,
} from '../src/systems/BagTypes';
import type { ItemDefinition } from '../src/systems/ItemTypes';
import { MAX_STACK } from '../src/systems/ItemTypes';

const ITEMS: Record<string, ItemDefinition> = {
  pouch: { id: 'pouch', name: 'Pouch', rarity: 'common', bagSlots: 4 },
  sack: { id: 'sack', name: 'Sack', rarity: 'uncommon', bagSlots: 8 },
  helm: { id: 'helm', name: 'Helm', rarity: 'common', equipSlot: 'head' },
};

function fill(count: number): Record<string, number> {
  const inv: Record<string, number> = {};
  for (let i = 0; i < count; i++) inv[`junk_${i}`] = 1;
  return inv;
}

describe('capacity', () => {
  it('is the base backpack plus equipped bags', () => {
    expect(inventoryCapacity(normalizeBagSlots(undefined), ITEMS)).toBe(BACKPACK_BASE_SLOTS);
    expect(inventoryCapacity(['pouch', 'sack', null, 'helm'], ITEMS)).toBe(BACKPACK_BASE_SLOTS + 12);
    expect(normalizeBagSlots(['sack'])).toEqual(['sack', null, null, null]);
  });

  it('counts distinct stacks, not copies', () => {
    expect(usedInventorySlots({ a: 99, b: 1, c: 0 })).toBe(2);
  });

  it('lets existing stacks grow to MAX_STACK when full, but not new ones', () => {
    const inv = fill(BACKPACK_BASE_SLOTS);
    expect(canAddToInventory(inv, BACKPACK_BASE_SLOTS, 'junk_0', 5)).toBe(true);
    expect(canAddToInventory(inv, BACKPACK_BASE_SLOTS, 'new', 1)).toBe(false);
    expect(canAddToInventory(inv, BACKPACK_BASE_SLOTS, 'junk_0', MAX_STACK)).toBe(false);
    expect(maxAddable(inv, BACKPACK_BASE_SLOTS, 'junk_0')).toBe(MAX_STACK - 1);
    expect(maxAddable(inv, BACKPACK_BASE_SLOTS, 'new')).toBe(0);
  });

  it('grandfathers an over-capacity backpack without letting it grow', () => {
    const inv = fill(BACKPACK_BASE_SLOTS + 5);
    expect(fitsInventoryChanges(inv, BACKPACK_BASE_SLOTS, { new: 1 })).toBe(false);
    expect(fitsInventoryChanges(inv, BACKPACK_BASE_SLOTS, { new: 1, junk_0: -1 })).toBe(true);
    expect(fitsInventoryChanges(inv, BACKPACK_BASE_SLOTS, { junk_0: -1 })).toBe(true);
  });
});

describe('bags', () => {
  it('only treats slotless items with bagSlots as bags', () => {
    expect(isBag(ITEMS.sack)).toBe(true);
    expect(isBag(ITEMS.helm)).toBe(false);
    expect(isBag({ ...ITEMS.helm, bagSlots: 4 })).toBe(false);
    expect(validateBagItem({ bagSlots: 0 })).toMatch(/bagSlots/);
    expect(validateBagItem({ bagSlots: 4, equipSlot: 'head' })).toMatch(/equipSlot/);
    expect(validateBagItem({ bagSlots: 4 })).toBeNull();
  });

  it('equips a bag out of the backpack and swaps the old one back', () => {
    const inv: Record<string, number> = { pouch: 1, sack: 1 };
    const bags = normalizeBagSlots(undefined);
    expect(equipBag(inv, bags, 0, 'pouch', ITEMS)).toEqual({ ok: true });
    expect(inv).toEqual({ sack: 1 });
    expect(equipBag(inv, bags, 0, 'sack', ITEMS)).toEqual({ ok: true, returnedItemId: 'pouch' });
    expect(inv).toEqual({ pouch: 1 });
    expect(bags[0]).toBe('sack');
  });

  it('refuses invalid bag requests', () => {
    const inv: Record<string, number> = { helm: 1 };
    const bags = normalizeBagSlots(undefined);
    expect(equipBag(inv, bags, 9, 'helm', ITEMS)).toEqual({ ok: false, error: 'bag_invalid_slot' });
    expect(equipBag(inv, bags, 0, 'helm', ITEMS)).toEqual({ ok: false, error: 'bag_not_a_bag' });
    expect(equipBag(inv, bags, 0, 'sack', ITEMS)).toEqual({ ok: false, error: 'bag_item_missing' });
    expect(unequipBag(inv, bags, 0, ITEMS)).toEqual({ ok: false, error: 'bag_slot_empty' });
  });

  it('will not remove a bag whose slots are in use', () => {
    const bags = ['sack', null, null, null];
    const inv = fill(BACKPACK_BASE_SLOTS + 3);
    expect(unequipBag(inv, bags, 0, ITEMS)).toEqual({ ok: false, error: 'bag_no_room' });
    const roomy = fill(BACKPACK_BASE_SLOTS - 1);
    expect(unequipBag(roomy, bags, 0, ITEMS)).toEqual({ ok: true, returnedItemId: 'sack' });
    expect(roomy.sack).toBe(1);
    expect(bags[0]).toBeNull();
  });

  it('will not swap to a smaller bag that cannot hold everything', () => {
    const bags = ['sack', null, null, null];
    const inv = { ...fill(BACKPACK_BASE_SLOTS + 7), pouch: 1 };
    expect(equipBag(inv, bags, 0, 'pouch', ITEMS)).toEqual({ ok: false, error: 'bag_no_room' });
  });
});

describe('starter bag', () => {
  it('goes into the first empty bag slot', () => {
    const bags = ['sack', null, null, null];
    const inv: Record<string, number> = {};
    expect(grantStarterBag(bags, inv)).toBe('bag_slot');
    expect(bags[1]).toBe(STARTER_BAG_ITEM.id);
    expect(inventoryCapacity(bags, { ...ITEMS, [STARTER_BAG_ITEM.id]: STARTER_BAG_ITEM })).toBe(BACKPACK_BASE_SLOTS + 8 + 12);
  });

  it('lands in the backpack when every bag slot is taken, even past capacity', () => {
    const bags = ['sack', 'sack', 'sack', 'sack'];
    const inv = fill(BACKPACK_BASE_SLOTS);
    expect(grantStarterBag(bags, inv)).toBe('backpack');
    expect(inv[STARTER_BAG_ITEM.id]).toBe(1);
  });

  it('is a valid bag', () => {
    expect(isBag(STARTER_BAG_ITEM)).toBe(true);
    expect(validateBagItem(STARTER_BAG_ITEM)).toBeNull();
  });
});

describe('Lost & Found', () => {
  it('fills the backpack, then the pouch, then loses the rest', () => {
    const inv = fill(BACKPACK_BASE_SLOTS);
    const pouch = fill(LOST_AND_FOUND_SLOTS - 1);
    expect(routeIncomingItems(inv, BACKPACK_BASE_SLOTS, pouch, 'junk_0', 3)).toEqual({ toInventory: 3, toPouch: 0, lost: 0 });
    expect(routeIncomingItems(inv, BACKPACK_BASE_SLOTS, pouch, 'gem', 2)).toEqual({ toInventory: 0, toPouch: 2, lost: 0 });
    expect(routeIncomingItems(inv, BACKPACK_BASE_SLOTS, pouch, 'ore', 1)).toEqual({ toInventory: 0, toPouch: 0, lost: 1 });
    expect(pouch.gem).toBe(2);
  });

  it('splits a delivery that overflows a stack', () => {
    const inv: Record<string, number> = { ore: MAX_STACK - 2 };
    const pouch: Record<string, number> = {};
    expect(routeIncomingItems(inv, 5, pouch, 'ore', 5)).toEqual({ toInventory: 2, toPouch: 3, lost: 0 });
  });

  it('claims what fits and leaves the rest', () => {
    const inv = fill(BACKPACK_BASE_SLOTS - 1);
    const pouch: Record<string, number> = { gem: 2, ore: 4, junk_0: 3 };
    expect(claimFromPouch(inv, BACKPACK_BASE_SLOTS, pouch)).toBe(5);
    expect(pouch).toEqual({ ore: 4 });
    expect(inv.gem).toBe(2);
    expect(inv.junk_0).toBe(4);
    expect(claimFromPouch(inv, BACKPACK_BASE_SLOTS, pouch, 'ore')).toBe(0);
  });
});
