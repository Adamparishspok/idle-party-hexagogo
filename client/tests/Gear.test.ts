import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientBankState, DerivedStats, ItemDefinition, ServerStateMessage, ShopSummary } from '@idle-party-rpg/shared';
import { computeDerivedStats } from '@idle-party-rpg/shared';
import type { GameClient } from '../src/network/GameClient';
import {
  bagBarModel,
  bankTabs,
  currentDerivedStats,
  deltaChips,
  formatDelta,
  slotPickerModel,
} from '../src/ui/GearModel';
import { statsSheetModel, renderStatsSheet } from '../src/ui/StatsSheet';
import { GearPicker } from '../src/ui/GearPicker';
import { BagPanel, capacityWarning } from '../src/ui/BagPanel';
import { BankView, resolveBankDrop } from '../src/ui/BankView';
import { hideItemTooltip, installItemTooltips, renderItemTooltip } from '../src/ui/ItemStats';
import { renderKitItem } from '../src/ui/ItemIcon';
import { installGearErrorToasts } from '../src/ui/GameToast';
import { BANK_ACTION_NAME, getRoomActions } from '../src/ui/RoomActions';
import { CharItemsScreen } from '../src/screens/CharItemsScreen';
import type { WorldCache } from '../src/network/WorldCache';
import type { RoomActionLookups } from '../src/ui/RoomActions';

const ITEMS: Record<string, ItemDefinition> = {
  sword: { id: 'sword', name: 'Iron Sword', rarity: 'common', equipSlot: 'mainhand', attributes: { strength: 3 } },
  blade: { id: 'blade', name: 'Rune Blade', rarity: 'rare', equipSlot: 'mainhand', attributes: { strength: 9, stamina: 2 } },
  axe: { id: 'axe', name: 'Great Axe', rarity: 'uncommon', equipSlot: 'twohanded', attributes: { strength: 12 } },
  wand: { id: 'wand', name: 'Wand', rarity: 'epic', equipSlot: 'mainhand', classRestriction: ['Mage'], attributes: { intellect: 9 } },
  cap: { id: 'cap', name: 'Leather Cap', rarity: 'common', equipSlot: 'head', damageReductionMin: 1, damageReductionMax: 2 },
  satchel: { id: 'satchel', name: 'Satchel', rarity: 'common', bagSlots: 12 },
  pack: { id: 'pack', name: 'Big Pack', rarity: 'uncommon', bagSlots: 8 },
  ore: { id: 'ore', name: 'Iron Ore', rarity: 'common' },
};

type StateListener = (s: ServerStateMessage) => void;
type ErrorListener = (message: string, code?: string) => void;

function mockClient() {
  const listeners = new Set<StateListener>();
  const errorListeners = new Set<ErrorListener>();
  let lastState: ServerStateMessage | null = null;
  const sends = {
    sendEquipItem: vi.fn(),
    sendUnequipItem: vi.fn(),
    sendEquipBag: vi.fn(),
    sendUnequipBag: vi.fn(),
    sendClaimLostFound: vi.fn(),
    sendDiscardLostFound: vi.fn(),
    sendBankDeposit: vi.fn(),
    sendBankWithdraw: vi.fn(),
    sendBankMove: vi.fn(),
    sendBankBuyTab: vi.fn(),
  };
  const client = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onServerError: (l: ErrorListener) => { errorListeners.add(l); return () => { errorListeners.delete(l); }; },
    ...sends,
  } as unknown as GameClient;
  const push = (s: ServerStateMessage) => {
    lastState = s;
    for (const l of listeners) l(s);
  };
  const serverError = (m: string, code?: string) => { for (const l of errorListeners) l(m, code); };
  return { client, sends, push, serverError };
}

interface StateOpts {
  className?: string;
  inventory?: Record<string, number>;
  equipment?: Record<string, string | null>;
  bags?: (string | null)[];
  capacity?: number;
  lostAndFound?: Record<string, number>;
  derivedStats?: DerivedStats;
  bank?: ClientBankState;
  gold?: number;
}

