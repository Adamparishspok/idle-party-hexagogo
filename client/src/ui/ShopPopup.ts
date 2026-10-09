import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { ShopDefinition, ItemDefinition, SetDefinition, HenchmanOffer, HiredHenchman, HouseOffer } from '@idle-party-rpg/shared';
import { describeHomeLocation, getUnequippedCount, listUnequippedEntries, MAX_PARTY_SIZE, MAX_HENCHMEN_PER_PARTY } from '@idle-party-rpg/shared';
import { escapeHtml, renderKitItem } from './ItemIcon';
import { renderItemPopupContent } from './ItemPopup';
import { houseArtHtml } from './HouseArt';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import '../styles/screens/map.css';

const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
type ShopMode = 'buy' | 'sell' | 'hire' | 'houses';

const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';

/**
 * Shop: a parchment modal with the shop's name on the title tab, your gold
 * as a big outlined number, Buy/Sell tabs, and the wares as kit item frames
 * with their price under each. Tapping an item opens its detail view in
 * place — stats, a quantity stepper, the total in big numbers, and a gold
 * Buy/Sell button on the panel's bottom edge. A Hire tab lists the room's
 * henchmen for hire while the shop offers any, and a Houses tab lists the
 * homes an estate agent sells.
 */
export class ShopPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  /** `hire` / `houses` only exist while the room's shop offers henchmen / houses. */
  private mode: ShopMode = 'buy';
  /** View context — what's open inside the shop popup right now. */
  private view: { kind: 'grid' } | { kind: 'buy'; itemId: string; price: number; qty: number } | { kind: 'sell'; itemId: string; qty: number } | { kind: 'replace'; henchmanId: string } | { kind: 'house'; houseId: string } = { kind: 'grid' };
  private notice: string | null = null;
  private noticeTimer: number | null = null;
  private unsubscribeState: (() => void) | null = null;
  /** Henchman id of a hire awaiting a server answer, so only its refusal shows. */
  private pendingHireId: string | null = null;
  private pendingHouse: HouseOffer | null = null;
  private unsubscribeError: (() => void) | null = null;
  /** Hash of the inputs that drove the most recent render. State ticks
   *  whose inputs match this skip the re-render entirely so item-artwork
   *  <img> elements aren't recreated and don't flicker. */
  private lastRenderKey: string = '';
  private onOpenBank: (() => void) | null = null;

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

  /** Banker shops get an "Open your bank" button that calls `cb`. */
  setOnOpenBank(cb: () => void): void {
    this.onOpenBank = cb;
  }

  show(state: ServerStateMessage): void {
    const shop = state.shopDefinition;
    if (!shop) return;
    this.mode = ShopPopup.initialMode(state, shop);
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
      // A state tick means the hire landed — a refusal arrives as an error first.
      this.pendingHireId = null;
      if (this.pendingHouse && s.house?.house.houseId === this.pendingHouse.houseId) {
        const name = this.pendingHouse.name;
        this.pendingHouse = null;
        this.setNotice(`${name} is yours! Tap the house at the top of the screen to go home.`);
      }
      this.renderCurrentView(s);
    });

    // A hire refusal arrives as an `error`, not a state change; only claim one while a hire is outstanding.
    this.unsubscribeError?.();
    this.unsubscribeError = this.gameClient.onServerError((message, code) => {
      if (this.overlay.style.display === 'none') return;
      const houseRefusal = !!this.pendingHouse && !!code?.startsWith('house_');
      const hireRefusal = !!this.pendingHireId && !code;
      if (!houseRefusal && !hireRefusal) return;
      this.pendingHireId = null;
      this.pendingHouse = null;
      this.setNotice(message);
      const s = this.gameClient.lastState;
      if (s) this.renderCurrentView(s);
    });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    release(this.overlay);
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.pendingHireId = null;
    this.pendingHouse = null;
    // Reset the render-cache so the next time the popup opens it
    // re-renders fresh (player may have visited a different shop).
    this.lastRenderKey = '';
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.notice = null;
  }

  private static initialMode(state: ServerStateMessage, shop: ShopDefinition): ShopMode {
    if (shop.inventory.length > 0) return 'buy';
    if ((state.henchmanOffers?.length ?? 0) > 0) return 'hire';
    if ((state.houseOffers?.length ?? 0) > 0) return 'houses';
    return 'buy';
  }

  private static hiredHenchmen(state: ServerStateMessage): HiredHenchman[] {
    return state.social?.party?.henchmen ?? [];
  }

  /** Whether one more henchman fits without anyone leaving. */
  private static hasRoomForHire(state: ServerStateMessage): boolean {
    const hired = ShopPopup.hiredHenchmen(state).length;
    const members = state.social?.party?.members.length ?? 1;
    return hired < MAX_HENCHMEN_PER_PARTY && members + hired < MAX_PARTY_SIZE;
  }

  private renderCurrentView(state: ServerStateMessage): void {
    const shop = state.shopDefinition;
    if (!shop) return;

    const offers = state.henchmanOffers ?? [];
    const houses = state.houseOffers ?? [];
    if (this.mode === 'hire' && offers.length === 0) this.mode = 'buy';
    if (this.mode === 'houses' && houses.length === 0) this.mode = 'buy';

    // Skip re-render if nothing the popup cares about changed. State ticks
    // arrive once per second and were re-creating the img elements every
    // time, causing the artwork to flicker as it re-loaded.
    const key = JSON.stringify({
      view: this.view,
      mode: this.mode,
      notice: this.notice,
      shopId: shop.id,
      shopInv: shop.inventory,
      offers,
      hired: ShopPopup.hiredHenchmen(state).map(h => `${h.instanceId}:${h.name ?? ''}`),
      room: ShopPopup.hasRoomForHire(state),
      houses,
      ownedHouse: state.house?.house.houseId ?? null,
      gold: state.character?.gold ?? 0,
      inv: state.character?.inventory ?? {},
      eq: state.character?.equipment ?? {},
      bank: !!state.bank,
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
    } else if (this.view.kind === 'replace') {
      if (ShopPopup.hiredHenchmen(state).length === 0) {
        this.view = { kind: 'grid' };
        this.renderGrid(state, shop);
        return;
      }
      this.renderReplaceConfirm(this.view.henchmanId, state, shop);
    } else if (this.view.kind === 'house') {
      this.renderHouseConfirm(this.view.houseId, state, shop);
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
  private panel(shop: ShopDefinition, gold: number, body: string, actions: string, extraClass = '', title = shop.name): string {
    const noticeHtml = this.notice
      ? `<div class="shop-modal__notice" role="status">${escapeHtml(this.notice)}</div>`
      : '';
    return `
      <div class="gc-modal__panel gc-parchment shop-modal__panel ${extraClass}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="gc-title-tab gc-modal__title shop-modal__title"><span class="gc-title-tab__text">${escapeHtml(title)}</span></div>
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

  /** Render the main grid view (buy / sell item list, or the hire list). */
  private renderGrid(state: ServerStateMessage, shop: ShopDefinition): void {
    const char = state.character;
    if (!char) return;
    const itemDefs = state.itemDefinitions ?? {};
    const setDefs = state.setDefinitions ?? {};
    const offers = state.henchmanOffers ?? [];

    const houses = state.houseOffers ?? [];
    const listHtml = this.mode === 'hire'
      ? `<div class="gc-modal__body shop-hire">${this.renderHireList(offers, state)}</div>`
      : this.mode === 'houses'
      ? `<div class="gc-modal__body shop-houses">${this.renderHouseList(houses, state)}</div>`
      : `<div class="gc-modal__body shop-modal__grid">${this.mode === 'buy'
          ? this.renderBuyItems(shop, itemDefs, setDefs)
          : this.renderSellItems(char.inventory, char.equipment, itemDefs, setDefs)}</div>`;

    const hireTab = offers.length > 0
      ? `<button type="button" role="tab" class="gc-tab shop-toggle-btn" data-mode="hire" aria-selected="${this.mode === 'hire'}">Hire</button>`
      : '';
    const housesTab = houses.length > 0
      ? `<button type="button" role="tab" class="gc-tab shop-toggle-btn" data-mode="houses" aria-selected="${this.mode === 'houses'}">Houses</button>`
      : '';

    const body = `
      <div class="gc-tabs shop-modal__tabs" role="tablist">
        <button type="button" role="tab" class="gc-tab shop-toggle-btn" data-mode="buy" aria-selected="${this.mode === 'buy'}">Buy</button>
        <button type="button" role="tab" class="gc-tab shop-toggle-btn" data-mode="sell" aria-selected="${this.mode === 'sell'}">Sell</button>
        ${hireTab}
        ${housesTab}
      </div>
      ${listHtml}
    `;
    const bankBtn = shop.banker && state.bank && this.onOpenBank
      ? '<button type="button" class="gc-btn gc-btn--gold gc-btn--lg shop-open-bank">Open your bank</button>'
      : '';
    this.overlay.innerHTML = this.panel(shop, char.gold, body, bankBtn);
    this.overlay.querySelector('.shop-open-bank')?.addEventListener('click', () => {
      const open = this.onOpenBank;
      this.hide();
      open?.();
    });

    for (const btn of this.overlay.querySelectorAll('.shop-toggle-btn')) {
      btn.addEventListener('click', () => {
        this.mode = (btn as HTMLElement).dataset.mode as ShopMode;
        this.view = { kind: 'grid' };
        this.renderGrid(state, shop);
      });
    }

    for (const btn of this.overlay.querySelectorAll('.shop-hire-btn')) {
      btn.addEventListener('click', () => {
        const henchmanId = (btn as HTMLElement).dataset.henchmanId;
        if (!henchmanId) return;
        if (!ShopPopup.hasRoomForHire(state) && ShopPopup.hiredHenchmen(state).length > 0) {
          this.view = { kind: 'replace', henchmanId };
          this.renderCurrentView(state);
          return;
        }
        this.pendingHireId = henchmanId;
        this.gameClient.sendHireHenchman(henchmanId);
        this.renderGrid(state, shop);
      });
    }

    for (const btn of this.overlay.querySelectorAll('.shop-house-buy')) {
      btn.addEventListener('click', () => {
        const houseId = (btn as HTMLElement).dataset.houseId;
        if (!houseId) return;
        this.view = { kind: 'house', houseId };
        this.renderCurrentView(state);
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

  /** Render the hire list. The combat archetype (className) is deliberately not shown. */
  private renderHireList(offers: HenchmanOffer[], state: ServerStateMessage): string {
    if (offers.length === 0) {
      return '<p class="shop-modal__empty">Nobody here is looking for work</p>';
    }
    const hired = ShopPopup.hiredHenchmen(state);
    const hiredIds = new Set(hired.map(h => h.henchmanId));
    const hasRoom = ShopPopup.hasRoomForHire(state);
    const partyFull = !hasRoom && hired.length === 0;

    const rows = offers.map(o => {
      const description = o.description?.trim();
      const verb = hasRoom ? 'Hire' : 'Replace';
      const action = hiredIds.has(o.henchmanId)
        ? '<span class="gc-tag gc-tag--green shop-hire-hired">In party</span>'
        : partyFull
          ? '<button type="button" class="gc-btn gc-btn--steel shop-hire-full" disabled>Party full</button>'
          : `<button type="button" class="gc-btn gc-btn--gold shop-hire-btn" data-henchman-id="${escapeHtml(o.henchmanId)}" aria-label="${verb} ${escapeHtml(o.name)}">${verb}</button>`;
      return `
        <div class="gc-row shop-hire-row" data-henchman-id="${escapeHtml(o.henchmanId)}">
          ${ShopPopup.henchmanPortrait(o.emoji, o.artworkUrl)}
          <div class="gc-row__main">
            <div class="gc-row__title shop-hire-name">${escapeHtml(o.name)}</div>
            ${description ? `<p class="shop-hire-desc">${escapeHtml(description)}</p>` : ''}
            <div class="gc-row__sub shop-hire-stats">${ShopPopup.henchmanStats(o)}</div>
          </div>
          ${action}
        </div>`;
    }).join('');
    const why = partyFull ? '<p class="gc-modal__why shop-hire-why">Your party is full of players.</p>' : '';
    return rows + why;
  }

  /** Why this house can't be bought right now, or null when it can. */
  private static houseBlocker(offer: HouseOffer, state: ServerStateMessage): string | null {
    if (state.house) {
      const where = state.house.location ? ` in ${describeHomeLocation(state.house.location)}` : '';
      return `You already own your ${state.house.definition.name}${where}. Sell it before buying another.`;
    }
    const gold = state.character?.gold ?? 0;
    if (gold < offer.price) return `You need ${(offer.price - gold).toLocaleString()} more gold.`;
    return null;
  }

  private currentTile(state: ServerStateMessage) {
    return this.worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row);
  }

  private homeHereText(state: ServerStateMessage): string {
    const tile = this.currentTile(state);
    if (!tile) return '';
    return `Your home will stand here in ${describeHomeLocation({ roomName: tile.name, zoneName: tile.zoneName })} — come back to go inside. `;
  }

  private renderHouseList(offers: HouseOffer[], state: ServerStateMessage): string {
    const ownedId = state.house?.house.houseId;
    const homeTileId = state.house?.location?.tileId;
    const ownedHere = !homeTileId || homeTileId === this.currentTile(state)?.id;
    return offers.map(o => {
      const blocker = ShopPopup.houseBlocker(o, state);
      const owned = ownedId === o.houseId && ownedHere;
      const short = !state.house && (state.character?.gold ?? 0) < o.price;
      const description = o.description?.trim();
      const action = owned
        ? '<span class="gc-tag gc-tag--green shop-house-owned">Your home</span>'
        : `<button type="button" class="gc-btn gc-btn--gold gc-btn--lg shop-house-buy" data-house-id="${escapeHtml(o.houseId)}"`
          + `${blocker ? ' disabled' : ''} aria-label="Buy ${escapeHtml(o.name)}">Buy</button>`;
      const why = blocker && !owned ? `<p class="gc-modal__why shop-house-why">${escapeHtml(blocker)}</p>` : '';
      return `
        <article class="shop-house" data-house-id="${escapeHtml(o.houseId)}">
          ${houseArtHtml(o, 'shop-house__art')}
          <div class="shop-house__main">
            <div class="shop-house__head">
              <h3 class="shop-house__name">${escapeHtml(o.name)}</h3>
              <span class="gc-tag gc-tag--gold shop-house__tier">Tier ${o.tier}</span>
            </div>
            ${description ? `<p class="shop-house__desc">${escapeHtml(description)}</p>` : ''}
            <div class="gc-facts shop-house__facts">
              <div class="gc-fact"><span class="gc-fact__label">Storage</span><span class="gc-fact__value">${o.storageSlots}</span></div>
              <div class="gc-fact"><span class="gc-fact__label">Shelves</span><span class="gc-fact__value">${o.displaySlots}</span></div>
            </div>
            <div class="shop-house__foot">
              <span class="shop-house__price${short ? ' is-short' : ''}"><span class="gc-coin" aria-hidden="true"></span>${o.price.toLocaleString()}</span>
              ${action}
            </div>
            ${why}
          </div>
        </article>`;
    }).join('');
  }

  private renderHouseConfirm(houseId: string, state: ServerStateMessage, shop: ShopDefinition): void {
    const offer = (state.houseOffers ?? []).find(o => o.houseId === houseId);
    const blocker = offer ? ShopPopup.houseBlocker(offer, state) : null;
    if (!offer || blocker) {
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
      return;
    }
    const question = `Buy ${offer.name} for ${offer.price.toLocaleString()} gold?`;
    const body = `
      <div class="gc-modal__body shop-house-confirm">
        ${houseArtHtml(offer, 'shop-house__art shop-house__art--lg')}
        <p class="shop-house-confirm__text">${escapeHtml(question)}</p>
        <p class="shop-house-confirm__sub">${escapeHtml(this.homeHereText(state))}Store up to ${offer.storageSlots} kinds of items, show off ${offer.displaySlots} trophies, and rest by your own fire.</p>
      </div>`;
    const actions = `
      <button type="button" class="gc-btn shop-house-cancel">Cancel</button>
      <button type="button" class="gc-btn gc-btn--gold gc-btn--lg shop-house-confirm-btn">Buy</button>`;
    this.overlay.innerHTML = this.panel(shop, state.character?.gold ?? 0, body, actions, 'is-detail', 'Buy a home');

    this.overlay.querySelector('.shop-house-confirm-btn')?.addEventListener('click', () => {
      this.pendingHouse = offer;
      this.gameClient.sendBuyHouse(offer.houseId);
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
    this.overlay.querySelector('.shop-house-cancel')?.addEventListener('click', () => {
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
    this.overlay.querySelector('.shop-close-btn')?.addEventListener('click', () => this.hide());
  }

  /** Ask which hired henchman makes room for a new one. */
  private renderReplaceConfirm(henchmanId: string, state: ServerStateMessage, shop: ShopDefinition): void {
    const offer = (state.henchmanOffers ?? []).find(o => o.henchmanId === henchmanId);
    if (!offer) {
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
      return;
    }

    const choices = ShopPopup.hiredHenchmen(state)
      .filter(h => h.henchmanId !== henchmanId)
      .map(h => {
        const name = h.name ?? 'henchman';
        return `
        <button type="button" class="gc-row shop-replace-confirm" data-instance-id="${escapeHtml(h.instanceId)}" aria-label="Replace ${escapeHtml(name)}">
          ${ShopPopup.henchmanPortrait(h.emoji ?? '?', h.artworkUrl)}
          <span class="gc-row__main">
            <span class="gc-row__title">${escapeHtml(name)}</span>
            ${h.level !== undefined ? `<span class="gc-row__sub">Lv ${h.level}</span>` : ''}
          </span>
          <span class="gc-tag gc-tag--red">Leaves</span>
        </button>`;
      })
      .join('');

    const body = `
      <div class="gc-modal__body shop-replace">
        <div class="gc-row shop-hire-row">
          ${ShopPopup.henchmanPortrait(offer.emoji, offer.artworkUrl)}
          <div class="gc-row__main">
            <div class="gc-row__title shop-hire-name">${escapeHtml(offer.name)}</div>
            <div class="gc-row__sub shop-hire-stats">${ShopPopup.henchmanStats(offer)}</div>
          </div>
        </div>
        <p class="shop-replace__prompt">Your party has no room. Choose who leaves; ${escapeHtml(offer.name)} takes their place in your formation.</p>
        <div class="shop-replace__choices">${choices}</div>
      </div>`;
    const actions = '<button type="button" class="gc-btn shop-replace-cancel">Cancel</button>';
    this.overlay.innerHTML = this.panel(shop, state.character?.gold ?? 0, body, actions, 'is-detail', `Make room for ${offer.name}?`);

    for (const btn of this.overlay.querySelectorAll('.shop-replace-confirm')) {
      btn.addEventListener('click', () => {
        const instanceId = (btn as HTMLElement).dataset.instanceId;
        if (!instanceId) return;
        this.pendingHireId = henchmanId;
        this.gameClient.sendHireHenchman(henchmanId, instanceId);
        this.view = { kind: 'grid' };
        this.renderGrid(state, shop);
      });
    }
    this.overlay.querySelector('.shop-replace-cancel')?.addEventListener('click', () => {
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
    this.overlay.querySelector('.shop-close-btn')?.addEventListener('click', () => this.hide());
  }

  private static henchmanStats(o: HenchmanOffer): string {
    return `Lv ${o.level} · ${o.maxHp} HP · ${o.baseDamage} DMG`;
  }

  /** Kit octagon portrait: the photo over the emoji, which shows through when the photo is missing or 404s. */
  private static henchmanPortrait(emoji: string, artworkUrl: string | undefined): string {
    const img = artworkUrl
      ? `<img class="gc-portrait__img" src="${escapeHtml(artworkUrl)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`
      : '';
    return '<span class="gc-portrait gc-portrait--sm shop-hire-portrait" aria-hidden="true">'
      + `<span class="gc-portrait__initial shop-hire-emoji">${escapeHtml(emoji)}</span>${img}</span>`;
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
      level: state.character?.level,
      skills: this.worldCache.getSkillContent().skills,
    });
    const rarity = def.rarity ?? 'common';
    return `
      <div class="gc-modal__body shop-detail">
        <div class="shop-detail__hero">
          ${renderKitItem(itemId, def, { size: 'lg', noTip: true })}
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
