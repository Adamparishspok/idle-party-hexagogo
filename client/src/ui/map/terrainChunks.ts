import { HEX_SIZE } from '@idle-party-rpg/shared';
import { paintTerrain, paintFingerprint, type FogState, type PaintTile } from './terrainPainter';

/** Chunk edge in world units (≈ 8 × 7 hexes). */
export const CHUNK_SIZE = 512;
/** How far outside a chunk a tile's painted footprint can reach (props, foam). */
export const PAINT_MARGIN = HEX_SIZE * 2.6;
/** Bake a little past each edge so texture filtering never shows a seam. */
export const SEAM_OVERLAP = 2;
const LOD_SCALES = [2, 1, 0.5, 0.25, 0.125] as const;

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/** Smallest LOD scale that still covers the requested pixel density. */
export function lodScale(pxPerWorldUnit: number): number {
  let best: number = LOD_SCALES[0];
  for (const s of LOD_SCALES) {
    if (s >= pxPerWorldUnit) best = s;
  }
  return best;
}

/** The world rect a baked chunk covers, seam overlap included. */
export function chunkBounds(cx: number, cy: number): { minX: number; minY: number; size: number } {
  return {
    minX: cx * CHUNK_SIZE - SEAM_OVERLAP,
    minY: cy * CHUNK_SIZE - SEAM_OVERLAP,
    size: CHUNK_SIZE + SEAM_OVERLAP * 2,
  };
}

/** Tiles that were under full fog and no longer are: their zone just opened up. */
export function revealedTiles(prevFog: (key: string) => FogState | undefined, next: readonly PaintTile[]): PaintTile[] {
  return next.filter(t => t.fog !== 'fog' && prevFog(t.key) === 'fog');
}

/** Paint tiles bucketed by chunk, with per-tile fingerprints to find what a re-sync changed. */
export class TerrainTileIndex {
  private tiles = new Map<string, PaintTile>();
  private buckets = new Map<string, PaintTile[]>();
  private fingerprints = new Map<string, string>();

  /** Replace the tile set; returns every tile whose painted look changed, added or removed. */
  setTiles(tiles: PaintTile[]): PaintTile[] {
    const next = new Map<string, PaintTile>();
    const nextFp = new Map<string, string>();
    for (const t of tiles) {
      next.set(t.key, t);
      nextFp.set(t.key, paintFingerprint(t));
    }

    const changed: PaintTile[] = [];
    for (const [key, fp] of nextFp) {
      if (this.fingerprints.get(key) !== fp) changed.push(next.get(key)!);
    }
    for (const [key, t] of this.tiles) {
      if (!next.has(key)) changed.push(t);
    }

    this.tiles = next;
    this.fingerprints = nextFp;
    this.buckets.clear();
    for (const t of tiles) {
      const k = chunkKey(Math.floor(t.x / CHUNK_SIZE), Math.floor(t.y / CHUNK_SIZE));
      let b = this.buckets.get(k);
      if (!b) { b = []; this.buckets.set(k, b); }
      b.push(t);
    }
    return changed;
  }

  clear(): void {
    this.tiles.clear();
    this.buckets.clear();
    this.fingerprints.clear();
  }

  getTile(key: string): PaintTile | undefined {
    return this.tiles.get(key);
  }

  /** Chunk keys a tile's painted footprint reaches. */
  chunksTouching(t: PaintTile): { cx: number; cy: number }[] {
    const out: { cx: number; cy: number }[] = [];
    const x0 = Math.floor((t.x - PAINT_MARGIN) / CHUNK_SIZE);
    const x1 = Math.floor((t.x + PAINT_MARGIN) / CHUNK_SIZE);
    const y0 = Math.floor((t.y - PAINT_MARGIN) / CHUNK_SIZE);
    const y1 = Math.floor((t.y + PAINT_MARGIN) / CHUNK_SIZE);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) out.push({ cx, cy });
    }
    return out;
  }

  /** A chunk paints tiles from its own bucket and its neighbours' (margin). */
  chunkHasContent(cx: number, cy: number): boolean {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (this.buckets.has(chunkKey(cx + dx, cy + dy))) return true;
      }
    }
    return false;
  }

  /** Every tile whose footprint can reach chunk (cx, cy). */
  tilesForChunk(cx: number, cy: number): PaintTile[] {
    const { minX, minY, size } = chunkBounds(cx, cy);
    const tiles: PaintTile[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = this.buckets.get(chunkKey(cx + dx, cy + dy));
        if (!b) continue;
        for (const t of b) {
          if (t.x >= minX - PAINT_MARGIN && t.x <= minX + size + PAINT_MARGIN &&
              t.y >= minY - PAINT_MARGIN && t.y <= minY + size + PAINT_MARGIN) {
            tiles.push(t);
          }
        }
      }
    }
    return tiles;
  }
}

/** Paint chunk (cx, cy) into `canvas` at `scale` px per world unit, resizing it to fit. */
export function bakeChunk(
  canvas: HTMLCanvasElement,
  index: TerrainTileIndex,
  cx: number,
  cy: number,
  scale: number,
  getArt: (tile: PaintTile) => CanvasImageSource | null,
): boolean {
  const { minX, minY, size } = chunkBounds(cx, cy);
  const px = Math.max(1, Math.ceil(size * scale));
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, px, px);
  const s = px / size;
  ctx.setTransform(s, 0, 0, s, -minX * s, -minY * s);
  paintTerrain(ctx, index.tilesForChunk(cx, cy), {
    scale: s,
    getTile: (k) => index.getTile(k),
    getArt,
  });
  return true;
}
