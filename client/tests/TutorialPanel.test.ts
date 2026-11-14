// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { TutorialPanel, showTutorialAgain, tutorialHiddenKey } from '../src/ui/TutorialPanel';

const step = { id: 's1', order: 1, title: 'T', body: 'B', trigger: { type: 'equipItem' as const } };

function fakeClient(username = 'alice') {
  const listeners: Array<(s: unknown) => void> = [];
  const state = { username, tutorial: { step, count: 0, locked: [] } };
  return {
    lastState: state,
    subscribe: (l: (s: unknown) => void) => { listeners.push(l); },
  } as never;
}

describe('TutorialPanel hide persistence', () => {
  beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; });

  it('remembers Hide per player across a reload and can be shown again', () => {
    new TutorialPanel(fakeClient());
    const panel = document.querySelector<HTMLElement>('.tutorial-panel')!;
    expect(panel.hidden).toBe(false);
    panel.querySelector<HTMLButtonElement>('[data-act="hide"]')!.click();
    expect(localStorage.getItem(tutorialHiddenKey('alice'))).toBe('s1');

    document.body.innerHTML = '';
    new TutorialPanel(fakeClient());
    expect(document.querySelector<HTMLElement>('.tutorial-panel')!.hidden).toBe(true);

    document.body.innerHTML = '';
    new TutorialPanel(fakeClient('bob'));
    expect(document.querySelector<HTMLElement>('.tutorial-panel')!.hidden).toBe(false);

    expect(showTutorialAgain('alice')).toBe(true);
    expect(localStorage.getItem(tutorialHiddenKey('alice'))).toBeNull();
  });
});