function makeState(opts: StateOpts = {}): ServerStateMessage {
  return {
    type: 'state',
    username: 'me',
    character: {
      className: opts.className ?? 'Knight',
      level: 10,
      xp: 0,
      xpForNextLevel: 100,
      maxHp: 95,
      gold: opts.gold ?? 2000,
      baseDamage: 10,
      damageType: 'physical',
      skillLoadout: { equippedSkills: [], unlockedSkills: [] },
      grantedSkillIds: [],
      xpRate: { startTime: Date.now(), totalXp: 0 },
      inventory: opts.inventory ?? {},
      equipment: opts.equipment ?? { mainhand: null, offhand: null, head: null },
      bags: opts.bags,
      inventoryCapacity: opts.capacity,
      lostAndFound: opts.lostAndFound,
      derivedStats: opts.derivedStats,
    },
    itemDefinitions: ITEMS,
    setDefinitions: {},
    bank: opts.bank,
  } as unknown as ServerStateMessage;
}

function bankState(tabs: Record<string, number>[], nextTabPrice: number | null = 1000): ClientBankState {
  return { tabs, slotsPerTab: 28, maxTabs: 6, nextTabPrice, itemDefinitions: {} };
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

// ── Pure models ─────────────────────────────────────────────

describe('slotPickerModel', () => {
  it('lists class-usable items that fit, best rarity first, with stat deltas', () => {
    const state = makeState({ inventory: { sword: 1, blade: 1, axe: 1, wand: 1, cap: 1, ore: 4 }, equipment: { mainhand: 'sword' } });
    const model = slotPickerModel('mainhand', state)!;
    expect(model.equipped?.itemId).toBe('sword');
    expect(model.candidates.map(c => c.itemId)).toEqual(['blade', 'axe', 'sword']);
    const blade = model.candidates[0];
    expect(blade.keyStat).toBe('+9 Strength');
    const str = blade.deltas.find(d => d.key === 'strength')!;
    expect(str.delta).toBe(6);
    expect(blade.deltas.find(d => d.key === 'damage')!.delta).toBeGreaterThan(0);
  });

  it('returns no candidates when nothing fits', () => {
    const model = slotPickerModel('ring', makeState({ inventory: { ore: 1 } }))!;
    expect(model.candidates).toEqual([]);
    expect(model.equipped).toBeNull();
  });
});

describe('deltaChips', () => {
  it('puts combat stats before raw attributes and signs them', () => {
    const state = makeState({ inventory: { blade: 1 } });
    const deltas = slotPickerModel('mainhand', state)!.candidates[0].deltas;
    const chips = deltaChips(deltas);
    expect(chips[0].text).toMatch(/^\+\d+ Dmg$/);
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.every(c => c.better)).toBe(true);
  });

  it('formats percentages and losses', () => {
    expect(formatDelta({ key: 'critChance', label: 'Crit', before: '', after: '', delta: 0.005 })).toBe('+0.5%');
    expect(formatDelta({ key: 'armor', label: 'Armor', before: '', after: '', delta: -1.5 })).toBe('−1.5');
  });
});

describe('currentDerivedStats', () => {
  it('prefers the server numbers and falls back to the shared formula', () => {
    const local = currentDerivedStats(makeState())!;
    expect(local.maxHp).toBe(95);
    const server = { ...local, maxHp: 999 };
    expect(currentDerivedStats(makeState({ derivedStats: server }))!.maxHp).toBe(999);
  });
});

describe('bagBarModel', () => {
  it('derives capacity from bags when the server omits it', () => {
    const model = bagBarModel(makeState({ bags: ['satchel', null, null, null], inventory: { ore: 1, pack: 1 } }))!;
    expect(model.capacity).toBe(32);
    expect(model.used).toBe(2);
    expect(model.slots.map(s => s.size)).toEqual([12, 0, 0, 0]);
    expect(model.bagsInBackpack).toEqual([['pack', 1]]);
    expect(model.full).toBe(false);
  });

  it('flags full and over-capacity backpacks', () => {
    const inv = { ore: 1, cap: 1, sword: 1 };
    expect(capacityWarning(bagBarModel(makeState({ inventory: inv, capacity: 3 }))!)).toMatch(/bags are full/);
    expect(capacityWarning(bagBarModel(makeState({ inventory: inv, capacity: 2 }))!)).toMatch(/Over capacity/);
    expect(capacityWarning(bagBarModel(makeState({ inventory: inv, capacity: 20 }))!)).toBeNull();
  });
});

