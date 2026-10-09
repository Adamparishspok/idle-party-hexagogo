import type { Screen } from './ScreenManager';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import { ALL_CLASS_NAMES, CLASS_DEFINITIONS, classIconHtml, getSkillsForClass } from '@idle-party-rpg/shared';
import type { ClassName } from '@idle-party-rpg/shared';
import { artworkUrl } from '../ui/assets';
import { TITLE_BACKDROP_HTML, escapeHtml, setButtonBusy } from '../ui/TitleShell';
import '../styles/screens/class-select.css';

/**
 * Class picker. A horizontal, scroll-snapped carousel of big class cards on
 * phones (swipe to browse, tap to pick) that becomes a wrapped grid on
 * desktop. The pick is explicit — swiping only browses — and the gold
 * "Choose {Class}" button pinned at the bottom confirms it.
 */
export class ClassSelectScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private onClassChosen: () => void;
  private selectedClass: ClassName | null = null;
  private confirmBtn!: HTMLButtonElement;
  private trackEl!: HTMLElement;
  private pips: HTMLElement[] = [];
  private scrollRaf = 0;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache, onClassChosen: () => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.onClassChosen = onClassChosen;

    this.buildDOM();
  }

  onActivate(): void {
    this.selectedClass = null;
    setButtonBusy(this.confirmBtn, false, 'Pick a class');
    this.confirmBtn.disabled = true;
    this.cards().forEach(c => {
      c.classList.remove('selected');
      c.setAttribute('aria-checked', 'false');
    });
    this.trackEl.scrollTo({ left: 0 });
    this.updatePips();
  }

  onDeactivate(): void {
    cancelAnimationFrame(this.scrollRaf);
  }

  private cards(): HTMLElement[] {
    return Array.from(this.container.querySelectorAll<HTMLElement>('.cs-card'));
  }

  private buildDOM(): void {
    const skillContent = this.worldCache.getSkillContent();
    const cards = ALL_CLASS_NAMES.map(cn => {
      const def = CLASS_DEFINITIONS[cn];
      // Starting-skill preview: the class's level-1 passive. getSkillsForClass
      // returns skills sorted by sortOrder, so the first match wins ties.
      const startingSkill = getSkillsForClass(cn, skillContent)
        .find(s => s.type === 'passive' && s.unlockLevel === 1);
      const passive = startingSkill
        ? `<span class="cs-passive__name">${escapeHtml(startingSkill.name)}</span>
           <span class="cs-passive__desc">${escapeHtml(startingSkill.description)}</span>`
        : '<span class="cs-passive__desc">No starting skill</span>';

      return `
        <button type="button" class="cs-card" role="radio" aria-checked="false" data-class="${cn}"
          aria-label="${escapeHtml(def.displayName)}">
          <span class="cs-card__art" data-class="${cn}">
            <span class="cs-card__icon">${classIconHtml(cn)}</span>
            <img class="cs-card__img" alt="" decoding="async" loading="lazy" />
          </span>
          <span class="cs-card__body">
            <span class="cs-card__name">${escapeHtml(def.displayName)}</span>
            <span class="cs-card__desc">${escapeHtml(def.description)}</span>
            <span class="cs-card__stats">
              <span class="cs-stat cs-stat--hp">
                <span class="cs-stat__label">HP</span>
                <span class="cs-stat__value">${def.baseHp}</span>
                <span class="cs-stat__growth">+${def.hpPerLevel}/lv</span>
              </span>
              <span class="cs-stat cs-stat--dmg">
                <span class="cs-stat__label">DMG</span>
                <span class="cs-stat__value">${def.baseDamage}</span>
                <span class="cs-stat__growth">+${def.damagePerLevel}/lv &middot; ${escapeHtml(def.damageType)}</span>
              </span>
            </span>
            <span class="cs-passive">${passive}</span>
          </span>
        </button>
      `;
    }).join('');

    this.container.innerHTML = `
      <div class="cs-screen">
        ${TITLE_BACKDROP_HTML}
        <header class="cs-head">
          <h1 class="gc-screen-title cs-title">Choose Your Class</h1>
          <p class="cs-sub">Each class is weak alone but powerful in a party.</p>
        </header>
        <div class="cs-track" role="radiogroup" aria-label="Classes">
          ${cards}
        </div>
        <div class="cs-pips" aria-hidden="true">
          ${ALL_CLASS_NAMES.map(() => '<span class="cs-pip"></span>').join('')}
        </div>
        <footer class="cs-foot">
          <button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block cs-confirm" disabled>Pick a class</button>
        </footer>
      </div>
    `;

    this.confirmBtn = this.container.querySelector('.cs-confirm')!;
    this.trackEl = this.container.querySelector('.cs-track')!;
    this.pips = Array.from(this.container.querySelectorAll<HTMLElement>('.cs-pip'));

    // Class art: show the painted portrait once it loads; otherwise the big
    // class icon underneath stays as the fallback.
    this.container.querySelectorAll<HTMLElement>('.cs-card__art').forEach(art => {
      const img = art.querySelector<HTMLImageElement>('.cs-card__img')!;
      img.addEventListener('load', () => art.classList.add('cs-card__art--loaded'), { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = artworkUrl('class', (art.dataset.class ?? '').toLowerCase());
    });

    // Wire card clicks
    this.cards().forEach(card => {
      card.addEventListener('click', () => this.select(card));
    });

    this.trackEl.addEventListener('scroll', () => {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = requestAnimationFrame(() => this.updatePips());
    }, { passive: true });

    // Wire confirm
    this.confirmBtn.addEventListener('click', () => {
      if (!this.selectedClass) return;
      setButtonBusy(this.confirmBtn, true, 'Creating...');
      this.gameClient.sendSetClass(this.selectedClass);

      // Listen for the state update confirming class change
      const unsub = this.gameClient.subscribe((state) => {
        if (state.character !== null) {
          unsub();
          // Defer to next microtask so enterGame() runs outside the subscriber
          // loop — errors propagate properly instead of being swallowed
          queueMicrotask(() => this.onClassChosen());
        }
      });
    });
  }

  private select(card: HTMLElement): void {
    if (this.confirmBtn.classList.contains('gc-btn--loading')) return;
    this.cards().forEach(c => {
      c.classList.remove('selected');
      c.setAttribute('aria-checked', 'false');
    });
    card.classList.add('selected');
    card.setAttribute('aria-checked', 'true');
    this.selectedClass = card.getAttribute('data-class') as ClassName;
    const name = CLASS_DEFINITIONS[this.selectedClass]?.displayName ?? this.selectedClass;
    this.confirmBtn.disabled = false;
    this.confirmBtn.textContent = `Choose ${name}`;
    // Bring a half-visible card fully into view on phones.
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  /** Highlight the pip for whichever card is nearest the track's center. */
  private updatePips(): void {
    if (!this.pips.length) return;
    const track = this.trackEl.getBoundingClientRect();
    const center = track.left + track.width / 2;
    let best = 0;
    let bestDist = Infinity;
    this.cards().forEach((c, i) => {
      const r = c.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - center);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    this.pips.forEach((p, i) => p.classList.toggle('active', i === best));
  }
}
