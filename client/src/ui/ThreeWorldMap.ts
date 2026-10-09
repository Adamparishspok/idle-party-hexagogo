/**
 * WebGL-backed world map renderer (replaces CanvasWorldMap).
 *
 * Rendering split:
 *   • three.js (WebGL canvas) renders the *static* layers — the sea
 *     backdrop and the painted terrain, which is baked per chunk at a zoom-
 *     matched level of detail (ChunkedMapLayer + terrainPainter). Textures
 *     live on the GPU, so per-frame work collapses to a camera-matrix update.
 *   • An HTML overlay (`.wm-overlay`) sits on top of the canvas
 *     and hosts every *dynamic* element — party marker, other-party
 *     portrait markers + pips, hover highlight, path preview. The overlay
 *     carries a single `transform: translate scale translate` mirroring
 *     the three.js camera, so a single style update moves all children
 *     together when the user pans/zooms.
 *   • The tooltip is a separate cursor-positioned element (no map
 *     transform).
 *
 * Why this matters: the WebGL scene is render-on-demand. Idle = zero
 * GPU/CPU. Panning re-renders the scene but the textures are already on
 * the GPU. Party pulse + tween live entirely in CSS so they don't drive
 * any JS frame work.
 *
 * Public API parity with the prior CanvasWorldMap:
 *   setSendMove, setOnTileClick, adjustZoom, applyServerState,
 *   rebuildFromCache, recenterOnPlayer, pause, resume, destroy.
 */

