import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HenchmanOffer, HiredHenchman, ServerStateMessage, ShopDefinition } from '@idle-party-rpg/shared';
import { ShopPopup } from '../src/ui/ShopPopup';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;
type ErrorListener = (message: string) => void;

const SELLSWORD: HenchmanOffer = {
  henchmanId: 'sellsword',
  name: 'Sellsword',
  description: 'Swings for coin.',
  emoji: '🗡️',
  artworkUrl: '/art/sellsword.png',
  level: 3,
  maxHp: 80,
  baseDamage: 6,
};
const ARCHER: HenchmanOffer = {
  henchmanId: 'archer',
  name: 'Archer',
  emoji: '🏹',
  level: 4,
  maxHp: 60,
  baseDamage: 9,
};

function hired(henchmanId: string, name: string, instanceId = `inst-${henchmanId}`): HiredHenchman {
  return { instanceId, henchmanId, name, emoji: '🛡️', level: 2, gridPosition: 0, mapId: 'm1' } as HiredHenchman;
}

interface StateParts {
  inventory?: ShopDefinition['inventory'];
  offers?: HenchmanOffer[];
  members?: number;
  henchmen?: HiredHenchman[];
}

function makeState(parts: StateParts = {}): ServerStateMessage {
  const shop: ShopDefinition = {
    id: 'shop1',
    name: 'Tavern',
    inventory: parts.inventory ?? [{ itemId: 'potion', price: 5 }],
  } as ShopDefinition;
  return {
    shopDefinition: shop,
    henchmanOffers: parts.offers,
    character: { gold: 100, inventory: {}, equipment: {}, className: 'Knight' },
    itemDefinitions: { potion: { id: 'potion', name: 'Potion', rarity: 'common', value: 2 } },
    setDefinitions: {},
    social: {
      party: {
        members: Array.from({ length: parts.members ?? 1 }, (_, i) => ({ username: `p${i}` })),
        henchmen: parts.henchmen ?? [],
      },
    },
  } as unknown as ServerStateMessage;
}

function setup() {
  document.body.innerHTML = '';
  const listeners = new Set<StateListener>();
  const errorListeners = new Set<ErrorListener>();
  let lastState: ServerStateMessage | null = null;
  const sendHireHenchman = vi.fn();

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onServerError: (l: ErrorListener) => { errorListeners.add(l); return () => { errorListeners.delete(l); }; },
    sendHireHenchman,
    sendShopBuy: vi.fn(),
    sendShopSell: vi.fn(),
  } as unknown as GameClient;
  const worldCache = { getSkillContent: () => ({ skills: {} }) } as unknown as WorldCache;

  const popup = new ShopPopup(gameClient, worldCache);
  const open = (parts: StateParts = {}) => {
    lastState = makeState(parts);
    popup.show(lastState);
  };
  const push = (parts: StateParts) => {
    lastState = makeState(parts);
    for (const l of listeners) l(lastState);
  };
  const serverError = (message: string) => { for (const l of errorListeners) l(message); };
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const tab = (mode: string) => $<HTMLButtonElement>(`.shop-toggle-btn[data-mode="${mode}"]`);
  const selected = () => $('.shop-toggle-btn[aria-selected="true"]')?.dataset.mode;
  const notice = () => $('.shop-modal__notice')?.textContent ?? null;

  return { popup, open, push, serverError, sendHireHenchman, $, $$, tab, selected, notice, listeners, errorListeners };
}

describe('ShopPopup hire tab', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('has no Hire tab when the shop offers no henchmen', () => {
    t.open();
    expect(t.tab('hire')).toBeNull();
    expect(t.selected()).toBe('buy');
  });

  it('opens on Buy when the shop has wares and offers', () => {
    t.open({ offers: [SELLSWORD] });
    expect(t.tab('hire')).not.toBeNull();
    expect(t.selected()).toBe('buy');
  });

  it('opens on Hire when the shop has offers but no wares', () => {
    t.open({ inventory: [], offers: [SELLSWORD] });
    expect(t.selected()).toBe('hire');
    expect(t.$$('.shop-hire-row')).toHaveLength(1);
  });

  it('lists name, level, HP and damage with a portrait, never the archetype', () => {
    t.open({ inventory: [], offers: [SELLSWORD, ARCHER] });
    const row = t.$('.shop-hire-row[data-henchman-id="sellsword"]')!;
    expect(row.querySelector('.shop-hire-name')?.textContent).toBe('Sellsword');
    expect(row.querySelector('.shop-hire-desc')?.textContent).toBe('Swings for coin.');
    expect(row.querySelector('.shop-hire-stats')?.textContent).toBe('Lv 3 · 80 HP · 6 DMG');
    expect(row.querySelector('.shop-hire-emoji')?.textContent).toBe('🗡️');
    expect(row.querySelector('img')?.getAttribute('src')).toBe('/art/sellsword.png');
    const archer = t.$('.shop-hire-row[data-henchman-id="archer"]')!;
    expect(archer.querySelector('img')).toBeNull();
    expect(archer.querySelector('.shop-hire-desc')).toBeNull();
    expect(document.body.textContent).not.toContain('Knight');
  });

  it('switches to the Hire tab and falls back to Buy when the offers vanish', () => {
    t.open({ offers: [SELLSWORD] });
    t.tab('hire')!.click();
    expect(t.selected()).toBe('hire');
    t.push({ offers: [] });
    expect(t.selected()).toBe('buy');
    expect(t.tab('hire')).toBeNull();
  });

  it('hires straight away when the party has room', () => {
    t.open({ inventory: [], offers: [SELLSWORD] });
    const btn = t.$<HTMLButtonElement>('.shop-hire-btn')!;
    expect(btn.textContent).toBe('Hire');
    btn.click();
    expect(t.sendHireHenchman).toHaveBeenCalledWith('sellsword');
  });

  it('marks an offer that is already in the party', () => {
    t.open({ inventory: [], offers: [SELLSWORD, ARCHER], henchmen: [hired('sellsword', 'Sellsword')] });
    const row = t.$('.shop-hire-row[data-henchman-id="sellsword"]')!;
    expect(row.querySelector('.shop-hire-hired')?.textContent).toBe('In party');
    expect(row.querySelector('.shop-hire-btn')).toBeNull();
    expect(t.$('.shop-hire-row[data-henchman-id="archer"] .shop-hire-btn')).not.toBeNull();
  });

  it('disables hiring with a reason when the party is full of players', () => {
    t.open({ inventory: [], offers: [SELLSWORD], members: 5 });
    const full = t.$<HTMLButtonElement>('.shop-hire-full')!;
    expect(full.disabled).toBe(true);
    expect(t.$('.shop-hire-btn')).toBeNull();
    expect(t.$('.shop-hire-why')?.textContent).toContain('full of players');
  });
});

