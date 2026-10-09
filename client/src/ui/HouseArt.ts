import { escapeHtml } from './ItemIcon';
import { artworkUrl } from './assets';

interface HouseArtSource {
  houseId?: string;
  id?: string;
  emoji: string;
  artworkUrl?: string;
}

export function houseExteriorUrl(houseId: string): string {
  return artworkUrl('house', encodeURIComponent(houseId));
}

export function houseInteriorUrl(houseId: string): string {
  return artworkUrl('house-interior', encodeURIComponent(houseId));
}

/** Exterior art → the content's artworkUrl → the emoji showing through underneath. */
export function houseArtHtml(house: HouseArtSource, className: string): string {
  const id = house.houseId ?? house.id ?? '';
  const fallback = house.artworkUrl ? escapeHtml(JSON.stringify(house.artworkUrl)) : '';
  const onerror = fallback
    ? `if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src=${fallback};}else{this.remove();}`
    : 'this.remove()';
  return `<span class="house-art ${className}" aria-hidden="true">`
    + `<span class="house-art__emoji">${escapeHtml(house.emoji)}</span>`
    + `<img class="house-art__img" src="${escapeHtml(houseExteriorUrl(id))}" alt="" loading="lazy" decoding="async" onerror="${onerror}" />`
    + '</span>';
}
