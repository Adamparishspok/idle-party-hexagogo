import { describe, expect, it } from 'vitest';
import { STARTER_BAG_ITEM, parseRolledItemId, resolveItem, templateIdOf, withRolledItems } from '@idle-party-rpg/shared';
import type { ItemDefinition } from '@idle-party-rpg/shared';
import { gearKit } from './gearTestKit.js';
import { TradeSystem } from '../src/game/social/TradeSystem.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';

const sword: ItemDefinition = {
  id: 'sword', name: 'Sword', rarity: 'common', equipSlot: 'mainhand', bonusAttackMin: 1, bonusAttackMax: 2, value: 9,
  rolls: { version: 1, stats: { bonusAttackMin: { min: 5, max: 9 }, bonusAttackMax: { min: 10, max: 20 } } },
};

function rollKit() {
  const kit = gearKit({
    [STARTER_BAG_ITEM.id]: { ...STARTER_BAG_ITEM },
    sword,
    ore: { id: 'ore', name: 'Ore', rarity: 'common' },
  });
  const content = kit.content as unknown as { getItem: (id: string) => ItemDefinition | undefined; getAllItems: () => Record<string, ItemDefinition> };
  content.getItem = id => resolveItem(id, kit.items);
  content.getAllItems = () => withRolledItems(kit.items);
  return kit;
}

function inventory(session: PlayerSession): Record<string, number> {
  return session['character']!.inventory;
}

describe('rolled items in a player session', () => {
  it('rolls each delivered copy of a rollable template, and leaves plain items stacked', () => {
    const session = rollKit().newSession('alice');
    expect(session.receiveItems('sword', 3).toInventory).toBe(3);
    session.receiveItems('ore', 3);
    const ids = Object.keys(inventory(session));
    const swords = ids.filter(id => templateIdOf(id) === 'sword');
    expect(swords.length).toBeGreaterThanOrEqual(2);
    for (const id of swords) expect(parseRolledItemId(id)).not.toBeNull();
    expect(inventory(session).ore).toBe(3);
    expect(inventory(session).sword).toBeUndefined();
  });

  it('equips a rolled copy and its rolled stats reach combat stats', () => {
    const kit = rollKit();
    const session = kit.newSession('alice');
    session.receiveItems('sword', 1);
    const id = Object.keys(inventory(session)).find(k => templateIdOf(k) === 'sword')!;
    const before = session.getDerivedStats()!.attackBonusMin;
    expect(session.handleEquipItem(id)).toBe(true);
    expect(session['character']!.equipment.mainhand).toBe(id);
    expect(session.getDerivedStats()!.attackBonusMin - before).toBe(kit.content.getItem(id)!.bonusAttackMin);
    expect(session.hasItemEquipped('sword')).toBe(true);
  });

  it('survives a save round-trip with the same id and stats', () => {
    const kit = rollKit();
    const session = kit.newSession('alice');
    session.receiveItems('sword', 1);
    const id = Object.keys(inventory(session)).find(k => templateIdOf(k) === 'sword')!;
    const restored = kit.roundTrip(session);
    expect(inventory(restored)[id]).toBe(1);
    expect(kit.content.getItem(id)!.bonusAttackMin).toBe(rollKit().content.getItem(id)!.bonusAttackMin);
  });

  it('sells for the template value and is tradeable by its exact id', () => {
    const kit = rollKit();
    const session = kit.newSession('alice');
    session.receiveItems('sword', 1);
    const id = Object.keys(inventory(session)).find(k => templateIdOf(k) === 'sword')!;
    expect(kit.content.getItem(id)!.value).toBe(9);

    const trades = new TradeSystem();
    const has = (_u: string, itemId: string, qty: number) => session.getInventoryCount(itemId) >= qty;
    expect(typeof trades.proposeTrade('alice', 'bob', [{ itemId: id, quantity: 1 }], has, () => false)).toBe('object');
    expect(trades.proposeTrade('alice', 'carol', [{ itemId: 'sword', quantity: 1 }], has, () => false)).toBe('Item not found in your inventory');
  });

  it('gives template definitions to the client for rolled ids it owns', () => {
    const session = rollKit().newSession('alice');
    session.receiveItems('sword', 1);
    const id = Object.keys(inventory(session)).find(k => templateIdOf(k) === 'sword')!;
    const defs = session['getOwnedItemDefinitions']({});
    expect(defs[id]?.templateId).toBe('sword');
  });
});
