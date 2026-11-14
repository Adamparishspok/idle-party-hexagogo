import { describe, expect, it } from 'vitest';
import { MAP_PROP_IDS, cubeToKey, getNeighbors, offsetToCube } from '@idle-party-rpg/shared';
import type { ShopSummary, WorldTileDefinition } from '@idle-party-rpg/shared';
import { buildPaintTiles, roomBuilding } from '../src/ui/map/paintTiles';
import { landmarkArtUrl } from '../src/ui/map/tileArt';
import { hasBuiltInLook, paintFingerprint, type PaintTile } from '../src/ui/map/terrainPainter';
import { TerrainTileIndex } from '../src/ui/map/terrainChunks';
import { markerGlyphs, MAX_MARKER_ICONS, ROOM_ICONS, type RoomAction } from '../src/ui/RoomActions';
import { adminPaintTiles, contentRoomLookups, roomMarkerGlyphs } from '../src/admin/map/mapPaint';
import { typeClusterTiles } from '../src/admin/map/typePreview';
import type { ContentData } from '../src/admin/types';

function shop(over: Partial<ShopSummary> = {}): ShopSummary {
  return { id: 's', name: 'Shop', sellsItems: true, hiresHenchmen: false, sellsHouses: false, isBanker: false, ...over };
}

function room(over: Partial<WorldTileDefinition> = {}): WorldTileDefinition {
  return { id: 'r1', mapId: 'm', col: 0, row: 0, type: 'plains', zone: 'z', name: 'Room', ...over };
}

function content(over: Partial<ContentData> = {}): ContentData {
  return {
    monsters: {}, items: {}, zones: {}, encounters: {}, sets: {}, shops: {}, henchmen: {}, houses: {},
    tileTypes: {}, recipes: {}, npcs: {}, quests: {}, dungeons: {}, skills: {}, skillSlotSchedules: {},
    designNotes: {},
    world: { tiles: [], startTile: { col: 0, row: 0 }, maps: [] } as unknown as ContentData['world'],
    ...over,
  };
}

describe('buildPaintTiles', () => {
  it('places rooms by cube key and links only neighbours that exist', () => {
    const tiles = buildPaintTiles([
      { col: 0, row: 0, type: 'plains', zone: 'a', color: '#000', traversable: true },
      { col: 1, row: 0, type: 'forest', zone: 'a', color: '#000', traversable: true },
      { col: 5, row: 5, type: 'void', zone: 'a', color: '#000', traversable: false },
    ]);
    expect(tiles).toHaveLength(2);
    const a = tiles[0];
    const b = tiles[1];
    expect(a.key).toBe(cubeToKey(offsetToCube({ col: 0, row: 0 })));
    expect(a.neighborKeys).toHaveLength(6);
    expect(a.neighborKeys.filter(Boolean)).toEqual([b.key]);
    expect(a.fog).toBe('open');
    expect(a.dimmed).toBe(false);
  });

  it('keeps neighbour slots in direction order', () => {
    const center = offsetToCube({ col: 3, row: 3 });
    const around = getNeighbors(center);
    const tiles = buildPaintTiles([
      { col: 3, row: 3, type: 'plains', zone: 'a', color: '#000', traversable: true },
    ]);
    expect(tiles[0].neighborKeys).toEqual(around.map(() => ''));
  });

  it('carries content flags through', () => {
    const [t] = buildPaintTiles([
      { col: 0, row: 0, type: 'plains', zone: 'a', color: '#000', traversable: true, building: 'bank', fog: 'haze', dimmed: true, icon: '🌾' },
    ]);
    expect(t.building).toBe('bank');
    expect(t.fog).toBe('haze');
    expect(t.dimmed).toBe(true);
    expect(t.icon).toBe('🌾');
  });
});

