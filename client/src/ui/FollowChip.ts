import type { GameClient } from '../network/GameClient';

/** "Following X — Stop" chip on the XP bar; tap to cancel. */
export class FollowChip {
  private el: HTMLButtonElement;

  constructor(gameClient: GameClient, container: HTMLElement) {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'follow-chip';
    this.el.hidden = true;
    this.el.addEventListener('click', (e) => {
      e.stopPropagation();
      gameClient.sendStopFollowing();
    });
    container.appendChild(this.el);

    gameClient.subscribe((state) => {
      this.el.hidden = !state.following;
      if (!state.following) return;
      this.el.textContent = `Following ${state.following} — Stop`;
      this.el.setAttribute('aria-label', `Stop following ${state.following}`);
    });
  }
}