describe('statsSheetModel', () => {
  it('highlights the class primary and explains each stat', () => {
    const stats = computeDerivedStats({ className: 'Archer', level: 10, equipment: {}, items: {} });
    const model = statsSheetModel(stats);
    expect(model.attributes.filter(a => a.primary).map(a => a.name)).toEqual(['agility']);
    expect(model.derived.map(d => d.label)).toEqual(['Health', 'Damage', 'Armor', 'Resist', 'Crit', 'Dodge', 'Healing']);
    expect(model.derived.find(d => d.key === 'crit')!.value).toBe('3.3%');
    expect(model.derived.every(d => d.explain.length > 0)).toBe(true);
  });

  it('renders tappable cells with explanations', () => {
    const stats = computeDerivedStats({ className: 'Knight', level: 10, equipment: { mainhand: 'blade' }, items: ITEMS });
    document.body.innerHTML = renderStatsSheet(stats, { exclude: ['maxHp'] });
    const str = $('.ss-attr[data-attribute="strength"]')!;
    expect(str.classList.contains('is-primary')).toBe(true);
    expect(str.querySelector('.ss-attr__sub')!.textContent).toBe('20 + 9 gear');
    expect($('[data-stat="maxHp"]')).toBeNull();
    expect($('[data-stat="armor"]')!.dataset.statDesc).toMatch(/physical damage/);
  });
});

describe('bankTabs', () => {
  it('counts used stacks per tab', () => {
    const tabs = bankTabs(bankState([{ ore: 5, cap: 1 }, {}]));
    expect(tabs.map(t => [t.used, t.slots])).toEqual([[2, 28], [0, 28]]);
  });
});

// ── Room action ────────────────────────────────────────────

describe('bank room action', () => {
  const shops: Record<string, ShopSummary> = {
    bankOnly: { id: 'bankOnly', name: 'Vault', sellsItems: false, hiresHenchmen: false, sellsHouses: false, isBanker: true },
    both: { id: 'both', name: 'Exchange', sellsItems: true, hiresHenchmen: false, sellsHouses: false, isBanker: true },
  };
  const lookups: RoomActionLookups = {
    getNpc: () => undefined,
    getShop: id => shops[id],
    getDungeon: () => undefined,
    getTileByGuid: () => undefined,
    getMaps: () => [],
  };

  it('a bank-only banker shows just the bank', () => {
    expect(getRoomActions({ shopId: 'bankOnly' }, lookups).map(a => [a.kind, a.name])).toEqual([['bank', BANK_ACTION_NAME]]);
  });

  it('a banker that sells items shows the shop and the bank', () => {
    expect(getRoomActions({ shopId: 'both' }, lookups).map(a => a.kind)).toEqual(['shop', 'bank']);
  });
});

// ── Tooltip ────────────────────────────────────────────────

describe('item tooltip', () => {
  it('renders stat lines and an If equipped block for usable gear', () => {
    const state = makeState({ equipment: { mainhand: 'sword' } });
    const html = renderItemTooltip(ITEMS.blade, {
      className: 'Knight',
      level: 10,
      compareInput: { className: 'Knight', level: 10, equipment: state.character!.equipment, items: ITEMS },
    });
    document.body.innerHTML = html;
    expect($('.gs-line.is-primary')!.textContent).toBe('+9 Strength');
    expect($('.gs-tip__compare-title')!.textContent).toBe('If equipped');
  });

  it('omits the compare block for gear the class cannot use', () => {
    const html = renderItemTooltip(ITEMS.wand, {
      className: 'Knight',
      compareInput: { className: 'Knight', level: 10, equipment: {}, items: ITEMS },
    });
    expect(html).not.toContain('If equipped');
  });

  it('shows on hover over any rendered item frame with a fine pointer', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: fine)' }));
    installItemTooltips(() => ({ className: 'Knight', level: 10 }));
    document.body.innerHTML = `<div>${renderKitItem('cap', ITEMS.cap, { button: true })}</div>`;
    const frame = $('[data-tip-item="cap"]')!;
    frame.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect($('.gs-tip')!.textContent).toContain('Leather Cap');
    expect($('.gs-tip')!.textContent).toContain('+1–2 Armor');
    hideItemTooltip();
    expect($('.gs-tip')).toBeNull();
  });
});

