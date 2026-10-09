import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import type { ClassName, ItemDefinition, RecipeDefinition, SetDefinition, ShopDefinition, WorldTileDefinition } from '@idle-party-rpg/shared';
import type { PlayerSaveData } from '../src/game/GameStateStore.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';

export interface GearKit {
  items: Record<string, ItemDefinition>;
  sets: Record<string, SetDefinition>;
  shops: Record<string, ShopDefinition>;
  tiles: WorldTileDefinition[];
  recipes: Record<string, RecipeDefinition>;
  content: ContentStore;
  grid: HexGrid;
  newSession(username: string, className?: ClassName): PlayerSession;
  restore(data: PlayerSaveData): PlayerSession;
  roundTrip(session: PlayerSession): PlayerSession;
}

export function gearKit(items: Record<string, ItemDefinition> = {}): GearKit {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', 'hatchetmill', 'tile-start'));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'forest', 'darkwood', 'tile-other'));
  const kit = { items, sets: {}, shops: {}, tiles: [], recipes: {} } as unknown as GearKit;
  kit.grid = grid;
  kit.content = {
    getStartTile: () => ({ col: 0, row: 0 }),
    getItem: (id: string) => kit.items[id],
    getAllItems: () => kit.items,
    getAllSets: () => kit.sets,
    getShop: (id: string) => kit.shops[id],
    getAllShops: () => kit.shops,
    getTileById: (id: string) => kit.tiles.find(t => t.id === id),
    getWorld: () => ({ tiles: kit.tiles, startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getAllZones: () => ({}),
    getZone: () => undefined,
    getAllRecipes: () => kit.recipes,
    getRecipe: (id: string) => kit.recipes[id],
    getAllQuests: () => ({}),
    getQuest: () => undefined,
    getNpc: () => undefined,
    getHouse: () => undefined,
    getHenchman: () => undefined,
    ...fakeSkillContent(),
  } as unknown as ContentStore;
  kit.newSession = (username, className = 'Knight') => {
    const session = new PlayerSession(username, wrapGrids(grid), kit.content);
    session.setClass(className);
    session.getCurrentTile = () => grid.getTile(offsetToCube({ col: 0, row: 0 })) ?? null;
    return session;
  };
  kit.restore = (data) => {
    const session = PlayerSession.fromSaveData(data, wrapGrids(grid), kit.content);
    session.getCurrentTile = () => grid.getTile(offsetToCube({ col: 0, row: 0 })) ?? null;
    return session;
  };
  kit.roundTrip = (session) => kit.restore(JSON.parse(JSON.stringify(session.toSaveData())) as PlayerSaveData);
  return kit;
}
