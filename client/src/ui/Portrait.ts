import { artworkUrl } from './assets';
import { escapeHtml } from './ItemIcon';

export type PortraitSize = 'sm' | 'md' | 'lg' | 'xl';

export interface PortraitOpts {
  name: string;
  className?: string;
  /** Kit size modifier; omit to size it from CSS (`--portrait-size`). */
  size?: PortraitSize;
  /** true/false draws the online pip; undefined draws none. */
  online?: boolean;
  /** Level pip on the bottom-left corner. */
  level?: number;
  /** Gold frame edge for the viewing player. */
  self?: boolean;
  extraClass?: string;
}

function initialOf(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

/**
 * Kit `.gc-portrait`: the class art clipped to the octagon over the player's
 * initial. When the art 404s the <img> removes itself and the initial shows
 * through — no placeholder service. Decorative (aria-hidden): the caller
 * labels the surrounding control.
 */
export function renderPortrait(o: PortraitOpts): string {
  const classes = ['gc-portrait'];
  if (o.size) classes.push(`gc-portrait--${o.size}`);
  if (o.self) classes.push('is-self');
  if (o.extraClass) classes.push(o.extraClass);
  const img = o.className
    ? `<img class="gc-portrait__img" src="${escapeHtml(artworkUrl('class', o.className.toLowerCase()))}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`
    : '';
  const online = o.online === undefined
    ? ''
    : `<span class="gc-portrait__online${o.online ? ' is-online' : ''}"></span>`;
  const level = o.level !== undefined ? `<span class="gc-portrait__level">${o.level}</span>` : '';
  return `<span class="${classes.join(' ')}" aria-hidden="true">`
    + `<span class="gc-portrait__initial">${escapeHtml(initialOf(o.name))}</span>${img}${online}${level}`
    + '</span>';
}
