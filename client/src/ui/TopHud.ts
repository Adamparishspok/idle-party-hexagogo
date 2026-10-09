import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';

const ICON_HOUSE = '<svg class="hud-home-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5" fill="none" stroke="#3a2817" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 10v9.5h13V10L12 4.8z" fill="#f5c842" stroke="#3a2817" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 19.5v-5h4v5" fill="#b8861b" stroke="#3a2817" stroke-width="1.4" stroke-linejoin="round"/><path d="M16 4.5h2.2v3.6" fill="none" stroke="#3a2817" stroke-width="1.8" stroke-linecap="round"/></svg>';

/**
 * Top-of-screen HUD strip, visible on every root screen: gold counter on the
 * left, the current zone + room name centered, and a settings gear on the
 * right (the notification bell sits beside it, mounted by NotificationCenter).
 * Once you own a house, a Home button sits left of the gear.
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
  private homeEl: HTMLButtonElement;
  private sceneKey = '';

  constructor(gameClient: GameClient, worldCache: WorldCache, onSettings: () => void, onHome: () => void = () => gameClient.sendEnterHome()) {
    this.container = document.getElementById('top-hud')!;
    this.container.innerHTML = `
      <div class="hud-currency" aria-label="Gold">
        <span class="hud-currency-icon gc-coin" aria-hidden="true"></span>
        <span class="hud-currency-value">0</span>
      </div>
      <div class="hud-location">
        <div class="hud-zone"></div>
        <div class="hud-room"></div>
      </div>
      <div class="hud-actions">
        <button type="button" class="hud-home" aria-label="Go home" hidden>${ICON_HOUSE}</button>
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
    this.homeEl = this.container.querySelector('.hud-home')!;
    this.homeEl.addEventListener('click', onHome);

    gameClient.subscribe((state) => {
      const gold = state.character?.gold ?? 0;
      this.goldEl.textContent = gold.toLocaleString();
      this.homeEl.hidden = !state.house;
      this.homeEl.classList.toggle('active', !!state.homeVisit && state.homeVisit.owner === state.username);

      const tile = worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row);
      this.zoneEl.textContent = tile?.zoneName ?? '';
      this.roomEl.textContent = tile?.name ?? '';
      this.setSceneBackdrop(tile?.id, tile?.zone, state.party.col, state.party.row);
    });
  }

  /**
   * Publish the current location's painted scene as `--scene-backdrop` so
   * screens without art of their own (Character) can sit in the same place.
   */
  private setSceneBackdrop(roomId: string | undefined, zoneId: string | undefined, col: number, row: number): void {
    const key = `${roomId}|${zoneId}|${col},${row}`;
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    const enc = encodeURIComponent;
    const layers: string[] = [];
    if (roomId) layers.push(`/room-bg-artwork/${enc(roomId)}.png`);
    if (zoneId) {
      layers.push(`/room-bg-artwork/${enc(zoneId)}-${col}-${row}.png`);
      layers.push(`/room-bg-artwork/${enc(zoneId)}.png`);
      layers.push(`/combat-bg-artwork/${enc(zoneId)}.png`);
      layers.push(`/zone-artwork/${enc(zoneId)}.png`);
    }
    document.body.style.setProperty('--scene-backdrop', layers.length ? layers.map(u => `url('${u}')`).join(', ') : 'none');
  }

  /** Light the gear while Settings is the visible root — it stands in for a nav tab. */
  setSettingsActive(active: boolean): void {
    this.gearEl.classList.toggle('active', active);
  }
}
