import type { GameClient } from '../network/GameClient';
import type { QuestProgressEntry } from '@idle-party-rpg/shared';
import { sound } from '../audio/SoundManager';
import { readyQuestIds } from './RoomActions';

export type NavMode = 'screen' | 'overlay' | 'submenu' | 'action';

export type QuestBadge = { kind: 'ready' } | { kind: 'count'; count: number } | null;

export function questBadgeFor(activeQuests: readonly QuestProgressEntry[] = []): QuestBadge {
  if (readyQuestIds(activeQuests).size > 0) return { kind: 'ready' };
  if (activeQuests.length > 0) return { kind: 'count', count: activeQuests.length };
  return null;
}

export interface NavSubmenuItem {
  id: string;
  label: string;
  /** Optional badge predicate keyed off game state (returns true when this row should show a dot). */
  badge?: 'friend-requests' | 'party-invites';
}

export interface NavTabConfig {
  id: string;
  label: string;
  icon: string;
  /**
   * - `screen` (default): switches the active screen.
   * - `overlay`: toggles a UI overlay without changing the active screen (Chat).
   * - `submenu`: opens a fly-out submenu above the tab. Each submenu item can
   *   route to a screen (with optional sub-tab id) via `onSubmenuPick`.
   * - `action`: fires `onAction` and keeps no state of its own (Quests).
   */
  mode?: NavMode;
  /** Submenu items shown when this tab is clicked (only when mode === 'submenu'). */
  submenu?: NavSubmenuItem[];
  /**
   * - `bar` (default): one of the big framed buttons in the stone bar.
   * - `perch`: a smaller button perched on the plinth above the bar (Quests, Chat).
   */
  placement?: 'bar' | 'perch';
}

/**
 * Bottom nav: a stone bar of framed icon buttons (the active one rises on a
 * banner), a plinth of perched buttons above it (Quests, Chat),
 * and fly-out submenus (Social). Labels are screen-reader only — the icons
 * carry the meaning, as in most mobile games.
 */
export class BottomNav {
  private container: HTMLElement;
  private tabButtons = new Map<string, HTMLElement>();
  private activeId: string;
  private overlayActiveIds = new Set<string>();
  private chatHasUnread = false;
  private openSubmenuTabId: string | null = null;
  private submenuEl: HTMLElement | null = null;
  /** Latest social state — used to drive submenu badges. */
  private hasFriendRequests = false;
  private hasPartyInvites = false;

  constructor(
    tabs: NavTabConfig[],
    defaultTab: string,
    /** Fires whenever a screen tab is clicked. `wasActive` is true when the
     *  user re-clicked the already-active tab (e.g. for "tap Map again to
     *  recenter on player"). */
    private onTabChange: (tabId: string, wasActive: boolean) => void,
    gameClient: GameClient,
    private onOverlayToggle?: (tabId: string, currentlyActive: boolean) => void,
    private onSubmenuPick?: (tabId: string, itemId: string) => void,
    private onAction?: (tabId: string) => void,
  ) {
    this.activeId = defaultTab;
    this.container = document.getElementById('bottom-nav')!;
    this.container.innerHTML = '';

    const perch = document.createElement('div');
    perch.className = 'nav-perch';
    const bar = document.createElement('div');
    bar.className = 'nav-bar';
    this.container.append(perch, bar);

    for (const tab of tabs) {
      const button = document.createElement('button');
      const mode: NavMode = tab.mode ?? 'screen';
      const placement = tab.placement ?? 'bar';
      button.type = 'button';
      button.className = `nav-tab nav-tab-${mode} nav-tab-${placement}${tab.id === defaultTab ? ' active' : ''}`;
      button.dataset.screen = tab.id;
      button.dataset.mode = mode;
      button.setAttribute('aria-label', tab.label);

      button.innerHTML = `
        <span class="nav-banner" aria-hidden="true"></span>
        <span class="nav-frame gc-frame" aria-hidden="true">
          <span class="nav-icon">${tab.icon}</span>
        </span>
        <span class="nav-label">${tab.label}</span>
        <span class="nav-badge"></span>
      `;

      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleClick(tab);
      });

