import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { rewardSnapshot, rewardSoundFor, tapSoundFor, wireGameSounds } from '../src/audio/SoundEvents';
import type { RewardSnapshot } from '../src/audio/SoundEvents';
import type { GameClient } from '../src/network/GameClient';
import type { SoundManager } from '../src/audio/SoundManager';

const base: RewardSnapshot = { level: 5, gold: 100, items: 3, equipment: 'head=|chest=tunic', craftLevel: 1, craftXp: 10 };

describe('rewardSoundFor', () => {
  it('is silent when nothing rewarding changed', () => {
    expect(rewardSoundFor(base, { ...base })).toBeNull();
  });

  it('picks the biggest reward when several land together', () => {
    expect(rewardSoundFor(base, { ...base, level: 6, gold: 150, items: 4 })).toBe('level-up');
    expect(rewardSoundFor(base, { ...base, gold: 150, items: 4 })).toBe('loot');
    expect(rewardSoundFor(base, { ...base, gold: 150 })).toBe('coin');
  });

  it('hears a finished craft through craft XP, including a craft level rollover', () => {
    expect(rewardSoundFor(base, { ...base, craftXp: 20, items: 4 })).toBe('craft-complete');
    expect(rewardSoundFor(base, { ...base, craftLevel: 2, craftXp: 0 })).toBe('craft-complete');
  });

  it('treats an equipment change as an equip, not a lost item', () => {
    expect(rewardSoundFor(base, { ...base, equipment: 'head=helm|chest=tunic', items: 2 })).toBe('equip');
  });

  it('does not call a purchase loot, nor spending gold a coin', () => {
    expect(rewardSoundFor(base, { ...base, gold: 50, items: 4 })).toBeNull();
    expect(rewardSoundFor(base, { ...base, gold: 50 })).toBeNull();
  });
});

describe('rewardSnapshot', () => {
  it('returns null before a character exists', () => {
    expect(rewardSnapshot({} as ServerStateMessage)).toBeNull();
  });

  it('sums inventory stacks and signs equipment independent of key order', () => {
    const a = rewardSnapshot({ character: { level: 1, gold: 0, inventory: { a: 2, b: 3 }, equipment: { head: 'x', chest: null }, craftLevel: 1, craftXp: 0 } } as unknown as ServerStateMessage)!;
    const b = rewardSnapshot({ character: { level: 1, gold: 0, inventory: { b: 3, a: 2 }, equipment: { chest: null, head: 'x' }, craftLevel: 1, craftXp: 0 } } as unknown as ServerStateMessage)!;
    expect(a.items).toBe(5);
    expect(a.equipment).toBe(b.equipment);
  });
});

describe('wireGameSounds', () => {
  type Listener = (s: ServerStateMessage) => void;
  let stateListener: Listener;
  let chatListener: (m: { senderUsername: string }) => void;
  let client: { isInitialState: boolean; lastState: { username: string } | null };
  let mgr: { play: ReturnType<typeof vi.fn> };

  const state = (gold: number, level = 1) => ({
    username: 'me',
    character: { level, gold, inventory: {}, equipment: {}, craftLevel: 1, craftXp: 0 },
  }) as unknown as ServerStateMessage;

  beforeEach(() => {
    mgr = { play: vi.fn() };
    client = {
      isInitialState: true,
      lastState: { username: 'me' },
    };
    const gc = {
      ...client,
      subscribe: (l: Listener) => { stateListener = l; return () => {}; },
      onChat: (l: typeof chatListener) => { chatListener = l; return () => {}; },
      onNotification: () => () => {},
      onServerError: () => () => {},
      onEquipBlocked: () => () => {},
      onMoveBlocked: () => () => {},
    };
    // Share the mutable flags with the object handed to wireGameSounds.
    client = gc;
    wireGameSounds(gc as unknown as GameClient, mgr as unknown as SoundManager);
  });

  it('never plays for the initial state, a reconnect, or a tab resume', () => {
    stateListener(state(100));
    client.isInitialState = false;
    stateListener(state(150));
    expect(mgr.play).toHaveBeenCalledTimes(1);
    expect(mgr.play.mock.calls[0][0]).toBe('coin');

    // Reconnect: gold went up a lot while offline — no sound, just a rebaseline.
    client.isInitialState = true;
    stateListener(state(900, 3));
    client.isInitialState = false;
    stateListener(state(900, 3));
    expect(mgr.play).toHaveBeenCalledTimes(1);
  });

  it('plays incoming chat but not my own messages', () => {
    chatListener({ senderUsername: 'me' });
    chatListener({ senderUsername: 'friend' });
    expect(mgr.play.mock.calls.map(c => c[0])).toEqual(['chat-message']);
  });
});

describe('tapSoundFor', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  function el(html: string, selector: string): Element {
    document.body.innerHTML = html;
    return document.querySelector(selector)!;
  }

  it('taps for kit buttons, including presses on their inner content', () => {
    expect(tapSoundFor(el('<button class="gc-btn"><span id="in">Go</span></button>', '#in'))).toBe('ui-tap');
    expect(tapSoundFor(el('<div class="gc-tab" id="t">Tab</div>', '#t'))).toBe('ui-tap');
  });

  it('leaves nav tabs and close buttons to their own sounds', () => {
    expect(tapSoundFor(el('<button class="nav-tab" id="n"></button>', '#n'))).toBe('none');
    expect(tapSoundFor(el('<button class="gc-close" id="c"></button>', '#c'))).toBe('none');
  });

  it('is silent for disabled buttons and plain content', () => {
    expect(tapSoundFor(el('<button class="gc-btn" id="b" disabled></button>', '#b'))).toBe('none');
    expect(tapSoundFor(el('<p id="p">text</p>', '#p'))).toBeNull();
  });

  it('honours a data-sfx override', () => {
    expect(tapSoundFor(el('<button class="gc-btn" data-sfx="equip" id="b"></button>', '#b'))).toBe('equip');
    expect(tapSoundFor(el('<button data-sfx="none" id="b"></button>', '#b'))).toBe('none');
  });
});
