import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientSocialState, GamePartyMember, HiredHenchman, ServerStateMessage } from '@idle-party-rpg/shared';
import { SocialScreen } from '../src/screens/SocialScreen';
import type { GameClient } from '../src/network/GameClient';
import type { ChatLocalStore } from '../src/network/ChatLocalStore';
import type { WorldCache } from '../src/network/WorldCache';

function hench(overrides: Partial<HiredHenchman> = {}): HiredHenchman {
  return {
    instanceId: 'h1',
    henchmanId: 'mercenary',
    gridPosition: 2,
    mapId: 'main',
    name: 'Mercenary',
    emoji: '🪓',
    artworkUrl: '/henchman-artwork/mercenary.png',
    level: 4,
    ...overrides,
  } as HiredHenchman;
}

function makeState(opts: {
  members?: GamePartyMember[];
  henchmen?: HiredHenchman[];
  otherPlayers?: Array<{ username: string; col: number; row: number; mapId?: string }>;
}): ServerStateMessage {
  const members = opts.members ?? [{ username: 'alice', role: 'owner', gridPosition: 4 } as GamePartyMember];
  return {
    username: 'alice',
    currentMapId: 'main',
    party: { col: 1, row: 1 },
    character: { className: 'Knight', level: 5, inventory: {} },
    otherPlayers: (opts.otherPlayers ?? []).map(p => ({ zone: 'z', ...p })),
    social: {
      party: { id: 'p1', members, henchmen: opts.henchmen ?? [] },
      onlinePlayers: ['alice'],
      allPlayers: [],
      friends: [],
    } as unknown as ClientSocialState,
  } as unknown as ServerStateMessage;
}

function setup(state: ServerStateMessage) {
  sessionStorage.setItem('socialSubTab', 'party');
  document.body.innerHTML = '<div id="social"></div>';
  const gameClient = {
    lastState: state,
    subscribe: () => () => {},
    onResume: () => () => {},
    onServerError: () => () => {},
    onChat: () => () => {},
    onSyncChat: () => () => {},
    sendSyncChat: () => {},
    sendDismissHenchman: vi.fn(),
    sendSetPartyGridPosition: vi.fn(),
  } as unknown as GameClient;
  const chatStore = { getLatestId: () => null, addMessage: () => {}, mergeSyncBatch: () => {} } as unknown as ChatLocalStore;
  const worldCache = { getSkillContent: () => ({ skills: {} }), getZoneName: (z: string) => z } as unknown as WorldCache;
  const screen = new SocialScreen('social', gameClient, chatStore, worldCache);
  screen.onActivate();
  return { screen, gameClient: gameClient as unknown as { sendDismissHenchman: ReturnType<typeof vi.fn>; sendSetPartyGridPosition: ReturnType<typeof vi.fn> } };
}

const cell = (pos: number) => document.querySelector<HTMLButtonElement>(`.soc-cell[data-pos="${pos}"]`)!;

describe('SocialScreen henchmen', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('seats a henchman in the formation with its photo over an emoji fallback', () => {
    setup(makeState({ henchmen: [hench()] }));
    const c = cell(2);
    expect(c.classList.contains('is-henchman')).toBe(true);
    expect(c.getAttribute('data-henchman-instance')).toBe('h1');
    expect(c.querySelector('.gc-portrait__img')?.getAttribute('src')).toBe('/henchman-artwork/mercenary.png');
    expect(c.querySelector('.gc-portrait__initial')?.textContent).toBe('🪓');
    expect(c.textContent).toContain('Mercenary');
  });

  it('never makes a henchman reachable by player-only flows', () => {
    setup(makeState({ henchmen: [hench()] }));
    for (const el of document.querySelectorAll('[data-henchman-instance]')) {
      expect(el.closest('[data-username]')).toBeNull();
      expect(el.querySelector('.soc-user-btn')).toBeNull();
    }
  });

  it('names duplicate hires the way combat does', () => {
    setup(makeState({ henchmen: [hench(), hench({ instanceId: 'h2', gridPosition: 5 })] }));
    const names = [...document.querySelectorAll('.soc-row--hench .gc-row__title')].map(e => e.textContent);
    expect(names).toEqual(['Mercenary', 'Mercenary #2']);
  });

  it('counts henchmen as party seats and drops the solo empty state', () => {
    setup(makeState({ henchmen: [hench()] }));
    expect(document.body.textContent).not.toContain("You're adventuring solo");
    expect(document.querySelector('.soc-section__count')?.textContent).toBe('2/5');
  });

  it('lets the owner dismiss a henchman', () => {
    const { gameClient } = setup(makeState({ henchmen: [hench()] }));
    document.querySelector<HTMLButtonElement>('[data-action="dismiss-henchman"]')!.click();
    expect(gameClient.sendDismissHenchman).toHaveBeenCalledWith('h1');
  });

  it('hides dismiss and moving from plain members', () => {
    setup(makeState({
      members: [
        { username: 'bob', role: 'owner', gridPosition: 1 } as GamePartyMember,
        { username: 'alice', role: 'member', gridPosition: 4 } as GamePartyMember,
      ],
      henchmen: [hench()],
    }));
    expect(document.querySelector('[data-action="dismiss-henchman"]')).toBeNull();
    expect(cell(2).classList.contains('is-movable')).toBe(false);
  });

  it('picks a henchman up and places it on an empty spot', () => {
    const { gameClient } = setup(makeState({ henchmen: [hench()] }));
    cell(2).click();
    expect(cell(2).classList.contains('is-picked')).toBe(true);
    expect(cell(2).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.soc-formation__hint')?.textContent).toContain('Mercenary');

    cell(8).click();
    expect(gameClient.sendSetPartyGridPosition).toHaveBeenCalledWith(8, 'h1');
  });

  it('moves the player when nothing is picked up', () => {
    const { gameClient } = setup(makeState({ henchmen: [hench()] }));
    cell(8).click();
    expect(gameClient.sendSetPartyGridPosition).toHaveBeenCalledWith(8, undefined);
  });

  it('blocks party invites when henchmen fill the seats, and says why', () => {
    const { screen } = setup(makeState({
      members: [
        { username: 'alice', role: 'owner', gridPosition: 4 } as GamePartyMember,
        { username: 'bob', role: 'member', gridPosition: 1 } as GamePartyMember,
      ],
      henchmen: [hench(), hench({ instanceId: 'h2', henchmanId: 'archer', name: 'Archer', gridPosition: 5 }), hench({ instanceId: 'h3', henchmanId: 'cleric', name: 'Cleric', gridPosition: 8 })],
      otherPlayers: [{ username: 'carol', col: 1, row: 1, mapId: 'main' }],
    }));
    screen.showUserPopup('carol', document.body);
    const invite = [...document.querySelectorAll<HTMLButtonElement>('.soc-modal--user .gc-btn')].find(b => b.textContent === 'Invite to Party')!;
    expect(invite.disabled).toBe(true);
    expect(document.querySelector('.soc-reasons')?.textContent).toContain('Party is full (5/5) — hired henchmen take a seat too.');
  });

  it('only counts players on this map as in the room', () => {
    const { screen } = setup(makeState({
      otherPlayers: [{ username: 'dave', col: 1, row: 1, mapId: 'other_map' }],
    }));
    screen.showUserPopup('dave', document.body);
    expect(document.querySelector('.soc-reasons')?.textContent).toContain('same room');
  });
});
