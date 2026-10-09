import type { EquipSlot, ServerStateMessage, SkillDefinition } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { SLOT_LABELS, escapeHtml, renderKitItem } from './ItemIcon';
import { deltaChips, isKnownClass, slotPickerModel } from './GearModel';
import type { SlotPickerModel } from './GearModel';
import { renderDeltaChips, renderDeltaList, renderItemStatBlock } from './ItemStats';
import type { ItemStatViewer } from './ItemStats';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import '../styles/screens/gear.css';

function prefersHover(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
  } catch {
    return false;
  }
}

/**
 * Bottom sheet for one equipment slot: what's worn now (with Unequip) and every
 * backpack item that fits, each with a stat-change preview. See docs/architecture/gear-stats-bank.md → Client UX.
 */
export class GearPicker {
  private gameClient: GameClient;
  private getSkills: () => Record<string, SkillDefinition>;
  private overlay: HTMLElement;
  private slot: EquipSlot | null = null;
  private selectedId: string | null = null;
  private renderKey = '';
  private unsubscribe: (() => void) | null = null;
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };

  constructor(gameClient: GameClient, getSkills: () => Record<string, SkillDefinition> = () => ({})) {
    this.gameClient = gameClient;
    this.getSkills = getSkills;
    this.overlay = document.createElement('div');
    this.overlay.className = 'gc-modal gp-modal';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => this.onClick(e));
    document.body.appendChild(this.overlay);
    wireFocusOnInteract(this.overlay);
  }

  isOpen(): boolean {
    return this.slot !== null;
  }

  open(slot: EquipSlot): void {
    const state = this.gameClient.lastState;
    if (!state?.character) return;
    this.slot = slot;
    this.selectedId = null;
    this.renderKey = '';
    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);
    document.addEventListener('keydown', this.onKey);
    this.unsubscribe?.();
    this.unsubscribe = this.gameClient.subscribe((s) => this.render(s));
    this.render(state);
    (this.overlay.querySelector('.gc-modal__close') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  close(): void {
    if (this.slot === null) return;
    this.slot = null;
    this.selectedId = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    document.removeEventListener('keydown', this.onKey);
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    release(this.overlay);
  }

  private viewer(state: ServerStateMessage): ItemStatViewer {
    const cls = state.character?.className;
    return { level: state.character?.level, className: isKnownClass(cls) ? cls : null, skills: this.getSkills() };
  }

  private render(state: ServerStateMessage, force = false): void {
    const slot = this.slot;
    if (!slot) return;
    const model = slotPickerModel(slot, state);
    if (!model) { this.close(); return; }
    if (this.selectedId && !model.candidates.some(c => c.itemId === this.selectedId)) this.selectedId = null;
    const key = JSON.stringify({
      slot,
      sel: this.selectedId,
      eq: model.equipped?.itemId ?? null,
      c: model.candidates.map(c => [c.itemId, c.count, c.deltas]),
    });
    if (!force && key === this.renderKey) return;
    this.renderKey = key;

    const label = SLOT_LABELS[slot] ?? slot;
    this.overlay.innerHTML = `
      <div class="gc-modal__panel gc-parchment has-title gp-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)} slot">
        <div class="gc-title-tab gc-modal__title"><span class="gc-title-tab__text">${escapeHtml(label)}</span></div>
        <button type="button" class="gc-close gc-modal__close" aria-label="Close"></button>
        <div class="gc-modal__body gp-body">
          ${this.equippedHtml(model, state)}
          <div class="gc-divider">From your bags</div>
          ${this.candidatesHtml(model, state)}
        </div>
      </div>`;
  }

  private equippedHtml(model: SlotPickerModel, state: ServerStateMessage): string {
    const eq = model.equipped;
    if (!eq) {
      return `<div class="gp-equipped is-empty">
        <span class="gp-equipped__label">Equipped</span>
        <p class="gp-equipped__none">Nothing in this slot yet.</p>
      </div>`;
    }
    const rarity = eq.def.rarity ?? 'common';
    return `<div class="gp-equipped">
      <span class="gp-equipped__label">Equipped</span>
      <div class="gp-equipped__row">
        ${renderKitItem(eq.itemId, eq.def, { size: 'sm', decorative: true })}
        <div class="gp-equipped__main">
          <span class="gp-name gc-rarity-text" data-rarity="${escapeHtml(rarity)}">${escapeHtml(eq.def.name)}</span>
          ${renderItemStatBlock(eq.def, this.viewer(state))}
        </div>
        <button type="button" class="gc-btn gc-btn--steel gp-unequip" data-gp-action="unequip">Unequip</button>
      </div>
    </div>`;
  }

  private candidatesHtml(model: SlotPickerModel, state: ServerStateMessage): string {
    if (model.candidates.length === 0) {
      return '<p class="gp-empty">Nothing in your bags fits this slot.</p>';
    }
    const viewer = this.viewer(state);
    return `<ul class="gp-list">${model.candidates.map(c => {
      const selected = c.itemId === this.selectedId;
      const rarity = c.def.rarity ?? 'common';
      const chips = renderDeltaChips(deltaChips(c.deltas));
      const expanded = selected ? `<div class="gp-detail">
          <div class="gp-detail__cols">
            <section class="gp-detail__col">
              <h3 class="gp-detail__head">This</h3>
              ${renderItemStatBlock(c.def, viewer) || '<p class="gp-detail__none">No stats</p>'}
            </section>
            <section class="gp-detail__col">
              <h3 class="gp-detail__head">Equipped</h3>
              ${model.equipped ? (renderItemStatBlock(model.equipped.def, viewer) || '<p class="gp-detail__none">No stats</p>') : '<p class="gp-detail__none">Empty</p>'}
            </section>
          </div>
          <div class="gp-detail__deltas">${renderDeltaList(c.deltas)}</div>
          <button type="button" class="gc-btn gc-btn--green gc-btn--lg gc-btn--block gp-equip" data-gp-action="equip" data-item-id="${escapeHtml(c.itemId)}">Equip</button>
        </div>` : '';
      return `<li class="gp-item${selected ? ' is-selected' : ''}">
        <button type="button" class="gp-row" data-gp-row="${escapeHtml(c.itemId)}" data-tip-item="${escapeHtml(c.itemId)}" aria-expanded="${selected}">
          ${renderKitItem(c.itemId, c.def, { size: 'sm', count: c.count, decorative: true })}
          <span class="gp-row__main">
            <span class="gp-name gc-rarity-text" data-rarity="${escapeHtml(rarity)}">${escapeHtml(c.def.name)}</span>
            ${c.keyStat ? `<span class="gp-row__key">${escapeHtml(c.keyStat)}</span>` : ''}
            <span class="gp-row__chips">${chips}</span>
          </span>
        </button>
        ${expanded}
      </li>`;
    }).join('')}</ul>`;
  }

  private onClick(e: Event): void {
    const target = e.target as HTMLElement;
    if (target === this.overlay || target.closest('.gc-modal__close')) { this.close(); return; }
    const action = target.closest<HTMLElement>('[data-gp-action]');
    if (action?.dataset.gpAction === 'unequip' && this.slot) {
      this.gameClient.sendUnequipItem(this.slot);
      this.close();
      return;
    }
    if (action?.dataset.gpAction === 'equip' && action.dataset.itemId) {
      this.equip(action.dataset.itemId);
      return;
    }
    const row = target.closest<HTMLElement>('[data-gp-row]');
    const itemId = row?.dataset.gpRow;
    if (!itemId) return;
    if (prefersHover() || itemId === this.selectedId) {
      this.equip(itemId);
      return;
    }
    this.selectedId = itemId;
    const state = this.gameClient.lastState;
    if (state) this.render(state, true);
  }

  private equip(itemId: string): void {
    this.gameClient.sendEquipItem(itemId);
    this.close();
  }
}
