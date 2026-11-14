import { describe, expect, it } from 'vitest';
import { STARTER_BAG_ITEM } from '@idle-party-rpg/shared';
import type { CharacterState, ItemDefinition } from '@idle-party-rpg/shared';
import { gearKit } from './gearTestKit.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';

function items(): Record<string, ItemDefinition> {
  const out: Record<string, ItemDefinition> = {
    [STARTER_BAG_ITEM.id]: { ...STARTER_BAG_ITEM },
    helm: { id: 'helm', name: 'Helm', rarity: 'common', equipSlot: 'head', sockets: 2 },
    helm1: { id: 'helm1', name: 'Helm 1', rarity: 'common', equipSlot: 'head', sockets: 1 },
    helm0: { id: 'helm0', name: 'Plain Helm', rarity: 'common', equipSlot: 'head' },
    ruby: { id: 'ruby', name: 'Ruby', rarity: 'common', jewel: true, attributes: { strength: 4 } },
    topaz: { id: 'topaz', name: 'Topaz', rarity: 'common', jewel: true, attributes: { stamina: 5 } },
  };
  for (let i = 0; i < 60; i++) out[`junk${i}`] = { id: `junk${i}`, name: `Junk ${i}`, rarity: 'janky' };
  return out;
}

const ch = (s: PlayerSession): CharacterState => s['character']!;

function knightWithHelm(): { kit: ReturnType<typeof gearKit>; session: PlayerSession } {
  const kit = gearKit(items());
  const session = kit.newSession('alice');
  ch(session).inventory.helm = 1;
  ch(session).inventory.ruby = 2;
  ch(session).inventory.topaz = 1;
  expect(session.handleEquipItem('helm')).toBe(true);
  return { kit, session };
}

describe('sockets', () => {
  it('moves a jewel from the backpack into the worn item and back', () => {
    const { session } = knightWithHelm();
    expect(session.handleSocketJewel('head', 'ruby')).toBeNull();
    expect(ch(session).inventory.ruby).toBe(1);
    expect(session.getSocketedJewels()).toEqual({ head: ['ruby'] });
    expect(session.handleUnsocketJewel('head', 0)).toBeNull();
    expect(ch(session).inventory.ruby).toBe(2);
    expect(session.getSocketedJewels()).toEqual({});
  });

  it('rejects bad requests', () => {
    const { session } = knightWithHelm();
    expect(session.handleSocketJewel('chest', 'ruby')).toBe('socket_invalid_slot');
    expect(session.handleSocketJewel('head', 'helm')).toBe('socket_not_a_jewel');
    expect(session.handleSocketJewel('head', 'nope')).toBe('socket_not_a_jewel');
    expect(session.handleSocketJewel('head', 42)).toBe('socket_not_a_jewel');
    expect(session.handleUnsocketJewel('head', 0)).toBe('socket_invalid_index');
    session.handleSocketJewel('head', 'ruby');
    session.handleSocketJewel('head', 'ruby');
    expect(session.handleSocketJewel('head', 'topaz')).toBe('socket_no_free_socket');
    expect(session.handleSocketJewel('head', 'ruby')).toBe('socket_jewel_missing');
  });

  it('refuses to unsocket into a full backpack', () => {
    const { session } = knightWithHelm();
    session.handleSocketJewel('head', 'topaz');
    const inv = ch(session).inventory;
    let i = 0;
    while (Object.keys(inv).length < session.getInventoryCapacity()) inv[`junk${i++}`] = 1;
    expect(session.handleUnsocketJewel('head', 0)).toBe('socket_inventory_full');
    expect(session.getSocketedJewels()).toEqual({ head: ['topaz'] });
  });

  it('adds jewel attributes to the real derived stats, only while socketed', () => {
    const { session } = knightWithHelm();
    const before = session.getDerivedStats()!;
    session.handleSocketJewel('head', 'topaz');
    session.handleSocketJewel('head', 'ruby');
    const after = session.getDerivedStats()!;
    expect(after.gearAttributes.stamina).toBe(5);
    expect(after.gearAttributes.strength).toBe(4);
    expect(after.maxHp).toBe(before.maxHp + 10);
    expect(after.damage).toBe(before.damage + 2);
    expect(session.getCombatInfo().maxHp).toBe(after.maxHp);
    expect(session.getState([]).character!.socketedJewels).toEqual({ head: ['topaz', 'ruby'] });
  });

  it('returns jewels when the item is unequipped', () => {
    const { session } = knightWithHelm();
    session.handleSocketJewel('head', 'ruby');
    expect(session.handleUnequipItem('head').success).toBe(true);
    expect(ch(session).inventory.ruby).toBe(2);
    expect(session.getSocketedJewels()).toEqual({});
    expect(session.getDerivedStats()!.gearAttributes.strength).toBe(0);
  });

  it('returns jewels when the item is swapped, even for another socketed item', () => {
    const { session } = knightWithHelm();
    ch(session).inventory.helm1 = 1;
    session.handleSocketJewel('head', 'ruby');
    expect(session.handleEquipItem('helm1')).toBe(true);
    expect(ch(session).inventory.ruby).toBe(2);
    expect(session.getSocketedJewels()).toEqual({});
  });

  it('sends returned jewels to Lost & Found when the backpack is full, never destroying them', () => {
    const { session } = knightWithHelm();
    session.handleSocketJewel('head', 'topaz');
    const inv = ch(session).inventory;
    delete inv.ruby;
    inv.helm0 = 1;
    let i = 0;
    while (Object.keys(inv).length < session.getInventoryCapacity()) inv[`junk${i++}`] = 1;
    expect(session.handleEquipItem('helm0')).toBe(true);
    expect(inv.topaz).toBeUndefined();
    expect(session.getLostAndFound().topaz).toBe(1);
    expect(session.getSocketedJewels()).toEqual({});
  });

  it('pops extras when a saved item has fewer sockets than jewels', () => {
    const { kit, session } = knightWithHelm();
    session.handleSocketJewel('head', 'ruby');
    session.handleSocketJewel('head', 'topaz');
    const saved = session.toSaveData();
    kit.items.helm = { ...kit.items.helm, sockets: 1 };
    const restored = kit.restore(saved);
    expect(restored.getSocketedJewels()).toEqual({ head: ['ruby'] });
    const owned = (ch(restored).inventory.topaz ?? 0) + (restored.getLostAndFound().topaz ?? 0);
    expect(owned).toBe(1);
  });

  it('round-trips through the save', () => {
    const { kit, session } = knightWithHelm();
    session.handleSocketJewel('head', 'ruby');
    const saved = session.toSaveData();
    expect(saved.character!.socketedJewels).toEqual({ head: ['ruby'] });
    const restored = kit.roundTrip(session);
    expect(restored.getSocketedJewels()).toEqual({ head: ['ruby'] });
    expect(restored.getDerivedStats()!.gearAttributes.strength).toBe(4);
  });
});
