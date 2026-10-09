import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SkillSlot, WorldData, WorldTileDefinition } from '@idle-party-rpg/shared';
import { SKILL_OPTION_CATALOG } from '@idle-party-rpg/shared';
import { DRAFT_CONTENT_TYPES } from '../../game/DraftEditor.js';
import type { DraftContentType } from '../../game/DraftEditor.js';
import type { McpToolDeps } from './McpToolDeps.js';
import { toolResult, errorMessage } from './mcpResult.js';

/** The 15 content types editable through the generic draft-write surface — single source of truth, shared with writeTools.ts. */
const CONTENT_TYPES = DRAFT_CONTENT_TYPES;

/** Per-type field-shape cheat sheet, verbatim — used by `get_content_schema` so the calling AI doesn't have to guess field names. */
const CONTENT_TYPE_DESCRIPTIONS: Record<DraftContentType, string> = {
  monsters: "MonsterDefinition — id, name, hp, damage, damageType ('physical'|'magical'|'holy'), xp, goldMin, goldMax, optional description (combat-popup flavor text), optional drops (ItemDrop[]: {itemId, chance}), optional resistances (Resistance[]: {damageType, flatReduction, percentReduction}), optional skills (MonsterSkillEntry[]: {skillId, value, cooldown}), optional passive:true (makes it a \"wall\": never attacks, doesn't count toward victory — use for tactical obstacles, not real enemies).",
  items: "ItemDefinition — id, name, rarity ('janky'|'common'|'uncommon'|'rare'|'epic'|'legendary'|'heirloom'), optional equipSlot (NOT 'slot'; EquipSlot union: head/shoulders/chest/bracers/gloves/mainhand/offhand/twohanded/foot/ring/necklace/back/relic — omit entirely for non-equippable items), optional bonusAttackMin/Max, damageReductionMin/Max, magicReductionMin/Max, optional classRestriction (string[] of class names that can equip), optional value (gold sell price), optional consumable (boolean placeholder, no effect yet), optional iconEmoji (overrides the slot-based icon), optional iconColor (CSS color for the icon tint), optional grantedSkillIds (skills equippable ONLY while this item is equipped), optional attributes (PartialAttributes: {strength?, agility?, intellect?, stamina?} whole numbers; heirlooms are authored per level and scale by the wearer's level), optional bagSlots (whole number 1-24 — makes the item a BAG: it must have NO equipSlot, sits in one of 4 bag slots and adds that many backpack slots; 'travelers_satchel' is the starter bag every character gets and cannot be deleted). Attribute budget (guidance, not enforced): points = max(1, round(itemLevel × rarityFactor / 4)), doubled for two-handers; rarityFactor janky 0.5, common 0.75, uncommon 1, rare 1.25, epic 1.5, legendary 2; heirlooms 1 point (2 for 2H) per level. Stamina → HP (per class rate), the class primary (Knight STR, Archer AGI, Priest/Mage/Bard INT) → damage, STR → armor (1 per 15), INT → resist (1 per 15) and gear INT → healing, AGI → crit/dodge. Legacy damageReduction = Armor, magicReduction = Resist.",
  sets: 'SetDefinition — id, name, itemIds (string[]), optional classRestriction, breakpoints (SetBreakpoint[]: {piecesRequired, bonuses: SetBonuses}). Bonuses do NOT stack across tiers within one set (highest unlocked tier wins) but DO stack across different sets. SetBonuses (every field optional): cooldownReduction, damagePercent, damageResistancePercent, damageReductionMin/Max, magicReductionMin/Max, bonusAttackMin/Max, flatHp, percentHp, grantedSkillIds, attributes (PartialAttributes: {strength?, agility?, intellect?, stamina?} whole numbers).',
  shops: 'ShopDefinition — id, name, inventory (ShopItem[]: {itemId, price} — there is no stock field), optional henchmanIds (string[] of HenchmanDefinition ids this shop offers for hire — hires are free, so there is no price to pair with them), optional houseIds (string[] of HouseDefinition ids this shop sells — a shop with houseIds is an estate agent; the price lives on the house, not here).',
  henchmen: "HenchmanDefinition — id, name, optional description (flavour line shown in the hire list), className ('Knight'|'Archer'|'Priest'|'Mage'|'Bard'), level, maxHp, baseDamage, optional damageType ('physical'|'magical'|'holy', overrides the archetype's damage type when set), skillIds (string[] of skill definition ids — the fixed loadout; ids the live server lacks resolve to an empty slot), emoji (REQUIRED, always renders even with no artwork), optional artworkUrl. Stats are FIXED: a henchman never levels, holds no equipment and has no inventory, so the definition is the whole of its power (level is a cosmetic display number — the stats above are authoritative, not derived from it). className is a HIDDEN combat archetype, not a player-facing label: the engine keys class checks off it (Sanctuary targeting, War Cry's targetClass, Martyr, monster all_class skill filters), but the hire UI never shows it. A shop offers henchmen for hire via its own henchmanIds array — there is no room/tile field for henchmen and no separate henchmen-shop content type.",
  houses: "HouseDefinition — id, name, optional description, tier (whole number 1-5: display grouping and price band only), price (whole gold, >=0), storageSlots (whole number >=0: distinct item stacks the owner's chest holds), displaySlots (whole number >=0: trophy shelf slots, each showing one item to visitors), emoji (REQUIRED, always renders even with no artwork), optional artworkUrl (exterior card art; falls back to /house-artwork/{id}.png, then the emoji). Players buy a house from a shop that lists its id in ShopDefinition.houseIds, own at most one, and sell it back for half the price. Shelf count is fixed when a player buys, so lowering displaySlots later doesn't shrink existing homes; lowering storageSlots only blocks new stacks. A house a shop still sells can't be deleted.",
  recipes: 'RecipeDefinition — id, name, optional description, optional classRestriction (string[] of classes that can craft), optional requiredLevel, durationSeconds (>0), optional xpReward (craft XP, default 0), ingredients (RecipeIngredient[]: {itemId, quantity>0}), result ({itemId, quantity>0}).',
  npcs: 'NpcDefinition — id, name, emoji (REQUIRED, always renders even with no artwork), greeting, optional artworkUrl, optional questIds (string[] quests this NPC offers).',
  quests: "QuestDefinition — id, name, description, scope ('solo' — only acceptable while in a solo party — or 'party_shared'), objectives ({kind:'kill', monsterId, count} | {kind:'collect', itemId, count} — consumed on turn-in | {kind:'visit', tileId}), rewards ({kind:'xp', amount} | {kind:'gold', amount} | {kind:'item', itemId, quantity}), optional prerequisiteQuestIds, optional requiredLevel, optional repeat ('once'|'weekly', default 'once'), optional completionText (NPC speech shown after the player turns the quest in).",
  dungeons: 'DungeonDefinition — id, name, optional description, floors (DungeonFloor[]: {floorNumber, gridShape:{cols,rows}, encounterTable ({encounterId, weight}[]), optional isBoss, optional rewards}), optional entryRequirements ({minLevel?,maxLevel?,requiredItemId?,consumeRequiredItem?,requiredClasses? (class names),minPartySize?,maxPartySize?}), optional firstClearRewards + flat firstClearXp/firstClearGold. Floor rewards and firstClearRewards are DungeonReward[]: {itemId, chance (0-1), minQty? (default 1), maxQty? (default 1), classRestriction? (class names)}.',
  zones: 'ZoneDefinition — id, displayName (NOTE: zones use displayName, NOT name), levelRange ([min, max] tuple), encounterTable (EncounterTableEntry[]: {encounterId, weight}).',
  encounters: "EncounterDefinition — id, name, type ('random'|'explicit'), optional monsterPool (random type: {monsterId,min,max}[]), optional placements (explicit type: {monsterId, gridPosition 0-8}[]), optional roomMax.",
  tileTypes: 'TileTypeDefinition — id, name, icon (emoji), color (hex like #ff0000), traversable (boolean), optional entryRequirements ({minLevel?,requiredItemId?,requiredQuestIds?}) — the default entry gate for every room of this type, which rooms override field by field; legacy top-level requiredItemId is still honoured and folded into the gate.',
  skills: "SkillDefinition — id, name, description, className, type ('passive'|'active'), unlockLevel (number, or null = grant-only via item/set, never level-learned), sortOrder, optional cooldown (actives only — triggers every Nth attack), optional passiveEffects[] (passive or active skills) and/or optional activeEffects[] (active skills only) — each effect's \"kind\" must be one from SKILL_OPTION_CATALOG (import { SKILL_OPTION_CATALOG } from '@idle-party-rpg/shared' — Record<string,SkillOptionDefinition> with {kind,slotType,label,description,targeting,params}). Percent params are stored as 0-1 fractions, not 0-100.",
  designNotes: 'DesignNote — id, title, body (markdown), optional tags (string[]), author (server fills this from the token label, do not accept from caller input), createdAt/updatedAt (server fills, ISO timestamps via new Date().toISOString()).',
};

