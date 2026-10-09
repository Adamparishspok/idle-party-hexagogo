import type { ServerStateMessage, TradeOfferItem, TradeState } from '@idle-party-rpg/shared';
import { listUnequippedEntries } from '@idle-party-rpg/shared';
import type { GameClient } from '../../network/GameClient';
import type { WorldCache } from '../../network/WorldCache';
import { esc, portraitHtml } from './socialHtml';
import { openSocModal, setHtmlKeepScroll } from './socialModal';
import type { SocModal } from './socialModal';
import { applyStep, offerSideHtml, pickerHtml } from './itemPicker';
import type { PickerCtx } from './itemPicker';

/**
 * Async trade dialog. Parchment modal with the two offers side by side
 * ("You give" / "<name> gives"), a status line saying whose move it is,
 * the bag picker for building or updating your offer, and pinned actions
 * (gold Confirm when the partner moved last).
 *
 * The bag is snapshotted when the dialog opens so the state tick can't move
 * items out from under the selection (issue #342); the server validates.
 */
export class TradeModal {
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private getState: () => ServerStateMessage | null;
  private getClassName: (username: string) => string | undefined;

  private modal: SocModal | null = null;
  private selected = new Map<string, number>();
  /** Existing trade being viewed; null while composing a new proposal. */
  private activeId: string | null = null;
  /** Target when composing a new proposal. */
  private targetUsername: string | null = null;
  private inventorySnapshot: Record<string, number> | null = null;
  /** Fingerprint of the last render — ticks skip the rewrite when unchanged. */
  private lastRenderKey = '';
  /** Offer version the Confirm button is armed against. */
  private confirmNonce: string | null = null;
  /** True when the last paint put a live Confirm button on screen. */
  private confirmArmed = false;
  /** The offer moved while Confirm was armed — Confirm is withheld until acknowledged. */
  private awaitingReview = false;
  private notice: string | null = null;
  /** The dialog outlives SocialScreen's own subscription (Items opens it without a screen switch). */
  private unsubState?: () => void;

  constructor(
    gameClient: GameClient,
    worldCache: WorldCache,
    getState: () => ServerStateMessage | null,
    getClassName: (username: string) => string | undefined,
  ) {
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.getState = getState;
    this.getClassName = getClassName;

    this.gameClient.onServerError((_message, code) => {
      if (code !== 'trade_nonce_mismatch' || !this.modal) return;
      this.notice = 'That offer changed before your confirmation went through. Review the updated offer below, then confirm again.';
      this.update();
    });
  }

  /** Resume the trade with `targetUsername` if one exists, else start a proposal. */
  open(targetUsername: string): void {
    const existing = this.findTradeWith(targetUsername);
    if (existing) {
      this.openExisting(existing.id);
      return;
    }
    this.activeId = null;
    this.targetUsername = targetUsername;
    this.show();
  }

  openExisting(tradeId: string): void {
    this.activeId = tradeId;
    this.targetUsername = null;
    this.show();
  }

  findTradeWith(username: string): TradeState | undefined {
    const self = this.getState()?.username ?? '';
    return (this.getState()?.social?.proposedTrades ?? []).find(t => {
      const a = t.initiator.username;
      const b = t.target?.username;
      return (a === self && b === username) || (a === username && b === self);
    });
  }

  dismiss(): void {
    this.modal?.close();
  }