import * as THREE from 'three';
import {
  HexGrid,
  HexTile,
  HEX_SIZE,
  getHexCorners,
  getNeighbors,
  cubeToKey,
  keyToCube,
  pixelToCube,
  offsetToCube,
  cubeToPixel,
  cubeToOffset,
} from '@idle-party-rpg/shared';
import type {
  ServerStateMessage,
  ServerPartyState,
  BattleVisual,
  OtherPlayerState,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import type { WorldCache } from '../network/WorldCache';
import { artworkUrl } from './assets';
import { ChunkedMapLayer } from './map/ChunkedMapLayer';
import { createSeaCanvas, type PaintTile, type FogState } from './map/terrainPainter';
import { ROOM_ICONS, getRoomActions, readyQuestIds, roomHome } from './RoomActions';
import type { RoomAction, RoomHome } from './RoomActions';

export interface TileClickInfo {
  col: number;
  row: number;
  tileType: string;
  zoneName: string;
  roomName: string;
  zoneId: string;
  isTraversable: boolean;
  isUnlocked: boolean;
  isSameZone: boolean;
  isCurrentTile: boolean;
  playersHere: { username: string; className?: string; partyId?: string; dungeonName?: string }[];
  partyMemberUsernames: string[];
  dungeonId?: string;
}

// ─── Render constants ─────────────────────────────────────────
// Party marker look (portrait frame, fighting/defeat states) lives in CSS —
// see `.wm-marker--party[data-visual]` in styles/screens/map.css.

/** Sea color behind everything until the sea texture is ready. */
const SEA_FALLBACK_COLOR = '#2f86bf';

/** Key glyph for the "party inside this room's dungeon" marker pip. */
const KEY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M11.5 11.5 20 20M16 16l2.5-2.5M18.5 18.5 21 16" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/></svg>';

function escapeMarkerText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MIN_TILES_VISIBLE = 15;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEPS = [0.4, 0.7, 1.0, 1.5, 2.5] as const;
const ZOOM_STORAGE_KEY = 'mapZoom';

const OVERDRAG_FACTOR = 0.25;
const SPRING_DURATION = 250;
const DRAG_THRESHOLD = 5;

// Parchment plane is sized to a fixed quad and follows the camera at a
// reduced rate so it reads as a deeper background layer (parallax).
const PARCHMENT_PARALLAX = 0.3;

const MAX_MARKER_ICONS = 3;
const TOOLTIP_MARGIN = 4;

interface TileOccupancy {
  col: number;
  row: number;
  count: number;
  inDungeon: boolean;
}

// ─── Image cache ──────────────────────────────────────────────

interface CachedImage {
  img: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
}

class ImageCache {
  private cache = new Map<string, CachedImage>();

  get(url: string, fallbackUrl: string | null, onLoad: () => void): HTMLImageElement | null {
    const existing = this.cache.get(url);
    if (existing) {
      if (existing.loaded) return existing.img;
      return null;
    }
    const entry: CachedImage = {
      img: new Image(),
      loaded: false,
      failed: false,
    };
    this.cache.set(url, entry);
    entry.img.onload = () => {
      entry.loaded = true;
      onLoad();
    };
    entry.img.onerror = () => {
      if (fallbackUrl && entry.img.src !== fallbackUrl) {
        entry.img.src = fallbackUrl;
      } else {
        entry.failed = true;
      }
    };
    entry.img.src = url;
    return null;
  }
}

// ─── Easing ───────────────────────────────────────────────────

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

// ─── Main class ───────────────────────────────────────────────

export class ThreeWorldMap {
  private container: HTMLElement;
  private worldCache: WorldCache;

  // DOM elements.
  private canvas: HTMLCanvasElement;
  private overlay: HTMLDivElement;
  private partyEl: HTMLDivElement;
  private hoverEl: HTMLDivElement;
  private pathEl: HTMLDivElement;
  private markersEl: HTMLDivElement;
  private flagsEl: HTMLDivElement;
  private tooltipEl: HTMLDivElement;
  private tooltipZoneEl: HTMLElement;
  private tooltipRoomEl: HTMLElement;
  private tooltipActionsEl: HTMLElement;
  private partyBodyEl: HTMLElement;
  private partyNameEl: HTMLElement;
  private partyInitialEl: HTMLElement;
  private partyImgEl: HTMLImageElement;
  private partyLevelEl: HTMLElement;
  private partyCountEl: HTMLElement;
  /** Class whose portrait the party marker currently shows. */
  private partyClassName = '';
  /** Zoom the marker counter-scale was last written for. */
  private markerZoom = 0;
  /** Last HTML written to the other-parties layer (identical rewrites are skipped). */
  private lastOthersHtml = '';

  // three.js core.
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;

  // Scene planes.
  private parchmentMesh: THREE.Mesh | null = null;
  private parchmentMaterial: THREE.MeshBasicMaterial;
  private parchmentTexture: THREE.Texture | null = null;
  /** Painted terrain, baked per chunk. */
  private terrain: ChunkedMapLayer;

  // Image cache (shared across renders).
  private imageCache = new ImageCache();
  private hexSpriteCache = new Map<string, HTMLCanvasElement>();
  /** Tile keys waiting on each art URL, so a late load re-bakes just them. */
  private artWaiters = new Map<string, Set<string>>();
  /** Map id whose parchment texture is currently loaded/loading (per-map backgrounds). */
  private parchmentMapId: string | null = null;

  // Grid + content.
  private grid: HexGrid = new HexGrid();
  private worldTileDefs = new Map<string, WorldTileDefinition>();

  // Camera state — camWorldX/Y is the world point currently centered on
  // screen; zoom is the magnification scalar. Maps directly to
  // `camera.position.x = camWorldX`, `camera.position.y = -camWorldY`
  // (Y flipped so positive world-Y still reads as "down" on screen),
  // and `camera.zoom = zoom`.
  private camWorldX = 0;
  private camWorldY = 0;
  private zoom = 1;

  // Spring-back animation state for overdrag.
  private springAnim: { startX: number; startY: number; targetX: number; targetY: number; startTime: number } | null = null;

  // Party state.
  private playerCol = 0;
  private playerRow = 0;
  private currentZone = '';
  private partyMemberUsernames: string[] = [];
  private lastOtherPlayers: OtherPlayerState[] = [];
  /** Players outside the viewer's party, per "col,row" in the current zone. */
  private othersByTile = new Map<string, TileOccupancy>();
  private currentBattleVisual: BattleVisual = 'none';

  // Room-action markers on explored rooms, keyed by "col,row".
  private roomActions = new Map<string, RoomAction[]>();
  private readyQuests: ReadonlySet<string> = new Set();
  private readyQuestKey = '';
  private home: RoomHome | undefined;
  private markersDirty = true;

  // Party rendering. Movement is animated by a CSS transition on the
  // `.wm-marker--party` element (`left`/`top`); we just push the target.
  private partyRendered = false;
  private partyTargetCol = 0;
  private partyTargetRow = 0;

  // Server-provided path (col,row pairs).
  private serverPath: { col: number; row: number }[] = [];

  // Hover state.
  private hoverCol: number | null = null;
  private hoverRow: number | null = null;
  private mousePixelX = 0;
  private mousePixelY = 0;

  // Drag state.
  private pointerActive = false;
  private isDragging = false;
  private dragStartClientX = 0;
  private dragStartClientY = 0;
  private dragStartCamX = 0;
  private dragStartCamY = 0;
  private dragDistance = 0;

  // Pinch zoom state.
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;
  private pinchStartCenterX = 0;
  private pinchStartCenterY = 0;
  private pinchStartCamX = 0;
  private pinchStartCamY = 0;
  private isPinching = false;
  private lastTouch: { x: number; y: number } | null = null;

  // External callbacks.
  private sendMoveFn?: (col: number, row: number) => void;
  private onTileClickFn?: (info: TileClickInfo) => void;

  // Lifecycle.
  private destroyed = false;
  private isFirstState = true;
  private hasInitializedView = false;
  private resizeObserver?: ResizeObserver;
  private resizeHandler: () => void;

  // Render-on-demand bookkeeping.
  /** True while we have a pending RAF render queued. Coalesces multiple
   *  state pushes into one re-render. */
  private renderQueued = false;
  /** RAF id for the active animation loop (spring-back). When null, we're
   *  in pure render-on-demand mode. */
  private animRafId: number | null = null;

  constructor(container: HTMLElement, worldCache: WorldCache) {
    this.container = container;
    this.worldCache = worldCache;

    // ── DOM scaffolding ──────────────────────────────────────
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wm-canvas';
    this.container.appendChild(this.canvas);

    this.overlay = document.createElement('div');
    this.overlay.className = 'wm-overlay';
    this.container.appendChild(this.overlay);

    // Layer order (bottom → top): hover hex, path preview, other parties,
    // the player's own party marker — so your portrait always wins an overlap.

    // Hover highlight — an SVG hex outline. Stroke color flips between
    // gold/red via the data-traversable attribute (see CSS).
    this.hoverEl = document.createElement('div');
    this.hoverEl.className = 'wm-hover';
    this.hoverEl.innerHTML =
      `<svg viewBox="-40 -35 80 70" width="80" height="70" preserveAspectRatio="xMidYMid meet">
        <polygon class="wm-hover__shadow" points="40,0 20,34.64 -20,34.64 -40,0 -20,-34.64 20,-34.64" />
        <polygon class="wm-hover__edge" points="40,0 20,34.64 -20,34.64 -40,0 -20,-34.64 20,-34.64" />
      </svg>`;
    this.hoverEl.style.display = 'none';
    this.overlay.appendChild(this.hoverEl);

    this.pathEl = document.createElement('div');
    this.pathEl.className = 'wm-path';
    this.overlay.appendChild(this.pathEl);

    this.markersEl = document.createElement('div');
    this.markersEl.className = 'three-map-markers';
    this.overlay.appendChild(this.markersEl);

    this.flagsEl = document.createElement('div');
    this.flagsEl.className = 'wm-others';
    this.overlay.appendChild(this.flagsEl);

    // Party marker: the player's class portrait in a gold octagon frame with
    // a level pip, outlined name above, and a "+N" pip when other players
    // share the room. The outer element carries the world position (and the
    // CSS move tween); the body counter-scales to a fixed on-screen size.
    this.partyEl = document.createElement('div');
    this.partyEl.className = 'wm-marker wm-marker--party';
    this.partyEl.innerHTML = `
      <div class="wm-marker__body">
        <span class="wm-marker__name"></span>
        <span class="wm-marker__frame">
          <span class="wm-marker__initial" aria-hidden="true"></span>
          <img class="wm-marker__img" alt="" />
        </span>
        <span class="wm-marker__level" hidden></span>
        <span class="wm-marker__count" hidden></span>
        <span class="wm-marker__key" title="A party is in the dungeon">${KEY_SVG}</span>
        <span class="wm-marker__fight" aria-hidden="true"></span>
      </div>`;
    this.partyBodyEl = this.partyEl.querySelector('.wm-marker__body') as HTMLElement;
    this.partyNameEl = this.partyEl.querySelector('.wm-marker__name') as HTMLElement;
    this.partyInitialEl = this.partyEl.querySelector('.wm-marker__initial') as HTMLElement;
    this.partyImgEl = this.partyEl.querySelector('.wm-marker__img') as HTMLImageElement;
    this.partyLevelEl = this.partyEl.querySelector('.wm-marker__level') as HTMLElement;
    this.partyCountEl = this.partyEl.querySelector('.wm-marker__count') as HTMLElement;
    // Missing class art: hide the img so the initial on the frame shows.
    this.partyImgEl.addEventListener('error', () => { this.partyImgEl.style.visibility = 'hidden'; });
    this.partyImgEl.addEventListener('load', () => { this.partyImgEl.style.visibility = ''; });
    this.partyEl.style.display = 'none';
    this.overlay.appendChild(this.partyEl);

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'wm-tooltip';
    this.tooltipEl.innerHTML = '<span class="wm-tooltip__zone"></span><span class="wm-tooltip__room"></span><ul class="wm-tooltip__actions"></ul>';
    this.tooltipZoneEl = this.tooltipEl.querySelector('.wm-tooltip__zone') as HTMLElement;
    this.tooltipRoomEl = this.tooltipEl.querySelector('.wm-tooltip__room') as HTMLElement;
    this.tooltipActionsEl = this.tooltipEl.querySelector('.wm-tooltip__actions') as HTMLElement;
    this.tooltipEl.style.display = 'none';
    this.container.appendChild(this.tooltipEl);

    // ── three.js setup ───────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      premultipliedAlpha: true,
    });
    this.renderer.setClearColor(new THREE.Color(SEA_FALLBACK_COLOR), 1);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);

    this.scene = new THREE.Scene();

    // OrthographicCamera frustum spans the canvas CSS pixels; we resize
    // it on every layout pass so screen-pixel math (pan/zoom, hit-test)
    // stays consistent with the DOM overlay.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.z = 100;

    // Materials are persistent; their textures are swapped in as the
    // various bakes complete.
    this.parchmentMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(SEA_FALLBACK_COLOR),
      depthWrite: false,
      transparent: false,
    });
    this.terrain = new ChunkedMapLayer(this.scene, {
      getArt: (tile) => this.getTileArt(tile),
      onBaked: () => this.requestRender(),
    });

    // ── Grid + content ───────────────────────────────────────
    this.grid = this.buildGridFromCache();
    this.loadParchment(this.worldCache.getCurrentMapId());
    this.attachInput();

    this.resizeHandler = () => this.handleResize();
    window.addEventListener('resize', this.resizeHandler);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.container);
    }
    this.handleResize();
  }

  // ─── Public API ─────────────────────────────────────────────

  setSendMove(fn: (col: number, row: number) => void): void {
    this.sendMoveFn = fn;
  }

  setOnTileClick(fn: (info: TileClickInfo) => void): void {
    this.onTileClickFn = fn;
  }

  adjustZoom(delta: number): void {
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    const target = this.nextZoomStep(this.zoom, delta > 0 ? 1 : -1);
    this.zoomAt(target, cw / 2, ch / 2);
  }

  private nextZoomStep(current: number, direction: 1 | -1): number {
    let nearestIdx = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      const d = Math.abs(ZOOM_STEPS[i] - current);
      if (d < bestDelta) { bestDelta = d; nearestIdx = i; }
    }
    const STICKY_THRESHOLD = 0.02;
    if (bestDelta > STICKY_THRESHOLD) {
      if (direction > 0) {
        for (const z of ZOOM_STEPS) if (z > current) return z;
        return ZOOM_STEPS[ZOOM_STEPS.length - 1];
      }
      for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current) return ZOOM_STEPS[i];
      return ZOOM_STEPS[0];
    }
    const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, nearestIdx + direction));
    return ZOOM_STEPS[next];
  }

  applyServerState(state: ServerStateMessage, snap?: boolean): void {
    // A map switch (transition) jumps the camera + party sprite — never tween
    // across a discontinuity between two unrelated grids.
    const mapChanged = this.worldCache.setCurrentMap(state.currentMapId);
    const shouldSnap = snap || this.isFirstState || mapChanged;
    if (mapChanged) this.loadParchment(state.currentMapId);

    const unlockedChanged = this.worldCache.updateUnlocked(state.unlocked);
    if (unlockedChanged || shouldSnap) {
      this.grid = this.buildGridFromCache();
    }
    let terrainStale = unlockedChanged || shouldSnap;

    this.applyPartyState(state.party, shouldSnap);
    this.currentBattleVisual = state.battle.visual;

    this.playerCol = state.party.col;
    this.playerRow = state.party.row;
    const myTile = this.grid.getTile(offsetToCube({ col: state.party.col, row: state.party.row }));
    const prevZone = this.currentZone;
    this.currentZone = myTile?.zone ?? '';
    if (this.currentZone !== prevZone) terrainStale = true;
    // Only chunks touching tiles whose fog/zone-dim state changed re-bake.
    if (terrainStale) this.syncTerrain(mapChanged);

    this.partyMemberUsernames = (state.social?.party?.members ?? []).map(m => m.username);
    // Only show players on the same map as us.
    this.lastOtherPlayers = state.otherPlayers.filter(p => !p.mapId || p.mapId === state.currentMapId);
    this.othersByTile = this.groupOtherPlayers();
    this.serverPath = state.party.path ?? [];

    const home = roomHome(state.house);
    if (home?.tileId !== this.home?.tileId || home?.name !== this.home?.name) {
      this.home = home;
      this.markersDirty = true;
    }

    const ready = readyQuestIds(state.activeQuests);
    const readyKey = [...ready].sort().join(',');
    if (readyKey !== this.readyQuestKey) {
      this.readyQuestKey = readyKey;
      this.readyQuests = ready;
      this.markersDirty = true;
    }

    if (shouldSnap || mapChanged || !this.hasInitializedView) {
      this.centerOnParty();
      this.hasInitializedView = true;
    }

    this.isFirstState = false;

    // State change → update overlays + redraw.
    this.updatePartyOverlay();
    this.updatePartyIdentity(state);
    this.updatePathOverlay();
    if (this.markersDirty) this.updateMarkersOverlay();
    this.updateFlagsOverlay();
    this.updateBattleVisualClass();
    if (this.tooltipEl.style.display !== 'none') this.updateHover();
    this.requestRender();
  }

  /**
   * Open the room view for the tile the party stands on — same payload as
   * tapping that tile. Used by the map's "Room" button.
   */
  openCurrentRoom(): void {
    const tile = this.grid.getTile(offsetToCube({ col: this.playerCol, row: this.playerRow }));
    if (tile) this.emitTileClick(tile);
  }

  rebuildFromCache(): void {
    this.grid = this.buildGridFromCache();
    // World content changed (admin deploy): drop every baked chunk.
    this.syncTerrain(true);
    this.requestRender();
  }

  /** What a click on this room would report; null for rooms that can't be entered. */
  getTileInfo(col: number, row: number): TileClickInfo | null {
    const tile = this.grid.getTile(offsetToCube({ col, row }));
    if (!tile?.isTraversable) return null;

    const def = this.worldTileDefs.get(`${col},${row}`);
    const isUnlocked = this.worldCache.isUnlocked(col, row);
    const isSameZone = tile.zone === this.currentZone;
    const playersHere = isSameZone
      ? this.lastOtherPlayers
        .filter(p => p.col === col && p.row === row)
        .map(p => ({ username: p.username, className: p.className, partyId: p.partyId, dungeonName: p.dungeonName }))
      : [];

    return {
      col,
      row,
      tileType: this.worldCache.getTileTypeDef(tile.type)?.name ?? tile.type,
      zoneName: def?.zoneName ?? def?.zone ?? tile.zone,
      roomName: isUnlocked ? def?.name ?? '' : 'Unexplored Room',
      zoneId: tile.zone,
      isTraversable: tile.isTraversable,
      isUnlocked,
      isSameZone,
      isCurrentTile: col === this.playerCol && row === this.playerRow,
      playersHere,
      partyMemberUsernames: this.partyMemberUsernames,
      dungeonId: def?.dungeonId,
    };
  }

  /** Players outside the viewer's party in this room, by the same rules as the map flags. */
  countOthersAt(col: number, row: number): number {
    return this.othersByTile.get(`${col},${row}`)?.count ?? 0;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.animRafId !== null) cancelAnimationFrame(this.animRafId);
    this.animRafId = null;

    window.removeEventListener('resize', this.resizeHandler);
    this.resizeObserver?.disconnect();

    this.terrain.dispose();
    this.parchmentTexture?.dispose();
    this.parchmentMaterial.dispose();
    this.renderer.dispose();

    this.canvas.remove();
    this.overlay.remove();
    this.tooltipEl.remove();
  }

  pause(): void {
    if (this.animRafId !== null) {
      cancelAnimationFrame(this.animRafId);
      this.animRafId = null;
    }
  }

  resume(): void {
    if (!this.destroyed) {
      this.handleResize();
      this.requestRender();
    }
  }

  recenterOnPlayer(): void {
    this.centerOnParty();
  }

  // ─── Grid building ──────────────────────────────────────────

  private buildGridFromCache(): HexGrid {
    const grid = new HexGrid();
    this.worldTileDefs.clear();

    for (const tileDef of this.worldCache.getTiles()) {
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      const tileTypeDef = this.worldCache.getTileTypeDef(tileDef.type);
      const tile = new HexTile(coord, tileDef.type, tileDef.zone, tileDef.id, tileDef.requiredItemId, tileTypeDef, tileDef.entryRequirements);
      grid.addTile(tile);
      this.worldTileDefs.set(`${tileDef.col},${tileDef.row}`, tileDef);
    }
    this.markersDirty = true;

    return grid;
  }

  // ─── Camera ────────────────────────────────────────────────

  private centerOnParty(): void {
    if (!this.partyRendered) return;
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    this.camWorldX = px.x;
    this.camWorldY = px.y;
    this.springAnim = null;
    this.requestRender();
  }

  private computeInitialZoom(): number {
    const shorter = Math.min(this.canvasCssWidth(), this.canvasCssHeight());
    if (shorter <= 0) return 1;
    const hexHeight = Math.sqrt(3) * HEX_SIZE;
    const tilesAtZoom1 = shorter / hexHeight;
    if (tilesAtZoom1 >= MIN_TILES_VISIBLE) return 1;
    return Math.max(MIN_ZOOM, tilesAtZoom1 / MIN_TILES_VISIBLE);
  }

  private getMapBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      const p = tile.pixelPosition;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX: minX - HEX_SIZE, minY: minY - HEX_SIZE, maxX: maxX + HEX_SIZE, maxY: maxY + HEX_SIZE };
  }

  /**
   * Bounds for camera position (world units) such that at least one
   * tile-width of map stays visible — i.e. the user can't scroll the
   * island entirely off-screen.
   */
  private getCamBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    const b = this.getMapBounds();
    const z = this.zoom;
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    // Half the visible world width/height at current zoom.
    const halfW = cw / 2 / z;
    const halfH = ch / 2 / z;
    // Pixel margin equivalent to ~2 tiles must stay visible.
    const tilePx = HEX_SIZE * 2;
    // Cam X range: keep at least tilePx of map inside the viewport.
    const minX = b.minX + tilePx - halfW;
    const maxX = b.maxX - tilePx + halfW;
    const minY = b.minY + tilePx - halfH;
    const maxY = b.maxY - tilePx + halfH;
    return { minX, maxX, minY, maxY };
  }

  private clampCamWithOverdrag(): void {
    const b = this.getCamBounds();
    const overW = (this.canvasCssWidth() / this.zoom) * OVERDRAG_FACTOR;
    const overH = (this.canvasCssHeight() / this.zoom) * OVERDRAG_FACTOR;

    const loX = Math.min(b.minX, b.maxX) - overW;
    const hiX = Math.max(b.minX, b.maxX) + overW;
    if (this.camWorldX < loX) this.camWorldX = loX;
    else if (this.camWorldX > hiX) this.camWorldX = hiX;

    const loY = Math.min(b.minY, b.maxY) - overH;
    const hiY = Math.max(b.minY, b.maxY) + overH;
    if (this.camWorldY < loY) this.camWorldY = loY;
    else if (this.camWorldY > hiY) this.camWorldY = hiY;
  }

  private springBackIfNeeded(): void {
    const b = this.getCamBounds();
    const lo = Math.min(b.minX, b.maxX);
    const hi = Math.max(b.minX, b.maxX);
    const loY = Math.min(b.minY, b.maxY);
    const hiY = Math.max(b.minY, b.maxY);

    const clampedX = Math.max(lo, Math.min(hi, this.camWorldX));
    const clampedY = Math.max(loY, Math.min(hiY, this.camWorldY));

    if (Math.abs(clampedX - this.camWorldX) > 0.5 || Math.abs(clampedY - this.camWorldY) > 0.5) {
      this.springAnim = {
        startX: this.camWorldX,
        startY: this.camWorldY,
        targetX: clampedX,
        targetY: clampedY,
        startTime: performance.now(),
      };
      this.ensureAnimLoop();
    } else {
      this.camWorldX = clampedX;
      this.camWorldY = clampedY;
    }
  }

  private zoomAt(newZoom: number, screenCssX: number, screenCssY: number): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if (z === this.zoom) return;
    // Keep the world-point under the cursor stable.
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    const worldX = this.camWorldX + (screenCssX - cw / 2) / this.zoom;
    const worldY = this.camWorldY + (screenCssY - ch / 2) / this.zoom;
    this.zoom = z;
    this.camWorldX = worldX - (screenCssX - cw / 2) / z;
    this.camWorldY = worldY - (screenCssY - ch / 2) / z;
    this.springAnim = null;
    this.persistZoom();
    this.requestRender();
  }

  private persistZoom(): void {
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(this.zoom)); } catch { /* ignore */ }
  }

  private loadPersistedZoom(): number | null {
    try {
      const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
      if (raw === null) return null;
      const z = parseFloat(raw);
      if (!Number.isFinite(z)) return null;
      return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    } catch { return null; }
  }

  // ─── Resize ────────────────────────────────────────────────

  private canvasCssWidth(): number {
    return this.container.clientWidth;
  }

  private canvasCssHeight(): number {
    return this.container.clientHeight;
  }

  private handleResize(): void {
    const w = this.canvasCssWidth();
    const h = this.canvasCssHeight();
    if (w <= 0 || h <= 0) return;

    this.renderer.setSize(w, h, false);
    // Camera frustum spans the CSS pixel viewport (so screen-pixel math
    // matches the DOM overlay 1:1).
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();

    if (!this.hasInitializedView) {
      this.zoom = this.loadPersistedZoom() ?? this.computeInitialZoom();
    }
    if (this.partyRendered && this.hasInitializedView) {
      this.centerOnParty();
    }

    this.requestRender();
  }

  // ─── Input ─────────────────────────────────────────────────

  private attachInput(): void {
    this.canvas.addEventListener('mousedown', e => {
      this.pointerActive = true;
      this.onPointerDown(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('mousemove', e => {
      this.onPointerMove(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverCol = null;
      this.hoverRow = null;
      this.hideTooltip();
      this.updateHoverOverlay();
    });
    window.addEventListener('mousemove', e => {
      if (!this.pointerActive) return;
      this.onPointerMove(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', e => {
      if (!this.pointerActive) return;
      this.pointerActive = false;
      this.onPointerUp(e.clientX, e.clientY);
    });

    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const target = this.nextZoomStep(this.zoom, e.deltaY > 0 ? -1 : 1);
      this.zoomAt(target, cx, cy);
    }, { passive: false });

    this.canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        this.onPointerDown(t.clientX, t.clientY);
        this.lastTouch = { x: t.clientX, y: t.clientY };
      } else if (e.touches.length === 2) {
        this.beginPinch(e);
      }
    }, { passive: false });

    this.canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 2 && this.isPinching) {
        this.updatePinch(e);
      } else if (e.touches.length === 1 && this.lastTouch) {
        const t = e.touches[0];
        this.onPointerMove(t.clientX, t.clientY);
        this.lastTouch = { x: t.clientX, y: t.clientY };
      }
    }, { passive: false });

    this.canvas.addEventListener('touchend', e => {
      e.preventDefault();
      if (e.touches.length === 0) {
        if (this.lastTouch) {
          this.onPointerUp(this.lastTouch.x, this.lastTouch.y);
          this.lastTouch = null;
        }
        this.isPinching = false;
      } else if (e.touches.length === 1 && this.isPinching) {
        this.isPinching = false;
        const t = e.touches[0];
        this.lastTouch = { x: t.clientX, y: t.clientY };
        this.dragStartClientX = t.clientX;
        this.dragStartClientY = t.clientY;
        this.dragStartCamX = this.camWorldX;
        this.dragStartCamY = this.camWorldY;
        this.isDragging = true;
        this.dragDistance = 0;
      }
    });
  }

  private beginPinch(e: TouchEvent): void {
    if (e.touches.length < 2) return;
    const a = e.touches[0];
    const b = e.touches[1];
    this.pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.pinchStartZoom = this.zoom;
    const rect = this.canvas.getBoundingClientRect();
    this.pinchStartCenterX = (a.clientX + b.clientX) / 2 - rect.left;
    this.pinchStartCenterY = (a.clientY + b.clientY) / 2 - rect.top;
    this.pinchStartCamX = this.camWorldX;
    this.pinchStartCamY = this.camWorldY;
    this.isPinching = true;
    this.isDragging = false;
  }

  private updatePinch(e: TouchEvent): void {
    if (e.touches.length < 2) return;
    const a = e.touches[0];
    const b = e.touches[1];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (this.pinchStartDistance <= 0) return;
    const ratio = dist / this.pinchStartDistance;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.pinchStartZoom * ratio));
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    const worldX = this.pinchStartCamX + (this.pinchStartCenterX - cw / 2) / this.pinchStartZoom;
    const worldY = this.pinchStartCamY + (this.pinchStartCenterY - ch / 2) / this.pinchStartZoom;
    this.zoom = newZoom;
    this.camWorldX = worldX - (this.pinchStartCenterX - cw / 2) / newZoom;
    this.camWorldY = worldY - (this.pinchStartCenterY - ch / 2) / newZoom;
    this.springAnim = null;
    this.persistZoom();
    this.requestRender();
  }

  private onPointerDown(clientX: number, clientY: number): void {
    this.isDragging = true;
    this.dragStartClientX = clientX;
    this.dragStartClientY = clientY;
    this.dragStartCamX = this.camWorldX;
    this.dragStartCamY = this.camWorldY;
    this.dragDistance = 0;
    this.springAnim = null;
  }

  private onPointerMove(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mousePixelX = clientX - rect.left;
    this.mousePixelY = clientY - rect.top;

    if (this.isDragging) {
      const dxClient = clientX - this.dragStartClientX;
      const dyClient = clientY - this.dragStartClientY;
      this.dragDistance = Math.max(this.dragDistance, Math.abs(dxClient) + Math.abs(dyClient));
      // Drag moves camera in WORLD units = client delta / zoom (inverted —
      // dragging right pans the world right, which means the camera moves
      // LEFT in world coords).
      this.camWorldX = this.dragStartCamX - dxClient / this.zoom;
      this.camWorldY = this.dragStartCamY - dyClient / this.zoom;
      this.clampCamWithOverdrag();
      this.requestRender();
    } else {
      this.updateHover();
    }
  }

  private onPointerUp(clientX: number, clientY: number): void {
    const wasDragging = this.dragDistance > DRAG_THRESHOLD;
    this.isDragging = false;
    this.springBackIfNeeded();

    if (!wasDragging) {
      this.handleClick(clientX, clientY);
    }
  }

  // ─── Hover / click handlers ───────────────────────────────

  /** Convert a CSS-pixel point on the canvas to a world-coord point. */
  private screenToWorld(px: number, py: number): { x: number; y: number } {
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    return {
      x: this.camWorldX + (px - cw / 2) / this.zoom,
      y: this.camWorldY + (py - ch / 2) / this.zoom,
    };
  }

  private getTileAtScreenPx(px: number, py: number): HexTile | null {
    const w = this.screenToWorld(px, py);
    const cube = pixelToCube({ x: w.x, y: w.y });
    return this.grid.getTile(cube) ?? null;
  }

  private updateHover(): void {
    const tile = this.getTileAtScreenPx(this.mousePixelX, this.mousePixelY);
    if (!tile) {
      this.hoverCol = null;
      this.hoverRow = null;
      this.hideTooltip();
      this.updateHoverOverlay();
      return;
    }
    const off = cubeToOffset(tile.coord);
    this.hoverCol = off.col;
    this.hoverRow = off.row;
    this.showTooltip(tile);
    this.updateHoverOverlay();
  }

  private showTooltip(tile: HexTile): void {
    if (!tile.isTraversable) {
      this.hideTooltip();
      return;
    }
    const off = cubeToOffset(tile.coord);
    const def = this.worldTileDefs.get(`${off.col},${off.row}`);
    const isUnlocked = this.worldCache.isUnlocked(off.col, off.row);
    const zoneName = def?.zoneName ?? def?.zone ?? tile.zone;
    // Unexplored traversable tiles still get a tooltip — matches the room
    // popup, which labels them "{zone}: Unexplored Room".
    const roomName = isUnlocked && def?.name ? def.name : 'Unexplored Room';

    this.tooltipZoneEl.textContent = zoneName;
    this.tooltipRoomEl.textContent = roomName;
    this.tooltipEl.classList.toggle('is-unexplored', !(isUnlocked && def?.name));
    // What the room offers and how many others stand there — counts only, never names.
    const lines: string[] = [];
    if (isUnlocked) {
      for (const action of this.roomActions.get(`${off.col},${off.row}`) ?? []) {
        lines.push(`${action.icon} ${action.name}${action.detail ? ` · ${action.detail}` : ''}`);
      }
      const others = this.countOthersAt(off.col, off.row);
      if (others > 0) lines.push(`${ROOM_ICONS.players} ${others} ${others === 1 ? 'player' : 'players'} here`);
    }
    this.tooltipActionsEl.replaceChildren(...lines.map(text => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
    this.tooltipEl.style.display = 'flex';
    this.positionTooltip();
  }

  /** Keep the tooltip beside the cursor but inside the canvas. */
  private positionTooltip(): void {
    const w = this.tooltipEl.offsetWidth;
    const h = this.tooltipEl.offsetHeight;
    const right = this.mousePixelX + 16;
    const left = right + w + TOOLTIP_MARGIN > this.canvasCssWidth() ? this.mousePixelX - 16 - w : right;
    const above = this.mousePixelY - 8 - h;
    const top = above < TOOLTIP_MARGIN ? this.mousePixelY + 20 : above;
    const maxTop = this.canvasCssHeight() - h - TOOLTIP_MARGIN;
    this.tooltipEl.style.left = `${Math.max(TOOLTIP_MARGIN, left)}px`;
    this.tooltipEl.style.top = `${Math.max(TOOLTIP_MARGIN, Math.min(top, maxTop))}px`;
  }

  private hideTooltip(): void {
    this.tooltipEl.style.display = 'none';
  }

  private handleClick(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    // Markers stand above their room's center, so a tap on a portrait would
    // otherwise land on the room north of it. Resolve marker hits first.
    const tile = this.getMarkerTileAt(clientX, clientY) ?? this.getTileAtScreenPx(px, py);
    if (!tile) return;
    this.emitTileClick(tile);
  }

  /** Room whose map marker (own party first, then others) covers this client point. */
  private getMarkerTileAt(clientX: number, clientY: number): HexTile | null {
    const hit = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    };
    if (this.partyEl.style.display !== 'none') {
      const frame = this.partyBodyEl.querySelector('.wm-marker__frame');
      if (frame && hit(frame)) {
        return this.grid.getTile(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow })) ?? null;
      }
    }
    const others = Array.from(this.flagsEl.querySelectorAll<HTMLElement>('.wm-marker'));
    for (let i = others.length - 1; i >= 0; i--) {
      const frame = others[i].querySelector('.wm-marker__frame');
      if (!frame || !hit(frame)) continue;
      const col = Number(others[i].dataset.col);
      const row = Number(others[i].dataset.row);
      return this.grid.getTile(offsetToCube({ col, row })) ?? null;
    }
    return null;
  }

  private emitTileClick(tile: HexTile): void {
    if (!tile.isTraversable) return;

    const offset = cubeToOffset(tile.coord);
    const info = this.getTileInfo(offset.col, offset.row);
    if (!info) return;

    if (this.onTileClickFn) {
      this.onTileClickFn(info);
    } else {
      this.sendMoveFn?.(offset.col, offset.row);
    }
  }

  // ─── Party state / animation ──────────────────────────────

  private applyPartyState(party: ServerPartyState, snap: boolean): void {
    if (!this.partyRendered) {
      this.partyTargetCol = party.col;
      this.partyTargetRow = party.row;
      this.partyRendered = true;
      // First-ever placement should always snap — no transition from
      // (0,0). The data attribute below is read by CSS to disable the
      // transition for this one render.
      this.partyEl.dataset.snap = '1';
      return;
    }
    const posChanged = party.col !== this.partyTargetCol || party.row !== this.partyTargetRow;
    if (!posChanged) return;
    this.partyTargetCol = party.col;
    this.partyTargetRow = party.row;
    this.partyEl.dataset.snap = snap ? '1' : '0';
  }

  // ─── Render loop (on-demand) ──────────────────────────────

  /**
   * Schedule a single render for the next animation frame. Coalesces
   * multiple requests in the same frame into one render.
   */
  private requestRender(): void {
    if (this.destroyed) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (this.destroyed) return;
      this.render();
    });
  }

  /**
   * Continuous animation loop, used only while the spring-back is active.
   * Party movement uses a CSS transition on the DOM party element, so it
   * doesn't need this loop at all. Self-cancels when the spring lands.
   */
  private ensureAnimLoop(): void {
    if (this.destroyed) return;
    if (this.animRafId !== null) return;
    const tick = () => {
      if (this.destroyed) { this.animRafId = null; return; }
      if (!this.springAnim) { this.animRafId = null; return; }
      const now = performance.now();
      const t = Math.min(1, (now - this.springAnim.startTime) / SPRING_DURATION);
      const e = easeOutCubic(t);
      this.camWorldX = this.springAnim.startX + (this.springAnim.targetX - this.springAnim.startX) * e;
      this.camWorldY = this.springAnim.startY + (this.springAnim.targetY - this.springAnim.startY) * e;
      const done = t >= 1;
      if (done) this.springAnim = null;
      this.render();
      this.animRafId = done ? null : requestAnimationFrame(tick);
    };
    this.animRafId = requestAnimationFrame(tick);
  }

  /**
   * Single render pass. Re-bakes any stale textures, updates the camera +
   * scene-mesh positions, refreshes the DOM overlay transform, and tells
   * three.js to draw.
   */
  private render(): void {
    if (this.destroyed) return;
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    if (cw <= 0 || ch <= 0) return;

    this.terrain.update({
      camX: this.camWorldX,
      camY: this.camWorldY,
      zoom: this.zoom,
      viewW: cw,
      viewH: ch,
      dpr: window.devicePixelRatio || 1,
    });
    this.updateParchmentMesh();

    // Camera: world Y flipped so positive world-Y reads as "down" on
    // screen, matching the canvas pixelPosition convention.
    this.camera.position.x = this.camWorldX;
    this.camera.position.y = -this.camWorldY;
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();

    // Parchment parallax: it follows the camera at a reduced rate so it
    // reads as a deeper layer behind the map.
    if (this.parchmentMesh) {
      this.parchmentMesh.position.x = this.camWorldX * (1 - PARCHMENT_PARALLAX);
      this.parchmentMesh.position.y = -this.camWorldY * (1 - PARCHMENT_PARALLAX);
    }

    this.renderer.render(this.scene, this.camera);

    this.updateOverlayTransform();
    // The hover highlight is overlay-positioned; keep it pinned to the
    // current tile as the camera moves.
    this.updateHoverOverlay();
  }

  // ─── Mesh / texture management ────────────────────────────

  private updateParchmentMesh(): void {
    if (this.parchmentMesh) return;
    // Sized large enough to always cover the viewport at min zoom even
    // when the camera is at the map's far corner. 8000×8000 world units
    // is plenty for any practical map size.
    const geom = new THREE.PlaneGeometry(8000, 8000);
    this.parchmentMesh = new THREE.Mesh(geom, this.parchmentMaterial);
    this.parchmentMesh.position.set(0, 0, 0);
    this.scene.add(this.parchmentMesh);
  }

  private getHexSprite(url: string, img: HTMLImageElement): HTMLCanvasElement {
    const cached = this.hexSpriteCache.get(url);
    if (cached) return cached;
    const SPRITE_W = HEX_SIZE * 4;
    const SPRITE_H = Math.round(SPRITE_W * Math.sqrt(3) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = SPRITE_W;
    canvas.height = SPRITE_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.hexSpriteCache.set(url, canvas);
      return canvas;
    }
    const s = SPRITE_W / 2;
    const cx = SPRITE_W / 2;
    const cy = SPRITE_H / 2;
    const cors = getHexCorners(s);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const x = cx + cors[i].x;
      const y = cy + cors[i].y;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, 0, 0, SPRITE_W, SPRITE_H);
    this.hexSpriteCache.set(url, canvas);
    return canvas;
  }

  // ─── Terrain feed ──────────────────────────────────────────

  /**
   * Hand the painted-terrain layer the current tiles with their visual state
   * (fog, zone dimming). The layer diffs per-tile fingerprints, so only chunks
   * touching changed tiles re-bake. `reset` drops every chunk (map switch,
   * content deploy).
   */
  private syncTerrain(reset = false): void {
    const tiles: PaintTile[] = [];
    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      const offset = cubeToOffset(tile.coord);
      const zoneOpen = this.worldCache.isZoneUnlocked(tile.zone);
      let fog: FogState;
      if (!tile.isTraversable) {
        // Scenery (mountains, lakes) is revealed with its zone.
        fog = zoneOpen ? 'open' : 'fog';
      } else if (this.worldCache.isUnlocked(offset.col, offset.row)) {
        fog = 'open';
      } else {
        fog = zoneOpen ? 'haze' : 'fog';
      }
      const p = tile.pixelPosition;
      tiles.push({
        key: tile.key,
        x: p.x,
        y: p.y,
        type: tile.type,
        color: this.colorToHex(tile.color),
        zone: tile.zone,
        traversable: tile.isTraversable,
        fog,
        dimmed: !!this.currentZone && tile.zone !== this.currentZone && tile.isTraversable,
        // Index = direction, so the painter can pick the shared edge.
        neighborKeys: getNeighbors(tile.coord).map(n => (this.grid.getTile(n) ? cubeToKey(n) : '')),
        icon: this.worldCache.getTileTypeDef(tile.type)?.icon,
      });
    }
    this.terrain.setTiles(tiles, reset);
    this.requestRender();
  }

  /**
   * Uploaded art for a tile (per-room art, then per-type art), as a hex
   * sprite, or null while loading / when there is none. A late load re-bakes
   * only the chunks around the tiles that asked for it.
   */
  private getTileArt(tile: PaintTile): CanvasImageSource | null {
    const cube = this.grid.getTile(keyToCube(tile.key));
    if (!cube) return null;
    const offset = cubeToOffset(cube.coord);
    const def = this.worldTileDefs.get(`${offset.col},${offset.row}`);
    const candidates: string[] = [];
    if (def?.id) candidates.push(artworkUrl('tile', def.id));
    candidates.push(artworkUrl('tile-type', tile.type));
    for (const url of candidates) {
      const img = this.imageCache.get(url, null, () => {
        const waiters = this.artWaiters.get(url);
        this.artWaiters.delete(url);
        if (waiters) this.terrain.markTileKeysDirty(waiters);
        this.requestRender();
      });
      if (img) return this.getHexSprite(url, img);
      let w = this.artWaiters.get(url);
      if (!w) { w = new Set(); this.artWaiters.set(url, w); }
      w.add(tile.key);
    }
    return null;
  }

  // ─── DOM overlay ───────────────────────────────────────────

  /**
   * Apply a single transform on the overlay so children positioned in
   * world coords (left:Xpx, top:Ypx) appear at the right screen position.
   * Formula: translate(W/2, H/2) · scale(zoom) · translate(-camX, -camY).
   */
  private updateOverlayTransform(): void {
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    this.overlay.style.transform =
      `translate(${cw / 2}px, ${ch / 2}px) scale(${this.zoom}) translate(${-this.camWorldX}px, ${-this.camWorldY}px)`;
    // Markers are portraits, not terrain: counter-scale them so they keep a
    // fixed, readable on-screen size (and their name text stays ≥13px) at
    // every zoom. Only written when the zoom actually changes.
    if (this.zoom !== this.markerZoom) {
      this.markerZoom = this.zoom;
      this.overlay.style.setProperty('--wm-marker-scale', String(1 / this.zoom));
    }
  }

  private updatePartyOverlay(): void {
    if (!this.partyRendered) {
      this.partyEl.style.display = 'none';
      return;
    }
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    this.partyEl.style.display = '';
    this.partyEl.style.left = `${px.x}px`;
    this.partyEl.style.top = `${px.y}px`;
    // Allow the snap-to-position render to land, then re-enable the
    // transition so the next move tweens. Reset on the following frame.
    if (this.partyEl.dataset.snap === '1') {
      requestAnimationFrame(() => { this.partyEl.dataset.snap = '0'; });
    }
  }

  /** Name, level pip, and class portrait on the party marker. */
  private updatePartyIdentity(state: ServerStateMessage): void {
    const name = state.username ?? '';
    if (this.partyNameEl.textContent !== name) {
      this.partyNameEl.textContent = name;
      this.partyInitialEl.textContent = name.charAt(0).toUpperCase();
    }
    const level = state.character?.level;
    this.partyLevelEl.hidden = level === undefined;
    if (level !== undefined) this.partyLevelEl.textContent = String(level);

    const className = state.character?.className ?? '';
    if (className !== this.partyClassName) {
      this.partyClassName = className;
      if (className) {
        this.partyImgEl.style.visibility = 'hidden';
        this.partyImgEl.src = artworkUrl('class', className.toLowerCase());
      } else {
        this.partyImgEl.removeAttribute('src');
        this.partyImgEl.style.visibility = 'hidden';
      }
    }
  }

  private updateBattleVisualClass(): void {
    this.partyEl.dataset.visual = this.currentBattleVisual;
  }

  private updateHoverOverlay(): void {
    if (this.hoverCol === null || this.hoverRow === null) {
      this.hoverEl.style.display = 'none';
      return;
    }
    const tile = this.grid.getTile(offsetToCube({ col: this.hoverCol, row: this.hoverRow }));
    if (!tile) {
      this.hoverEl.style.display = 'none';
      return;
    }
    const p = tile.pixelPosition;
    this.hoverEl.style.display = '';
    this.hoverEl.style.left = `${p.x}px`;
    this.hoverEl.style.top = `${p.y}px`;
    this.hoverEl.dataset.traversable = tile.isTraversable ? '1' : '0';
  }

  private updatePathOverlay(): void {
    const html: string[] = [];
    for (let i = 0; i < this.serverPath.length; i++) {
      const step = this.serverPath[i];
      const p = cubeToPixel(offsetToCube({ col: step.col, row: step.row }));
      const isDest = i === this.serverPath.length - 1;
      const cls = isDest ? 'wm-path__dest' : 'wm-path__step';
      html.push(`<div class="${cls}" style="left:${p.x}px;top:${p.y}px"></div>`);
    }
    this.pathEl.innerHTML = html.join('');
  }

  /** Players outside the viewer's party, grouped per room in the current zone. */
  private groupOtherPlayers(): Map<string, TileOccupancy> {
    const groups = new Map<string, TileOccupancy>();
    if (!this.currentZone) return groups;
    const partySet = new Set(this.partyMemberUsernames);
    for (const other of this.lastOtherPlayers) {
      if (other.zone !== this.currentZone) continue;
      if (partySet.has(other.username)) continue;
      const key = `${other.col},${other.row}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        if (other.inDungeon) existing.inDungeon = true;
      } else {
        groups.set(key, { col: other.col, row: other.row, count: 1, inDungeon: !!other.inDungeon });
      }
    }
    return groups;
  }

  /**
   * Other parties: one marker per occupied room in the current zone — the
   * first player's class portrait in a steel frame, tinted by a per-room hue
   * so neighbouring groups read apart, with a count pip when several players
   * share the room and a key pip when they're inside the room's dungeon.
   * Other players in the party's own room surface as a "+N" pip on the
   * party marker instead.
   */
  private updateFlagsOverlay(): void {
    let ownCount = 0;
    let ownInDungeon = false;
    const html: string[] = [];

    if (this.currentZone) {
      const partySet = new Set(this.partyMemberUsernames);
      const tileGroups = new Map<string, { col: number; row: number; count: number; inDungeon: boolean; lead: OtherPlayerState }>();
      for (const other of this.lastOtherPlayers) {
        if (other.zone !== this.currentZone) continue;
        if (partySet.has(other.username)) continue;
        const key = `${other.col},${other.row}`;
        const existing = tileGroups.get(key);
        if (existing) {
          existing.count++;
          if (other.inDungeon) existing.inDungeon = true;
        } else {
          tileGroups.set(key, { col: other.col, row: other.row, count: 1, inDungeon: !!other.inDungeon, lead: other });
        }
      }

      for (const group of tileGroups.values()) {
        if (group.col === this.playerCol && group.row === this.playerRow) {
          ownCount = group.count;
          ownInDungeon = group.inDungeon;
          continue;
        }
        const p = cubeToPixel(offsetToCube({ col: group.col, row: group.row }));
        const hue = this.hashHue(`${group.col},${group.row}`);
        const lead = group.lead;
        const initial = escapeMarkerText(lead.username.charAt(0).toUpperCase());
        const img = lead.className
          ? `<img class="wm-marker__img" src="${artworkUrl('class', encodeURIComponent(lead.className.toLowerCase()))}" alt="" onerror="this.style.visibility='hidden'" />`
          : '';
        const count = group.count > 1 ? `<span class="wm-marker__count">${group.count}</span>` : '';
        // A party delving a dungeon parks at its entrance — mark the room so
        // other players can tell they're inside, not just standing around.
        const key = group.inDungeon
          ? `<span class="wm-marker__key" title="A party is in the dungeon">${KEY_SVG}</span>`
          : '';
        html.push(
          `<div class="wm-marker wm-marker--other" data-col="${group.col}" data-row="${group.row}" style="left:${p.x}px;top:${p.y}px;--wm-hue:${hue}">
            <div class="wm-marker__body">
              <span class="wm-marker__frame"><span class="wm-marker__initial" aria-hidden="true">${initial}</span>${img}</span>
              ${count}${key}
            </div>
          </div>`,
        );
      }
    }

    this.partyCountEl.hidden = ownCount === 0;
    this.partyCountEl.textContent = ownCount > 0 ? `+${ownCount}` : '';
    this.partyEl.classList.toggle('has-dungeon-party', ownInDungeon);

    // State pushes arrive every tick; rewriting identical markup would
    // recreate the portrait <img>s and flicker them.
    const next = html.join('');
    if (next !== this.lastOthersHtml) {
      this.lastOthersHtml = next;
      this.flagsEl.innerHTML = next;
    }
  }

  private updateMarkersOverlay(): void {
    this.markersDirty = false;
    this.roomActions.clear();
    const markers = document.createDocumentFragment();
    for (const [key, def] of this.worldTileDefs) {
      if (!this.worldCache.isUnlocked(def.col, def.row)) continue;
      const actions = getRoomActions(def, this.worldCache, this.readyQuests, this.home);
      if (actions.length === 0) continue;
      this.roomActions.set(key, actions);
      markers.appendChild(this.buildMarker(def.col, def.row, actions));
    }
    this.markersEl.replaceChildren(markers);
  }

  private buildMarker(col: number, row: number, actions: RoomAction[]): HTMLElement {
    const p = cubeToPixel(offsetToCube({ col, row }));
    const marker = document.createElement('div');
    marker.className = 'three-map-marker';
    marker.style.left = `${p.x}px`;
    marker.style.top = `${p.y + HEX_SIZE * 0.55}px`;

    const firstExit = actions.find(a => a.kind === 'travel');
    const icons = [...actions.filter(a => a.kind !== 'travel'), ...(firstExit ? [firstExit] : [])];
    for (const action of icons.slice(0, MAX_MARKER_ICONS)) {
      const icon = document.createElement('span');
      icon.className = action.questReady ? 'three-map-marker-icon quest-ready-pip' : 'three-map-marker-icon';
      icon.textContent = action.icon;
      marker.appendChild(icon);
    }
    if (icons.length > MAX_MARKER_ICONS) {
      const more = document.createElement('span');
      more.className = 'three-map-marker-more';
      more.textContent = `+${icons.length - MAX_MARKER_ICONS}`;
      marker.appendChild(more);
    }
    return marker;
  }

  // ─── Misc helpers ─────────────────────────────────────────

  private colorToHex(color: number): string {
    return '#' + color.toString(16).padStart(6, '0');
  }

  private hashHue(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  /**
   * Load the parchment background for `mapId` (each map can have its own,
   * uploaded in the admin Maps tab → `/parchment-artwork/{mapId}.png`).
   * Re-entrant: a no-op if that map's parchment is already loaded/loading, and
   * reloads when the party switches maps. Stale loads (map switched again
   * mid-fetch) are discarded.
   */
  private loadParchment(mapId: string): void {
    if (this.parchmentMapId === mapId) return;
    this.parchmentMapId = mapId;
    const loader = new THREE.TextureLoader();
    const url = artworkUrl('parchment', mapId);
    const onLoaded = (tex: THREE.Texture) => {
      // A later map switch already superseded this load — drop it.
      if (this.parchmentMapId !== mapId) { tex.dispose(); return; }
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      // Repeat across the large parchment plane so the texture tiles.
      tex.repeat.set(8000 / 256, 8000 / 256);
      this.parchmentTexture?.dispose();
      this.parchmentTexture = tex;
      this.parchmentMaterial.map = tex;
      // Once textured, clear the fallback solid color (otherwise it tints
      // the texture).
      this.parchmentMaterial.color.setHex(0xffffff);
      this.parchmentMaterial.needsUpdate = true;
      this.requestRender();
    };
    loader.load(url, onLoaded, undefined, () => {
      // No uploaded backdrop for this map: paint the procedural sea.
      const sea = new THREE.CanvasTexture(createSeaCanvas(256));
      onLoaded(sea);
    });
  }
}
