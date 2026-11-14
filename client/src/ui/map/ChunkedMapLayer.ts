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
import type { PaintTile } from './terrainPainter';
import { CHUNK_SIZE, TerrainTileIndex, bakeChunk, chunkBounds, chunkKey, lodScale, revealedTiles } from './terrainChunks';
import { prefersReducedMotion } from './markerMotion';

export { CHUNK_SIZE, lodScale };

/** Max bake work per frame, so panning stays smooth while chunks fill in. */
const FRAME_BUDGET_MS = 8;
/** Mesh z — above the sea backdrop, below nothing (markers are DOM). */
const CHUNK_Z = 2;
/** The pre-reveal texture fades out on top of the fresh bake. */
const FADE_Z = 2.5;
const REVEAL_FADE_MS = 900;
/** Per chunk of distance from the view center, so the clouds roll outward. */
const REVEAL_STAGGER_MS = 180;

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
  /** Fog lifted on a tile here: cross-fade the next bake in. */
  reveal: boolean;
}

interface RevealFade {
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  start: number;
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
  getPropArt?: (tile: PaintTile) => CanvasImageSource | null;
  /** Called when what the chunks show changed — a bake landed or a reveal faded a step (caller re-renders). */
  onBaked: () => void;
}

function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

export class ChunkedMapLayer {
  private scene: THREE.Scene;
  private opts: LayerOptions;
  private index = new TerrainTileIndex();
  private resident = new Map<string, ResidentChunk>();
  /** Chunks wanted by the last update, nearest first, with their target LOD. */
  private queue: { key: string; cx: number; cy: number; scale: number }[] = [];
  private bakeRaf: number | null = null;
  private fades: RevealFade[] = [];
  private fadeRaf: number | null = null;
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
    const revealed = revealedTiles(k => this.index.getTile(k)?.fog, tiles);
    const changed = this.index.setTiles(tiles);
    for (const t of revealed) {
      for (const { cx, cy } of this.index.chunksTouching(t)) {
        const rc = this.resident.get(chunkKey(cx, cy));
        if (rc) rc.reveal = true;
      }
    }
    this.markTilesDirty(changed);
  }

  /** Mark every chunk a set of tiles can paint into as needing a re-bake. */
  markTilesDirty(tiles: Iterable<PaintTile>): void {
    let any = false;
    for (const t of tiles) {
      for (const { cx, cy } of this.index.chunksTouching(t)) {
        const rc = this.resident.get(chunkKey(cx, cy));
        if (rc) { rc.dirty = true; any = true; }
      }
    }
    if (any && this.lastView) this.update(this.lastView);
  }

  markTileKeysDirty(keys: Iterable<string>): void {
    const ts: PaintTile[] = [];
    for (const k of keys) {
      const t = this.index.getTile(k);
      if (t) ts.push(t);
    }
    this.markTilesDirty(ts);
  }

  getTile(key: string): PaintTile | undefined {
    return this.index.getTile(key);
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
        if (!this.index.chunkHasContent(cx, cy)) continue;
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
    if (this.fadeRaf !== null) cancelAnimationFrame(this.fadeRaf);
    this.fadeRaf = null;
    this.clear();
  }

  // ─── Internals ───────────────────────────────────────────────

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
    const { minX, minY, size } = chunkBounds(cx, cy);
    let rc = this.resident.get(key);
    const fadeOut = rc?.reveal && rc.mesh.visible && !prefersReducedMotion();
    const canvas = rc && !fadeOut ? rc.canvas : document.createElement('canvas');
    if (!bakeChunk(canvas, this.index, cx, cy, scale, this.opts)) return;
    const px = canvas.width;

    if (!rc) {
      const texture = chunkTexture(canvas);
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
      // World Y is flipped for three.js (positive world-Y reads as down).
      mesh.position.set(minX + size / 2, -(minY + size / 2), CHUNK_Z);
      this.scene.add(mesh);
      rc = { key, cx, cy, scale, canvas, texture, mesh, bytes: 0, dirty: false, reveal: false };
      this.resident.set(key, rc);
    } else {
      if (fadeOut) this.startFade(rc);
      else rc.texture.dispose();
      rc.canvas = canvas;
      rc.texture = chunkTexture(canvas);
      (rc.mesh.material as THREE.MeshBasicMaterial).map = rc.texture;
      (rc.mesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
    }
    rc.scale = scale;
    rc.dirty = false;
    rc.reveal = false;
    // Canvas backing store + GPU copy.
    rc.bytes = px * px * 4 * 2;
    rc.mesh.visible = true;
  }

  /** Keep the chunk's pre-reveal texture on top and fade it out, nearer chunks first. */
  private startFade(rc: ResidentChunk): void {
    const { minX, minY, size } = chunkBounds(rc.cx, rc.cy);
    const material = new THREE.MeshBasicMaterial({ map: rc.texture, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    mesh.position.set(minX + size / 2, -(minY + size / 2), FADE_Z);
    this.scene.add(mesh);
    const view = this.lastView;
    const chunksAway = view
      ? Math.hypot((rc.cx + 0.5) * CHUNK_SIZE - view.camX, (rc.cy + 0.5) * CHUNK_SIZE - view.camY) / CHUNK_SIZE
      : 0;
    this.fades.push({ mesh, canvas: rc.canvas, start: performance.now() + chunksAway * REVEAL_STAGGER_MS });
    this.runFades();
  }

  private runFades(): void {
    if (this.fadeRaf !== null || this.disposed) return;
    this.fadeRaf = requestAnimationFrame(() => {
      this.fadeRaf = null;
      const now = performance.now();
      this.fades = this.fades.filter(f => {
        const t = (now - f.start) / REVEAL_FADE_MS;
        if (t >= 1) { this.endFade(f); return false; }
        const u = Math.max(0, t);
        (f.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - u * u * (3 - 2 * u);
        return true;
      });
      this.opts.onBaked();
      if (this.fades.length > 0) this.runFades();
    });
  }

  private endFade(f: RevealFade): void {
    this.scene.remove(f.mesh);
    f.mesh.geometry.dispose();
    const material = f.mesh.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    material.dispose();
    f.canvas.width = 0;
    f.canvas.height = 0;
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
    for (const f of this.fades) this.endFade(f);
    this.fades = [];
    for (const rc of [...this.resident.values()]) this.destroyChunk(rc);
    this.queue = [];
    this.index.clear();
  }
}

function chunkTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}
