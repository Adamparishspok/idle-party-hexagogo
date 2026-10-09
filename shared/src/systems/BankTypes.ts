import type { ItemDefinition } from './ItemTypes.js';
import { MAX_STACK } from './ItemTypes.js';
import { fitsInventoryChanges } from './BagTypes.js';
import type { ShopDefinition } from './ShopTypes.js';

// See docs/architecture/gear-stats-bank.md → Bank.

// --- Types ---

type Inventory = Record<string, number>;

/** One shared bank per player, persisted. Each tab is itemId → count, at most BANK_SLOTS_PER_TAB distinct ids. */
export interface PlayerBank {
  tabs: Inventory[];
}

/** Sent on the state push only while the party stands in a banker's room. */
export interface ClientBankState {
  tabs: Inventory[];
  slotsPerTab: number;
  maxTabs: number;
  /** null once every tab is bought. */
  nextTabPrice: number | null;
  itemDefinitions: Record<string, ItemDefinition>;
}

export type BankErrorCode =
  | 'bank_not_here'
  | 'bank_invalid_request'
  | 'bank_item_missing'
  | 'bank_tab_full'
  | 'bank_bag_full'
  | 'bank_cannot_afford'
  | 'bank_max_tabs';

export type BankResult =
  | { ok: true; tab: number; quantity: number }
  | { ok: false; error: BankErrorCode };

/** `tab` omitted = the server picks (`chooseDepositTab`). */
export interface ClientBankDepositMessage { type: 'bank_deposit'; itemId: string; quantity: number; tab?: number }
export interface ClientBankWithdrawMessage { type: 'bank_withdraw'; tab: number; itemId: string; quantity: number }
export interface ClientBankMoveMessage { type: 'bank_move'; fromTab: number; toTab: number; itemId: string; quantity: number }
export interface ClientBankBuyTabMessage { type: 'bank_buy_tab' }

export type ClientBankMessage =
  | ClientBankDepositMessage
  | ClientBankWithdrawMessage
  | ClientBankMoveMessage
  | ClientBankBuyTabMessage;

// --- Constants ---

export const BANK_BASE_TABS = 1;
export const BANK_SLOTS_PER_TAB = 28;
/** Gold for the 2nd, 3rd, … tab. */
export const BANK_TAB_PRICES: readonly number[] = [1_000, 5_000, 25_000, 100_000, 500_000];
export const MAX_BANK_TABS = BANK_BASE_TABS + BANK_TAB_PRICES.length;

/** A fresh world's banker, on the starting room, also selling the seed bags. Live servers author their own. */
export const SEED_BANKER_SHOP: ShopDefinition = {
  id: 'hatchetmill_bank',
  name: 'Hatchetmill Bank',
  banker: true,
  inventory: [
    { itemId: 'small_pouch', price: 50 },
    { itemId: 'cloth_bag', price: 120 },
    { itemId: 'leather_pack', price: 300 },
  ],
};

// --- Pure functions ---

export function emptyBank(): PlayerBank {
  return { tabs: Array.from({ length: BANK_BASE_TABS }, () => ({})) };
}

/** Restores a saved bank: at least the base tabs, never more than the max. */
export function normalizeBank(saved: PlayerBank | undefined): PlayerBank {
  const tabs = (saved?.tabs ?? []).slice(0, MAX_BANK_TABS).map(tab => ({ ...tab }));
  while (tabs.length < BANK_BASE_TABS) tabs.push({});
  return { tabs };
}

export function nextBankTabPrice(bank: PlayerBank): number | null {
  const bought = bank.tabs.length - BANK_BASE_TABS;
  return BANK_TAB_PRICES[bought] ?? null;
}

/** Appends a tab after the caller has taken `nextBankTabPrice` gold. */
export function addBankTab(bank: PlayerBank): boolean {
  if (bank.tabs.length >= MAX_BANK_TABS) return false;
  bank.tabs.push({});
  return true;
}

export function bankTabUsedSlots(tab: Inventory): number {
  let used = 0;
  for (const count of Object.values(tab)) if (count > 0) used++;
  return used;
}