describe('roomBuilding', () => {
  const lookups = (s?: ShopSummary, dungeon = true, npc = true) => ({
    getShop: () => s,
    getDungeon: () => (dungeon ? { id: 'd' } : undefined),
    getNpc: () => (npc ? { id: 'n' } : undefined),
  });

  it('gives a dungeon room a cave, even with a shop', () => {
    expect(roomBuilding({ dungeonId: 'd', shopId: 's' }, lookups(shop()))).toBe('cave');
  });

  it('ignores a dungeon id that no longer resolves', () => {
    expect(roomBuilding({ dungeonId: 'gone', shopId: 's' }, lookups(shop(), false))).toBe('shop');
  });

  it('picks the building from what the shop offers', () => {
    expect(roomBuilding({ shopId: 's' }, lookups(shop({ isBanker: true, sellsItems: true })))).toBe('bank');
    expect(roomBuilding({ shopId: 's' }, lookups(shop({ sellsHouses: true, sellsItems: false })))).toBe('houses');
    expect(roomBuilding({ shopId: 's' }, lookups(shop({ hiresHenchmen: true, sellsItems: false })))).toBe('shop');
  });

  it('stands your home on its room, under a dungeon but over a shop', () => {
    expect(roomBuilding({ id: 'r1', shopId: 's' }, lookups(shop()), 'r1')).toBe('home');
    expect(roomBuilding({ id: 'r1', dungeonId: 'd' }, lookups(shop()), 'r1')).toBe('cave');
    expect(roomBuilding({ id: 'r2', shopId: 's' }, lookups(shop()), 'r1')).toBe('shop');
  });

  it('marks NPC rooms, then town rooms, when nothing bigger is there', () => {
    expect(roomBuilding({ npcId: 'n', type: 'town' }, lookups(undefined))).toBe('npc');
    expect(roomBuilding({ npcId: 'gone', type: 'town' }, lookups(undefined, true, false))).toBe('town');
    expect(roomBuilding({ npcId: 'n', shopId: 's' }, lookups(shop()))).toBe('shop');
    expect(roomBuilding({ type: 'town' }, lookups(undefined))).toBe('town');
  });

  it('leaves plain rooms alone', () => {
    expect(roomBuilding({}, lookups(undefined))).toBeUndefined();
    expect(roomBuilding({ shopId: 'missing' }, lookups(undefined))).toBeUndefined();
  });
});

describe('hasBuiltInLook', () => {
  it('is true for types the painter draws itself', () => {
    for (const id of ['plains', 'forest', 'town', 'dungeon', 'mountain', 'volcano', 'lava_field', 'beach', 'desert', 'hedge', 'water', 'void']) {
      expect(hasBuiltInLook(id)).toBe(true);
    }
  });

  it('is false for authored types and prototype keys', () => {
    expect(hasBuiltInLook('swamp')).toBe(false);
    expect(hasBuiltInLook('7f1e0d6a-uuid')).toBe(false);
    expect(hasBuiltInLook('toString')).toBe(false);
  });
});

describe('paintFingerprint', () => {
  const base: PaintTile = {
    key: 'k', x: 0, y: 0, type: 'plains', color: '#000', zone: 'z', traversable: true,
    fog: 'open', dimmed: false, neighborKeys: [],
  };

  it('changes when a room gains a building or a new fallback look', () => {
    const fp = paintFingerprint(base);
    expect(paintFingerprint({ ...base, building: 'shop' })).not.toBe(fp);
    expect(paintFingerprint({ ...base, color: '#fff' })).not.toBe(fp);
    expect(paintFingerprint({ ...base, icon: '🌾' })).not.toBe(fp);
    expect(paintFingerprint({ ...base })).toBe(fp);
  });
});

describe('TerrainTileIndex', () => {
  const t = (key: string, over: Partial<PaintTile> = {}): PaintTile => ({
    key, x: 10, y: 10, type: 'plains', color: '#000', zone: 'z', traversable: true,
    fog: 'open', dimmed: false, neighborKeys: [], ...over,
  });

  it('reports changed, added and removed tiles', () => {
    const index = new TerrainTileIndex();
    expect(index.setTiles([t('a'), t('b')]).map(x => x.key)).toEqual(['a', 'b']);
    expect(index.setTiles([t('a'), t('b')])).toEqual([]);
    expect(index.setTiles([t('a', { building: 'cave' })]).map(x => x.key).sort()).toEqual(['a', 'b']);
    expect(index.tilesForChunk(0, 0).map(x => x.key)).toEqual(['a']);
  });
});

