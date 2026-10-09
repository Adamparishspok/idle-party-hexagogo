import type { ItemDefinition } from '@idle-party-rpg/shared';
import { artworkUrl } from './assets';
import { escapeHtml, getItemInitials } from './ItemIcon';

export interface KitItemOptions {
  /** Kit size modifier (`gc-item--sm` / `gc-item--lg`); default is 72px. */
  size?: 'sm' | 'lg';
  /** Count shown bottom-right (omitted when ≤ 1 unless `alwaysCount`). */
  count?: number;
  alwaysCount?: boolean;
  /** Render as a <button> (tappable) instead of a <span>. */
  button?: boolean;
  extraClass?: string;
  /** data-* attributes (keys without the `data-` prefix). */
  dataAttrs?: Record<string, string>;
  /** Accessible label; defaults to the item name. */
  label?: string;
}

/**
 * An item in a kit `.gc-item` octagon frame: rarity-colored edge, artwork
 * from `/item-artwork/{id}.png`, and — when the art is missing — the item's
 * emoji or initials painted on the frame instead (never a placeholder image).
 */
export function renderKitItem(itemId: string, def: ItemDefinition | undefined, opts: KitItemOptions = {}): string {
  const name = def?.name ?? itemId;
  const rarity = def?.rarity ?? 'common';
  const glyph = def?.iconEmoji ? escapeHtml(def.iconEmoji) : escapeHtml(getItemInitials(name));
  const img = def?.iconEmoji
    ? ''
    : `<img class="gc-item__img" src="${artworkUrl('item', encodeURIComponent(itemId))}" alt="" onload="this.previousElementSibling.hidden=true" onerror="this.remove()" />`;
  const showCount = opts.count !== undefined && (opts.alwaysCount || opts.count > 1);
  const count = showCount ? `<span class="gc-item__count">${opts.count}</span>` : '';
  const cls = ['gc-item', opts.size ? `gc-item--${opts.size}` : '', opts.extraClass ?? ''].filter(Boolean).join(' ');
  const data = opts.dataAttrs
    ? Object.entries(opts.dataAttrs).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
    : '';
  const label = escapeHtml(opts.label ?? name);
  const inner = `<span class="gc-item__glyph${def?.iconEmoji ? ' is-emoji' : ''}" aria-hidden="true">${glyph}</span>${img}${count}`;
  return opts.button
    ? `<button type="button" class="${cls}" data-rarity="${escapeHtml(rarity)}" aria-label="${label}"${data}>${inner}</button>`
    : `<span class="${cls}" data-rarity="${escapeHtml(rarity)}" role="img" aria-label="${label}"${data}>${inner}</span>`;
}
