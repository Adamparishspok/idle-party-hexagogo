import type { ItemDefinition, SetDefinition } from '@idle-party-rpg/shared';
// Legacy square-icon + dark popup styles, still used by the Shop and View
// Player popups (they call renderItemIcon / renderItemPopupContent). Delete
// this import and the file once those screens move to renderItemFrame.
import '../styles/item-legacy.css';
// Item detail modal styles (renderItemDetail in ItemPopup.ts). The frame
// itself (.gc-item and its parts) is in the kit, components.css.
import '../styles/screens/items.css';
import { artworkUrl } from './assets';

export const RARITY_COLORS: Record<string, string> = {
  janky: '#808080',
  common: '#e8e8e8',
  uncommon: '#66bb6a',
  rare: '#4fc3f7',
  epic: '#ee66e3',
  legendary: '#9233df',
  heirloom: '#e9bc18',
};

/** Border colors: gray for all rarities. Epic+ get animated glow via CSS. */
export const RARITY_BORDER_COLORS: Record<string, string> = {
  janky: 'rgba(180,180,180,0.25)',
  common: 'rgba(180,180,180,0.25)',
  uncommon: 'rgba(180,180,180,0.25)',
  rare: 'rgba(180,180,180,0.25)',
  epic: 'rgba(180,180,180,0.4)',
  legendary: 'rgba(180,180,180,0.4)',
  heirloom: 'rgba(180,180,180,0.4)',
};

/**
 * Slot icon image URLs. Replace emoji glyphs that previously decorated
 * equipment-slot dogears. Drop PNGs into `data/slot-icons/{slot}.png` and
 * mount `/slot-icons` server-side; missing files fall through to placehold.co.
 */
export const SLOT_ICONS: Record<string, string> = {
  head: '/slot-icons/head.png',
  shoulders: '/slot-icons/shoulders.png',
  chest: '/slot-icons/chest.png',
  bracers: '/slot-icons/bracers.png',
  gloves: '/slot-icons/gloves.png',
  mainhand: '/slot-icons/mainhand.png',
  offhand: '/slot-icons/offhand.png',
  twohanded: '/slot-icons/twohanded.png',
  foot: '/slot-icons/foot.png',
  ring: '/slot-icons/ring.png',
  necklace: '/slot-icons/necklace.png',
  back: '/slot-icons/back.png',
  relic: '/slot-icons/relic.png',
};

export const SLOT_LABELS: Record<string, string> = {
  head: 'Head', shoulders: 'Shoulders', chest: 'Chest', bracers: 'Bracers',
  gloves: 'Hands', mainhand: 'Main Hand', offhand: 'Offhand', twohanded: 'Two-Handed',
  foot: 'Feet', ring: 'Ring', necklace: 'Necklace', back: 'Back', relic: 'Relic',
};

export const SHINY_RARITIES = new Set(['epic', 'legendary', 'heirloom']);

