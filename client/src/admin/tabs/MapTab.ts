import {
  HexTile,
  cubeToKey,
  offsetToCube,
  cubeToPixel,
  pixelToCube,
  cubeToOffset,
  cubeEquals,
  getHexCorners,
  getNeighbors,
  getNeighbor,
  TILE_CONFIGS,
  HEX_SIZE,
  DEFAULT_MAP_ID,
  toRoomRequirements,
} from '@idle-party-rpg/shared';
import type {
  CubeCoord,
  TileType,
  WorldData,
  WorldTileDefinition,
  EncounterDefinition,
  MapTransitionLink,
  RoomEntryRequirements,
} from '@idle-party-rpg/shared';

import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { entryRequirementsHtml, readEntryRequirements, summarizeEntryRequirements } from '../components/EntryRequirements';
import { renderArtworkSection, wireArtworkSection } from '../components/ArtworkSection';
import { adminPaintTiles, contentRoomLookups, roomMarkerGlyphs } from '../map/mapPaint';
import type { ContentRoomLookups } from '../map/mapPaint';
import { artworkUrl } from '../../ui/assets';
import { CanvasTerrainLayer } from '../../ui/map/CanvasTerrainLayer';
import { createSeaCanvas } from '../../ui/map/terrainPainter';
import type { PaintTile } from '../../ui/map/terrainPainter';
import { TileArtCache, tileArtUrls } from '../../ui/map/tileArt';

// Maps CUBE_DIRECTIONS index → hex corner indices for the shared edge.
const DIR_TO_EDGE: [number, number][] = [
  [0, 1],
  [5, 0],
  [4, 5],
  [3, 4],
  [2, 3],
  [1, 2],
];

const SEA_FALLBACK_COLOR = '#2f86bf';
/** World units one backdrop repeat spans, matching the game's sea. */
const BACKDROP_REPEAT = 256;
const MARKER_MIN_ZOOM = 0.3;
const VIEW_MODE_KEY = 'admin-map-view';

type MapViewMode = 'painted' | 'flat';

const ROOM_ART_KINDS = [
  { kind: 'tile', label: 'Map art', hint: 'Replaces the painted room on the world map.' },
  { kind: 'room-bg', label: 'Room backdrop', hint: 'Behind the room view. Falls back to the zone backdrop.' },
  { kind: 'combat-bg', label: 'Combat backdrop', hint: 'Behind combat in this room. Falls back to the zone backdrop.' },
] as const;

function loadViewMode(): MapViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'flat' ? 'flat' : 'painted';
  } catch {
    return 'painted';
  }
}

interface AdjacentSlot {
  col: number;
  row: number;
  coord: CubeCoord;
}

export class MapTab implements Tab {
  private mapTiles: HexTile[] = [];
  private worldTileDefs = new Map<string, WorldTileDefinition>();
  /** Room by cube key, for the painter's art lookup. */
  private defsByCubeKey = new Map<string, WorldTileDefinition>();
  private adjacentSlots: AdjacentSlot[] = [];

  private viewMode: MapViewMode = loadViewMode();
  private terrain: CanvasTerrainLayer | null = null;
  private terrainMapId: string | null = null;
  private paintTiles: PaintTile[] = [];
  private lookups: ContentRoomLookups | null = null;
  private tileArt = new TileArtCache(keys => {
    this.terrain?.markTileKeysDirty(keys);
    this.requestDraw();
  });
  /** Freshly uploaded map art by room id, so the map shows it without a reload. */
  private artOverrides = new Map<string, string>();
  private backdrop: { mapId: string; pattern: CanvasPattern | null } | null = null;
  private hoverKey: string | null = null;
  private drawRaf: number | null = null;
  private drawCtx: AdminContext | null = null;

  private mapCanvas: HTMLCanvasElement | null = null;
  private mapCtx: CanvasRenderingContext2D | null = null;
  private mapOffset = { x: 0, y: 0 };
  private mapZoom = 1.0;
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private dragOffsetStart = { x: 0, y: 0 };
  private mapInitialized = false;
  private hasDragged = false;

  private resizeHandler: (() => void) | null = null;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private mouseUpHandler: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  private selectedTile: WorldTileDefinition | null = null;
  /** Which map the editor is currently showing. */
  private selectedMapId: string = DEFAULT_MAP_ID;
  /** When set, the next room click links it as `sourceTile`'s transition target. */
  private pickTransition: { sourceTile: WorldTileDefinition } | null = null;

  cleanup(): void {
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    if (this.mouseMoveHandler) window.removeEventListener('mousemove', this.mouseMoveHandler);
    if (this.mouseUpHandler) window.removeEventListener('mouseup', this.mouseUpHandler);
    if (this.keydownHandler) window.removeEventListener('keydown', this.keydownHandler);
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    if (this.drawRaf !== null) cancelAnimationFrame(this.drawRaf);
    this.resizeHandler = this.mouseMoveHandler = this.mouseUpHandler = this.keydownHandler = null;
    this.saveTimeout = null;
    this.drawRaf = null;
    this.terrain?.dispose();
    this.terrain = null;
    this.terrainMapId = null;
    this.backdrop = null;
    this.hoverKey = null;
    this.mapCanvas = null;
    this.mapCtx = null;
    this.mapInitialized = false;
    this.selectedTile = null;
  }

  render(container: HTMLElement, ctx: AdminContext): void {
    this.rebuildMapData(ctx);
    const content = ctx.getDisplayContent();
    const maps = content?.world.maps ?? [];
    const mapOptions = maps.map(m =>
      `<option value="${escapeHtml(m.id)}"${m.id === this.selectedMapId ? ' selected' : ''}>${escapeHtml(m.name)}</option>`
    ).join('');
    container.innerHTML = `
      <div class="admin-page admin-page-map">
        <div class="admin-map-layout">
          <div class="admin-map-canvas-area">
            <div class="admin-map-controls">
              <select id="map-selector" class="admin-select admin-select-sm" title="Switch map">${mapOptions}</select>
              <span id="map-tile-count" class="admin-map-tile-count">${this.mapTiles.length} rooms</span>
              <button class="admin-btn admin-btn-sm" id="map-zoom-in">+</button>
              <button class="admin-btn admin-btn-sm" id="map-zoom-out">−</button>
              <button class="admin-btn admin-btn-sm" id="map-reset">Reset</button>
              <button class="admin-btn admin-btn-sm" id="map-view-toggle" title="Painted shows the map as players see it; flat shows plain room-type colors">${this.viewMode === 'painted' ? 'View: Painted' : 'View: Flat'}</button>
              <span id="map-hover-info" class="admin-map-info"></span>
            </div>
            <div id="map-pick-banner" class="admin-map-pick-banner" style="display:none"></div>
            <canvas id="admin-map-canvas"></canvas>
          </div>
          <div class="admin-map-sidebar" id="admin-map-sidebar"></div>
        </div>
      </div>
    `;
    this.initMapCanvas(ctx);
    this.renderSidebar(ctx);
    this.updatePickBanner();
  }

