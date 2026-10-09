import type { GameClient } from '../network/GameClient';
import { artworkUrl } from './assets';

/**
 * XP strip that lives directly above the bottom nav, visible on every screen.
 * A class portrait perches above its left end (tap → character screen), the
 * level badge sits on the junction, and the bar shows `xp / next XP` centered.
 */
export class PersistentXpBar {
  private container: HTMLElement;
  private fill!: HTMLElement;
  private levelLabel!: HTMLElement;
  private xpText!: HTMLElement;
  private portraitImg!: HTMLImageElement;
  private portraitClass = '';

  constructor(gameClient: GameClient, onPortraitClick: () => void) {
    this.container = document.getElementById('persistent-xp-bar')!;
    this.container.innerHTML = `
      <button type="button" class="xpbar-portrait gc-frame" aria-label="Character">
        <img class="xpbar-portrait-img" alt="" style="opacity:0" />
      </button>
      <div class="xpbar-level" aria-label="Level">1</div>
      <div class="xpbar-track">
        <div class="xpbar-fill"></div>
        <div class="xpbar-text"></div>
      </div>
    `;
    this.fill = this.container.querySelector('.xpbar-fill')!;
    this.levelLabel = this.container.querySelector('.xpbar-level')!;
    this.xpText = this.container.querySelector('.xpbar-text')!;
    this.portraitImg = this.container.querySelector('.xpbar-portrait-img')!;
    this.portraitImg.addEventListener('load', () => { this.portraitImg.style.opacity = '1'; });
    this.portraitImg.addEventListener('error', () => { this.portraitImg.style.display = 'none'; });

    this.container.querySelector('.xpbar-portrait')!.addEventListener('click', onPortraitClick);

    gameClient.subscribe((state) => {
      const char = state.character;
      if (!char) {
        this.container.style.display = 'none';
        return;
      }
      this.container.style.display = '';
      this.levelLabel.textContent = String(char.level);
      const pct = char.xpForNextLevel > 0
        ? Math.max(0, Math.min(100, (char.xp / char.xpForNextLevel) * 100))
        : 0;
      this.fill.style.width = `${pct}%`;
      this.xpText.textContent = char.xpForNextLevel > 0
        ? `${char.xp.toLocaleString()} / ${char.xpForNextLevel.toLocaleString()} XP`
        : 'Max level';

      if (char.className !== this.portraitClass) {
        this.portraitClass = char.className;
        this.portraitImg.style.display = '';
        this.portraitImg.style.opacity = '0';
        this.portraitImg.src = artworkUrl('class', char.className.toLowerCase());
      }
    });
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }
}
