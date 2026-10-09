import type { ClientBankState, ItemDefinition, ServerStateMessage, SkillDefinition } from '@idle-party-rpg/shared';
import { canDepositToTab, fitsInventoryChanges } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { escapeHtml, renderKitItem } from './ItemIcon';
import { allItemDefs, bagBarModel, bankTabs, depositableEntries, isKnownClass } from './GearModel';
import { renderItemStatBlock } from './ItemStats';
import { renderEmptyState } from './EmptyState';
import { gearErrorText, isBankErrorCode, isGearErrorCode } from './GameToast';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import '../styles/screens/bank.css';

type View =
  | { kind: 'main' }
  | { kind: 'withdraw'; itemId: string; qty: number }
  | { kind: 'deposit'; itemId: string; qty: number }
  | { kind: 'buy-tab' };

const NOTICE_MS = 3500;
const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>';
const ICON_VAULT = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="currentColor"/><circle cx="12" cy="12" r="4" fill="#1a1009"/><path d="M12 9v6M9 12h6" stroke="currentColor" stroke-width="1.5"/></svg>';

/** Whether `qty` of `itemId` can go into `tab` right now. */
export function canDepositHere(bank: ClientBankState, tab: number, itemId: string, qty: number): boolean {
  return canDepositToTab({ tabs: bank.tabs }, tab, itemId, qty);
}

/**
 * The player's bank, open only while the party stands in a banker's room
 * (`state.bank` is present). See docs/architecture/gear-stats-bank.md → Bank.
 */
