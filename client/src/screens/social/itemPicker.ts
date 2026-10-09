import type { ItemDefinition, TradeOfferItem } from '@idle-party-rpg/shared';
import { getItemEffectText } from '@idle-party-rpg/shared';
import { esc, itemFrameHtml } from './socialHtml';

type SkillDefs = Parameters<typeof getItemEffectText>[1];

export interface PickerCtx {
  itemDefs: Record<string, ItemDefinition>;
  skillDefs: SkillDefs;
}

/**
 * Bag picker used by the trade and gift dialogs: one row per unequipped
 * stack — item frame, name, effect, owned count, and a −/qty/+ stepper.
 * `action` prefixes the stepper's data-action ("trade" → trade-inc/trade-dec).
 */
export function pickerHtml(
  ids: string[],
  inventory: Record<string, number>,
  selected: Map<string, number>,
  ctx: PickerCtx,
  action: string,
  emptyText: string,
): string {
  if (ids.length === 0) {
    return `<div class="soc-pick-empty">${esc(emptyText)}</div>`;
  }
  return `<div class="soc-pick-list">${ids.map(id => {
    const def = ctx.itemDefs[id];
    const have = inventory[id] ?? 0;
    const sel = selected.get(id) ?? 0;
    const effect = def ? getItemEffectText(def, ctx.skillDefs) : '';
    const name = def?.name ?? id;
    return `<div class="soc-pick${sel > 0 ? ' is-picked' : ''}">
      ${itemFrameHtml(id, def, { size: 'sm', extraClass: 'soc-pick__frame' })}
      <div class="soc-pick__info">
        <div class="soc-pick__name">${esc(name)}</div>
        ${effect ? `<div class="soc-pick__effect">${esc(effect)}</div>` : ''}
      </div>
      <div class="soc-pick__have">Have ×${have}</div>
      <div class="gc-stepper" role="group" aria-label="${esc(name)} quantity">
        <button type="button" class="gc-btn gc-btn--steel gc-btn--icon gc-stepper__btn" data-action="${action}-dec" data-item-id="${esc(id)}" aria-label="One fewer"${sel === 0 ? ' disabled' : ''}>−</button>
        <span class="gc-stepper__val" aria-live="polite">${sel}</span>
        <button type="button" class="gc-btn gc-btn--green gc-btn--icon gc-stepper__btn" data-action="${action}-inc" data-item-id="${esc(id)}" aria-label="One more"${sel >= have ? ' disabled' : ''}>+</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

/** One side of an offer: item frames with counts, names and effects underneath. */
export function offerSideHtml(label: string, items: TradeOfferItem[], ctx: PickerCtx, emptyText = 'Nothing yet'): string {
  const body = items.length === 0
    ? `<div class="soc-offer__none">
        <span class="gc-item gc-item--sm gc-item--empty" aria-hidden="true"></span>
        <span>${esc(emptyText)}</span>
      </div>`
    : `<div class="soc-offer__items">${items.map(({ itemId, quantity }) => {
      const def = ctx.itemDefs[itemId];
      const effect = def ? getItemEffectText(def, ctx.skillDefs) : '';
      return `<div class="soc-offer__item">
        ${itemFrameHtml(itemId, def, { size: 'sm', qty: quantity })}
        <span class="soc-offer__name">${esc(def?.name ?? itemId)}${quantity > 1 ? ` ×${quantity}` : ''}</span>
        ${effect ? `<span class="soc-offer__effect">${esc(effect)}</span>` : ''}
      </div>`;
    }).join('')}</div>`;
  return `<div class="soc-offer${items.length === 0 ? ' is-empty' : ''}">
    <div class="soc-offer__label">${esc(label)}</div>
    ${body}
  </div>`;
}

/** Shared stepper click handling. Returns true when the selection changed. */
export function applyStep(
  btn: HTMLElement,
  action: string,
  selected: Map<string, number>,
  inventory: Record<string, number>,
): boolean {
  const kind = btn.getAttribute('data-action');
  const itemId = btn.getAttribute('data-item-id');
  if (!itemId) return false;
  const current = selected.get(itemId) ?? 0;
  if (kind === `${action}-inc`) {
    const max = inventory[itemId] ?? 0;
    if (current >= max) return false;
    selected.set(itemId, current + 1);
    return true;
  }
  if (kind === `${action}-dec`) {
    if (current > 1) selected.set(itemId, current - 1);
    else selected.delete(itemId);
    return true;
  }
  return false;
}
