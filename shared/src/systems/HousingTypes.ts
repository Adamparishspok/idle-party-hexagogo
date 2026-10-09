import type { ItemDefinition } from './ItemTypes.js';

/** A preset house a player can buy, authored as content. See docs/architecture/housing.md. */
export interface HouseDefinition {
  id: string;
  name: string;
  description?: string;
  /** 1 = humble cottage … 5 = manor. Display grouping and price band; rules key off the fields below. */
  tier: number;
  /** Gold to buy. */
  price: number;
  /** Distinct item stacks the storage chest holds. */
  storageSlots: number;
  /** Trophy shelf slots — each shows one item. */
  displaySlots: number;
  emoji: string;
  /** Exterior card art URL; falls back to `/house-artwork/{id}.png`, then `emoji`. */
  artworkUrl?: string;
}

/** A house a shop offers, resolved for the estate agent list. */
export interface HouseOffer {
  houseId: string;
  name: string;
  description?: string;
  tier: number;
  price: number;
  storageSlots: number;
  displaySlots: number;
  emoji: string;
  artworkUrl?: string;
}

/** Where a home stands: the estate agent's room it was bought in. */
export interface HomeLocation {
  tileId: string;
  mapId: string;
  col: number;
  row: number;
  roomName: string;
  zoneName?: string;
}

/** What a player owns, as persisted. */
export interface PlayerHouse {
  houseId: string;
  purchasedAt: number;
  /** Room GUID the home stands in. Absent on homes bought before homes had a place. */
  tileId?: string;
  /** itemId → count. At most `storageSlots` distinct ids. */
  storage: Record<string, number>;
  /** One itemId (or null) per shelf slot; length == displaySlots of the house when bought/upgraded. */
  displays: (string | null)[];
}

/** The owner's own house, sent on every state push. */
export interface ClientHouseState {
  house: PlayerHouse;
  definition: HouseDefinition;
  location?: HomeLocation;
}

export interface HomeOccupant {
  username: string;
  className?: string;
  level?: number;
  sitting: boolean;
}

/** The home the viewer is currently inside (their own or a visit). */
export interface HomeView {
  owner: string;
  definition: HouseDefinition;
  location?: HomeLocation;
  displays: (string | null)[];
  /** Only for the owner — visitors never see the chest. */
  storage?: Record<string, number>;
  occupants: HomeOccupant[];
  /** Definitions for every item on the shelves (and in storage, for the owner). */
  itemDefinitions: Record<string, ItemDefinition>;
}

// ── Client → server ──────────────────────────────────────────

export interface ClientBuyHouseMessage { type: 'buy_house'; houseId: string }
export interface ClientSellHouseMessage { type: 'sell_house' }
/** `owner` omitted = your own home. */
export interface ClientEnterHomeMessage { type: 'enter_home'; owner?: string }
export interface ClientLeaveHomeMessage { type: 'leave_home' }
export interface ClientHomeStoreMessage { type: 'home_store'; itemId: string; quantity: number }
export interface ClientHomeWithdrawMessage { type: 'home_withdraw'; itemId: string; quantity: number }
/** Put one stored item on a shelf (`itemId`) or return the shelf's item to storage (`itemId: null`). */
export interface ClientHomeDisplayMessage { type: 'home_display'; slot: number; itemId: string | null }
export interface ClientCampfireSitMessage { type: 'campfire_sit' }
export interface ClientCampfireStandMessage { type: 'campfire_stand' }
export interface ClientHomeInviteMessage { type: 'home_invite'; username: string }
/** Walk the party to a home's room; it is entered on arrival. `owner` omitted = your own home. */
export interface ClientTravelHomeMessage { type: 'travel_home'; owner?: string }

export type ClientHousingMessage =
  | ClientBuyHouseMessage
  | ClientSellHouseMessage
  | ClientEnterHomeMessage
  | ClientLeaveHomeMessage
  | ClientHomeStoreMessage
  | ClientHomeWithdrawMessage
  | ClientHomeDisplayMessage
  | ClientCampfireSitMessage
  | ClientCampfireStandMessage
  | ClientHomeInviteMessage
  | ClientTravelHomeMessage;

// ── Rules ────────────────────────────────────────────────────

