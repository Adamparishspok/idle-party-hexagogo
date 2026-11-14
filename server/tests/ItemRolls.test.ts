import { describe, expect, it } from 'vitest';
import { STARTER_BAG_ITEM, makeRolledItemId, rollItemStats, parseRolledItemId, resolveItem, templateIdOf, withRolledItems } from '@idle-party-rpg/shared';
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

describe('rolled copies satisfy template requirements', () => {
  const ruby: ItemDefinition = {
    id: 'ruby', name: 'Ruby', rarity: 'common', jewel: true, attributes: { strength: 1 },
    rolls: { version: 1, stats: { strength: { min: 1, max: 9 } } },
  };
  const helm: ItemDefinition = { id: 'helm', name: 'Helm', rarity: 'common', equipSlot: 'head', sockets: 2 };

  function kitWith() {
    const kit = rollKit();
    kit.items.ruby = ruby;
    kit.items.helm = helm;
    return kit;
  }

  const qualityOf = (kit: ReturnType<typeof rollKit>, id: string) => kit.content.getItem(id)!.rollQuality!;

  it('consumes the plain id first, then the lowest quality copy, never equipped ones', () => {
    const kit = kitWith();
    const session = kit.newSession('alice');
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map(n => makeRolledItemId('sword', 1, n));
    const sorted = [...seeds].sort((a, b) => qualityOf(kit, a) - qualityOf(kit, b));
    const [low, , , , , , , high] = sorted;
    inventory(session).sword = 1;
    inventory(session)[high] = 1;
    inventory(session)[low] = 1;
    expect(session.getInventoryTemplateCount('sword')).toBe(3);
    expect(session.consumeByTemplate('sword', 2)).toBe(true);
    expect(Object.keys(inventory(session))).toEqual([high]);
    session['character']!.equipment.mainhand = low;
    expect(session.getInventoryTemplateCount('sword')).toBe(1);
    expect(session.consumeByTemplate('sword', 2)).toBe(false);
    expect(inventory(session)[high]).toBe(1);
    expect(session['character']!.equipment.mainhand).toBe(low);
  });

  it('counts socketed rolled jewels for quest checks, and hand-in keeps them', () => {
    const kit = kitWith();
    const session = kit.newSession('alice');
    const rolled = makeRolledItemId('ruby', 1, 42);
    inventory(session).helm = 1;
    inventory(session)[rolled] = 1;
    expect(session.handleEquipItem('helm')).toBe(true);
    expect(session.handleSocketJewel('head', rolled)).toBeNull();
    expect(session.getInventoryTemplateCount('ruby')).toBe(0);
    expect(session.getQuestItemCount('ruby')).toBe(1);
    inventory(session).ruby = 1;
    expect(session.getQuestItemCount('ruby')).toBe(2);
    expect(session.consumeQuestItems('ruby', 2)).toBe(true);
    expect(inventory(session).ruby).toBeUndefined();
    expect(session.getSocketedJewels()).toEqual({ head: [rolled] });
    expect(session.consumeQuestItems('ruby', 1)).toBe(true);
    expect(session.consumeQuestItems('ruby', 2)).toBe(false);
  });

  it('crafting spends rolled ingredients', () => {
    const kit = kitWith();
    kit.recipes.r = { id: 'r', name: 'R', ingredients: [{ itemId: 'sword', quantity: 2 }], result: { itemId: 'ore', quantity: 1 }, durationSeconds: 10 } as never;
    const session = kit.newSession('alice');
    const a = makeRolledItemId('sword', 1, 7);
    inventory(session)[a] = 1;
    inventory(session).sword = 1;
    expect(session.handleCraftQueue('r')).toEqual({ ok: true });
    expect(Object.keys(inventory(session)).filter(id => templateIdOf(id) === 'sword')).toEqual([]);
  });

  it('loot, quest-style and welcome-back text use the rolled name', () => {
    const kit = kitWith();
    const session = kit.newSession('alice');
    const tile = session.getCurrentTile()!;
    session.handleVictory({ xp: 0, gold: 0, items: ['sword'] }, tile, { unlockTiles: false });
    const id = Object.keys(inventory(session)).find(k => templateIdOf(k) === 'sword')!;
    const name = kit.content.getItem(id)!.name;
    expect(session['combatLog'].some(e => e.text === `Found ${name}!`)).toBe(true);
    expect(rollItemStats('sword', kit.items.sword.rolls!, parseRolledItemId(id)!.seed).quality).toBe(kit.content.getItem(id)!.rollQuality);
  });

  it('welcome-back lists rolled loot under its rolled definition', () => {
    const kit = kitWith();
    const session = kit.newSession('alice');
    session.captureAwaySnapshot(0);
    session.receiveItems('sword', 1);
    const id = Object.keys(inventory(session)).find(k => templateIdOf(k) === 'sword')!;
    const msg = session.consumeWelcomeBack(10 * 60 * 1000, 0)!;
    expect(msg.items).toEqual([{ itemId: id, count: 1 }]);
    expect(msg.itemDefinitions[id].name).toBe(kit.content.getItem(id)!.name);
  });
});