describe('markerGlyphs', () => {
  const action = (kind: RoomAction['kind'], icon: string): RoomAction => ({ kind, icon, name: kind, targetId: kind });

  it('caps the icons and counts the rest', () => {
    const actions = [action('npc', '🧙'), action('shop', '🪙'), action('bank', '🏦'), action('dungeon', '🗝️'), action('travel', '🌀')];
    const { shown, more } = markerGlyphs(actions);
    expect(shown).toHaveLength(MAX_MARKER_ICONS);
    expect(shown[0].icon).toBe('🏦');
    expect(more).toBe(2);
  });
});

describe('admin map content', () => {
  const data = content({
    shops: {
      store: { id: 'store', name: 'Store', inventory: [{ itemId: 'i', price: 1 }] },
      hire: { id: 'hire', name: 'Guild', inventory: [], henchmanIds: ['h'] },
      bank: { id: 'bank', name: 'Bank', inventory: [], banker: true },
      agent: { id: 'agent', name: 'Agent', inventory: [], houseIds: ['house'] },
    },
    npcs: { mira: { id: 'mira', name: 'Mira', emoji: '🧙', greeting: '' } as ContentData['npcs'][string] },
    dungeons: { caves: { id: 'caves', name: 'Caves', floors: [] } as unknown as ContentData['dungeons'][string] },
    tileTypes: { swamp: { id: 'swamp', name: 'Swamp', icon: '🐸', color: '#336633', traversable: true } },
  });
  const lookups = contentRoomLookups(data);

  it('shows the same glyphs the game does', () => {
    expect(roomMarkerGlyphs(room({ shopId: 'store' }), lookups).icons).toEqual([ROOM_ICONS.shop]);
    expect(roomMarkerGlyphs(room({ shopId: 'hire' }), lookups).icons).toEqual([ROOM_ICONS.hire]);
    expect(roomMarkerGlyphs(room({ shopId: 'bank' }), lookups).icons).toEqual([ROOM_ICONS.bank]);
    expect(roomMarkerGlyphs(room({ dungeonId: 'caves' }), lookups).icons).toEqual([ROOM_ICONS.dungeon]);
    expect(roomMarkerGlyphs(room({ npcId: 'mira' }), lookups).icons).toEqual(['🧙']);
    expect(roomMarkerGlyphs(room({ transitions: [{ mapId: 'm2', tileId: 'x' }] }), lookups).icons).toEqual([ROOM_ICONS.travel]);
    expect(roomMarkerGlyphs(room(), lookups).icons).toEqual([]);
  });

  it('paints rooms with their type look and content buildings', () => {
    const tiles = adminPaintTiles(data, [
      room({ id: 'a', col: 0, row: 0, type: 'swamp', shopId: 'agent' }),
      room({ id: 'b', col: 1, row: 0, type: 'plains', dungeonId: 'caves' }),
      room({ id: 'c', col: 2, row: 0, type: 'void' }),
    ], lookups);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toMatchObject({ type: 'swamp', color: '#336633', icon: '🐸', building: 'houses', fog: 'open', traversable: true });
    expect(tiles[1].building).toBe('cave');
  });
});

describe('typeClusterTiles', () => {
  it('builds a fully connected seven-room cluster of one type', () => {
    const tiles = typeClusterTiles({ id: 'forest', color: '#000', icon: '', traversable: true });
    expect(tiles).toHaveLength(7);
    expect(new Set(tiles.map(t => t.type))).toEqual(new Set(['forest']));
    expect(tiles[0].neighborKeys.filter(Boolean)).toHaveLength(6);
  });
});

describe('landmarkArtUrl', () => {
  it('serves every landmark from a fixed map-prop id', () => {
    for (const b of ['cave', 'bank', 'houses', 'shop', 'npc', 'home', 'town'] as const) {
      const url = landmarkArtUrl(b);
      const id = url.slice('/map-prop-artwork/'.length, -'.png'.length);
      expect(url.startsWith('/map-prop-artwork/')).toBe(true);
      expect(MAP_PROP_IDS).toContain(id);
    }
    expect(landmarkArtUrl('town')).toBe('/map-prop-artwork/building-inn.png');
  });
});
