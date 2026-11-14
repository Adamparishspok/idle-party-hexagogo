import type { ClientTutorialState } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import '../styles/screens/tutorial.css';

export const TUTORIAL_SHOW_EVENT = 'idleparty:tutorial-show';
const HIDDEN_KEY_PREFIX = 'idleparty.tutorialHidden.';

export function tutorialHiddenKey(username: string): string {
  return HIDDEN_KEY_PREFIX + username;
}

function readHiddenStep(username: string | undefined): string | null {
  if (!username) return null;
  try { return localStorage.getItem(tutorialHiddenKey(username)); } catch { return null; }
}

function writeHiddenStep(username: string | undefined, stepId: string | null): void {
  if (!username) return;
  try {
    if (stepId) localStorage.setItem(tutorialHiddenKey(username), stepId);
    else localStorage.removeItem(tutorialHiddenKey(username));
  } catch { /* storage unavailable: hide lasts until reload */ }
}

/** Forgets the saved Hide so the current step shows again. Returns true if one was set. */
export function showTutorialAgain(username: string | undefined): boolean {
  const had = readHiddenStep(username) !== null;
  writeHiddenStep(username, null);
  return had;
}

/** Small card above the nav showing the current tutorial step. Hide is remembered per player until the next step. */
export class TutorialPanel {
  private el: HTMLElement;

  constructor(private gameClient: GameClient) {
    this.el = document.createElement('div');
    this.el.className = 'tutorial-panel gc-parchment';
    this.el.setAttribute('role', 'status');
    this.el.hidden = true;
    document.body.appendChild(this.el);
    gameClient.subscribe((state) => this.render(state.tutorial, state.username));
    this.render(gameClient.lastState?.tutorial, gameClient.lastState?.username);
    window.addEventListener(TUTORIAL_SHOW_EVENT, () => this.render(gameClient.lastState?.tutorial, gameClient.lastState?.username));
  }

  private render(tutorial: ClientTutorialState | undefined, username: string | undefined): void {
    const step = tutorial?.step;
    if (!step || step.id === readHiddenStep(username)) {
      this.el.hidden = true;
      return;
    }
    const goal = step.trigger.type === 'winBattles' ? ` (${tutorial.count}/${step.trigger.count})` : '';
    this.el.hidden = false;
    this.el.innerHTML = `
      <div class="tutorial-panel__title gc-display"></div>
      <p class="tutorial-panel__body"></p>
      <div class="tutorial-panel__actions">
        <button type="button" class="tutorial-panel__link" data-act="skip">Skip tutorial</button>
        <button type="button" class="tutorial-panel__link" data-act="hide">Hide</button>
      </div>
    `;
    this.el.querySelector('.tutorial-panel__title')!.textContent = step.title + goal;
    this.el.querySelector('.tutorial-panel__body')!.textContent = step.body;
    this.el.querySelector('[data-act="skip"]')!.addEventListener('click', () => {
      if (confirm('Skip the tutorial and unlock everything?')) this.gameClient.sendTutorialSkip();
    });
    this.el.querySelector('[data-act="hide"]')!.addEventListener('click', () => {
      writeHiddenStep(username, step.id);
      this.el.hidden = true;
    });
  }
}
