import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientSocialState, GamePartyMember, HomeLocation, HomeOccupant, HouseDefinition, HouseOffer, ServerStateMessage, ShopDefinition,
} from '@idle-party-rpg/shared';
import { houseSellPrice } from '@idle-party-rpg/shared';
import { ShopPopup } from '../src/ui/ShopPopup';
import { HomeView, RESTED_HINT } from '../src/ui/HomeView';
import { TopHud } from '../src/ui/TopHud';
import { WellRestedChip, formatRestedRemaining } from '../src/ui/WellRestedChip';
import { resolveClientNavigation } from '../src/ui/NotificationCenter';
import { SocialScreen } from '../src/screens/SocialScreen';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';
import type { ChatLocalStore } from '../src/network/ChatLocalStore';

type StateListener = (state: ServerStateMessage) => void;
type ErrorListener = (message: string) => void;

const COTTAGE: HouseDefinition = {
  id: 'cottage', name: 'Cottage', tier: 1, price: 500, storageSlots: 2, displaySlots: 3, emoji: '🏠',
};
const COTTAGE_OFFER: HouseOffer = {
  houseId: 'cottage', name: 'Cottage', description: 'Snug.', tier: 1, price: 500, storageSlots: 2, displaySlots: 3, emoji: '🏠',
};