  private rebuildMapData(ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;
    // Default to the world's spawn map; fall back if the selected map was deleted.
    const maps = content.world.maps ?? [];
    if (!maps.some(m => m.id === this.selectedMapId)) {
      this.selectedMapId = content.world.defaultMapId ?? maps[0]?.id ?? DEFAULT_MAP_ID;
    }
    this.worldTileDefs.clear();
    this.defsByCubeKey.clear();
    const tiles: HexTile[] = [];
    const rooms: WorldTileDefinition[] = [];
    for (const tileDef of content.world.tiles) {
      if (tileDef.mapId !== this.selectedMapId) continue;
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      tiles.push(new HexTile(coord, tileDef.type, tileDef.zone));
      this.worldTileDefs.set(`${tileDef.col},${tileDef.row}`, tileDef);
      this.defsByCubeKey.set(cubeToKey(coord), tileDef);
      rooms.push(tileDef);
    }
    this.mapTiles = tiles;
    this.lookups = contentRoomLookups(content);
    this.paintTiles = adminPaintTiles(content, rooms, this.lookups);
    this.computeAdjacentSlots();
    this.syncTerrain();
  }

  private syncTerrain(): void {
    if (!this.terrain) return;
    this.terrain.setTiles(this.paintTiles, this.terrainMapId !== this.selectedMapId);
    this.terrainMapId = this.selectedMapId;
  }

  private getTileArt(tile: PaintTile): CanvasImageSource | null {
    const def = this.defsByCubeKey.get(tile.key);
    const urls = tileArtUrls({ id: def?.id ?? '', type: tile.type });
    const override = def?.id ? this.artOverrides.get(def.id) : undefined;
    return this.tileArt.get(override ? [override, ...urls] : urls, tile.key);
  }

  private requestDraw(): void {
    if (this.drawRaf !== null) return;
    this.drawRaf = requestAnimationFrame(() => {
      this.drawRaf = null;
      if (this.drawCtx) this.draw(this.drawCtx);
    });
  }

  private computeAdjacentSlots(): void {
    const occupied = new Set<string>();
    for (const tile of this.mapTiles) {
      const offset = cubeToOffset(tile.coord);
      occupied.add(`${offset.col},${offset.row}`);
    }
    const adjacent = new Map<string, AdjacentSlot>();
    // A brand-new (empty) map has no tiles to be adjacent to — offer a single
    // starter slot at the origin so the first room can be placed.
    if (this.mapTiles.length === 0) {
      adjacent.set('0,0', { col: 0, row: 0, coord: offsetToCube({ col: 0, row: 0 }) });
      this.adjacentSlots = Array.from(adjacent.values());
      return;
    }
    for (const tile of this.mapTiles) {
      for (const neighborCoord of getNeighbors(tile.coord)) {
        const offset = cubeToOffset(neighborCoord);
        const key = `${offset.col},${offset.row}`;
        if (!occupied.has(key) && !adjacent.has(key)) {
          adjacent.set(key, { col: offset.col, row: offset.row, coord: neighborCoord });
        }
      }
    }
    this.adjacentSlots = Array.from(adjacent.values());
  }

  private initMapCanvas(ctx: AdminContext): void {
    this.cleanup();

    this.mapCanvas = document.getElementById('admin-map-canvas') as HTMLCanvasElement;
    if (!this.mapCanvas) return;
    this.mapCtx = this.mapCanvas.getContext('2d');
    this.drawCtx = ctx;
    this.terrain = new CanvasTerrainLayer({
      getArt: tile => this.getTileArt(tile),
      onBaked: () => this.requestDraw(),
    });
    this.syncTerrain();

    const resizeCanvas = () => {
      if (!this.mapCanvas) return;
      this.mapCanvas.width = this.mapCanvas.clientWidth;
      this.mapCanvas.height = this.mapCanvas.clientHeight;
      if (!this.mapInitialized) {
        const startPixel = this.getStartTilePixel(ctx);
        this.mapOffset = {
          x: this.mapCanvas.width / 2 - startPixel.x * this.mapZoom,
          y: this.mapCanvas.height / 2 - startPixel.y * this.mapZoom,
        };
        this.mapInitialized = true;
      }
      this.draw(ctx);
    };
    this.resizeHandler = resizeCanvas;
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    this.mapCanvas.addEventListener('mousedown', e => {
      this.isDragging = true;
      this.hasDragged = false;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragOffsetStart = { ...this.mapOffset };
    });
    this.mouseMoveHandler = (e: MouseEvent) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.hasDragged = true;
      this.mapOffset = { x: this.dragOffsetStart.x + dx, y: this.dragOffsetStart.y + dy };
      this.draw(ctx);
    };
    window.addEventListener('mousemove', this.mouseMoveHandler);
    this.mouseUpHandler = () => { this.isDragging = false; };
    window.addEventListener('mouseup', this.mouseUpHandler);

    this.mapCanvas.addEventListener('click', e => {
      if (this.hasDragged) return;
      const rect = this.mapCanvas!.getBoundingClientRect();
      this.handleMapClick(ctx, e.clientX - rect.left, e.clientY - rect.top);
    });