/** Points callers at the REST admin API for anything MCP doesn't surface — the MCP bearer token authenticates there too. */
export const REST_API_FALLBACK = {
  note: 'MCP does not expose every route or field. The bearer token this MCP client sends also authenticates the REST admin API on the same host (Authorization: Bearer <token>) — use it for anything missing here, and report the gap.',
  fullLiveExport: 'GET /api/admin/content',
  fullVersionExport: 'GET /api/admin/versions/{versionId}/content',
  openApiDocs: '/api-docs/admin',
};

function versionNotFoundError(versionId: string): string {
  return `Version '${versionId}' no longer exists — it may have been deleted between calls. Stop and check with the user before proceeding.`;
}

/** Reads a type's array from the live `ContentStore` (design notes included). */
function getLiveContentArray(deps: McpToolDeps, type: DraftContentType): unknown[] {
  const store = deps.contentStore();
  switch (type) {
    case 'monsters': return Object.values(store.getAllMonsters());
    case 'items': return Object.values(store.getAllItems());
    case 'sets': return Object.values(store.getAllSets());
    case 'shops': return Object.values(store.getAllShops());
    case 'henchmen': return Object.values(store.getAllHenchmen());
    case 'houses': return Object.values(store.getAllHouses());
    case 'recipes': return Object.values(store.getAllRecipes());
    case 'npcs': return Object.values(store.getAllNpcs());
    case 'quests': return Object.values(store.getAllQuests());
    case 'dungeons': return Object.values(store.getAllDungeons());
    case 'zones': return Object.values(store.getAllZones());
    case 'encounters': return Object.values(store.getAllEncounters());
    case 'tileTypes': return Object.values(store.getAllTileTypes());
    case 'skills': return Object.values(store.getAllSkills());
    case 'designNotes': return Object.values(store.getAllDesignNotes());
  }
}

