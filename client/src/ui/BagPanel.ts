import type { ItemDefinition, ServerStateMessage } from '@idle-party-rpg/shared';
import { LOST_AND_FOUND_SLOTS, fitsInventoryChanges, maxAddable } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { escapeHtml, renderKitItem } from './ItemIcon';
import { allItemDefs, bagBarModel } from './GearModel';
import type { BagBarModel } from './GearModel';
import { renderEmptyState } from './EmptyState';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import '../styles/screens/gear.css';

type Sheet =
  | { kind: 'bag'; index: number }
  | { kind: 'pouch' }
  | { kind: 'discard'; itemId: string };

const ICON_POUCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8l-1.5 3h-5z" fill="currentColor"/><path d="M6 9.5C6 8.1 7.1 7 8.5 7h7C16.9 7 18 8.1 18 9.5L19.5 18A2.5 2.5 0 0 1 17 21H7a2.5 2.5 0 0 1-2.5-3z" fill="currentColor" opacity="0.85"/></svg>';

/** Shown under the backpack text: what happens to loot when the bags are full. */
export function capacityWarning(model: Pick<BagBarModel, 'full' | 'over'>): string | null {
  if (model.over) return 'Over capacity — new items go to Lost & Found.';
  if (model.full) return 'Your bags are full — new loot goes to Lost & Found.';
  return null;
}

/**
 * The bag bar under the backpack grid (capacity, four bag slots, Lost & Found)
 * and its sheets. See docs/architecture/gear-stats-bank.md → Client UX.
 */
