import type { PaintTile } from './terrainPainter';
import { CHUNK_SIZE, TerrainTileIndex, bakeChunk, chunkBounds, chunkKey, lodScale } from './terrainChunks';

const FRAME_BUDGET_MS = 8;
const BUDGET_BYTES = 64 * 1024 * 1024;

interface BakedChunk {
  key: string;
  cx: number;
  cy: number;
  scale: number;
  canvas: HTMLCanvasElement;
  dirty: boolean;
  lastUsed: number;
}

/** Screen transform: screen = world * zoom + offset, in canvas px. */
export interface CanvasView {
  offsetX: number;
  offsetY: number;
  zoom: number;
  width: number;
  height: number;
}

export interface CanvasLayerOptions {
  getArt: (tile: PaintTile) => CanvasImageSource | null;
  /** Called when background baking finishes chunks (caller redraws). */
  onBaked: () => void;
}

/**
 * The painted terrain for a plain 2D canvas: the same chunks and painter as
 * the game's three.js layer, cached as offscreen canvases and blitted per
 * frame, so pan and zoom never repaint terrain.
 */
export class CanvasTerrainLayer {
  private index = new TerrainTileIndex();
  private chunks = new Map<string, BakedChunk>();
  private queue: { cx: number; cy: number; scale: number }[] = [];
  private raf: number | null = null;
  private frame = 0;
  private opts: CanvasLayerOptions;
  private disposed = false;

  constructor(opts: CanvasLayerOptions) {
    this.opts = opts;
  }

  setTiles(tiles: PaintTile[], reset = false): void {
    if (reset) {
      this.chunks.clear();
      this.index.clear();
    }
    this.markTilesDirty(this.index.setTiles(tiles));
  }

  markTilesDirty(tiles: Iterable<PaintTile>): void {
    for (const t of tiles) {
      for (const { cx, cy } of this.index.chunksTouching(t)) {
        const c = this.chunks.get(chunkKey(cx, cy));
        if (c) c.dirty = true;
      }
    }
  }

  markTileKeysDirty(keys: Iterable<string>): void {
    const ts: PaintTile[] = [];
    for (const k of keys) {
      const t = this.index.getTile(k);
      if (t) ts.push(t);
    }
    this.markTilesDirty(ts);
  }

  /** Blit every baked chunk in view (stale ones too, until their re-bake lands) and queue the rest. */
  draw(ctx: CanvasRenderingContext2D, view: CanvasView): void {
    if (this.disposed) return;
    this.frame++;
    const scale = lodScale(view.zoom);
    const x0 = Math.floor(-view.offsetX / view.zoom / CHUNK_SIZE);
    const x1 = Math.floor((view.width - view.offsetX) / view.zoom / CHUNK_SIZE);
    const y0 = Math.floor(-view.offsetY / view.zoom / CHUNK_SIZE);
    const y1 = Math.floor((view.height - view.offsetY) / view.zoom / CHUNK_SIZE);
    const queue: { cx: number; cy: number; scale: number; dist: number }[] = [];
    const midCx = (x0 + x1) / 2;
    const midCy = (y0 + y1) / 2;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        if (!this.index.chunkHasContent(cx, cy)) continue;
        const c = this.chunks.get(chunkKey(cx, cy));
        if (c) {
          c.lastUsed = this.frame;
          const { minX, minY, size } = chunkBounds(cx, cy);
          ctx.drawImage(c.canvas, minX * view.zoom + view.offsetX, minY * view.zoom + view.offsetY, size * view.zoom, size * view.zoom);
        }
        if (!c || c.dirty || c.scale !== scale) {
          queue.push({ cx, cy, scale, dist: Math.hypot(cx - midCx, cy - midCy) });
        }
      }
    }
    ctx.restore();
    queue.sort((a, b) => a.dist - b.dist);
    this.queue = queue;
    if (queue.length > 0) this.scheduleBake();
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    for (const c of this.chunks.values()) { c.canvas.width = 0; c.canvas.height = 0; }
    this.chunks.clear();
    this.index.clear();
  }

  private scheduleBake(): void {
    if (this.raf !== null || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      const start = performance.now();
      let baked = 0;
      while (this.queue.length > 0 && performance.now() - start < FRAME_BUDGET_MS) {
        const job = this.queue.shift()!;
        this.bake(job.cx, job.cy, job.scale);
        baked++;
      }
      if (baked > 0) {
        this.evict();
        this.opts.onBaked();
      }
      if (this.queue.length > 0) this.scheduleBake();
    });
  }

  private bake(cx: number, cy: number, scale: number): void {
    const key = chunkKey(cx, cy);
    const existing = this.chunks.get(key);
    const canvas = existing?.canvas ?? document.createElement('canvas');
    if (!bakeChunk(canvas, this.index, cx, cy, scale, this.opts.getArt)) return;
    this.chunks.set(key, { key, cx, cy, scale, canvas, dirty: false, lastUsed: this.frame });
  }

  private evict(): void {
    let total = 0;
    for (const c of this.chunks.values()) total += c.canvas.width * c.canvas.height * 4;
    if (total <= BUDGET_BYTES) return;
    const oldest = [...this.chunks.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const c of oldest) {
      if (total <= BUDGET_BYTES || c.lastUsed === this.frame) break;
      total -= c.canvas.width * c.canvas.height * 4;
      c.canvas.width = 0;
      c.canvas.height = 0;
      this.chunks.delete(c.key);
    }
  }
}