/**
 * Resolves a content type's array against either a draft snapshot (`versionId` given) or
 * live content (`versionId` omitted). Shared by `list_content` and `get_content` so both
 * honor the same "halt on phantom version" rule.
 */
async function resolveContentArray(
  deps: McpToolDeps,
  type: DraftContentType,
  versionId: string | undefined
): Promise<{ array: unknown[] } | { error: string }> {
  if (!versionId) return { array: getLiveContentArray(deps, type) };
  const version = deps.versionStore().get(versionId);
  if (!version) return { error: versionNotFoundError(versionId) };
  const snapshot = await deps.versionStore().loadSnapshot(versionId);
  return { array: deps.draftEditor.getContentArray(type, snapshot) };
}

/** Stored room fields in the column order `format: 'table'` uses; any unlisted field is appended after these. */
const TILE_FIELDS = [
  'id', 'mapId', 'col', 'row', 'type', 'zone', 'name', 'encounterTable', 'shopId', 'npcId',
  'dungeonId', 'requiredItemId', 'entryRequirements', 'transitions',
] as const;

export interface GetWorldArgs {
  versionId?: string;
  mapId?: string;
  zone?: string;
  area?: { colMin?: number; colMax?: number; rowMin?: number; rowMax?: number };
  fields?: string[];
  format?: 'objects' | 'table';
}

function filterTiles(tiles: WorldTileDefinition[], args: GetWorldArgs): WorldTileDefinition[] {
  const { mapId, zone, area } = args;
  return tiles.filter(t =>
    (!mapId || t.mapId === mapId)
    && (!zone || t.zone === zone)
    && (area?.colMin === undefined || t.col >= area.colMin)
    && (area?.colMax === undefined || t.col <= area.colMax)
    && (area?.rowMin === undefined || t.row >= area.rowMin)
    && (area?.rowMax === undefined || t.row <= area.rowMax));
}

