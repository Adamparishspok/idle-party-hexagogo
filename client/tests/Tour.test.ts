import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { TOUR_DONE_KEY, TOUR_STEPS, Tour, isNewPlayer, isTourDone, startTourWhenClear } from '../src/ui/Tour';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

function navWith(...ids: string[]): void {
  document.body.innerHTML = `<nav>${ids.map(id => `<button class="nav-tab" data-screen="${id}"></button>`).join('')}</nav>`;
}

const step = () => document.querySelector<HTMLElement>('.tour')?.dataset.step ?? null;
const nextBtn = () => document.querySelector('.tour__next') as HTMLButtonElement;
const count = () => document.querySelector('.tour__count')!.textContent;
const pressKey = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('Tour', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('walks every step whose target is on screen, then remembers it is done', () => {
    navWith('social', 'items', 'map', 'combat', 'quests');
    const tour = new Tour();
    expect(tour.start()).toBe(true);

    const seen: string[] = [];
    while (tour.isRunning) {
      seen.push(step()!);
      nextBtn().click();
    }
    expect(seen).toEqual(TOUR_STEPS.map(s => s.id));
    expect(document.querySelector('.tour')).toBeNull();
    expect(localStorage.getItem(TOUR_DONE_KEY)).toBe('1');
    expect(isTourDone()).toBe(true);
  });

  it('skips steps whose target is missing and counts only the present ones', () => {
    navWith('map', 'social');
    const tour = new Tour();
    tour.start();

    expect(step()).toBe('map');
    expect(count()).toBe('1 of 2');
    expect(nextBtn().textContent).toBe('Next');

    nextBtn().click();
    expect(step()).toBe('social');
    expect(count()).toBe('2 of 2');
    expect(nextBtn().textContent).toBe('Got it');

    nextBtn().click();
    expect(tour.isRunning).toBe(false);
  });

  it('treats a hidden target as missing', () => {
    navWith('map', 'social');
    (document.querySelector('[data-screen="map"]') as HTMLElement).parentElement!.style.display = 'none';
    expect(new Tour().start()).toBe(false);
    expect(document.querySelector('.tour')).toBeNull();
    expect(isTourDone()).toBe(false);
  });

  it('is an accessible dialog with focus on the primary button', () => {
    navWith('map');
    new Tour().start();
    const dialog = document.querySelector('.tour__callout')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)!;
    expect(title.textContent).toBe('The Map');
    expect(document.activeElement).toBe(nextBtn());
  });

  it('Skip tour ends the tour and remembers it', () => {
    navWith('map', 'social');
    const tour = new Tour();
    tour.start();
    (document.querySelector('.tour__skip') as HTMLButtonElement).click();
    expect(tour.isRunning).toBe(false);
    expect(isTourDone()).toBe(true);
  });

  it('Escape skips the tour', () => {
    navWith('map', 'social');
    const tour = new Tour();
    tour.start();
    pressKey('Escape');
    expect(tour.isRunning).toBe(false);
    expect(isTourDone()).toBe(true);
  });

  it('can be replayed after it was completed', () => {
    navWith('map');
    localStorage.setItem(TOUR_DONE_KEY, '1');
    const tour = new Tour();
    expect(tour.start()).toBe(true);
    expect(step()).toBe('map');
  });

  it('reads completion as not done when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(isTourDone()).toBe(false);
    spy.mockRestore();
  });
});

describe('isNewPlayer', () => {
  it('is true only for characters at level 2 or below', () => {
    const at = (level: number) => ({ character: { level } }) as unknown as ServerStateMessage;
    expect(isNewPlayer(at(1))).toBe(true);
    expect(isNewPlayer(at(2))).toBe(true);
    expect(isNewPlayer(at(3))).toBe(false);
    expect(isNewPlayer(null)).toBe(false);
  });
});

describe('startTourWhenClear', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    navWith('map');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits until no modal is showing', () => {
    const modal = document.createElement('div');
    modal.className = 'gc-modal';
    document.body.appendChild(modal);
    const tour = new Tour();
    startTourWhenClear(tour, () => true, { pollMs: 100, settleChecks: 2 });

    vi.advanceTimersByTime(1000);
    expect(tour.isRunning).toBe(false);

    modal.remove();
    vi.advanceTimersByTime(100);
    expect(tour.isRunning).toBe(false);
    vi.advanceTimersByTime(100);
    expect(tour.isRunning).toBe(true);
  });

  it('never starts for players who are not new', () => {
    const tour = new Tour();
    startTourWhenClear(tour, () => false, { pollMs: 100 });
    vi.advanceTimersByTime(1000);
    expect(tour.isRunning).toBe(false);
  });
});

describe('Settings replay tour row', () => {
  it('calls the replay callback', () => {
    document.body.innerHTML = '<div id="settings"></div>';
    const gameClient = { lastState: null, subscribe: () => () => {} } as unknown as GameClient;
    const onReplay = vi.fn();
    new SettingsScreen('settings', gameClient, {} as WorldCache, () => {}, undefined, onReplay);
    const row = document.querySelector('#btn-replay-tour') as HTMLButtonElement;
    expect(row.classList.contains('gc-row')).toBe(true);
    row.click();
    expect(onReplay).toHaveBeenCalledTimes(1);
  });
});
