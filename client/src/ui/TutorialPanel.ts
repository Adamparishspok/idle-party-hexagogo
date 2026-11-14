import type { ClientTutorialState } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import '../styles/screens/tutorial.css';

/** Small card above the nav showing the current tutorial step. Dismissing hides that step only until the next one. */
export class TutorialPanel {
  private el: HTMLElement;
  private dismissedStepId: string | null = null;

  constructor(private gameClient: GameClient) {
    this.el = document.createElement('div');
    this.el.className = 'tutorial-panel gc-parchment';
    this.el.setAttribute('role', 'status');
    this.el.hidden = true;
    document.body.appendChild(this.el);
    gameClient.subscribe((state) => this.render(state.tutorial));
    this.render(gameClient.lastState?.tutorial);
  }

  private render(tutorial: ClientTutorialState | undefined): void {
    const step = tutorial?.step;
    if (!step || step.id === this.dismissedStepId) {
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
      this.dismissedStepId = step.id;
      this.el.hidden = true;
    });
  }
}
