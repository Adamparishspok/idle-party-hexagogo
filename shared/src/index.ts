// Hex utilities
export {
  createCube,
  cubeDistance,
  cubeEquals,
  cubeToKey,
  keyToCube,
  cubeToPixel,
  pixelToCube,
  cubeRound,
  cubeToOffset,
  offsetToCube,
  getNeighbors,
  getNeighbor,
  getHexCorners,
  HEX_SIZE,
  HEX_WIDTH,
  HEX_HEIGHT,
} from './hex/HexUtils.js';
export type { CubeCoord, OffsetCoord, PixelCoord } from './hex/HexUtils.js';

// Hex tile
export { TileType, TILE_CONFIGS, SEED_TILE_TYPES, HexTile } from './hex/HexTile.js';
export type { TileConfig, TileTypeDefinition } from './hex/HexTile.js';

// Hex grid & pathfinding
export { HexGrid } from './hex/HexGrid.js';
export { HexPathfinder } from './hex/HexPathfinder.js';

// Map
export { WORLD_MAP, DEFAULT_MAP_ID, migrateWorldData, zoneMapConflict, findZonesSpanningMaps } from './hex/MapSchema.js';
export type { MapSchema, TileDefinition, WorldTileDefinition, WorldData, WorldMapMeta, MapTransitionLink } from './hex/MapSchema.js';
export { generateWorldMap, getStartingPosition } from './hex/MapData.js';

// Systems
export { UnlockSystem } from './systems/UnlockSystem.js';

// Room entry requirements
export {
  isRoomGateEmpty,
  toRoomRequirements,
  mergeRoomRequirements,
  validateRoomEntry,
} from './systems/RoomRequirements.js';
export type {
  RoomEntryRequirements,
  RoomEntryMemberInfo,
  RoomEntryLabels,
  RoomEntryFailureKind,
  RoomEntryFailure,
} from './systems/RoomRequirements.js';

// Character stats
export {
  CLASS_DEFINITIONS,
  CLASS_ICONS,
  UNKNOWN_CLASS_ICON,
  SERVER_ICON,
  inlineIconHtml,
  classIconHtml,
  serverIconHtml,
  ALL_CLASS_NAMES,
  CRAFT_SKILL_NAMES,
  getCraftSkillName,
  MAX_GOLD,
  xpForNextLevel,
  totalXpEarned,
  xpForCraftLevel,
  calculateMaxHp,
  calculateBaseDamage,
  createCharacter,
  addXp,
  addCraftXp,
  addGold,
} from './systems/CharacterStats.js';
export type {
  ClassName,
  DamageType,
  CharacterState,
  ClassDefinition,
} from './systems/CharacterStats.js';

// Skill types
export {
  SEED_SKILLS,
  SEED_SKILL_SLOT_SCHEDULES,
  migrateLegacySkill,
  canEquipSkill,
  equipSkillInSlot,
  unequipSkillFromSlot,
  createDefaultSkillLoadout,
  reconcileSkillLoadout,
  getSkillById,
  getSkillsForClass,
  getSlotSchedule,
  getUnlockedSkillsForLevel,
} from './systems/SkillTypes.js';
export type {
  SkillSlotType,
  SkillId,
  SkillSlot,
  PassiveEffectKind,
  PassiveEffect,
  ActiveEffectKind,
  ActiveEffect,
  SkillDefinition,
  SkillLoadout,
  SkillContent,
} from './systems/SkillTypes.js';

// Skill option catalog (admin editor + validation)
export {
  SKILL_OPTION_CATALOG,
  SKILL_CONDITION_VALUES,
  ALL_PASSIVE_EFFECT_KINDS,
  ALL_ACTIVE_EFFECT_KINDS,
  validateSkillDefinition,
} from './systems/SkillOptionCatalog.js';
export type {
  SkillOptionParamSpec,
  SkillOptionDefinition,
} from './systems/SkillOptionCatalog.js';