function tileColumns(tiles: WorldTileDefinition[], fields: string[] | undefined): string[] {
  if (fields && fields.length > 0) return fields;
  const present = new Set<string>();
  for (const tile of tiles) for (const [key, value] of Object.entries(tile)) if (value !== undefined) present.add(key);
  const ordered: string[] = TILE_FIELDS.filter(f => present.has(f));
  for (const key of present) if (!ordered.includes(key)) ordered.push(key);
  return ordered;
}

function worldResult(world: WorldData, args: GetWorldArgs) {
  const tiles = filterTiles(world.tiles, args);
  const header = { maps: world.maps, defaultMapId: world.defaultMapId, startTile: world.startTile, tileCount: tiles.length };
  const columns = tileColumns(tiles, args.fields);
  const asRecords = tiles as unknown as Record<string, unknown>[];
  if (args.format === 'table') {
    return { ...header, columns, rows: asRecords.map(tile => columns.map(c => tile[c] ?? null)) };
  }
  if (!args.fields || args.fields.length === 0) return { ...header, tiles };
  return { ...header, tiles: asRecords.map(tile => Object.fromEntries(columns.filter(c => tile[c] !== undefined).map(c => [c, tile[c]]))) };
}

export async function getOverview(deps: McpToolDeps) {
  try {
    const store = deps.contentStore();
    const counts = {
      monsters: Object.keys(store.getAllMonsters()).length,
      items: Object.keys(store.getAllItems()).length,
      zones: Object.keys(store.getAllZones()).length,
      encounters: Object.keys(store.getAllEncounters()).length,
      sets: Object.keys(store.getAllSets()).length,
      shops: Object.keys(store.getAllShops()).length,
      henchmen: Object.keys(store.getAllHenchmen()).length,
      houses: Object.keys(store.getAllHouses()).length,
      tileTypes: Object.keys(store.getAllTileTypes()).length,
      recipes: Object.keys(store.getAllRecipes()).length,
      npcs: Object.keys(store.getAllNpcs()).length,
      quests: Object.keys(store.getAllQuests()).length,
      dungeons: Object.keys(store.getAllDungeons()).length,
      skills: Object.keys(store.getAllSkills()).length,
      designNotes: Object.keys(store.getAllDesignNotes()).length,
    };
    const versionStore = deps.versionStore();
    const versions = versionStore.getAll().map(v => ({ id: v.id, name: v.name, status: v.status, isActive: v.isActive }));
    const activeVersionId = versionStore.getActiveVersionId();
    return { counts, versions, activeVersionId, restApi: REST_API_FALLBACK };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function listVersions(deps: McpToolDeps) {
  try {
    const versionStore = deps.versionStore();
    return { versions: versionStore.getAll(), activeVersionId: versionStore.getActiveVersionId() };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function listContent(deps: McpToolDeps, args: { type: DraftContentType; versionId?: string }) {
  try {
    const resolved = await resolveContentArray(deps, args.type, args.versionId);
    if ('error' in resolved) return { error: resolved.error };
    const entries = (resolved.array as Array<Record<string, unknown>>).map(entry => ({
      id: entry.id as string,
      label: (entry.name ?? entry.displayName ?? entry.title ?? entry.id) as string,
    }));
    return { type: args.type, versionId: args.versionId ?? null, count: entries.length, entries };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function getContent(deps: McpToolDeps, args: { type: DraftContentType; id: string; versionId?: string }) {
  try {
    const resolved = await resolveContentArray(deps, args.type, args.versionId);
    if ('error' in resolved) return { error: resolved.error };
    const entry = (resolved.array as Array<{ id: string }>).find(e => e.id === args.id);
    if (!entry) return { error: `Not found: ${args.type} "${args.id}".` };
    return entry;
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function getWorld(deps: McpToolDeps, args: GetWorldArgs) {
  try {
    if (args.versionId) {
      const version = deps.versionStore().get(args.versionId);
      if (!version) return { error: versionNotFoundError(args.versionId) };
      const snapshot = await deps.versionStore().loadSnapshot(args.versionId);
      return worldResult(snapshot.world, args);
    }
    return worldResult(deps.contentStore().getWorld(), args);
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function getSkillSlots(deps: McpToolDeps, args: { versionId?: string }) {
  try {
    if (!args.versionId) return { versionId: null, schedules: deps.contentStore().getAllSkillSlotSchedules() };
    const version = deps.versionStore().get(args.versionId);
    if (!version) return { error: versionNotFoundError(args.versionId) };
    const snapshot = await deps.versionStore().loadSnapshot(args.versionId);
    // keep-when-absent: a snapshot predating slot schedules inherits live ones on publish
    if (snapshot.skillSlotSchedules === undefined) {
      return { versionId: args.versionId, schedules: deps.contentStore().getAllSkillSlotSchedules() };
    }
    const schedules: Record<string, SkillSlot[]> = {};
    for (const entry of snapshot.skillSlotSchedules) schedules[entry.className] = entry.slots;
    return { versionId: args.versionId, schedules };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function getContentSchema(args: { type: DraftContentType }) {
  try {
    const description = CONTENT_TYPE_DESCRIPTIONS[args.type];
    if (args.type === 'skills') {
      return { type: args.type, description, skillOptionCatalog: SKILL_OPTION_CATALOG };
    }
    return { type: args.type, description };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export function registerReadTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'get_overview',
    {
      description: 'Content-catalog counts per type (monsters, items, zones, etc.) from live content, plus the list of content versions and which one is active.',
      inputSchema: {},
    },
    async () => {
      const result = await getOverview(deps);
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_versions',
    {
      description: 'List all content versions (drafts and published) and the currently active version id.',
      inputSchema: {},
    },
    async () => {
      const result = await listVersions(deps);
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_content',
    {
      description: 'List a light index (id + label) of every entry of one content type, either from live content or from a draft version snapshot.',
      inputSchema: {
        type: z.enum(CONTENT_TYPES).describe('Which content type to list.'),
        versionId: z.string().optional().describe('If given, list from this draft/version snapshot instead of live content.'),
      },
    },
    async (args) => {
      const result = await listContent(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_content',
    {
      description: 'Fetch the full definition of a single content entry by id, either from live content or from a draft version snapshot.',
      inputSchema: {
        type: z.enum(CONTENT_TYPES).describe('Which content type to look in.'),
        id: z.string().describe('The id of the entry to fetch.'),
        versionId: z.string().optional().describe('If given, look in this draft/version snapshot instead of live content.'),
      },
    },
    async (args) => {
      const result = await getContent(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_world',
    {
      description: "Fetch world data (maps, default map, start tile, and rooms/tiles), either from live content or from a draft version snapshot. On a big world, narrow it: filter by mapId/zone/area, pick only the fields you need, and use format 'table' to stop repeating every key on every room.",
      inputSchema: {
        versionId: z.string().optional().describe('If given, read world data from this draft/version snapshot instead of live content.'),
        mapId: z.string().optional().describe('If given, only return tiles belonging to this map.'),
        zone: z.string().optional().describe('If given, only return tiles in this zone id.'),
        area: z.object({
          colMin: z.number().optional(),
          colMax: z.number().optional(),
          rowMin: z.number().optional(),
          rowMax: z.number().optional(),
        }).optional().describe('Inclusive col/row bounds; omitted bounds are open.'),
        fields: z.array(z.string()).optional().describe(`Only return these room fields (e.g. ['col','row','zone','name']). Known fields: ${TILE_FIELDS.join(', ')}.`),
        format: z.enum(['objects', 'table']).optional().describe("'objects' (default): tiles as an array of objects. 'table': columns (field names, once) + rows (one value array per room, null = field absent)."),
      },
    },
    async (args) => {
      const result = await getWorld(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_skill_slots',
    {
      description: 'Fetch every class\'s skill-slot unlock schedule (className -> slots), either from live content or from a draft version snapshot. Pair with set_skill_slots.',
      inputSchema: {
        versionId: z.string().optional().describe('If given, read from this draft/version snapshot instead of live content.'),
      },
    },
    async (args) => {
      const result = await getSkillSlots(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_content_schema',
    {
      description: "Field-shape cheat sheet for one content type — what fields it has, which are optional, and their quirks. For 'skills', also includes the full SKILL_OPTION_CATALOG of valid effect kinds.",
      inputSchema: {
        type: z.enum(CONTENT_TYPES).describe('Which content type to describe.'),
      },
    },
    async (args) => {
      const result = await getContentSchema(args);
      return toolResult(result);
    }
  );
}
