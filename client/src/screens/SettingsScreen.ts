import type { Screen } from './ScreenManager';
import { logout } from '../network/AuthClient';
import { getQuestHintsEnabled, setQuestHintsEnabled } from '../settings/UserSettings';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';
import type { GameClient } from '../network/GameClient';
import { renderNotificationPreferences } from '../ui/NotificationPreferences';
import { GAME_VERSION } from '@idle-party-rpg/shared';
import '../styles/screens/settings.css';

/** Stroke icons for the settings rows — drawn inline so there's no art dependency. */
const ROW_ICONS = {
  options: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2.5" /><circle cx="10" cy="17" r="2.5" /></svg>',
  notifications: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg>',
  patchNotes: '<svg viewBox="0 0 24 24"><path d="M7 3h8l4 4v14H7z" /><path d="M15 3v4h4M10 12h6M10 16h6" /></svg>',
  signOut: '<svg viewBox="0 0 24 24"><path d="M14 4H6v16h8" /><path d="M11 12h9M17 8.5l3.5 3.5-3.5 3.5" /></svg>',
} as const;

function rowHtml(id: string, icon: string, title: string, sub: string, variant = ''): string {
  return `
    <button type="button" class="gc-row st-row ${variant}" id="${id}">
      <span class="st-row__icon" aria-hidden="true">${icon}</span>
      <span class="gc-row__main">
        <span class="gc-row__title">${title}</span>
        <span class="gc-row__sub">${sub}</span>
      </span>
      <span class="st-row__chevron" aria-hidden="true"></span>
    </button>
  `;
}

/**
 * Parchment modal shell (`.gc-modal`) used by both Settings popups. Returns
 * the overlay plus a `close` that releases it from the modal stack.
 */
function openSettingsModal(title: string, bodyHtml: string, extraPanelClass: string, onClosed: () => void): { overlay: HTMLElement; close: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'gc-modal st-modal';
  overlay.innerHTML = `
    <div class="gc-modal__panel gc-parchment st-modal__panel ${extraPanelClass}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="gc-modal__title gc-title-tab">${title}</div>
      <button type="button" class="gc-modal__close gc-close" aria-label="Close"></button>
      <div class="gc-modal__body st-modal__body">${bodyHtml}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    release(overlay);
    overlay.remove();
    onClosed();
  };

  // Click outside the modal closes; click on the X closes.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('.gc-modal__close')!.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  bringToFront(overlay);
  wireFocusOnInteract(overlay);
  return { overlay, close };
}

export class SettingsScreen implements Screen {
  private container: HTMLElement;
  private closeOptions: (() => void) | null = null;
  private closeNotifPrefs: (() => void) | null = null;

  constructor(
    containerId: string,
    private gameClient: GameClient,
    /** Drill down to a pushed screen. Wired by App to ScreenManager.push. */
    private onOpenScreen: (id: string) => void,
  ) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;

    this.container.innerHTML = `
      <div class="st-screen">
        <div class="st-scroll screen-scroll">
          <h1 class="gc-screen-title st-title">Settings</h1>
          <div class="st-list">
            ${rowHtml('btn-player-options', ROW_ICONS.options, 'Player Options', 'Map and gameplay preferences')}
            ${rowHtml('btn-notifications', ROW_ICONS.notifications, 'Notifications', 'Choose how you hear about events')}
            ${rowHtml('btn-patch-notes', ROW_ICONS.patchNotes, 'Patch Notes', 'What’s new in the game')}
          </div>
          <div class="st-list st-list--danger">
            ${rowHtml('btn-sign-out', ROW_ICONS.signOut, 'Sign Out', 'Your party keeps fighting while you’re away', 'st-row--danger')}
          </div>
          <p class="st-version">Version ${GAME_VERSION}</p>
        </div>
      </div>
    `;

    const btnPlayerOptions = this.container.querySelector('#btn-player-options') as HTMLButtonElement;
    const btnNotifications = this.container.querySelector('#btn-notifications') as HTMLButtonElement;
    const btnPatchNotes = this.container.querySelector('#btn-patch-notes') as HTMLButtonElement;

    btnPlayerOptions.addEventListener('click', () => this.openPlayerOptions());
    btnNotifications.addEventListener('click', () => this.openNotificationPreferences());
    btnPatchNotes.addEventListener('click', () => this.onOpenScreen('patch-notes'));

    const btnSignOut = this.container.querySelector('#btn-sign-out') as HTMLButtonElement;
    const signOutTitle = btnSignOut.querySelector('.gc-row__title') as HTMLElement;
    btnSignOut.addEventListener('click', async () => {
      if (!confirm('Sign out of your account?')) return;
      btnSignOut.disabled = true;
      signOutTitle.textContent = 'Signing out...';
      try {
        await logout();
      } finally {
        window.location.reload();
      }
    });
  }

  /**
   * Player Options popup. Keeps each per-toggle setting wired here so adding
   * a new option is one HTML block + one change listener — no plumbing
   * through to SettingsScreen state.
   */
  private openPlayerOptions(): void {
    // Idempotent: re-clicking the button while open is a no-op.
    if (this.closeOptions) return;

    const { overlay, close } = openSettingsModal('Player Options', `
      <ul class="st-options">
        <li>
          <label class="gc-switch-row">
            <span class="gc-switch-row__text">
              <span class="gc-switch-row__title">Quest hints</span>
              <span class="gc-switch-row__desc">Highlight quest-giver rooms and visit objectives on the map.</span>
            </span>
            <span class="gc-switch">
              <input type="checkbox" role="switch" class="gc-switch__input" id="po-quest-hints" ${getQuestHintsEnabled() ? 'checked' : ''}>
              <span class="gc-switch__track" aria-hidden="true"><span class="gc-switch__thumb"></span></span>
            </span>
          </label>
        </li>
      </ul>
    `, 'st-modal__panel--options', () => { this.closeOptions = null; });
    this.closeOptions = close;

    const questHintsToggle = overlay.querySelector('#po-quest-hints') as HTMLInputElement;
    questHintsToggle.addEventListener('change', () => {
      setQuestHintsEnabled(questHintsToggle.checked);
    });
  }

  private openNotificationPreferences(): void {
    if (this.closeNotifPrefs) return;

    const { overlay, close } = openSettingsModal(
      'Notifications',
      '<div class="notif-prefs-body"></div>',
      'st-modal__panel--notif',
      () => { this.closeNotifPrefs = null; },
    );
    this.closeNotifPrefs = close;

    renderNotificationPreferences(overlay.querySelector('.notif-prefs-body') as HTMLElement, this.gameClient);
  }

  onActivate(): void {
    // Nothing to reset — patch notes is a pushed screen now, so returning
    // here means it has already been popped.
  }

  onDeactivate(): void {
    // Close any open popup so it doesn't survive a tab switch.
    this.closeNotifPrefs?.();
    this.closeOptions?.();
  }
}