// ── Gear picker ────────────────────────────────────────────

describe('GearPicker', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
  });

  function openPicker(state: ServerStateMessage, slot: 'mainhand' | 'head' | 'ring' = 'mainhand') {
    const mock = mockClient();
    mock.push(state);
    const picker = new GearPicker(mock.client);
    picker.open(slot);
    return { ...mock, picker };
  }

  it('lists candidates with delta chips and the equipped item', () => {
    openPicker(makeState({ inventory: { blade: 1, axe: 1 }, equipment: { mainhand: 'sword' } }));
    expect($$('.gp-row').map(r => r.dataset.gpRow)).toEqual(['blade', 'axe']);
    expect($('.gp-equipped .gp-name')!.textContent).toBe('Iron Sword');
    expect($$('.gp-row')[0].querySelectorAll('.gs-chip--up').length).toBeGreaterThan(0);
  });

  it('first tap expands the compare, Equip sends equip_item', () => {
    const { sends } = openPicker(makeState({ inventory: { blade: 1 }, equipment: { mainhand: 'sword' } }));
    $('.gp-row')!.click();
    expect(sends.sendEquipItem).not.toHaveBeenCalled();
    expect($('.gp-detail .gs-deltas')).not.toBeNull();
    $('.gp-equip')!.click();
    expect(sends.sendEquipItem).toHaveBeenCalledWith('blade');
    expect($('.gp-modal')!.style.display).toBe('none');
  });

  it('a second tap on the same row equips', () => {
    const { sends } = openPicker(makeState({ inventory: { blade: 1 } }));
    $('.gp-row')!.click();
    $('.gp-row')!.click();
    expect(sends.sendEquipItem).toHaveBeenCalledWith('blade');
  });

  it('clicking equips straight away with a mouse', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: fine)' }));
    const { sends } = openPicker(makeState({ inventory: { blade: 1 } }));
    $('.gp-row')!.click();
    expect(sends.sendEquipItem).toHaveBeenCalledWith('blade');
  });

  it('Unequip sends unequip_item for the slot', () => {
    const { sends } = openPicker(makeState({ equipment: { mainhand: 'sword' } }));
    $('[data-gp-action="unequip"]')!.click();
    expect(sends.sendUnequipItem).toHaveBeenCalledWith('mainhand');
  });

  it('says so when nothing fits', () => {
    openPicker(makeState({ inventory: { ore: 2 } }), 'ring');
    expect($('.gp-empty')!.textContent).toBe('Nothing in your bags fits this slot.');
  });
});

// ── Bag bar and Lost & Found ───────────────────────────────

