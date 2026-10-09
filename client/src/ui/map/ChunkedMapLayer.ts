/**
 * Chunked terrain layer for the world map.
 *
 * The world plane is cut into fixed CHUNK_SIZE squares. Each chunk is baked
 * on demand into its own canvas texture (via terrainPainter) at a level of
 * detail matched to the current zoom, shown on its own plane mesh, and
 * evicted when it falls far outside the view and the memory budget is tight.
 * Baking is time-sliced so panning never stutters. See
 * ideas/world-map-renderer.md for the full design.
 */

import * as THREE from 'three';
import { HEX_SIZE } from '@idle-party-rpg/shared';
import { paintTerrain, type PaintTile } from './terrainPainter';

/** Chunk edge in world units (≈ 8 × 7 hexes). */
export const CHUNK_SIZE = 512;
/** How far outside a chunk a tile's painted footprint can reach (props, foam). */
const PAINT_MARGIN = HEX_SIZE * 2.6;
/** Bake a little past each edge so texture filtering never shows a seam. */
const SEAM_OVERLAP = 2;
/** Max bake work per frame, so panning stays smooth while chunks fill in. */
const FRAME_BUDGET_MS = 8;
const LOD_SCALES = [2, 1, 0.5, 0.25, 0.125] as const;
/** Mesh z — above the sea backdrop, below nothing (markers are DOM). */
const CHUNK_Z = 2;

interface ResidentChunk {
  key: string;
  cx: number;
  cy: number;
  scale: number;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh;
  bytes: number;
  /** State changed since this bake; re-bake when next wanted. */
  dirty: boolean;
}

export interface LayerView {
  camX: number;
  camY: number;
  zoom: number;
  /** Viewport size in CSS px. */
  viewW: number;
  viewH: number;
  dpr: number;
}

export interface LayerOptions {
  getArt: (tile: PaintTile) => CanvasImageSource | null;
  /** Called when background baking finishes a chunk (caller re-renders). */
  onBaked: () => void;
}

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

export class ChunkedMapLayer {
  private scene: THREE.Scene;
  private opts: LayerOptions;
  private tiles = new Map<string, PaintTile>();
  /** Tiles bucketed by the chunk their center falls in. */
  private buckets = new Map<string, PaintTile[]>();
  /** Visual fingerprint per tile — a change marks overlapping chunks dirty. */
  private fingerprints = new Map<string, string>();
  private resident = new Map<string, ResidentChunk>();
  /** Chunks wanted by the last update, nearest first, with their target LOD. */
  private queue: { key: string; cx: number; cy: number; scale: number }[] = [];
  private bakeRaf: number | null = null;
  private budgetBytes = isTouchDevice() ? 48 * 1024 * 1024 : 96 * 1024 * 1024;
  private lastView: LayerView | null = null;
  private disposed = false;

  constructor(scene: THREE.Scene, opts: LayerOptions) {
    this.scene = scene;
    this.opts = opts;
  }

