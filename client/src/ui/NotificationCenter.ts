import type { GameClient } from '../network/GameClient';
import type { NotificationCategory, NotificationEntry, NotificationNavigationTarget } from '@idle-party-rpg/shared';
import { resolveNotificationNavigation } from '@idle-party-rpg/shared';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import '../styles/screens/notifications.css';

const TOAST_LIFETIME_MS = 6000;
/** Matches the toast leave transition in notifications.css. */
const TOAST_LEAVE_MS = 300;

const INK = '#1a1009';

/** Small category glyphs for rows and toasts (filled with currentColor, inked outline). */
const CATEGORY_ICONS: Record<NotificationCategory, string> = {
  party: `<circle cx="9" cy="8" r="3.6"/><circle cx="16.5" cy="9" r="3"/><path d="M14.4 13.8c.7-.3 1.4-.4 2.1-.4 3 0 5 2.2 5 5.6h-5.2"/><path d="M2.5 20c0-4 2.9-6.6 6.5-6.6s6.5 2.6 6.5 6.6z"/>`,
  dm: `<path d="M4 4.5h16a1.6 1.6 0 0 1 1.6 1.6v9.3A1.6 1.6 0 0 1 20 17h-8.2L6.5 21v-4H4a1.6 1.6 0 0 1-1.6-1.6V6.1A1.6 1.6 0 0 1 4 4.5z"/>`,
  friend: `<circle cx="9.5" cy="8" r="4"/><path d="M2 21c0-4.4 3.3-7 7.5-7s7.5 2.6 7.5 7z"/><path d="M18.5 6.5v7M15 10h7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`,
  trade: `<path d="M3.5 8h14M14 4l4 4-4 4M20.5 16h-14M10 12l-4 4 4 4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  world_event: `<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>`,
  quest: `<path d="M9.8 3h4.4l-.7 11.5h-3z"/><circle cx="12" cy="19" r="2.2"/>`,
  guild_combat: `<path d="M4 4l10 10M20 4L10 14M7 15l2 2M17 15l-2 2M5 19l2.5-2.5M19 19l-2.5-2.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`,
  system: `<path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6z"/><path d="M9.5 18.5a2.5 2.5 0 0 0 5 0z"/>`,
};

const ICON_X = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;

function categoryIcon(category: NotificationCategory): string {
  const glyph = CATEGORY_ICONS[category] ?? CATEGORY_ICONS.system;
  return `<span class="gc-octicon notif-icon" data-cat="${escapeHtml(category)}" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round">${glyph}</svg>
  </span>`;
}

export type ClientNavigationTarget = NotificationNavigationTarget | { kind: 'home'; owner: string };

const HOME_INVITE_OWNER_KEYS = ['owner', 'ownerUsername', 'fromUsername'] as const;