export class BagPanel {
  private gameClient: GameClient;
  private host: HTMLElement;
  private overlay: HTMLElement;
  private sheet: Sheet | null = null;
  private state: ServerStateMessage | null = null;
  private barKey = '';
  private sheetKey = '';
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.closeSheet(); };

  constructor(host: HTMLElement, gameClient: GameClient) {
    this.host = host;
    this.gameClient = gameClient;
    this.host.classList.add('bb');
    this.host.addEventListener('click', (e) => this.onBarClick(e));

    this.overlay = document.createElement('div');
    this.overlay.className = 'gc-modal bb-modal';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => this.onSheetClick(e));
    document.body.appendChild(this.overlay);
    wireFocusOnInteract(this.overlay);
  }

  update(state: ServerStateMessage): void {
    this.state = state;
    const model = bagBarModel(state);
    if (!model) return;
    const key = JSON.stringify(model.slots.map(s => s.itemId)) + `|${model.used}|${model.capacity}|${JSON.stringify(model.pouch)}`;
    if (key !== this.barKey) {
      this.barKey = key;
      this.renderBar(model);
    }
    if (this.sheet) this.renderSheet();
  }

  closeSheet(): void {
    if (!this.sheet) return;
    this.sheet = null;
    this.sheetKey = '';
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    document.removeEventListener('keydown', this.onKey);
    release(this.overlay);
  }

  openPouch(): void {
    this.openSheet({ kind: 'pouch' });
  }

  private renderBar(model: BagBarModel): void {
    const fill = model.capacity > 0 ? Math.min(100, (model.used / model.capacity) * 100) : 100;
    const warning = capacityWarning(model);
    const pouchCount = model.pouch.length;
    const slots = model.slots.map(s => {
      if (s.itemId) {
        const name = s.def?.name ?? s.itemId;
        return `<span class="bb-slot">${renderKitItem(s.itemId, s.def, {
          size: 'sm',
          button: true,
          dataAttrs: { 'bag-index': String(s.index) },
          label: `${name}, ${s.size} slots. Bag slot ${s.index + 1}`,
        })}<span class="bb-slot__size">+${s.size}</span></span>`;
      }
      return `<span class="bb-slot"><button type="button" class="gc-item gc-item--sm gc-item--empty bb-slot__empty" data-bag-index="${s.index}" aria-label="Empty bag slot ${s.index + 1}">
        <span class="gc-item__slot-name">Bag</span></button><span class="bb-slot__size">&nbsp;</span></span>`;
    }).join('');
    this.host.innerHTML = `
      <div class="bb-head">
        <div class="bb-cap${model.full ? ' is-full' : ''}">
          <span class="bb-cap__label">Backpack</span>
          <span class="bb-cap__value" aria-label="${model.used} of ${model.capacity} slots used">${model.used} / ${model.capacity}</span>
        </div>
        <button type="button" class="gc-btn gc-btn--steel bb-pouch-btn${pouchCount ? ' has-items' : ''}" data-bb-action="pouch" aria-label="Lost and Found, ${pouchCount} ${pouchCount === 1 ? 'item' : 'items'}">
          ${ICON_POUCH}<span>Lost &amp; Found</span>${pouchCount ? `<span class="gc-badge bb-pouch-badge">${pouchCount}</span>` : ''}
        </button>
      </div>
      <div class="gc-bar bb-bar${model.full ? ' gc-bar--danger' : ''}" aria-hidden="true"><div class="gc-bar__fill" style="width:${fill}%"></div></div>
      ${warning ? `<p class="bb-warn" role="status">${escapeHtml(warning)}</p>` : ''}
      <div class="bb-slots" role="group" aria-label="Bag slots">${slots}</div>
    `;
  }

  private onBarClick(e: Event): void {
    const target = e.target as HTMLElement;
    if (target.closest('[data-bb-action="pouch"]')) { this.openPouch(); return; }
    const slot = target.closest<HTMLElement>('[data-bag-index]');
    if (slot) this.openSheet({ kind: 'bag', index: Number(slot.dataset.bagIndex) });
  }

  private openSheet(sheet: Sheet): void {
    this.sheet = sheet;
    this.sheetKey = '';
    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);
    document.addEventListener('keydown', this.onKey);
    this.renderSheet();
    (this.overlay.querySelector('.gc-modal__close') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private renderSheet(): void {
    const state = this.state;
    const sheet = this.sheet;
    if (!state || !sheet) return;
    const model = bagBarModel(state);
    if (!model) { this.closeSheet(); return; }
    const key = JSON.stringify({ sheet, slots: model.slots.map(s => s.itemId), bags: model.bagsInBackpack, pouch: model.pouch, used: model.used, cap: model.capacity });
    if (key === this.sheetKey) return;
    this.sheetKey = key;
    const defs = allItemDefs(state);
    switch (sheet.kind) {
      case 'bag': this.renderBagSheet(model, defs, sheet.index, state.character?.inventory ?? {}); break;
      case 'pouch': this.renderPouchSheet(model, defs, state); break;
      case 'discard': this.renderDiscardSheet(model, defs, sheet.itemId); break;
    }
  }

  private panel(title: string, body: string, actions = ''): void {
    this.overlay.innerHTML = `
      <div class="gc-modal__panel gc-parchment has-title${actions ? ' has-actions' : ''} bb-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="gc-title-tab gc-modal__title"><span class="gc-title-tab__text">${escapeHtml(title)}</span></div>
        <button type="button" class="gc-close gc-modal__close" aria-label="Close"></button>
        <div class="gc-modal__body bb-body">${body}</div>
        ${actions ? `<div class="gc-modal__actions">${actions}</div>` : ''}
      </div>`;
  }

  private bagPickGrid(model: BagBarModel, defs: Record<string, ItemDefinition>, verb: string): string {
    return `<div class="bb-grid">${model.bagsInBackpack.map(([id, n]) => renderKitItem(id, defs[id], {
      button: true,
      count: n,
      dataAttrs: { 'bb-equip': id },
      label: `${verb} ${defs[id]?.name ?? id}, ${defs[id]?.bagSlots ?? 0} slots`,
    })).join('')}</div>`;
  }

  private renderBagSheet(model: BagBarModel, defs: Record<string, ItemDefinition>, index: number, inventory: Record<string, number>): void {
    const slot = model.slots[index];
    if (!slot) { this.closeSheet(); return; }
    const title = `Bag slot ${index + 1}`;
    if (slot.itemId) {
      const def = defs[slot.itemId];
      const hero = `<div class="bb-hero">
        ${renderKitItem(slot.itemId, def, { size: 'lg', decorative: true, noTip: true })}
        <div class="bb-hero__text">
          <h3 class="bb-hero__name gc-rarity-text" data-rarity="${escapeHtml(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? slot.itemId)}</h3>
          <span class="bb-hero__sub">Adds ${slot.size} backpack slots</span>
        </div>
      </div>`;
      const swap = model.bagsInBackpack.length
        ? `<div class="gc-divider">Swap for</div>${this.bagPickGrid(model, defs, 'Swap to')}`
        : '';
      const after = model.capacity - slot.size;
      const fits = fitsInventoryChanges(inventory, model.capacity, { [slot.itemId]: 1 }, after);
      const why = fits ? '' : `<p class="gc-modal__why">Your backpack would only have ${after} slots and you're using ${model.used}. Make room first.</p>`;
      this.panel(title, hero + why + swap,
        `<button type="button" class="gc-btn gc-btn--red gc-btn--lg" data-bb-action="unequip"${fits ? '' : ' disabled'}>Remove bag</button>`);
      return;
    }
    const body = model.bagsInBackpack.length
      ? `<p class="bb-lead">Pick a bag from your backpack to carry more.</p>${this.bagPickGrid(model, defs, 'Equip')}`
      : renderEmptyState({ emblem: ICON_POUCH, title: 'No bags to equip', body: 'Bags come from shops, crafting and loot. Each one adds backpack slots.', compact: true });
    this.panel(title, body);
  }

  private renderPouchSheet(model: BagBarModel, defs: Record<string, ItemDefinition>, state: ServerStateMessage): void {
    if (model.pouch.length === 0) {
      this.panel('Lost & Found', renderEmptyState({
        emblem: ICON_POUCH,
        title: 'Nothing lost',
        body: "Loot that doesn't fit in your bags waits here. It's reachable from any room.",
        compact: true,
      }));
      return;
    }
    const inventory = state.character?.inventory ?? {};
    const rows = model.pouch.map(([id, n]) => {
      const def = defs[id];
      const room = maxAddable(inventory, model.capacity, id);
      return `<div class="gc-row bb-pouch-row">
        ${renderKitItem(id, def, { size: 'sm', count: n, decorative: true })}
        <div class="gc-row__main">
          <div class="gc-row__title gc-rarity-text" data-rarity="${escapeHtml(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? id)}</div>
          <div class="gc-row__sub">×${n}${room <= 0 ? ' · no room in your bags' : room < n ? ` · ${room} will fit` : ''}</div>
        </div>
        <div class="bb-pouch-row__actions">
          <button type="button" class="gc-btn gc-btn--green" data-bb-claim="${escapeHtml(id)}"${room <= 0 ? ' disabled' : ''}>Claim</button>
          <button type="button" class="gc-btn gc-btn--red gc-btn--icon" data-bb-discard="${escapeHtml(id)}" aria-label="Discard ${escapeHtml(def?.name ?? id)}">✕</button>
        </div>
      </div>`;
    }).join('');
    const anyFits = model.pouch.some(([id]) => maxAddable(inventory, model.capacity, id) > 0);
    this.panel('Lost & Found', `
      <p class="bb-lead">${model.pouch.length} / ${LOST_AND_FOUND_SLOTS} stacks waiting. When it's full, new loot is lost.</p>
      <div class="bb-pouch-list">${rows}</div>`,
    `<button type="button" class="gc-btn gc-btn--green gc-btn--lg" data-bb-action="claim-all"${anyFits ? '' : ' disabled'}>Claim all</button>`);
  }

  private renderDiscardSheet(model: BagBarModel, defs: Record<string, ItemDefinition>, itemId: string): void {
    const entry = model.pouch.find(([id]) => id === itemId);
    if (!entry) { this.sheet = { kind: 'pouch' }; this.sheetKey = ''; this.renderSheet(); return; }
    const name = defs[itemId]?.name ?? itemId;
    this.panel('Discard?', `<p class="bb-lead"><strong>${escapeHtml(name)} ×${entry[1]}</strong> will be gone for good.</p>`,
      `<button type="button" class="gc-btn gc-btn--steel" data-bb-action="back">Keep it</button>
       <button type="button" class="gc-btn gc-btn--red gc-btn--lg" data-bb-action="discard-confirm">Discard</button>`);
  }

  private onSheetClick(e: Event): void {
    const target = e.target as HTMLElement;
    const sheet = this.sheet;
    if (!sheet) return;
    if (target === this.overlay || target.closest('.gc-modal__close')) { this.closeSheet(); return; }
    const button = target.closest<HTMLButtonElement>('button');
    if (button?.disabled) return;

    const equipId = target.closest<HTMLElement>('[data-bb-equip]')?.dataset.bbEquip;
    if (equipId && sheet.kind === 'bag') {
      this.gameClient.sendEquipBag(equipId, sheet.index);
      this.closeSheet();
      return;
    }
    const claimId = target.closest<HTMLElement>('[data-bb-claim]')?.dataset.bbClaim;
    if (claimId) { this.gameClient.sendClaimLostFound(claimId); return; }
    const discardId = target.closest<HTMLElement>('[data-bb-discard]')?.dataset.bbDiscard;
    if (discardId) { this.goTo({ kind: 'discard', itemId: discardId }); return; }

    switch (target.closest<HTMLElement>('[data-bb-action]')?.dataset.bbAction) {
      case 'unequip':
        if (sheet.kind === 'bag') this.gameClient.sendUnequipBag(sheet.index);
        this.closeSheet();
        return;
      case 'claim-all':
        this.gameClient.sendClaimLostFound();
        return;
      case 'back':
        this.goTo({ kind: 'pouch' });
        return;
      case 'discard-confirm':
        if (sheet.kind === 'discard') this.gameClient.sendDiscardLostFound(sheet.itemId);
        this.goTo({ kind: 'pouch' });
        return;
    }
  }

  private goTo(sheet: Sheet): void {
    this.sheet = sheet;
    this.sheetKey = '';
    this.renderSheet();
  }
}