// Item types
export {
  MAX_STACK,
  RARITY_DROP_RATES,
  EQUIP_SLOTS,
  DISPLAY_EQUIP_SLOTS,
  SEED_ITEMS,
  addItemToInventory,
  removeItemFromInventory,
  equipItem,
  unequipItem,
  destroyItems,
  equipItemForceDestroy,
  computeEquipmentBonuses,
  isTwoHandedEquipped,
  getItemEffectText,
  rollDrops,
} from './systems/ItemTypes.js';
export type {
  ItemRarity,
  EquipSlot,
  ItemDefinition,
  ItemDrop,
  EquipmentBonuses,
} from './systems/ItemTypes.js';

// Inventory views (read-only helpers over inventory + equipment)
export {
  getEquippedCount,
  getUnequippedCount,
  getOwnedCount,
  hasItemEquipped,
  hasUnequipped,
  ownsItem,
  getEquippedItemIds,
  getOwnedItemIds,
  listUnequippedEntries,
} from './systems/InventoryView.js';

// Monster types
export {
  SEED_MONSTERS,
  createMonsterInstance,
} from './systems/MonsterTypes.js';
export type {
  Resistance,
  MonsterSkillEntry,
  MonsterDefinition,
  MonsterInstance,
} from './systems/MonsterTypes.js';

// Monster skills
export {
  MONSTER_SKILL_CATALOG,
} from './systems/MonsterSkills.js';
export type {
  MonsterSkillDefinition,
} from './systems/MonsterSkills.js';

// Encounter types
export {
  SEED_ENCOUNTERS,
  resolveEncounter,
  createEncounter,
} from './systems/EncounterTypes.js';
export type {
  RandomMonsterEntry,
  ExplicitPlacement,
  EncounterDefinition,
} from './systems/EncounterTypes.js';

// Zone types
export {
  SEED_ZONES,
  getZone,
} from './systems/ZoneTypes.js';
export type {
  EncounterTableEntry,
  ZoneDefinition,
} from './systems/ZoneTypes.js';

// Dev seed (procedural world generator)
export {
  generateDevWorld,
  DEV_SEED_VERSION,
  DEV_ZONE_PREFIX,
  DEV_SEED_MARKER_ZONE_ID,
} from './seed/SeedDevWorld.js';
export type {
  DevWorldOutput,
  GenerateOptions as GenerateDevWorldOptions,
} from './seed/SeedDevWorld.js';

// Combat engine
export {
  createPartyCombatState,
  processPartyTick,
  findTarget,
  applyMonsterResistance,
} from './systems/CombatEngine.js';
export type {
  TickResult,
  PartyCombatant,
  CombatMonster,
  PartyCombatState,
  CombatAction,
  DotEffect,
  HotEffect,
  CombatBuff,
  CombatDebuff,
  SunderMark,
} from './systems/CombatEngine.js';

// Battle types & constants
export type {
  BattleTimerState,
  BattleResult,
  PartyState,
  BattleVisual,
  ServerPartyState,
  ClientPlayerCombatant,
  ClientMonsterState,
  ClientCombatAction,
  ClientCombatState,
  ServerBattleState,
  ClientCharacterState,
  OtherPlayerState,
  CombatLogType,
  CombatLogEntry,
  ServerStateMessage,
  ClientMoveMessage,
  ClientRequestStateMessage,
  ClientEquipItemMessage,
  ClientUnequipItemMessage,
  ClientDestroyItemsMessage,
  ClientEquipItemForceDestroyMessage,
  ServerEquipBlockedMessage,
  ServerMoveBlockedMessage,
  ClientSetClassMessage,
  ClientResetXpRateMessage,
  ClientEquipSkillMessage,
  ClientUnequipSkillMessage,
  ClientViewPlayerMessage,
  ClientShopBuyMessage,
  ClientShopSellMessage,
  ClientCraftQueueMessage,
  ClientCraftCancelMessage,
  ClientCraftingState,
  ClientAcceptQuestMessage,
  ClientTurnInQuestMessage,
  PlayerProfileMessage,
  ServerWelcomeBackMessage,
  WelcomeBackItem,
  ServerMessage,
  ServerErrorCode,
  ClientMessage,
} from './systems/BattleTypes.js';
export {
  RESULT_PAUSE,
  MOVE_DURATION,
  RUN_AVAILABLE_ROUNDS,
  GAME_VERSION,
} from './systems/BattleTypes.js';

