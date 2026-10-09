import type { ServerWelcomeBackMessage, WelcomeBackItem, SfxId } from '@idle-party-rpg/shared';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { renderKitItem, escapeHtml, RARITY_ORDER } from './ItemIcon';
import { sound } from '../audio/SoundManager';
import '../styles/screens/welcome.css';

export const MAX_VISIBLE_LOOT = 8;
const COUNT_UP_MS = 900;
const COLLECT_MS = 320;

export function formatAway(ms: number): string {
  const totalMin = Math.max(1, Math.floor(ms / 60_000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}K`;
  return Math.round(n).toLocaleString('en-US');
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Rewards were already granted server-side; Collect only closes the summary. */
export class WelcomeBackModal {
  private overlay: HTMLElement;
  private msg: ServerWelcomeBackMessage | null = null;
  private rafId = 0;
  private collectTimer: ReturnType<typeof setTimeout> | null = null;
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.hide();
  };

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'gc-modal wb-modal';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    wireFocusOnInteract(this.overlay);
    document.body.appendChild(this.overlay);
  }

  get isOpen(): boolean {
    return this.overlay.style.display !== 'none';
  }

  show(msg: ServerWelcomeBackMessage): void {
    this.stopAnimations();
    this.msg = msg;
    this.overlay.classList.remove('is-collecting');
    this.overlay.innerHTML = `
      <div class="gc-modal__panel gc-parchment wb-modal__panel" role="dialog" aria-modal="true" aria-labelledby="wb-modal-title">
        <div class="gc-title-tab gc-modal__title"><span class="gc-title-tab__text" id="wb-modal-title">Welcome Back!</span></div>
        <div class="gc-modal__body wb-modal__body">
          <p class="wb-modal__lead">Your party fought on for <strong>${escapeHtml(formatAway(msg.awayMs))}</strong></p>
          <div class="gc-facts wb-modal__stats">${this.renderStats(msg)}</div>
          ${this.renderLoot(msg)}
        </div>
        <div class="gc-modal__actions">
          <button type="button" class="gc-btn gc-btn--gold gc-btn--lg wb-modal__collect" data-sfx="none">Collect</button>
        </div>
      </div>
    `;
    this.overlay.querySelector('.wb-modal__collect')?.addEventListener('click', () => this.collect());

    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);
    document.addEventListener('keydown', this.onKeyDown);
    (this.overlay.querySelector('.wb-modal__collect') as HTMLElement).focus({ preventScroll: true });
    this.countUp();
  }

  hide(): void {
    if (!this.isOpen) return;
    this.stopAnimations();
    document.removeEventListener('keydown', this.onKeyDown);
    this.overlay.style.display = 'none';
    this.overlay.classList.remove('is-collecting');
    this.overlay.innerHTML = '';
    this.msg = null;
    release(this.overlay);
  }

  private collect(): void {
    const msg = this.msg;
    if (!msg || this.overlay.classList.contains('is-collecting')) return;
    sound.play(this.collectSound(msg));
    this.finishCountUp();
    if (prefersReducedMotion()) {
      this.hide();
      return;
    }
    this.overlay.classList.add('is-collecting');
    this.collectTimer = setTimeout(() => this.hide(), COLLECT_MS);
  }

  private collectSound(msg: ServerWelcomeBackMessage): SfxId {
    if (msg.levelsGained > 0) return 'level-up';
    if (msg.items.length > 0) return 'loot';
    return 'coin';
  }

  private renderStats(msg: ServerWelcomeBackMessage): string {
    const tiles: string[] = [];
    if (msg.levelsGained > 0) {
      tiles.push(this.statTile('levels', msg.levelsGained === 1 ? 'Level up' : 'Levels gained', msg.levelsGained, '+'));
    }
    tiles.push(this.statTile('xp', 'XP earned', msg.xpGained, '+'));
    tiles.push(this.statTile('gold', 'Gold', msg.goldGained, '+', '<span class="gc-coin" aria-hidden="true"></span>'));
    tiles.push(this.statTile('wins', 'Battles won', msg.battlesWon));
    return tiles.join('');
  }

  private statTile(kind: string, label: string, value: number, prefix = '', icon = ''): string {
    const start = prefersReducedMotion() ? value : 0;
    return `
      <div class="gc-stat wb-stat wb-stat--${kind}">
        <span class="gc-stat__value">${icon}<span class="wb-stat__num" data-target="${value}" data-prefix="${prefix}">${prefix}${formatCount(start)}</span></span>
        <span class="gc-stat__label">${escapeHtml(label)}</span>
      </div>`;
  }

  private renderLoot(msg: ServerWelcomeBackMessage): string {
    if (msg.items.length === 0) return '';
    const sorted = [...msg.items].sort((a, b) => this.rarityRank(a) - this.rarityRank(b) || b.count - a.count);
    const visible = sorted.slice(0, MAX_VISIBLE_LOOT);
    const hidden = sorted.length - visible.length;
    const frames = visible.map(({ itemId, count }) => {
      const def = msg.itemDefinitions[itemId];
      const name = def?.name ?? itemId;
      return `
        <li class="wb-loot__item">
          ${renderKitItem(itemId, def, { size: 'sm', count, label: `${name} x${count}` })}
          <span class="wb-loot__name">${escapeHtml(name)}</span>
        </li>`;
    }).join('');
    const more = hidden > 0 ? `<li class="wb-loot__more">+${hidden} more</li>` : '';
    return `
      <div class="gc-divider wb-modal__divider">Loot</div>
      <ul class="wb-loot">${frames}${more}</ul>`;
  }

  private rarityRank(item: WelcomeBackItem): number {
    const rarity = this.msg?.itemDefinitions[item.itemId]?.rarity ?? 'common';
    return RARITY_ORDER[rarity] ?? 99;
  }

  private countUp(): void {
    if (prefersReducedMotion()) return;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      this.renderNumbers(eased);
      this.rafId = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.rafId = requestAnimationFrame(step);
  }

  private finishCountUp(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.renderNumbers(1);
  }

  private renderNumbers(progress: number): void {
    for (const el of this.overlay.querySelectorAll<HTMLElement>('.wb-stat__num')) {
      const target = Number(el.dataset.target ?? 0);
      el.textContent = `${el.dataset.prefix ?? ''}${formatCount(target * progress)}`;
    }
  }

  private stopAnimations(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.collectTimer) clearTimeout(this.collectTimer);
    this.collectTimer = null;
  }
}