export function canDepositToTab(bank: PlayerBank, tab: number, itemId: string, quantity: number): boolean {
  const contents = bank.tabs[tab];
  if (!contents || quantity <= 0) return false;
  const current = contents[itemId] ?? 0;
  if (current + quantity > MAX_STACK) return false;
  return current > 0 || bankTabUsedSlots(contents) < BANK_SLOTS_PER_TAB;
}

/** First tab already holding the item with room, else the first tab with a free slot, else -1. */
export function chooseDepositTab(bank: PlayerBank, itemId: string, quantity: number): number {
  const withStack = bank.tabs.findIndex((tab, i) => (tab[itemId] ?? 0) > 0 && canDepositToTab(bank, i, itemId, quantity));
  if (withStack >= 0) return withStack;
  return bank.tabs.findIndex((_, i) => canDepositToTab(bank, i, itemId, quantity));
}

/** Backpack → bank. Mutates both. */
export function bankDeposit(
  bank: PlayerBank,
  inventory: Inventory,
  itemId: string,
  quantity: number,
  tab?: number,
): BankResult {
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, error: 'bank_invalid_request' };
  if (tab !== undefined && !isTabIndex(bank, tab)) return { ok: false, error: 'bank_invalid_request' };
  if ((inventory[itemId] ?? 0) < quantity) return { ok: false, error: 'bank_item_missing' };
  const target = tab ?? chooseDepositTab(bank, itemId, quantity);
  if (target < 0 || !canDepositToTab(bank, target, itemId, quantity)) return { ok: false, error: 'bank_tab_full' };

  take(inventory, itemId, quantity);
  bank.tabs[target][itemId] = (bank.tabs[target][itemId] ?? 0) + quantity;
  return { ok: true, tab: target, quantity };
}

/** Bank → backpack, honouring backpack capacity. Mutates both. */
export function bankWithdraw(
  bank: PlayerBank,
  inventory: Inventory,
  capacity: number,
  tab: number,
  itemId: string,
  quantity: number,
): BankResult {
  if (!Number.isInteger(quantity) || quantity <= 0 || !isTabIndex(bank, tab)) return { ok: false, error: 'bank_invalid_request' };
  if ((bank.tabs[tab][itemId] ?? 0) < quantity) return { ok: false, error: 'bank_item_missing' };
  if (!fitsInventoryChanges(inventory, capacity, { [itemId]: quantity })) return { ok: false, error: 'bank_bag_full' };

  take(bank.tabs[tab], itemId, quantity);
  inventory[itemId] = (inventory[itemId] ?? 0) + quantity;
  return { ok: true, tab, quantity };
}

export function bankMove(bank: PlayerBank, fromTab: number, toTab: number, itemId: string, quantity: number): BankResult {
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, error: 'bank_invalid_request' };
  if (!isTabIndex(bank, fromTab) || !isTabIndex(bank, toTab) || fromTab === toTab) return { ok: false, error: 'bank_invalid_request' };
  if ((bank.tabs[fromTab][itemId] ?? 0) < quantity) return { ok: false, error: 'bank_item_missing' };
  if (!canDepositToTab(bank, toTab, itemId, quantity)) return { ok: false, error: 'bank_tab_full' };

  take(bank.tabs[fromTab], itemId, quantity);
  bank.tabs[toTab][itemId] = (bank.tabs[toTab][itemId] ?? 0) + quantity;
  return { ok: true, tab: toTab, quantity };
}

export function toClientBankState(bank: PlayerBank, items: Record<string, ItemDefinition>): ClientBankState {
  const itemDefinitions: Record<string, ItemDefinition> = {};
  for (const tab of bank.tabs) {
    for (const id of Object.keys(tab)) if (items[id]) itemDefinitions[id] = items[id];
  }
  return {
    tabs: bank.tabs.map(tab => ({ ...tab })),
    slotsPerTab: BANK_SLOTS_PER_TAB,
    maxTabs: MAX_BANK_TABS,
    nextTabPrice: nextBankTabPrice(bank),
    itemDefinitions,
  };
}

function isTabIndex(bank: PlayerBank, tab: number): boolean {
  return Number.isInteger(tab) && tab >= 0 && tab < bank.tabs.length;
}

function take(from: Inventory, itemId: string, quantity: number): void {
  const left = (from[itemId] ?? 0) - quantity;
  if (left <= 0) delete from[itemId];
  else from[itemId] = left;
}