// Set types
export {
  computeActiveSetBonuses,
  computeGrantedSkillIds,
  mergeSetBonusesIntoEquip,
  getSetInfoForItem,
  getSetsForItem,
  getSetBonusText,
  getSetDisplayName,
  setAppliesToClass,
  getActiveBreakpoint,
  normalizeBreakpoints,
  findSetConflicts,
  migrateLegacySet,
} from './systems/SetTypes.js';
export type {
  SetBonuses,
  SetBreakpoint,
  SetDefinition,
} from './systems/SetTypes.js';

// Shop types
export type {
  ShopItem,
  ShopDefinition,
  ShopSummary,
} from './systems/ShopTypes.js';
export { toShopSummary } from './systems/ShopTypes.js';

export type {
  HenchmanDefinition,
  HiredHenchman,
  HenchmanOffer,
} from './systems/HenchmanTypes.js';
export {
  SEED_HENCHMEN,
  henchmanDisplayNames,
  buildHenchmanCombatant,
} from './systems/HenchmanTypes.js';

// Crafting types
export {
  MAX_CRAFT_QUEUE,
  SEED_RECIPES,
  emptyCraftQueue,
  canQueueRecipe,
  enqueueRecipe,
  cancelJobAt,
  processCompletions,
  getActiveJobProgress,
  getVisibleRecipes,
} from './systems/CraftingTypes.js';
export type {
  RecipeIngredient,
  RecipeResult,
  RecipeDefinition,
  CraftJob,
  CraftQueueState,
  EnqueueError,
  CompletedJobEvent,
  ActiveJobProgress,
} from './systems/CraftingTypes.js';

// NPC types
export { SEED_NPCS } from './systems/NpcTypes.js';
export type { NpcDefinition } from './systems/NpcTypes.js';

// Design note types (MCP-authored content design context)
export type { DesignNote } from './systems/DesignNoteTypes.js';

// Quest types
export {
  getObjectiveTarget,
  objectivesComplete,
  computeStatus,
  canAcceptQuest,
  initialProgress,
} from './systems/QuestTypes.js';
export type {
  QuestStatus,
  QuestScope,
  QuestRepeat,
  KillObjective,
  CollectObjective,
  VisitObjective,
  QuestObjective,
  XpReward,
  GoldReward,
  ItemReward,
  QuestReward,
  QuestDefinition,
  QuestProgressEntry,
  CompletedQuestEntry,
} from './systems/QuestTypes.js';

// Dungeon types
export {
  SEED_DUNGEONS,
  getDungeon,
  validateDungeonEntry,
  rollDungeonRewards,
  rewardAppliesToClass,
} from './systems/DungeonTypes.js';
export type {
  DungeonGridShape,
  DungeonReward,
  DungeonFloor,
  DungeonEntryRequirements,
  DungeonDefinition,
  DungeonRunInfo,
  DungeonEntryMemberInfo,
} from './systems/DungeonTypes.js';

