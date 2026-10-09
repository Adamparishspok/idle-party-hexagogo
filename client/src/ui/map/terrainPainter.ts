/**
 * Painted-terrain renderer for one map chunk.
 *
 * Pure and deterministic: given the tiles that can reach into a rectangle,
 * it paints that rectangle of the world. Every random choice is seeded by the
 * tile key or by world position, and every pass draws tiles in one global
 * order, so two adjacent chunks paint identical pixels along their seam.
 * Nothing here touches three.js or the DOM, which keeps the door open to
 * moving it into a worker later (see ideas/world-map-renderer.md).
 *
 * All drawing is in world units; the caller sets the canvas transform.
 */

import { HEX_SIZE, getHexCorners } from '@idle-party-rpg/shared';

export type FogState = 'open' | 'haze' | 'fog';

export interface PaintTile {
  /** Cube key — stable identity, also the RNG seed. */
  key: string;
  /** World-space center. */
  x: number;
  y: number;
  type: string;
  /** Fallback color for tile types the painter has no recipe for. */
  color: string;
  zone: string;
  traversable: boolean;
  fog: FogState;
  /** Outside the zone the party is in — painted slightly darker. */
  dimmed: boolean;
  /** Keys of the 6 neighbours (missing neighbours are omitted). */
  neighborKeys: string[];
  /** Emoji glyph for types with no procedural recipe. */
  icon?: string;
}

export interface PaintOptions {
  /** Bake scale (canvas px per world unit). Detail is skipped when small. */
  scale: number;
  getTile: (key: string) => PaintTile | undefined;
  /** Uploaded art for a tile, already clipped to a hex sprite; null if none. */
  getArt: (tile: PaintTile) => CanvasImageSource | null;
}

// ─── Deterministic noise ─────────────────────────────────────────

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for scattering props. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lattice(ix: number, iy: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1], a function of world position only. */
function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = lattice(ix, iy);
  const b = lattice(ix + 1, iy);
  const c = lattice(ix, iy + 1);
  const d = lattice(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number): number {
  return noise2(x, y) * 0.65 + noise2(x * 2.3 + 17, y * 2.3 + 5) * 0.35;
}

// ─── Shapes ──────────────────────────────────────────────────────

const HEX_CORNERS = getHexCorners(HEX_SIZE);
const BLOB_POINTS_PER_EDGE = 4;

function blobPath(ctx: CanvasRenderingContext2D, t: PaintTile, scale: number, wobble: number): void {
  ctx.beginPath();
  addBlob(ctx, t, scale, wobble);
}

function hexPath(ctx: CanvasRenderingContext2D, t: PaintTile): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const c = HEX_CORNERS[i];
    if (i === 0) ctx.moveTo(t.x + c.x, t.y + c.y); else ctx.lineTo(t.x + c.x, t.y + c.y);
  }
  ctx.closePath();
}

// ─── Terrain recipes ─────────────────────────────────────────────

interface Recipe {
  /** Paint order — higher layers paint over lower ones at borders. */
  layer: number;
  base: string;
  /** Lighter/darker dab colors for brush texture. */
  light: string;
  dark: string;
  props?: (ctx: CanvasRenderingContext2D, t: PaintTile, r: () => number) => void;
}

const WATER_TYPES = new Set(['water']);
const isLand = (t: PaintTile) => t.type !== 'void' && !WATER_TYPES.has(t.type);

const RECIPES: Record<string, Recipe> = {
  beach: { layer: 0, base: '#ecd39a', light: '#f7e6b8', dark: '#d8b878', props: pebbles },
  desert: { layer: 1, base: '#e2c271', light: '#f0d792', dark: '#c9a352', props: dunes },
  plains: { layer: 2, base: '#86c94a', light: '#a6dc62', dark: '#6aac38', props: grassTufts },
  hedge: { layer: 3, base: '#4f9a35', light: '#69b445', dark: '#3a7a28', props: hedges },
  forest: { layer: 3, base: '#4c9b3a', light: '#66b24a', dark: '#357a2a', props: pines },
  town: { layer: 4, base: '#8fc451', light: '#a9d867', dark: '#72a63e', props: houses },
  dungeon: { layer: 4, base: '#7f9a55', light: '#97b066', dark: '#627a40', props: caveMouth },
  lava_field: { layer: 5, base: '#4a2c24', light: '#5e3a2e', dark: '#2e1a15', props: lavaCracks },
  mountain: { layer: 6, base: '#a08a68', light: '#bba57e', dark: '#7d6a4e', props: peaks },
  volcano: { layer: 7, base: '#4a2f28', light: '#5d3b31', dark: '#2c1b17', props: volcanoCone },
};

