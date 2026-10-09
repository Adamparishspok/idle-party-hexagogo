import type {
  ClientHouseState,
  DungeonDefinition,
  MapTransitionLink,
  NpcDefinition,
  QuestProgressEntry,
  ShopSummary,
  WorldMapMeta,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';

export type RoomActionKind = 'home' | 'npc' | 'shop' | 'bank' | 'dungeon' | 'travel';

export interface RoomAction {
  kind: RoomActionKind;
  icon: string;
  name: string;
  detail?: string;
  /** NPC, shop (also for bank) or dungeon id; for travel, the destination tile GUID; for home, the home's tile GUID. */
  targetId: string;
  questReady?: boolean;
}

export interface RoomActionLookups {
  getNpc(id: string): NpcDefinition | undefined;
  getShop(id: string): ShopSummary | undefined;
  getDungeon(id: string): DungeonDefinition | undefined;
  getTileByGuid(id: string): WorldTileDefinition | undefined;
  getMaps(): WorldMapMeta[];
}

export type RoomContents = Pick<WorldTileDefinition, 'npcId' | 'shopId' | 'dungeonId' | 'transitions'> & { id?: string };

/** The viewer's home, for the room it stands in. */
export interface RoomHome {
  tileId: string;
  name: string;
}

export const ROOM_ICONS = {
  home: '🏠',
  shop: '🪙',
  bank: '🏦',
  hire: '🤝',
  dungeon: '🗝️',
  travel: '🌀',
  players: '👥',
} as const;

export const QUEST_READY_DETAIL = 'Quest ready to turn in';
export const HIRE_DETAIL = 'Henchmen for hire';

const NO_READY_QUESTS: ReadonlySet<string> = new Set();

export const BANK_ACTION_NAME = 'Bank';

/** Everything a room offers, in display order: your home, NPC, shop, bank, dungeon, then one entry per exit. */
export function getRoomActions(
  room: RoomContents,
  lookups: RoomActionLookups,
  readyQuestIds: ReadonlySet<string> = NO_READY_QUESTS,
  home?: RoomHome,
): RoomAction[] {
  const actions: RoomAction[] = [];

  if (home && room.id === home.tileId) {
    actions.push({ kind: 'home', icon: ROOM_ICONS.home, name: home.name, targetId: home.tileId });
  }

  const npc = room.npcId ? lookups.getNpc(room.npcId) : undefined;
  if (npc) {
    const questReady = (npc.questIds ?? []).some(id => readyQuestIds.has(id));
    actions.push({
      kind: 'npc',
      icon: npc.emoji,
      name: npc.name,
      targetId: npc.id,
      ...(questReady ? { detail: QUEST_READY_DETAIL, questReady } : {}),
    });
  }

  const shop = room.shopId ? lookups.getShop(room.shopId) : undefined;
  if (shop && hasShopFront(shop)) actions.push(shopAction(shop));
  if (shop?.isBanker) actions.push({ kind: 'bank', icon: ROOM_ICONS.bank, name: BANK_ACTION_NAME, targetId: shop.id });

  const dungeon = room.dungeonId ? lookups.getDungeon(room.dungeonId) : undefined;
  if (dungeon) {
    actions.push({ kind: 'dungeon', icon: ROOM_ICONS.dungeon, name: dungeon.name, targetId: dungeon.id });
  }

  for (const link of room.transitions ?? []) {
    actions.push({ kind: 'travel', icon: ROOM_ICONS.travel, name: transitionName(link, lookups), targetId: link.tileId });
  }

  return actions;
}

const MARKER_RANK: Partial<Record<RoomAction['kind'], number>> = { home: 0, bank: 2 };

/** Map-marker icons in priority order: home, ready quests and the bank first, then the rest, then one exit. */
export function markerActions(actions: readonly RoomAction[]): RoomAction[] {
  const rank = (a: RoomAction) => (a.questReady ? 1 : MARKER_RANK[a.kind] ?? 3);
  const places = actions.filter(a => a.kind !== 'travel').sort((a, b) => rank(a) - rank(b));
  const firstExit = actions.find(a => a.kind === 'travel');
  return firstExit ? [...places, firstExit] : places;
}

/** Button/chip text for acting on a room action. */
export function actionLabel(action: RoomAction): string {
  switch (action.kind) {
    case 'home': return `Enter ${action.name}`;
    case 'npc': return `Talk to ${action.name}`;
    case 'shop': return action.name;
    case 'bank': return 'Open your bank';
    case 'dungeon': return `Enter ${action.name}`;
    case 'travel': return `Travel to ${action.name}`;
  }
}

export function readyQuestIds(activeQuests: readonly QuestProgressEntry[] = []): Set<string> {
  return new Set(activeQuests.filter(q => q.status === 'ready').map(q => q.questId));
}

/** A banker that sells nothing is only a bank, so it gets no shop entry. */
function hasShopFront(shop: ShopSummary): boolean {
  return !shop.isBanker || shop.sellsItems || shop.hiresHenchmen || shop.sellsHouses;
}

function shopAction(shop: ShopSummary): RoomAction {
  const hireOnly = shop.hiresHenchmen && !shop.sellsItems;
  return {
    kind: 'shop',
    icon: hireOnly ? ROOM_ICONS.hire : ROOM_ICONS.shop,
    name: shop.name,
    targetId: shop.id,
    ...(shop.sellsItems && shop.hiresHenchmen ? { detail: HIRE_DETAIL } : {}),
  };
}

function transitionName(link: MapTransitionLink, lookups: RoomActionLookups): string {
  const dest = lookups.getTileByGuid(link.tileId);
  if (dest?.name) return dest.name;
  return lookups.getMaps().find(m => m.id === link.mapId)?.name ?? 'a passage';
}

export function roomHome(house: ClientHouseState | undefined): RoomHome | undefined {
  const tileId = house?.location?.tileId;
  return tileId ? { tileId, name: `your ${house!.definition.name}` } : undefined;
}
