import { describe, expect, it, vi } from 'vitest';
import { BACKPACK_BASE_SLOTS, LOST_AND_FOUND_SLOTS, STARTER_BAG_ITEM, offsetToCube } from '@idle-party-rpg/shared';
import type { CharacterState, ItemDefinition } from '@idle-party-rpg/shared';
import { gearKit } from './gearTestKit.js';
import type { GearKit } from './gearTestKit.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import type { PlayerSaveData } from '../src/game/GameStateStore.js';

const SATCHEL = STARTER_BAG_ITEM.id;

function baseItems(): Record<string, ItemDefinition> {
  const items: Record<string, ItemDefinition> = {
    [SATCHEL]: { ...STARTER_BAG_ITEM },
    pouch4: { id: 'pouch4', name: 'Small Pouch', rarity: 'common', bagSlots: 4 },
    helm: { id: 'helm', name: 'Helm', rarity: 'common', equipSlot: 'head' },
    helm2: { id: 'helm2', name: 'Helm II', rarity: 'common', equipSlot: 'head' },
    ore: { id: 'ore', name: 'Iron Ore', rarity: 'common' },
  };
  for (let i = 0; i < 60; i++) items[`junk${i}`] = { id: `junk${i}`, name: `Junk ${i}`, rarity: 'janky' };
  return items;
}

function character(session: PlayerSession): CharacterState {
  return session['character']!;
}

/** Fills the backpack with distinct junk until `free` slots remain. */
function fillBackpack(session: PlayerSession, free = 0): void {
  const inv = character(session).inventory;
  let i = 0;
  while (Object.keys(inv).length < session.getInventoryCapacity() - free) inv[`junk${i++}`] = 1;
}

function save(overrides: Partial<PlayerSaveData> = {}): PlayerSaveData {
  return {
    username: 'alice',
    battleCount: 0,
    combatLog: [],
    unlockedKeys: ['tile-start'],
    position: { col: 0, row: 0 },
    target: null,
    movementQueue: [],
    character: { className: 'Knight', level: 3, xp: 0, gold: 0, inventory: {} },
    ...overrides,
  };
}

describe('starter bag', () => {
  it('goes into the first bag slot for a new character', () => {
    const kit = gearKit(baseItems());
    const session = kit.newSession('alice');
    expect(session.getBags()).toEqual([SATCHEL, null, null, null]);
    expect(session.getInventoryCapacity()).toBe(BACKPACK_BASE_SLOTS + 12);
  });

  it('is granted once to an existing save and never again', () => {
    const kit = gearKit(baseItems());
    const restored = kit.restore(save());
    expect(restored.getBags()[0]).toBe(SATCHEL);
    expect(restored.toSaveData().starterBagGranted).toBe(true);

    const again = kit.roundTrip(restored);
    expect(again.getBags()).toEqual([SATCHEL, null, null, null]);
    expect(Object.keys(character(again).inventory)).not.toContain(SATCHEL);
  });

  it('lands in the backpack when every bag slot is full', () => {
    const kit = gearKit(baseItems());
    const data = save();
    data.character!.bags = ['pouch4', 'pouch4', 'pouch4', 'pouch4'];
    const restored = kit.restore(data);
    expect(character(restored).inventory[SATCHEL]).toBe(1);
  });

  it('is not granted to a save without a character until a class is chosen', () => {
    const kit = gearKit(baseItems());
    const data = save({ character: undefined });
    const restored = kit.restore(data);
    expect(restored.toSaveData().starterBagGranted).toBe(false);
    restored.setClass('Mage');
    expect(restored.getBags()[0]).toBe(SATCHEL);
  });
});

