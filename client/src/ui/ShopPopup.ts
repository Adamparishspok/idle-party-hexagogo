import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { ShopDefinition, ItemDefinition, SetDefinition } from '@idle-party-rpg/shared';
import { getUnequippedCount, listUnequippedEntries } from '@idle-party-rpg/shared';
import { escapeHtml, renderKitItem } from './ItemIcon';
import { renderItemPopupContent } from './ItemPopup';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import '../styles/screens/map.css';

const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';

/**
 * Shop: a parchment modal with the shop's name on the title tab, your gold
 * as a big outlined number, Buy/Sell tabs, and the wares as kit item frames
 * with their price under each. Tapping an item opens its detail view in
 * place — stats, a quantity stepper, the total in big numbers, and a gold
 * Buy/Sell button on the panel's bottom edge.
 */
export class ShopPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private mode: 'buy' | 'sell' = 'buy';
  /** View context — what's open inside the shop popup right now. */
  private view: { kind: 'grid' } | { kind: 'buy'; itemId: string; price: number; qty: number } | { kind: 'sell'; itemId: string; qty: number } = { kind: 'grid' };
  private notice: string | null = null;
  private noticeTimer: number | null = null;
  private unsubscribeState: (() => void) | null = null;
  /** Hash of the inputs that drove the most recent render. State ticks
   *  whose inputs match this skip the re-render entirely so item-artwork
   *  <img> elements aren't recreated and don't flicker. */
  private lastRenderKey: string = '';

  constructor(gameClient: GameClient, worldCache: WorldCache) {
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.overlay = document.createElement('div');
    this.overlay.className = 'gc-modal shop-modal';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    document.body.appendChild(this.overlay);
    wireFocusOnInteract(this.overlay);
  }

  show(state: ServerStateMessage): void {
    const shop = state.shopDefinition;
    if (!shop) return;
    this.mode = 'buy';
    this.view = { kind: 'grid' };
    this.notice = null;
    this.lastRenderKey = '';
    this.renderCurrentView(state);
    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);

    // Subscribe to state updates so the popup reflects post-action state (sold qty, gold, etc.)
    this.unsubscribeState?.();
    this.unsubscribeState = this.gameClient.subscribe(s => {
      if (this.overlay.style.display === 'none') return;
      if (!s.shopDefinition) { this.hide(); return; }
      this.renderCurrentView(s);
    });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    release(this.overlay);
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    // Reset the render-cache so the next time the popup opens it
    // re-renders fresh (player may have visited a different shop).
    this.lastRenderKey = '';
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.notice = null;
  }

  private renderCurrentView(state: ServerStateMessage): void {
    const shop = state.shopDefinition;
    if (!shop) return;

    // Skip re-render if nothing the popup cares about changed. State ticks
    // arrive once per second and were re-creating the img elements every
    // time, causing the artwork to flicker as it re-loaded.
    const key = JSON.stringify({
      view: this.view,
      mode: this.mode,
      notice: this.notice,
      shopId: shop.id,
      shopInv: shop.inventory,
      gold: state.character?.gold ?? 0,
      inv: state.character?.inventory ?? {},
      eq: state.character?.equipment ?? {},
    });
    if (key === this.lastRenderKey) return;
    this.lastRenderKey = key;

    if (this.view.kind === 'grid') {
      this.renderGrid(state, shop);
    } else if (this.view.kind === 'buy') {
      this.renderBuyDetail(this.view.itemId, this.view.price, state.itemDefinitions ?? {}, state.setDefinitions ?? {}, state, shop);
    } else if (this.view.kind === 'sell') {
      // Recompute max from current inventory minus equipped
      const max = this.computeSellable(state, this.view.itemId);
      if (max <= 0) {
        this.view = { kind: 'grid' };
        this.renderGrid(state, shop);
        return;
      }
      this.renderSellDetail(this.view.itemId, max, state.itemDefinitions ?? {}, state.setDefinitions ?? {}, state, shop);
    }
  }

  private computeSellable(state: ServerStateMessage, itemId: string): number {
    const char = state.character;
    if (!char) return 0;
    return getUnequippedCount(itemId, char.inventory);
  }

  private setNotice(message: string): void {
    this.notice = message;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.notice = null;
      this.noticeTimer = null;
      const state = this.gameClient.lastState;
      if (state && this.overlay.style.display !== 'none') this.renderCurrentView(state);
    }, 3500);
  }

  /** Shared panel chrome: title tab, close, purse, notice. */
  private panel(shop: ShopDefinition, gold: number, body: string, actions: string, extraClass = ''): string {
    const noticeHtml = this.notice
      ? `<div class="shop-modal__notice" role="status">${escapeHtml(this.notice)}</div>`
      : '';
    return `
      <div class="gc-modal__panel gc-parchment shop-modal__panel ${extraClass}" role="dialog" aria-modal="true" aria-label="${escapeHtml(shop.name)}">
        <div class="gc-title-tab gc-modal__title shop-modal__title"><span class="gc-title-tab__text">${escapeHtml(shop.name)}</span></div>
        <button type="button" class="gc-close gc-modal__close shop-close-btn" aria-label="Close"></button>
        <div class="shop-modal__purse" aria-label="Your gold">
          <span class="gc-coin" aria-hidden="true"></span>
          <span class="shop-modal__gold">${gold.toLocaleString()}</span>
        </div>
        ${noticeHtml}
        ${body}
        ${actions ? `<div class="gc-modal__actions">${actions}</div>` : ''}
      </div>
    `;
  }

  /** Render the main grid view (buy or sell item list). */
  private renderGrid(state: ServerStateMessage, shop: ShopDefinition): void {
    const char = state.character;
    if (!char) return;
    const itemDefs = state.itemDefinitions ?? {};
    const setDefs = state.setDefinitions ?? {};

    const itemsHtml = this.mode === 'buy'
      ? this.renderBuyItems(shop, itemDefs, setDefs)
      : this.renderSellItems(char.inventory, char.equipment, itemDefs, setDefs);

    const body = `
      <div class="gc-tabs shop-modal__tabs" role="tablist">
        <button type="button" role="tab" class="gc-tab shop-toggle-btn" data-mode="buy" aria-selected="${this.mode === 'buy'}">Buy</button>
        <button type="button" role="tab" class="gc-tab shop-toggle-btn" data-mode="sell" aria-selected="${this.mode === 'sell'}">Sell</button>
      </div>
      <div class="gc-modal__body shop-modal__grid">${itemsHtml}</div>
    `;
    this.overlay.innerHTML = this.panel(shop, char.gold, body, '');

    for (const btn of this.overlay.querySelectorAll('.shop-toggle-btn')) {
      btn.addEventListener('click', () => {
        this.mode = (btn as HTMLElement).dataset.mode as 'buy' | 'sell';
        this.view = { kind: 'grid' };
        this.renderGrid(state, shop);
      });
    }

    for (const el of this.overlay.querySelectorAll('.shop-cell')) {
      el.addEventListener('click', () => {
        const itemId = (el as HTMLElement).dataset.itemId;
        if (!itemId) return;
        if (this.mode === 'buy') {
          const price = parseInt((el as HTMLElement).dataset.price ?? '0', 10);
          this.view = { kind: 'buy', itemId, price, qty: 1 };
          this.renderBuyDetail(itemId, price, itemDefs, setDefs, state, shop);
        } else {
          const max = parseInt((el as HTMLElement).dataset.qty ?? '1', 10);
          this.view = { kind: 'sell', itemId, qty: 1 };
          this.renderSellDetail(itemId, max, itemDefs, setDefs, state, shop);
        }
      });
    }

    this.overlay.querySelector('.shop-close-btn')?.addEventListener('click', () => this.hide());
  }

  /** One ware: item frame, outlined price with a coin, and the name. */
  private cell(itemId: string, def: ItemDefinition | undefined, price: number, data: Record<string, string>, qty?: number): string {
    const name = def?.name ?? itemId;
    const dataStr = Object.entries(data).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('');
    return `
      <button type="button" class="shop-cell"${dataStr} aria-label="${escapeHtml(name)}, ${price} gold">
        ${renderKitItem(itemId, def, { count: qty })}
        <span class="shop-cell__price"><span class="gc-coin gc-coin--sm" aria-hidden="true"></span>${price}</span>
        <span class="shop-cell__name">${escapeHtml(name)}</span>
      </button>`;
  }

  private renderBuyItems(shop: ShopDefinition, itemDefs: Record<string, ItemDefinition>, _setDefs: Record<string, SetDefinition>): string {
    if (shop.inventory.length === 0) {
      return '<p class="shop-modal__empty">Nothing for sale right now.</p>';
    }
    return shop.inventory
      .map(si => this.cell(si.itemId, itemDefs[si.itemId], si.price, { 'item-id': si.itemId, price: String(si.price) }))
      .join('');
  }

  private renderSellItems(
    inventory: Record<string, number>,
    _equipment: Record<string, string | null>,
    itemDefs: Record<string, ItemDefinition>,
    _setDefs: Record<string, SetDefinition>,
  ): string {
    // Sellable = every unequipped copy. `inventory` already excludes equipped copies
    // (`equipItem` removes from inventory on equip), so do NOT subtract equipped counts.
    const entries = listUnequippedEntries(inventory);

    if (entries.length === 0) {
      return '<p class="shop-modal__empty">No items to sell</p>';
    }

    return entries.map(([itemId, qty]) => {
      const def = itemDefs[itemId];
      const value = def ? (def.value ?? 1) : 1;
      return this.cell(itemId, def, value, { 'item-id': itemId, qty: String(qty) }, qty);
    }).join('');
  }

  /** Detail body shared by buy and sell: hero frame, stats, stepper, total. */
  private detailBody(
    itemId: string, def: ItemDefinition, qty: number, unitPrice: number,
    itemDefs: Record<string, ItemDefinition>, setDefs: Record<string, SetDefinition>,
    state: ServerStateMessage, maxLabel: string, availableNote: string,
  ): string {
    const stats = renderItemPopupContent(def, {
      itemDefs,
      setDefs,
      className: state.character?.className ?? null,
      skills: this.worldCache.getSkillContent().skills,
    });
    const rarity = def.rarity ?? 'common';
    return `
      <div class="gc-modal__body shop-detail">
        <div class="shop-detail__hero">
          ${renderKitItem(itemId, def, { size: 'lg' })}
          <div class="shop-detail__heading">
            <h2 class="shop-detail__name">${escapeHtml(def.name)}</h2>
            <span class="gc-tag gc-tag--rarity shop-detail__rarity" data-rarity="${escapeHtml(rarity)}">${escapeHtml(rarity)}</span>
          </div>
        </div>
        <div class="shop-detail__stats">${stats}</div>
        <div class="gc-stepper gc-stepper--lg shop-detail__qty" role="group" aria-label="Quantity">
          <button type="button" class="gc-btn gc-btn--steel gc-btn--icon gc-stepper__btn shop-qty-minus" aria-label="One fewer">${ICON_MINUS}</button>
          <span class="gc-stepper__val shop-qty-value" aria-live="polite">${qty}</span>
          <button type="button" class="gc-btn gc-btn--steel gc-btn--icon gc-stepper__btn shop-qty-plus" aria-label="One more">${ICON_PLUS}</button>
          <button type="button" class="gc-btn gc-btn--steel shop-qty-all">${maxLabel}</button>
        </div>
        <div class="shop-detail__total">
          <span class="shop-detail__total-label">Total</span>
          <span class="shop-detail__total-num"><span class="gc-coin" aria-hidden="true"></span><span class="shop-total-value">${qty * unitPrice}</span></span>
          ${availableNote}
        </div>
      </div>
    `;
  }

  /** Render a buy detail view inside the shop popup container. */
  private renderBuyDetail(
    itemId: string, price: number,
    itemDefs: Record<string, ItemDefinition>,
    setDefs: Record<string, SetDefinition>,
    state: ServerStateMessage, shop: ShopDefinition,
  ): void {
    const def = itemDefs[itemId];
    if (!def) return;

    const gold = state.character?.gold ?? 0;
    const maxAffordable = Math.max(1, Math.floor(gold / price));
    if (this.view.kind !== 'buy') this.view = { kind: 'buy', itemId, price, qty: 1 };
    let qty = Math.min(this.view.qty, maxAffordable);
    this.view.qty = qty;

    const body = this.detailBody(itemId, def, qty, price, itemDefs, setDefs, state, 'Max', '');
    const actions = `
      <button type="button" class="gc-btn shop-detail-back">Back</button>
      <button type="button" class="gc-btn gc-btn--gold gc-btn--lg shop-action-confirm">Buy</button>`;
    this.overlay.innerHTML = this.panel(shop, gold, body, actions, 'is-detail');

    const updateQty = () => {
      if (this.view.kind === 'buy') this.view.qty = qty;
      this.setQtyText(qty, qty * price, qty * price > gold);
    };
    updateQty();

    this.wireStepper(
      () => { qty = Math.max(1, qty - 1); updateQty(); },
      () => { qty = Math.min(maxAffordable, qty + 1); updateQty(); },
      () => { qty = maxAffordable; updateQty(); },
    );
    this.overlay.querySelector('.shop-action-confirm')?.addEventListener('click', () => {
      for (let i = 0; i < qty; i++) {
        this.gameClient.sendShopBuy(itemId);
      }
      const noun = qty === 1 ? def.name : `${qty} ${def.name}`;
      this.setNotice(`You bought ${noun} for ${qty * price} gold.`);
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
    this.wireBackAndClose(state, shop);
  }

  /** Render a sell detail view inside the shop popup container. */
  private renderSellDetail(
    itemId: string, max: number,
    itemDefs: Record<string, ItemDefinition>,
    setDefs: Record<string, SetDefinition>,
    state: ServerStateMessage, shop: ShopDefinition,
  ): void {
    const def = itemDefs[itemId];
    if (!def) return;
    const value = def.value ?? 1;

    if (this.view.kind !== 'sell') this.view = { kind: 'sell', itemId, qty: 1 };
    let qty = Math.min(this.view.qty, max);
    this.view.qty = qty;

    const available = `<span class="shop-detail__available">You have ${max}</span>`;
    const body = this.detailBody(itemId, def, qty, value, itemDefs, setDefs, state, 'All', available);
    const actions = `
      <button type="button" class="gc-btn shop-detail-back">Back</button>
      <button type="button" class="gc-btn gc-btn--gold gc-btn--lg shop-action-confirm">Sell</button>`;
    this.overlay.innerHTML = this.panel(shop, state.character?.gold ?? 0, body, actions, 'is-detail');

    const updateQty = () => {
      if (this.view.kind === 'sell') this.view.qty = qty;
      this.setQtyText(qty, qty * value, false);
    };

    this.wireStepper(
      () => { qty = Math.max(1, qty - 1); updateQty(); },
      () => { qty = Math.min(max, qty + 1); updateQty(); },
      () => { qty = max; updateQty(); },
    );
    this.overlay.querySelector('.shop-action-confirm')?.addEventListener('click', () => {
      this.gameClient.sendShopSell(itemId, qty);
      const noun = qty === 1 ? def.name : `${qty} ${def.name}`;
      this.setNotice(`You sold ${noun} for ${qty * value} gold.`);
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
    this.wireBackAndClose(state, shop);
  }

  private setQtyText(qty: number, total: number, short: boolean): void {
    const qtyEl = this.overlay.querySelector('.shop-qty-value');
    const totalEl = this.overlay.querySelector('.shop-total-value');
    if (qtyEl) qtyEl.textContent = String(qty);
    if (totalEl) totalEl.textContent = String(total);
    // Can't cover the total: tint it red (the server still has the final say).
    this.overlay.querySelector('.shop-detail__total')?.classList.toggle('is-short', short);
  }

  private wireStepper(minus: () => void, plus: () => void, all: () => void): void {
    this.overlay.querySelector('.shop-qty-minus')?.addEventListener('click', minus);
    this.overlay.querySelector('.shop-qty-plus')?.addEventListener('click', plus);
    this.overlay.querySelector('.shop-qty-all')?.addEventListener('click', all);
  }

  private wireBackAndClose(state: ServerStateMessage, shop: ShopDefinition): void {
    this.overlay.querySelector('.shop-detail-back')?.addEventListener('click', () => {
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
    this.overlay.querySelector('.shop-close-btn')?.addEventListener('click', () => this.hide());
  }
}
