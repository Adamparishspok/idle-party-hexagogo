import { HEX_SIZE, getHexCorners } from '@idle-party-rpg/shared';
import type { MapPropId, WorldTileDefinition } from '@idle-party-rpg/shared';
import { artworkUrl } from '../assets';
import type { RoomBuilding } from './terrainPainter';

interface CachedImage {
  img: HTMLImageElement;
  loaded: boolean;
}

/** Per-room art first, then the room type's art. */
export function tileArtUrls(room: Pick<WorldTileDefinition, 'id' | 'type'>): string[] {
  const urls: string[] = [];
  if (room.id) urls.push(artworkUrl('tile', room.id));
  urls.push(artworkUrl('tile-type', room.type));
  return urls;
}

const LANDMARK_PROPS: Record<RoomBuilding, MapPropId> = {
  town: 'building-inn',
  shop: 'building-merchant',
  cave: 'building-dungeon',
  npc: 'building-tavern',
  bank: 'building-bank',
  houses: 'building-estate',
  home: 'building-home',
};

export function landmarkArtUrl(building: RoomBuilding): string {
  return artworkUrl('map-prop', LANDMARK_PROPS[building]);
}

/**
 * Loads uploaded room art and clips it to hex sprites for the painter.
 * Tiles that asked for art still loading are reported back when it lands,
 * so only their chunks re-bake.
 */
export class TileArtCache {
  private images = new Map<string, CachedImage>();
  private sprites = new Map<string, HTMLCanvasElement>();
  private waiters = new Map<string, Set<string>>();
  private onArtLoaded: (tileKeys: Set<string>) => void;

  constructor(onArtLoaded: (tileKeys: Set<string>) => void) {
    this.onArtLoaded = onArtLoaded;
  }

  /** The first of `urls` that has loaded, as a hex sprite; null while loading or when none exist. */
  get(urls: readonly string[], tileKey: string): CanvasImageSource | null {
    for (const url of urls) {
      const img = this.image(url, tileKey);
      if (img) return this.sprite(url, img);
    }
    return null;
  }

  /** The image itself, unclipped; null while loading or missing. */
  image(url: string, tileKey: string): HTMLImageElement | null {
    const img = this.load(url);
    if (img) return img;
    let w = this.waiters.get(url);
    if (!w) { w = new Set(); this.waiters.set(url, w); }
    w.add(tileKey);
    return null;
  }

  /** Drop a cached URL so its next request re-fetches (after an upload or removal). */
  forget(url: string): void {
    this.images.delete(url);
    this.sprites.delete(url);
  }

  private load(url: string): HTMLImageElement | null {
    const existing = this.images.get(url);
    if (existing) return existing.loaded ? existing.img : null;
    const entry: CachedImage = { img: new Image(), loaded: false };
    this.images.set(url, entry);
    entry.img.onload = () => {
      if (this.images.get(url) !== entry) return;
      entry.loaded = true;
      const waiters = this.waiters.get(url);
      this.waiters.delete(url);
      if (waiters) this.onArtLoaded(waiters);
    };
    entry.img.src = url;
    return null;
  }

  private sprite(url: string, img: HTMLImageElement): HTMLCanvasElement {
    const cached = this.sprites.get(url);
    if (cached) return cached;
    const w = HEX_SIZE * 4;
    const h = Math.round(w * Math.sqrt(3) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    this.sprites.set(url, canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    const corners = getHexCorners(w / 2);
    ctx.beginPath();
    corners.forEach((c, i) => {
      if (i === 0) ctx.moveTo(w / 2 + c.x, h / 2 + c.y); else ctx.lineTo(w / 2 + c.x, h / 2 + c.y);
    });
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  }
}
