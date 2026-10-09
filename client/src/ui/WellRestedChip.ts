import type { GameClient } from '../network/GameClient';
import { WELL_RESTED_BONUS, isWellRested } from '@idle-party-rpg/shared';

const TICK_MS = 30_000;
const TIP_MS = 4000;
const ICON_MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor" stroke="#1a1009" stroke-width="1.4" stroke-linejoin="round"/></svg>';

/** "2h 05m", "45m", "<1m" — minute precision, rounded up so it never reads 0 while active. */
export function formatRestedRemaining(ms: number): string {
  if (ms <= 0) return '0m';
  if (ms < 60_000) return '<1m';
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** Glowing Well Rested chip on the XP bar with the time left; tap for what it does. */
export class WellRestedChip {
  private el: HTMLButtonElement;
  private timeEl: HTMLElement;
  private tipEl: HTMLElement;
  private until: number | undefined;
  private tipTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(gameClient: GameClient, container: HTMLElement) {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'rested-chip';
    this.el.hidden = true;
    this.el.innerHTML = `<span class="rested-chip__icon">${ICON_MOON}</span><span class="rested-chip__time"></span>`
      + '<span class="rested-chip__tip" role="tooltip" hidden></span>';
    this.timeEl = this.el.querySelector('.rested-chip__time')!;
    this.tipEl = this.el.querySelector('.rested-chip__tip')!;
    this.el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleTip();
    });
    container.appendChild(this.el);

    gameClient.subscribe((state) => {
      if (state.wellRestedUntil === this.until) return;
      this.until = state.wellRestedUntil;
      this.update();
    });
    setInterval(() => this.update(), TICK_MS);
  }

  private update(): void {
    const now = Date.now();
    const active = isWellRested(this.until, now);
    this.el.hidden = !active;
    if (!active) {
      this.tipEl.hidden = true;
      return;
    }
    const left = formatRestedRemaining((this.until ?? 0) - now);
    const pct = Math.round((WELL_RESTED_BONUS - 1) * 100);
    const explain = `Well Rested: +${pct}% XP and gold from victories. ${left} left.`;
    this.timeEl.textContent = left;
    this.tipEl.textContent = explain;
    this.el.setAttribute('aria-label', explain);
    this.el.title = explain;
  }

  private toggleTip(): void {
    this.tipEl.hidden = !this.tipEl.hidden;
    if (this.tipTimer) clearTimeout(this.tipTimer);
    if (!this.tipEl.hidden) {
      this.tipTimer = setTimeout(() => { this.tipEl.hidden = true; }, TIP_MS);
    }
  }
}
