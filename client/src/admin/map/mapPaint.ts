import { HexTile, offsetToCube, toShopSummary } from '@idle-party-rpg/shared';
import type { ShopSummary, WorldTileDefinition } from '@idle-party-rpg/shared';
import type { ContentData } from '../types';
import type { RoomActionLookups } from '../../ui/RoomActions';
import { getRoomActions, markerGlyphs } from '../../ui/RoomActions';
import { buildPaintTiles, roomBuilding } from '../../ui/map/paintTiles';
import type { RoomBuildingLookups } from '../../ui/map/paintTiles';
import type { PaintTile } from '../../ui/map/terrainPainter';

export type ContentRoomLookups = RoomActionLookups & RoomBuildingLookups;

/** Room lookups over an admin content snapshot, shaped like the game's WorldCache. */
export function contentRoomLookups(content: ContentData): ContentRoomLookups {
  const summaries = new Map<string, ShopSummary>();
  return {
    getNpc: id => content.npcs?.[id],
    getShop: id => {
      const shop = content.shops?.[id];
      if (!shop) return undefined;
      let s = summaries.get(id);
      if (!s) { s = toShopSummary(shop); summaries.set(id, s); }
      return s;
    },
    getDungeon: id => content.dungeons?.[id],
    getTileByGuid: id => content.world.tiles.find(t => t.id === id),
    getMaps: () => content.world.maps ?? [],
  };
}

/** Every room on one map as the game paints it for a player who has explored it all. */
export function adminPaintTiles(
  content: ContentData,
  rooms: readonly WorldTileDefinition[],
  lookups: RoomBuildingLookups = contentRoomLookups(content),
): PaintTile[] {
  return buildPaintTiles(rooms.map(def => {
    const typeDef = content.tileTypes?.[def.type];
    const hex = new HexTile(offsetToCube({ col: def.col, row: def.row }), def.type, def.zone, def.id, undefined, typeDef);
    return {
      col: def.col,
      row: def.row,
      type: def.type,
      zone: def.zone,
      color: '#' + hex.color.toString(16).padStart(6, '0'),
      traversable: hex.isTraversable,
      icon: typeDef?.icon,
      building: roomBuilding(def, lookups),
    };
  }));
}

/** The marker glyphs the game shows under a room for a player with no home there and no quests ready. */
export function roomMarkerGlyphs(def: WorldTileDefinition, lookups: RoomActionLookups): { icons: string[]; more: number } {
  const { shown, more } = markerGlyphs(getRoomActions(def, lookups));
  return { icons: shown.map(a => a.icon), more };
}