/** Fraction of the purchase price returned on sale. */
export const HOUSE_SELL_REFUND = 0.5;
/** Well Rested earned per minute sitting at a campfire. */
export const RESTED_MS_PER_SIT_MS = 12;
/** Well Rested never stacks beyond this much remaining time. */
export const RESTED_CAP_MS = 8 * 60 * 60 * 1000;
/** XP and gold multiplier while Well Rested. */
export const WELL_RESTED_BONUS = 1.1;

export function houseSellPrice(def: Pick<HouseDefinition, 'price'>): number {
  return Math.floor(def.price * HOUSE_SELL_REFUND);
}

/** New `wellRestedUntil` after sitting from `sitStart` to `now`. */
export function accrueRested(currentUntil: number | undefined, sitStart: number, now: number): number {
  const sat = Math.max(0, now - sitStart);
  const base = Math.max(currentUntil ?? 0, now);
  return Math.min(base + sat * RESTED_MS_PER_SIT_MS, now + RESTED_CAP_MS);
}

export function isWellRested(wellRestedUntil: number | undefined, now: number): boolean {
  return (wellRestedUntil ?? 0) > now;
}

/** Gold/XP amount after the Well Rested bonus (floored). */
export function applyRestedBonus(amount: number, wellRestedUntil: number | undefined, now: number): number {
  return isWellRested(wellRestedUntil, now) ? Math.floor(amount * WELL_RESTED_BONUS) : amount;
}

/** Whether `quantity` of `itemId` fits in the chest (a new id needs a free slot). */
export function canStore(house: PlayerHouse, def: Pick<HouseDefinition, 'storageSlots'>, itemId: string, quantity: number): boolean {
  if (quantity <= 0) return false;
  if ((house.storage[itemId] ?? 0) > 0) return true;
  const used = Object.values(house.storage).filter(n => n > 0).length;
  return used < def.storageSlots;
}

export function emptyHouse(def: HouseDefinition, now: number, tileId?: string): PlayerHouse {
  return {
    houseId: def.id,
    purchasedAt: now,
    ...(tileId ? { tileId } : {}),
    storage: {},
    displays: Array.from({ length: def.displaySlots }, () => null),
  };
}

/** "Hatchetmill · General Store", or just the room name when the zone is unknown. */
export function describeHomeLocation(location: Pick<HomeLocation, 'roomName' | 'zoneName'>): string {
  const room = location.roomName || 'an unnamed room';
  return location.zoneName ? `${location.zoneName} · ${room}` : room;
}

const MAX_HOUSE_TIER = 5;

/** Shape check for authored houses. Returns an error message, or null when valid. */
export function validateHouseDefinition(def: Partial<HouseDefinition>): string | null {
  if (typeof def.id !== 'string' || !def.id) return 'House needs an id.';
  if (typeof def.name !== 'string' || !def.name.trim()) return 'House needs a name.';
  if (typeof def.emoji !== 'string' || !def.emoji) return 'House needs an emoji.';
  if (!Number.isInteger(def.tier) || def.tier! < 1 || def.tier! > MAX_HOUSE_TIER) return `House tier must be a whole number from 1 to ${MAX_HOUSE_TIER}.`;
  if (!Number.isInteger(def.price) || def.price! < 0) return 'House price must be a whole number of gold, 0 or more.';
  if (!Number.isInteger(def.storageSlots) || def.storageSlots! < 0) return 'House storageSlots must be a whole number, 0 or more.';
  if (!Number.isInteger(def.displaySlots) || def.displaySlots! < 0) return 'House displaySlots must be a whole number, 0 or more.';
  return null;
}

/** Starter houses `ContentStore` seeds into a fresh world. */
export const SEED_HOUSES: Record<string, HouseDefinition> = {
  cottage: {
    id: 'cottage',
    name: 'Cottage',
    description: 'A snug one-room cottage with a hearth and a sturdy chest.',
    tier: 1,
    price: 1000,
    storageSlots: 6,
    displaySlots: 3,
    emoji: '🛖',
  },
  townhouse: {
    id: 'townhouse',
    name: 'Townhouse',
    description: 'Two storeys on a quiet lane, with room to show off your finds.',
    tier: 2,
    price: 5000,
    storageSlots: 12,
    displaySlots: 6,
    emoji: '🏠',
  },
  manor: {
    id: 'manor',
    name: 'Manor',
    description: 'A grand estate with a trophy hall and a vault for your treasures.',
    tier: 3,
    price: 25000,
    storageSlots: 24,
    displaySlots: 10,
    emoji: '🏰',
  },
};
