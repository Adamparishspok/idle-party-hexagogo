import { describe, expect, it, vi } from 'vitest';
import { BANK_SLOTS_PER_TAB, BANK_TAB_PRICES, MAX_BANK_TABS, STARTER_BAG_ITEM, DEFAULT_MAP_ID, TileType } from '@idle-party-rpg/shared';
import type { CharacterState, ClientBankMessage, ItemDefinition } from '@idle-party-rpg/shared';
import { gearKit } from './gearTestKit.js';
import type { GearKit } from './gearTestKit.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import { BankService } from '../src/game/bank/BankService.js';

function items(): Record<string, ItemDefinition> {
  const out: Record<string, ItemDefinition> = {
    [STARTER_BAG_ITEM.id]: { ...STARTER_BAG_ITEM },
    ore: { id: 'ore', name: 'Iron Ore', rarity: 'common' },
    ruby: { id: 'ruby', name: 'Ruby', rarity: 'rare' },
  };
  for (let i = 0; i < 60; i++) out[`junk${i}`] = { id: `junk${i}`, name: `Junk ${i}`, rarity: 'janky' };
  return out;
}

function character(session: PlayerSession): CharacterState {
  return session['character']!;
}

function setup(banker = true) {
  const kit: GearKit = gearKit(items());
  kit.shops.bank = { id: 'bank', name: 'Bank', inventory: [], banker };
  kit.tiles.push({ id: 'tile-start', mapId: DEFAULT_MAP_ID, col: 0, row: 0, type: TileType.Town, zone: 'hatchetmill', name: 'Square', shopId: 'bank' });
  const session = kit.newSession('alice');
  const pushState = vi.fn();
  const service = new BankService({ getSession: u => (u === 'alice' ? session : undefined), pushState });
  const send = (msg: ClientBankMessage) => service.handle('alice', msg);
  return { kit, session, service, pushState, send };
}

describe('bank access', () => {
  it('ships the bank on the state push only in a banker room', () => {
    expect(setup(true).session.getState([]).bank?.tabs).toEqual([{}]);
    expect(setup(false).session.getState([]).bank).toBeUndefined();
  });

  it('refuses every request away from a banker, and inside a dungeon', () => {
    const away = setup(false);
    character(away.session).inventory.ore = 1;
    expect(away.send({ type: 'bank_deposit', itemId: 'ore', quantity: 1 })?.code).toBe('bank_not_here');

    const delving = setup(true);
    delving.session.getDungeonState = () => ({ dungeonId: 'd' } as never);
    expect(delving.session.getState([]).bank).toBeUndefined();
    expect(delving.send({ type: 'bank_buy_tab' })?.code).toBe('bank_not_here');
  });
});

describe('bank transfers', () => {
  it('deposits and withdraws, pushing state on success', () => {
    const { session, send, pushState } = setup();
    character(session).inventory.ore = 10;
    expect(send({ type: 'bank_deposit', itemId: 'ore', quantity: 4 })).toBeNull();
    expect(session.getBank().tabs[0]).toEqual({ ore: 4 });
    expect(character(session).inventory.ore).toBe(6);
    expect(send({ type: 'bank_withdraw', tab: 0, itemId: 'ore', quantity: 4 })).toBeNull();
    expect(session.getBank().tabs[0]).toEqual({});
    expect(character(session).inventory.ore).toBe(10);
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(session.getState([]).bank?.itemDefinitions).toEqual({});
  });

  it('refuses a withdrawal that would not fit the backpack', () => {
    const { session, send } = setup();
    session.getBank().tabs[0].ruby = 1;
    const inv = character(session).inventory;
    for (let i = 0; Object.keys(inv).length < session.getInventoryCapacity(); i++) inv[`junk${i}`] = 1;
    expect(send({ type: 'bank_withdraw', tab: 0, itemId: 'ruby', quantity: 1 })?.code).toBe('bank_bag_full');
  });

  it('refuses missing items, bad tabs and full tabs', () => {
    const { session, send } = setup();
    expect(send({ type: 'bank_deposit', itemId: 'ore', quantity: 1 })?.code).toBe('bank_item_missing');
    character(session).inventory.ore = 1;
    expect(send({ type: 'bank_deposit', itemId: 'ore', quantity: 1, tab: 3 })?.code).toBe('bank_invalid_request');
    expect(send({ type: 'bank_deposit', itemId: 'ore', quantity: 0 })?.code).toBe('bank_invalid_request');
    for (let i = 0; i < BANK_SLOTS_PER_TAB; i++) session.getBank().tabs[0][`junk${i}`] = 1;
    expect(send({ type: 'bank_deposit', itemId: 'ore', quantity: 1 })?.code).toBe('bank_tab_full');
  });

  it('moves between tabs once a second tab is bought', () => {
    const { session, send } = setup();
    character(session).gold = BANK_TAB_PRICES[0];
    session.getBank().tabs[0].ore = 5;
    expect(send({ type: 'bank_move', fromTab: 0, toTab: 1, itemId: 'ore', quantity: 2 })?.code).toBe('bank_invalid_request');
    expect(send({ type: 'bank_buy_tab' })).toBeNull();
    expect(character(session).gold).toBe(0);
    expect(send({ type: 'bank_move', fromTab: 0, toTab: 1, itemId: 'ore', quantity: 2 })).toBeNull();
    expect(session.getBank().tabs).toEqual([{ ore: 3 }, { ore: 2 }]);
    expect(session.getState([]).bank?.nextTabPrice).toBe(BANK_TAB_PRICES[1]);
  });

  it('charges the contract prices and stops at the last tab', () => {
    const { session, send } = setup();
    expect(send({ type: 'bank_buy_tab' })?.code).toBe('bank_cannot_afford');
    character(session).gold = BANK_TAB_PRICES.reduce((a, b) => a + b, 0);
    for (let i = 1; i < MAX_BANK_TABS; i++) expect(send({ type: 'bank_buy_tab' })).toBeNull();
    expect(character(session).gold).toBe(0);
    expect(session.getBank().tabs).toHaveLength(MAX_BANK_TABS);
    expect(send({ type: 'bank_buy_tab' })?.code).toBe('bank_max_tabs');
    expect(session.getState([]).bank?.nextTabPrice).toBeNull();
  });
});

describe('bank persistence', () => {
  it('round-trips tabs and restores legacy saves with one empty tab', () => {
    const { kit, session } = setup();
    session.getBank().tabs.push({ ruby: 2 });
    session.getBank().tabs[0].ore = 9;
    const restored = kit.roundTrip(session);
    expect(restored.getBank().tabs).toEqual([{ ore: 9 }, { ruby: 2 }]);

    const data = session.toSaveData();
    delete data.bank;
    expect(kit.restore(data).getBank().tabs).toEqual([{}]);
  });
});
