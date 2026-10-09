import type { ItemDefinition } from '@idle-party-rpg/shared';
import { artworkUrl } from '../../ui/assets';
import { getItemInitials } from '../../ui/ItemIcon';

/**
 * Small HTML-string builders shared by the Social screen and its modals.
 * Every user-supplied string goes through `esc()` before it reaches innerHTML.
 *
 * Image convention: art loads over a visible initial. When the art 404s the
 * <img> removes itself and the initial shows through — no placeholder service.
 */

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function initialOf(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

/** Class portrait art (the same `/class-artwork/` art the combat cards use). */
export function classArtUrl(className?: string): string | null {
  if (!className) return null;
  return artworkUrl('class', className.toLowerCase());
}

/** `<img>` that removes itself on error so the sibling initial shows. */
export function fallbackImg(src: string, className: string): string {
  return `<img class="${className}" src="${esc(src)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`;
}

export type PortraitSize = 'sm' | 'md' | 'lg' | 'xl';

export interface PortraitOpts {
  name: string;
  className?: string;
  size?: PortraitSize;
  /** true/false draws the online dot; undefined draws none. */
  online?: boolean;
  /** Level badge on the frame's corner. */
  level?: number;
  /** Gold frame edge for the viewing player. */
  self?: boolean;
}

/** Octagon class-portrait frame (`.gc-frame`) with initial fallback. */
export function portraitHtml(o: PortraitOpts): string {
  const size = o.size ?? 'md';
  const art = classArtUrl(o.className);
  const dot = o.online === undefined
    ? ''
    : `<span class="soc-dot ${o.online ? 'is-online' : 'is-offline'}" aria-hidden="true"></span>`;
  const level = o.level ? `<span class="gc-badge gc-badge--level soc-portrait__level">${o.level}</span>` : '';
  return `<span class="soc-portrait soc-portrait--${size} gc-frame${o.self ? ' is-self' : ''}" aria-hidden="true">
    <span class="soc-portrait__initial">${esc(initialOf(o.name))}</span>
    ${art ? fallbackImg(art, 'soc-portrait__img') : ''}
    ${dot}${level}
  </span>`;
}

/** "Knight · Hatchetmill" — parts that are empty are skipped. */
export function subtitle(...parts: (string | undefined | null | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).map(esc).join(' · ');
}

export type TagTone = 'gold' | 'green' | 'red' | 'teal' | 'steel';

export function tagHtml(label: string, tone: TagTone = 'steel'): string {
  return `<span class="soc-tag soc-tag--${tone}">${esc(label)}</span>`;
}

/** The game has two rarities the kit doesn't paint (janky, heirloom) — social.css covers them. */
export function rarityOf(def: ItemDefinition | undefined): string {
  return def?.rarity ?? 'common';
}

export interface ItemFrameOpts {
  qty?: number;
  size?: 'sm' | 'md' | 'lg';
  /** Render as a <button> (pressable) instead of a <span>. */
  button?: boolean;
  extraClass?: string;
  dataAttrs?: Record<string, string>;
  label?: string;
}

/** Kit item frame (`.gc-item`) for an item: art over initials (or emoji), optional count. */
export function itemFrameHtml(itemId: string, def: ItemDefinition | undefined, opts: ItemFrameOpts = {}): string {
  const tag = opts.button ? 'button' : 'span';
  const sizeClass = opts.size === 'sm' ? ' gc-item--sm' : opts.size === 'lg' ? ' gc-item--lg' : '';
  const extra = opts.extraClass ? ` ${opts.extraClass}` : '';
  const data = Object.entries(opts.dataAttrs ?? {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  const typeAttr = opts.button ? ' type="button"' : '';
  const label = opts.label ? ` aria-label="${esc(opts.label)}"` : '';
  const inner = def?.iconEmoji
    ? `<span class="soc-item__initial soc-item__emoji">${esc(def.iconEmoji)}</span>`
    : `<span class="soc-item__initial">${esc(getItemInitials(def?.name ?? itemId))}</span>${fallbackImg(artworkUrl('item', itemId), 'gc-item__img')}`;
  const count = opts.qty !== undefined && opts.qty > 1 ? `<span class="gc-item__count">${opts.qty}</span>` : '';
  return `<${tag}${typeAttr} class="gc-item soc-item${sizeClass}${extra}" data-rarity="${esc(rarityOf(def))}"${data}${label}>${inner}${count}</${tag}>`;
}

/** Friendly illustrated empty state: emblem, headline, line, one primary action. */
export function emptyStateHtml(o: { emblem: string; title: string; body: string; actionHtml?: string }): string {
  return `<div class="soc-empty">
    <span class="soc-empty__emblem gc-frame" aria-hidden="true"><span>${o.emblem}</span></span>
    <div class="soc-empty__title">${esc(o.title)}</div>
    <p class="soc-empty__body">${esc(o.body)}</p>
    ${o.actionHtml ?? ''}
  </div>`;
}
