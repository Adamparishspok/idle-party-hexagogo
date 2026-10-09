import type { TileClickInfo } from './ThreeWorldMap';
import { actionLabel } from './RoomActions';
import type { RoomAction } from './RoomActions';
import { artworkUrl } from './assets';
import { bringToFront, release } from './ModalStack';
import { renderPortrait } from './Portrait';
import '../styles/screens/map.css';

type Member = { username: string; className?: string; level?: number };

const ICON_KEY = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M11.5 11.5 20 20M16 16l2.5-2.5M18.5 18.5 21 16" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/></svg>';
const ICON_DOOR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><path d="M2.5 21h19" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="15" cy="12.5" r="1.6" fill="currentColor"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

/**
 * RoomView — what you see when you tap a room on the map.
 *
 *   - **Current room** — a full-screen "place" inside the map screen: the
 *     room's painted backdrop (`/room-bg-artwork/{zone}-{col}-{row}.png` →
 *     `/room-bg-artwork/{zone}.png` → `/zone-artwork/{zone}.png`, over a CSS
 *     scene), the room name as an outlined title, parties as cards of
 *     portrait frames, and big buttons for Talk / Shop / Enter Dungeon /
 *     Enter {destination}. It sits under the bottom nav and perch (not in the
 *     modal stack), so chat and the nav stay reachable.
 *   - **Remote room** — a parchment preview modal: room name on the title
 *     tab, what's known about it, and a "Travel here" button.
 *
 * Re-opening the current room right after previewing it (i.e. you travelled
 * there) plays an "arrival" animation so the trip has weight.
 */
export class RoomView {
  private overlay: HTMLElement;
  private modal: HTMLElement;
  private onMove: (col: number, row: number) => void;
  private onUserClick?: (username: string, anchor: HTMLElement, tileCol: number, tileRow: number) => void;
  private onAction?: (action: RoomAction) => void;
  /** What the room offers. Set externally before showing; buttons on the current room, a list on a remote one. */
  actions: RoomAction[] = [];
  /** Whether the party is walking a route. Set externally before showing. */
  isTraveling = false;
  /** GUID of the room being shown — the per-room artwork override id. Set externally before showing. */
  roomId: string | null = null;
  /** The viewing player, shown first in "Your party" (they aren't in `playersHere`). */
  self: Member | null = null;
  /** Last shown remote-room key — used to drive the arrival transition. */
  private lastRemoteKey: string | null = null;
  private mode: 'place' | 'preview' = 'preview';
  private arrivalTimer?: ReturnType<typeof setTimeout>;

  constructor(
    parent: HTMLElement,
    onMove: (col: number, row: number) => void,
    onUserClick?: (username: string, anchor: HTMLElement, tileCol: number, tileRow: number) => void,
    onAction?: (action: RoomAction) => void,
  ) {
    this.onMove = onMove;
    this.onUserClick = onUserClick;
    this.onAction = onAction;

    this.overlay = document.createElement('div');
    this.overlay.className = 'room-view-overlay';
    this.overlay.style.display = 'none';
    // Swallow pointer events so they can't bubble to (or be re-targeted at)
    // the canvas underneath. Clicking outside the panel dismisses.
    const stopAll = (e: Event) => { e.stopPropagation(); };
    for (const ev of ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend'] as const) {
      this.overlay.addEventListener(ev, stopAll);
    }
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    // Click-to-front only for the preview modal: the place view lives below
    // the nav and perch on purpose, so it must never climb the modal stack.
    const focus = () => { if (this.mode === 'preview') bringToFront(this.overlay); };
    this.overlay.addEventListener('mousedown', focus, true);
    this.overlay.addEventListener('touchstart', focus, true);

    this.modal = document.createElement('div');
    this.modal.className = 'room-view';
    this.overlay.appendChild(this.modal);
    parent.appendChild(this.overlay);
  }

