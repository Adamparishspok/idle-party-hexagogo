import type { ItemDefinition } from '@idle-party-rpg/shared';
import { artworkUrl } from '../../ui/assets';
import { renderKitItem } from '../../ui/ItemIcon';
import { renderPortrait, type PortraitOpts } from '../../ui/Portrait';
import { renderEmptyState } from '../../ui/EmptyState';

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

export type { PortraitSize, PortraitOpts } from '../../ui/Portrait';

/** Kit octagon class portrait (`.gc-portrait`) with initial fallback; md by default. */
export function portraitHtml(o: PortraitOpts): string {
  return renderPortrait({ ...o, size: o.size ?? 'md' });
}

/** "Knight · Hatchetmill" — parts that are empty are skipped. */
export function subtitle(...parts: (string | undefined | null | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).map(esc).join(' · ');
}

export type TagTone = 'gold' | 'green' | 'red' | 'teal' | 'steel';

/** Kit status pill (`.gc-tag`); steel is the kit default. */
export function tagHtml(label: string, tone: TagTone = 'steel'): string {
  const toneClass = tone === 'steel' ? '' : ` gc-tag--${tone}`;
  return `<span class="gc-tag${toneClass}">${esc(label)}</span>`;
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

/** Kit item frame (`.gc-item`) for an item: art over its glyph fallback, optional count. */
export function itemFrameHtml(itemId: string, def: ItemDefinition | undefined, opts: ItemFrameOpts = {}): string {
  return renderKitItem(itemId, def, {
    size: opts.size === 'md' ? undefined : opts.size,
    count: opts.qty,
    button: opts.button,
    // Unlabelled frames sit next to the item's name, so keep them out of the a11y tree.
    decorative: !opts.label,
    extraClass: opts.extraClass,
    dataAttrs: opts.dataAttrs,
    label: opts.label,
  });
}

/** Friendly illustrated empty state: emblem, headline, line, one primary action. */
export function emptyStateHtml(o: { emblem: string; title: string; body: string; actionHtml?: string }): string {
  return renderEmptyState(o);
}