export class BankView {
  private gameClient: GameClient;
  private getSkills: () => Record<string, SkillDefinition>;
  private overlay: HTMLElement;
  private open = false;
  private tab = 0;
  private view: View = { kind: 'main' };
  private renderKey = '';
  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (this.view.kind === 'main') this.close();
    else this.goTo({ kind: 'main' });
  };

  constructor(gameClient: GameClient, getSkills: () => Record<string, SkillDefinition> = () => ({})) {
    this.gameClient = gameClient;
    this.getSkills = getSkills;
    this.overlay = document.createElement('div');
    this.overlay.className = 'gc-modal bank-modal';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => this.onClick(e));
    document.body.appendChild(this.overlay);
    wireFocusOnInteract(this.overlay);

    gameClient.subscribe((s) => this.onState(s));
    gameClient.onServerError((message, code) => {
      if (!isGearErrorCode(code) || !this.claimsError(code)) return;
      this.setNotice(gearErrorText(message, code));
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Bank refusals (and bag-full refusals while banking) are shown inside the bank instead of as a toast. */
  claimsError(code: string): boolean {
    return this.open && (isBankErrorCode(code) || code === 'inventory_full');
  }

  /** Opens when the party is in a banker's room; returns false otherwise. */
  show(): boolean {
    const state = this.gameClient.lastState;
    if (!state?.bank) return false;
    this.open = true;
    this.view = { kind: 'main' };
    this.tab = Math.min(this.tab, state.bank.tabs.length - 1);
    this.renderKey = '';
    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);
    document.addEventListener('keydown', this.onKey);
    this.render(state);
    (this.overlay.querySelector('.gc-modal__close') as HTMLElement | null)?.focus({ preventScroll: true });
    return true;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.notice = null;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    document.removeEventListener('keydown', this.onKey);
    release(this.overlay);
  }

  private onState(state: ServerStateMessage): void {
    if (!this.open) return;
    if (!state.bank) { this.close(); return; }
    this.render(state);
  }

  private setNotice(message: string): void {
    this.notice = message;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.noticeTimer = null;
      this.rerender();
    }, NOTICE_MS);
    this.rerender();
  }

  private rerender(): void {
    const state = this.gameClient.lastState;
    this.renderKey = '';
    if (state && this.open) this.render(state);
  }

  private goTo(view: View): void {
    this.view = view;
    this.rerender();
  }

  private render(state: ServerStateMessage): void {
    const bank = state.bank;
    if (!bank) return;
    if (this.tab >= bank.tabs.length) this.tab = 0;
    const key = JSON.stringify({
      view: this.view,
      tab: this.tab,
      notice: this.notice,
      bank: [bank.tabs, bank.nextTabPrice],
      inv: state.character?.inventory ?? {},
      cap: state.character?.inventoryCapacity ?? null,
      bags: state.character?.bags ?? null,
      gold: state.character?.gold ?? 0,
    });
    if (key === this.renderKey) return;
    this.renderKey = key;

    const defs = allItemDefs(state);
    switch (this.view.kind) {
      case 'main': this.renderMain(state, bank, defs); break;
      case 'withdraw': this.renderWithdraw(state, bank, defs, this.view); break;
      case 'deposit': this.renderDeposit(state, bank, defs, this.view); break;
      case 'buy-tab': this.renderBuyTab(state, bank); break;
    }
  }

  private panel(body: string, actions = '', extraClass = ''): void {
    const gold = this.gameClient.lastState?.character?.gold ?? 0;
    const notice = this.notice ? `<div class="bank-notice" role="status">${escapeHtml(this.notice)}</div>` : '';
    this.overlay.innerHTML = `
      <div class="gc-modal__panel gc-parchment has-title${actions ? ' has-actions' : ''} bank-panel ${extraClass}" role="dialog" aria-modal="true" aria-label="Bank">
        <div class="gc-title-tab gc-modal__title"><span class="gc-title-tab__text">Bank</span></div>
        <button type="button" class="gc-close gc-modal__close" aria-label="Close bank"></button>
        <div class="bank-gold"><span class="gc-coin" aria-hidden="true"></span><span class="bank-gold__value">${gold.toLocaleString()}</span></div>
        ${notice}
        <div class="gc-modal__body bank-body">${body}</div>
        ${actions ? `<div class="gc-modal__actions">${actions}</div>` : ''}
      </div>`;
  }

  private renderMain(state: ServerStateMessage, bank: ClientBankState, defs: Record<string, ItemDefinition>): void {
    const tabs = bankTabs(bank);
    const current = tabs[this.tab];
    const tabStrip = tabs.map(t => `<button type="button" class="gc-tab bank-tab" role="tab" data-bank-tab="${t.index}" aria-selected="${t.index === this.tab}">
      <span class="bank-tab__name">Tab ${t.index + 1}</span><span class="bank-tab__count">${t.used}/${t.slots}</span></button>`).join('');
    const buy = bank.nextTabPrice !== null
      ? `<button type="button" class="gc-btn gc-btn--gold bank-buy-tab" data-bank-action="buy-tab">${ICON_PLUS}<span>Buy tab · ${bank.nextTabPrice.toLocaleString()}g</span></button>`
      : '';
    const vaultItems = current.entries.map(([id, n]) => renderKitItem(id, defs[id], {
      button: true,
      count: n,
      dataAttrs: { 'bank-item': id },
      label: `${defs[id]?.name ?? id} ×${n}, take out`,
    })).join('');
    const freeVault = Math.max(0, current.slots - current.used);
    const vaultGrid = current.entries.length
      ? `<div class="bank-grid">${vaultItems}${'<span class="gc-item gc-item--empty bank-free" aria-hidden="true"></span>'.repeat(freeVault)}</div>`
      : renderEmptyState({ emblem: ICON_VAULT, title: 'This tab is empty', body: 'Tap an item in your backpack to store it here.', compact: true });

    const bag = bagBarModel(state);
    const pack = depositableEntries(state);
    const packGrid = pack.length
      ? `<div class="bank-grid">${pack.map(([id, n]) => renderKitItem(id, defs[id], {
        button: true,
        count: n,
        dataAttrs: { 'pack-item': id },
        label: `${defs[id]?.name ?? id} ×${n}, deposit`,
      })).join('')}</div>`
      : renderEmptyState({ emblem: ICON_VAULT, title: 'Your backpack is empty', body: 'Equipped gear stays on your hero.', compact: true });

    this.panel(`
      <div class="bank-tabs-row">
        <div class="gc-tabs bank-tabs" role="tablist" aria-label="Bank tabs">${tabStrip}</div>
        ${buy}
      </div>
      <div class="bank-panes">
        <section class="bank-pane bank-pane--vault" aria-label="Bank tab ${this.tab + 1}">
          <div class="bank-pane__head"><span class="bank-pane__title">Tab ${this.tab + 1}</span><span class="bank-pane__count">${current.used} / ${current.slots}</span></div>
          ${vaultGrid}
        </section>
        <section class="bank-pane bank-pane--pack" aria-label="Backpack">
          <div class="bank-pane__head"><span class="bank-pane__title">Backpack</span>${bag ? `<span class="bank-pane__count${bag.full ? ' is-full' : ''}">${bag.used} / ${bag.capacity}</span>` : ''}</div>
          ${packGrid}
        </section>
      </div>`);
  }

  private stepper(qty: number, max: number): string {
    if (max <= 1) return '';
    return `<div class="gc-stepper gc-stepper--lg bank-qty" role="group" aria-label="Quantity">
      <button type="button" class="gc-btn gc-btn--steel gc-btn--icon gc-stepper__btn" data-bank-qty="minus" aria-label="One fewer"${qty <= 1 ? ' disabled' : ''}>${ICON_MINUS}</button>
      <span class="gc-stepper__val" aria-live="polite">${qty}</span>
      <button type="button" class="gc-btn gc-btn--steel gc-btn--icon gc-stepper__btn" data-bank-qty="plus" aria-label="One more"${qty >= max ? ' disabled' : ''}>${ICON_PLUS}</button>
      <button type="button" class="gc-btn gc-btn--steel" data-bank-qty="all"${qty >= max ? ' disabled' : ''}>All</button>
    </div>`;
  }

  private hero(itemId: string, def: ItemDefinition | undefined, sub: string, state: ServerStateMessage): string {
    const cls = state.character?.className;
    const stats = def ? renderItemStatBlock(def, { level: state.character?.level, className: isKnownClass(cls) ? cls : null, skills: this.getSkills() }) : '';
    return `<div class="bank-hero">
      ${renderKitItem(itemId, def, { size: 'lg', decorative: true, noTip: true })}
      <div class="bank-hero__text">
        <h3 class="bank-hero__name gc-rarity-text" data-rarity="${escapeHtml(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? itemId)}</h3>
        <span class="bank-hero__sub">${escapeHtml(sub)}</span>
      </div>
    </div>${stats ? `<div class="bank-hero__stats">${stats}</div>` : ''}`;
  }

  private renderWithdraw(state: ServerStateMessage, bank: ClientBankState, defs: Record<string, ItemDefinition>, view: { itemId: string; qty: number }): void {
    const have = bank.tabs[this.tab]?.[view.itemId] ?? 0;
    if (have <= 0) { this.view = { kind: 'main' }; this.renderMain(state, bank, defs); return; }
    view.qty = Math.max(1, Math.min(view.qty, have));
    const bag = bagBarModel(state);
    const fits = !!bag && fitsInventoryChanges(state.character?.inventory ?? {}, bag.capacity, { [view.itemId]: view.qty });
    const why = fits ? '' : '<p class="gc-modal__why">Your bags are full. Make room in your backpack first.</p>';
    const moves = bank.tabs.length > 1
      ? `<div class="gc-divider">Move to</div><div class="bank-move">${bank.tabs.map((_, i) => i === this.tab ? '' : `<button type="button" class="gc-btn gc-btn--steel" data-bank-move="${i}"${canDepositHere(bank, i, view.itemId, view.qty) ? '' : ' disabled'}>Tab ${i + 1}</button>`).join('')}</div>`
      : '';
    this.panel(`${this.hero(view.itemId, defs[view.itemId], `${have} in tab ${this.tab + 1}`, state)}${this.stepper(view.qty, have)}${why}${moves}`,
      `<button type="button" class="gc-btn" data-bank-action="back">Back</button>
       <button type="button" class="gc-btn gc-btn--gold gc-btn--lg" data-bank-action="withdraw"${fits ? '' : ' disabled'}>Withdraw ${view.qty}</button>`, 'is-detail');
  }

  private renderDeposit(state: ServerStateMessage, bank: ClientBankState, defs: Record<string, ItemDefinition>, view: { itemId: string; qty: number }): void {
    const have = state.character?.inventory[view.itemId] ?? 0;
    if (have <= 0) { this.view = { kind: 'main' }; this.renderMain(state, bank, defs); return; }
    view.qty = Math.max(1, Math.min(view.qty, have));
    const fits = canDepositHere(bank, this.tab, view.itemId, view.qty);
    const why = fits ? '' : `<p class="gc-modal__why">Tab ${this.tab + 1} has no room for that. Pick another tab or a smaller amount.</p>`;
    this.panel(`${this.hero(view.itemId, defs[view.itemId], `${have} in your backpack`, state)}${this.stepper(view.qty, have)}${why}`,
      `<button type="button" class="gc-btn" data-bank-action="back">Back</button>
       <button type="button" class="gc-btn gc-btn--gold gc-btn--lg" data-bank-action="deposit"${fits ? '' : ' disabled'}>Deposit ${view.qty}</button>`, 'is-detail');
  }

  private renderBuyTab(state: ServerStateMessage, bank: ClientBankState): void {
    const price = bank.nextTabPrice;
    if (price === null) { this.goTo({ kind: 'main' }); return; }
    const gold = state.character?.gold ?? 0;
    const afford = gold >= price;
    this.panel(`<div class="bank-buy">
        <p class="bank-buy__q">Buy bank tab ${bank.tabs.length + 1} for <span class="gc-coin gc-coin--sm" aria-hidden="true"></span><strong>${price.toLocaleString()}</strong> gold?</p>
        <p class="bank-buy__lead">Each tab holds ${bank.slotsPerTab} more stacks. You can own up to ${bank.maxTabs} tabs.</p>
        ${afford ? '' : `<p class="gc-modal__why">You need ${(price - gold).toLocaleString()} more gold.</p>`}
      </div>`,
    `<button type="button" class="gc-btn" data-bank-action="back">Cancel</button>
     <button type="button" class="gc-btn gc-btn--gold gc-btn--lg" data-bank-action="buy-confirm"${afford ? '' : ' disabled'}>Buy tab</button>`, 'is-detail');
  }

  private onClick(e: Event): void {
    const target = e.target as HTMLElement;
    if (target === this.overlay || target.closest('.gc-modal__close')) { this.close(); return; }
    const button = target.closest<HTMLButtonElement>('button');
    if (button?.disabled) return;

    const tab = target.closest<HTMLElement>('[data-bank-tab]')?.dataset.bankTab;
    if (tab !== undefined) { this.tab = Number(tab); this.goTo({ kind: 'main' }); return; }
    const bankItem = target.closest<HTMLElement>('[data-bank-item]')?.dataset.bankItem;
    if (bankItem) { this.goTo({ kind: 'withdraw', itemId: bankItem, qty: 1 }); return; }
    const packItem = target.closest<HTMLElement>('[data-pack-item]')?.dataset.packItem;
    if (packItem) { this.goTo({ kind: 'deposit', itemId: packItem, qty: 1 }); return; }

    const view = this.view;
    const qtyAction = target.closest<HTMLElement>('[data-bank-qty]')?.dataset.bankQty;
    if (qtyAction && (view.kind === 'withdraw' || view.kind === 'deposit')) {
      if (qtyAction === 'minus') view.qty -= 1;
      if (qtyAction === 'plus') view.qty += 1;
      if (qtyAction === 'all') view.qty = Number.MAX_SAFE_INTEGER;
      this.rerender();
      return;
    }
    const moveTo = target.closest<HTMLElement>('[data-bank-move]')?.dataset.bankMove;
    if (moveTo !== undefined && view.kind === 'withdraw') {
      this.gameClient.sendBankMove(this.tab, Number(moveTo), view.itemId, view.qty);
      this.goTo({ kind: 'main' });
      return;
    }

    switch (target.closest<HTMLElement>('[data-bank-action]')?.dataset.bankAction) {
      case 'back': this.goTo({ kind: 'main' }); return;
      case 'buy-tab': this.goTo({ kind: 'buy-tab' }); return;
      case 'buy-confirm':
        this.gameClient.sendBankBuyTab();
        this.goTo({ kind: 'main' });
        return;
      case 'withdraw':
        if (view.kind === 'withdraw') this.gameClient.sendBankWithdraw(this.tab, view.itemId, view.qty);
        this.goTo({ kind: 'main' });
        return;
      case 'deposit':
        if (view.kind === 'deposit') this.gameClient.sendBankDeposit(view.itemId, view.qty, this.tab);
        this.goTo({ kind: 'main' });
        return;
    }
  }
}
