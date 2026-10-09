import { artworkUrl } from './assets';
import '../styles/screens/title.css';

/**
 * Title-screen shell shared by every out-of-game flow screen (login,
 * username, verify, approve, offline, suspended) and the class picker's
 * backdrop. One painted-in-CSS dusk scene, the game logo, and a parchment
 * card that holds whatever the screen needs.
 *
 * The logo is the uploaded `/logo-artwork/idle-party.png` when it exists;
 * until it loads (or when it 404s) an outlined wordmark stands in, so the
 * screen never shows a broken image or a placeholder service.
 */

/** Decorative dusk scene. Pure CSS — no art needed. */
export const TITLE_BACKDROP_HTML = `
  <div class="ts-backdrop" aria-hidden="true">
    <div class="ts-stars"></div>
    <div class="ts-moon"></div>
    <div class="ts-peaks ts-peaks--far"></div>
    <div class="ts-castle"></div>
    <div class="ts-peaks ts-peaks--near"></div>
    <div class="ts-mist"></div>
  </div>
`;

const LOGO_HTML = `
  <header class="ts-logo">
    <img class="ts-logo__art" alt="" decoding="async" />
    <h1 class="ts-logo__word"><span class="ts-logo__line">Idle</span><span class="ts-logo__line ts-logo__line--accent">Party</span></h1>
  </header>
`;

export interface TitleShellOpts {
  /** Text on the slate tab that sits on the card's top edge. */
  tab: string;
}

/**
 * Full-screen title layout. `cardHtml` goes inside the parchment card;
 * callers are responsible for escaping anything dynamic in it.
 */
export function titleShellHtml(cardHtml: string, opts: TitleShellOpts): string {
  return `
    <div class="ts-screen">
      ${TITLE_BACKDROP_HTML}
      <div class="ts-stage">
        ${LOGO_HTML}
        <section class="ts-card gc-parchment">
          <div class="ts-card__tab gc-title-tab">${escapeHtml(opts.tab)}</div>
          ${cardHtml}
        </section>
      </div>
    </div>
  `;
}

/** Swap the wordmark for the uploaded logo once (and only if) it loads. */
export function wireTitleLogo(root: HTMLElement): void {
  const logo = root.querySelector<HTMLElement>('.ts-logo');
  const img = root.querySelector<HTMLImageElement>('.ts-logo__art');
  if (!logo || !img) return;
  img.addEventListener('load', () => logo.classList.add('ts-logo--art'), { once: true });
  img.addEventListener('error', () => img.remove(), { once: true });
  img.src = artworkUrl('logo', 'idle-party');
}

/**
 * The round seal at the top of a card that says what is going on at a
 * glance: working, done, failed, waiting on an email, or offline.
 */
export type TitleStatus = 'pending' | 'success' | 'error' | 'mail' | 'offline' | 'locked';

const STATUS_GLYPHS: Record<TitleStatus, string> = {
  pending: '<span class="ts-status__spinner"></span>',
  success: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17" /></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3.5 7l8.5 6.5L20.5 7" /></svg>',
  offline: '<svg viewBox="0 0 24 24"><path d="M12 6v8" /><path d="M12 18h.01" /></svg>',
  locked: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>',
};

export function titleStatusHtml(state: TitleStatus): string {
  return `<div class="ts-status" data-state="${state}" aria-hidden="true">${STATUS_GLYPHS[state]}</div>`;
}

export function setTitleStatus(el: HTMLElement, state: TitleStatus): void {
  if (el.dataset.state === state) return;
  el.dataset.state = state;
  el.innerHTML = STATUS_GLYPHS[state];
}

/** Put a button into (or out of) its busy state without losing its label. */
export function setButtonBusy(btn: HTMLButtonElement, busy: boolean, label: string): void {
  btn.disabled = busy;
  btn.classList.toggle('gc-btn--loading', busy);
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  btn.textContent = label;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
