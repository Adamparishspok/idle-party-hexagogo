import { cubeToKey, cubeToPixel, getNeighbors, offsetToCube } from '@idle-party-rpg/shared';
import type { ShopSummary, WorldTileDefinition } from '@idle-party-rpg/shared';
import type { FogState, PaintTile, RoomBuilding } from './terrainPainter';

export interface PaintTileInput {
  col: number;
  row: number;
  type: string;
  zone: string;
  color: string;
  traversable: boolean;
  icon?: string;
  fog?: FogState;
  dimmed?: boolean;
  building?: RoomBuilding;
}

export interface RoomBuildingLookups {
  getShop(id: string): ShopSummary | undefined;
  getDungeon(id: string): unknown;
}

/** The landmark a room's contents earn it on the map: a dungeon's cave, then its shop's building. */
export function roomBuilding(
  room: Pick<WorldTileDefinition, 'shopId' | 'dungeonId'>,
  lookups: RoomBuildingLookups,
): RoomBuilding | undefined {
  if (room.dungeonId && lookups.getDungeon(room.dungeonId)) return 'cave';
  const shop = room.shopId ? lookups.getShop(room.shopId) : undefined;
  if (!shop) return undefined;
  if (shop.isBanker) return 'bank';
  if (shop.sellsHouses) return 'houses';
  return 'shop';
}

/** Turn rooms on one map into painter tiles; void rooms are dropped and fog defaults to open. */
export function buildPaintTiles(inputs: readonly PaintTileInput[]): PaintTile[] {
  const present = new Set<string>();
  for (const i of inputs) {
    if (i.type === 'void') continue;
    present.add(cubeToKey(offsetToCube({ col: i.col, row: i.row })));
  }
  const out: PaintTile[] = [];
  for (const i of inputs) {
    if (i.type === 'void') continue;
    const cube = offsetToCube({ col: i.col, row: i.row });
    const p = cubeToPixel(cube);
    out.push({
      key: cubeToKey(cube),
      x: p.x,
      y: p.y,
      type: i.type,
      color: i.color,
      zone: i.zone,
      traversable: i.traversable,
      fog: i.fog ?? 'open',
      dimmed: i.dimmed ?? false,
      // Index = direction, so the painter can pick the shared edge.
      neighborKeys: getNeighbors(cube).map(n => {
        const k = cubeToKey(n);
        return present.has(k) ? k : '';
      }),
      ...(i.icon ? { icon: i.icon } : {}),
      ...(i.building ? { building: i.building } : {}),
    });
  }
  return out;
}
