import type {
  DungeonDefinition,
  MapTransitionLink,
  NpcDefinition,
  QuestProgressEntry,
  ShopSummary,
  WorldMapMeta,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';

export type RoomActionKind = 'npc' | 'shop' | 'dungeon' | 'travel';

export interface RoomAction {
  kind: RoomActionKind;
  icon: string;
  name: string;
  detail?: string;
  /** NPC, shop or dungeon id; for travel, the destination tile GUID. */
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

export type RoomContents = Pick<WorldTileDefinition, 'npcId' | 'shopId' | 'dungeonId' | 'transitions'>;

export const ROOM_ICONS = {
  shop: '🪙',
  hire: '🤝',
  dungeon: '🗝️',
  travel: '🌀',
  players: '👥',
} as const;

export const QUEST_READY_DETAIL = 'Quest ready to turn in';
export const HIRE_DETAIL = 'Henchmen for hire';

const NO_READY_QUESTS: ReadonlySet<string> = new Set();

/** Everything a room offers, in display order: NPC, shop, dungeon, then one entry per exit. */
export function getRoomActions(
  room: RoomContents,
  lookups: RoomActionLookups,
  readyQuestIds: ReadonlySet<string> = NO_READY_QUESTS,
): RoomAction[] {
  const actions: RoomAction[] = [];

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
  if (shop) actions.push(shopAction(shop));

  const dungeon = room.dungeonId ? lookups.getDungeon(room.dungeonId) : undefined;
  if (dungeon) {
    actions.push({ kind: 'dungeon', icon: ROOM_ICONS.dungeon, name: dungeon.name, targetId: dungeon.id });
  }

  for (const link of room.transitions ?? []) {
    actions.push({ kind: 'travel', icon: ROOM_ICONS.travel, name: transitionName(link, lookups), targetId: link.tileId });
  }

  return actions;
}

/** Button/chip text for acting on a room action. */
export function actionLabel(action: RoomAction): string {
  switch (action.kind) {
    case 'npc': return `Talk to ${action.name}`;
    case 'shop': return action.name;
    case 'dungeon': return `Enter ${action.name}`;
    case 'travel': return `Travel to ${action.name}`;
  }
}

export function readyQuestIds(activeQuests: readonly QuestProgressEntry[] = []): Set<string> {
  return new Set(activeQuests.filter(q => q.status === 'ready').map(q => q.questId));
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
