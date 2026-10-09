import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemDefinition, ServerWelcomeBackMessage } from '@idle-party-rpg/shared';

const play = vi.fn();
vi.mock('../src/audio/SoundManager', () => ({ sound: { play: (...args: unknown[]) => play(...args) } }));

const { WelcomeBackModal, MAX_VISIBLE_LOOT, formatAway } = await import('../src/ui/WelcomeBackModal');

function item(id: string, name: string, rarity: ItemDefinition['rarity'] = 'common'): ItemDefinition {
  return { id, name, rarity } as ItemDefinition;
}

function message(overrides: Partial<ServerWelcomeBackMessage> = {}): ServerWelcomeBackMessage {
  return {
    type: 'welcome_back',
    awayMs: (3 * 60 + 12) * 60 * 1000,
    level: 7,
    levelsGained: 2,
    xpGained: 4200,
    goldGained: 315,
    battlesWon: 41,
    battlesFought: 44,
    items: [{ itemId: 'pelt', count: 5 }, { itemId: 'ruby', count: 1 }],
    itemDefinitions: { pelt: item('pelt', 'Wolf Pelt'), ruby: item('ruby', 'Ruby', 'rare') },
    ...overrides,
  };
}

function setReducedMotion(reduce: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function overlay(): HTMLElement {
  return document.querySelector('.wb-modal') as HTMLElement;
}

function statText(kind: string): string {
  return overlay().querySelector(`.wb-stat--${kind} .wb-stat__num`)!.textContent ?? '';
}

describe('WelcomeBackModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    play.mockClear();
    setReducedMotion(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the time away, stats and loot from the message', () => {
    const modal = new WelcomeBackModal();
    modal.show(message());

    expect(overlay().style.display).toBe('flex');
    expect(overlay().querySelector('.gc-title-tab__text')!.textContent).toBe('Welcome Back!');
    expect(overlay().querySelector('.wb-modal__lead')!.textContent).toContain('3h 12m');
    expect(statText('levels')).toBe('+2');
    expect(statText('xp')).toBe('+4,200');
    expect(statText('gold')).toBe('+315');
    expect(overlay().querySelector('.wb-stat--gold .gc-coin')).not.toBeNull();
    expect(statText('wins')).toBe('41');

    const frames = overlay().querySelectorAll('.wb-loot .gc-item');
    expect(frames).toHaveLength(2);
    expect(frames[0].getAttribute('data-rarity')).toBe('rare');
    expect(frames[1].querySelector('.gc-item__count')!.textContent).toBe('5');
    expect(overlay().querySelector('.gc-modal__actions .gc-btn--gold.gc-btn--lg')!.textContent).toBe('Collect');
  });

  it('hides the level tile and loot section when there is nothing to show', () => {
    new WelcomeBackModal().show(message({ levelsGained: 0, items: [], itemDefinitions: {} }));
    expect(overlay().querySelector('.wb-stat--levels')).toBeNull();
    expect(overlay().querySelector('.wb-loot')).toBeNull();
  });

  it('caps visible loot and summarizes the rest', () => {
    const items = Array.from({ length: MAX_VISIBLE_LOOT + 3 }, (_, i) => ({ itemId: `i${i}`, count: 1 }));
    const defs = Object.fromEntries(items.map(({ itemId }) => [itemId, item(itemId, `Item ${itemId}`)]));
    new WelcomeBackModal().show(message({ items, itemDefinitions: defs }));

    expect(overlay().querySelectorAll('.wb-loot .gc-item')).toHaveLength(MAX_VISIBLE_LOOT);
    expect(overlay().querySelector('.wb-loot__more')!.textContent).toBe('+3 more');
  });

  it('escapes item names', () => {
    new WelcomeBackModal().show(message({
      items: [{ itemId: 'bad', count: 2 }],
      itemDefinitions: { bad: item('bad', '<img src=x onerror="alert(1)">') },
    }));
    expect(overlay().querySelector('.wb-loot img[onerror="alert(1)"]')).toBeNull();
    expect(overlay().querySelector('.wb-loot__name')!.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it('counts numbers up from zero when motion is allowed', () => {
    setReducedMotion(false);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    new WelcomeBackModal().show(message());
    expect(statText('gold')).toBe('+0');
    expect(frames.length).toBeGreaterThan(0);

    frames.shift()!(performance.now() + 10_000);
    expect(statText('gold')).toBe('+315');
    vi.unstubAllGlobals();
  });

  it('skips the count-up under reduced motion', () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    new WelcomeBackModal().show(message());
    expect(statText('xp')).toBe('+4,200');
    expect(raf).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Collect plays the reward sound and closes', () => {
    const modal = new WelcomeBackModal();
    modal.show(message());
    (overlay().querySelector('.wb-modal__collect') as HTMLButtonElement).click();

    expect(play).toHaveBeenCalledWith('level-up');
    expect(modal.isOpen).toBe(false);
    expect(overlay().innerHTML).toBe('');
  });

  it('Collect waits for the flourish before closing when motion is allowed', () => {
    setReducedMotion(false);
    vi.useFakeTimers();
    const modal = new WelcomeBackModal();
    modal.show(message({ levelsGained: 0, items: [], itemDefinitions: {} }));
    (overlay().querySelector('.wb-modal__collect') as HTMLButtonElement).click();

    expect(play).toHaveBeenCalledWith('coin');
    expect(overlay().classList.contains('is-collecting')).toBe(true);
    vi.runAllTimers();
    expect(modal.isOpen).toBe(false);
  });

  it('Escape and backdrop clicks close it', () => {
    const modal = new WelcomeBackModal();
    modal.show(message());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.isOpen).toBe(false);

    modal.show(message());
    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.isOpen).toBe(false);
  });
});

describe('formatAway', () => {
  it('formats minutes, hours and days', () => {
    expect(formatAway(42 * 60_000)).toBe('42m');
    expect(formatAway((3 * 60 + 12) * 60_000)).toBe('3h 12m');
    expect(formatAway(2 * 60 * 60_000)).toBe('2h');
    expect(formatAway((2 * 24 + 5) * 60 * 60_000)).toBe('2d 5h');
  });
});
