import type { GameClient } from '../network/GameClient';
import type { ChatMessage, ChatChannelType, ServerStateMessage } from '@idle-party-rpg/shared';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { chatFocusTracker } from '../network/ChatFocusTracker';
import '../styles/screens/chat.css';

const STORAGE_KEY_GEOMETRY = 'chatPopoutGeometry';
const STORAGE_KEY_FILTERS = 'chatPopoutFilters';
const STORAGE_KEY_MOBILE_LAYOUT = 'chatPopoutMobileLayout';
/** Browser-level memory of whether chat was open last time. */
const STORAGE_KEY_OPEN = 'chatPopoutOpen';
/** Desktop maximize toggle — true means the chat is full-screen. */
const STORAGE_KEY_DESKTOP_MAX = 'chatPopoutDesktopMax';

const DEFAULT_FILTERS: Record<ChatChannelType, boolean> = {
  global: true,
  zone: true,
  tile: true,
  party: true,
  guild: true,
  dm: true,
  server: true,
};

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

type MobileLayout = 'full' | 'sheet';

const CHANNEL_LABELS: Record<ChatChannelType, string> = {
  global: 'Global',
  zone: 'Zone',
  tile: 'Room',
  party: 'Party',
  guild: 'Guild',
  dm: 'DM',
  server: 'Server',
};

/** Channel accent colors — tuned to read on the slate chat panel. */
const CHANNEL_COLORS: Record<ChatChannelType, string> = {
  global: '#ffe7a0',
  zone: '#8cc4ff',
  tile: '#ffc36b',
  party: '#9ef07a',
  guild: '#c49bff',
  dm: '#ff9ad5',
  server: '#b7bec9',
};

/** Consecutive messages from one sender on one channel within this window share a header. */
const GROUP_WINDOW_MS = 3 * 60 * 1000;
/** Distance from the bottom (px) still treated as "following the live feed". */
const STICK_THRESHOLD_PX = 80;

const ICON_EXPAND = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * Floating, draggable, resizable chat window — overlays whichever screen is
 * active. Mobile gets a non-draggable full-screen / bottom-sheet variant
 * (toggled via a layout button).
 */
export class ChatPopout {
  private root: HTMLElement;
  private window!: HTMLElement;
  private timelineEl!: HTMLElement;
  private filtersEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private channelSelect!: HTMLSelectElement;
  private dmInput!: HTMLInputElement;
  private dmRow!: HTMLElement;
  private composerEl!: HTMLElement;
  private layoutBtn!: HTMLButtonElement;
  private jumpBtn!: HTMLButtonElement;

  private gameClient: GameClient;
  private isOpen = false;
  private messages: ChatMessage[] = [];
  private filters: Record<ChatChannelType, boolean>;
  private mobileLayout: MobileLayout;
  private desktopMaximized = false;
  private syncedOnce = false;

  /** Toggle handler invoked when chat is closed (so the nav can clear active state). */
  private onClose?: () => void;
  /** Callback the bottom nav uses to update its unread badge. */
  private onUnreadChange?: (hasUnread: boolean) => void;
  /** Callback to open the user popup when a sender name is clicked in the timeline. */
  private onUserClick?: (username: string, anchor: HTMLElement) => void;
  private hasUnread = false;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.filters = this.loadFilters();
    this.mobileLayout = (localStorage.getItem(STORAGE_KEY_MOBILE_LAYOUT) as MobileLayout) ?? 'sheet';
    this.desktopMaximized = localStorage.getItem(STORAGE_KEY_DESKTOP_MAX) === '1';

    this.root = document.getElementById('chat-popout-root')!;
    this.buildDOM();