/** Shared resolution plus client-only targets the shared resolver doesn't know yet (home invites). */
export function resolveClientNavigation(entry: Pick<NotificationEntry, 'category' | 'eventKey' | 'payload'>): ClientNavigationTarget {
  if (entry.eventKey === 'home_invite') {
    for (const key of HOME_INVITE_OWNER_KEYS) {
      const owner = entry.payload?.[key];
      if (typeof owner === 'string' && owner) return { kind: 'home', owner };
    }
  }
  return resolveNotificationNavigation(entry);
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Global notification bell + dropdown inbox + live toast stack. Mounted once
 * outside #app (like ChatPopout) so it survives screen switches.
 */
export class NotificationCenter {
  private root: HTMLElement;
  private bellButton: HTMLButtonElement;
  private toastStack: HTMLElement;
  private dropdown: HTMLElement | null = null;
  private notifications: NotificationEntry[] = [];
  /** Signature of what the open dropdown last rendered — skips no-op rebuilds on every state tick. */
  private renderedKey = '';

  constructor(
    private gameClient: GameClient,
    private onNavigate: (target: ClientNavigationTarget) => void,
  ) {
    this.root = document.getElementById('notification-center-root')!;

    this.bellButton = document.createElement('button');
    this.bellButton.className = 'notif-bell-btn';
    this.bellButton.setAttribute('aria-label', 'Notifications');
    this.bellButton.innerHTML = `
      <svg class="notif-bell-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6z" fill="#f5c842" stroke="#3a2817" stroke-width="1.6" stroke-linejoin="round"/><path d="M9.5 18.5a2.5 2.5 0 0 0 5 0" fill="none" stroke="#3a2817" stroke-width="1.8" stroke-linecap="round"/></svg>
      <span class="notif-bell-badge"></span>
    `;
    this.bellButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });
    this.root.appendChild(this.bellButton);

    this.toastStack = document.createElement('div');
    this.toastStack.className = 'notif-toast-stack';
    this.toastStack.setAttribute('role', 'region');
    this.toastStack.setAttribute('aria-label', 'New notifications');
    this.toastStack.setAttribute('aria-live', 'polite');
    this.root.appendChild(this.toastStack);

    document.addEventListener('click', () => this.closeDropdown());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeDropdown();
    });

    this.gameClient.subscribe((state) => {
      this.notifications = state.social?.notifications ?? [];
      this.updateBadge();
      if (this.dropdown) this.renderDropdownList();
    });

    this.gameClient.onNotification((notification) => {
      this.showToast(notification);
    });
  }

  private unreadCount(): number {
    return this.notifications.filter(n => n.readAt === null).length;
  }

  private updateBadge(): void {
    const badge = this.bellButton.querySelector('.notif-bell-badge') as HTMLElement;
    const count = this.unreadCount();
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.toggle('visible', count > 0);
  }

  private toggleDropdown(): void {
    if (this.dropdown) {
      this.closeDropdown();
    } else {
      this.openDropdown();
    }
  }

  private openDropdown(): void {
    if (this.dropdown) return;

    const panel = document.createElement('div');
    panel.className = 'notif-dropdown';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Notifications');
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.innerHTML = `
      <div class="notif-dropdown-header">
        <h2 class="notif-dropdown-title">Notifications</h2>
        <button type="button" class="notif-dropdown-close gc-close" aria-label="Close notifications"></button>
      </div>
      <div class="notif-dropdown-actions">
        <button type="button" class="notif-mark-all-btn gc-btn gc-btn--steel">Mark all read</button>
        <button type="button" class="notif-clear-all-btn gc-btn gc-btn--red">Clear all</button>
      </div>
      <div class="notif-dropdown-list"></div>
    `;

    panel.querySelector('.notif-dropdown-close')!.addEventListener('click', () => this.closeDropdown());

    panel.querySelector('.notif-mark-all-btn')!.addEventListener('click', () => {
      this.gameClient.sendMarkAllNotificationsRead();
    });

    panel.querySelector('.notif-clear-all-btn')!.addEventListener('click', () => {
      if (this.notifications.length === 0) return;
      if (!window.confirm("Clear all notifications? This can't be undone.")) return;
      this.gameClient.sendClearAllNotifications();
    });

    document.body.appendChild(panel);
    this.dropdown = panel;
    this.renderedKey = '';
    this.renderDropdownList();

    requestAnimationFrame(() => {
      const btnRect = this.bellButton.getBoundingClientRect();
      // offsetWidth, not the bounding rect: the pop-in starts scaled down.
      const width = panel.offsetWidth;
      const margin = 8;
      let left = btnRect.right - width;
      left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
      panel.style.left = `${left}px`;
      panel.style.top = `${btnRect.bottom + 6}px`;
      // Grow the panel out of the bell.
      const originX = Math.max(0, Math.min(width, btnRect.left + btnRect.width / 2 - left));
      panel.style.transformOrigin = `${originX}px 0`;
      panel.classList.add('notif-dropdown-shown');
    });

    bringToFront(panel);
    wireFocusOnInteract(panel);
  }

  private closeDropdown(): void {
    if (!this.dropdown) return;
    release(this.dropdown);
    this.dropdown.remove();
    this.dropdown = null;
  }

  private renderDropdownList(): void {
    if (!this.dropdown) return;
    const list = this.dropdown.querySelector('.notif-dropdown-list') as HTMLElement;

    // State pushes arrive every tick; only rebuild when something visible
    // changed (entries, read state, or the minute-resolution relative times),
    // so rows don't flicker or lose a press mid-tap.
    const key = `${Math.floor(Date.now() / 60000)}|${this.notifications.map(n => `${n.id}:${n.readAt ?? ''}`).join(',')}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    const hasAny = this.notifications.length > 0;
    this.dropdown.querySelector<HTMLButtonElement>('.notif-mark-all-btn')!.disabled = this.unreadCount() === 0;
    this.dropdown.querySelector<HTMLButtonElement>('.notif-clear-all-btn')!.disabled = !hasAny;

    if (!hasAny) {
      list.innerHTML = `
        <div class="notif-empty">
          ${categoryIcon('system')}
          <span class="notif-empty-title">All caught up</span>
          <span class="notif-empty-text">Party invites, messages and friend requests will show up here.</span>
        </div>`;
      return;
    }

    const sorted = [...this.notifications].sort((a, b) => b.createdAt - a.createdAt);
    list.innerHTML = sorted.map(n => {
      const unread = n.readAt === null;
      return `
      <div class="notif-row gc-row${unread ? ' notif-row-unread' : ''}">
        <button type="button" class="notif-row-main" data-id="${escapeHtml(n.id)}">
          ${categoryIcon(n.category)}
          <span class="notif-row-body gc-row__main">
            <span class="notif-row-title gc-row__title">${escapeHtml(n.title)}</span>
            <span class="notif-row-text">${escapeHtml(n.body)}</span>
            <span class="notif-row-time">${relativeTime(n.createdAt)}${unread ? '<span class="notif-sr-only"> · unread</span>' : ''}</span>
          </span>
          <span class="notif-row-dot" aria-hidden="true"></span>
        </button>
        <button type="button" class="notif-row-dismiss" data-id="${escapeHtml(n.id)}" aria-label="Dismiss notification">${ICON_X}</button>
      </div>
    `;
    }).join('');

    list.querySelectorAll<HTMLButtonElement>('.notif-row-main').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.id!;
        this.gameClient.sendMarkNotificationRead(id);
        this.navigateFor(id);
      });
    });

    list.querySelectorAll<HTMLButtonElement>('.notif-row-dismiss').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.gameClient.sendDismissNotification(btn.dataset.id!);
      });
    });
  }

  /** Resolves and applies the click-to-navigate target for a notification, closing the dropdown if it navigates. */
  private navigateFor(id: string): void {
    const entry = this.notifications.find(n => n.id === id);
    if (!entry) return;
    const target = resolveClientNavigation(entry);
    if (target.kind === 'none') return;
    this.onNavigate(target);
    this.closeDropdown();
  }

  private showToast(notification: NotificationEntry): void {
    const toast = document.createElement('div');
    toast.className = 'notif-toast';
    toast.setAttribute('role', 'button');
    toast.tabIndex = 0;
    toast.style.setProperty('--toast-life', `${TOAST_LIFETIME_MS}ms`);
    toast.innerHTML = `
      ${categoryIcon(notification.category)}
      <span class="notif-toast-body">
        <span class="notif-toast-title">${escapeHtml(notification.title)}</span>
        <span class="notif-toast-text">${escapeHtml(notification.body)}</span>
      </span>
      <button type="button" class="notif-toast-close" aria-label="Hide">${ICON_X}</button>
      <span class="notif-toast-timer" aria-hidden="true"></span>
    `;

    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      toast.classList.add('notif-toast-leaving');
      setTimeout(() => toast.remove(), TOAST_LEAVE_MS);
    };
    const activate = () => {
      this.gameClient.sendMarkNotificationRead(notification.id);
      const target = resolveClientNavigation(notification);
      if (target.kind !== 'none') this.onNavigate(target);
      dismiss();
    };

    toast.addEventListener('click', activate);
    toast.addEventListener('keydown', (e) => {
      if (e.target !== toast) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    // Hide just this toast; the inbox entry stays unread.
    toast.querySelector('.notif-toast-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });

    this.toastStack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('notif-toast-shown'));
    setTimeout(dismiss, TOAST_LIFETIME_MS);
  }
}