function recipeFor(t: PaintTile): Recipe {
  return RECIPES[t.type] ?? { layer: 2, base: t.color, light: t.color, dark: t.color };
}

const SAND = '#e7cd8f';
const FOAM = 'rgba(255,255,255,0.85)';
const SHALLOWS = 'rgba(140,220,230,0.32)';
const LAKE = '#3d93c9';
const LAKE_DEEP = '#2f7db3';

// ─── Public entry ────────────────────────────────────────────────

/**
 * Paint every tile in `tiles` (the chunk's tiles plus its margin) into `ctx`.
 * The caller has already set the world→canvas transform and cleared it.
 */
export function paintTerrain(ctx: CanvasRenderingContext2D, tiles: PaintTile[], opts: PaintOptions): void {
  // One global order for every pass: by key. Adjacent chunks iterate the
  // same tiles in the same order, so overlapping draws match at seams.
  const ordered = [...tiles].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const land = ordered.filter(isLand);
  const water = ordered.filter(t => WATER_TYPES.has(t.type));
  const detail = opts.scale > 0.26;

  // 1. Coast: shallows halo → foam → sand rim, each a union of blobs.
  fillBlobs(ctx, land, 1.62, 10, SHALLOWS);
  fillBlobs(ctx, land, 1.36, 9, FOAM);
  fillBlobs(ctx, land, 1.24, 9, SAND);

  // 2. Terrain fills, low layers first so higher terrain overlaps borders.
  const byLayer = [...land].sort((a, b) => recipeFor(a).layer - recipeFor(b).layer || (a.key < b.key ? -1 : 1));
  for (const t of byLayer) {
    const rec = recipeFor(t);
    // Soft halo, then a solid core, so neighbouring types feather together.
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = rec.base;
    blobPath(ctx, t, 1.2, 7);
    ctx.fill();
    ctx.globalAlpha = 1;
    blobPath(ctx, t, 1.06, 6);
    ctx.fill();
    if (detail) brushDabs(ctx, t, rec);
  }

  // 3. Lakes and inland water, with foam rims.
  fillBlobs(ctx, water, 1.12, 7, FOAM);
  for (const t of water) {
    ctx.fillStyle = LAKE;
    blobPath(ctx, t, 1.02, 6);
    ctx.fill();
    if (detail) waterRipples(ctx, t);
  }

  // 4. Uploaded art, clipped to the tile, replaces the procedural props.
  const withArt = new Set<string>();
  for (const t of ordered) {
    if (t.type === 'void') continue;
    const art = opts.getArt(t);
    if (!art) continue;
    withArt.add(t.key);
    ctx.save();
    blobPath(ctx, t, 1.0, 4);
    ctx.clip();
    ctx.drawImage(art, t.x - HEX_SIZE, t.y - (Math.sqrt(3) * HEX_SIZE) / 2, HEX_SIZE * 2, Math.sqrt(3) * HEX_SIZE);
    ctx.restore();
  }

  // 5. Props, depth-sorted so lower things overlap higher ones.
  if (detail) {
    const propTiles = land.filter(t => !withArt.has(t.key)).sort((a, b) => a.y - b.y || (a.key < b.key ? -1 : 1));
    for (const t of propTiles) {
      const rec = RECIPES[t.type];
      const r = rng(hashString(t.key) ^ 0x9e3779b9);
      if (rec?.props) rec.props(ctx, t, r);
      else if (t.icon) drawIcon(ctx, t);
    }
  }

  // 6. Fog of war and zone dimming — union fills, so neighbouring fog
  //    blobs don't stack darker where they overlap.
  const visible = ordered.filter(t => t.type !== 'void');
  fillBlobs(ctx, visible.filter(t => t.fog === 'open' && t.dimmed), 1.08, 5, 'rgba(14,16,28,0.28)');
  fillBlobs(ctx, visible.filter(t => t.fog === 'haze'), 1.3, 10, 'rgba(28,33,51,0.5)');
  const fogged = visible.filter(t => t.fog === 'fog');
  fillBlobs(ctx, fogged, 1.3, 10, 'rgba(28,33,51,0.88)');
  if (detail) for (const t of fogged) fogPuffs(ctx, t);

  // 7. Faint grid on explored land; soft dashed zone borders.
  if (detail) {
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(40,30,12,0.16)';
    for (const t of land) {
      if (t.fog !== 'open' || !t.traversable) continue;
      hexPath(ctx, t);
      ctx.stroke();
    }
  }
  drawZoneBorders(ctx, ordered, opts);
}