describe('BagPanel', () => {
  function mount(state: ServerStateMessage) {
    const mock = mockClient();
    mock.push(state);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const panel = new BagPanel(host, mock.client);
    panel.update(state);
    return { ...mock, panel, host };
  }

  it('shows capacity, bag slots and the pouch badge', () => {
    const { host } = mount(makeState({ bags: ['satchel', null, null, null], inventory: { ore: 3 }, lostAndFound: { cap: 1, ore: 2 } }));
    expect(host.querySelector('.bb-cap__value')!.textContent).toBe('1 / 32');
    expect(host.querySelectorAll('.bb-slot').length).toBe(4);
    expect(host.querySelector('.bb-pouch-badge')!.textContent).toBe('2');
    expect(host.querySelector('.bb-warn')).toBeNull();
  });

  it('warns when the backpack is full', () => {
    const { host } = mount(makeState({ inventory: { ore: 1, cap: 1 }, capacity: 2 }));
    expect(host.querySelector('.bb-warn')!.textContent).toMatch(/Lost & Found/);
  });

  it('equips a bag from the backpack into an empty slot', () => {
    const { host, sends } = mount(makeState({ inventory: { pack: 1 } }));
    (host.querySelector('[data-bag-index="1"]') as HTMLElement).click();
    ($('[data-bb-equip="pack"]') as HTMLElement).click();
    expect(sends.sendEquipBag).toHaveBeenCalledWith('pack', 1);
  });

  it('blocks removing a bag the backpack could not do without', () => {
    const inv: Record<string, number> = {};
    for (let i = 0; i < 25; i++) inv[`junk${i}`] = 1;
    const { host, sends } = mount(makeState({ bags: ['satchel', null, null, null], inventory: inv }));
    (host.querySelector('[data-bag-index="0"]') as HTMLElement).click();
    const remove = $('[data-bb-action="unequip"]') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    remove.click();
    expect(sends.sendUnequipBag).not.toHaveBeenCalled();
  });

  it('claims, claims all and discards from Lost & Found', () => {
    const { host, sends } = mount(makeState({ inventory: {}, lostAndFound: { ore: 2, cap: 1 } }));
    (host.querySelector('[data-bb-action="pouch"]') as HTMLElement).click();
    ($('[data-bb-claim="ore"]') as HTMLElement).click();
    expect(sends.sendClaimLostFound).toHaveBeenCalledWith('ore');
    ($('[data-bb-action="claim-all"]') as HTMLElement).click();
    expect(sends.sendClaimLostFound).toHaveBeenLastCalledWith();
    ($('[data-bb-discard="cap"]') as HTMLElement).click();
    ($('[data-bb-action="discard-confirm"]') as HTMLElement).click();
    expect(sends.sendDiscardLostFound).toHaveBeenCalledWith('cap');
  });
});

// ── Bank ───────────────────────────────────────────────────

describe('BankView', () => {
  function mount(state: ServerStateMessage) {
    const mock = mockClient();
    mock.push(state);
    const bank = new BankView(mock.client);
    return { ...mock, bank };
  }

  it('only opens while the party is in a banker room', () => {
    const { bank } = mount(makeState());
    expect(bank.show()).toBe(false);
    expect(bank.isOpen()).toBe(false);
  });

  it('shows tabs, the open tab and the backpack', () => {
    const { bank } = mount(makeState({ inventory: { ore: 3 }, bank: bankState([{ cap: 1 }, { sword: 1 }]) }));
    expect(bank.show()).toBe(true);
    expect($$('.bank-tab').map(t => t.querySelector('.bank-tab__name')!.textContent)).toEqual(['Tab 1', 'Tab 2']);
    expect($('.bank-pane--vault [data-bank-item="cap"]')).not.toBeNull();
    expect($('.bank-pane--pack [data-pack-item="ore"]')).not.toBeNull();
    expect($('.bank-buy-tab')!.textContent).toContain('1,000g');
  });

  it('deposits into the open tab with the chosen amount', () => {
    const { bank, sends } = mount(makeState({ inventory: { ore: 3 }, bank: bankState([{}, {}]) }));
    bank.show();
    ($('[data-bank-tab="1"]') as HTMLElement).click();
    ($('[data-pack-item="ore"]') as HTMLElement).click();
    ($('[data-bank-qty="all"]') as HTMLElement).click();
    ($('[data-bank-action="deposit"]') as HTMLElement).click();
    expect(sends.sendBankDeposit).toHaveBeenCalledWith('ore', 3, 1);
  });

  it('withdraws, and refuses up front when the bags are full', () => {
    const full = mount(makeState({ inventory: { sword: 1 }, capacity: 1, bank: bankState([{ ore: 2 }]) }));
    full.bank.show();
    ($('[data-bank-item="ore"]') as HTMLElement).click();
    expect(($('[data-bank-action="withdraw"]') as HTMLButtonElement).disabled).toBe(true);
    expect($('.gc-modal__why')!.textContent).toMatch(/bags are full/);
    full.bank.close();
    document.body.innerHTML = '';

    const ok = mount(makeState({ inventory: {}, bank: bankState([{ ore: 2 }]) }));
    ok.bank.show();
    ($('[data-bank-item="ore"]') as HTMLElement).click();
    ($('[data-bank-action="withdraw"]') as HTMLElement).click();
    expect(ok.sends.sendBankWithdraw).toHaveBeenCalledWith(0, 'ore', 1);
  });

  it('buys a tab after confirming, and blocks it without the gold', () => {
    const { bank, sends } = mount(makeState({ gold: 500, bank: bankState([{}]) }));
    bank.show();
    ($('.bank-buy-tab') as HTMLElement).click();
    expect(($('[data-bank-action="buy-confirm"]') as HTMLButtonElement).disabled).toBe(true);
    expect($('.gc-modal__why')!.textContent).toBe('You need 500 more gold.');
    bank.close();

    const rich = mount(makeState({ gold: 5000, bank: bankState([{}]) }));
    rich.bank.show();
    ($('.bank-buy-tab') as HTMLElement).click();
    ($('[data-bank-action="buy-confirm"]') as HTMLElement).click();
    expect(rich.sends.sendBankBuyTab).toHaveBeenCalled();
    expect(sends.sendBankBuyTab).not.toHaveBeenCalled();
  });

  it('closes when the party leaves the banker room', () => {
    const { bank, push } = mount(makeState({ bank: bankState([{}]) }));
    bank.show();
    push(makeState());
    expect(bank.isOpen()).toBe(false);
    expect($('.bank-modal')!.style.display).toBe('none');
  });

  it('shows bank refusals inside the bank instead of a toast', () => {
    const { bank, serverError, client } = mount(makeState({ bank: bankState([{}]) }));
    installGearErrorToasts(client, (code) => bank.claimsError(code));
    bank.show();
    serverError('', 'bank_tab_full');
    expect($('.bank-notice')!.textContent).toBe('That bank tab is full.');
    expect($('.gs-toast')).toBeNull();
  });
});

