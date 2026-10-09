import type { GameClient } from '../network/GameClient';
import type { ChatLocalStore } from '../network/ChatLocalStore';
import type { ServerStateMessage, ClientSocialState, PlayerListEntry, GamePartyMember, HiredHenchman, OtherPlayerState } from '@idle-party-rpg/shared';
import { MAX_PARTY_SIZE, henchmanDisplayNames } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import type { WorldCache } from '../network/WorldCache';
import { esc, emptyStateHtml, portraitHtml, subtitle, tagHtml } from './social/socialHtml';
import { openSocModal } from './social/socialModal';
import type { SocModal } from './social/socialModal';
import { TradeModal } from './social/TradeModal';
import { GiftModal } from './social/GiftModal';
import { ProfileModal } from './social/ProfileModal';
import '../styles/screens/social.css';

type SubTab = 'users' | 'guild' | 'party';
type SortMode = 'name' | 'status' | 'level';
type FilterMode = 'all' | 'friends' | 'guild' | 'room' | 'zone';

// Sub-views. Picked from the top segmented tabs or the bottom-nav fly-out.
// (A stored legacy 'chat' value falls back to 'party' — chat is the global pop-out now.)
const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'party', label: 'Party' },
  { id: 'guild', label: 'Guild' },
  { id: 'users', label: 'Leaderboard' },
];

const FILTERS: { id: FilterMode; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'room', label: 'Room' },
  { id: 'zone', label: 'Zone' },
  { id: 'friends', label: 'Friends' },
  { id: 'guild', label: 'Guild' },
];

/** Formation rows top→bottom, matching the combat screen (party front faces the enemy). */
const DEPTH_LABELS = ['Front', 'Middle', 'Back'];

// Simple emblem glyphs for empty states (inline SVG — no emoji icons).
const EMBLEM_SWORDS = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 6l20 20-3 3L5 9V6zM40 6v3L20 29l-3-3L37 6zM14 30l4 4-6 6-4-4zM34 30l6 6-4 4-6-6z" fill="currentColor"/></svg>';
const EMBLEM_SHIELD = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4l16 6v12c0 10-7 18-16 22C15 40 8 32 8 22V10z" fill="currentColor"/><path d="M24 12v26M14 20h20" stroke="#1a1009" stroke-width="3"/></svg>';
const EMBLEM_SPYGLASS = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" stroke-width="5"/><path d="M28 28l12 12" stroke="currentColor" stroke-width="7" stroke-linecap="round"/></svg>';

const SELF_FLAVOR = [
  'Tis thyself, brave soul. Look not in mirrors for adventure.',
  'You gaze upon thine own visage. Stout fellow!',
  'A noble hero — and curiously vain, to click upon themself.',
  "'Tis you, dear adventurer. Onward to glory!",
  "Behold: thyself. The realm's worst raid is lucky to have you.",
  'Yon reflection is uncommonly handsome today.',
];

/**
 * Social screen — Party / Guild / Leaderboard, plus the dialogs other screens
 * open through it (user popup, View Player, trade, gift).
 *
 * Layout: kit segmented tabs on top (`.gc-tabs`, kept in sync with the
 * bottom-nav fly-out), then the active view. Each view owns its scroll region
 * (`.screen-scroll`), so the screen never scrolls as a whole; the leaderboard
 * pins its search + filters above the list.
 *
 * Rendering: a full view render on tab switch, then per-tick targeted updates
 * (online dots, tab badges) with a structural-key check that re-renders only
 * when the underlying lists change. One delegated click handler survives the
 * innerHTML swaps.
 */
