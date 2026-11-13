import { HEX_SIZE, cubeToOffset, cubeToPixel, getNeighbors, offsetToCube } from '@idle-party-rpg/shared';
import type { TileTypeDefinition } from '@idle-party-rpg/shared';
import { buildPaintTiles, type PaintTileInput } from '../../ui/map/paintTiles';
import { createSeaCanvas, paintTerrain, type PaintTile } from '../../ui/map/terrainPainter';

const CLUSTER_CENTER = { col: 2, row: 2 };
/** World units the preview frames around the cluster's center: the cluster plus its coast. */
const FRAME_HALF_HEIGHT = HEX_SIZE * 2.4;

let seaCanvas: HTMLCanvasElement | null = null;

/** A seven-room cluster of one type, as the map paints it. */
export function typeClusterTiles(type: Pick<TileTypeDefinition, 'id' | 'color' | 'icon' | 'traversable'>): PaintTile[] {
  const center = offsetToCube(CLUSTER_CENTER);
  const cubes = [center, ...getNeighbors(center)];
  const inputs: PaintTileInput[] = cubes.map(c => {
    const { col, row } = cubeToOffset(c);
    return { col, row, type: type.id, zone: 'preview', color: type.color, traversable: type.traversable, icon: type.icon || undefined };
  });
  return buildPaintTiles(inputs);
}

/** Paint a type preview into `canvas`, sized to its CSS box. */
export function paintTypePreview(
  canvas: HTMLCanvasElement,
  type: Pick<TileTypeDefinition, 'id' | 'color' | 'icon' | 'traversable'>,
  getArt: (tile: PaintTile) => CanvasImageSource | null = () => null,
): void {
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const tiles = typeClusterTiles(type);
  const byKey = new Map(tiles.map(t => [t.key, t]));
  const mid = cubeToPixel(offsetToCube(CLUSTER_CENTER));
  const scale = canvas.height / (FRAME_HALF_HEIGHT * 2);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  seaCanvas ??= createSeaCanvas(256);
  const sea = ctx.createPattern(seaCanvas, 'repeat');
  ctx.fillStyle = sea ?? '#2f86bf';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, canvas.width / 2 - mid.x * scale, canvas.height / 2 - mid.y * scale);
  paintTerrain(ctx, tiles, { scale, getTile: k => byKey.get(k), getArt });
}