      (placement === 'perch' ? perch : bar).appendChild(button);
      this.tabButtons.set(tab.id, button);
    }

    // Outside-click closes any open submenu.
    document.addEventListener('click', () => this.closeSubmenu());

    this.wireStatusIndicators(gameClient);
  }

  private handleClick(tab: NavTabConfig): void {
    const mode: NavMode = tab.mode ?? 'screen';
    // Nav buttons are excluded from the global tap sound (SoundEvents) so each
    // mode can speak for itself: screens get the tab "tock", a submenu gets a
    // tap, and overlays (Chat) and actions (Quests) are voiced by ModalStack's open/close.
    if (mode === 'screen') sound.play('tab-switch');
    else if (mode === 'submenu') sound.play('ui-tap');

    if (mode === 'submenu') {
      // Re-clicking the same tab toggles the submenu closed.
      if (this.openSubmenuTabId === tab.id) {
        this.closeSubmenu();
        return;
      }
      this.closeSubmenu();
      this.openSubmenu(tab);
      return;
    }

    this.closeSubmenu();

    if (mode === 'action') {
      this.onAction?.(tab.id);
      return;
    }

    if (mode === 'overlay') {
      const wasActive = this.overlayActiveIds.has(tab.id);
      const button = this.tabButtons.get(tab.id);
      if (wasActive) {
        this.overlayActiveIds.delete(tab.id);
        button?.classList.remove('overlay-active');
      } else {
        this.overlayActiveIds.add(tab.id);
        button?.classList.add('overlay-active');
        if (tab.id === 'chat') {
          this.chatHasUnread = false;
          this.updateChatBadge();
        }
      }
      this.onOverlayToggle?.(tab.id, !wasActive);
      return;
    }

    // Re-clicking the active tab still fires onTabChange — the App can
    // interpret a re-click (e.g. recenter the map on the player) instead
    // of swallowing the event silently.
    const wasActive = this.activeId === tab.id;
    this.setActive(tab.id);
    sessionStorage.setItem('activeScreen', tab.id);
    this.onTabChange(tab.id, wasActive);
  }

  setActive(id: string): void {
    if (this.activeId === id) return;
    const prev = this.tabButtons.get(this.activeId);
    if (prev) prev.classList.remove('active');
    const next = this.tabButtons.get(id);
    if (next) next.classList.add('active');
    this.activeId = id;
  }

  /** External: mark an overlay (Chat) as opened/closed (e.g. when user closes it from the popout itself). */
  setOverlayActive(id: string, active: boolean): void {
    const button = this.tabButtons.get(id);
    if (!button) return;
    if (active) {
      this.overlayActiveIds.add(id);
      button.classList.add('overlay-active');
    } else {
      this.overlayActiveIds.delete(id);
      button.classList.remove('overlay-active');
    }
  }

  /** External: update chat unread state (driven by ChatPopout). */
  setChatUnread(hasUnread: boolean): void {
    this.chatHasUnread = hasUnread;
    this.updateChatBadge();
  }

  // ── Submenu fly-out ────────────────────────────────────────

  private openSubmenu(tab: NavTabConfig): void {
    if (!tab.submenu || tab.submenu.length === 0) return;
    const button = this.tabButtons.get(tab.id);
    if (!button) return;

    this.openSubmenuTabId = tab.id;
    button.classList.add('submenu-open');

    const fly = document.createElement('div');
    fly.className = 'nav-submenu';
    fly.addEventListener('click', (e) => e.stopPropagation());

    for (const item of tab.submenu) {
      const row = document.createElement('button');
      row.className = 'nav-submenu-item';
      row.dataset.item = item.id;
      const showBadge =
        (item.badge === 'friend-requests' && this.hasFriendRequests) ||
        (item.badge === 'party-invites' && this.hasPartyInvites);
      row.innerHTML = `<span class="nav-submenu-label">${item.label}</span>${showBadge ? '<span class="nav-submenu-badge"></span>' : ''}`;
      row.addEventListener('click', () => {
        sound.play('tab-switch');
        this.closeSubmenu();
        this.onSubmenuPick?.(tab.id, item.id);
      });
      fly.appendChild(row);
    }

    document.body.appendChild(fly);
    this.submenuEl = fly;

    // Position the fly-out above the button, horizontally centered, then nudge into viewport.
    requestAnimationFrame(() => {
      const btnRect = button.getBoundingClientRect();
      const flyRect = fly.getBoundingClientRect();
      const margin = 8;
      let left = btnRect.left + btnRect.width / 2 - flyRect.width / 2;
      left = Math.max(margin, Math.min(window.innerWidth - flyRect.width - margin, left));
      const top = btnRect.top - flyRect.height - 6;
      fly.style.left = `${left}px`;
      fly.style.top = `${Math.max(margin, top)}px`;
      fly.classList.add('nav-submenu-shown');
    });
  }

  private closeSubmenu(): void {
    if (this.submenuEl) {
      this.submenuEl.remove();
      this.submenuEl = null;
    }
    if (this.openSubmenuTabId) {
      this.tabButtons.get(this.openSubmenuTabId)?.classList.remove('submenu-open');
      this.openSubmenuTabId = null;
    }
  }

  private updateChatBadge(): void {
    const tab = this.tabButtons.get('chat');
    if (!tab) return;
    const badge = tab.querySelector('.nav-badge');
    if (!badge) return;
    badge.classList.toggle('visible', this.chatHasUnread);
  }

  private wireStatusIndicators(gameClient: GameClient): void {
    let lastVisual = '';

    gameClient.subscribe((state) => {
      const combatTab = this.tabButtons.get('combat');
      const mapTab = this.tabButtons.get('map');
      const visual = state.battle.visual;

      if (combatTab) {
        combatTab.classList.remove('fighting-pulse', 'victory-flash', 'defeat-flash');
        if (visual === 'fighting') {
          combatTab.classList.add('fighting-pulse');
        } else if (visual === 'victory' && lastVisual === 'fighting') {
          combatTab.classList.add('victory-flash');
        } else if (visual === 'defeat' && lastVisual === 'fighting') {
          combatTab.classList.add('defeat-flash');
        }
      }

      if (mapTab) {
        const isMoving = state.party.path.length > 0;
        mapTab.classList.toggle('has-path', isMoving);
      }

      const social = state.social;
      this.hasFriendRequests = (social?.incomingFriendRequests?.length ?? 0) > 0;
      this.hasPartyInvites = (social?.pendingInvites?.length ?? 0) > 0;

      const socialTab = this.tabButtons.get('social');
      if (socialTab) {
        const badge = socialTab.querySelector('.nav-badge');
        if (badge) badge.classList.toggle('visible', this.hasFriendRequests || this.hasPartyInvites);
      }

      // Items badge: gifts in mailbox or trades needing attention
      const itemsTab = this.tabButtons.get('items');
      if (itemsTab && social) {
        const selfUsername = state.username ?? '';
        const hasMailbox = (social.mailbox?.length ?? 0) > 0;
        const tradeNeedsAction = (social.proposedTrades ?? []).some(t =>
          t.lastUpdatedBy && t.lastUpdatedBy !== selfUsername,
        );
        const badge = itemsTab.querySelector('.nav-badge');
        if (badge) badge.classList.toggle('visible', hasMailbox || tradeNeedsAction);
      }

      this.updateQuestBadge(questBadgeFor(state.activeQuests));

      lastVisual = visual;
    });
  }

  private updateQuestBadge(questBadge: QuestBadge): void {
    const tab = this.tabButtons.get('quests');
    const badge = tab?.querySelector<HTMLElement>('.nav-badge');
    if (!tab || !badge) return;
    badge.classList.toggle('visible', questBadge !== null);
    badge.classList.toggle('nav-badge--ready', questBadge?.kind === 'ready');
    badge.classList.toggle('nav-badge--count', questBadge?.kind === 'count');
    badge.textContent = questBadge?.kind === 'ready' ? '!' : questBadge?.kind === 'count' ? String(questBadge.count) : '';
    tab.setAttribute('aria-label', questButtonLabel(questBadge));
  }
}

function questButtonLabel(questBadge: QuestBadge): string {
  if (questBadge?.kind === 'ready') return 'Quests, ready to turn in';
  if (questBadge?.kind === 'count') return `Quests, ${questBadge.count} active`;
  return 'Quests';
}