// Social types
export { MAX_PARTY_SIZE, MAX_HENCHMEN_PER_PARTY } from './systems/SocialTypes.js';
export type {
  PlayerListEntry,
  FriendEntry,
  FriendRequest,
  GuildInfo,
  GuildMemberEntry,
  PartyRole,
  PartyGridPosition,
  GamePartyMember,
  GamePartyInfo,
  ChatChannelType,
  ChatMessage,
  ChatChannel,
  BlockLevel,
  ClientSocialState,
  ClientSendFriendRequestMessage,
  ClientAcceptFriendRequestMessage,
  ClientDeclineFriendRequestMessage,
  ClientRevokeFriendRequestMessage,
  ClientRemoveFriendMessage,
  ClientCreateGuildMessage,
  ClientInviteGuildMessage,
  ClientJoinGuildMessage,
  ClientLeaveGuildMessage,
  ClientCreatePartyMessage,
  ClientInvitePartyMessage,
  ClientLeavePartyMessage,
  ClientKickPartyMemberMessage,
  ClientSetPartyGridPositionMessage,
  ClientHireHenchmanMessage,
  ClientDismissHenchmanMessage,
  ClientPromotePartyLeaderMessage,
  ClientDemotePartyMemberMessage,
  ClientTransferPartyOwnershipMessage,
  ClientAcceptPartyInviteMessage,
  ClientDeclinePartyInviteMessage,
  PartyInvite,
  ClientSendChatMessage,
  ClientSyncChatMessage,
  ClientBlockUserMessage,
  ClientUnblockUserMessage,
  ClientSetChatPreferencesMessage,
  ChatPreferences,
  ClientSocialMessage,
  ServerSocialStateMessage,
  ServerChatMessageMessage,
  ServerSyncChatMessage,
  TradeStatus,
  TradeOfferItem,
  TradeOffer,
  TradeState,
  ClientProposeTradeMessage,
  ClientCounterTradeMessage,
  ClientConfirmTradeMessage,
  ClientCancelTradeMessage,
  ClientSendGiftMessage,
  ClientAcceptGiftMessage,
  ClientDenyGiftMessage,
  ServerTradeProposedMessage,
  ServerTradeCancelledMessage,
  ServerTradeCompletedMessage,
  MailboxEntry,
} from './systems/SocialTypes.js';

// Notification framework
export {
  ALL_NOTIFICATION_CHANNELS,
  NOTIFICATION_CATEGORY_META,
  NOTIFICATION_EVENT_REGISTRY,
  getNotificationEventDefinition,
  emptyNotificationPreferences,
  resolveNotificationNavigation,
} from './systems/NotificationTypes.js';
export type {
  NotificationCategory,
  NotificationChannel,
  NotificationCategoryMeta,
  NotificationEventDefinition,
  NotificationPreferences,
  NotificationEntry,
  WebPushSubscription,
  ClientMarkNotificationReadMessage,
  ClientMarkAllNotificationsReadMessage,
  ClientDismissNotificationMessage,
  ClientClearAllNotificationsMessage,
  ClientSetNotificationPreferencesMessage,
  ClientRegisterPushSubscriptionMessage,
  ClientUnregisterPushSubscriptionMessage,
  ClientSetChatFocusMessage,
  ClientNotificationMessage,
  ServerNotificationMessage,
  NotificationNavigationTarget,
} from './systems/NotificationTypes.js';

// Imagery / assets registry
export {
  ASSET_KINDS,
  ASSET_KIND_INFO,
  MANAGED_ASSET_KINDS,
  DEFERRED_ASSET_KINDS,
  ASSET_ID_PATTERN,
  isAssetKind,
  isManagedAssetKind,
  isDeferredAssetKind,
  isValidAssetId,
  assetPublicPath,
  assetFileExtension,
  assetFileExtensions,
  isAudioAssetKind,
  canonicalAssetId,
  UI_CHROME_IDS,
  SFX_IDS,
} from './assets/AssetKinds.js';
export type {
  AssetKind,
  ManagedAssetKind,
  DeferredAssetKind,
  AssetKindInfo,
  AssetIdSource,
  AssetOverrideSource,
  AssetFallback,
  AssetFileFormat,
  SfxId,
} from './assets/AssetKinds.js';

