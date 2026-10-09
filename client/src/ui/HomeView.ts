import type { GameClient } from '../network/GameClient';
import type { HomeOccupant, HomeView as HomeViewState, HouseDefinition, ItemDefinition, ServerStateMessage } from '@idle-party-rpg/shared';
import {
  RESTED_MS_PER_SIT_MS,
  WELL_RESTED_BONUS,
  canStore,
  houseSellPrice,
  isWellRested,
  listUnequippedEntries,
} from '@idle-party-rpg/shared';
import { escapeHtml, renderKitItem } from './ItemIcon';
import { renderPortrait } from './Portrait';
import { renderEmptyState } from './EmptyState';
import { houseArtHtml, houseInteriorUrl } from './HouseArt';
import { formatRestedRemaining } from './WellRestedChip';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import '../styles/screens/home.css';

/** How long after a request a server `error` is still taken as its refusal. */
const PENDING_WINDOW_MS = 5000;
const LEAVE_GRACE_MS = 4000;
const NOTICE_MS = 3500;
const MAX_RING_SEATS = 8;

const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
const ICON_CHEST = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5v1H3z" fill="currentColor"/><path d="M3 12h18v7H3z" fill="currentColor" opacity="0.8"/><rect x="10" y="10" width="4" height="5" rx="1" fill="#1a1009"/></svg>';
const ICON_LEAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const RESTED_HINT = `Each minute by the fire earns ${RESTED_MS_PER_SIT_MS} minutes of Well Rested — `
  + `+${Math.round((WELL_RESTED_BONUS - 1) * 100)}% XP and gold`;

type Sheet =
  | { kind: 'shelf'; slot: number }
  | { kind: 'withdraw'; itemId: string; qty: number }
  | { kind: 'deposit' }
  | { kind: 'deposit-item'; itemId: string; qty: number }
  | { kind: 'invite' }
  | { kind: 'manage' }
  | { kind: 'sell-confirm' };

interface Ctx {
  state: ServerStateMessage;
  visit: HomeViewState;
  isOwner: boolean;
  defs: Record<string, ItemDefinition>;
}

/**
 * Inside a home: a full-screen place shown whenever the state push carries
 * `homeVisit`. See docs/architecture/housing.md.
 */
export class HomeView {
  private gameClient: GameClient;
  private root: HTMLElement;
  private sheetEl: HTMLElement;
  private sheet: Sheet | null = null;
  private ctx: Ctx | null = null;
  private placeKey = '';
  private sheetKey = '';
  private leaving = false;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUntil = 0;
  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private invited = new Set<string>();
  private toastEl: HTMLElement | null = null;
  private minuteTimer: ReturnType<typeof setInterval> | null = null;

  constructor(parent: HTMLElement, gameClient: GameClient) {
    this.gameClient = gameClient;

    this.root = document.createElement('div');
    this.root.className = 'home-place';
    this.root.style.display = 'none';
    this.root.setAttribute('role', 'region');
    parent.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.onPlaceClick(e));