// ─── Passes ──────────────────────────────────────────────────────

/**
 * Fill the union of many blobs as one compound path, so overlapping
 * translucent halos (shallows, foam) don't stack darker where they meet.
 */
function fillBlobs(ctx: CanvasRenderingContext2D, tiles: PaintTile[], scale: number, wobble: number, fill: string): void {
  if (tiles.length === 0) return;
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (const t of tiles) addBlob(ctx, t, scale, wobble);
  ctx.fill('nonzero');
}

/**
 * Append a hex whose outline is pushed in/out by world-position noise. The
 * displacement depends only on world position, so the coastline is one
 * continuous wobbly line no matter which tile or chunk draws it.
 */
function addBlob(ctx: CanvasRenderingContext2D, t: PaintTile, scale: number, wobble: number): void {
  for (let i = 0; i < 6; i++) {
    const a = HEX_CORNERS[i];
    const b = HEX_CORNERS[(i + 1) % 6];
    for (let k = 0; k < BLOB_POINTS_PER_EDGE; k++) {
      const f = k / BLOB_POINTS_PER_EDGE;
      const px = (a.x + (b.x - a.x) * f) * scale;
      const py = (a.y + (b.y - a.y) * f) * scale;
      const wx = t.x + px;
      const wy = t.y + py;
      const len = Math.hypot(px, py) || 1;
      const d = (fbm(wx / 34, wy / 34) - 0.5) * 2 * wobble;
      const x = wx + (px / len) * d;
      const y = wy + (py / len) * d;
      if (i === 0 && k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

function brushDabs(ctx: CanvasRenderingContext2D, t: PaintTile, rec: Recipe): void {
  const r = rng(hashString(t.key) ^ 0x51ed270b);
  ctx.save();
  blobPath(ctx, t, 1.06, 6);
  ctx.clip();
  for (let i = 0; i < 14; i++) {
    const ang = r() * Math.PI * 2;
    const dist = Math.sqrt(r()) * HEX_SIZE * 0.95;
    const x = t.x + Math.cos(ang) * dist;
    const y = t.y + Math.sin(ang) * dist;
    ctx.globalAlpha = 0.28 + r() * 0.22;
    ctx.fillStyle = r() < 0.5 ? rec.light : rec.dark;
    ctx.beginPath();
    ctx.ellipse(x, y, 5 + r() * 9, 3 + r() * 5, r() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function waterRipples(ctx: CanvasRenderingContext2D, t: PaintTile): void {
  const r = rng(hashString(t.key) ^ 0x2545f491);
  ctx.save();
  ctx.fillStyle = LAKE_DEEP;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.ellipse(t.x, t.y + 3, HEX_SIZE * 0.55, HEX_SIZE * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const x = t.x + (r() - 0.5) * HEX_SIZE;
    const y = t.y + (r() - 0.5) * HEX_SIZE * 0.9;
    ctx.beginPath();
    ctx.arc(x, y, 5 + r() * 4, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.restore();
}

/** A few lighter puffs so fog reads as cloud, not a flat shade. */
function fogPuffs(ctx: CanvasRenderingContext2D, t: PaintTile): void {
  const r = rng(hashString(t.key) ^ 0x7f4a7c15);
  ctx.save();
  ctx.fillStyle = '#3a4260';
  for (let i = 0; i < 3; i++) {
    ctx.globalAlpha = 0.3 + r() * 0.25;
    ctx.beginPath();
    ctx.arc(t.x + (r() - 0.5) * HEX_SIZE * 1.2, t.y + (r() - 0.5) * HEX_SIZE, 12 + r() * 14, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const DIR_TO_EDGE: [number, number][] = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];

function drawZoneBorders(ctx: CanvasRenderingContext2D, tiles: PaintTile[], opts: PaintOptions): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,214,120,0.7)';
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.setLineDash([7, 6]);
  for (const t of tiles) {
    if (t.type === 'void') continue;
    t.neighborKeys.forEach((nk, dir) => {
      if (!nk) return;
      const nb = opts.getTile(nk);
      if (!nb || nb.type === 'void' || nb.zone === t.zone) return;
      // Each shared edge is drawn once, by the lower key.
      if (t.key > nb.key) return;
      const [c0, c1] = DIR_TO_EDGE[dir];
      ctx.beginPath();
      ctx.moveTo(t.x + HEX_CORNERS[c0].x, t.y + HEX_CORNERS[c0].y);
      ctx.lineTo(t.x + HEX_CORNERS[c1].x, t.y + HEX_CORNERS[c1].y);
      ctx.stroke();
    });
  }
  ctx.restore();
}

function drawIcon(ctx: CanvasRenderingContext2D, t: PaintTile): void {
  ctx.save();
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t.icon ?? '', t.x, t.y);
  ctx.restore();
}

// ─── Props ───────────────────────────────────────────────────────

function groundShadow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  ctx.fillStyle = 'rgba(20,40,10,0.28)';
  ctx.beginPath();
  ctx.ellipse(x + 2, y + 1, w, w * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
}

function pine(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, dark: boolean): void {
  const w = h * 0.42;
  groundShadow(ctx, x, y, w * 0.9);
  ctx.fillStyle = '#6b4a2a';
  ctx.fillRect(x - 1.6, y - h * 0.18, 3.2, h * 0.2);
  const tiers = 3;
  for (let i = 0; i < tiers; i++) {
    const ty = y - h * 0.15 - i * h * 0.24;
    const tw = w * (1 - i * 0.22);
    const th = h * 0.42;
    ctx.fillStyle = dark ? '#245a26' : '#2e6e2c';
    ctx.beginPath();
    ctx.moveTo(x, ty - th);
    ctx.lineTo(x + tw, ty);
    ctx.lineTo(x - tw, ty);
    ctx.closePath();
    ctx.fill();
    // Lit left face.
    ctx.fillStyle = dark ? '#33772f' : '#3f8e37';
    ctx.beginPath();
    ctx.moveTo(x, ty - th);
    ctx.lineTo(x, ty);
    ctx.lineTo(x - tw, ty);
    ctx.closePath();
    ctx.fill();
  }
}

function pines(ctx: CanvasRenderingContext2D, t: PaintTile, r: () => number): void {
  const n = 4 + Math.floor(r() * 3);
  const pts: { x: number; y: number; h: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ang = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * HEX_SIZE * 0.62;
    pts.push({ x: t.x + Math.cos(ang) * d, y: t.y + Math.sin(ang) * d * 0.85 + 8, h: 20 + r() * 12 });
  }
  pts.sort((a, b) => a.y - b.y);
  for (const p of pts) pine(ctx, p.x, p.y, p.h, r() < 0.5);
}

function hedges(ctx: CanvasRenderingContext2D, t: PaintTile, r: () => number): void {
  for (let i = 0; i < 7; i++) {
    const x = t.x + (r() - 0.5) * HEX_SIZE * 1.3;
    const y = t.y + (r() - 0.5) * HEX_SIZE * 1.1;
    const s = 7 + r() * 5;
    groundShadow(ctx, x, y + s * 0.6, s);
    ctx.fillStyle = '#2f6b26';
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4b9338';
    ctx.beginPath();
    ctx.arc(x - s * 0.3, y - s * 0.3, s * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function grassTufts(ctx: CanvasRenderingContext2D, t: PaintTile, r: () => number): void {
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 5; i++) {
    const x = t.x + (r() - 0.5) * HEX_SIZE * 1.3;
    const y = t.y + (r() - 0.5) * HEX_SIZE * 1.1;
    ctx.strokeStyle = '#5a9a2e';
    ctx.beginPath();
    ctx.moveTo(x - 3, y - 4); ctx.lineTo(x - 1, y);
    ctx.moveTo(x, y - 6); ctx.lineTo(x, y);
    ctx.moveTo(x + 3, y - 4); ctx.lineTo(x + 1, y);
    ctx.stroke();
  }
  if (r() < 0.6) {
    const colors = ['#ffe36b', '#ffffff', '#ff9fc4'];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = colors[Math.floor(r() * colors.length)];
      ctx.beginPath();
      ctx.arc(t.x + (r() - 0.5) * HEX_SIZE * 1.2, t.y + (r() - 0.5) * HEX_SIZE, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function pebbles(ctx: CanvasRenderingContext2D, t: PaintTile, r: () => number): void {
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = r() < 0.5 ? '#cdb489' : '#fff1cf';
    ctx.beginPath();
    ctx.ellipse(t.x + (r() - 0.5) * HEX_SIZE, t.y + (r() - 0.5) * HEX_SIZE * 0.9, 2.4, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function dunes(ctx: CanvasRenderingContext2D, t: PaintTile, r: () => number): void {
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const x = t.x + (r() - 0.5) * HEX_SIZE;
    const y = t.y + (r() - 0.5) * HEX_SIZE * 0.9;
    const w = 12 + r() * 10;
    ctx.strokeStyle = 'rgba(255,240,190,0.85)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(x - w, y);
    ctx.quadraticCurveTo(x, y - 7, x + w, y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(170,130,60,0.5)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.8, y + 2.5);
    ctx.quadraticCurveTo(x, y - 3, x + w * 0.8, y + 2.5);
    ctx.stroke();
  }
  if (r() < 0.35) {
    // A lone cactus.
    const x = t.x + (r() - 0.5) * HEX_SIZE * 0.8;
    const y = t.y + (r() - 0.5) * HEX_SIZE * 0.6;
    groundShadow(ctx, x, y, 5);
    ctx.strokeStyle = '#4c8a3a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x, y - 14);
    ctx.moveTo(x, y - 7); ctx.lineTo(x - 5, y - 7); ctx.lineTo(x - 5, y - 11);
    ctx.stroke();
  }
}

function house(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, roof: string): void {
  groundShadow(ctx, x, y, s * 0.9);
  const w = s * 1.3;
  const h = s * 0.85;
  ctx.fillStyle = '#efe0bf';
  ctx.fillRect(x - w / 2, y - h, w, h);
  ctx.fillStyle = '#c9b48d';
  ctx.fillRect(x + w * 0.1, y - h, w * 0.4, h);
  ctx.fillStyle = '#6b4526';
  ctx.fillRect(x - w * 0.12, y - h * 0.55, w * 0.24, h * 0.55);
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(x - w * 0.65, y - h);
  ctx.lineTo(x, y - h - s * 0.75);
  ctx.lineTo(x + w * 0.65, y - h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.moveTo(x, y - h - s * 0.75);
  ctx.lineTo(x + w * 0.65, y - h);
  ctx.lineTo(x, y - h);
  ctx.closePath();
  ctx.fill();
}

function houses(ctx: CanvasRenderingContext2D, t: PaintTile, r: () => number): void {
  // A dirt plaza, then a few houses around it.
  ctx.fillStyle = '#d9bd86';
  ctx.beginPath();
  ctx.ellipse(t.x, t.y + 4, HEX_SIZE * 0.5, HEX_SIZE * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  const roofs = ['#b8452f', '#7d4a9b', '#3f6fae', '#a5662f'];
  const spots = [
    { x: -14, y: -4 }, { x: 13, y: -8 }, { x: -2, y: 12 }, { x: 18, y: 10 },
  ];
  const n = 2 + Math.floor(r() * 3);
  const chosen = spots.slice(0, n).sort((a, b) => a.y - b.y);
  for (const p of chosen) {
    house(ctx, t.x + p.x + (r() - 0.5) * 4, t.y + p.y, 11 + r() * 4, roofs[Math.floor(r() * roofs.length)]);
  }
}

function caveMouth(ctx: CanvasRenderingContext2D, t: PaintTile, _r: () => number): void {
  const x = t.x;
  const y = t.y + 8;
  groundShadow(ctx, x, y, 22);
  ctx.fillStyle = '#8a8270';
  ctx.beginPath();
  ctx.ellipse(x, y - 8, 24, 18, 0, Math.PI, 0);
  ctx.lineTo(x + 24, y);
  ctx.lineTo(x - 24, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#a69e88';
  ctx.beginPath();
  ctx.ellipse(x - 6, y - 14, 12, 9, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1310';
  ctx.beginPath();
  ctx.ellipse(x, y - 2, 10, 11, 0, Math.PI, 0);
  ctx.lineTo(x + 10, y);
  ctx.lineTo(x - 10, y);
  ctx.closePath();
  ctx.fill();
}

function lavaCracks(ctx: CanvasRenderingContext2D, t: PaintTile, r: () => number): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,120,20,0.9)';
  ctx.shadowBlur = 6;
  ctx.strokeStyle = '#ff8a1c';
  ctx.lineWidth = 2.4;
  for (let i = 0; i < 3; i++) {
    let x = t.x + (r() - 0.5) * HEX_SIZE;
    let y = t.y + (r() - 0.5) * HEX_SIZE * 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (r() - 0.5) * 16;
      y += (r() - 0.5) * 12;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function peak(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  groundShadow(ctx, x, y, w * 0.9);
  ctx.fillStyle = '#7b6a55';
  ctx.beginPath();
  ctx.moveTo(x - w, y);
  ctx.lineTo(x, y - h);
  ctx.lineTo(x + w, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#a99579';
  ctx.beginPath();
  ctx.moveTo(x - w, y);
  ctx.lineTo(x, y - h);
  ctx.lineTo(x - w * 0.1, y);
  ctx.closePath();
  ctx.fill();
  // Snow cap.
  ctx.fillStyle = '#f4f7fb';
  ctx.beginPath();
  ctx.moveTo(x, y - h);
  ctx.lineTo(x + w * 0.32, y - h * 0.66);
  ctx.lineTo(x + w * 0.1, y - h * 0.7);
  ctx.lineTo(x - w * 0.05, y - h * 0.6);
  ctx.lineTo(x - w * 0.3, y - h * 0.68);
  ctx.closePath();
  ctx.fill();
}

function peaks(ctx: CanvasRenderingContext2D, t: PaintTile, r: () => number): void {
  const n = 1 + Math.floor(r() * 2);
  if (n === 1) {
    peak(ctx, t.x, t.y + 14, 30, 46 + r() * 8);
  } else {
    peak(ctx, t.x - 12, t.y + 10, 22, 34 + r() * 6);
    peak(ctx, t.x + 12, t.y + 18, 26, 42 + r() * 6);
  }
}

function volcanoCone(ctx: CanvasRenderingContext2D, t: PaintTile, _r: () => number): void {
  const x = t.x;
  const y = t.y + 16;
  groundShadow(ctx, x, y, 30);
  ctx.fillStyle = '#3b2621';
  ctx.beginPath();
  ctx.moveTo(x - 32, y);
  ctx.lineTo(x - 9, y - 40);
  ctx.lineTo(x + 9, y - 40);
  ctx.lineTo(x + 32, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#56372f';
  ctx.beginPath();
  ctx.moveTo(x - 32, y);
  ctx.lineTo(x - 9, y - 40);
  ctx.lineTo(x - 2, y - 40);
  ctx.lineTo(x - 10, y);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.shadowColor = 'rgba(255,110,20,1)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#ff7b1c';
  ctx.beginPath();
  ctx.ellipse(x, y - 40, 9, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Smoke.
  ctx.fillStyle = 'rgba(90,85,90,0.55)';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x + i * 5 - 3, y - 50 - i * 8, 6 + i * 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── Sea texture ─────────────────────────────────────────────────

/**
 * A 256px painted-sea tile that wraps seamlessly: color variation comes from
 * integer-frequency waves (periodic over the tile), and wave marks near an
 * edge are drawn again on the opposite edge.
 */
export function createSeaCanvas(size = 256): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const img = ctx.createImageData(size, size);
  const tau = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const n =
        Math.sin(tau * (2 * u + v)) * 0.5 +
        Math.sin(tau * (3 * v - u)) * 0.35 +
        Math.sin(tau * (5 * u + 4 * v)) * 0.15;
      const k = (n + 1) / 2;
      const i = (y * size + x) * 4;
      img.data[i] = 38 + k * 22;
      img.data[i + 1] = 118 + k * 34;
      img.data[i + 2] = 176 + k * 30;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const r = rng(0xc0ffee);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const x = r() * size;
    const y = r() * size;
    const w = 6 + r() * 8;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, w, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
    }
  }
  return c;
}