  show(info: TileClickInfo): void {
    const isCurrent = info.isCurrentTile;
    this.mode = isCurrent ? 'place' : 'preview';

    if (isCurrent) {
      this.renderCurrentRoom(info);
      release(this.overlay);
    } else {
      this.renderRemoteRoom(info);
    }

    this.overlay.style.display = 'flex';
    if (!isCurrent) bringToFront(this.overlay);

    // Re-opening the room you just previewed means you travelled there:
    // play the arrival flourish.
    if (isCurrent && this.lastRemoteKey === `${info.col},${info.row}`) {
      if (this.arrivalTimer) clearTimeout(this.arrivalTimer);
      this.modal.classList.add('is-arriving');
      this.arrivalTimer = setTimeout(() => this.modal.classList.remove('is-arriving'), 900);
    }
    this.lastRemoteKey = isCurrent ? null : `${info.col},${info.row}`;

    (this.modal.querySelector('.room-view-close') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    release(this.overlay);
  }

  // ── Current room: full-screen place ──────────────────────

  private renderCurrentRoom(info: TileClickInfo): void {
    this.overlay.className = 'room-view-overlay rv-place';
    this.modal.className = 'room-view rv-place__root';
    this.modal.setAttribute('role', 'dialog');
    this.modal.setAttribute('aria-label', info.roomName || 'Current room');

    const grouped = this.groupPlayersByParty(info.playersHere, info.partyMemberUsernames);
    const mine: Member[] = this.self
      ? [this.self, ...grouped.mine.filter(m => m.username !== this.self!.username)]
      : grouped.mine;

    const mineCard = mine.length > 0
      ? this.renderPartyCard(mine, 'Your party', 'rv-party--self', grouped.mineDungeonName)
      : '';
    const otherCards = grouped.others
      .map(g => this.renderPartyCard(g.members, null, 'rv-party--other', g.dungeonName))
      .join('');
    const othersBlock = otherCards
      ? `<div class="rv-place__divider">Other parties here</div>${otherCards}`
      : '';

    const roomActions = this.actions;
    const actions: string[] = roomActions.map((action, i) => this.actionButton(
      `room-view-action-${action.kind}${action.questReady ? ' is-quest-ready' : ''}`,
      this.actionIcon(action),
      actionLabel(action),
      `data-action-index="${i}"${action.detail ? ` title="${this.escapeHtml(action.detail)}"` : ''}`,
    ));
    // One obvious primary action: the first button goes gold.
    if (actions.length > 0) actions[0] = actions[0].replace('class="gc-btn ', 'class="gc-btn gc-btn--gold ');
    // Travelling through this room? Offer to stop here instead of walking on.
    if (this.isTraveling) {
      actions.unshift(`<button type="button" class="gc-btn gc-btn--steel gc-btn--lg gc-btn--block rv-action room-view-action-stop">
        <span class="rv-action__glyph">${ICON_STOP}</span><span class="rv-action__label">Stop here</span>
      </button>`);
    }

    const actionsHtml = actions.length > 0
      ? `<div class="rv-place__actions" data-count="${actions.length}">${actions.join('')}</div>`
      : `<p class="rv-place__idle">Nothing to trade or talk to here. Your party keeps fighting while you look around.</p>`;

    this.modal.innerHTML = `
      <div class="rv-place__bg" aria-hidden="true"></div>
      <div class="rv-place__vignette" aria-hidden="true"></div>
      <header class="rv-place__head">
        <span class="rv-place__here">You are here</span>
        <h2 class="rv-place__name">${this.escapeHtml(info.roomName || 'Unnamed Room')}</h2>
        <div class="rv-place__zone">${this.escapeHtml(info.zoneName)}</div>
      </header>
      <button type="button" class="gc-close room-view-close rv-place__close" aria-label="Back to map"></button>
      <div class="rv-place__parties">
        ${mineCard}
        ${othersBlock}
      </div>
      ${actionsHtml}
    `;

    const bg = this.modal.querySelector('.rv-place__bg') as HTMLElement;
    const zone = encodeURIComponent(info.zoneId);
    // Room GUID → legacy zone+coords → zone default → zone art.
    bg.style.backgroundImage = [
      ...(this.roomId ? [artworkUrl('room-bg', encodeURIComponent(this.roomId))] : []),
      artworkUrl('room-bg', `${zone}-${info.col}-${info.row}`),
      artworkUrl('room-bg', zone),
      artworkUrl('zone', zone),
    ].map(u => `url("${u}")`).join(', ');

    this.modal.querySelector('.room-view-close')!.addEventListener('click', () => this.hide());

    this.modal.querySelector('.room-view-action-stop')?.addEventListener('click', () => {
      this.onMove(info.col, info.row);
      this.hide();
    });

    for (const el of this.modal.querySelectorAll('[data-action-index]')) {
      el.addEventListener('click', () => {
        const action = roomActions[Number(el.getAttribute('data-action-index'))];
        this.hide();
        if (action) this.onAction?.(action);
      });
    }

    this.wireMembers(info);
  }

  // ── Remote room: parchment preview ───────────────────────

  private renderRemoteRoom(info: TileClickInfo): void {
    this.overlay.className = 'room-view-overlay gc-modal rv-preview';
    this.modal.className = 'room-view gc-modal__panel gc-parchment rv-preview__panel';
    this.modal.setAttribute('role', 'dialog');
    this.modal.setAttribute('aria-modal', 'true');
    this.modal.setAttribute('aria-label', info.roomName || 'Unexplored Room');

    const unexplored = !info.roomName || info.roomName === 'Unexplored Room';
    const grouped = this.groupPlayersByParty(info.playersHere, info.partyMemberUsernames);
    const mineCard = grouped.mine.length > 0
      ? this.renderPartyCard(grouped.mine, 'Your party', 'rv-party--self rv-party--mini', grouped.mineDungeonName)
      : '';
    const otherCards = grouped.others
      .map(g => this.renderPartyCard(g.members, null, 'rv-party--other rv-party--mini', g.dungeonName))
      .join('');

    const facts: string[] = [];
    if (unexplored) {
      facts.push(this.fact('rv-fact--dim', 'Unexplored. Travel here to learn more.'));
    }
    if (info.isUnlocked) {
      for (const action of this.actions) {
        const detail = action.detail ? ` · ${action.detail}` : '';
        facts.push(this.fact(`rv-fact--${action.kind}${action.questReady ? ' is-quest-ready' : ''}`, `${action.icon} ${action.name}${detail}`));
      }
    }
    const playerCount = info.playersHere.length;
    if (playerCount === 0 && !unexplored) facts.push(this.fact('rv-fact--dim', 'No other adventurers here right now.'));

    const partiesBlock = (mineCard || otherCards)
      ? `<div class="gc-divider rv-preview__divider">Adventurers here</div><div class="rv-preview__parties">${mineCard}${otherCards}</div>`
      : '';

    const kind = info.tileType && !unexplored ? ` · ${this.escapeHtml(info.tileType)}` : '';

    this.modal.innerHTML = `
      <div class="gc-title-tab gc-modal__title rv-preview__title"><span class="gc-title-tab__text">${this.escapeHtml(info.roomName || 'Unexplored Room')}</span></div>
      <button type="button" class="gc-close gc-modal__close room-view-close" aria-label="Close"></button>
      <div class="gc-modal__body rv-preview__body">
        <div class="rv-preview__zone">${this.escapeHtml(info.zoneName)}${kind}</div>
        ${facts.length > 0 ? `<ul class="rv-preview__facts">${facts.join('')}</ul>` : ''}
        ${partiesBlock}
      </div>
      ${info.isTraversable
        ? `<div class="gc-modal__actions"><button type="button" class="gc-btn gc-btn--gold gc-btn--lg room-view-action-go">Travel here</button></div>`
        : ''}
    `;
    this.modal.classList.toggle('has-actions', info.isTraversable);

    this.modal.querySelector('.room-view-close')!.addEventListener('click', () => this.hide());
    this.modal.querySelector('.room-view-action-go')?.addEventListener('click', () => {
      this.onMove(info.col, info.row);
      this.hide();
    });
    this.wireMembers(info);
  }

  // ── Shared pieces ────────────────────────────────────────

  private wireMembers(info: TileClickInfo): void {
    for (const el of this.modal.querySelectorAll('.room-party-member')) {
      el.addEventListener('click', () => {
        const username = el.getAttribute('data-username');
        if (username && this.onUserClick) {
          this.onUserClick(username, el as HTMLElement, info.col, info.row);
        }
      });
    }
  }

  private fact(cls: string, text: string): string {
    return `<li class="rv-fact ${cls}">${this.escapeHtml(text)}</li>`;
  }

  private actionButton(hook: string, icon: string, label: string, attrs = ''): string {
    return `<button type="button" class="gc-btn gc-btn--lg gc-btn--block rv-action ${hook}" ${attrs}>
      ${icon}<span class="rv-action__label">${this.escapeHtml(label)}</span>
    </button>`;
  }

  /** Icon chip for a room action: NPC portrait, shop art over a coin, or a drawn glyph. */
  private actionIcon(action: RoomAction): string {
    const id = encodeURIComponent(action.targetId);
    if (action.kind === 'npc') {
      return `<span class="rv-action__chip">
        <span class="rv-action__emoji" aria-hidden="true">${this.escapeHtml(action.icon || '')}</span>
        <img class="rv-action__img" src="${artworkUrl('npc', id)}" alt="" onerror="this.remove()" />
      </span>`;
    }
    if (action.kind === 'shop') {
      return `<span class="rv-action__chip">
        <span class="gc-coin rv-action__coin" aria-hidden="true"></span>
        <img class="rv-action__img" src="${artworkUrl('shop', id)}" alt="" onerror="this.remove()" />
      </span>`;
    }
    return `<span class="rv-action__glyph">${action.kind === 'dungeon' ? ICON_KEY : ICON_DOOR}</span>`;
  }

  /**
   * Group co-located players into "my party" + per-party other-party buckets.
   * `partyMemberUsernames` identifies the viewer's party so members of it
   * always land in `mine` (even if their `partyId` field is briefly stale
   * during join/leave transitions). Other players are bucketed by `partyId`;
   * any without a known partyId share a synthetic 'unknown' bucket so they
   * still appear rather than silently dropping.
   */
  private groupPlayersByParty(
    players: { username: string; className?: string; partyId?: string; dungeonName?: string }[],
    partyMemberUsernames: string[],
  ): {
    mine: Member[];
    mineDungeonName?: string;
    others: { partyId: string; members: Member[]; dungeonName?: string }[];
  } {
    const myUsernames = new Set(partyMemberUsernames);
    const mine: Member[] = [];
    let mineDungeonName: string | undefined;
    const otherMap = new Map<string, { partyId: string; members: Member[]; dungeonName?: string }>();
    const unknown: Member[] = [];
    let unknownDungeonName: string | undefined;

    for (const p of players) {
      if (myUsernames.has(p.username)) {
        mine.push({ username: p.username, className: p.className });
        if (p.dungeonName) mineDungeonName = p.dungeonName;
      } else if (p.partyId) {
        let group = otherMap.get(p.partyId);
        if (!group) {
          group = { partyId: p.partyId, members: [] };
          otherMap.set(p.partyId, group);
        }
        group.members.push({ username: p.username, className: p.className });
        if (p.dungeonName) group.dungeonName = p.dungeonName;
      } else {
        unknown.push({ username: p.username, className: p.className });
        if (p.dungeonName) unknownDungeonName = p.dungeonName;
      }
    }

    const others = Array.from(otherMap.values());
    if (unknown.length > 0) others.push({ partyId: 'unknown', members: unknown, dungeonName: unknownDungeonName });
    return { mine, mineDungeonName, others };
  }

  /** A party as a card of portrait frames, with optional label and dungeon tag. */
  private renderPartyCard(
    members: Member[],
    label: string | null,
    modifier: string,
    dungeonName?: string,
  ): string {
    if (members.length === 0) return '';
    const portraits = members.map(p => {
      const isSelf = this.self?.username === p.username;
      const portrait = renderPortrait({ name: p.username, className: p.className, level: p.level, self: isSelf });
      return `
        <button type="button" class="rv-member room-party-member${isSelf ? ' is-self' : ''}" data-username="${this.escapeHtml(p.username)}"
          aria-label="${this.escapeHtml(p.username)}${p.className ? `, ${this.escapeHtml(p.className)}` : ''}">
          ${portrait}
          <span class="rv-member__name">${this.escapeHtml(p.username)}</span>
        </button>`;
    }).join('');
    const tag = dungeonName
      ? `<span class="rv-party__tag">${ICON_KEY}Delving ${this.escapeHtml(dungeonName)}</span>`
      : '';
    const head = (label || tag)
      ? `<div class="rv-party__head">${label ? `<span class="rv-party__label">${this.escapeHtml(label)}</span>` : ''}${tag}</div>`
      : '';
    return `<section class="rv-party ${modifier}">${head}<div class="rv-party__members">${portraits}</div></section>`;
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