export const RARITY_ORDER: Record<string, number> = {
  heirloom: 0, legendary: 1, epic: 2, rare: 3, uncommon: 4, common: 5, janky: 6,
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getItemInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Check if an item belongs to any set; returns the set ID or null. */
export function getItemSetId(itemId: string, setDefs: Record<string, SetDefinition>): string | null {
  for (const set of Object.values(setDefs)) {
    if (set.itemIds.includes(itemId)) return set.id;
  }
  return null;
}

/**
 * Render the dogear corner element with a slot icon image.
 * `slot` is one of EquipSlot; we look up the URL in SLOT_ICONS, fall through
 * to placehold.co on load failure, and hide the img if even that fails.
 *
 * The img starts at opacity:0 and only reveals on successful load (real
 * artwork OR placehold.co fallback). That hides the broken-image flash
 * the browser would otherwise paint between the 404 and the fallback
 * request resolving.
 */
function renderSlotDogear(slot: string): string {
  const src = SLOT_ICONS[slot];
  if (!src) return '';
  const label = (SLOT_LABELS[slot] ?? slot).slice(0, 8);
  const placeholder = `https://placehold.co/16x16/2a2a40/e8e8e8/png?text=${encodeURIComponent(label)}`;
  const onerror = `if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${placeholder}';}else{this.style.display='none';}`;
  const onload = `this.style.opacity='1'`;
  return `<span class="item-dogear"><img class="item-dogear-img" src="${src}" alt="${escapeHtml(label)}" style="opacity:0" onload="${onload}" onerror="${onerror}" /></span>`;
}

export interface ItemIconOptions {
  qty?: number;
  showSlotIcon?: boolean;
  /** Override the slot used for the dogear (e.g. for equipped items where slot comes from position, not definition). */
  slotOverride?: string;
  showSetIndicator?: boolean;
  setDefs?: Record<string, SetDefinition>;
  /** Extra CSS classes */
  extraClass?: string;
  /** data attributes as key-value pairs */
  dataAttrs?: Record<string, string>;
}

/**
 * Render a square item icon as HTML string.
 * Options control what overlays appear (qty badge, set indicator, slot icon dogear).
 */
export function renderItemIcon(itemId: string, def: ItemDefinition, options?: ItemIconOptions): string {
  const rarity = def.rarity ?? 'common';
  const bgColor = def.iconColor ?? RARITY_COLORS[rarity] ?? '#e8e8e8';
  const borderColor = RARITY_BORDER_COLORS[rarity] ?? 'rgba(180,180,180,0.25)';
  const shinyClass = SHINY_RARITIES.has(rarity) ? ` item-rarity-${rarity}` : '';
  const initials = getItemInitials(def.name);
  const extraClass = options?.extraClass ? ` ${options.extraClass}` : '';

  const dataStr = options?.dataAttrs
    ? Object.entries(options.dataAttrs).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
    : '';

  // Custom emoji icon (e.g., potions): render emoji centered, skip artwork lookup + initials.
  let inner: string;
  if (def.iconEmoji) {
    inner = `<span class="item-square-emoji">${escapeHtml(def.iconEmoji)}</span>`;
  } else {
    // img starts at opacity:0 so a missing PNG never flashes the browser's
    // broken-image glyph; the initials sibling acts as the visible placeholder
    // until onload reveals the real artwork.
    inner = `<img class="item-square-img" src="/item-artwork/${itemId}.png" style="opacity:0" onerror="this.style.display='none'" onload="this.style.opacity='1';this.nextElementSibling.style.display='none'" alt="">
    <span class="item-square-initials">${initials}</span>`;
  }

  if (options?.showSetIndicator && options.setDefs && getItemSetId(itemId, options.setDefs)) {
    inner += `<span class="item-square-set">S</span>`;
  }

  if (options?.qty != null && options.qty > 1) {
    inner += `<span class="item-square-qty">${options.qty}</span>`;
  }

  if (options?.showSlotIcon) {
    const slot = options.slotOverride ?? def.equipSlot;
    if (slot) {
      inner += renderSlotDogear(slot);
    }
  }

  return `<div class="item-square${shinyClass}${extraClass}" data-tooltip="${escapeHtml(def.name)}" style="background:${bgColor};border-color:${borderColor}"${dataStr}>${inner}</div>`;
}

/**
 * Render an empty equipment slot icon with a dogear showing the slot icon.
 */
export function renderEmptySlotIcon(slot: string, options?: { extraClass?: string; dataAttrs?: Record<string, string> }): string {
  const extraClass = options?.extraClass ? ` ${options.extraClass}` : '';
  const dataStr = options?.dataAttrs
    ? Object.entries(options.dataAttrs).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
    : '';
  const label = SLOT_LABELS[slot] ?? slot;

  return `<div class="item-square item-square-empty${extraClass}" data-tooltip="${escapeHtml(label)}" style="background:#2a2a3a;border-color:rgba(255,255,255,0.08)"${dataStr}>${renderSlotDogear(slot)}</div>`;
}

// ── Kit item frames ──────────────────────────────────────────────────────
// Rebuilt screens draw items as `.gc-item` octagon frames whose edge takes the
// rarity color (components.css). `renderKitItem` is the one builder for that
// markup; `renderItemFrame` wraps it with the inventory defaults. The legacy
// square renderers above stay for screens that haven't been rebuilt yet.

/** Short slot names that fit inside an empty frame when the slot icon is missing. */
export const SLOT_SHORT_LABELS: Record<string, string> = {
  head: 'Head', shoulders: 'Shldr', chest: 'Chest', bracers: 'Wrist',
  gloves: 'Hands', mainhand: 'Main', offhand: 'Off', twohanded: '2H',
  foot: 'Feet', ring: 'Ring', necklace: 'Neck', back: 'Back', relic: 'Relic',
};

export interface KitItemOptions {
  /** Kit size modifier (`gc-item--sm` / `gc-item--lg`); default is 72px. */
  size?: 'sm' | 'lg';
  /** Count shown bottom-right (omitted when ≤ 1 unless `alwaysCount`). */
  count?: number;
  alwaysCount?: boolean;
  /** Render as a <button> (tappable) instead of a <span>. */
  button?: boolean;
  /** Purely decorative: an aria-hidden <span> (ignored when `button`). */
  decorative?: boolean;
  extraClass?: string;
  /** data-* attributes (keys without the `data-` prefix). */
  dataAttrs?: Record<string, string>;
  /** Accessible label; defaults to the item name. */
  label?: string;
  /** Hover tooltip (`title`) for buttons. */
  title?: string;
  /** Show the gold set pip (top-left) when the item belongs to any set. */
  setDefs?: Record<string, SetDefinition>;
  /** Show a small slot badge (top-right) for this slot. */
  slot?: string;
}

function dataAttrString(attrs?: Record<string, string>): string {
  return attrs
    ? Object.entries(attrs).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
    : '';
}

/**
 * Slot glyph image. Slot icons are optional art: a missing PNG removes the
 * img (no placehold.co), and empty frames fall back to the short slot name.
 */
function slotIconImg(slot: string, className: string): string {
  const src = SLOT_ICONS[slot];
  if (!src) return '';
  return `<img class="${className}" src="${src}" alt="" onload="this.classList.add('is-loaded')" onerror="this.remove()" decoding="async">`;
}

/**
 * Inner art for a frame: the item artwork followed by its `.gc-item__glyph`
 * (initials, or the item's emoji). The glyph is hidden while the img exists
 * and shows only when a 404 removes it — never a broken-image icon or a
 * placeholder service.
 */
export function renderItemArt(itemId: string, def: ItemDefinition | undefined): string {
  if (def?.iconEmoji) {
    return `<span class="gc-item__glyph is-emoji" aria-hidden="true">${escapeHtml(def.iconEmoji)}</span>`;
  }
  const tint = def?.iconColor ? ` style="color:${escapeHtml(def.iconColor)}"` : '';
  return `<img class="gc-item__img" src="${escapeHtml(artworkUrl('item', itemId))}" alt="" onerror="this.remove()" decoding="async">`
    + `<span class="gc-item__glyph" aria-hidden="true"${tint}>${escapeHtml(getItemInitials(def?.name ?? itemId))}</span>`;
}

/**
 * An item in a kit `.gc-item` octagon frame: rarity-colored edge (epic+
 * glow), artwork with the glyph fallback, and optional set pip, slot badge
 * and count.
 */
export function renderKitItem(itemId: string, def: ItemDefinition | undefined, opts: KitItemOptions = {}): string {
  const name = def?.name ?? itemId;
  const rarity = def?.rarity ?? 'common';
  const classes = ['gc-item'];
  if (opts.size) classes.push(`gc-item--${opts.size}`);
  if (SHINY_RARITIES.has(rarity)) classes.push('gc-item--shiny');
  if (opts.extraClass) classes.push(opts.extraClass);

  let inner = renderItemArt(itemId, def);
  if (opts.setDefs && getItemSetId(itemId, opts.setDefs)) {
    inner += '<span class="gc-item__set" aria-hidden="true">S</span>';
  }
  if (opts.slot) {
    inner += slotIconImg(opts.slot, 'gc-item__slot');
  }
  if (opts.count !== undefined && (opts.alwaysCount || opts.count > 1)) {
    inner += `<span class="gc-item__count">${opts.count}</span>`;
  }

  const attrs = `class="${classes.join(' ')}" data-rarity="${escapeHtml(rarity)}"${dataAttrString(opts.dataAttrs)}`;
  const label = escapeHtml(opts.label ?? name);
  if (opts.button) {
    const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : '';
    return `<button type="button" ${attrs}${title} aria-label="${label}">${inner}</button>`;
  }
  if (opts.decorative) return `<span ${attrs} aria-hidden="true">${inner}</span>`;
  return `<span ${attrs} role="img" aria-label="${label}">${inner}</span>`;
}

export interface ItemFrameOptions {
  /** Stack count, drawn bottom-right when > 1. */
  qty?: number;
  /** Kit size modifier; default is the kit's 72px (screens may resize). */
  size?: 'sm' | 'lg';
  /** Show a small slot badge (top-right) for this slot. */
  slot?: string;
  /** Show the gold set pip (top-left) when the item belongs to any set. */
  setDefs?: Record<string, SetDefinition>;
  extraClass?: string;
  dataAttrs?: Record<string, string>;
  /** Render as a <span> (decorative) instead of a <button>. */
  decorative?: boolean;
}

/** Render an item as a kit `.gc-item` rarity frame (a button by default). */
export function renderItemFrame(itemId: string, def: ItemDefinition, options?: ItemFrameOptions): string {
  const qty = options?.qty ?? 0;
  return renderKitItem(itemId, def, {
    size: options?.size,
    count: qty,
    button: !options?.decorative,
    decorative: options?.decorative,
    extraClass: options?.extraClass,
    dataAttrs: options?.dataAttrs,
    setDefs: options?.setDefs,
    slot: options?.slot,
    title: def.name,
    label: qty > 1 ? `${def.name} ×${qty}` : def.name,
  });
}

/** Render an empty equipment slot as a muted `.gc-item--empty` frame button. */
export function renderEmptySlotFrame(
  slot: string,
  options?: { size?: 'sm' | 'lg'; extraClass?: string; dataAttrs?: Record<string, string>; decorative?: boolean },
): string {
  const classes = ['gc-item', 'gc-item--empty'];
  if (options?.size) classes.push(`gc-item--${options.size}`);
  if (options?.extraClass) classes.push(options.extraClass);
  const label = SLOT_LABELS[slot] ?? slot;
  const short = SLOT_SHORT_LABELS[slot] ?? label;
  const inner = slotIconImg(slot, 'gc-item__slot-glyph')
    + `<span class="gc-item__slot-name">${escapeHtml(short)}</span>`;
  const attrs = `class="${classes.join(' ')}"${dataAttrString(options?.dataAttrs)}`;
  if (options?.decorative) {
    return `<span ${attrs} role="img" aria-label="${escapeHtml(label)}: empty">${inner}</span>`;
  }
  return `<button type="button" ${attrs} aria-label="Empty ${escapeHtml(label)} slot">${inner}</button>`;
}