    this.sheetEl = document.createElement('div');
    this.sheetEl.className = 'gc-modal home-sheet';
    this.sheetEl.style.display = 'none';
    this.sheetEl.addEventListener('click', (e) => {
      if (e.target === this.sheetEl) this.closeSheet();
    });
    document.body.appendChild(this.sheetEl);
    wireFocusOnInteract(this.sheetEl);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.sheet) this.closeSheet();
    });

    gameClient.subscribe((s) => this.onState(s));
    gameClient.onServerError((message, code) => this.onServerError(message, code));
    if (gameClient.lastState) this.onState(gameClient.lastState);
  }

  /** Ask the server to open a home (yours when `owner` is omitted). A refusal is shown as a toast. */
  requestEnter(owner?: string): void {
    this.markPending();
    this.gameClient.sendEnterHome(owner);
  }

  isOpen(): boolean {
    return this.root.style.display !== 'none';
  }

  private onState(s: ServerStateMessage): void {
    const visit = s.homeVisit;
    if (!visit) {
      this.leaving = false;
      this.ctx = null;
      this.hide();
      return;
    }
    if (this.leaving) return;

    const isOwner = visit.owner === s.username;
    this.ctx = { state: s, visit, isOwner, defs: { ...(s.itemDefinitions ?? {}), ...visit.itemDefinitions } };
    this.show();
    this.renderPlace();
    if (this.sheet) this.renderSheet();
  }

  private onServerError(message: string, code?: string): void {
    const housing = !!code && (code.startsWith('house_') || code.startsWith('home_'));
    if (!housing && (code || Date.now() > this.pendingUntil)) return;
    this.pendingUntil = 0;
    if (this.isOpen()) {
      this.setNotice(message);
    } else {
      this.showToast(message);
    }
  }

  private markPending(): void {
    this.pendingUntil = Date.now() + PENDING_WINDOW_MS;
  }

  private send(fn: () => void): void {
    this.markPending();
    fn();
  }

  private show(): void {
    if (this.isOpen()) return;
    this.root.style.display = '';
    this.placeKey = '';
    this.minuteTimer = setInterval(() => this.renderPlace(), 30_000);
  }

  private hide(): void {
    if (this.minuteTimer) clearInterval(this.minuteTimer);
    this.minuteTimer = null;
    this.root.style.display = 'none';
    this.root.innerHTML = '';
    this.placeKey = '';
    this.closeSheet();
    this.invited.clear();
  }

  private leave(): void {
    this.gameClient.sendLeaveHome();
    this.leaving = true;
    this.hide();
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = setTimeout(() => {
      this.leaving = false;
      const s = this.gameClient.lastState;
      if (s) this.onState(s);
    }, LEAVE_GRACE_MS);
  }

  private setNotice(message: string): void {
    this.notice = message;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.noticeTimer = null;
      this.placeKey = '';
      this.renderPlace();
      if (this.sheet) this.renderSheet(true);
    }, NOTICE_MS);
    this.placeKey = '';
    this.renderPlace();
    if (this.sheet) this.renderSheet(true);
  }

  private showToast(message: string): void {
    this.toastEl?.remove();
    const toast = document.createElement('div');
    toast.className = 'home-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    this.toastEl = toast;
    setTimeout(() => {
      if (this.toastEl === toast) this.toastEl = null;
      toast.remove();
    }, NOTICE_MS);
  }

  // ── The place ───────────────────────────────────────────

  private renderPlace(): void {
    const ctx = this.ctx;
    if (!ctx || !this.isOpen()) return;
    const { state, visit, isOwner } = ctx;
    const now = Date.now();
    const rested = isWellRested(state.wellRestedUntil, now);
    const key = JSON.stringify({
      visit,
      me: state.username,
      notice: this.notice,
      rested: rested ? formatRestedRemaining((state.wellRestedUntil ?? 0) - now) : null,
    });
    if (key === this.placeKey) return;
    this.placeKey = key;

    const def = visit.definition;
    const title = isOwner ? `Your ${def.name}` : `${visit.owner}'s ${def.name}`;
    this.root.setAttribute('aria-label', title);
    const me = visit.occupants.find(o => o.username === state.username);
    const sitting = me?.sitting ?? false;
    const seated = visit.occupants.filter(o => o.sitting);
    const ring = seated.slice(0, MAX_RING_SEATS);
    const gathered = visit.occupants.filter(o => !ring.includes(o));

    const restedLine = rested
      ? `<p class="home-rested"><span class="home-rested__dot" aria-hidden="true"></span>Well Rested · ${escapeHtml(formatRestedRemaining((state.wellRestedUntil ?? 0) - now))} left</p>`
      : '';
    const noticeHtml = this.notice && !this.sheet
      ? `<div class="home-place__notice" role="status">${escapeHtml(this.notice)}</div>`
      : '';
    const ownerRow = isOwner
      ? `<button type="button" class="gc-btn gc-btn--lg home-btn home-invite-btn" data-home-action="invite">Invite</button>
         <button type="button" class="gc-btn gc-btn--lg home-btn home-manage-btn" data-home-action="manage">Manage</button>`
      : '';

    this.root.innerHTML = `
      <div class="home-place__bg" aria-hidden="true"></div>
      <div class="home-place__glow${sitting ? ' is-warm' : ''}" aria-hidden="true"></div>
      <div class="home-place__vignette" aria-hidden="true"></div>
      <header class="home-place__head">
        <span class="home-place__badge${isOwner ? '' : ' is-visit'}">${isOwner ? 'Home' : 'Visiting'}</span>
        <h2 class="home-place__name">${escapeHtml(title)}</h2>
      </header>
      <button type="button" class="gc-close home-place__close" data-home-action="leave" aria-label="Leave home"></button>
      ${noticeHtml}
      <div class="home-place__scroll">
        <section class="home-hearth${sitting ? ' is-sitting' : ''}" aria-label="Campfire">
          ${this.fireHtml()}
          ${ring.map((o, i) => this.seatHtml(o, i, ring.length, state.username)).join('')}
        </section>
        <button type="button" class="gc-btn ${sitting ? 'gc-btn--steel' : 'gc-btn--gold'} gc-btn--lg home-sit-btn" data-home-action="${sitting ? 'stand' : 'sit'}">${sitting ? 'Stand up' : 'Sit by the fire'}</button>
        <p class="home-hint">${escapeHtml(RESTED_HINT)}</p>
        ${restedLine}
        ${gathered.length ? `<section class="home-gathered" aria-label="Also here">
          <div class="home-section-title">Also here</div>
          <div class="home-gathered__row">${gathered.map(o => this.occupantHtml(o, state.username)).join('')}</div>
        </section>` : ''}
        ${this.shelvesHtml(ctx)}
        ${isOwner ? this.chestHtml(ctx) : ''}
      </div>
      <div class="home-place__actions">
        <div class="home-place__row">
          ${ownerRow}
          <button type="button" class="gc-btn gc-btn--steel gc-btn--lg home-btn home-leave-btn" data-home-action="leave">${ICON_LEAVE}<span>Leave</span></button>
        </div>
      </div>
    `;
    const bg = this.root.querySelector<HTMLElement>('.home-place__bg')!;
    bg.style.backgroundImage = `url("${houseInteriorUrl(def.id)}")`;
  }

  private shelvesHtml(ctx: Ctx): string {
    const { visit, isOwner, defs } = ctx;
    if (visit.displays.length === 0) return '';
    const slots = visit.displays.map((itemId, slot) => {
      const n = slot + 1;
      if (itemId) {
        const def = defs[itemId];
        const name = def?.name ?? itemId;
        return renderKitItem(itemId, def, {
          size: 'sm',
          button: isOwner,
          extraClass: 'home-shelf__slot',
          dataAttrs: { slot: String(slot) },
          label: isOwner ? `${name} on shelf ${n}` : name,
          title: name,
        });
      }
      return isOwner
        ? `<button type="button" class="gc-item gc-item--sm gc-item--empty home-shelf__slot is-empty" data-slot="${slot}" aria-label="Empty shelf ${n}, add a trophy"><span class="home-shelf__plus">${ICON_PLUS}</span></button>`
        : `<span class="gc-item gc-item--sm gc-item--empty home-shelf__slot is-empty" role="img" aria-label="Empty shelf ${n}"></span>`;
    }).join('');
    return `<section class="home-shelf" aria-label="Trophy shelf">
      <div class="home-section-title">Trophy shelf</div>
      <div class="home-shelf__plank" style="--shelf-cols: ${shelfColumns(visit.displays.length)}">${slots}</div>
    </section>`;
  }

  private fireHtml(): string {
    return `<div class="home-fire" aria-hidden="true">
      <span class="home-fire__glow"></span>
      <span class="home-fire__flame home-fire__flame--back"></span>
      <span class="home-fire__flame home-fire__flame--mid"></span>
      <span class="home-fire__flame home-fire__flame--core"></span>
      <span class="home-fire__spark"></span><span class="home-fire__spark"></span><span class="home-fire__spark"></span>
      <span class="home-fire__log home-fire__log--a"></span>
      <span class="home-fire__log home-fire__log--b"></span>
      <span class="home-fire__stones"></span>
    </div>`;
  }

  private seatHtml(o: HomeOccupant, i: number, count: number, me: string): string {
    const angle = Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / Math.max(count, 2);
    const x = 50 + 40 * Math.cos(angle);
    const y = 54 + 34 * Math.sin(angle);
    return `<div class="home-seat" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%">${this.occupantHtml(o, me)}</div>`;
  }

  private occupantHtml(o: HomeOccupant, me: string): string {
    const isMe = o.username === me;
    const label = `${o.username}${o.sitting ? ', sitting by the fire' : ''}`;
    return `<div class="home-occupant${o.sitting ? ' is-sitting' : ''}${isMe ? ' is-self' : ''}" data-username="${escapeHtml(o.username)}" role="img" aria-label="${escapeHtml(label)}">
      ${renderPortrait({ name: o.username, className: o.className, level: o.level, self: isMe })}
      <span class="home-occupant__name">${escapeHtml(isMe ? 'You' : o.username)}</span>
    </div>`;
  }

  private chestHtml(ctx: Ctx): string {
    const storage = ctx.visit.storage ?? {};
    const entries = Object.entries(storage).filter(([, n]) => n > 0);
    const slots = ctx.visit.definition.storageSlots;
    const grid = entries.length
      ? `<div class="home-chest__grid">${entries.map(([id, n]) => renderKitItem(id, ctx.defs[id], {
        button: true,
        count: n,
        extraClass: 'home-chest__item',
        dataAttrs: { 'item-id': id },
        label: `${ctx.defs[id]?.name ?? id} ×${n}, take out`,
      })).join('')}</div>`
      : renderEmptyState({
        emblem: ICON_CHEST,
        title: 'Your chest is empty',
        body: 'Deposit items from your bag to keep them safe at home.',
        compact: true,
      });
    return `<section class="home-chest" aria-label="Chest">
      <div class="home-chest__head">
        <div class="home-section-title">Chest <span class="home-chest__count">${entries.length}/${slots}</span></div>
        <button type="button" class="gc-btn gc-btn--green home-deposit-btn" data-home-action="deposit">Deposit</button>
      </div>
      ${grid}
    </section>`;
  }

  private onPlaceClick(e: Event): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const target = e.target as HTMLElement;
    const actionEl = target.closest<HTMLButtonElement>('[data-home-action]');
    if (actionEl) {
      if (actionEl.disabled) return;
      switch (actionEl.dataset.homeAction) {
        case 'sit': this.send(() => this.gameClient.sendCampfireSit()); return;
        case 'stand': this.send(() => this.gameClient.sendCampfireStand()); return;
        case 'leave': this.leave(); return;
        case 'invite': this.openSheet({ kind: 'invite' }); return;
        case 'manage': this.openSheet({ kind: 'manage' }); return;
        case 'deposit': this.openSheet({ kind: 'deposit' }); return;
      }
      return;
    }
    if (!ctx.isOwner) return;
    const slotEl = target.closest<HTMLElement>('.home-shelf__slot[data-slot]');
    if (slotEl && slotEl.tagName === 'BUTTON') {
      this.openSheet({ kind: 'shelf', slot: Number(slotEl.dataset.slot) });
      return;
    }
    const itemEl = target.closest<HTMLElement>('.home-chest__item[data-item-id]');
    if (itemEl?.dataset.itemId) {
      this.openSheet({ kind: 'withdraw', itemId: itemEl.dataset.itemId, qty: 1 });
    }
  }

  // ── Sheets (chest, shelves, invite, manage) ─────────────

  private openSheet(sheet: Sheet): void {
    this.sheet = sheet;
    this.notice = null;
    this.sheetEl.style.display = 'flex';
    bringToFront(this.sheetEl);
    this.renderSheet(true);
  }

  private closeSheet(): void {
    if (!this.sheet && this.sheetEl.style.display === 'none') return;
    this.sheet = null;
    this.sheetKey = '';
    this.sheetEl.style.display = 'none';
    this.sheetEl.innerHTML = '';
    release(this.sheetEl);
  }

  private renderSheet(force = false): void {
    const ctx = this.ctx;
    const sheet = this.sheet;
    if (!ctx || !sheet) return;
    if (!ctx.isOwner) {
      this.closeSheet();
      return;
    }
    const key = JSON.stringify({
      sheet,
      notice: this.notice,
      visit: ctx.visit,
      inv: ctx.state.character?.inventory ?? {},
      house: ctx.state.house ?? null,
      social: sheet.kind === 'invite' ? ctx.state.social ?? null : null,
      invited: [...this.invited],
    });
    if (!force && key === this.sheetKey) return;
    this.sheetKey = key;

    switch (sheet.kind) {
      case 'shelf': this.renderShelfSheet(ctx, sheet.slot); break;
      case 'withdraw': this.renderWithdrawSheet(ctx, sheet); break;
      case 'deposit': this.renderDepositSheet(ctx); break;
      case 'deposit-item': this.renderDepositItemSheet(ctx, sheet); break;
      case 'invite': this.renderInviteSheet(ctx); break;
      case 'manage': this.renderManageSheet(ctx); break;
      case 'sell-confirm': this.renderSellConfirm(ctx); break;
    }
  }

  private panel(title: string, body: string, actions: string, extraClass = ''): void {
    const noticeHtml = this.notice
      ? `<div class="home-sheet__notice" role="status">${escapeHtml(this.notice)}</div>`
      : '';
    this.sheetEl.innerHTML = `
      <div class="gc-modal__panel gc-parchment home-sheet__panel ${extraClass}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="gc-title-tab gc-modal__title"><span class="gc-title-tab__text">${escapeHtml(title)}</span></div>
        <button type="button" class="gc-close gc-modal__close home-sheet-close" aria-label="Close"></button>
        ${noticeHtml}
        <div class="gc-modal__body home-sheet__body">${body}</div>
        ${actions ? `<div class="gc-modal__actions">${actions}</div>` : ''}
      </div>`;
    this.on('.home-sheet-close', () => this.closeSheet());
  }

  private on(selector: string, fn: (el: HTMLElement) => void): void {
    for (const el of this.sheetEl.querySelectorAll<HTMLElement>(selector)) {
      el.addEventListener('click', () => {
        if ((el as HTMLButtonElement).disabled) return;
        fn(el);
      });
    }
  }

  private storageOf(ctx: Ctx): Record<string, number> {
    return ctx.visit.storage ?? ctx.state.house?.house.storage ?? {};
  }

  private chestHas(ctx: Ctx, itemId: string, qty: number): boolean {
    const storage = this.storageOf(ctx);
    const house = { houseId: ctx.visit.definition.id, purchasedAt: 0, storage, displays: ctx.visit.displays };
    return canStore(house, ctx.visit.definition, itemId, qty);
  }

  private chestFullWhy(ctx: Ctx): string {
    return `Your chest is full — all ${ctx.visit.definition.storageSlots} spaces hold something. Take an item out first.`;
  }

  private heroHtml(itemId: string, def: ItemDefinition | undefined, sub: string): string {
    return `<div class="home-sheet__hero">
      ${renderKitItem(itemId, def, { size: 'lg', decorative: true })}
      <div class="home-sheet__heading">
        <h3 class="home-sheet__name">${escapeHtml(def?.name ?? itemId)}</h3>
        ${sub ? `<span class="home-sheet__sub">${escapeHtml(sub)}</span>` : ''}
      </div>
    </div>`;
  }

  private itemGridHtml(entries: [string, number][], defs: Record<string, ItemDefinition>, cls: string, verb: string): string {
    return `<div class="home-sheet__grid">${entries.map(([id, n]) => renderKitItem(id, defs[id], {
      button: true,
      count: n,
      extraClass: cls,
      dataAttrs: { 'item-id': id },
      label: `${verb} ${defs[id]?.name ?? id}${n > 1 ? ` ×${n}` : ''}`,
    })).join('')}</div>`;
  }

  private stepperHtml(qty: number, max: number): string {
    return `<div class="gc-stepper gc-stepper--lg home-qty" role="group" aria-label="Quantity">
      <button type="button" class="gc-btn gc-btn--steel gc-btn--icon gc-stepper__btn home-qty-minus" aria-label="One fewer"${qty <= 1 ? ' disabled' : ''}>${ICON_MINUS}</button>
      <span class="gc-stepper__val home-qty-value" aria-live="polite">${qty}</span>
      <button type="button" class="gc-btn gc-btn--steel gc-btn--icon gc-stepper__btn home-qty-plus" aria-label="One more"${qty >= max ? ' disabled' : ''}>${ICON_PLUS}</button>
      <button type="button" class="gc-btn gc-btn--steel home-qty-all"${qty >= max ? ' disabled' : ''}>All</button>
    </div>`;
  }

  private wireStepper(sheet: { qty: number }, max: number): void {
    const set = (qty: number) => {
      sheet.qty = Math.max(1, Math.min(max, qty));
      this.renderSheet(true);
    };
    this.on('.home-qty-minus', () => set(sheet.qty - 1));
    this.on('.home-qty-plus', () => set(sheet.qty + 1));
    this.on('.home-qty-all', () => set(max));
  }

  private renderShelfSheet(ctx: Ctx, slot: number): void {
    const current = ctx.visit.displays[slot];
    if (current === undefined) { this.closeSheet(); return; }
    const n = slot + 1;
    if (current) {
      const def = ctx.defs[current];
      const fits = this.chestHas(ctx, current, 1);
      const why = fits ? '' : `<p class="gc-modal__why">${escapeHtml(this.chestFullWhy(ctx))}</p>`;
      this.panel(`Shelf ${n}`, `${this.heroHtml(current, def, 'On display for every visitor')}${why}`,
        `<button type="button" class="gc-btn home-sheet-back">Keep it</button>
         <button type="button" class="gc-btn gc-btn--gold gc-btn--lg home-shelf-return"${fits ? '' : ' disabled'}>Return to chest</button>`);
      this.on('.home-sheet-back', () => this.closeSheet());
      this.on('.home-shelf-return', () => {
        this.send(() => this.gameClient.sendHomeDisplay(slot, null));
        this.closeSheet();
      });
      return;
    }
    const entries = Object.entries(this.storageOf(ctx)).filter(([, c]) => c > 0);
    const body = entries.length
      ? `<p class="home-sheet__lead">Pick a treasure from your chest to show off on shelf ${n}.</p>${this.itemGridHtml(entries, ctx.defs, 'home-pick-trophy', 'Display')}`
      : renderEmptyState({ emblem: ICON_CHEST, title: 'Nothing to display yet', body: 'Deposit an item into your chest first, then put it on a shelf.', compact: true });
    this.panel('Choose a trophy', body, '');
    this.on('.home-pick-trophy', (el) => {
      const itemId = el.dataset.itemId;
      if (!itemId) return;
      this.send(() => this.gameClient.sendHomeDisplay(slot, itemId));
      this.closeSheet();
    });
  }

  private renderWithdrawSheet(ctx: Ctx, sheet: { itemId: string; qty: number }): void {
    const have = this.storageOf(ctx)[sheet.itemId] ?? 0;
    if (have <= 0) { this.closeSheet(); return; }
    sheet.qty = Math.min(sheet.qty, have);
    const def = ctx.defs[sheet.itemId];
    const freeShelf = ctx.visit.displays.indexOf(null);
    const stepper = have > 1 ? this.stepperHtml(sheet.qty, have) : '';
    this.panel('Your chest', `${this.heroHtml(sheet.itemId, def, `${have} in your chest`)}${stepper}`,
      `${freeShelf >= 0 ? '<button type="button" class="gc-btn home-chest-display">Put on shelf</button>' : ''}
       <button type="button" class="gc-btn gc-btn--gold gc-btn--lg home-chest-take">Take ${sheet.qty}</button>`);
    this.wireStepper(sheet, have);
    this.on('.home-chest-display', () => {
      this.send(() => this.gameClient.sendHomeDisplay(freeShelf, sheet.itemId));
      this.closeSheet();
    });
    this.on('.home-chest-take', () => {
      this.send(() => this.gameClient.sendHomeWithdraw(sheet.itemId, sheet.qty));
      this.closeSheet();
    });
  }

  private renderDepositSheet(ctx: Ctx): void {
    const entries = listUnequippedEntries(ctx.state.character?.inventory ?? {});
    const body = entries.length
      ? `<p class="home-sheet__lead">Choose something from your bag. Equipped gear stays on your hero.</p>${this.itemGridHtml(entries, ctx.defs, 'home-pick-deposit', 'Deposit')}`
      : renderEmptyState({ emblem: ICON_CHEST, title: 'Your bag is empty', body: 'Win some battles and bring the loot home.', compact: true });
    this.panel('Deposit', body, '');
    this.on('.home-pick-deposit', (el) => {
      const itemId = el.dataset.itemId;
      if (!itemId) return;
      this.sheet = { kind: 'deposit-item', itemId, qty: 1 };
      this.renderSheet(true);
    });
  }

  private renderDepositItemSheet(ctx: Ctx, sheet: { itemId: string; qty: number }): void {
    const have = listUnequippedEntries(ctx.state.character?.inventory ?? {}).find(([id]) => id === sheet.itemId)?.[1] ?? 0;
    if (have <= 0) {
      this.sheet = { kind: 'deposit' };
      this.renderSheet(true);
      return;
    }
    sheet.qty = Math.min(sheet.qty, have);
    const fits = this.chestHas(ctx, sheet.itemId, sheet.qty);
    const def = ctx.defs[sheet.itemId];
    const stepper = have > 1 ? this.stepperHtml(sheet.qty, have) : '';
    const why = fits ? '' : `<p class="gc-modal__why">${escapeHtml(this.chestFullWhy(ctx))}</p>`;
    this.panel('Deposit', `${this.heroHtml(sheet.itemId, def, `${have} in your bag`)}${stepper}${why}`,
      `<button type="button" class="gc-btn home-sheet-back">Back</button>
       <button type="button" class="gc-btn gc-btn--gold gc-btn--lg home-deposit-confirm"${fits ? '' : ' disabled'}>Store ${sheet.qty}</button>`);
    this.wireStepper(sheet, have);
    this.on('.home-sheet-back', () => {
      this.sheet = { kind: 'deposit' };
      this.renderSheet(true);
    });
    this.on('.home-deposit-confirm', () => {
      this.send(() => this.gameClient.sendHomeStore(sheet.itemId, sheet.qty));
      this.sheet = { kind: 'deposit' };
      this.renderSheet(true);
    });
  }

  private inviteCandidates(ctx: Ctx): { username: string; tag: string; online: boolean }[] {
    const social = ctx.state.social;
    const me = ctx.state.username;
    const inside = new Set(ctx.visit.occupants.map(o => o.username));
    const online = new Set(social?.onlinePlayers ?? []);
    const out = new Map<string, string>();
    for (const m of social?.party?.members ?? []) out.set(m.username, 'Party');
    for (const f of social?.friends ?? []) if (!out.has(f)) out.set(f, 'Friend');
    return [...out.entries()]
      .filter(([u]) => u !== me && !inside.has(u))
      .map(([username, tag]) => ({ username, tag, online: online.has(username) }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  }

  private renderInviteSheet(ctx: Ctx): void {
    const people = this.inviteCandidates(ctx);
    const rows = people.map(p => {
      const sent = this.invited.has(p.username);
      return `<div class="gc-row home-invite-row" data-username="${escapeHtml(p.username)}">
        ${renderPortrait({ name: p.username, size: 'sm', online: p.online })}
        <div class="gc-row__main">
          <div class="gc-row__title">${escapeHtml(p.username)}</div>
          <div class="gc-row__sub">${escapeHtml(p.tag)} · ${p.online ? 'Online' : 'Offline'}</div>
        </div>
        <button type="button" class="gc-btn ${sent ? 'gc-btn--steel' : 'gc-btn--green'} home-invite-send" data-username="${escapeHtml(p.username)}"${sent ? ' disabled' : ''}>${sent ? 'Invited' : 'Invite'}</button>
      </div>`;
    }).join('');
    const body = people.length
      ? `<p class="home-sheet__lead">Invite a friend or party member to sit by your fire.</p><div class="home-invite-list">${rows}</div>`
      : renderEmptyState({
        emblem: ICON_CHEST,
        title: 'No one to invite yet',
        body: 'Make friends or join a party, then invite them over.',
        compact: true,
      });
    this.panel('Invite', body, '');
    this.on('.home-invite-send', (el) => {
      const username = el.dataset.username;
      if (!username) return;
      this.send(() => this.gameClient.sendHomeInvite(username));
      this.invited.add(username);
      this.renderSheet(true);
    });
  }

  private houseDef(ctx: Ctx): HouseDefinition {
    return ctx.state.house?.definition ?? ctx.visit.definition;
  }

  private sellBlocker(ctx: Ctx): string | null {
    const hasStored = Object.values(this.storageOf(ctx)).some(n => n > 0);
    const hasTrophies = ctx.visit.displays.some(d => d !== null);
    if (hasStored || hasTrophies) return 'Empty your chest and trophy shelves before selling, so nothing is lost.';
    return null;
  }

  private renderManageSheet(ctx: Ctx): void {
    const def = this.houseDef(ctx);
    const refund = houseSellPrice(def);
    const blocker = this.sellBlocker(ctx);
    const body = `
      <div class="home-manage">
        ${houseArtHtml(def, 'home-manage__art')}
        <h3 class="home-sheet__name">${escapeHtml(def.name)}</h3>
        ${def.description ? `<p class="home-sheet__lead">${escapeHtml(def.description)}</p>` : ''}
        <div class="gc-facts home-manage__facts">
          <div class="gc-fact"><span class="gc-fact__label">Tier</span><span class="gc-fact__value">${def.tier}</span></div>
          <div class="gc-fact"><span class="gc-fact__label">Storage</span><span class="gc-fact__value">${def.storageSlots}</span></div>
          <div class="gc-fact"><span class="gc-fact__label">Shelves</span><span class="gc-fact__value">${def.displaySlots}</span></div>
        </div>
        <div class="gc-divider">Sell your home</div>
        <p class="home-manage__refund">Selling returns <span class="gc-coin gc-coin--sm" aria-hidden="true"></span><strong>${refund.toLocaleString()}</strong> gold.</p>
        ${blocker ? `<p class="gc-modal__why home-sell-why">${escapeHtml(blocker)}</p>` : ''}
      </div>`;
    this.panel('Manage home', body,
      `<button type="button" class="gc-btn gc-btn--red gc-btn--lg home-sell-btn"${blocker ? ' disabled' : ''}>Sell</button>`);
    this.on('.home-sell-btn', () => {
      this.sheet = { kind: 'sell-confirm' };
      this.renderSheet(true);
    });
  }

  private renderSellConfirm(ctx: Ctx): void {
    if (this.sellBlocker(ctx)) {
      this.sheet = { kind: 'manage' };
      this.renderSheet(true);
      return;
    }
    const def = this.houseDef(ctx);
    const refund = houseSellPrice(def);
    this.panel('Sell home?', `
      <div class="home-manage">
        <p class="home-sell-question">Sell ${escapeHtml(def.name)} for ${refund.toLocaleString()} gold?</p>
        <p class="home-sheet__lead">Everyone inside will be sent back out. You can buy a new home from an estate agent.</p>
      </div>`,
    `<button type="button" class="gc-btn home-sheet-back">Keep it</button>
     <button type="button" class="gc-btn gc-btn--red gc-btn--lg home-sell-confirm">Sell</button>`);
    this.on('.home-sheet-back', () => {
      this.sheet = { kind: 'manage' };
      this.renderSheet(true);
    });
    this.on('.home-sell-confirm', () => {
      this.send(() => this.gameClient.sendSellHouse());
      this.closeSheet();
    });
  }
}

/** Even rows: up to 3 shelves in one row, 4–6 as two rows of 3, larger sets five per row. */
function shelfColumns(count: number): number {
  if (count <= 3) return Math.max(1, count);
  return count <= 6 ? 3 : 5;
}