describe('persistence', () => {
  it('round-trips bags and Lost & Found', () => {
    const kit = gearKit(baseItems());
    const session = kit.newSession('alice');
    character(session).inventory.pouch4 = 1;
    expect(session.handleEquipBag('pouch4', 1)).toBeNull();
    session['lostAndFound'].ore = 7;
    const restored = kit.roundTrip(session);
    expect(restored.getBags()).toEqual([SATCHEL, 'pouch4', null, null]);
    expect(restored.getLostAndFound()).toEqual({ ore: 7 });
  });

  it('restores legacy saves with empty bag slots and an empty pouch', () => {
    const kit = gearKit(baseItems());
    const data = save({ starterBagGranted: true });
    const restored = kit.restore(data);
    expect(restored.getBags()).toEqual([null, null, null, null]);
    expect(restored.getLostAndFound()).toEqual({});
  });
});

describe('capacity', () => {
  it('refuses player-initiated adds of a new stack when full, but tops up existing stacks', () => {
    const kit = gearKit(baseItems());
    const session = kit.newSession('alice');
    fillBackpack(session);
    expect(session.addToInventory('ore', 1)).toBe(false);
    expect(session.addToInventory('junk0', 5)).toBe(true);
  });

  it('grandfathers an over-capacity backpack: keeps it, refuses growth', () => {
    const kit = gearKit(baseItems());
    const data = save({ starterBagGranted: true });
    data.character!.inventory = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`junk${i}`, 1]));
    const restored = kit.restore(data);
    expect(Object.keys(character(restored).inventory)).toHaveLength(30);
    expect(restored.addToInventory('ore', 1)).toBe(false);
    expect(restored.fitsInventory({ junk0: -1, ore: 1 })).toBe(true);
  });

  it('refuses an unequip that would add a stack to a full backpack', () => {
    const kit = gearKit(baseItems());
    const session = kit.newSession('alice');
    character(session).equipment.head = 'helm';
    fillBackpack(session);
    expect(session.handleUnequipItem('head')).toEqual({ success: false, inventoryFull: true });
    expect(character(session).equipment.head).toBe('helm');
  });

  it('allows an equip swap in a full backpack (one stack out, one in)', () => {
    const kit = gearKit(baseItems());
    const session = kit.newSession('alice');
    character(session).equipment.head = 'helm';
    fillBackpack(session, 1);
    character(session).inventory.helm2 = 1;
    expect(session.equipOverflowsInventory('helm2')).toBe(false);
    expect(session.handleEquipItem('helm2')).toBe(true);
    expect(character(session).inventory.helm).toBe(1);
  });

  it('refuses an equip when the swapped-out item needs a new slot', () => {
    const kit = gearKit(baseItems());
    const session = kit.newSession('alice');
    character(session).equipment.head = 'helm';
    fillBackpack(session, 1);
    character(session).inventory.helm2 = 2;
    expect(session.equipOverflowsInventory('helm2')).toBe(true);
    expect(session.handleEquipItem('helm2')).toBe(false);
  });

  it('reports capacity, bags and Lost & Found on the state push', () => {
    const kit = gearKit(baseItems());
    const session = kit.newSession('alice');
    session['lostAndFound'].ore = 2;
    const c = session.getState([]).character!;
    expect(c.inventoryCapacity).toBe(32);
    expect(c.bags).toEqual([SATCHEL, null, null, null]);
    expect(c.lostAndFound).toEqual({ ore: 2 });
    const defs = session.getState([]).itemDefinitions;
    expect(defs[SATCHEL]).toBeDefined();
    expect(defs.ore).toBeDefined();
  });
});