    this.mapCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const rect = this.mapCanvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const next = Math.max(0.05, Math.min(3, this.mapZoom * delta));
      const k = next / this.mapZoom;
      this.mapOffset = { x: mx - (mx - this.mapOffset.x) * k, y: my - (my - this.mapOffset.y) * k };
      this.mapZoom = next;
      this.draw(ctx);
    });

    let lastTouch: { x: number; y: number } | null = null;
    this.mapCanvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.dragOffsetStart = { ...this.mapOffset };
      }
    });
    this.mapCanvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && lastTouch) {
        this.mapOffset = {
          x: this.dragOffsetStart.x + (e.touches[0].clientX - lastTouch.x),
          y: this.dragOffsetStart.y + (e.touches[0].clientY - lastTouch.y),
        };
        this.draw(ctx);
      }
    });
    this.mapCanvas.addEventListener('touchend', () => { lastTouch = null; });

    this.keydownHandler = (e: KeyboardEvent) => {
      if (ctx.isReadOnly()) return;
      if (e.key === 'Escape' && this.pickTransition) {
        e.preventDefault();
        this.pickTransition = null;
        this.updatePickBanner();
        this.renderSidebar(ctx);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        if (this.selectedTile) {
          e.preventDefault();
          this.deleteSelectedTile(ctx);
        }
      }
    };
    window.addEventListener('keydown', this.keydownHandler);

    document.getElementById('map-zoom-in')?.addEventListener('click', () => {
      this.mapZoom = Math.min(3, this.mapZoom * 1.3);
      this.draw(ctx);
    });
    document.getElementById('map-zoom-out')?.addEventListener('click', () => {
      this.mapZoom = Math.max(0.05, this.mapZoom * 0.7);
      this.draw(ctx);
    });
    document.getElementById('map-reset')?.addEventListener('click', () => {
      this.mapZoom = 1.0;
      const startPixel = this.getStartTilePixel(ctx);
      this.mapOffset = {
        x: this.mapCanvas!.width / 2 - startPixel.x * this.mapZoom,
        y: this.mapCanvas!.height / 2 - startPixel.y * this.mapZoom,
      };
      this.draw(ctx);
    });
    document.getElementById('map-view-toggle')?.addEventListener('click', e => {
      this.viewMode = this.viewMode === 'painted' ? 'flat' : 'painted';
      try { localStorage.setItem(VIEW_MODE_KEY, this.viewMode); } catch { /* storage blocked */ }
      (e.currentTarget as HTMLButtonElement).textContent = this.viewMode === 'painted' ? 'View: Painted' : 'View: Flat';
      this.draw(ctx);
    });
    (document.getElementById('map-selector') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
      this.switchMap(ctx, (e.target as HTMLSelectElement).value);
    });

    this.mapCanvas.addEventListener('mousemove', e => {
      if (this.isDragging) return;
      const rect = this.mapCanvas!.getBoundingClientRect();
      this.updateHoverInfo(e.clientX - rect.left, e.clientY - rect.top);
    });
    this.mapCanvas.addEventListener('mouseleave', () => {
      if (this.hoverKey === null) return;
      this.hoverKey = null;
      this.requestDraw();
    });
  }

  private getStartTilePixel(ctx: AdminContext): { x: number; y: number } {
    const content = ctx.getDisplayContent();
    if (content) {
      const meta = content.world.maps?.find(m => m.id === this.selectedMapId);
      const { col, row } = meta?.startTile ?? content.world.startTile;
      return cubeToPixel(offsetToCube({ col, row }));
    }
    return { x: 0, y: 0 };
  }

  private updateHoverInfo(mx: number, my: number): void {
    const infoEl = document.getElementById('map-hover-info');
    if (!infoEl) return;
    const zoom = this.mapZoom;
    const worldX = (mx - this.mapOffset.x) / zoom;
    const worldY = (my - this.mapOffset.y) / zoom;
    const hoveredCube = pixelToCube({ x: worldX, y: worldY });
    const hoveredOffset = cubeToOffset(hoveredCube);
    const hoverKey = `${hoveredOffset.col},${hoveredOffset.row}`;
    const tileDef = this.worldTileDefs.get(hoverKey);
    const nextHover = tileDef ? hoverKey : null;
    if (nextHover !== this.hoverKey) {
      this.hoverKey = nextHover;
      this.requestDraw();
    }
    if (tileDef) {
      infoEl.textContent = `${tileDef.name} — ${tileDef.zone} (${hoveredOffset.col}, ${hoveredOffset.row})`;
      return;
    }
    const slot = this.adjacentSlots.find(s => cubeEquals(s.coord, hoveredCube));
    if (slot) {
      infoEl.textContent = `+ New room (${slot.col}, ${slot.row})`;
    } else {
      infoEl.textContent = '';
    }
  }

  private updateMapTileCount(): void {
    const el = document.getElementById('map-tile-count');
    if (el) el.textContent = `${this.mapTiles.length} rooms`;
  }

  /** Show/hide the "click a room to link" banner while in transition-pick mode. */
  private updatePickBanner(): void {
    const banner = document.getElementById('map-pick-banner');
    if (!banner) return;
    if (this.pickTransition) {
      banner.style.display = '';
      banner.textContent = `Linking "${this.pickTransition.sourceTile.name}" — switch maps if needed, then click the destination room. (Esc to cancel)`;
    } else {
      banner.style.display = 'none';
      banner.textContent = '';
    }
  }

  /** Switch the editor to a different map (full re-render keeps the selector in sync). */
  private switchMap(ctx: AdminContext, mapId: string): void {
    if (mapId === this.selectedMapId) return;
    this.selectedMapId = mapId;
    this.selectedTile = null;
    this.mapInitialized = false; // re-center on the new map's start
    ctx.rerenderTab();
  }

  /** Finish a transition pick: link the source room to the clicked target room. */
  private async completeTransitionPick(ctx: AdminContext, target: WorldTileDefinition): Promise<void> {
    const pick = this.pickTransition;
    if (!pick) return;
    const source = pick.sourceTile;
    this.pickTransition = null;
    if (target.id === source.id) {
      this.updatePickBanner();
      this.renderSidebar(ctx);
      return; // a room can't transition to itself
    }
    if (!source.transitions) source.transitions = [];
    if (!source.transitions.some(t => t.tileId === target.id && t.mapId === this.selectedMapId)) {
      source.transitions.push({ mapId: this.selectedMapId, tileId: target.id });
    }
    try {
      const data = await putAdmin<{ world: WorldData }>(
        `/api/admin/world/tile${ctx.versionQueryParam()}`, source);
      this.applyWorldUpdate(ctx, data.world);
      // Return to the source room's map and reselect it so the link is visible.
      this.selectedMapId = source.mapId;
      this.mapInitialized = false;
      ctx.rerenderTab();
      this.selectedTile = this.worldTileDefs.get(`${source.col},${source.row}`) ?? null;
      this.draw(ctx);
      this.renderSidebar(ctx);
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  private handleMapClick(ctx: AdminContext, mx: number, my: number): void {
    const zoom = this.mapZoom;
    const worldX = (mx - this.mapOffset.x) / zoom;
    const worldY = (my - this.mapOffset.y) / zoom;
    const clickedCube = pixelToCube({ x: worldX, y: worldY });
    const clickedOffset = cubeToOffset(clickedCube);
    const clickedKey = `${clickedOffset.col},${clickedOffset.row}`;

    const tileDef = this.worldTileDefs.get(clickedKey);

    // Transition pick mode: the next room click becomes the source tile's target.
    if (this.pickTransition && tileDef) {
      this.completeTransitionPick(ctx, tileDef);
      return;
    }

    if (tileDef) {
      this.selectedTile = tileDef;
      this.draw(ctx);
      this.renderSidebar(ctx);
      return;
    }
    if (!ctx.isReadOnly()) {
      const slot = this.adjacentSlots.find(s => cubeEquals(s.coord, clickedCube));
      if (slot) {
        this.addTileAtSlot(ctx, slot);
        return;
      }
    }
    this.selectedTile = null;
    this.draw(ctx);
    this.renderSidebar(ctx);
  }

  // ---- Drawing ----

  private draw(ctx: AdminContext): void {
    const c = this.mapCtx;
    const canvas = this.mapCanvas;
    if (!c || !canvas) return;

    const content = ctx.getDisplayContent();
    const corners = getHexCorners(HEX_SIZE);
    const zoom = this.mapZoom;
    const ox = this.mapOffset.x;
    const oy = this.mapOffset.y;
    const painted = this.viewMode === 'painted';

    this.drawBackground(c, canvas, painted);
    if (painted) {
      this.terrain?.draw(c, { offsetX: ox, offsetY: oy, zoom, width: canvas.width, height: canvas.height });
    }

    const zoneMap = new Map<string, string>();
    for (const tile of this.mapTiles) {
      const off = cubeToOffset(tile.coord);
      zoneMap.set(`${off.col},${off.row}`, tile.zone);
    }
    const selectedZone = this.selectedTile
      ? zoneMap.get(`${this.selectedTile.col},${this.selectedTile.row}`) ?? null
      : null;

    const otherTiles: HexTile[] = [];
    const zoneTiles: HexTile[] = [];
    let selectedHexTile: HexTile | null = null;
    for (const tile of this.mapTiles) {
      const off = cubeToOffset(tile.coord);
      const isSelected = this.selectedTile && this.selectedTile.col === off.col && this.selectedTile.row === off.row;
      if (isSelected) selectedHexTile = tile;
      else if (selectedZone && tile.zone === selectedZone) zoneTiles.push(tile);
      else otherTiles.push(tile);
    }

    const showSlots = !ctx.isReadOnly();
    for (const slot of (showSlots ? this.adjacentSlots : [])) {
      const pixel = cubeToPixel(slot.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;
      if (!this.inBounds(sx, sy, canvas, zoom)) continue;
      this.drawHex(c, corners, sx, sy, zoom);
      c.fillStyle = painted ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
      c.fill();
      c.strokeStyle = painted ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
      c.lineWidth = 1;
      c.setLineDash([4, 4]);
      c.stroke();
      c.setLineDash([]);
      const plusSize = 14 * zoom;
      c.strokeStyle = painted ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.35)';
      c.lineWidth = Math.max(1.5, 3 * zoom);
      c.beginPath();
      c.moveTo(sx - plusSize, sy); c.lineTo(sx + plusSize, sy);
      c.moveTo(sx, sy - plusSize); c.lineTo(sx, sy + plusSize);
      c.stroke();
    }

    if (painted) {
      if (selectedZone) {
        c.beginPath();
        for (const tile of otherTiles) {
          const pixel = cubeToPixel(tile.coord);
          const sx = pixel.x * zoom + ox;
          const sy = pixel.y * zoom + oy;
          if (!this.inBounds(sx, sy, canvas, zoom)) continue;
          this.addHex(c, corners, sx, sy, zoom);
        }
        c.fillStyle = 'rgba(14,16,28,0.38)';
        c.fill();
        this.drawZoneGlow(c, canvas, selectedHexTile ? [...zoneTiles, selectedHexTile] : zoneTiles, selectedZone, zoneMap, corners, 0.6);
      }
    } else {
      for (const tile of otherTiles) this.drawFlatTile(c, tile, corners, ox, oy, zoom, content);
      if (selectedZone) {
        this.drawZoneGlow(c, canvas, selectedHexTile ? [...zoneTiles, selectedHexTile] : zoneTiles, selectedZone, zoneMap, corners, 1);
      }
      for (const tile of zoneTiles) this.drawFlatTile(c, tile, corners, ox, oy, zoom, content);
      this.drawFlatZoneBorders(c, canvas, zoneMap, corners);
    }

    if (this.hoverKey && this.hoverKey !== (selectedHexTile ? this.tileKey(selectedHexTile) : null)) {
      const def = this.worldTileDefs.get(this.hoverKey);
      if (def) {
        const pixel = cubeToPixel(offsetToCube({ col: def.col, row: def.row }));
        this.drawHex(c, corners, pixel.x * zoom + ox, pixel.y * zoom + oy, zoom);
        c.strokeStyle = 'rgba(255,255,255,0.7)';
        c.lineWidth = Math.max(1.5, 2 * zoom);
        c.stroke();
      }
    }

    if (selectedHexTile) {
      const pixel = cubeToPixel(selectedHexTile.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;
      if (painted) this.drawPaintedSelection(c, corners, sx, sy, zoom);
      else this.drawFlatSelection(c, selectedHexTile, corners, sx, sy, zoom, zoneMap, content);
    }

    this.drawMarkers(c, canvas, content, painted);
  }

  private drawBackground(c: CanvasRenderingContext2D, canvas: HTMLCanvasElement, painted: boolean): void {
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (!painted) {
      c.fillStyle = '#1a1d23';
      c.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    c.fillStyle = SEA_FALLBACK_COLOR;
    c.fillRect(0, 0, canvas.width, canvas.height);
    const pattern = this.backdropPattern(c);
    if (!pattern) return;
    const zoom = this.mapZoom;
    c.save();
    c.setTransform(zoom, 0, 0, zoom, this.mapOffset.x, this.mapOffset.y);
    c.fillStyle = pattern;
    c.fillRect(-this.mapOffset.x / zoom, -this.mapOffset.y / zoom, canvas.width / zoom, canvas.height / zoom);
    c.restore();
  }

  /** The map's uploaded parchment, else the game's painted sea; one repeat spans BACKDROP_REPEAT world units. */
  private backdropPattern(c: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.backdrop?.mapId === this.selectedMapId) return this.backdrop.pattern;
    const mapId = this.selectedMapId;
    const sea = createSeaCanvas(BACKDROP_REPEAT);
    this.backdrop = { mapId, pattern: c.createPattern(sea, 'repeat') };
    const img = new Image();
    img.onload = () => {
      if (this.backdrop?.mapId !== mapId || !this.mapCtx) return;
      const pattern = this.mapCtx.createPattern(img, 'repeat');
      if (pattern && typeof DOMMatrix !== 'undefined') {
        pattern.setTransform(new DOMMatrix().scale(BACKDROP_REPEAT / img.width, BACKDROP_REPEAT / img.height));
      }
      this.backdrop = { mapId, pattern };
      this.requestDraw();
    };
    img.src = artworkUrl('parchment', mapId);
    return this.backdrop.pattern;
  }

  private drawZoneGlow(
    c: CanvasRenderingContext2D, canvas: HTMLCanvasElement, tiles: HexTile[], zone: string,
    zoneMap: Map<string, string>, corners: { x: number; y: number }[], strength: number,
  ): void {
    const zoom = this.mapZoom;
    const edges: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const tile of tiles) {
      const pixel = cubeToPixel(tile.coord);
      const sx = pixel.x * zoom + this.mapOffset.x;
      const sy = pixel.y * zoom + this.mapOffset.y;
      if (!this.inBounds(sx, sy, canvas, zoom, 4)) continue;
      for (let dir = 0; dir < 6; dir++) {
        const nOff = cubeToOffset(getNeighbor(tile.coord, dir));
        if (zoneMap.get(`${nOff.col},${nOff.row}`) === zone) continue;
        const [ei0, ei1] = DIR_TO_EDGE[dir];
        edges.push({
          x0: sx + corners[ei0].x * zoom, y0: sy + corners[ei0].y * zoom,
          x1: sx + corners[ei1].x * zoom, y1: sy + corners[ei1].y * zoom,
        });
      }
    }
    c.save();
    c.lineCap = 'round';
    const passes = [
      { width: Math.max(20, 40 * zoom), alpha: 0.04 },
      { width: Math.max(14, 28 * zoom), alpha: 0.08 },
      { width: Math.max(8, 16 * zoom), alpha: 0.15 },
      { width: Math.max(4, 8 * zoom), alpha: 0.25 },
      { width: Math.max(2, 4 * zoom), alpha: 0.4 },
    ];
    for (const pass of passes) {
      c.strokeStyle = `rgba(255,255,255,${pass.alpha * strength})`;
      c.lineWidth = pass.width;
      c.beginPath();
      for (const e of edges) { c.moveTo(e.x0, e.y0); c.lineTo(e.x1, e.y1); }
      c.stroke();
    }
    c.restore();
  }

  private drawFlatZoneBorders(
    c: CanvasRenderingContext2D, canvas: HTMLCanvasElement, zoneMap: Map<string, string>, corners: { x: number; y: number }[],
  ): void {
    const zoom = this.mapZoom;
    c.save();
    c.strokeStyle = '#ffc845';
    c.lineWidth = Math.max(1.5, 2.5 * zoom);
    c.lineCap = 'round';
    for (const tile of this.mapTiles) {
      const pixel = cubeToPixel(tile.coord);
      const sx = pixel.x * zoom + this.mapOffset.x;
      const sy = pixel.y * zoom + this.mapOffset.y;
      if (!this.inBounds(sx, sy, canvas, zoom, 3)) continue;
      for (let dir = 0; dir < 6; dir++) {
        const nOff = cubeToOffset(getNeighbor(tile.coord, dir));
        const nZone = zoneMap.get(`${nOff.col},${nOff.row}`);
        if (nZone === undefined || nZone === tile.zone) continue;
        const [ei0, ei1] = DIR_TO_EDGE[dir];
        c.beginPath();
        c.moveTo(sx + corners[ei0].x * zoom, sy + corners[ei0].y * zoom);
        c.lineTo(sx + corners[ei1].x * zoom, sy + corners[ei1].y * zoom);
        c.stroke();
      }
    }
    c.restore();
  }

  private drawPaintedSelection(
    c: CanvasRenderingContext2D, corners: { x: number; y: number }[], sx: number, sy: number, zoom: number,
  ): void {
    c.save();
    this.drawHex(c, corners, sx, sy, zoom);
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = Math.max(4, 8 * zoom);
    c.strokeStyle = '#ffffff';
    c.lineWidth = Math.max(2, 3.5 * zoom);
    c.stroke();
    c.shadowBlur = 0;
    c.strokeStyle = '#ffc845';
    c.lineWidth = Math.max(1, 1.5 * zoom);
    c.stroke();
    c.restore();
  }

  private drawFlatSelection(
    c: CanvasRenderingContext2D, tile: HexTile, corners: { x: number; y: number }[],
    sx: number, sy: number, zoom: number, zoneMap: Map<string, string>,
    content: ReturnType<AdminContext['getDisplayContent']>,
  ): void {
    const scale = 1.08;
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = Math.max(4, 8 * zoom);
    c.shadowOffsetY = Math.max(1, 3 * zoom);
    this.drawHex(c, corners, sx, sy, zoom, scale);
    c.fillStyle = this.flatColor(tile, content);
    c.fill();
    c.restore();
    this.drawHex(c, corners, sx, sy, zoom, scale);
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.lineWidth = Math.max(1, 1.5 * zoom);
    c.stroke();
    c.strokeStyle = '#ffc845';
    c.lineWidth = Math.max(2, 3 * zoom);
    c.lineCap = 'round';
    for (let dir = 0; dir < 6; dir++) {
      const nOff = cubeToOffset(getNeighbor(tile.coord, dir));
      const nZone = zoneMap.get(`${nOff.col},${nOff.row}`);
      if (nZone === undefined || nZone === tile.zone) continue;
      const [ei0, ei1] = DIR_TO_EDGE[dir];
      c.beginPath();
      c.moveTo(sx + corners[ei0].x * zoom * scale, sy + corners[ei0].y * zoom * scale);
      c.lineTo(sx + corners[ei1].x * zoom * scale, sy + corners[ei1].y * zoom * scale);
      c.stroke();
    }
    this.drawNonTraversableMarker(c, tile, sx, sy, zoom, content);
  }

  private flatColor(tile: HexTile, content: ReturnType<AdminContext['getDisplayContent']>): string {
    const tt = content?.tileTypes?.[tile.type];
    return tt
      ? tt.color
      : '#' + (TILE_CONFIGS[tile.type as TileType]?.color ?? 0x333333).toString(16).padStart(6, '0');
  }

  private drawFlatTile(
    c: CanvasRenderingContext2D, tile: HexTile, corners: { x: number; y: number }[],
    ox: number, oy: number, zoom: number,
    content: ReturnType<AdminContext['getDisplayContent']>,
  ): void {
    const canvas = this.mapCanvas!;
    const pixel = cubeToPixel(tile.coord);
    const sx = pixel.x * zoom + ox;
    const sy = pixel.y * zoom + oy;
    if (!this.inBounds(sx, sy, canvas, zoom)) return;
    this.drawHex(c, corners, sx, sy, zoom);
    c.fillStyle = this.flatColor(tile, content);
    c.fill();
    c.strokeStyle = '#2a2e36';
    c.lineWidth = 0.5;
    c.stroke();
    this.drawNonTraversableMarker(c, tile, sx, sy, zoom, content);
  }

  /** The game's room markers (same glyphs, same pill), plus the admin-only start star. */
  private drawMarkers(
    c: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
    content: ReturnType<AdminContext['getDisplayContent']>, painted: boolean,
  ): void {
    if (!content) return;
    const zoom = this.mapZoom;
    const meta = content.world.maps?.find(m => m.id === this.selectedMapId);
    const start = meta?.startTile ?? content.world.startTile;
    const lookups = this.lookups ?? contentRoomLookups(content);
    for (const def of this.worldTileDefs.values()) {
      const pixel = cubeToPixel(offsetToCube({ col: def.col, row: def.row }));
      const sx = pixel.x * zoom + this.mapOffset.x;
      const sy = pixel.y * zoom + this.mapOffset.y;
      if (!this.inBounds(sx, sy, canvas, zoom)) continue;
      if (zoom >= MARKER_MIN_ZOOM) {
        const { icons, more } = roomMarkerGlyphs(def, lookups);
        if (icons.length > 0) this.drawMarkerPill(c, sx, sy + HEX_SIZE * 0.55 * zoom, icons, more);
      }
      if (start.col === def.col && start.row === def.row) {
        c.save();
        c.font = `${Math.max(10, 16 * zoom)}px sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        if (painted) {
          c.lineWidth = 3;
          c.strokeStyle = 'rgba(0,0,0,0.6)';
          c.strokeText('★', sx, sy);
        }
        c.fillStyle = '#ffc845';
        c.fillText('★', sx, sy);
        c.restore();
      }
    }
  }

  private drawMarkerPill(c: CanvasRenderingContext2D, x: number, y: number, icons: string[], more: number): void {
    c.save();
    c.font = '15px sans-serif';
    c.textBaseline = 'middle';
    const gap = 2;
    const iconW = icons.map(i => c.measureText(i).width);
    c.font = 'bold 11px sans-serif';
    const moreText = more > 0 ? `+${more}` : '';
    const moreW = moreText ? c.measureText(moreText).width + gap : 0;
    const innerW = iconW.reduce((a, b) => a + b, 0) + gap * (icons.length - 1) + moreW;
    const w = innerW + 14;
    const h = 22;
    const left = x - w / 2;
    const top = y - h / 2;
    const grad = c.createLinearGradient(0, top, 0, top + h);
    grad.addColorStop(0, '#3a4256');
    grad.addColorStop(1, '#1d2230');
    c.shadowColor = 'rgba(0,0,0,0.55)';
    c.shadowBlur = 4;
    c.shadowOffsetY = 2;
    c.beginPath();
    c.roundRect(left, top, w, h, h / 2);
    c.fillStyle = grad;
    c.fill();
    c.shadowColor = 'transparent';
    c.lineWidth = 2;
    c.strokeStyle = '#b8862b';
    c.stroke();
    let cx = left + 7;
    c.font = '15px sans-serif';
    c.textAlign = 'left';
    icons.forEach((icon, i) => {
      c.fillText(icon, cx, y + 1);
      cx += iconW[i] + gap;
    });
    if (moreText) {
      c.font = 'bold 11px sans-serif';
      c.fillStyle = '#ffffff';
      c.fillText(moreText, cx, y + 1);
    }
    c.restore();
  }

  private drawHex(c: CanvasRenderingContext2D, corners: { x: number; y: number }[], sx: number, sy: number, zoom: number, scale = 1.0): void {
    c.beginPath();
    this.addHex(c, corners, sx, sy, zoom, scale);
  }

  private addHex(c: CanvasRenderingContext2D, corners: { x: number; y: number }[], sx: number, sy: number, zoom: number, scale = 1.0): void {
    for (let i = 0; i < corners.length; i++) {
      const cx = sx + corners[i].x * zoom * scale;
      const cy = sy + corners[i].y * zoom * scale;
      if (i === 0) c.moveTo(cx, cy); else c.lineTo(cx, cy);
    }
    c.closePath();
  }

  private inBounds(sx: number, sy: number, canvas: HTMLCanvasElement, zoom: number, pad = 2): boolean {
    const margin = HEX_SIZE * zoom * pad;
    return sx > -margin && sx < canvas.width + margin && sy > -margin && sy < canvas.height + margin;
  }

  private drawNonTraversableMarker(
    c: CanvasRenderingContext2D, tile: HexTile, sx: number, sy: number, zoom: number,
    content: ReturnType<AdminContext['getDisplayContent']>,
  ): void {
    const tt = content?.tileTypes?.[tile.type];
    const isTraversable = tt ? tt.traversable : (TILE_CONFIGS[tile.type as TileType]?.traversable ?? true);
    if (isTraversable) return;
    const size = Math.max(5, 10 * zoom);
    c.save();
    c.strokeStyle = 'rgba(255,60,60,0.7)';
    c.lineWidth = Math.max(1.5, 2.5 * zoom);
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(sx - size, sy - size); c.lineTo(sx + size, sy + size);
    c.moveTo(sx + size, sy - size); c.lineTo(sx - size, sy + size);
    c.stroke();
    c.restore();
  }

  private tileKey(tile: HexTile): string {
    const off = cubeToOffset(tile.coord);
    return `${off.col},${off.row}`;
  }

  // ---- Sidebar ----

  private renderSidebar(ctx: AdminContext): void {
    const sidebar = document.getElementById('admin-map-sidebar');
    if (!sidebar) return;
    const readOnly = ctx.isReadOnly();
    const tile = this.selectedTile;

    if (!tile) {
      const hint = readOnly
        ? 'Click a room to view details. This version is read-only.'
        : 'Click a room to edit, or click + to add a new room.';
      sidebar.innerHTML = `
        <div class="admin-map-sidebar-header">Room Editor</div>
        <div class="admin-map-sidebar-placeholder">${hint}</div>
      `;
      return;
    }

    this.renderSidebarEditor(sidebar, ctx, tile);
  }

  private renderSidebarEditor(sidebar: HTMLElement, ctx: AdminContext, tile: WorldTileDefinition): void {
    const content = ctx.getDisplayContent();
    const zones = content ? Object.values(content.zones) : [];
    const mapMeta = content?.world.maps?.find(m => m.id === this.selectedMapId);
    const startTile = mapMeta?.startTile ?? content?.world.startTile;
    const isStart = !!startTile && startTile.col === tile.col && startTile.row === tile.row;
    const tileTypeDefs = content ? Object.values(content.tileTypes ?? {}) : [];
    const tileTypeDef = content?.tileTypes?.[tile.type];
    const isTraversable = tileTypeDef ? tileTypeDef.traversable : (TILE_CONFIGS[tile.type as TileType]?.traversable ?? false);
    const readOnly = ctx.isReadOnly();
    const disabled = readOnly ? ' disabled' : '';

    const typeOptions = tileTypeDefs
      .filter(t => t.id !== 'void')
      .map(t => {
        const prefix = !t.traversable ? '(X) ' : '';
        return `<option value="${t.id}"${t.id === tile.type ? ' selected' : ''}>${prefix}${escapeHtml(t.name)}</option>`;
      }).join('');
    const zoneOptions = zones.map(z =>
      `<option value="${z.id}"${z.id === tile.zone ? ' selected' : ''}>${escapeHtml(z.displayName)}</option>`
    ).join('');
    const shops = content ? Object.values(content.shops ?? {}) : [];
    const shopOptions = `<option value="">(none)</option>` + shops.map(s =>
      `<option value="${s.id}"${s.id === (tile.shopId ?? '') ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
    ).join('');
    const npcs = content ? Object.values(content.npcs ?? {}) : [];
    const npcOptions = `<option value="">(none)</option>` + npcs.map(n =>
      `<option value="${n.id}"${n.id === (tile.npcId ?? '') ? ' selected' : ''}>${escapeHtml(`${n.emoji} ${n.name}`)}</option>`
    ).join('');
    const dungeons = content ? Object.values(content.dungeons ?? {}) : [];
    const dungeonOptions = `<option value="">(none)</option>` + dungeons.map(d =>
      `<option value="${d.id}"${d.id === (tile.dungeonId ?? '') ? ' selected' : ''}>${escapeHtml(d.name)}</option>`
    ).join('');

    // Map transitions — a room may link to several rooms on other maps.
    const links = tile.transitions ?? [];
    const itemName = (id: string): string => content?.items?.[id]?.name ?? id;
    const questName = (id: string): string => content?.quests?.[id]?.name ?? id;
    const linkRow = (link: MapTransitionLink, idx: number): string => {
      const destTile = content?.world.tiles.find(t => t.id === link.tileId);
      const destMap = content?.world.maps?.find(m => m.id === link.mapId);
      // Per-transition gates are authored via MCP; surface them here so an
      // admin can at least see one exists.
      const gate = summarizeEntryRequirements(link.entryRequirements, itemName, questName);
      const gateLabel = gate ? ` <span class="admin-form-hint" title="Gate on this exit">🔒 ${escapeHtml(gate)}</span>` : '';
      const label = `→ ${escapeHtml(destMap?.name ?? link.mapId)}: ${escapeHtml(destTile?.name ?? '(missing room)')}${gateLabel}`;
      return readOnly
        ? `<div class="admin-form-hint">${label}</div>`
        : `<div class="admin-map-transition-row"><span class="admin-form-hint">${label}</span><button class="admin-btn admin-btn-sm" data-remove-transition="${idx}" type="button">Remove</button></div>`;
    };
    const linksHtml = links.length
      ? links.map(linkRow).join('')
      : `<div class="admin-form-hint">No transitions. Link this room to rooms on other maps.</div>`;
    const addTransitionBtn = `<button class="admin-btn admin-btn-sm" id="sidebar-link-transition" type="button"${readOnly ? ' disabled title="Switch to a draft version to edit"' : ''}>${this.pickTransition ? 'Cancel linking…' : '+ Add transition'}</button>`;
    const transitionSectionHtml = `<div class="admin-map-transition">
          <div class="admin-form-label-text">Map Transitions</div>
          ${linksHtml}
          ${addTransitionBtn}
        </div>`;

    const artHtml = `<fieldset class="admin-form-fieldset admin-map-art"${readOnly ? ' disabled' : ''}>
          <legend>Artwork</legend>
          ${ROOM_ART_KINDS.map(a => `<div class="admin-map-art-kind" data-room-art="${a.kind}">
            <div class="admin-form-label-text">${a.label}</div>
            <div class="admin-form-hint">${a.hint}</div>
            ${renderArtworkSection({ kind: a.kind, id: tile.id, idPrefix: `map-art-${a.kind}` })}
          </div>`).join('')}
        </fieldset>`;

    let startBtnHtml = '';
    if (!readOnly) {
      startBtnHtml = isStart
        ? `<div class="admin-pill admin-pill-gold">★ Start Tile</div>`
        : isTraversable
          ? `<button class="admin-btn" id="sidebar-set-start" type="button">Set as Start Tile</button>`
          : '';
    }
    const deleteBtnHtml = readOnly ? '' : (isStart
      ? `<button class="admin-btn admin-btn-danger" disabled title="Cannot delete the start tile">Delete Room</button>
         <div class="admin-form-hint">Assign a different start tile before deleting.</div>`
      : `<button class="admin-btn admin-btn-danger" id="sidebar-delete" type="button">Delete Room</button>`);

    sidebar.innerHTML = `
      <div class="admin-map-sidebar-header">
        <span>${readOnly ? 'Room Info' : 'Edit Room'}</span>
        ${isStart ? '<span class="admin-pill admin-pill-gold">★ Start</span>' : ''}
      </div>
      <div class="admin-map-sidebar-fields">
        <label>Room Name<input type="text" id="sidebar-name" value="${escapeHtml(tile.name)}"${disabled}></label>
        <label>Type<select id="sidebar-type"${disabled}>${typeOptions}</select></label>
        <label>Zone<select id="sidebar-zone"${disabled}>${zoneOptions}</select></label>
        <label>Shop<select id="sidebar-shop"${disabled}>${shopOptions}</select></label>
        <label>NPC<select id="sidebar-npc"${disabled}>${npcOptions}</select></label>
        <label>Dungeon<select id="sidebar-dungeon"${disabled}>${dungeonOptions}</select></label>
        ${transitionSectionHtml}
        ${entryRequirementsHtml({
          idPrefix: 'sidebar-req',
          current: this.tileGate(tile),
          items: Object.values(content?.items ?? {}),
          quests: Object.values(content?.quests ?? {}),
          readOnly,
          itemLabel: 'Required Item (override)',
          itemNoneLabel: '(use type default)',
          hint: 'Every party member must satisfy every requirement to enter this room. Unset fields fall back to the tile type.',
        })}
        <div class="admin-form-coords">Coordinates (${tile.col}, ${tile.row})</div>
        <label class="admin-form-checkbox">
          <input type="checkbox" id="sidebar-custom-encounters" ${tile.encounterTable?.length ? 'checked' : ''}${disabled}>
          Custom Encounters
        </label>
        <div id="sidebar-encounters-section" style="${tile.encounterTable?.length ? '' : 'display:none'}">
          ${this.encounterRowsHtml(tile, content ? Object.values(content.encounters) : [], readOnly)}
        </div>
        ${artHtml}
        ${startBtnHtml}
        <div class="admin-map-sidebar-spacer"></div>
        ${deleteBtnHtml}
        <div id="sidebar-error" class="admin-map-sidebar-error"></div>
      </div>
    `;

    const nameInput = document.getElementById('sidebar-name') as HTMLInputElement;
    nameInput?.addEventListener('input', () => {
      if (this.selectedTile) { this.selectedTile.name = nameInput.value; this.scheduleSave(ctx); }
    });
    const typeSelect = document.getElementById('sidebar-type') as HTMLSelectElement;
    typeSelect?.addEventListener('change', () => {
      if (this.selectedTile) { this.selectedTile.type = typeSelect.value; this.scheduleSave(ctx); this.renderSidebar(ctx); }
    });
    const zoneSelect = document.getElementById('sidebar-zone') as HTMLSelectElement;
    zoneSelect?.addEventListener('change', () => {
      if (this.selectedTile) { this.selectedTile.zone = zoneSelect.value; this.scheduleSave(ctx); }
    });
    const shopSelect = document.getElementById('sidebar-shop') as HTMLSelectElement;
    shopSelect?.addEventListener('change', () => {
      if (!this.selectedTile) return;
      if (shopSelect.value) this.selectedTile.shopId = shopSelect.value;
      else delete this.selectedTile.shopId;
      this.scheduleSave(ctx);
    });
    const npcSelect = document.getElementById('sidebar-npc') as HTMLSelectElement;
    npcSelect?.addEventListener('change', () => {
      if (!this.selectedTile) return;
      if (npcSelect.value) this.selectedTile.npcId = npcSelect.value;
      else delete this.selectedTile.npcId;
      this.scheduleSave(ctx);
      this.draw(ctx);
    });
    const dungeonSelect = document.getElementById('sidebar-dungeon') as HTMLSelectElement;
    dungeonSelect?.addEventListener('change', () => {
      if (!this.selectedTile) return;
      if (dungeonSelect.value) this.selectedTile.dungeonId = dungeonSelect.value;
      else delete this.selectedTile.dungeonId;
      this.scheduleSave(ctx);
    });
    const applyEntryRequirements = (): void => {
      if (!this.selectedTile) return;
      const reqs = readEntryRequirements('sidebar-req');
      if (reqs) this.selectedTile.entryRequirements = reqs;
      else delete this.selectedTile.entryRequirements;
      // The legacy scalar is folded into the gate at read time — clear it so a
      // room never carries two competing item requirements.
      delete this.selectedTile.requiredItemId;
      this.scheduleSave(ctx);
    };
    document.getElementById('sidebar-req-item')?.addEventListener('change', applyEntryRequirements);
    document.getElementById('sidebar-req-min-level')?.addEventListener('change', applyEntryRequirements);
    for (const el of document.querySelectorAll('[data-sidebar-req-quest]')) {
      el.addEventListener('change', applyEntryRequirements);
    }
    const customEncCheck = document.getElementById('sidebar-custom-encounters') as HTMLInputElement;
    customEncCheck?.addEventListener('change', () => {
      const section = document.getElementById('sidebar-encounters-section');
      if (!section || !this.selectedTile) return;
      if (customEncCheck.checked) {
        if (!this.selectedTile.encounterTable || this.selectedTile.encounterTable.length === 0) {
          this.selectedTile.encounterTable = [];
        }
        section.style.display = '';
        const c = ctx.getDisplayContent();
        section.innerHTML = this.encounterRowsHtml(this.selectedTile, c ? Object.values(c.encounters) : [], ctx.isReadOnly());
        this.wireEncounterEvents(ctx);
      } else {
        delete this.selectedTile.encounterTable;
        section.style.display = 'none';
        this.scheduleSave(ctx);
      }
    });

    this.wireEncounterEvents(ctx);
    this.wireRoomArt(sidebar, tile);
    document.getElementById('sidebar-set-start')?.addEventListener('click', () => this.setAsStartTile(ctx));
    document.getElementById('sidebar-delete')?.addEventListener('click', () => this.deleteSelectedTile(ctx));
    document.getElementById('sidebar-link-transition')?.addEventListener('click', () => {
      if (ctx.isReadOnly()) return;
      this.pickTransition = this.pickTransition ? null : (this.selectedTile ? { sourceTile: this.selectedTile } : null);
      this.updatePickBanner();
      this.renderSidebar(ctx);
    });
    for (const el of document.querySelectorAll('[data-remove-transition]')) {
      el.addEventListener('click', () => {
        if (!this.selectedTile?.transitions) return;
        const idx = Number(el.getAttribute('data-remove-transition'));
        this.selectedTile.transitions.splice(idx, 1);
        if (this.selectedTile.transitions.length === 0) delete this.selectedTile.transitions;
        this.scheduleSave(ctx);
        this.draw(ctx);
        this.renderSidebar(ctx);
      });
    }
  }

  private wireRoomArt(sidebar: HTMLElement, tile: WorldTileDefinition): void {
    const key = cubeToKey(offsetToCube({ col: tile.col, row: tile.row }));
    const repaint = (): void => {
      this.terrain?.markTileKeysDirty([key]);
      this.requestDraw();
    };
    for (const a of ROOM_ART_KINDS) {
      const root = sidebar.querySelector<HTMLElement>(`[data-room-art="${a.kind}"]`);
      if (!root) continue;
      const mapArt = a.kind === 'tile' && tile.id
        ? {
          onUploaded: (url: string) => {
            this.artOverrides.set(tile.id, url);
            repaint();
          },
          onRemoved: () => {
            this.artOverrides.delete(tile.id);
            this.tileArt.forget(artworkUrl('tile', tile.id));
            repaint();
          },
        }
        : {};
      wireArtworkSection(root, { kind: a.kind, id: tile.id, idPrefix: `map-art-${a.kind}`, ...mapArt });
    }
  }

  /**
   * The room's own gate for editing, with any legacy top-level
   * `requiredItemId` folded in so the form shows one value, not two.
   */
  private tileGate(tile: WorldTileDefinition): RoomEntryRequirements | undefined {
    return toRoomRequirements(tile.entryRequirements, tile.requiredItemId);
  }

  private encounterRowsHtml(tile: WorldTileDefinition, encounters: EncounterDefinition[], readOnly: boolean): string {
    const disabled = readOnly ? ' disabled' : '';
    const entries = tile.encounterTable ?? [];
    const rows = entries.map((e, i) => {
      const options = encounters.map(enc =>
        `<option value="${enc.id}" ${enc.id === e.encounterId ? 'selected' : ''}>${escapeHtml(enc.name)}</option>`
      ).join('');
      return `
        <div class="admin-form-row sidebar-enc-row" data-index="${i}">
          <select class="sidebar-enc-encounter"${disabled}>${options}</select>
          <label>W <input type="number" class="sidebar-enc-weight" value="${e.weight}" min="1" step="1"${disabled}></label>
          ${readOnly ? '' : '<button class="admin-btn admin-btn-sm admin-btn-danger sidebar-enc-remove" type="button">×</button>'}
        </div>
      `;
    }).join('');
    const addBtn = readOnly ? '' : '<button class="admin-btn admin-btn-sm" id="sidebar-add-encounter" type="button">+ Encounter</button>';
    return `${addBtn}<div id="sidebar-encounters-list">${rows}</div>`;
  }

  private wireEncounterEvents(ctx: AdminContext): void {
    document.getElementById('sidebar-add-encounter')?.addEventListener('click', () => {
      if (!this.selectedTile) return;
      const c = ctx.getDisplayContent();
      const encounterDefs = c ? Object.values(c.encounters) : [];
      if (encounterDefs.length === 0) return;
      if (!this.selectedTile.encounterTable) this.selectedTile.encounterTable = [];
      this.selectedTile.encounterTable.push({ encounterId: encounterDefs[0].id, weight: 1 });
      this.scheduleSave(ctx);
      const section = document.getElementById('sidebar-encounters-section');
      if (section) {
        section.innerHTML = this.encounterRowsHtml(this.selectedTile, encounterDefs, ctx.isReadOnly());
        this.wireEncounterEvents(ctx);
      }
    });
    document.querySelectorAll<HTMLButtonElement>('.sidebar-enc-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.selectedTile?.encounterTable) return;
        const row = btn.closest('.sidebar-enc-row');
        const index = parseInt(row?.getAttribute('data-index') ?? '-1');
        if (index >= 0) {
          this.selectedTile.encounterTable.splice(index, 1);
          this.scheduleSave(ctx);
          const section = document.getElementById('sidebar-encounters-section');
          const c = ctx.getDisplayContent();
          if (section) {
            section.innerHTML = this.encounterRowsHtml(this.selectedTile, c ? Object.values(c.encounters) : [], ctx.isReadOnly());
            this.wireEncounterEvents(ctx);
          }
        }
      });
    });
    document.querySelectorAll<HTMLElement>('.sidebar-enc-row').forEach(row => {
      const index = parseInt(row.getAttribute('data-index') ?? '-1');
      if (index < 0) return;
      row.querySelector('.sidebar-enc-encounter')?.addEventListener('change', e => {
        if (this.selectedTile?.encounterTable?.[index]) {
          this.selectedTile.encounterTable[index].encounterId = (e.target as HTMLSelectElement).value;
          this.scheduleSave(ctx);
        }
      });
      row.querySelector('.sidebar-enc-weight')?.addEventListener('input', e => {
        if (this.selectedTile?.encounterTable?.[index]) {
          this.selectedTile.encounterTable[index].weight = parseInt((e.target as HTMLInputElement).value) || 1;
          this.scheduleSave(ctx);
        }
      });
    });
  }

  private scheduleSave(ctx: AdminContext): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.saveSelectedTile(ctx), 300);
  }

  private async saveSelectedTile(ctx: AdminContext): Promise<void> {
    if (!this.selectedTile) return;
    try {
      const data = await putAdmin<{ world: WorldData }>(
        `/api/admin/world/tile${ctx.versionQueryParam()}`, this.selectedTile);
      this.applyWorldUpdate(ctx, data.world);
      this.selectedTile = this.worldTileDefs.get(`${this.selectedTile.col},${this.selectedTile.row}`) ?? null;
      this.draw(ctx);
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async addTileAtSlot(ctx: AdminContext, slot: AdjacentSlot): Promise<void> {
    if (ctx.isReadOnly()) return;

    const neighbors = getNeighbors(slot.coord);
    const selectedZone = this.selectedTile?.zone;
    let defaultZone = 'unknown';
    let fallbackZone = 'unknown';
    for (const neighborCoord of neighbors) {
      const offset = cubeToOffset(neighborCoord);
      const neighborDef = this.worldTileDefs.get(`${offset.col},${offset.row}`);
      if (neighborDef) {
        if (fallbackZone === 'unknown') fallbackZone = neighborDef.zone;
        if (selectedZone && neighborDef.zone === selectedZone) {
          defaultZone = selectedZone;
          break;
        }
      }
    }
    if (defaultZone === 'unknown') defaultZone = fallbackZone;
    // First room on a fresh map has no neighbors to inherit from — fall back to any zone.
    if (defaultZone === 'unknown') {
      const content = ctx.getDisplayContent();
      defaultZone = Object.keys(content?.zones ?? {})[0] ?? 'unknown';
    }

    const newTile: WorldTileDefinition = {
      id: '',
      mapId: this.selectedMapId,
      col: slot.col,
      row: slot.row,
      type: this.selectedTile?.type ?? 'plains',
      zone: defaultZone,
      name: 'New Room',
      encounterTable: this.selectedTile?.encounterTable ? [...this.selectedTile.encounterTable] : undefined,
    };

    try {
      const data = await putAdmin<{ world: WorldData }>(
        `/api/admin/world/tile${ctx.versionQueryParam()}`, newTile);
      this.applyWorldUpdate(ctx, data.world);
      this.selectedTile = this.worldTileDefs.get(`${newTile.col},${newTile.row}`) ?? newTile;
      this.draw(ctx);
      this.updateMapTileCount();
      this.renderSidebar(ctx);
      const input = document.getElementById('sidebar-name') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteSelectedTile(ctx: AdminContext): Promise<void> {
    if (!this.selectedTile) return;
    try {
      const data = await deleteAdmin<{ world: WorldData }>(
        `/api/admin/world/tile${ctx.versionQueryParam()}`,
        { mapId: this.selectedTile.mapId, col: this.selectedTile.col, row: this.selectedTile.row });
      this.applyWorldUpdate(ctx, data.world);
      this.selectedTile = null;
      this.draw(ctx);
      this.updateMapTileCount();
      this.renderSidebar(ctx);
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async setAsStartTile(ctx: AdminContext): Promise<void> {
    if (!this.selectedTile) return;
    try {
      const data = await putAdmin<{ world: WorldData }>(
        `/api/admin/world/start-tile${ctx.versionQueryParam()}`,
        { mapId: this.selectedTile.mapId, col: this.selectedTile.col, row: this.selectedTile.row });
      this.applyWorldUpdate(ctx, data.world);
      this.draw(ctx);
      this.renderSidebar(ctx);
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  private applyWorldUpdate(ctx: AdminContext, world: WorldData): void {
    ctx.patchVersionContent({ world });
    this.rebuildMapData(ctx);
  }

  private showSidebarError(message: string): void {
    const errorEl = document.getElementById('sidebar-error');
    if (errorEl) {
      errorEl.textContent = message;
      setTimeout(() => { if (errorEl) errorEl.textContent = ''; }, 5000);
    }
  }
}