export class SocialScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private chatStore: ChatLocalStore;
  private worldCache: WorldCache;
  private isActive = false;
  private activeTab: SubTab = (() => {
    const stored = sessionStorage.getItem('socialSubTab');
    if (stored && SUB_TABS.some(t => t.id === stored)) return stored as SubTab;
    return 'party';
  })();
  private unsubscribe?: () => void;
  private unsubChat?: () => void;
  private unsubSyncChat?: () => void;

  private tabsEl!: HTMLElement;
  private panelContainer!: HTMLElement;
  private lastSocial: ClientSocialState | null = null;
  private lastState: ServerStateMessage | null = null;
  private searchQuery = '';
  private sortBy: SortMode = 'level';
  private filterBy: FilterMode = 'all';

  /** Open user popup (or self popup) dialog. */
  private popup: SocModal | null = null;

  /** Wired by App.ts to open the chat popout pre-filled for a DM target. */
  private onDmRequest?: (username: string) => void;
  private onVisitHome?: (username: string) => void;

  private trade: TradeModal;
  private gift: GiftModal;
  private profile: ProfileModal;

  // Formation drag-to-reposition state
  private gridDragging = false;
  private gridDragSourcePos: number | null = null;
  private gridDragGhost: HTMLElement | null = null;
  private gridDragHoverCell: HTMLElement | null = null;
  private gridAnimating = false;
  private gridDragHenchmanId: string | null = null;
  /** Henchman held for tap-to-move; the next empty-cell tap places it. */
  private gridPickedUpHenchmanId: string | null = null;
  private canManageHenchmen = false;

  // Structural change detection keys — only re-render when these change
  private lastRenderedUsersKey = '';
  private lastRenderedGuildKey = '';
  private lastRenderedPartyKey = '';

  constructor(containerId: string, gameClient: GameClient, chatStore: ChatLocalStore, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.chatStore = chatStore;
    this.worldCache = worldCache;

    const getState = () => this.freshState();
    const getClass = (u: string) => this.getPlayerClassName(u);
    this.trade = new TradeModal(gameClient, worldCache, getState, getClass);
    this.gift = new GiftModal(gameClient, worldCache, getState, getClass);
    this.profile = new ProfileModal(gameClient, worldCache);

    this.buildDOM();

    // On tab resume, trigger incremental chat sync (no clearing)
    this.gameClient.onResume(() => {
      this.gameClient.sendSyncChat(this.chatStore.getLatestId());
    });
  }

  onActivate(): void {
    this.isActive = true;
    this.unsubscribe = this.gameClient.subscribe((state) => {
      if (this.isActive) this.updateFromState(state);
    });
    // Keep the local chat history store current (O(1) dedup).
    this.unsubChat = this.gameClient.onChat((msg) => {
      this.chatStore.addMessage(msg);
    });
    this.unsubSyncChat = this.gameClient.onSyncChat((messages, full) => {
      this.chatStore.mergeSyncBatch(messages, full);
    });
    this.gameClient.sendSyncChat(this.chatStore.getLatestId());

    const state = this.gameClient.lastState;
    if (state) {
      this.lastSocial = state.social ?? null;
      this.lastState = state;
    }
    this.renderPanel();
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubChat?.();
    this.unsubChat = undefined;
    this.unsubSyncChat?.();
    this.unsubSyncChat = undefined;
    this.dismissPopup();
    this.dismissTradeModal();
    this.gridPickedUpHenchmanId = null;
  }

  /** Switch sub-view — called by the top tabs and the bottom-nav fly-out submenu. */
  setSubTab(tab: string): void {
    if (!SUB_TABS.some(t => t.id === tab)) return;
    if (this.activeTab === tab) return;
    this.activeTab = tab as SubTab;
    sessionStorage.setItem('socialSubTab', this.activeTab);
    this.lastRenderedUsersKey = '';
    this.lastRenderedGuildKey = '';
    this.lastRenderedPartyKey = '';
    this.syncTabs();
    if (this.isActive) this.renderPanel();
  }

  /**
   * Open the chat popout pre-filled for a DM to `username`. Also persists
   * the choice as the user's chat preferences for cross-device sync.
   */
  startDm(username: string): void {
    this.gameClient.sendSetChatPreferences('dm', username);
    this.onDmRequest?.(username);
  }

  /** Wire an external handler that opens the global chat popout to a DM. */
  setOnVisitHome(cb: (username: string) => void): void {
    this.onVisitHome = cb;
  }

  setOnDmRequest(cb: (username: string) => void): void {
    this.onDmRequest = cb;
  }

  /** Open the trade dialog — resumes an existing trade with this player if there is one. */
  openTradeModal(targetUsername: string): void {
    this.trade.open(targetUsername);
  }

  /** Open the trade dialog for an existing trade, identified by trade ID. */
  openExistingTrade(tradeId: string): void {
    this.trade.openExisting(tradeId);
  }

  dismissTradeModal(): void {
    this.trade.dismiss();
  }

  openGiftModal(targetUsername: string): void {
    this.gift.open(targetUsername);
  }

  dismissGiftModal(): void {
    this.gift.dismiss();
  }

  // ── User popup ───────────────────────────────────────────────

  /**
   * Player card for any username tapped across the app (lists, map, combat,
   * chat). `_anchor` is kept for callers; the card is a centered dialog now.
   * Tile coords (from the room view) make the same-room check reliable.
   */
  showUserPopup(username: string, _anchor: HTMLElement, tileCol?: number, tileRow?: number): void {
    this.dismissPopup();
    this.freshState();
    const social = this.lastSocial;
    if (!social) return;

    const selfUsername = this.lastState?.username ?? '';
    if (username === selfUsername) {
      this.showSelfPopup();
      return;
    }

    const friends = new Set(social.friends ?? []);
    const blocked = social.blockedUsers ?? {};
    const incomingFrom = new Set((social.incomingFriendRequests ?? []).map(r => r.fromUsername));
    const outgoingTo = new Set((social.outgoingFriendRequests ?? []).map(r => r.toUsername));
    const guildMembers = new Set((social.guildMembers ?? []).map(m => m.username));
    const partyMembers = new Set((social.party?.members ?? []).map(m => m.username));
    const otherPlayers = this.lastState?.otherPlayers ?? [];
    const sameRoom = tileCol !== undefined && tileRow !== undefined
      ? (this.lastState?.party.col === tileCol && this.lastState?.party.row === tileRow)
      : otherPlayers.some(p => p.username === username && this.isInMyRoom(p));

    const isFriend = friends.has(username);
    const isGuildMember = guildMembers.has(username);
    const isPartyMember = partyMembers.has(username);
    const isBlocked = username in blocked;
    const isOnline = (social.onlinePlayers ?? []).includes(username);
    const entry = social.allPlayers?.find(p => p.username === username);
    const className = this.getPlayerClassName(username);
    const rank = this.rankMap().get(username);

    const tags: string[] = [];
    if (isFriend) tags.push(tagHtml('Friend', 'green'));
    if (isGuildMember) tags.push(tagHtml('Guild', 'teal'));
    if (isPartyMember) tags.push(tagHtml('Party', 'gold'));
    if (isBlocked) tags.push(tagHtml('Blocked', 'red'));

    const act = (action: string, label: string, tone = '') =>
      `<button type="button" class="gc-btn${tone ? ` gc-btn--${tone}` : ''} gc-btn--block" data-popup-action="${action}">${label}</button>`;
    const off = (label: string) => `<button type="button" class="gc-btn gc-btn--block" disabled>${label}</button>`;
    const actions: string[] = [];
    const reasons: string[] = [];

    actions.push(act('chat', 'Chat'));

    if (!isFriend) {
      if (incomingFrom.has(username)) {
        actions.push(act('accept_friend', 'Accept Friend', 'green'));
        actions.push(act('decline_friend', 'Decline Friend', 'red'));
      } else if (outgoingTo.has(username)) {
        actions.push(act('revoke_friend', 'Revoke Request', 'steel'));
      } else {
        actions.push(act('add_friend', 'Add Friend', 'green'));
      }
    }

    if (!isPartyMember) {
      const selfMember = social.party?.members.find(m => m.username === selfUsername);
      const canInvite = selfMember?.role === 'owner' || selfMember?.role === 'leader';
      const seatsUsed = this.partySeatsUsed(social.party);
      const partyFull = seatsUsed >= MAX_PARTY_SIZE;
      const alreadyInvited = (social.outgoingPartyInvites ?? []).includes(username);
      if (!canInvite) {
        actions.push(off('Invite to Party'));
        reasons.push('Only the party owner or a leader can invite.');
      } else if (partyFull) {
        actions.push(off('Invite to Party'));
        reasons.push(`Party is full (${seatsUsed}/${MAX_PARTY_SIZE}) — hired henchmen take a seat too.`);
      } else if (alreadyInvited) {
        actions.push(off('Invited to Party'));
      } else if (!sameRoom) {
        actions.push(off('Invite to Party'));
        reasons.push('Party invites need you both in the same room.');
      } else {
        actions.push(act('party_invite', 'Invite to Party', 'green'));
      }
    }

    if (social.guild && !isGuildMember) {
      actions.push(act('guild_invite', 'Invite to Guild', 'green'));
    }

    // Trades are async — no same-room rule. One active trade per pair.
    if (this.trade.findTradeWith(username)) {
      actions.push(off('Trade'));
      reasons.push('You already have a trade open with this player.');
    } else {
      actions.push(act('trade', 'Trade'));
    }
    actions.push(act('gift', 'Send Gift'));
    if (entry?.hasHouse) actions.push(act('visit_home', 'Visit Home', 'steel'));
    actions.push(isBlocked ? act('unblock', 'Unblock', 'steel') : act('block', 'Block', 'red'));

    const modal = openSocModal({
      title: username,
      variant: 'user',
      onClose: () => { if (this.popup === modal) this.popup = null; },
    });
    this.popup = modal;
    modal.body.innerHTML = `
      <div class="soc-hero">
        ${portraitHtml({ name: username, className, size: 'xl', online: isOnline })}
        <div class="soc-hero__sub">${subtitle(className, this.zoneOf(username)) || 'Adventurer'}</div>
        ${tags.length ? `<div class="soc-tags">${tags.join('')}</div>` : ''}
      </div>
      <div class="soc-stats">
        <div class="gc-stat"><span class="gc-stat__label">Level</span><span class="gc-stat__value">${entry?.level ?? '?'}</span></div>
        <div class="gc-stat"><span class="gc-stat__label">Rank</span><span class="gc-stat__value">${rank ? `#${rank}` : '—'}</span></div>
        <div class="gc-stat soc-stat--word"><span class="gc-stat__label">Status</span><span class="gc-stat__value ${isOnline ? 'is-online' : 'is-offline'}">${isOnline ? 'Online' : 'Offline'}</span></div>
      </div>
      <div class="soc-popup-actions">
        <button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block" data-popup-action="view_player">View Player</button>
        <div class="soc-action-grid">${actions.join('')}</div>
        ${reasons.length ? `<ul class="soc-reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      </div>
    `;

    modal.body.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-popup-action]');
      if (!btn || btn.disabled) return;
      switch (btn.getAttribute('data-popup-action')) {
        case 'view_player': this.profile.show(username); break;
        case 'chat': this.startDm(username); break;
        case 'guild_invite': this.gameClient.sendInviteGuild(username); break;
        case 'accept_friend': this.gameClient.sendAcceptFriendRequest(username); break;
        case 'decline_friend': this.gameClient.sendDeclineFriendRequest(username); break;
        case 'revoke_friend': this.gameClient.sendRevokeFriendRequest(username); break;
        case 'add_friend': this.gameClient.sendFriendRequest(username); break;
        case 'party_invite': this.gameClient.sendInviteParty(username); break;
        case 'block': this.gameClient.sendBlockUser(username, 'all'); break;
        case 'unblock': this.gameClient.sendUnblockUser(username); break;
        case 'trade': this.openTradeModal(username); break;
        case 'gift': this.openGiftModal(username); break;
        case 'visit_home':
          if (this.onVisitHome) this.onVisitHome(username);
          else this.gameClient.sendEnterHome(username);
          break;
      }
      this.dismissPopup();
    });
  }

  /** "This is you" card for taps on your own name — identity + a flavor line. */
  private showSelfPopup(): void {
    const state = this.lastState;
    const username = state?.username ?? '';
    const className = state?.character?.className ?? '';
    const level = state?.character?.level ?? 0;
    const flavor = SELF_FLAVOR[Math.floor(Math.random() * SELF_FLAVOR.length)];

    const modal = openSocModal({
      title: username,
      variant: 'self',
      onClose: () => { if (this.popup === modal) this.popup = null; },
    });
    this.popup = modal;
    modal.body.innerHTML = `
      <div class="soc-hero">
        ${portraitHtml({ name: username, className, size: 'xl', self: true })}
        <div class="soc-hero__sub">${subtitle(className, level ? `Level ${level}` : '')}</div>
        <div class="soc-tags">${tagHtml('You', 'gold')}</div>
      </div>
      <p class="soc-flavor">${esc(flavor)}</p>
    `;
    modal.footer.innerHTML = '<button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block" data-action="close">Onward!</button>';
    modal.footer.querySelector('[data-action="close"]')?.addEventListener('click', () => modal.close());
  }

  private dismissPopup(): void {
    this.popup?.close();
    this.popup = null;
  }

  // ── Layout ───────────────────────────────────────────────────

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="soc">
        <div class="soc-head">
          <div class="gc-tabs soc-tabs" role="tablist" aria-label="Social">
            ${SUB_TABS.map(t => `
              <button type="button" class="gc-tab soc-tab" role="tab" data-subtab="${t.id}" aria-selected="${t.id === this.activeTab}">
                ${t.label}<span class="gc-badge soc-tab__badge" hidden></span>
              </button>`).join('')}
          </div>
        </div>
        <div class="soc-panel" role="tabpanel"></div>
      </div>
    `;
    this.tabsEl = this.container.querySelector('.soc-tabs')!;
    this.panelContainer = this.container.querySelector('.soc-panel')!;
    this.tabsEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-subtab]');
      if (btn) this.setSubTab(btn.getAttribute('data-subtab')!);
    });
    this.wireDelegatedEvents();
  }

  private syncTabs(): void {
    for (const btn of this.tabsEl.querySelectorAll<HTMLElement>('[data-subtab]')) {
      btn.setAttribute('aria-selected', String(btn.getAttribute('data-subtab') === this.activeTab));
    }
  }

  /** Party = pending invites, Leaderboard = incoming friend requests. */
  private updateTabBadges(): void {
    const social = this.lastSocial;
    const counts: Record<string, number> = {
      party: social?.pendingInvites?.length ?? 0,
      users: social?.incomingFriendRequests?.length ?? 0,
    };
    for (const btn of this.tabsEl.querySelectorAll<HTMLElement>('[data-subtab]')) {
      const badge = btn.querySelector<HTMLElement>('.soc-tab__badge');
      if (!badge) continue;
      const n = counts[btn.getAttribute('data-subtab') ?? ''] ?? 0;
      badge.hidden = n === 0;
      badge.textContent = n > 9 ? '9+' : String(n);
    }
  }

  /** Single set of delegated handlers on the panel — survives innerHTML swaps. */
  private wireDelegatedEvents(): void {
    this.panelContainer.addEventListener('click', (e) => {
      if (this.gridDragging) return;
      const target = e.target as HTMLElement;

      // Formation cell
      const cell = target.closest<HTMLElement>('.soc-cell[data-pos]');
      if (cell) {
        this.onCellTap(cell, (e as MouseEvent).detail === 0);
        return;
      }

      const btn = target.closest<HTMLButtonElement>('button');
      if (!btn || btn.disabled) return;

      // Any player name / row → player card
      if (btn.matches('.soc-user-btn')) {
        const username = btn.getAttribute('data-username');
        if (username) this.showUserPopup(username, btn);
        return;
      }

      const username = btn.getAttribute('data-username') || btn.closest('[data-username]')?.getAttribute('data-username') || null;
      const partyId = btn.getAttribute('data-party-id');

      switch (btn.getAttribute('data-action')) {
        case 'promote': if (username) this.gameClient.sendPromotePartyLeader(username); return;
        case 'demote': if (username) this.gameClient.sendDemotePartyMember(username); return;
        case 'transfer': if (username) this.gameClient.sendTransferPartyOwnership(username); return;
        case 'kick': if (username) this.gameClient.sendKickPartyMember(username); return;
        case 'leave-party': this.gameClient.sendLeaveParty(); return;
        case 'dismiss-henchman': {
          const instanceId = btn.getAttribute('data-henchman-instance');
          if (instanceId) this.gameClient.sendDismissHenchman(instanceId);
          return;
        }
        case 'accept-invite': if (partyId) this.gameClient.sendAcceptPartyInvite(partyId); return;
        case 'decline-invite': if (partyId) this.gameClient.sendDeclinePartyInvite(partyId); return;
        case 'nearby-invite':
          if (!username) return;
          this.gameClient.sendInviteParty(username);
          btn.textContent = 'Invited';
          btn.disabled = true;
          return;
        case 'find-players':
          this.filterBy = 'room';
          this.searchQuery = '';
          this.setSubTab('users');
          return;
        case 'leave-guild': this.gameClient.sendLeaveGuild(); return;
        case 'create-guild': this.createGuild(); return;
        case 'filter':
          this.filterBy = (btn.getAttribute('data-filter') as FilterMode) ?? 'all';
          for (const b of this.panelContainer.querySelectorAll('[data-action="filter"]')) {
            b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === this.filterBy));
          }
          this.renderUserRows();
          return;
        case 'sort':
          this.sortBy = this.sortBy === 'level' ? 'status' : this.sortBy === 'status' ? 'name' : 'level';
          btn.textContent = SocialScreen.sortLabel(this.sortBy);
          this.renderUserRows();
          return;
        case 'clear-filters':
          this.searchQuery = '';
          this.filterBy = 'all';
          this.renderUsersPanel();
          return;
        case 'accept-friend': if (username) this.gameClient.sendAcceptFriendRequest(username); return;
        case 'decline-friend': if (username) this.gameClient.sendDeclineFriendRequest(username); return;
      }
    });

    this.panelContainer.addEventListener('input', (e) => {
      const target = e.target as HTMLElement;
      if (target.matches('.soc-search')) {
        this.searchQuery = (target as HTMLInputElement).value;
        this.renderUserRows();
      }
    });

    this.panelContainer.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.matches('.soc-guild-input') && e.key === 'Enter') this.createGuild();
    });

    // Formation drag handlers
    this.panelContainer.addEventListener('mousedown', (e) => this.onGridDragStart(e));
    this.panelContainer.addEventListener('touchstart', (e) => this.onGridDragStart(e), { passive: false });
    document.addEventListener('mousemove', (e) => this.onGridDragMove(e));
    document.addEventListener('touchmove', (e) => this.onGridDragMove(e), { passive: false });
    document.addEventListener('mouseup', (e) => this.onGridDragEnd(e));
    document.addEventListener('touchend', (e) => this.onGridDragEnd(e));
  }

  private createGuild(): void {
    const input = this.panelContainer.querySelector<HTMLInputElement>('.soc-guild-input');
    const name = input?.value.trim();
    if (name) this.gameClient.sendCreateGuild(name);
  }

  private updateFromState(state: ServerStateMessage): void {
    this.lastSocial = state.social ?? null;
    this.lastState = state;
    this.updateTabBadges();

    // Hold the party view still while the formation is animating or dragged.
    if (this.activeTab === 'party' && (this.gridAnimating || this.gridDragging)) return;

    switch (this.activeTab) {
      case 'users': this.updateUsersPanel(); break;
      case 'guild': this.updateGuildPanel(); break;
      case 'party': this.updatePartyPanel(); break;
    }
  }

  private renderPanel(): void {
    this.syncTabs();
    this.updateTabBadges();
    this.panelContainer.setAttribute('data-view', this.activeTab);
    switch (this.activeTab) {
      case 'users': this.renderUsersPanel(); break;
      case 'guild': this.renderGuildPanel(); break;
      case 'party': this.renderPartyPanel(); break;
    }
  }

  /** Swap a view's HTML, keeping the scroll position of its scroll region. */
  private setPanelHtml(html: string): void {
    const top = this.panelContainer.querySelector('.screen-scroll')?.scrollTop ?? 0;
    this.panelContainer.innerHTML = html;
    const scroller = this.panelContainer.querySelector('.screen-scroll');
    if (scroller) scroller.scrollTop = top;
  }

  private loadingHtml(): string {
    return '<div class="soc-loading" role="status">Gathering adventurers…</div>';
  }

  // ── Targeted per-tick updates ────────────────────────────────

  private refreshOnlineDots(): void {
    const onlineSet = new Set(this.lastSocial?.onlinePlayers ?? []);
    for (const dot of this.panelContainer.querySelectorAll<HTMLElement>('.gc-portrait__online')) {
      const username = dot.closest('[data-username]')?.getAttribute('data-username');
      if (!username) continue;
      dot.classList.toggle('is-online', onlineSet.has(username));
    }
  }

  private updateUsersPanel(): void {
    const social = this.lastSocial;
    if (!social) return;
    if (!this.panelContainer.querySelector('.soc-lb')) { this.renderUsersPanel(); return; }
    this.refreshOnlineDots();
    const key = JSON.stringify({
      players: (social.allPlayers ?? []).map(p => `${p.username}:${p.level ?? ''}`),
      friends: social.friends ?? [],
      inReq: (social.incomingFriendRequests ?? []).map(r => r.fromUsername),
      outReq: (social.outgoingFriendRequests ?? []).map(r => r.toUsername),
      blocked: Object.keys(social.blockedUsers ?? {}),
    });
    if (key !== this.lastRenderedUsersKey) {
      this.lastRenderedUsersKey = key;
      // Rebuild requests + rows, keep the toolbar (and the search box focus) intact.
      this.renderFriendRequests();
      this.renderUserRows();
    }
  }

  private updateGuildPanel(): void {
    const social = this.lastSocial;
    if (!social) return;
    this.refreshOnlineDots();
    const key = JSON.stringify({
      guildId: social.guild?.id ?? null,
      leader: social.guild?.leaderUsername ?? null,
      members: (social.guildMembers ?? []).map(m => `${m.username}:${m.role}`),
    });
    if (key !== this.lastRenderedGuildKey) {
      this.lastRenderedGuildKey = key;
      this.renderGuildPanel();
    }
  }

  private updatePartyPanel(): void {
    const social = this.lastSocial;
    if (!social) return;
    this.refreshOnlineDots();
    const party = social.party;
    const key = JSON.stringify({
      partyId: party?.id ?? null,
      members: (party?.members ?? []).map(m => `${m.username}:${m.role}:${m.gridPosition}`),
      henchmen: (party?.henchmen ?? []).map(h => `${h.instanceId}:${h.name ?? ''}:${h.level ?? ''}:${h.artworkUrl ?? ''}:${h.gridPosition}`),
      pending: (social.pendingInvites ?? []).map(i => `${i.partyId}:${i.inviterUsername}`),
      outgoing: social.outgoingPartyInvites ?? [],
      sameTile: this.sameRoomPlayers(),
    });
    if (key !== this.lastRenderedPartyKey) {
      this.lastRenderedPartyKey = key;
      this.renderPartyPanel();
    }
  }

  // ── Player lookups ───────────────────────────────────────────

  /** Pull the latest state — popups can open from other screens while this one is idle. */
  private freshState(): ServerStateMessage | null {
    const fresh = this.gameClient.lastState;
    if (fresh) {
      this.lastSocial = fresh.social ?? null;
      this.lastState = fresh;
    }
    return this.lastState;
  }

  private getPlayerClassName(username: string): string | undefined {
    if (username === this.lastState?.username && this.lastState?.character?.className) {
      return this.lastState.character.className;
    }
    const other = this.lastState?.otherPlayers?.find(p => p.username === username);
    if (other?.className) return other.className;
    return this.lastSocial?.allPlayers?.find(p => p.username === username)?.className;
  }

  private getPlayerLevel(username: string): number | undefined {
    if (username === this.lastState?.username && this.lastState?.character?.level) {
      return this.lastState.character.level;
    }
    return this.lastSocial?.allPlayers?.find(p => p.username === username)?.level;
  }

  /** Zone name for players we can see on the world map (and ourselves). */
  private zoneOf(username: string): string | undefined {
    if (username === this.lastState?.username) return this.lastState?.zoneName || undefined;
    const zoneId = this.lastState?.otherPlayers?.find(p => p.username === username)?.zone;
    return zoneId ? this.worldCache.getZoneName(zoneId) : undefined;
  }

  /** Global standings: level desc, then name. Independent of search / filter. */
  private rankMap(): Map<string, number> {
    const all = [...(this.lastSocial?.allPlayers ?? [])].sort((a, b) => {
      const d = (b.level ?? 0) - (a.level ?? 0);
      return d !== 0 ? d : a.username.localeCompare(b.username);
    });
    return new Map(all.map((p, i) => [p.username, i + 1]));
  }

  /** Same room means same map too; `mapId` is optional on the wire, so absent counts as ours. */
  private isInMyRoom(p: OtherPlayerState): boolean {
    const s = this.lastState;
    if (!s) return false;
    return p.col === s.party.col && p.row === s.party.row && (!p.mapId || p.mapId === s.currentMapId);
  }

  private sameRoomPlayers(): string[] {
    return (this.lastState?.otherPlayers ?? [])
      .filter(p => this.isInMyRoom(p))
      .map(p => p.username)
      .sort();
  }

  /** Members plus henchmen — a henchman takes a seat against MAX_PARTY_SIZE. */
  private partySeatsUsed(party: ClientSocialState['party']): number {
    if (!party) return 0;
    return party.members.length + (party.henchmen?.length ?? 0);
  }

  /** Combat names by instance id, so the party list matches the combat log. */
  private henchmanNames(): Map<string, string> {
    const party = this.lastSocial?.party;
    const henchmen = party?.henchmen ?? [];
    const names = henchmanDisplayNames(henchmen.map(h => h.name ?? 'Henchman'), (party?.members ?? []).map(m => m.username));
    return new Map(henchmen.map((h, i) => [h.instanceId, names[i]]));
  }

  private henchmanPortrait(h: HiredHenchman, name: string, withLevel = true): string {
    return portraitHtml({ name, size: 'sm', imageUrl: h.artworkUrl, glyph: h.emoji, level: withLevel ? h.level : undefined });
  }

  /** Name + subtitle block that opens the player card. */
  private whoHtml(username: string, opts: { online?: boolean; showLevel?: boolean; self?: boolean; sub?: string } = {}): string {
    const className = this.getPlayerClassName(username);
    const level = opts.showLevel === false ? undefined : this.getPlayerLevel(username);
    const sub = opts.sub ?? (subtitle(className, this.zoneOf(username)) || 'Adventurer');
    return `<button type="button" class="soc-who soc-user-btn" data-username="${esc(username)}" aria-label="${esc(username)} — player options">
      ${portraitHtml({ name: username, className, size: 'sm', online: opts.online, level, self: opts.self })}
      <span class="gc-row__main">
        <span class="gc-row__title">${esc(username)}</span>
        <span class="gc-row__sub">${sub}</span>
      </span>
    </button>`;
  }

  // ── Leaderboard ──────────────────────────────────────────────

  private getUsersPanelData() {
    const social = this.lastSocial;
    if (!social) return null;

    const onlineSet = new Set(social.onlinePlayers ?? []);
    const friends = new Set(social.friends ?? []);
    const guildMembers = new Set((social.guildMembers ?? []).map(m => m.username));
    const otherPlayers = this.lastState?.otherPlayers ?? [];
    const myZone = this.lastState?.zoneName ?? '';
    const roomPlayers = new Set(otherPlayers.filter(p => this.isInMyRoom(p)).map(p => p.username));
    const zonePlayers = new Set(otherPlayers.filter(p => p.zone === myZone).map(p => p.username));

    // Self stays in the list so the player can see where they stand.
    let players = [...(social.allPlayers ?? [])];
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      players = players.filter(p => p.username.toLowerCase().includes(q));
    }
    switch (this.filterBy) {
      case 'friends': players = players.filter(p => friends.has(p.username)); break;
      case 'guild': players = players.filter(p => guildMembers.has(p.username)); break;
      case 'room': players = players.filter(p => roomPlayers.has(p.username)); break;
      case 'zone': players = players.filter(p => zonePlayers.has(p.username)); break;
    }

    if (this.sortBy === 'name') {
      players.sort((a, b) => a.username.localeCompare(b.username));
    } else if (this.sortBy === 'level') {
      players.sort((a, b) => {
        const d = (b.level ?? 0) - (a.level ?? 0);
        return d !== 0 ? d : a.username.localeCompare(b.username);
      });
    } else {
      players.sort((a, b) => {
        const ao = onlineSet.has(a.username) ? 0 : 1;
        const bo = onlineSet.has(b.username) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        const af = friends.has(a.username) ? 0 : 1;
        const bf = friends.has(b.username) ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.username.localeCompare(b.username);
      });
    }
    return { players, onlineSet, social };
  }

  private renderUsersPanel(): void {
    const data = this.getUsersPanelData();
    if (!data) { this.panelContainer.innerHTML = this.loadingHtml(); return; }
    this.lastRenderedUsersKey = '';

    this.panelContainer.innerHTML = `
      <div class="soc-lb">
        <div class="soc-lb__toolbar">
          <input class="gc-input soc-search" type="search" enterkeyhint="search" placeholder="Search adventurers…" aria-label="Search players" value="${esc(this.searchQuery)}" />
          <div class="soc-lb__controls">
            <div class="gc-chips soc-lb__chips" role="group" aria-label="Filter">
              ${FILTERS.map(f => `<button type="button" class="gc-chip" data-action="filter" data-filter="${f.id}" aria-pressed="${this.filterBy === f.id}"><span class="gc-chip__face">${f.label}</span></button>`).join('')}
            </div>
            <button type="button" class="gc-btn gc-btn--steel soc-sort" data-action="sort" aria-label="Change sort">${SocialScreen.sortLabel(this.sortBy)}</button>
          </div>
        </div>
        <div class="soc-lb__scroll screen-scroll">
          <div class="soc-lb__requests"></div>
          <div class="soc-count"></div>
          <div class="soc-list soc-lb__list"></div>
        </div>
      </div>
    `;
    this.renderFriendRequests();
    this.renderUserRows();
  }

  private renderFriendRequests(): void {
    const host = this.panelContainer.querySelector<HTMLElement>('.soc-lb__requests');
    const social = this.lastSocial;
    if (!host || !social) return;
    const incoming = social.incomingFriendRequests ?? [];
    const onlineSet = new Set(social.onlinePlayers ?? []);
    host.innerHTML = incoming.length === 0 ? '' : `
      <section class="soc-section soc-section--alert">
        <h2 class="soc-section__title">Friend Requests <span class="gc-badge">${incoming.length}</span></h2>
        <div class="soc-list">
          ${incoming.map(r => `
            <div class="gc-row soc-row" data-username="${esc(r.fromUsername)}">
              ${this.whoHtml(r.fromUsername, { online: onlineSet.has(r.fromUsername) })}
              <div class="soc-row__actions">
                <button type="button" class="gc-btn gc-btn--green" data-action="accept-friend" data-username="${esc(r.fromUsername)}">Accept</button>
                <button type="button" class="gc-btn gc-btn--red" data-action="decline-friend" data-username="${esc(r.fromUsername)}">Decline</button>
              </div>
            </div>`).join('')}
        </div>
      </section>`;
  }

  private renderUserRows(): void {
    const data = this.getUsersPanelData();
    if (!data) return;
    const list = this.panelContainer.querySelector<HTMLElement>('.soc-lb__list');
    const count = this.panelContainer.querySelector<HTMLElement>('.soc-count');
    if (count) count.textContent = `${data.players.length} adventurer${data.players.length !== 1 ? 's' : ''}`;
    if (list) list.innerHTML = this.renderUserListHtml(data.players, data.onlineSet);
  }

  private renderUserListHtml(players: PlayerListEntry[], onlineSet: Set<string>): string {
    if (players.length === 0) {
      const filtered = this.searchQuery !== '' || this.filterBy !== 'all';
      return emptyStateHtml({
        emblem: EMBLEM_SPYGLASS,
        title: 'No adventurers here',
        body: filtered
          ? 'Nobody matches that search. Try another name or widen the filter.'
          : 'The realm is quiet. Check back soon.',
        actionHtml: filtered ? '<button type="button" class="gc-btn gc-btn--gold gc-btn--lg" data-action="clear-filters">Show Everyone</button>' : '',
      });
    }
    const ranks = this.rankMap();
    const row = (p: PlayerListEntry) => this.renderUserRow(p, onlineSet, ranks.get(p.username));
    if (this.sortBy === 'status') {
      const on = players.filter(p => onlineSet.has(p.username));
      const offl = players.filter(p => !onlineSet.has(p.username));
      return `
        <h2 class="soc-section__title">Online <span class="soc-section__count">${on.length}</span></h2>
        ${on.length === 0 ? '<p class="soc-muted">Nobody online right now.</p>' : on.map(row).join('')}
        <h2 class="soc-section__title">Offline <span class="soc-section__count">${offl.length}</span></h2>
        ${offl.length === 0 ? '<p class="soc-muted">Everyone is online!</p>' : offl.map(row).join('')}
      `;
    }
    return players.map(row).join('');
  }

  private renderUserRow(p: PlayerListEntry, onlineSet: Set<string>, rank?: number): string {
    const social = this.lastSocial;
    const isSelf = p.username === (this.lastState?.username ?? '');
    const isFriend = (social?.friends ?? []).includes(p.username);
    const isBlocked = p.username in (social?.blockedUsers ?? {});
    const hasIncoming = (social?.incomingFriendRequests ?? []).some(r => r.fromUsername === p.username);
    const hasSent = (social?.outgoingFriendRequests ?? []).some(r => r.toUsername === p.username);

    let tag = '';
    if (isSelf) tag = tagHtml('You', 'gold');
    else if (isFriend) tag = tagHtml('Friend', 'green');
    else if (hasIncoming) tag = tagHtml('Request', 'green');
    else if (hasSent) tag = tagHtml('Pending', 'steel');
    if (isBlocked) tag += tagHtml('Blocked', 'red');

    const rankHtml = rank
      ? `<span class="soc-rank${rank <= 3 ? ` soc-rank--${rank}` : ''}" aria-label="Rank ${rank}">${rank}</span>`
      : '<span class="soc-rank" aria-hidden="true"></span>';
    const sub = subtitle(p.className, this.zoneOf(p.username)) || 'Adventurer';

    return `<button type="button" class="gc-row soc-row soc-row--rank soc-user-btn${isSelf ? ' is-self' : ''}" data-username="${esc(p.username)}">
      ${rankHtml}
      ${portraitHtml({ name: p.username, className: p.className, size: 'sm', online: onlineSet.has(p.username), self: isSelf })}
      <span class="gc-row__main">
        <span class="gc-row__title">${esc(p.username)}</span>
        <span class="gc-row__sub">${sub}</span>
      </span>
      ${tag ? `<span class="soc-row__tags">${tag}</span>` : ''}
      ${p.level !== undefined && p.level !== null ? `<span class="gc-badge gc-badge--level soc-row__level" aria-label="Level ${p.level}">${p.level}</span>` : ''}
    </button>`;
  }

  private static sortLabel(mode: SortMode): string {
    if (mode === 'level') return 'Top';
    if (mode === 'status') return 'Status';
    return 'A–Z';
  }

  // ── Guild ────────────────────────────────────────────────────

  private renderGuildPanel(): void {
    const social = this.lastSocial;
    if (!social) { this.panelContainer.innerHTML = this.loadingHtml(); return; }

    const guild = social.guild;
    if (!guild) {
      this.setPanelHtml(`
        <div class="soc-view screen-scroll">
          <div class="soc-stack">
            ${emptyStateHtml({
              emblem: EMBLEM_SHIELD,
              title: 'No guild yet',
              body: 'Raise a banner and gather adventurers under one name. Founding a guild takes level 20.',
              actionHtml: `<div class="soc-guild-form">
                <input class="gc-input soc-guild-input" type="text" placeholder="Guild name" maxlength="20" aria-label="Guild name" enterkeyhint="done" />
                <button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block" data-action="create-guild">Found Guild</button>
              </div>`,
            })}
          </div>
        </div>
      `);
      return;
    }

    const members = social.guildMembers ?? [];
    const onlineSet = new Set(social.onlinePlayers ?? []);
    const selfUsername = this.lastState?.username ?? '';
    const onlineCount = members.filter(m => onlineSet.has(m.username)).length;
    const sorted = [...members].sort((a, b) => {
      if (a.role !== b.role) return a.role === 'leader' ? -1 : 1;
      const ao = onlineSet.has(a.username) ? 0 : 1;
      const bo = onlineSet.has(b.username) ? 0 : 1;
      return ao !== bo ? ao - bo : a.username.localeCompare(b.username);
    });

    this.setPanelHtml(`
      <div class="soc-view screen-scroll">
        <div class="soc-stack">
          <section class="gc-card soc-guild">
            <span class="soc-guild__crest gc-frame" aria-hidden="true"><span>${esc(guild.name.charAt(0).toUpperCase())}</span></span>
            <div class="soc-guild__info">
              <h2 class="soc-guild__name">${esc(guild.name)}</h2>
              <div class="soc-guild__meta">Led by ${esc(guild.leaderUsername)}</div>
              <div class="soc-guild__meta">${members.length} member${members.length !== 1 ? 's' : ''} · ${onlineCount} online</div>
            </div>
          </section>
          <section class="soc-section">
            <h2 class="soc-section__title">Members <span class="soc-section__count">${members.length}</span></h2>
            <div class="soc-list">
              ${sorted.map(m => `
                <div class="gc-row soc-row" data-username="${esc(m.username)}">
                  ${this.whoHtml(m.username, { online: onlineSet.has(m.username), self: m.username === selfUsername })}
                  <span class="soc-row__tags">
                    ${m.role === 'leader' ? tagHtml('Leader', 'gold') : ''}
                    ${m.username === selfUsername ? tagHtml('You', 'steel') : ''}
                  </span>
                </div>`).join('')}
            </div>
          </section>
          <div class="soc-footer-actions">
            <button type="button" class="gc-btn gc-btn--red" data-action="leave-guild">Leave Guild</button>
          </div>
        </div>
      </div>
    `);
  }

  // ── Party ────────────────────────────────────────────────────

  private renderPartyPanel(): void {
    const social = this.lastSocial;
    const party = social?.party;
    if (!social || !party) { this.panelContainer.innerHTML = this.loadingHtml(); return; }

    const selfUsername = this.lastState?.username ?? '';
    const selfRole = party.members.find(m => m.username === selfUsername)?.role ?? 'member';
    const isOwner = selfRole === 'owner';
    const isLeaderOrOwner = isOwner || selfRole === 'leader';
    const isSolo = party.members.length === 1;
    const onlineSet = new Set(social.onlinePlayers ?? []);
    const partyNames = new Set(party.members.map(m => m.username));
    this.canManageHenchmen = isLeaderOrOwner;
    const henchmen = party.henchmen ?? [];
    const henchNames = this.henchmanNames();
    const isAlone = isSolo && henchmen.length === 0;
    if (this.gridPickedUpHenchmanId && (!isLeaderOrOwner || !henchmen.some(h => h.instanceId === this.gridPickedUpHenchmanId))) {
      this.gridPickedUpHenchmanId = null;
    }

    // Invites waiting on this player
    const pending = social.pendingInvites ?? [];
    const invitesHtml = pending.length === 0 ? '' : `
      <section class="soc-section soc-section--alert">
        <h2 class="soc-section__title">Party Invites <span class="gc-badge">${pending.length}</span></h2>
        <div class="soc-list">
          ${pending.map(inv => `
            <div class="gc-row soc-row" data-party-id="${esc(inv.partyId)}">
              ${this.whoHtml(inv.inviterUsername, { online: onlineSet.has(inv.inviterUsername), sub: 'Invites you to their party' })}
              <div class="soc-row__actions">
                <button type="button" class="gc-btn gc-btn--green" data-action="accept-invite" data-party-id="${esc(inv.partyId)}">Join</button>
                <button type="button" class="gc-btn gc-btn--red" data-action="decline-invite" data-party-id="${esc(inv.partyId)}">Decline</button>
              </div>
            </div>`).join('')}
        </div>
      </section>`;

    // Players in the same room who aren't with us — owner/leader can invite them.
    const nearby = this.sameRoomPlayers().filter(p => !partyNames.has(p));
    const outgoing = new Set(social.outgoingPartyInvites ?? []);
    const nearbyHtml = !isLeaderOrOwner ? '' : `
      <section class="soc-section">
        <h2 class="soc-section__title">In This Room <span class="soc-section__count">${nearby.length}</span></h2>
        ${nearby.length === 0
          ? '<p class="soc-muted">No one else is in this room right now. Travel to a friend, or wait for someone to wander by.</p>'
          : `<div class="soc-list">${nearby.map(p => {
            const invited = outgoing.has(p);
            return `<div class="gc-row soc-row" data-username="${esc(p)}">
              ${this.whoHtml(p, { online: true })}
              <div class="soc-row__actions soc-row__actions--inline">
                <button type="button" class="gc-btn gc-btn--green" data-action="nearby-invite" data-username="${esc(p)}"${invited ? ' disabled' : ''}>${invited ? 'Invited' : 'Invite'}</button>
              </div>
            </div>`;
          }).join('')}</div>`}
      </section>`;

    const soloHtml = !isAlone ? '' : emptyStateHtml({
      emblem: EMBLEM_SWORDS,
      title: "You're adventuring solo",
      body: 'Every class fights better together. Invite someone in your room to share battles and loot.',
      actionHtml: '<button type="button" class="gc-btn gc-btn--gold gc-btn--lg" data-action="find-players">Find Adventurers</button>',
    });

    const memberActions = (m: GamePartyMember): string => {
      if (m.username === selfUsername) return '';
      const u = esc(m.username);
      const a: string[] = [];
      if (isOwner) {
        if (m.role === 'member') a.push(`<button type="button" class="gc-btn gc-btn--green" data-action="promote" data-username="${u}">Promote</button>`);
        if (m.role === 'leader') a.push(`<button type="button" class="gc-btn gc-btn--steel" data-action="demote" data-username="${u}">Demote</button>`);
        a.push(`<button type="button" class="gc-btn" data-action="transfer" data-username="${u}">Make Owner</button>`);
        a.push(`<button type="button" class="gc-btn gc-btn--red" data-action="kick" data-username="${u}">Kick</button>`);
      } else if (selfRole === 'leader') {
        if (m.role === 'member') a.push(`<button type="button" class="gc-btn gc-btn--green" data-action="promote" data-username="${u}">Promote</button>`);
        if (m.role !== 'owner') a.push(`<button type="button" class="gc-btn gc-btn--red" data-action="kick" data-username="${u}">Kick</button>`);
      }
      return a.length ? `<div class="soc-row__actions">${a.join('')}</div>` : '';
    };

    const roleTag = (m: GamePartyMember) =>
      m.role === 'owner' ? tagHtml('Owner', 'gold') : m.role === 'leader' ? tagHtml('Leader', 'teal') : '';

    const henchmenHtml = henchmen.map(h => {
      const name = henchNames.get(h.instanceId) ?? 'Henchman';
      return `<div class="gc-row soc-row soc-row--hench" data-henchman-instance="${esc(h.instanceId)}">
        <div class="soc-who soc-who--static">
          ${this.henchmanPortrait(h, name)}
          <span class="gc-row__main">
            <span class="gc-row__title">${esc(name)}</span>
            <span class="gc-row__sub">${subtitle('Henchman', h.level !== undefined ? `Level ${h.level}` : '')}</span>
          </span>
        </div>
        <span class="soc-row__tags">${tagHtml('Hired', 'teal')}</span>
        ${isLeaderOrOwner ? `<div class="soc-row__actions">
          <button type="button" class="gc-btn gc-btn--red" data-action="dismiss-henchman" data-henchman-instance="${esc(h.instanceId)}" aria-label="Dismiss ${esc(name)}">Dismiss</button>
        </div>` : ''}
      </div>`;
    }).join('');

    const membersHtml = `
      <section class="soc-section">
        <h2 class="soc-section__title">Party <span class="soc-section__count">${this.partySeatsUsed(party)}/${MAX_PARTY_SIZE}</span></h2>
        <div class="soc-list">
          ${party.members.map(m => `
            <div class="gc-row soc-row${m.username === selfUsername ? ' is-self' : ''}" data-username="${esc(m.username)}">
              ${this.whoHtml(m.username, { online: onlineSet.has(m.username), self: m.username === selfUsername })}
              <span class="soc-row__tags">${roleTag(m)}${m.username === selfUsername ? tagHtml('You', 'steel') : ''}</span>
              ${memberActions(m)}
            </div>`).join('')}
          ${henchmenHtml}
        </div>
      </section>`;

    this.setPanelHtml(`
      <div class="soc-view screen-scroll">
        <div class="soc-stack">
          ${invitesHtml}
          ${soloHtml}
          ${this.formationHtml()}
          ${isAlone ? '' : membersHtml}
          ${nearbyHtml}
          ${isSolo ? '' : `<div class="soc-footer-actions">
            <button type="button" class="gc-btn gc-btn--red" data-action="leave-party">Leave Party</button>
          </div>`}
        </div>
      </div>
    `);
  }

  /**
   * 3×3 formation, laid out like the combat screen: each grid row is a lane
   * (a screen column) and grid column 2 is the front line, drawn on top
   * nearest the enemy.
   */
  private formationHtml(): string {
    const party = this.lastSocial?.party;
    if (!party) return '';
    const selfUsername = this.lastState?.username ?? '';
    const onlineSet = new Set(this.lastSocial?.onlinePlayers ?? []);
    const byPos = new Map<number, GamePartyMember>(party.members.map(m => [m.gridPosition as number, m]));
    const henchByPos = new Map<number, HiredHenchman>((party.henchmen ?? []).map(h => [h.gridPosition as number, h]));
    const henchNames = this.henchmanNames();

    let cells = '';
    for (let depth = 0; depth < 3; depth++) {
      cells += `<span class="soc-formation__depth" style="grid-row:${depth + 2}">${DEPTH_LABELS[depth]}</span>`;
      for (let lane = 0; lane < 3; lane++) {
        const pos = lane * 3 + (2 - depth);
        const member = byPos.get(pos);
        const hench = member ? undefined : henchByPos.get(pos);
        cells += hench
          ? this.henchCellHtml(pos, hench, henchNames.get(hench.instanceId) ?? 'Henchman', depth, lane)
          : this.cellHtml(pos, member, selfUsername, onlineSet, depth, lane);
      }
    }

    return `
      <section class="gc-card soc-formation">
        <div class="soc-formation__head">
          <h2 class="soc-section__title">Formation</h2>
          <span class="soc-formation__hint" aria-live="polite">${esc(this.formationHint())}</span>
        </div>
        <div class="soc-formation__grid">
          <span class="soc-formation__enemy" aria-hidden="true">▲ Enemies ▲</span>
          ${cells}
        </div>
      </section>`;
  }

  private cellHtml(pos: number, member: GamePartyMember | undefined, selfUsername: string, onlineSet: Set<string>, depth: number, lane: number): string {
    const place = `grid-row:${depth + 2};grid-column:${lane + 2}`;
    const where = `${DEPTH_LABELS[depth]} row, lane ${lane + 1}`;
    if (!member) {
      return `<button type="button" class="soc-cell" data-pos="${pos}" style="${place}" aria-label="${where}: empty — move here">
        <span class="soc-cell__plus" aria-hidden="true">+</span>
      </button>`;
    }
    const isSelf = member.username === selfUsername;
    const role = member.role === 'owner' ? '<span class="soc-cell__role soc-cell__role--owner" aria-hidden="true">★</span>'
      : member.role === 'leader' ? '<span class="soc-cell__role" aria-hidden="true">★</span>' : '';
    return `<button type="button" class="soc-cell is-occupied${isSelf ? ' is-self' : ''}" data-pos="${pos}" data-username="${esc(member.username)}" style="${place}" aria-label="${where}: ${esc(member.username)}${isSelf ? ' (you)' : ''}">
      ${portraitHtml({ name: member.username, className: this.getPlayerClassName(member.username), size: 'sm', online: onlineSet.has(member.username), self: isSelf })}
      <span class="soc-cell__name">${esc(member.username)}</span>
      ${role}
    </button>`;
  }

  private henchCellHtml(pos: number, h: HiredHenchman, name: string, depth: number, lane: number): string {
    const place = `grid-row:${depth + 2};grid-column:${lane + 2}`;
    const where = `${DEPTH_LABELS[depth]} row, lane ${lane + 1}`;
    const movable = this.canManageHenchmen;
    const picked = movable && this.gridPickedUpHenchmanId === h.instanceId;
    const cls = `soc-cell is-occupied is-henchman${movable ? ' is-movable' : ''}${picked ? ' is-picked' : ''}`;
    return `<button type="button" class="${cls}" data-pos="${pos}" data-henchman-instance="${esc(h.instanceId)}" style="${place}" aria-label="${where}: ${esc(name)} (henchman)${movable ? ' — tap to pick up' : ''}"${movable ? ` aria-pressed="${picked}"` : ''}>
      ${this.henchmanPortrait(h, name, false)}
      <span class="soc-cell__name">${esc(name)}</span>
      <span class="soc-cell__role soc-cell__role--hire" aria-hidden="true">H</span>
    </button>`;
  }

  private formationHint(): string {
    const id = this.gridPickedUpHenchmanId;
    if (id) return `Tap an empty spot to move ${this.henchmanNames().get(id) ?? 'your henchman'}`;
    if (this.canManageHenchmen && (this.lastSocial?.party?.henchmen?.length ?? 0) > 0) return 'Tap or drag to move you or a henchman';
    return 'Tap or drag to a spot to move';
  }

  // ── Formation repositioning ──────────────────────────────────

  /** `keyboard`: a click with no pointer — pointer taps on a henchman are handled in onGridDragEnd. */
  private onCellTap(cell: HTMLElement, keyboard: boolean): void {
    const pos = parseInt(cell.getAttribute('data-pos') ?? '', 10);
    if (isNaN(pos)) return;
    if (cell.classList.contains('is-occupied')) {
      if (cell.classList.contains('is-movable')) {
        if (keyboard) this.togglePickedUp(cell.getAttribute('data-henchman-instance'));
        return;
      }
      // Someone else's spot → shake no
      if (!cell.classList.contains('is-self')) this.flashGridCell(cell);
      return;
    }
    const henchId = this.canManageHenchmen ? this.gridPickedUpHenchmanId : null;
    this.setGridPickedUp(null);
    this.animateGridMove(pos, henchId);
    this.gameClient.sendSetPartyGridPosition(pos, henchId ?? undefined);
  }

  private togglePickedUp(instanceId: string | null): void {
    this.setGridPickedUp(instanceId && instanceId !== this.gridPickedUpHenchmanId ? instanceId : null);
  }

  private setGridPickedUp(instanceId: string | null): void {
    this.gridPickedUpHenchmanId = instanceId;
    for (const cell of this.panelContainer.querySelectorAll<HTMLElement>('.soc-cell.is-movable[data-henchman-instance]')) {
      const held = cell.getAttribute('data-henchman-instance') === instanceId;
      cell.classList.toggle('is-picked', held);
      cell.setAttribute('aria-pressed', String(held));
    }
    const hint = this.panelContainer.querySelector('.soc-formation__hint');
    if (hint) hint.textContent = this.formationHint();
  }

  private flashGridCell(cell: HTMLElement): void {
    cell.classList.remove('is-denied');
    void cell.offsetWidth;
    cell.classList.add('is-denied');
    cell.addEventListener('animationend', () => cell.classList.remove('is-denied'), { once: true });
  }

  /** Tilt-and-slide the player's own cell (or the named henchman's) toward the target, then swap optimistically. */
  private animateGridMove(targetPos: number, henchmanInstanceId?: string | null): void {
    const party = this.lastSocial?.party;
    if (!party) return;
    const srcPos = henchmanInstanceId
      ? (party.henchmen ?? []).find(h => h.instanceId === henchmanInstanceId)?.gridPosition
      : party.members.find(m => m.username === this.lastState?.username)?.gridPosition;
    if (srcPos === undefined) return;

    const grid = this.panelContainer.querySelector('.soc-formation__grid');
    const src = grid?.querySelector<HTMLElement>(`.soc-cell[data-pos="${srcPos}"]`);
    const dst = grid?.querySelector<HTMLElement>(`.soc-cell[data-pos="${targetPos}"]`);
    if (!src || !dst) return;

    const a = src.getBoundingClientRect();
    const b = dst.getBoundingClientRect();
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    const tilt = Math.sign(dx) * 8 + Math.sign(dy) * 4;
    src.style.setProperty('--tilt', `${tilt}deg`);
    src.style.setProperty('--move-x', `${dx}px`);
    src.style.setProperty('--move-y', `${dy}px`);

    this.gridAnimating = true;
    void src.offsetWidth;
    src.classList.add('is-moving');
    src.addEventListener('animationend', () => {
      src.classList.remove('is-moving');
      src.style.removeProperty('--tilt');
      src.style.removeProperty('--move-x');
      src.style.removeProperty('--move-y');
      // Swap contents + state so the player shows in the new spot right away.
      const swap = (attr: string) => {
        const av = src.getAttribute(attr);
        const bv = dst.getAttribute(attr);
        if (bv === null) src.removeAttribute(attr); else src.setAttribute(attr, bv);
        if (av === null) dst.removeAttribute(attr); else dst.setAttribute(attr, av);
      };
      const html = src.innerHTML;
      src.innerHTML = dst.innerHTML;
      dst.innerHTML = html;
      for (const attr of ['data-username', 'data-henchman-instance', 'aria-label', 'aria-pressed']) swap(attr);
      for (const c of ['is-occupied', 'is-self', 'is-henchman', 'is-movable', 'is-picked']) {
        const had = src.classList.contains(c);
        src.classList.toggle(c, dst.classList.contains(c));
        dst.classList.toggle(c, had);
      }
      this.gridAnimating = false;
    }, { once: true });
  }

  private onGridDragStart(e: MouseEvent | TouchEvent): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.soc-cell.is-self[data-pos], .soc-cell.is-movable[data-pos]');
    if (!cell) return;
    const selfUsername = this.lastState?.username;
    if (!selfUsername) return;
    const henchId = cell.getAttribute('data-henchman-instance');
    const hench = henchId ? (this.lastSocial?.party?.henchmen ?? []).find(h => h.instanceId === henchId) : undefined;
    if (henchId && (!hench || !this.canManageHenchmen)) return;

    e.preventDefault();
    this.gridDragging = true;
    this.gridDragSourcePos = parseInt(cell.getAttribute('data-pos')!, 10);
    this.gridDragHenchmanId = hench?.instanceId ?? null;

    const ghost = document.createElement('div');
    ghost.className = 'soc-drag-ghost';
    if (hench) {
      const name = this.henchmanNames().get(hench.instanceId) ?? 'Henchman';
      ghost.innerHTML = `${this.henchmanPortrait(hench, name, false)}<span>${esc(name)}</span>`;
    } else {
      ghost.innerHTML = `${portraitHtml({ name: selfUsername, className: this.getPlayerClassName(selfUsername), size: 'sm', self: true })}<span>${esc(selfUsername)}</span>`;
    }
    document.body.appendChild(ghost);
    this.gridDragGhost = ghost;
    const { clientX, clientY } = this.getPointerXY(e);
    this.placeGhost(clientX, clientY);
  }

  private placeGhost(x: number, y: number): void {
    if (!this.gridDragGhost) return;
    this.gridDragGhost.style.left = `${x - 28}px`;
    this.gridDragGhost.style.top = `${y - 28}px`;
  }

  private onGridDragMove(e: MouseEvent | TouchEvent): void {
    if (!this.gridDragging || !this.gridDragGhost) return;
    e.preventDefault();
    const { clientX, clientY } = this.getPointerXY(e);
    this.placeGhost(clientX, clientY);

    const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const cell = under?.closest<HTMLElement>('.soc-cell[data-pos]') ?? null;
    const valid = cell && parseInt(cell.getAttribute('data-pos')!, 10) !== this.gridDragSourcePos ? cell : null;
    if (valid === this.gridDragHoverCell) return;
    this.gridDragHoverCell?.classList.remove('is-drop-ok', 'is-drop-bad');
    this.gridDragHoverCell = valid;
    valid?.classList.add(valid.classList.contains('is-occupied') ? 'is-drop-bad' : 'is-drop-ok');
  }

  private onGridDragEnd(e: MouseEvent | TouchEvent): void {
    if (!this.gridDragging) return;
    this.gridDragging = false;
    const henchId = this.gridDragHenchmanId;
    this.gridDragHenchmanId = null;
    this.gridDragGhost?.remove();
    this.gridDragGhost = null;
    this.gridDragHoverCell?.classList.remove('is-drop-ok', 'is-drop-bad');
    this.gridDragHoverCell = null;

    const { clientX, clientY } = this.getPointerXY(e);
    const cell = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>('.soc-cell[data-pos]');
    const source = this.gridDragSourcePos;
    this.gridDragSourcePos = null;
    if (!cell) return;
    const pos = parseInt(cell.getAttribute('data-pos')!, 10);
    if (isNaN(pos)) return;
    if (pos === source) {
      // Tap lands here, not in the click handler: onGridDragStart's preventDefault eats the synthetic touch click.
      this.togglePickedUp(henchId);
      return;
    }
    if (cell.classList.contains('is-occupied')) {
      this.flashGridCell(cell);
    } else {
      this.setGridPickedUp(null);
      this.animateGridMove(pos, henchId);
      this.gameClient.sendSetPartyGridPosition(pos, henchId ?? undefined);
    }
  }

  private getPointerXY(e: MouseEvent | TouchEvent): { clientX: number; clientY: number } {
    if ('touches' in e) {
      const t = e.changedTouches?.[0] ?? e.touches?.[0];
      return t ? { clientX: t.clientX, clientY: t.clientY } : { clientX: 0, clientY: 0 };
    }
    return { clientX: e.clientX, clientY: e.clientY };
  }
}