describe('unattended delivery and Lost & Found', () => {
  function fullSession(kit: GearKit): PlayerSession {
    const session = kit.newSession('alice');
    fillBackpack(session);
    return session;
  }

  it('routes victory loot to Lost & Found when the backpack is full', () => {
    const kit = gearKit(baseItems());
    const session = fullSession(kit);
    const tile = kit.grid.getTile(offsetToCube({ col: 0, row: 0 }))!;
    session.handleVictory({ xp: 0, gold: 0, items: ['ore', 'ore'] }, tile, { unlockTiles: false });
    expect(session.getLostAndFound()).toEqual({ ore: 2 });
    expect(session['combatLog'].some(e => e.text.includes('2×') || e.text.includes('Lost & Found'))).toBe(true);
    expect(session.consumeLostItems()).toEqual({});
  });

  it('loses items once Lost & Found is full and batches them for one notification', () => {
    const kit = gearKit(baseItems());
    const session = fullSession(kit);
    for (let i = 0; i < LOST_AND_FOUND_SLOTS; i++) session['lostAndFound'][`p${i}`] = 1;
    session.receiveItems('ore', 3);
    session.receiveItems('ore', 2);
    expect(session.consumeLostItems()).toEqual({ ore: 5 });
    expect(session.consumeLostItems()).toEqual({});
    expect(session['combatLog'].some(e => e.text.includes('lost 3× Iron Ore'))).toBe(true);
  });

  it('sends finished crafts through the same routing', () => {
    const kit = gearKit(baseItems());
    kit.recipes.smelt = { id: 'smelt', name: 'Smelt', durationSeconds: 1, ingredients: [], result: { itemId: 'ore', quantity: 4 } };
    const session = fullSession(kit);
    session['craftQueue'] = { activeStartedAtMs: 0, jobs: [{ recipeId: 'smelt' }] };
    expect(session.processCraftCompletions(5000)).toBe(true);
    expect(session.getLostAndFound()).toEqual({ ore: 4 });
  });

  it('counts pouch and lost copies in the welcome-back summary', () => {
    const kit = gearKit(baseItems());
    const session = fullSession(kit);
    session.captureAwaySnapshot(0);
    session.receiveItems('ore', 2);
    const msg = session.consumeWelcomeBack(60 * 60 * 1000)!;
    expect(msg.itemsToLostAndFound).toBe(2);
  });

  it('claims what fits and leaves the rest, and discards stacks', () => {
    const kit = gearKit(baseItems());
    const session = fullSession(kit);
    session['lostAndFound'].ore = 3;
    session['lostAndFound'].junk0 = 2;
    expect(session.handleClaimLostFound('ore')).toBe('inventory_full');
    expect(session.handleClaimLostFound(undefined)).toBeNull();
    expect(character(session).inventory.junk0).toBe(3);
    expect(session.getLostAndFound()).toEqual({ ore: 3 });
    expect(session.handleClaimLostFound('nope')).toBe('lost_found_item_missing');
    expect(session.handleDiscardLostFound('ore')).toBeNull();
    expect(session.getLostAndFound()).toEqual({});
  });
});

describe('bag slots', () => {
  it('equips and unequips bags, refusing a removal that would leave too few slots', () => {
    const kit = gearKit(baseItems());
    const session = kit.newSession('alice');
    character(session).inventory.pouch4 = 1;
    expect(session.handleEquipBag('pouch4', 1)).toBeNull();
    expect(session.getInventoryCapacity()).toBe(36);
    fillBackpack(session);
    expect(session.handleUnequipBag(1)).toBe('bag_no_room');
    expect(session.handleUnequipBag(3)).toBe('bag_slot_empty');
    expect(session.handleEquipBag('helm', 2)).toBe('bag_not_a_bag');
    expect(session.handleEquipBag('pouch4', 9)).toBe('bag_invalid_slot');
  });
});

describe('items_lost notification', () => {
  it('formats one notification listing every lost stack', async () => {
    const { PlayerManager } = await import('../src/game/PlayerManager.js');
    const kit = gearKit(baseItems());
    const notify = vi.fn();
    const fake = { content: kit.content, notify: { notify } } as unknown as InstanceType<typeof PlayerManager>;
    PlayerManager.prototype.notifyItemsLost.call(fake, 'alice', { ore: 3, junk1: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
    const [username, eventKey, vars] = notify.mock.calls[0];
    expect(username).toBe('alice');
    expect(eventKey).toBe('items_lost');
    expect(vars.body).toContain('3× Iron Ore');
    expect(vars.body).toContain('1× Junk 1');
  });
});