  /**
   * Replace the tile set. Chunks whose painted area touches a tile whose
   * visual state changed are marked dirty (they keep showing their old
   * texture until the re-bake lands). Pass `reset` when the whole world
   * changed (map switch) to drop every chunk.
   */
  setTiles(tiles: PaintTile[], reset = false): void {
    if (reset) this.clear();

    const next = new Map<string, PaintTile>();
    const nextFp = new Map<string, string>();
    for (const t of tiles) {
      next.set(t.key, t);
      nextFp.set(t.key, fingerprint(t));
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

    this.markTilesDirty(changed);
  }

  /** Mark every chunk a set of tiles can paint into as needing a re-bake. */
  markTilesDirty(tiles: Iterable<PaintTile>): void {
    let any = false;
    for (const t of tiles) {
      const x0 = Math.floor((t.x - PAINT_MARGIN) / CHUNK_SIZE);
      const x1 = Math.floor((t.x + PAINT_MARGIN) / CHUNK_SIZE);
      const y0 = Math.floor((t.y - PAINT_MARGIN) / CHUNK_SIZE);
      const y1 = Math.floor((t.y + PAINT_MARGIN) / CHUNK_SIZE);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const rc = this.resident.get(chunkKey(cx, cy));
          if (rc) { rc.dirty = true; any = true; }
        }
      }
    }
    if (any && this.lastView) this.update(this.lastView);
  }

  markTileKeysDirty(keys: Iterable<string>): void {
    const ts: PaintTile[] = [];
    for (const k of keys) {
      const t = this.tiles.get(k);
      if (t) ts.push(t);
    }
    this.markTilesDirty(ts);
  }

  getTile(key: string): PaintTile | undefined {
    return this.tiles.get(key);
  }

  /**
   * Work out which chunks the view needs and at what detail, show what's
   * already baked, and schedule the rest. Cheap to call every render.
   */
  update(view: LayerView): void {
    if (this.disposed) return;
    this.lastView = view;
    const scale = lodScale(view.zoom * Math.min(view.dpr, 2));

    // Visible world rect plus one chunk of prefetch on every side.
    const halfW = view.viewW / 2 / view.zoom;
    const halfH = view.viewH / 2 / view.zoom;
    const x0 = Math.floor((view.camX - halfW) / CHUNK_SIZE) - 1;
    const x1 = Math.floor((view.camX + halfW) / CHUNK_SIZE) + 1;
    const y0 = Math.floor((view.camY - halfH) / CHUNK_SIZE) - 1;
    const y1 = Math.floor((view.camY + halfH) / CHUNK_SIZE) + 1;

    const wanted: { key: string; cx: number; cy: number; scale: number; dist: number }[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        if (!this.chunkHasContent(cx, cy)) continue;
        const key = chunkKey(cx, cy);
        const midX = (cx + 0.5) * CHUNK_SIZE;
        const midY = (cy + 0.5) * CHUNK_SIZE;
        wanted.push({ key, cx, cy, scale, dist: Math.hypot(midX - view.camX, midY - view.camY) });
      }
    }
    wanted.sort((a, b) => a.dist - b.dist);

    const wantedKeys = new Set(wanted.map(w => w.key));
    for (const rc of this.resident.values()) rc.mesh.visible = wantedKeys.has(rc.key);

    // Anything missing, at the wrong detail, or dirty goes on the queue.
    this.queue = wanted.filter(w => {
      const rc = this.resident.get(w.key);
      return !rc || rc.scale !== w.scale || rc.dirty;
    });
    if (this.queue.length > 0) this.scheduleBake();
    this.evict(wantedKeys);
  }

  dispose(): void {
    this.disposed = true;
    if (this.bakeRaf !== null) cancelAnimationFrame(this.bakeRaf);
    this.clear();
  }

  // ─── Internals ───────────────────────────────────────────────

  private chunkHasContent(cx: number, cy: number): boolean {
    // A chunk paints tiles from its own bucket and its neighbours' (margin).
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (this.buckets.has(chunkKey(cx + dx, cy + dy))) return true;
      }
    }
    return false;
  }

  private scheduleBake(): void {
    if (this.bakeRaf !== null || this.disposed) return;
    this.bakeRaf = requestAnimationFrame(() => {
      this.bakeRaf = null;
      const start = performance.now();
      let baked = 0;
      while (this.queue.length > 0 && performance.now() - start < FRAME_BUDGET_MS) {
        const job = this.queue.shift()!;
        this.bake(job.cx, job.cy, job.scale);
        baked++;
      }
      if (baked > 0) this.opts.onBaked();
      if (this.queue.length > 0) this.scheduleBake();
    });
  }

  private bake(cx: number, cy: number, scale: number): void {
    const key = chunkKey(cx, cy);
    const minX = cx * CHUNK_SIZE - SEAM_OVERLAP;
    const minY = cy * CHUNK_SIZE - SEAM_OVERLAP;
    const size = CHUNK_SIZE + SEAM_OVERLAP * 2;
    const px = Math.max(1, Math.ceil(size * scale));

    // Gather every tile whose footprint can reach this chunk.
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

    let rc = this.resident.get(key);
    const canvas = rc?.canvas ?? document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    const s = px / size;
    ctx.setTransform(s, 0, 0, s, -minX * s, -minY * s);
    paintTerrain(ctx, tiles, {
      scale: s,
      getTile: (k) => this.tiles.get(k),
      getArt: this.opts.getArt,
    });

    if (!rc) {
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
      // World Y is flipped for three.js (positive world-Y reads as down).
      mesh.position.set(minX + size / 2, -(minY + size / 2), CHUNK_Z);
      this.scene.add(mesh);
      rc = { key, cx, cy, scale, canvas, texture, mesh, bytes: 0, dirty: false };
      this.resident.set(key, rc);
    } else {
      rc.texture.dispose();
      rc.texture = new THREE.CanvasTexture(canvas);
      rc.texture.colorSpace = THREE.SRGBColorSpace;
      rc.texture.minFilter = THREE.LinearFilter;
      rc.texture.magFilter = THREE.LinearFilter;
      rc.texture.generateMipmaps = false;
      (rc.mesh.material as THREE.MeshBasicMaterial).map = rc.texture;
      (rc.mesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
    }
    rc.scale = scale;
    rc.dirty = false;
    // Canvas backing store + GPU copy.
    rc.bytes = px * px * 4 * 2;
    rc.mesh.visible = true;
  }

  /** Drop the farthest non-wanted chunks until resident memory fits the budget. */
  private evict(wantedKeys: Set<string>): void {
    let total = 0;
    for (const rc of this.resident.values()) total += rc.bytes;
    if (total <= this.budgetBytes) return;
    const view = this.lastView;
    const candidates = [...this.resident.values()]
      .filter(rc => !wantedKeys.has(rc.key))
      .sort((a, b) => {
        if (!view) return 0;
        const da = Math.hypot((a.cx + 0.5) * CHUNK_SIZE - view.camX, (a.cy + 0.5) * CHUNK_SIZE - view.camY);
        const db = Math.hypot((b.cx + 0.5) * CHUNK_SIZE - view.camX, (b.cy + 0.5) * CHUNK_SIZE - view.camY);
        return db - da;
      });
    for (const rc of candidates) {
      if (total <= this.budgetBytes) break;
      this.destroyChunk(rc);
      total -= rc.bytes;
    }
  }

  private destroyChunk(rc: ResidentChunk): void {
    this.scene.remove(rc.mesh);
    rc.mesh.geometry.dispose();
    (rc.mesh.material as THREE.MeshBasicMaterial).dispose();
    rc.texture.dispose();
    // Release the canvas backing store promptly (mobile Safari holds it).
    rc.canvas.width = 0;
    rc.canvas.height = 0;
    this.resident.delete(rc.key);
  }

  private clear(): void {
    for (const rc of [...this.resident.values()]) this.destroyChunk(rc);
    this.queue = [];
    this.fingerprints.clear();
  }
}

/** Smallest LOD scale that still covers the requested pixel density. */
export function lodScale(pxPerWorldUnit: number): number {
  let best: number = LOD_SCALES[0];
  for (const s of LOD_SCALES) {
    if (s >= pxPerWorldUnit) best = s;
  }
  return best;
}

function fingerprint(t: PaintTile): string {
  return `${t.type}|${t.fog}|${t.dimmed ? 1 : 0}|${t.zone}`;
}
