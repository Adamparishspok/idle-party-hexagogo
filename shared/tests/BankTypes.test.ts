import { describe, expect, it } from 'vitest';
import {
  BANK_BASE_TABS,
  BANK_SLOTS_PER_TAB,
  BANK_TAB_PRICES,
  MAX_BANK_TABS,
  addBankTab,
  bankDeposit,
  bankMove,
  bankWithdraw,
  chooseDepositTab,
  emptyBank,
  nextBankTabPrice,
  normalizeBank,
  toClientBankState,
} from '../src/systems/BankTypes';
import type { PlayerBank } from '../src/systems/BankTypes';
import { MAX_STACK } from '../src/systems/ItemTypes';
import type { ItemDefinition } from '../src/systems/ItemTypes';

function fullTab(): Record<string, number> {
  const tab: Record<string, number> = {};
  for (let i = 0; i < BANK_SLOTS_PER_TAB; i++) tab[`x${i}`] = 1;
  return tab;
}

describe('bank tabs', () => {
  it('starts with the base tabs and prices extra ones on an escalating schedule', () => {
    const bank = emptyBank();
    expect(bank.tabs).toHaveLength(BANK_BASE_TABS);
    for (const price of BANK_TAB_PRICES) {
      expect(nextBankTabPrice(bank)).toBe(price);
      expect(addBankTab(bank)).toBe(true);
    }
    expect(bank.tabs).toHaveLength(MAX_BANK_TABS);
    expect(nextBankTabPrice(bank)).toBeNull();
    expect(addBankTab(bank)).toBe(false);
  });

  it('restores a saved bank within bounds', () => {
    expect(normalizeBank(undefined).tabs).toHaveLength(BANK_BASE_TABS);
    const tooMany: PlayerBank = { tabs: Array.from({ length: MAX_BANK_TABS + 2 }, () => ({ a: 1 })) };
    expect(normalizeBank(tooMany).tabs).toHaveLength(MAX_BANK_TABS);
  });
});

describe('deposit and withdraw', () => {
  it('moves items between backpack and bank', () => {
    const bank = emptyBank();
    const inv: Record<string, number> = { ore: 10 };
    expect(bankDeposit(bank, inv, 'ore', 4)).toEqual({ ok: true, tab: 0, quantity: 4 });
    expect(inv.ore).toBe(6);
    expect(bankDeposit(bank, inv, 'ore', 6)).toEqual({ ok: true, tab: 0, quantity: 6 });
    expect(inv).toEqual({});
    expect(bankWithdraw(bank, inv, 20, 0, 'ore', 3)).toEqual({ ok: true, tab: 0, quantity: 3 });
    expect(bank.tabs[0].ore).toBe(7);
    expect(inv.ore).toBe(3);
  });

  it('refuses bad requests', () => {
    const bank = emptyBank();
    const inv: Record<string, number> = { ore: 1 };
    expect(bankDeposit(bank, inv, 'ore', 2)).toEqual({ ok: false, error: 'bank_item_missing' });
    expect(bankDeposit(bank, inv, 'ore', 0)).toEqual({ ok: false, error: 'bank_invalid_request' });
    expect(bankDeposit(bank, inv, 'ore', 1, 3)).toEqual({ ok: false, error: 'bank_invalid_request' });
    expect(bankWithdraw(bank, inv, 20, 0, 'gem', 1)).toEqual({ ok: false, error: 'bank_item_missing' });
  });

  it('refuses a deposit into a full tab or past a full stack', () => {
    const bank: PlayerBank = { tabs: [fullTab()] };
    expect(bankDeposit(bank, { ore: 1 }, 'ore', 1)).toEqual({ ok: false, error: 'bank_tab_full' });
    expect(bankDeposit(bank, { x0: MAX_STACK }, 'x0', MAX_STACK)).toEqual({ ok: false, error: 'bank_tab_full' });
  });

  it('picks a tab already holding the item, else the first with room', () => {
    const bank: PlayerBank = { tabs: [fullTab(), {}, { ore: 5 }] };
    expect(chooseDepositTab(bank, 'ore', 1)).toBe(2);
    expect(chooseDepositTab(bank, 'gem', 1)).toBe(1);
  });

  it('refuses a withdrawal the backpack cannot hold', () => {
    const bank: PlayerBank = { tabs: [{ gem: 1 }] };
    expect(bankWithdraw(bank, { a: 1, b: 1 }, 2, 0, 'gem', 1)).toEqual({ ok: false, error: 'bank_bag_full' });
  });

  it('moves stacks between tabs', () => {
    const bank: PlayerBank = { tabs: [{ ore: 5 }, {}] };
    expect(bankMove(bank, 0, 1, 'ore', 5)).toEqual({ ok: true, tab: 1, quantity: 5 });
    expect(bank.tabs).toEqual([{}, { ore: 5 }]);
    expect(bankMove(bank, 1, 1, 'ore', 1)).toEqual({ ok: false, error: 'bank_invalid_request' });
  });
});

describe('toClientBankState', () => {
  it('ships the tabs, limits and the definitions of stored items', () => {
    const items: Record<string, ItemDefinition> = { ore: { id: 'ore', name: 'Ore', rarity: 'common' } };
    const state = toClientBankState({ tabs: [{ ore: 2 }] }, items);
    expect(state).toMatchObject({ tabs: [{ ore: 2 }], slotsPerTab: BANK_SLOTS_PER_TAB, maxTabs: MAX_BANK_TABS, nextTabPrice: BANK_TAB_PRICES[0] });
    expect(Object.keys(state.itemDefinitions)).toEqual(['ore']);
  });
});