describe('resolveBankDrop', () => {
  const bank = bankState([{ ore: 5 }, {}]);

  it('deposits the whole backpack stack into the tab it lands on', () => {
    expect(resolveBankDrop({ from: 'pack', itemId: 'ore' }, { to: 'tab', tab: 1 }, bank, { ore: 3 }))
      .toEqual({ kind: 'deposit', itemId: 'ore', qty: 3, tab: 1 });
    expect(resolveBankDrop({ from: 'pack', itemId: 'ore' }, { to: 'pack' }, bank, { ore: 3 })).toBeNull();
    expect(resolveBankDrop({ from: 'pack', itemId: 'cap' }, { to: 'tab', tab: 0 }, bank, { ore: 3 })).toBeNull();
  });

  it('withdraws or moves the whole bank stack', () => {
    expect(resolveBankDrop({ from: 'bank', tab: 0, itemId: 'ore' }, { to: 'pack' }, bank, {}))
      .toEqual({ kind: 'withdraw', tab: 0, itemId: 'ore', qty: 5 });
    expect(resolveBankDrop({ from: 'bank', tab: 0, itemId: 'ore' }, { to: 'tab', tab: 1 }, bank, {}))
      .toEqual({ kind: 'move', from: 0, to: 1, itemId: 'ore', qty: 5 });
    expect(resolveBankDrop({ from: 'bank', tab: 0, itemId: 'ore' }, { to: 'tab', tab: 0 }, bank, {})).toBeNull();
  });
});