  /** Called on every state tick while open. */
  update(): void {
    const modal = this.modal;
    if (!modal) return;

    const state = this.getState();
    const trade = this.getActiveTrade();
    this.gateConfirm(trade, state?.username ?? '');
    const renderKey = this.computeRenderKey(trade);
    if (renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;

    // The viewed trade is gone (confirmed / cancelled) — close.
    if (this.activeId && !trade) { this.dismiss(); return; }
    if (!trade && !this.targetUsername) { this.dismiss(); return; }

    const self = state?.username ?? '';
    const partner = trade
      ? (trade.initiator.username === self ? (trade.target?.username ?? '') : trade.initiator.username)
      : (this.targetUsername ?? '');
    const isInitiator = trade ? trade.initiator.username === self : true;
    const myOffer = trade ? (isInitiator ? trade.initiator.items : (trade.target?.items ?? [])) : [];
    const theirOffer = trade ? (isInitiator ? (trade.target?.items ?? []) : trade.initiator.items) : [];
    const waitingOnMe = trade ? trade.lastUpdatedBy !== self : false;

    const ctx: PickerCtx = {
      itemDefs: state?.itemDefinitions ?? {},
      skillDefs: this.worldCache.getSkillContent().skills,
    };
    const inventory = this.inventorySnapshot ?? {};
    const tradeable = listUnequippedEntries(inventory).map(([id]) => id);
    const selItems: TradeOfferItem[] = Array.from(this.selected.entries()).map(([itemId, quantity]) => ({ itemId, quantity }));
    const hasSel = selItems.length > 0;
    const p = esc(partner);

    modal.setTitle(`Trade with ${partner}`);

    // What each side shows, plus status / picker copy and the action set.
    let mine: TradeOfferItem[];
    let theirs: TradeOfferItem[];
    let mineLabel = 'You give';
    let status = '';
    let tone: 'wait' | 'act' = 'act';
    let pickLabel: string;
    let primary = '';
    const secondary: string[] = [];
    const send = (label: string, gold = false) =>
      `<button type="button" class="gc-btn ${gold ? 'gc-btn--gold gc-btn--lg' : 'gc-btn--green'} gc-btn--block" data-action="trade-send"${hasSel ? '' : ' disabled'}>${label}</button>`;
    const cancel = (label: string) =>
      `<button type="button" class="gc-btn gc-btn--red gc-btn--block" data-action="trade-cancel">${label}</button>`;

    if (!trade) {
      mine = selItems;
      theirs = [];
      status = `Pick what you'll offer ${p}. They can accept or counter whenever they're around.`;
      pickLabel = 'Your bag';
      primary = send('Send Offer', true);
    } else if (trade.status === 'countered' && waitingOnMe) {
      mine = myOffer;
      theirs = theirOffer;
      status = `${p} updated their offer. Confirm to swap, or counter with new items.`;
      pickLabel = 'Counter with';
      // Confirm carries the nonce of the offer on screen; the server rejects a stale one.
      primary = this.awaitingReview
        ? '<button type="button" class="gc-btn gc-btn--steel gc-btn--lg gc-btn--block" data-action="trade-review">Review Updated Offer</button>'
        : `<button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block" data-action="trade-confirm" data-nonce="${esc(trade.nonce)}">Confirm Trade</button>`;
      secondary.push(send('Counter'), cancel('Cancel Trade'));
    } else if (trade.status === 'countered') {
      mine = myOffer;
      theirs = theirOffer;
      status = `Waiting for ${p} to confirm or counter…`;
      tone = 'wait';
      pickLabel = 'Update your offer';
      secondary.push(send('Update Offer'), cancel('Cancel Trade'));
    } else if (waitingOnMe) {
      // Partner proposed; my side is empty until I pick a counter.
      mine = selItems;
      mineLabel = 'Your counter';
      theirs = theirOffer;
      status = `${p} wants to trade. Pick something to send back.`;
      pickLabel = 'Counter with';
      primary = send('Send Back', true);
      secondary.push(cancel('Decline'));
    } else {
      mine = myOffer;
      theirs = [];
      status = `Waiting for ${p} to respond…`;
      tone = 'wait';
      pickLabel = 'Update your offer';
      secondary.push(send('Update Offer'), cancel('Cancel Trade'));
    }

    setHtmlKeepScroll(modal.body, `
      <div class="soc-trade-head">
        ${portraitHtml({ name: partner, className: this.getClassName(partner), size: 'md' })}
        <p class="soc-status soc-status--${tone}">${status}</p>
      </div>
      <div class="soc-trade-sides">
        ${offerSideHtml(mineLabel, mine, ctx)}
        <span class="soc-trade-swap" aria-hidden="true">⇄</span>
        ${offerSideHtml(`${partner} gives`, theirs, ctx)}
      </div>
      <div class="gc-divider soc-divider">${esc(pickLabel)}</div>
      ${pickerHtml(tradeable, inventory, this.selected, ctx, 'trade', 'Nothing to trade — only unequipped items can be offered.')}
    `);
    const noticeHtml = this.notice ? `<p class="gc-modal__why soc-trade-notice" role="alert">${esc(this.notice)}</p>` : '';
    modal.footer.innerHTML = `
      ${noticeHtml}
      ${primary}
      ${secondary.length ? `<div class="gc-modal__footer-row">${secondary.join('')}</div>` : ''}
    `;
  }

  private show(): void {
    this.modal?.close();
    this.selected = new Map();
    this.inventorySnapshot = { ...(this.getState()?.character?.inventory ?? {}) };
    this.lastRenderKey = '';
    this.confirmNonce = null;
    this.confirmArmed = false;
    this.awaitingReview = false;
    this.notice = null;
    this.unsubState?.();
    this.unsubState = this.gameClient.subscribe(() => this.update());

    const modal = openSocModal({ title: 'Trade', variant: 'trade', onClose: () => this.reset(modal) });
    this.modal = modal;
    modal.root.addEventListener('click', (e) => this.onClick(e));
    this.update();
  }

  private reset(closing: SocModal): void {
    // A newer dialog may already have replaced this one.
    if (this.modal !== closing) return;
    this.modal = null;
    this.unsubState?.();
    this.unsubState = undefined;
    this.confirmNonce = null;
    this.confirmArmed = false;
    this.awaitingReview = false;
    this.notice = null;
    this.selected = new Map();
    this.activeId = null;
    this.targetUsername = null;
    this.inventorySnapshot = null;
    this.lastRenderKey = '';
  }

  private onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.getAttribute('data-action');

    if (action === 'trade-cancel') {
      const trade = this.getActiveTrade();
      if (trade) this.gameClient.sendCancelTrade(trade.id);
      this.dismiss();
      return;
    }
    if (action === 'trade-review') {
      this.awaitingReview = false;
      this.notice = null;
      this.update();
      return;
    }
    if (action === 'trade-confirm') {
      const trade = this.getActiveTrade();
      const nonce = btn.getAttribute('data-nonce');
      if (!trade || !nonce) return;
      this.notice = null;
      this.gameClient.sendConfirmTrade(trade.id, nonce);
      return;
    }
    if (action === 'trade-send') {
      const items: TradeOfferItem[] = Array.from(this.selected.entries()).map(([itemId, quantity]) => ({ itemId, quantity }));
      if (items.length === 0) return;
      const trade = this.getActiveTrade();
      if (trade) this.gameClient.sendCounterTrade(trade.id, items);
      else if (this.targetUsername) this.gameClient.sendProposeTrade(this.targetUsername, items);
      // Server response repaints. The review gate stays up: a rejected or dropped
      // counter never repaints, and the next tick must not turn it into a live Confirm.
      this.selected = new Map();
      return;
    }
    if (applyStep(btn, 'trade', this.selected, this.inventorySnapshot ?? {})) {
      this.update();
    }
  }