export {
  HOUSE_SELL_REFUND,
  RESTED_MS_PER_SIT_MS,
  RESTED_CAP_MS,
  WELL_RESTED_BONUS,
  houseSellPrice,
  accrueRested,
  isWellRested,
  applyRestedBonus,
  canStore,
  emptyHouse,
  describeHomeLocation,
  validateHouseDefinition,
  SEED_HOUSES,
} from './systems/HousingTypes.js';
export type {
  HouseDefinition,
  HouseOffer,
  PlayerHouse,
  ClientHouseState,
  HomeOccupant,
  HomeView,
  ClientBuyHouseMessage,
  ClientSellHouseMessage,
  ClientEnterHomeMessage,
  ClientLeaveHomeMessage,
  ClientHomeStoreMessage,
  ClientHomeWithdrawMessage,
  ClientHomeDisplayMessage,
  ClientCampfireSitMessage,
  ClientCampfireStandMessage,
  ClientHomeInviteMessage,
  ClientTravelHomeMessage,
  ClientHousingMessage,
  HomeLocation,
} from './systems/HousingTypes.js';

// Core attributes and derived stats
export {
  ATTRIBUTE_NAMES,
  ATTRIBUTE_LABELS,
  ATTRIBUTE_ABBREVIATIONS,
  CLASS_ATTRIBUTE_PROFILES,
  STRENGTH_PER_ARMOR,
  INTELLECT_PER_RESIST,
  CRIT_PER_AGILITY,
  DODGE_PER_AGILITY,
  MAX_ATTRIBUTE_CRIT,
  MAX_ATTRIBUTE_DODGE,
  INTELLECT_HEAL_RATE,
  RARITY_ATTRIBUTE_BUDGET,
  emptyAttributes,
  addAttributes,
  hasAttributes,
  classBaseAttributes,
  itemAttributes,
  equipmentAttributes,
  computeSetAttributes,
  computeDerivedStats,
  derivedToEquipmentBonuses,
  suggestedAttributeBudget,
  validateAttributes,
} from './systems/AttributeTypes.js';
export type {
  AttributeName,
  PrimaryAttribute,
  ClassAttributeProfile,
  AttributeBlock,
  PartialAttributes,
  DerivedStats,
  DerivedStatsInput,
} from './systems/AttributeTypes.js';

// Gear picker / tooltip / compare helpers
export {
  canClassUse,
  slotAccepts,
  itemsForSlot,
  previewEquip,
  statDelta,
  compareEquip,
  describeItemStats,
} from './systems/GearTypes.js';
export type {
  SlotCandidate,
  ItemStatLineKind,
  ItemStatLine,
  DerivedStatKey,
  StatDeltaLine,
} from './systems/GearTypes.js';

// Backpack capacity, bags, Lost & Found
export {
  BACKPACK_BASE_SLOTS,
  BAG_SLOT_COUNT,
  MAX_BAG_SIZE,
  LOST_AND_FOUND_SLOTS,
  STARTER_BAG_ITEM,
  grantStarterBag,
  isBag,
  normalizeBagSlots,
  inventoryCapacity,
  usedInventorySlots,
  freeInventorySlots,
  fitsInventoryChanges,
  canAddToInventory,
  maxAddable,
  equipBag,
  unequipBag,
  routeIncomingItems,
  claimFromPouch,
  validateBagItem,
} from './systems/BagTypes.js';
export type {
  BagSlots,
  InventoryErrorCode,
  BagResult,
  ItemRouting,
  ClientEquipBagMessage,
  ClientUnequipBagMessage,
  ClientClaimLostFoundMessage,
  ClientDiscardLostFoundMessage,
  ClientInventoryMessage,
} from './systems/BagTypes.js';

// Bank
export {
  BANK_BASE_TABS,
  BANK_SLOTS_PER_TAB,
  BANK_TAB_PRICES,
  MAX_BANK_TABS,
  emptyBank,
  normalizeBank,
  nextBankTabPrice,
  addBankTab,
  bankTabUsedSlots,
  canDepositToTab,
  chooseDepositTab,
  bankDeposit,
  bankWithdraw,
  bankMove,
  toClientBankState,
} from './systems/BankTypes.js';
export type {
  PlayerBank,
  ClientBankState,
  BankErrorCode,
  BankResult,
  ClientBankDepositMessage,
  ClientBankWithdrawMessage,
  ClientBankMoveMessage,
  ClientBankBuyTabMessage,
  ClientBankMessage,
} from './systems/BankTypes.js';
