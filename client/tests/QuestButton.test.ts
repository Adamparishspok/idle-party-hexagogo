import { beforeEach, describe, expect, it } from 'vitest';
import type { QuestProgressEntry, ServerStateMessage } from '@idle-party-rpg/shared';
import { BottomNav, questBadgeFor } from '../src/ui/BottomNav';
import { QuestLog } from '../src/ui/QuestLog';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { tapSoundFor } from '../src/audio/SoundEvents';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;

function quest(questId: string, status: QuestProgressEntry['status']): QuestProgressEntry {
  return { questId, status, progress: [0], acceptedAt: '2026-01-01T00:00:00.000Z' };
}

function makeState(activeQuests: QuestProgressEntry[]): ServerStateMessage {
  return {
    battle: { visual: 'none' },
    party: { path: [] },
    activeQuests,
    completedQuests: [],
    weeklyCompletions: {},
    questDefinitions: {},
    questResolutions: { monsters: {}, items: {}, tiles: {} },
    unlocked: [],
  } as unknown as ServerStateMessage;
}

function setup() {
  document.body.innerHTML = '<div id="bottom-nav"></div><div id="settings"></div>';
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = makeState([]);
  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
  } as unknown as GameClient;
  const worldCache = { getAllNpcs: () => [], getRoomsWithNpc: () => [] } as unknown as WorldCache;

  const questLog = new QuestLog(gameClient, worldCache);
  new BottomNav(
    [
      { id: 'combat', label: 'Combat', icon: '' },
      { id: 'quests', label: 'Quests', icon: '', mode: 'action', placement: 'perch' },
      { id: 'chat', label: 'Chat', icon: '', mode: 'overlay', placement: 'perch' },
    ],
    'combat',
    () => {},
    gameClient,
    undefined,
    undefined,
    (tabId) => { if (tabId === 'quests') questLog.open(); },
  );

  const push = (activeQuests: QuestProgressEntry[]) => {
    lastState = makeState(activeQuests);
    for (const l of listeners) l(lastState);
  };
  const button = () => document.querySelector('.nav-tab[data-screen="quests"]') as HTMLButtonElement;
  const badge = () => button().querySelector('.nav-badge') as HTMLElement;
  return { gameClient, worldCache, questLog, push, button, badge };
}

describe('questBadgeFor', () => {
  it('shows ! when any quest is ready, a count otherwise, and nothing with no quests', () => {
    expect(questBadgeFor([quest('a', 'in_progress'), quest('b', 'ready')])).toEqual({ kind: 'ready' });
    expect(questBadgeFor([quest('a', 'in_progress'), quest('b', 'accepted')])).toEqual({ kind: 'count', count: 2 });
    expect(questBadgeFor([])).toBeNull();
    expect(questBadgeFor()).toBeNull();
  });
});

describe('perched Quests button', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('sits on the perch before Chat', () => {
    setup();
    const perched = [...document.querySelectorAll<HTMLElement>('.nav-perch .nav-tab')].map(el => el.dataset.screen);
    expect(perched).toEqual(['quests', 'chat']);
  });

  it('badges a ready quest with a gold !', () => {
    const t = setup();
    t.push([quest('a', 'in_progress'), quest('b', 'ready')]);
    expect(t.badge().classList.contains('visible')).toBe(true);
    expect(t.badge().classList.contains('nav-badge--ready')).toBe(true);
    expect(t.badge().textContent).toBe('!');
    expect(t.button().getAttribute('aria-label')).toBe('Quests, ready to turn in');
  });

  it('badges the active quest count when none are ready', () => {
    const t = setup();
    t.push([quest('a', 'in_progress'), quest('b', 'accepted'), quest('c', 'in_progress')]);
    expect(t.badge().classList.contains('nav-badge--count')).toBe(true);
    expect(t.badge().classList.contains('nav-badge--ready')).toBe(false);
    expect(t.badge().textContent).toBe('3');
    expect(t.button().getAttribute('aria-label')).toBe('Quests, 3 active');
  });

  it('hides the badge with no active quests', () => {
    const t = setup();
    t.push([quest('a', 'ready')]);
    t.push([]);
    expect(t.badge().classList.contains('visible')).toBe(false);
    expect(t.badge().textContent).toBe('');
    expect(t.button().getAttribute('aria-label')).toBe('Quests');
  });

  it('opens a single Quest Log shared with Settings', () => {
    const t = setup();
    const settings = new SettingsScreen('settings', t.gameClient, t.worldCache, () => {}, t.questLog);

    t.button().click();
    t.button().click();
    (document.querySelector('#btn-quest-log') as HTMLButtonElement).click();
    expect(document.querySelectorAll('.quest-log-modal')).toHaveLength(1);

    settings.onDeactivate();
    expect(document.querySelector('.quest-log-modal')).toBeNull();
    t.button().click();
    expect(document.querySelectorAll('.quest-log-modal')).toHaveLength(1);
  });

  it('leaves the tap sound to the Quest Log opening', () => {
    const t = setup();
    expect(tapSoundFor(t.button())).toBe('none');
  });
});
