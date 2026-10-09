import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';

/**
 * Top-of-screen HUD strip, visible on every root screen: gold counter on the
 * left, the current zone + room name centered, and a settings gear on the
 * right (the notification bell sits beside it, mounted by NotificationCenter).
 *
 * Hidden at nav depth > 1 by CSS — a pushed screen's back header takes the
 * top edge instead.
 */
export class TopHud {
  private container: HTMLElement;
  private goldEl: HTMLElement;
  private zoneEl: HTMLElement;
  private roomEl: HTMLElement;
  private gearEl: HTMLElement;

  constructor(gameClient: GameClient, worldCache: WorldCache, onSettings: () => void) {
    this.container = document.getElementById('top-hud')!;
    this.container.innerHTML = `
      <div class="hud-currency" aria-label="Gold">
        <span class="hud-currency-icon hud-gold-icon" aria-hidden="true"></span>
        <span class="hud-currency-value">0</span>
      </div>
      <div class="hud-location">
        <div class="hud-zone"></div>
        <div class="hud-room"></div>
      </div>
      <div class="hud-actions">
        <button type="button" class="hud-gear gc-frame" aria-label="Settings">
          <img class="hud-gear-img" src="/nav-icons/settings.png" alt="" />
        </button>
      </div>
    `;
    this.goldEl = this.container.querySelector('.hud-currency-value')!;
    this.zoneEl = this.container.querySelector('.hud-zone')!;
    this.roomEl = this.container.querySelector('.hud-room')!;

    this.gearEl = this.container.querySelector('.hud-gear')!;
    this.gearEl.addEventListener('click', onSettings);

    gameClient.subscribe((state) => {
      const gold = state.character?.gold ?? 0;
      this.goldEl.textContent = gold.toLocaleString();

      const tile = worldCache.getTile(state.party.col, state.party.row);
      this.zoneEl.textContent = tile?.zoneName ?? '';
      this.roomEl.textContent = tile?.name ?? '';
    });
  }

  /** Light the gear while Settings is the visible root — it stands in for a nav tab. */
  setSettingsActive(active: boolean): void {
    this.gearEl.classList.toggle('active', active);
  }
}