describe('ShopPopup replace flow', () => {
  let t: ReturnType<typeof setup>;
  const fullOfHenchmen = {
    inventory: [],
    offers: [SELLSWORD],
    members: 1,
    henchmen: [hired('a', 'Alda'), hired('b', 'Bram'), hired('c', 'Cole'), hired('d', 'Dov')],
  };
  beforeEach(() => { t = setup(); });

  it('turns Hire into Replace and asks who leaves', () => {
    t.open(fullOfHenchmen);
    const btn = t.$<HTMLButtonElement>('.shop-hire-btn')!;
    expect(btn.textContent).toBe('Replace');
    btn.click();
    expect(t.sendHireHenchman).not.toHaveBeenCalled();
    expect(t.$('.shop-modal__title')?.textContent).toBe('Make room for Sellsword?');
    expect(t.$$('.shop-replace-confirm').map(b => b.dataset.instanceId)).toEqual(['inst-a', 'inst-b', 'inst-c', 'inst-d']);
  });

  it('sends the hire with the chosen henchman to replace and returns to the list', () => {
    t.open(fullOfHenchmen);
    t.$<HTMLButtonElement>('.shop-hire-btn')!.click();
    t.$<HTMLButtonElement>('.shop-replace-confirm[data-instance-id="inst-c"]')!.click();
    expect(t.sendHireHenchman).toHaveBeenCalledWith('sellsword', 'inst-c');
    expect(t.$('.shop-replace')).toBeNull();
    expect(t.selected()).toBe('hire');
  });

  it('Cancel returns to the hire list without hiring', () => {
    t.open(fullOfHenchmen);
    t.$<HTMLButtonElement>('.shop-hire-btn')!.click();
    t.$<HTMLButtonElement>('.shop-replace-cancel')!.click();
    expect(t.sendHireHenchman).not.toHaveBeenCalled();
    expect(t.$('.shop-hire-btn')).not.toBeNull();
  });

  it('leaves the replace view when the party no longer holds henchmen', () => {
    t.open(fullOfHenchmen);
    t.$<HTMLButtonElement>('.shop-hire-btn')!.click();
    t.push({ inventory: [], offers: [SELLSWORD], henchmen: [] });
    expect(t.$('.shop-replace')).toBeNull();
    expect(t.$<HTMLButtonElement>('.shop-hire-btn')?.textContent).toBe('Hire');
  });
});

describe('ShopPopup hire refusals', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('shows a server error as a notice while a hire is outstanding', () => {
    t.open({ inventory: [], offers: [SELLSWORD] });
    t.$<HTMLButtonElement>('.shop-hire-btn')!.click();
    t.serverError('Only owners and leaders can hire henchmen');
    expect(t.notice()).toBe('Only owners and leaders can hire henchmen');
  });

  it('ignores server errors when no hire is outstanding', () => {
    t.open({ inventory: [], offers: [SELLSWORD] });
    t.serverError('Something unrelated');
    expect(t.notice()).toBeNull();
  });

  it('a state tick clears the outstanding hire', () => {
    t.open({ inventory: [], offers: [SELLSWORD] });
    t.$<HTMLButtonElement>('.shop-hire-btn')!.click();
    t.push({ inventory: [], offers: [SELLSWORD], henchmen: [hired('sellsword', 'Sellsword')] });
    t.serverError('Late unrelated error');
    expect(t.notice()).toBeNull();
  });

  it('unsubscribes from state and errors on close', () => {
    t.open({ inventory: [], offers: [SELLSWORD] });
    expect(t.listeners.size).toBe(1);
    expect(t.errorListeners.size).toBe(1);
    t.popup.hide();
    expect(t.listeners.size).toBe(0);
    expect(t.errorListeners.size).toBe(0);
  });
});