describe('BankView drag and drop', () => {
  function drag(type: string, el: Element) {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  }

  function mountFine(state: ServerStateMessage) {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: fine)' }));
    const mock = mockClient();
    mock.push(state);
    const bank = new BankView(mock.client);
    bank.show();
    return { ...mock, bank };
  }

  it('makes items draggable only with a mouse', () => {
    mountFine(makeState({ inventory: { ore: 2 }, bank: bankState([{ cap: 1 }]) }));
    expect(($('[data-pack-item="ore"]') as HTMLElement).draggable).toBe(true);
    expect(($('[data-bank-item="cap"]') as HTMLElement).draggable).toBe(true);
  });

  it('deposits on drop into the open tab and moves onto another tab chip', () => {
    const { sends } = mountFine(makeState({ inventory: { ore: 2 }, bank: bankState([{ cap: 1 }, {}]) }));
    drag('dragstart', $('[data-pack-item="ore"]')!);
    drag('drop', $('.bank-pane--vault')!);
    expect(sends.sendBankDeposit).toHaveBeenCalledWith('ore', 2, 0);
    drag('dragstart', $('[data-bank-item="cap"]')!);
    drag('drop', $('[data-bank-tab="1"]')!);
    expect(sends.sendBankMove).toHaveBeenCalledWith(0, 1, 'cap', 1);
  });

  it('withdraws on drop into the backpack and holds re-renders mid-drag', () => {
    const { sends, push } = mountFine(makeState({ inventory: {}, bank: bankState([{ cap: 1 }]) }));
    const source = $('[data-bank-item="cap"]')!;
    drag('dragstart', source);
    push(makeState({ inventory: { ore: 1 }, bank: bankState([{ cap: 1 }]) }));
    expect(source.isConnected).toBe(true);
    drag('drop', $('.bank-pane--pack')!);
    expect(sends.sendBankWithdraw).toHaveBeenCalledWith(0, 'cap', 1);
    expect($('.bank-pane--pack [data-pack-item="ore"]')).not.toBeNull();
  });
});

describe('gear error toasts', () => {
  it('toasts bag refusals and ignores unrelated errors', () => {
    const { client, serverError } = mockClient();
    installGearErrorToasts(client);
    serverError('Some chat error');
    expect($('.gs-toast')).toBeNull();
    serverError('', 'bag_no_room');
    expect($('.gs-toast')!.textContent).toMatch(/too small without that bag/);
    serverError('Server says no', 'inventory_full');
    expect($('.gs-toast')!.textContent).toBe('Server says no');
  });
});

// ── Character screen wiring ────────────────────────────────

describe('CharItemsScreen gear wiring', () => {
  function mountScreen(state: ServerStateMessage) {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const mock = mockClient();
    const client = Object.assign(mock.client, { onEquipBlocked: () => () => {} });
    mock.push(state);
    const worldCache = {
      contentGeneration: 0,
      getSlotSchedule: () => [],
      getSkill: () => undefined,
      getSkillContent: () => ({ skills: {} }),
    } as unknown as WorldCache;
    const el = document.createElement('div');
    el.id = 'screen-items';
    document.body.appendChild(el);
    const screen = new CharItemsScreen('screen-items', client, worldCache);
    screen.onActivate();
    return { ...mock, screen, el };
  }

  it('renders the stats sheet with the primary attribute highlighted', () => {
    const { el } = mountScreen(makeState({ equipment: { mainhand: 'blade' } }));
    expect(el.querySelector('.ss-attr.is-primary')!.getAttribute('data-attribute')).toBe('strength');
    expect(el.querySelector('[data-stat="armor"]')).not.toBeNull();
    expect(el.querySelector('.ss-stat--gold .ss-stat__value')!.textContent).toBe('2,000');
  });

  it('opens the gear picker from both filled and empty slots', () => {
    const { el } = mountScreen(makeState({ inventory: { cap: 1 }, equipment: { mainhand: 'sword', head: null } }));
    (el.querySelector('.gc-item[data-slot="head"]') as HTMLElement).click();
    expect($('.gp-modal')!.style.display).toBe('flex');
    expect($$('.gp-row').map(r => r.dataset.gpRow)).toEqual(['cap']);
    ($('.gp-modal .gc-modal__close') as HTMLElement).click();
    (el.querySelector('.gc-item[data-slot="mainhand"]') as HTMLElement).click();
    expect($('.gp-equipped .gp-name')!.textContent).toBe('Iron Sword');
  });

  it('draws free backpack cells up to capacity and the bag bar', () => {
    const { el } = mountScreen(makeState({ inventory: { ore: 2, cap: 1 }, capacity: 5 }));
    expect(el.querySelectorAll('.ci-bag__free').length).toBe(3);
    expect(el.querySelector('.bb-cap__value')!.textContent).toBe('2 / 5');
  });
});