    gameClient.onChat((msg) => this.handleChatMessage(msg));
    // Sync responses are *always* merged, never replaced. The server's `full`
    // flag means "your sync is consistent" (i.e. your sinceId was honored), not
    // "this is the entire chat history" — so a successful incremental response
    // arrives with `full: true` and only the new messages. Replacing on
    // `full: true` was wiping chat on tab resume.
    gameClient.onSyncChat((messages) => {
      let added = false;
      for (const m of messages) {
        if (!this.messages.find(x => x.id === m.id)) {
          this.messages.push(m);
          added = true;
        }
      }
      if (added) {
        this.messages.sort((a, b) => a.timestamp - b.timestamp);
        this.renderTimeline();
      }
    });
    gameClient.subscribe((_state: ServerStateMessage) => {
      // First state: ask server for the chat backlog (no sinceId → last batch).
      if (!this.syncedOnce) {
        this.syncedOnce = true;
        gameClient.sendSyncChat();
      }
    });
    // On tab resume, fetch any messages we missed while the tab was hidden.
    // Pass the latest-known message ID so the server can do an incremental sync.
    gameClient.onResume(() => {
      const latestId = this.getLatestId();
      gameClient.sendSyncChat(latestId);
    });
  }

  setOnClose(cb: () => void): void { this.onClose = cb; }
  setOnUnreadChange(cb: (hasUnread: boolean) => void): void {
    this.onUnreadChange = cb;
    cb(this.hasUnread);
  }
  setOnUserClick(cb: (username: string, anchor: HTMLElement) => void): void {
    this.onUserClick = cb;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.window.style.display = '';
    this.applyMobileLayout();
    this.applyDesktopMaximized();
    this.hasUnread = false;
    this.onUnreadChange?.(false);
    bringToFront(this.window);
    document.body.dataset.chatOpen = '1';
    // Re-render: messages may have been pushed into this.messages while
    // chat was closed (handleChatMessage skips renderTimeline when !isOpen),
    // so the DOM is stale. Always rebuild on open so the user sees them.
    this.renderTimeline(true);
    // Also pull anything that arrived server-side while we were away.
    this.gameClient.sendSyncChat(this.getLatestId());
    this.persistOpenState();
    requestAnimationFrame(() => {
      this.scrollToLatest();
      // Mobile: don't grab focus on open — that pops the soft keyboard over
      // the timeline, so the user can't read the messages they just opened.
      if (!this.isMobile()) this.inputEl.focus();
    });
    this.reportChatFocus();
  }

  /** Open the popout and pre-fill the composer for a DM to `username`. */
  openDm(username: string): void {
    this.open();
    this.channelSelect.value = 'dm';
    this.dmInput.value = username;
    this.syncChannelUi();
    this.reportChatFocus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.window.style.display = 'none';
    release(this.window);
    delete document.body.dataset.chatOpen;
    delete document.body.dataset.chatLayout;
    this.persistOpenState();
    this.onClose?.();
    this.reportChatFocus();
  }

  /**
   * The popout shows a unified timeline, not per-thread views — so "focused
   * on a DM thread" means the popout is open with that thread selected in
   * the composer. Suppresses DM notifications for whoever that is.
   */
  private reportChatFocus(): void {
    const target = this.dmInput.value.trim();
    if (this.isOpen && this.channelSelect.value === 'dm' && target) {
      chatFocusTracker.setActiveThread('dm', target);
    } else {
      chatFocusTracker.clearActiveThread();
    }
  }

  /** True if chat was open last session — caller may call open() during boot. */
  wasOpen(): boolean {
    try { return localStorage.getItem(STORAGE_KEY_OPEN) === '1'; } catch { return false; }
  }

  private persistOpenState(): void {
    try {
      if (this.isOpen) localStorage.setItem(STORAGE_KEY_OPEN, '1');
      else localStorage.removeItem(STORAGE_KEY_OPEN);
    } catch { /* ignore */ }
  }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  isVisible(): boolean { return this.isOpen; }

  // ── DOM construction ──────────────────────────────────────────────────

  private buildDOM(): void {
    this.root.innerHTML = `
      <div class="chat-popout" role="dialog" aria-label="Chat" style="display:none">
        <div class="chat-popout-header">
          <h2 class="chat-popout-title">Chat</h2>
          <div class="chat-popout-header-actions">
            <button type="button" class="chat-popout-layout-btn gc-btn gc-btn--steel gc-btn--icon"></button>
            <button type="button" class="chat-popout-close gc-close" aria-label="Close chat"></button>
          </div>
        </div>
        <div class="chat-popout-filters gc-chips" role="group" aria-label="Show channels"></div>
        <div class="chat-popout-body">
          <div class="chat-popout-timeline" role="log" aria-live="polite"></div>
          <button type="button" class="chat-popout-jump gc-btn gc-btn--steel" hidden>New messages ↓</button>
        </div>
        <div class="chat-popout-composer">
          <label class="chat-popout-dm-row" hidden>
            <span class="chat-popout-dm-label">To</span>
            <input class="chat-popout-dm-target gc-input" type="text" placeholder="Player name"
              autocomplete="off" autocapitalize="off" spellcheck="false" />
          </label>
          <div class="chat-popout-send-row">
            <select class="chat-popout-channel" aria-label="Send to channel">
              <option value="global">Global</option>
              <option value="zone">Zone</option>
              <option value="tile">Room</option>
              <option value="party">Party</option>
              <option value="guild">Guild</option>
              <option value="dm">DM</option>
            </select>
            <input class="chat-popout-input gc-input" type="text" placeholder="Say something…" maxlength="500"
              aria-label="Message" autocomplete="off" enterkeyhint="send" />
            <button type="button" class="chat-popout-send gc-btn gc-btn--green">Send</button>
          </div>
        </div>
        <div class="chat-popout-resize" aria-hidden="true"></div>
      </div>
    `;

    this.window = this.root.querySelector('.chat-popout')!;
    this.timelineEl = this.window.querySelector('.chat-popout-timeline')!;
    this.filtersEl = this.window.querySelector('.chat-popout-filters')!;
    this.inputEl = this.window.querySelector('.chat-popout-input')! as HTMLInputElement;
    this.channelSelect = this.window.querySelector('.chat-popout-channel')! as HTMLSelectElement;
    this.dmInput = this.window.querySelector('.chat-popout-dm-target')! as HTMLInputElement;
    this.dmRow = this.window.querySelector('.chat-popout-dm-row')!;
    this.composerEl = this.window.querySelector('.chat-popout-composer')!;
    this.layoutBtn = this.window.querySelector('.chat-popout-layout-btn')! as HTMLButtonElement;
    this.jumpBtn = this.window.querySelector('.chat-popout-jump')! as HTMLButtonElement;
    this.jumpBtn.addEventListener('click', () => this.scrollToLatest());
    this.timelineEl.addEventListener('scroll', () => {
      if (this.isNearBottom()) this.jumpBtn.hidden = true;
    }, { passive: true });

    this.syncChannelUi();
    this.updateLayoutButton();
    this.renderFilters();
    this.applyGeometry(this.loadGeometry());

    this.wireDrag();
    this.wireResize();
    this.wireClose();
    this.wireSend();
    this.wireChannelChange();
    this.wireLayoutToggle();
    this.wireTimelineClicks();

    // Refocus to top of stack on any pointer interaction with the window.
    wireFocusOnInteract(this.window);

    window.addEventListener('resize', () => {
      this.applyMobileLayout();
      this.constrainToViewport();
    });
  }

  private wireClose(): void {
    this.window.querySelector('.chat-popout-close')!.addEventListener('click', () => this.close());
  }

  private wireLayoutToggle(): void {
    this.window.querySelector('.chat-popout-layout-btn')!.addEventListener('click', () => {
      if (this.isMobile()) {
        // Mobile: cycle full <-> bottom sheet.
        this.mobileLayout = this.mobileLayout === 'full' ? 'sheet' : 'full';
        localStorage.setItem(STORAGE_KEY_MOBILE_LAYOUT, this.mobileLayout);
        this.applyMobileLayout();
        return;
      }
      // Desktop: toggle maximized full-screen.
      this.desktopMaximized = !this.desktopMaximized;
      try { localStorage.setItem(STORAGE_KEY_DESKTOP_MAX, this.desktopMaximized ? '1' : '0'); } catch { /* ignore */ }
      this.applyDesktopMaximized();
    });
  }

  /** The layout button shows what tapping it will do: expand or shrink the chat. */
  private updateLayoutButton(): void {
    const expanded = this.isMobile() ? this.mobileLayout === 'full' : this.desktopMaximized;
    this.layoutBtn.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND;
    const label = expanded ? 'Shrink chat' : 'Expand chat';
    this.layoutBtn.setAttribute('aria-label', label);
    this.layoutBtn.title = label;
  }

  private applyDesktopMaximized(): void {
    this.updateLayoutButton();
    if (this.isMobile()) {
      this.window.classList.remove('chat-popout-desktop-max');
      return;
    }
    this.window.classList.toggle('chat-popout-desktop-max', this.desktopMaximized);
    if (!this.desktopMaximized) {
      // Restore the saved geometry when un-maximizing.
      this.applyGeometry(this.loadGeometry());
      this.constrainToViewport();
    } else {
      // Clear inline geometry so the maximized CSS rule wins.
      this.window.style.left = '';
      this.window.style.top = '';
      this.window.style.right = '';
      this.window.style.bottom = '';
      this.window.style.width = '';
      this.window.style.height = '';
    }
  }

  private wireSend(): void {
    const send = () => {
      const text = this.inputEl.value.trim();
      if (!text) return;
      const channel = this.channelSelect.value as ChatChannelType;
      let channelId = '';
      if (channel === 'dm') {
        channelId = this.dmInput.value.trim();
        if (!channelId) return;
      }
      this.gameClient.sendChat(channel, channelId, text);
      this.inputEl.value = '';
    };

    this.window.querySelector('.chat-popout-send')!.addEventListener('click', send);
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
  }

  private wireChannelChange(): void {
    this.channelSelect.addEventListener('change', () => {
      this.syncChannelUi();
      this.reportChatFocus();
    });
    this.dmInput.addEventListener('input', () => this.reportChatFocus());
  }

  /** Tint the composer with the send channel's color and show the DM "To" row for DMs. */
  private syncChannelUi(): void {
    const channel = this.channelSelect.value as ChatChannelType;
    this.composerEl.style.setProperty('--ch-color', CHANNEL_COLORS[channel] ?? CHANNEL_COLORS.global);
    this.dmRow.hidden = channel !== 'dm';
    const label = CHANNEL_LABELS[channel] ?? 'Global';
    this.inputEl.placeholder = channel === 'dm' ? 'Whisper something…' : `Say something in ${label}…`;
  }

  private wireDrag(): void {
    const header = this.window.querySelector('.chat-popout-header')! as HTMLElement;
    let startX = 0, startY = 0, startL = 0, startT = 0;
    let dragging = false;

    header.addEventListener('pointerdown', (e) => {
      if (this.isMobile()) return;
      if (this.desktopMaximized) return;
      if ((e.target as HTMLElement).closest('button')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.window.getBoundingClientRect();
      startL = rect.left;
      startT = rect.top;
      header.setPointerCapture(e.pointerId);
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Live-clamp during drag so the window never visually slides behind
      // the nav / xp bar. The pointerup handler also calls constrainToViewport
      // as a final safety net.
      const margin = 8;
      const vw = window.innerWidth;
      const bottom = this.getBottomBoundary();
      const w = this.window.offsetWidth;
      const h = this.window.offsetHeight;
      const maxLeft = vw - w - margin;
      const maxTop = bottom - h - margin;
      const left = Math.max(margin, Math.min(maxLeft, startL + dx));
      const top = Math.max(margin, Math.min(maxTop, startT + dy));
      this.window.style.left = `${left}px`;
      this.window.style.top = `${top}px`;
      this.window.style.right = 'auto';
      this.window.style.bottom = 'auto';
    });

    header.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.constrainToViewport();
      this.saveGeometry();
    });
  }

  private wireResize(): void {
    const handle = this.window.querySelector('.chat-popout-resize')! as HTMLElement;
    let startX = 0, startY = 0, startW = 0, startH = 0;
    let resizing = false;

    handle.addEventListener('pointerdown', (e) => {
      if (this.isMobile()) return;
      if (this.desktopMaximized) return;
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.window.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const margin = 8;
      const rect = this.window.getBoundingClientRect();
      const maxW = window.innerWidth - rect.left - margin;
      const maxH = this.getBottomBoundary() - rect.top - margin;
      const w = Math.max(320, Math.min(maxW, startW + (e.clientX - startX)));
      const h = Math.max(280, Math.min(maxH, startH + (e.clientY - startY)));
      this.window.style.width = `${w}px`;
      this.window.style.height = `${h}px`;
    });

    handle.addEventListener('pointerup', (e) => {
      if (!resizing) return;
      resizing = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.constrainToViewport();
      this.saveGeometry();
    });
  }

  /**
   * Bottom of the usable area for the chat window — above the persistent
   * XP bar and bottom nav. We measure live so the constraint is correct
   * even if the user has resized the window or those elements are hidden.
   */
  private getBottomBoundary(): number {
    const nav = document.getElementById('bottom-nav');
    const xpbar = document.getElementById('persistent-xp-bar');
    const navH = nav && nav.offsetHeight > 0 ? nav.offsetHeight : 0;
    const xpH = xpbar && xpbar.offsetHeight > 0 ? xpbar.offsetHeight : 0;
    return window.innerHeight - navH - xpH;
  }

  private constrainToViewport(): void {
    if (this.isMobile()) return;
    const rect = this.window.getBoundingClientRect();
    const vw = window.innerWidth;
    const bottom = this.getBottomBoundary();
    const margin = 8;
    let left = rect.left;
    let top = rect.top;
    let width = Math.min(rect.width, vw - 2 * margin);
    let height = Math.min(rect.height, bottom - 2 * margin);
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    if (left + width > vw - margin) left = vw - width - margin;
    if (top + height > bottom - margin) top = bottom - height - margin;
    this.window.style.left = `${left}px`;
    this.window.style.top = `${top}px`;
    this.window.style.width = `${width}px`;
    this.window.style.height = `${height}px`;
    this.window.style.right = 'auto';
    this.window.style.bottom = 'auto';
  }

  private isMobile(): boolean {
    return window.innerWidth < 768;
  }

  private applyMobileLayout(): void {
    this.updateLayoutButton();
    if (!this.isMobile()) {
      this.window.classList.remove('chat-popout-mobile-full', 'chat-popout-mobile-sheet');
      delete document.body.dataset.chatLayout;
      return;
    }
    this.window.classList.toggle('chat-popout-mobile-full', this.mobileLayout === 'full');
    this.window.classList.toggle('chat-popout-mobile-sheet', this.mobileLayout === 'sheet');
    // Expose layout to CSS so the screen container can dock under the sheet
    // instead of being overlaid by it.
    document.body.dataset.chatLayout = this.mobileLayout;
    this.window.style.left = '';
    this.window.style.top = '';
    this.window.style.right = '';
    this.window.style.bottom = '';
    this.window.style.width = '';
    this.window.style.height = '';
  }

  private renderFilters(): void {
    const channels: ChatChannelType[] = ['global', 'zone', 'tile', 'party', 'guild', 'dm', 'server'];
    this.filtersEl.innerHTML = channels.map(ch => `
      <button type="button" class="chat-filter gc-chip ${this.filters[ch] ? 'active' : ''}" data-ch="${ch}"
        aria-pressed="${this.filters[ch] ? 'true' : 'false'}" style="--chip-color:${CHANNEL_COLORS[ch]}">
        <span class="gc-chip__face"><span class="gc-chip__dot"></span>${CHANNEL_LABELS[ch]}</span>
      </button>
    `).join('');
    for (const btn of this.filtersEl.querySelectorAll('.chat-filter')) {
      btn.addEventListener('click', () => {
        const ch = btn.getAttribute('data-ch') as ChatChannelType;
        this.filters[ch] = !this.filters[ch];
        this.saveFilters();
        btn.classList.toggle('active', this.filters[ch]);
        btn.setAttribute('aria-pressed', this.filters[ch] ? 'true' : 'false');
        this.renderTimeline(true);
      });
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────

  private handleChatMessage(msg: ChatMessage): void {
    if (!this.messages.find(m => m.id === msg.id)) {
      this.messages.push(msg);
    }
    if (this.isOpen) {
      // Your own message always snaps the feed back to the bottom.
      this.renderTimeline(this.isOwn(msg));
    } else {
      this.hasUnread = true;
      this.onUnreadChange?.(true);
    }
  }

  private getLatestId(): string | undefined {
    if (this.messages.length === 0) return undefined;
    return this.messages[this.messages.length - 1].id;
  }

  /**
   * Rebuild the timeline. The feed follows new messages only while the
   * player is at (or near) the bottom; if they've scrolled back to read, it
   * stays put and a "New messages" pill offers the jump. `forceBottom` snaps
   * regardless (opening chat, changing filters, sending a message).
   */
  private renderTimeline(forceBottom = false): void {
    const stick = forceBottom || this.isNearBottom();
    const visible = this.messages.filter(m => this.filters[m.channelType] !== false);
    let html = '';
    let prev: ChatMessage | null = null;
    for (const m of visible) {
      const newDay = prev === null || !this.isSameCalendarDay(prev.timestamp, m.timestamp);
      if (newDay) {
        html += `<div class="chat-day-separator"><span>${this.formatDayLabel(m.timestamp)}</span></div>`;
      }
      html += this.formatMessage(m, !newDay && this.continuesGroup(prev, m));
      prev = m;
    }
    if (!html) {
      html = `<div class="chat-empty">No messages yet.<br>Say hello, or turn on more channels above.</div>`;
    }
    this.timelineEl.innerHTML = html;
    if (stick) {
      this.jumpBtn.hidden = true;
      requestAnimationFrame(() => {
        this.timelineEl.scrollTop = this.timelineEl.scrollHeight;
      });
    } else {
      this.jumpBtn.hidden = false;
    }
  }

  private scrollToLatest(): void {
    this.timelineEl.scrollTop = this.timelineEl.scrollHeight;
    this.jumpBtn.hidden = true;
  }

  private isNearBottom(): boolean {
    const el = this.timelineEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  }

  private isOwn(msg: ChatMessage): boolean {
    const me = this.gameClient.lastState?.username;
    return !!me && msg.channelType !== 'server' && msg.senderUsername === me;
  }

  /** True when `msg` should tuck under `prev`'s header (same sender + channel, close in time). */
  private continuesGroup(prev: ChatMessage | null, msg: ChatMessage): boolean {
    if (!prev || msg.channelType === 'server') return false;
    return prev.senderUsername === msg.senderUsername
      && prev.channelType === msg.channelType
      && prev.channelId === msg.channelId
      && msg.timestamp - prev.timestamp <= GROUP_WINDOW_MS;
  }

  private formatMessage(msg: ChatMessage, continued: boolean): string {
    const time = this.formatTime(msg.timestamp);
    const color = CHANNEL_COLORS[msg.channelType] ?? CHANNEL_COLORS.global;
    const tag = CHANNEL_LABELS[msg.channelType] ?? msg.channelType;
    const sender = this.escapeHtml(msg.senderUsername || 'Server');
    const text = this.escapeHtml(msg.text);
    const isServer = msg.channelType === 'server';

    // Server messages render as a centered system line (no popup / no
    // channel switch).
    if (isServer) {
      return `
        <div class="chat-msg chat-msg--server" style="--ch-color:${color}">
          <span class="chat-msg-text">${text}</span>
          <span class="chat-msg-time">${time}</span>
        </div>
      `;
    }

    // Everything else gets a clickable tag (switch send channel) and sender
    // (open user popup). Continuation messages drop the header row.
    const classes = ['chat-msg'];
    if (this.isOwn(msg)) classes.push('chat-msg--own');
    if (continued) classes.push('chat-msg--cont');
    const header = continued ? '' : `
      <div class="chat-msg-meta">
        <button type="button" class="chat-msg-sender chat-msg-sender-btn" data-user="${sender}">${sender}</button>
        <button type="button" class="chat-msg-tag chat-msg-tag-btn" data-channel="${msg.channelType}" data-channel-id="${this.escapeHtml(msg.channelId ?? '')}" data-sender="${sender}" title="Reply in ${tag}">${tag}</button>
        <span class="chat-msg-time">${time}</span>
      </div>`;
    return `
      <div class="${classes.join(' ')}" style="--ch-color:${color}">
        ${header}
        <div class="chat-msg-bubble" title="${time}"><span class="chat-msg-text">${text}</span></div>
      </div>
    `;
  }

  private wireTimelineClicks(): void {
    this.timelineEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const senderBtn = target.closest<HTMLElement>('.chat-msg-sender-btn');
      if (senderBtn) {
        const username = senderBtn.dataset.user;
        if (username) this.onUserClick?.(username, senderBtn);
        return;
      }
      const tagBtn = target.closest<HTMLElement>('.chat-msg-tag-btn');
      if (tagBtn) {
        const channel = tagBtn.dataset.channel as ChatChannelType | undefined;
        if (!channel) return;
        this.selectSendChannel(channel, tagBtn.dataset.channelId ?? '', tagBtn.dataset.sender ?? '');
      }
    });
  }

  /**
   * Switch the composer to the given channel (and for DMs, populate the
   * target with the "other party" inferred from the clicked message).
   */
  private selectSendChannel(channel: ChatChannelType, channelId: string, sender: string): void {
    if (channel === 'server') return;
    this.channelSelect.value = channel;
    // dispatch change so the DM target field shows/hides as needed
    this.channelSelect.dispatchEvent(new Event('change'));
    if (channel === 'dm') {
      const me = this.gameClient.lastState?.username;
      // If this DM was sent by me, the "other party" is channelId; otherwise
      // it's the sender. Either way the DM target is the *other* participant.
      const target = (sender && me && sender === me) ? channelId : sender;
      if (target) this.dmInput.value = target;
    }
    this.inputEl.focus();
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  private isSameCalendarDay(a: number, b: number): boolean {
    const da = new Date(a);
    const db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  }

  /** "Today" / "Yesterday" / a short date — used for the day-separator between messages. */
  private formatDayLabel(ts: number): string {
    const now = Date.now();
    if (this.isSameCalendarDay(ts, now)) return 'Today';
    if (this.isSameCalendarDay(ts, now - 24 * 60 * 60 * 1000)) return 'Yesterday';
    const d = new Date(ts);
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Persistence ───────────────────────────────────────────────────────

  private loadGeometry(): Geometry {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_GEOMETRY);
      if (raw) return JSON.parse(raw) as Geometry;
    } catch { /* ignore */ }
    return { x: window.innerWidth - 436, y: 72, width: 420, height: 540 };
  }

  private saveGeometry(): void {
    if (this.isMobile()) return;
    const rect = this.window.getBoundingClientRect();
    const geom: Geometry = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    localStorage.setItem(STORAGE_KEY_GEOMETRY, JSON.stringify(geom));
  }

  private applyGeometry(g: Geometry): void {
    if (this.isMobile()) return;
    this.window.style.left = `${g.x}px`;
    this.window.style.top = `${g.y}px`;
    this.window.style.width = `${g.width}px`;
    this.window.style.height = `${g.height}px`;
    this.window.style.right = 'auto';
    this.window.style.bottom = 'auto';
  }

  private loadFilters(): Record<ChatChannelType, boolean> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_FILTERS);
      if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_FILTERS };
  }

  private saveFilters(): void {
    localStorage.setItem(STORAGE_KEY_FILTERS, JSON.stringify(this.filters));
  }
}