  /** Re-arming Confirm on a moved offer would let the partner swap items mid-click; withhold it until acknowledged. */
  private gateConfirm(trade: TradeState | null, self: string): void {
    const confirmOnScreen = !!trade && trade.status === 'countered' && trade.lastUpdatedBy !== self;
    if (!confirmOnScreen) {
      this.awaitingReview = false;
      this.notice = null;
    } else if (trade && this.confirmArmed && this.confirmNonce !== null && trade.nonce !== this.confirmNonce) {
      this.awaitingReview = true;
      this.notice = 'Their offer changed while you were looking at it. Check the new offer, then confirm.';
    }
    this.confirmArmed = confirmOnScreen && !this.awaitingReview;
    this.confirmNonce = trade?.nonce ?? null;
  }

  private getActiveTrade(): TradeState | null {
    if (!this.activeId) return null;
    return this.getState()?.social?.proposedTrades?.find(t => t.id === this.activeId) ?? null;
  }

  private computeRenderKey(trade: TradeState | null): string {
    const sel = Array.from(this.selected.entries()).map(([id, q]) => `${id}:${q}`).sort().join(',');
    const gate = `${this.notice ?? ''}|${this.awaitingReview ? 'review' : ''}`;
    if (!trade) return `new|${this.targetUsername ?? ''}|${sel}|${gate}`;
    const offer = (items: TradeOfferItem[]) => items.map(i => `${i.itemId}:${i.quantity}`).sort().join(',');
    return [trade.id, trade.status, trade.lastUpdatedBy, trade.nonce, offer(trade.initiator.items), offer(trade.target?.items ?? []), sel, gate].join('|');
  }
}