function mockClient() {
  const listeners = new Set<StateListener>();
  const errorListeners = new Set<ErrorListener>();
  let lastState: ServerStateMessage | null = null;
  const sends = {
    sendBuyHouse: vi.fn(),
    sendSellHouse: vi.fn(),
    sendEnterHome: vi.fn(),
    sendTravelHome: vi.fn(),
    sendLeaveHome: vi.fn(),
    sendHomeStore: vi.fn(),
    sendHomeWithdraw: vi.fn(),
    sendHomeDisplay: vi.fn(),
    sendCampfireSit: vi.fn(),
    sendCampfireStand: vi.fn(),
    sendHomeInvite: vi.fn(),
    sendHireHenchman: vi.fn(),
    sendShopBuy: vi.fn(),
    sendShopSell: vi.fn(),
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
  return { client, sends, push, serverError, setLast: (s: ServerStateMessage) => { lastState = s; } };
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

// ── Shop: Houses tab ─────────────────────────────────────────

describe('ShopPopup Houses tab', () => {
  function shopState(opts: { gold?: number; owns?: boolean; inventory?: ShopDefinition['inventory'] } = {}): ServerStateMessage {
    return {
      shopDefinition: { id: 'agent', name: 'Estate Agent', inventory: opts.inventory ?? [] } as ShopDefinition,
      party: { col: 0, row: 0 },
      currentMapId: 'm',
      houseOffers: [COTTAGE_OFFER],
      house: opts.owns ? { house: { houseId: 'cottage', purchasedAt: 0, storage: {}, displays: [null, null, null] }, definition: COTTAGE } : undefined,
      character: { gold: opts.gold ?? 1000, inventory: {}, equipment: {}, className: 'Knight' },
      itemDefinitions: { potion: { id: 'potion', name: 'Potion', rarity: 'common', value: 2 } },
      setDefinitions: {},
      social: { party: { members: [{ username: 'me' }], henchmen: [] } },
    } as unknown as ServerStateMessage;
  }

  function open(state: ServerStateMessage) {
    document.body.innerHTML = '';
    const m = mockClient();
    m.setLast(state);
    const here = { id: 'tile-agent', name: 'Estate Agent', zoneName: 'Hatchetmill' };
    const popup = new ShopPopup(m.client, {
      getSkillContent: () => ({ skills: {} }),
      getTileOn: () => here,
    } as unknown as WorldCache);
    popup.show(state);
    return m;
  }

  it('opens on Houses when the shop sells nothing else, with art, tier, facts and price', () => {
    open(shopState());
    expect($('.shop-toggle-btn[data-mode="houses"]')?.getAttribute('aria-selected')).toBe('true');
    const card = $('.shop-house')!;
    expect(card.querySelector('.house-art__img')?.getAttribute('src')).toBe('/house-artwork/cottage.png');
    expect(card.querySelector('.house-art__emoji')?.textContent).toBe('🏠');
    expect(card.querySelector('.shop-house__tier')?.textContent).toBe('Tier 1');
    expect(card.textContent).toContain('Storage');
    expect(card.textContent).toContain('Shelves');
    expect(card.querySelector('.shop-house__price')?.textContent).toContain('500');
  });

  it('opens on Buy when the shop also sells items, with a Houses tab alongside', () => {
    open(shopState({ inventory: [{ itemId: 'potion', price: 5 }] }));
    expect($('.shop-toggle-btn[data-mode="buy"]')?.getAttribute('aria-selected')).toBe('true');
    expect($('.shop-toggle-btn[data-mode="houses"]')).not.toBeNull();
  });

  it('confirms and buys an affordable house', () => {
    const m = open(shopState());
    $<HTMLButtonElement>('.shop-house-buy')!.click();
    expect($('.shop-house-confirm__text')?.textContent).toBe('Buy Cottage for 500 gold?');
    expect($('.shop-house-confirm__sub')?.textContent).toContain('stand here in Hatchetmill · Estate Agent');
    $<HTMLButtonElement>('.shop-house-confirm-btn')!.click();
    expect(m.sends.sendBuyHouse).toHaveBeenCalledWith('cottage');
  });

  it('disables Buy with the reason when you cannot afford it', () => {
    open(shopState({ gold: 120 }));
    expect($<HTMLButtonElement>('.shop-house-buy')!.disabled).toBe(true);
    expect($('.shop-house-why')?.textContent).toBe('You need 380 more gold.');
  });

  it('marks your own house and blocks buying while you own one', () => {
    const offers = [COTTAGE_OFFER, { ...COTTAGE_OFFER, houseId: 'manor', name: 'Manor', tier: 5, price: 900 }];
    open({ ...shopState({ owns: true }), houseOffers: offers } as ServerStateMessage);
    expect($('.shop-house[data-house-id="cottage"] .shop-house-owned')?.textContent).toBe('Your home');
    const manorBuy = $<HTMLButtonElement>('.shop-house[data-house-id="manor"] .shop-house-buy')!;
    expect(manorBuy.disabled).toBe(true);
    expect($('.shop-house[data-house-id="manor"] .shop-house-why')?.textContent).toContain('already own your Cottage');
  });

  it('only marks a house as yours at the estate agent where it stands', () => {
    const owns = shopState({ owns: true });
    const location = { tileId: 'tile-elsewhere', mapId: 'm', col: 9, row: 9, roomName: 'Harbour Lets', zoneName: 'Saltmere' };
    open({ ...owns, house: { ...owns.house!, location } } as ServerStateMessage);
    expect($('.shop-house-owned')).toBeNull();
    expect($('.shop-house-why')?.textContent).toBe('You already own your Cottage in Saltmere · Harbour Lets. Sell it before buying another.');
  });

  it('shows a refusal from the server after buying', () => {
    const m = open(shopState());
    $<HTMLButtonElement>('.shop-house-buy')!.click();
    $<HTMLButtonElement>('.shop-house-confirm-btn')!.click();
    m.serverError('You must be at an estate agent.', 'house_not_for_sale');
    expect($('.shop-modal__notice')?.textContent).toBe('You must be at an estate agent.');
  });
});

// ── Home view ────────────────────────────────────────────────

interface HomeParts {
  me?: string;
  owner?: string;
  occupants?: HomeOccupant[];
  displays?: (string | null)[];
  storage?: Record<string, number>;
  inventory?: Record<string, number>;
  wellRestedUntil?: number;
  friends?: string[];
  members?: string[];
  location?: HomeLocation;
}

function homeState(p: HomeParts = {}): ServerStateMessage {
  const me = p.me ?? 'alice';
  const owner = p.owner ?? 'alice';
  const isOwner = me === owner;
  const displays = p.displays ?? [null, 'crown', null];
  const storage = p.storage ?? { gem: 2 };
  return {
    username: me,
    character: { gold: 100, inventory: p.inventory ?? { ore: 5, potion: 1 }, equipment: {}, className: 'Knight' },
    itemDefinitions: {
      ore: { id: 'ore', name: 'Iron Ore', rarity: 'common' },
      potion: { id: 'potion', name: 'Potion', rarity: 'common' },
    },
    house: isOwner ? { house: { houseId: 'cottage', purchasedAt: 0, storage, displays }, definition: COTTAGE } : undefined,
    wellRestedUntil: p.wellRestedUntil,
    homeVisit: {
      owner,
      definition: COTTAGE,
      location: p.location,
      displays,
      storage: isOwner ? storage : undefined,
      occupants: p.occupants ?? [{ username: me, className: 'Knight', level: 5, sitting: false }],
      itemDefinitions: {
        crown: { id: 'crown', name: '<b>Crown</b>', rarity: 'epic' },
        gem: { id: 'gem', name: 'Gem', rarity: 'rare' },
      },
    },
    social: {
      friends: p.friends ?? ['bob'],
      onlinePlayers: ['bob'],
      party: { members: (p.members ?? [me]).map(username => ({ username })) },
    },
  } as unknown as ServerStateMessage;
}

function openHome(parts: HomeParts = {}) {
  document.body.innerHTML = '<div id="screen-container"></div>';
  const m = mockClient();
  const view = new HomeView(document.getElementById('screen-container')!, m.client);
  m.push(homeState(parts));
  return { ...m, view, update: (p: HomeParts) => m.push(homeState(p)) };
}

describe('HomeView', () => {
  it('stays hidden until the state carries a home visit', () => {
    document.body.innerHTML = '<div id="screen-container"></div>';
    const m = mockClient();
    const view = new HomeView(document.getElementById('screen-container')!, m.client);
    m.push({ username: 'alice' } as ServerStateMessage);
    expect(view.isOpen()).toBe(false);
    m.push(homeState());
    expect(view.isOpen()).toBe(true);
    m.push({ username: 'alice' } as ServerStateMessage);
    expect(view.isOpen()).toBe(false);
  });

  it('gives the owner the chest and owner controls, with the interior backdrop', () => {
    openHome();
    expect($('.home-place__name')?.textContent).toBe('Your Cottage');
    expect($('.home-place__badge')?.textContent).toBe('Home');
    expect($('.home-chest')).not.toBeNull();
    expect($('.home-chest__count')?.textContent).toBe('1/2');
    expect($('[data-home-action="invite"]')).not.toBeNull();
    expect($('[data-home-action="manage"]')).not.toBeNull();
    expect($<HTMLElement>('.home-place__bg')!.style.backgroundImage).toContain('/house-interior-artwork/cottage.png');
  });

  it('shows visitors the shelves and fire but no chest or owner controls', () => {
    openHome({
      me: 'bob',
      owner: 'alice',
      occupants: [{ username: 'alice', sitting: true }, { username: 'bob', sitting: false }],
    });
    expect($('.home-place__name')?.textContent).toBe("alice's Cottage");
    expect($('.home-place__badge')?.textContent).toBe('Visiting');
    expect($('.home-chest')).toBeNull();
    expect($('[data-home-action="invite"]')).toBeNull();
    expect($('[data-home-action="manage"]')).toBeNull();
    expect($('[data-home-action="leave"]')).not.toBeNull();
    expect($$('.home-shelf__slot')).toHaveLength(3);
    expect($$('button.home-shelf__slot')).toHaveLength(0);
  });

  it('escapes item names from content', () => {
    openHome();
    const slot = $('.home-shelf__slot[data-slot="1"]')!;
    expect(slot.getAttribute('aria-label')).toBe('<b>Crown</b> on shelf 2');
    expect(slot.querySelector('b')).toBeNull();
  });

  it('seats sitting occupants around the fire and lists the rest', () => {
    openHome({
      occupants: [
        { username: 'alice', sitting: false },
        { username: 'bob', sitting: true },
      ],
    });
    expect($$('.home-seat .home-occupant').map(e => e.dataset.username)).toEqual(['bob']);
    expect($$('.home-gathered .home-occupant').map(e => e.dataset.username)).toEqual(['alice']);
  });

  it('swaps the campfire button between Sit and Stand with your seat', () => {
    const h = openHome();
    const sit = $<HTMLButtonElement>('.home-sit-btn')!;
    expect(sit.textContent).toBe('Sit by the fire');
    expect(sit.classList.contains('gc-btn--gold')).toBe(true);
    sit.click();
    expect(h.sends.sendCampfireSit).toHaveBeenCalledTimes(1);
    expect($('.home-hint')?.textContent).toBe(RESTED_HINT);
    expect(RESTED_HINT).toBe('Each minute by the fire earns 12 minutes of Well Rested — +10% XP and gold');

    h.update({ occupants: [{ username: 'alice', sitting: true }] });
    const stand = $<HTMLButtonElement>('.home-sit-btn')!;
    expect(stand.textContent).toBe('Stand up');
    expect(stand.classList.contains('gc-btn--steel')).toBe(true);
    stand.click();
    expect(h.sends.sendCampfireStand).toHaveBeenCalledTimes(1);
  });

  it('puts a chest item on an empty shelf', () => {
    const h = openHome();
    $<HTMLButtonElement>('button.home-shelf__slot[data-slot="0"]')!.click();
    expect($('.home-sheet .gc-title-tab__text')?.textContent).toBe('Choose a trophy');
    $<HTMLButtonElement>('.home-pick-trophy[data-item-id="gem"]')!.click();
    expect(h.sends.sendHomeDisplay).toHaveBeenCalledWith(0, 'gem');
    expect($<HTMLElement>('.home-sheet')!.style.display).toBe('none');
  });

  it('returns a trophy to the chest, or explains why not when the chest is full', () => {
    const h = openHome();
    $<HTMLButtonElement>('button.home-shelf__slot[data-slot="1"]')!.click();
    $<HTMLButtonElement>('.home-shelf-return')!.click();
    expect(h.sends.sendHomeDisplay).toHaveBeenCalledWith(1, null);

    h.update({ storage: { gem: 2, ore: 1 } });
    $<HTMLButtonElement>('button.home-shelf__slot[data-slot="1"]')!.click();
    expect($<HTMLButtonElement>('.home-shelf-return')!.disabled).toBe(true);
    expect($('.home-sheet .gc-modal__why')?.textContent).toContain('chest is full');
  });

  it('deposits a chosen amount from the bag with the stepper', () => {
    const h = openHome({ inventory: { ore: 5, potion: 1 } });
    $<HTMLButtonElement>('[data-home-action="deposit"]')!.click();
    expect($$('.home-pick-deposit').map(e => e.dataset.itemId)).toEqual(['ore', 'potion']);
    $<HTMLButtonElement>('.home-pick-deposit[data-item-id="ore"]')!.click();
    $<HTMLButtonElement>('.home-qty-plus')!.click();
    $<HTMLButtonElement>('.home-qty-plus')!.click();
    expect($('.home-qty-value')?.textContent).toBe('3');
    $<HTMLButtonElement>('.home-deposit-confirm')!.click();
    expect(h.sends.sendHomeStore).toHaveBeenCalledWith('ore', 3);
  });

  it('blocks depositing a new kind of item into a full chest', () => {
    openHome({ storage: { gem: 2, crown: 1 }, displays: [null, null, null] });
    $<HTMLButtonElement>('[data-home-action="deposit"]')!.click();
    $<HTMLButtonElement>('.home-pick-deposit[data-item-id="ore"]')!.click();
    expect($<HTMLButtonElement>('.home-deposit-confirm')!.disabled).toBe(true);
  });

  it('withdraws from the chest', () => {
    const h = openHome();
    $<HTMLButtonElement>('.home-chest__item[data-item-id="gem"]')!.click();
    $<HTMLButtonElement>('.home-qty-all')!.click();
    $<HTMLButtonElement>('.home-chest-take')!.click();
    expect(h.sends.sendHomeWithdraw).toHaveBeenCalledWith('gem', 2);
  });

  it('disables selling while the chest or shelves hold items', () => {
    openHome();
    $<HTMLButtonElement>('[data-home-action="manage"]')!.click();
    expect($<HTMLButtonElement>('.home-sell-btn')!.disabled).toBe(true);
    expect($('.home-sell-why')?.textContent).toContain('Empty your chest and trophy shelves');
  });

  it('sells an empty home after confirming the refund', () => {
    const h = openHome({ storage: {}, displays: [null, null, null] });
    $<HTMLButtonElement>('[data-home-action="manage"]')!.click();
    expect($('.home-manage__refund')?.textContent).toContain(String(houseSellPrice(COTTAGE)));
    $<HTMLButtonElement>('.home-sell-btn')!.click();
    expect($('.home-sell-question')?.textContent).toBe('Sell Cottage for 250 gold?');
    $<HTMLButtonElement>('.home-sell-confirm')!.click();
    expect(h.sends.sendSellHouse).toHaveBeenCalledTimes(1);
  });

  it('invites friends and party members who are not already inside', () => {
    const h = openHome({ friends: ['bob', 'cara'], members: ['alice', 'dan'], occupants: [{ username: 'alice', sitting: false }, { username: 'cara', sitting: false }] });
    $<HTMLButtonElement>('[data-home-action="invite"]')!.click();
    expect($$('.home-invite-row').map(e => e.dataset.username)).toEqual(['bob', 'dan']);
    $<HTMLButtonElement>('.home-invite-send[data-username="dan"]')!.click();
    expect(h.sends.sendHomeInvite).toHaveBeenCalledWith('dan');
    const sent = $<HTMLButtonElement>('.home-invite-send[data-username="dan"]')!;
    expect(sent.disabled).toBe(true);
    expect(sent.textContent).toBe('Invited');
  });

  it('leaves at once and stays closed while the server catches up', () => {
    const h = openHome();
    $<HTMLButtonElement>('.home-leave-btn')!.click();
    expect(h.sends.sendLeaveHome).toHaveBeenCalledTimes(1);
    expect(h.view.isOpen()).toBe(false);
    h.update({});
    expect(h.view.isOpen()).toBe(false);
  });

  it('shows a refused entry as a toast', () => {
    document.body.innerHTML = '<div id="screen-container"></div>';
    const m = mockClient();
    const view = new HomeView(document.getElementById('screen-container')!, m.client);
    view.requestEnter('zed');
    expect(m.sends.sendEnterHome).toHaveBeenCalledWith('zed');
    m.serverError("You aren't invited to zed's home.", 'home_access_denied');
    expect($('.home-toast')?.textContent).toBe("You aren't invited to zed's home.");
  });

  it('offers to travel to a home that is too far away, then heads there', () => {
    document.body.innerHTML = '<div id="screen-container"></div>';
    const m = mockClient();
    const view = new HomeView(document.getElementById('screen-container')!, m.client);
    const onTravel = vi.fn();
    view.setOnTravel(onTravel);
    view.requestEnter('zed');
    m.serverError("zed's Cottage is in Hatchetmill · Estate Agent. Travel there to go inside.", 'home_too_far');
    expect($('.home-toast')?.textContent).toContain('Hatchetmill · Estate Agent');
    $<HTMLButtonElement>('.home-toast__action')!.click();
    expect(m.sends.sendTravelHome).toHaveBeenCalledWith('zed');
    expect(onTravel).toHaveBeenCalledTimes(1);
    expect($('.home-toast')).toBeNull();
  });

  it('shows where the home stands', () => {
    const h = openHome();
    h.update({ location: { tileId: 't', mapId: 'm', col: 0, row: 0, roomName: 'Estate Agent', zoneName: 'Hatchetmill' } });
    expect($('.home-place__where')?.textContent).toBe('in Hatchetmill · Estate Agent');
  });

  it('ignores server errors nobody asked about', () => {
    const h = openHome();
    h.serverError('Something unrelated.');
    expect($('.home-place__notice')).toBeNull();
    expect($('.home-toast')).toBeNull();
  });
});

// ── HUD Home button ──────────────────────────────────────────

describe('TopHud Home button', () => {
  it('only shows once you own a house and opens your home', () => {
    document.body.innerHTML = '<header id="top-hud"></header>';
    const m = mockClient();
    const worldCache = { getTileOn: () => undefined } as unknown as WorldCache;
    const onHome = vi.fn();
    new TopHud(m.client, worldCache, () => {}, onHome);
    const base = { username: 'alice', party: { col: 0, row: 0 }, currentMapId: 'm', character: { gold: 0 } };
    m.push(base as unknown as ServerStateMessage);
    const btn = $<HTMLButtonElement>('.hud-home')!;
    expect(btn.hidden).toBe(true);

    m.push({ ...base, house: { house: { houseId: 'cottage' }, definition: COTTAGE } } as unknown as ServerStateMessage);
    expect(btn.hidden).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Travel home');
    btn.click();
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});

// ── Well Rested chip ─────────────────────────────────────────

describe('WellRestedChip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats the time left', () => {
    expect(formatRestedRemaining(30_000)).toBe('<1m');
    expect(formatRestedRemaining(45 * 60_000)).toBe('45m');
    expect(formatRestedRemaining(125 * 60_000)).toBe('2h 05m');
  });

  it('shows while Well Rested, counts down, and hides when it runs out', () => {
    document.body.innerHTML = '<div id="persistent-xp-bar"></div>';
    const m = mockClient();
    new WellRestedChip(m.client, document.getElementById('persistent-xp-bar')!);
    const chip = $<HTMLButtonElement>('.rested-chip')!;
    m.push({ wellRestedUntil: undefined } as ServerStateMessage);
    expect(chip.hidden).toBe(true);

    m.push({ wellRestedUntil: Date.now() + 90 * 60_000 } as ServerStateMessage);
    expect(chip.hidden).toBe(false);
    expect($('.rested-chip__time')?.textContent).toBe('1h 30m');
    expect(chip.getAttribute('aria-label')).toContain('+10% XP and gold');

    vi.advanceTimersByTime(60_000);
    expect($('.rested-chip__time')?.textContent).toBe('1h 29m');

    vi.advanceTimersByTime(90 * 60_000);
    expect(chip.hidden).toBe(true);
  });
});

// ── Visit Home + invite notifications ────────────────────────

describe('Visit Home', () => {
  it('sends enter_home for the player from their card', () => {
    sessionStorage.clear();
    document.body.innerHTML = '<div id="social"></div>';
    const sendEnterHome = vi.fn();
    const state = {
      username: 'alice',
      currentMapId: 'main',
      party: { col: 1, row: 1 },
      character: { className: 'Knight', level: 5, inventory: {} },
      otherPlayers: [],
      social: {
        party: { id: 'p1', members: [{ username: 'alice', role: 'owner', gridPosition: 4 } as GamePartyMember], henchmen: [] },
        onlinePlayers: ['alice', 'bob'],
        allPlayers: [{ username: 'bob', level: 3, hasHouse: true }],
        friends: ['bob'],
      } as unknown as ClientSocialState,
    } as unknown as ServerStateMessage;
    const gameClient = {
      lastState: state,
      subscribe: () => () => {},
      onResume: () => () => {},
      onServerError: () => () => {},
      onChat: () => () => {},
      onSyncChat: () => () => {},
      sendSyncChat: () => {},
      sendEnterHome,
    } as unknown as GameClient;
    const chatStore = { getLatestId: () => null, addMessage: () => {}, mergeSyncBatch: () => {} } as unknown as ChatLocalStore;
    const worldCache = { getSkillContent: () => ({ skills: {} }), getZoneName: (z: string) => z } as unknown as WorldCache;
    const screen = new SocialScreen('social', gameClient, chatStore, worldCache);
    screen.onActivate();
    screen.showUserPopup('bob', document.body);
    $<HTMLButtonElement>('[data-popup-action="visit_home"]')!.click();
    (state.social as unknown as { allPlayers: { username: string; hasHouse?: boolean }[] }).allPlayers[0].hasHouse = false;
    document.querySelectorAll('.soc-modal').forEach(el => el.remove());
    screen.showUserPopup('bob', document.body);
    expect($('[data-popup-action="visit_home"]')).toBeNull();
    expect(sendEnterHome).toHaveBeenCalledWith('bob');
  });

  it('routes a home invite notification to that home', () => {
    expect(resolveClientNavigation({ category: 'friend', eventKey: 'home_invite', payload: { owner: 'bob' } }))
      .toEqual({ kind: 'home', owner: 'bob' });
    expect(resolveClientNavigation({ category: 'system', eventKey: 'home_invite', payload: {} }))
      .toEqual({ kind: 'none' });
    expect(resolveClientNavigation({ category: 'dm', eventKey: 'dm_received', payload: { fromUsername: 'bob' } }))
      .toEqual({ kind: 'dm_reply', username: 'bob' });
  });
});
