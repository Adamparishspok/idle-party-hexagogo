import type { ItemDefinition } from './ItemTypes.js';
import { MAX_STACK } from './ItemTypes.js';

// See docs/architecture/gear-stats-bank.md → Bags and Lost & Found.

// --- Types ---

type Inventory = Record<string, number>;

/** One entry per bag slot: the equipped bag's item id, or null. */
export type BagSlots = (string | null)[];

export type InventoryErrorCode =
  | 'inventory_full'
  | 'bag_invalid_slot'
  | 'bag_not_a_bag'
  | 'bag_item_missing'
  | 'bag_slot_empty'
  | 'bag_no_room'
  | 'lost_found_item_missing';

export type BagResult =
  | { ok: true; returnedItemId?: string }
  | { ok: false; error: InventoryErrorCode };

/** Where incoming items went. `lost` were dropped because the pouch was full too. */
export interface ItemRouting {
  toInventory: number;
  toPouch: number;
  lost: number;
}

export interface ClientEquipBagMessage { type: 'equip_bag'; itemId: string; bagIndex: number }
export interface ClientUnequipBagMessage { type: 'unequip_bag'; bagIndex: number }
/** `itemId` omitted = claim everything that fits. */
export interface ClientClaimLostFoundMessage { type: 'claim_lost_found'; itemId?: string }
export interface ClientDiscardLostFoundMessage { type: 'discard_lost_found'; itemId: string }

export type ClientInventoryMessage =
  | ClientEquipBagMessage
  | ClientUnequipBagMessage
  | ClientClaimLostFoundMessage
  | ClientDiscardLostFoundMessage;

// --- Constants ---

/** Distinct item stacks the backpack holds with no bags. */
export const BACKPACK_BASE_SLOTS = 20;
export const BAG_SLOT_COUNT = 4;
export const MAX_BAG_SIZE = 24;
/** Distinct stacks the Lost & Found pouch holds; past this, incoming items are lost. */
export const LOST_AND_FOUND_SLOTS = 20;

/** One-time gift to every character (`starterBagGranted` in the save). The server ensures this item exists in content. */
export const STARTER_BAG_ITEM: ItemDefinition = {
  id: 'travelers_satchel',
  name: "Traveler's Satchel",
  rarity: 'common',
  bagSlots: 12,
  value: 1,
  iconEmoji: '🎒',
};

/** Bags a fresh world's content starts with (alongside STARTER_BAG_ITEM). Live servers author their own. */
export const SEED_BAG_ITEMS: ItemDefinition[] = [
  { id: 'small_pouch', name: 'Small Pouch', rarity: 'common', bagSlots: 4, value: 25, iconEmoji: '👝' },
  { id: 'cloth_bag', name: 'Cloth Bag', rarity: 'common', bagSlots: 6, value: 60, iconEmoji: '💰' },
  { id: 'leather_pack', name: 'Leather Pack', rarity: 'uncommon', bagSlots: 8, value: 150, iconEmoji: '🎒' },
];

// --- Pure functions ---

export function isBag(def: ItemDefinition | undefined): boolean {
  return !!def && !def.equipSlot && (def.bagSlots ?? 0) > 0;
}

/** Restores a saved bag row to exactly BAG_SLOT_COUNT entries. */
export function normalizeBagSlots(saved: BagSlots | undefined): BagSlots {
  const out: BagSlots = [];
  for (let i = 0; i < BAG_SLOT_COUNT; i++) out.push(saved?.[i] ?? null);
  return out;
}

export function inventoryCapacity(bags: BagSlots, items: Record<string, ItemDefinition>): number {
  let total = BACKPACK_BASE_SLOTS;
  for (const id of bags) {
    if (!id) continue;
    const def = items[id];
    if (isBag(def)) total += Math.min(MAX_BAG_SIZE, def!.bagSlots!);
  }
  return total;
}

/** Distinct stacks in the backpack. Equipped gear and equipped bags live elsewhere and never count. */
export function usedInventorySlots(inventory: Inventory): number {
  let used = 0;
  for (const count of Object.values(inventory)) if (count > 0) used++;
  return used;
}

export function freeInventorySlots(inventory: Inventory, capacity: number): number {
  return Math.max(0, capacity - usedInventorySlots(inventory));
}

/**
 * Whether applying `changes` (itemId → signed delta) keeps the backpack legal.
 * keep-overflow: an already over-capacity backpack (legacy save) may not grow its overflow, but may keep it.
 */
export function fitsInventoryChanges(
  inventory: Inventory,
  capacity: number,
  changes: Record<string, number>,
  capacityAfter: number = capacity,
): boolean {
  let usedAfter = usedInventorySlots(inventory);
  for (const [itemId, delta] of Object.entries(changes)) {
    const before = inventory[itemId] ?? 0;
    const after = before + delta;
    if (after < 0 || after > MAX_STACK) return false;
    if (before <= 0 && after > 0) usedAfter++;
    if (before > 0 && after <= 0) usedAfter--;
  }
  if (usedAfter <= capacityAfter) return true;
  const overflowBefore = Math.max(0, usedInventorySlots(inventory) - capacity);
  return usedAfter - capacityAfter <= overflowBefore;
}

export function canAddToInventory(inventory: Inventory, capacity: number, itemId: string, quantity: number): boolean {
  if (quantity <= 0) return false;
  return fitsInventoryChanges(inventory, capacity, { [itemId]: quantity });
}

/** How many copies of `itemId` could be added right now. */
export function maxAddable(inventory: Inventory, capacity: number, itemId: string): number {
  const current = inventory[itemId] ?? 0;
  if (current > 0) return Math.max(0, MAX_STACK - current);
  return usedInventorySlots(inventory) < capacity ? MAX_STACK : 0;
}

/** Put a bag from the backpack into a bag slot; a bag already there goes back to the backpack. */
export function equipBag(
  inventory: Inventory,
  bags: BagSlots,
  bagIndex: number,
  itemId: string,
  items: Record<string, ItemDefinition>,
): BagResult {
  if (!Number.isInteger(bagIndex) || bagIndex < 0 || bagIndex >= BAG_SLOT_COUNT) return { ok: false, error: 'bag_invalid_slot' };
  if (!isBag(items[itemId])) return { ok: false, error: 'bag_not_a_bag' };
  if ((inventory[itemId] ?? 0) <= 0) return { ok: false, error: 'bag_item_missing' };

  const previous = bags[bagIndex] ?? null;
  const capacity = inventoryCapacity(bags, items);
  const nextBags = [...bags];
  nextBags[bagIndex] = itemId;
  const changes: Record<string, number> = { [itemId]: -1 };
  if (previous) changes[previous] = (changes[previous] ?? 0) + 1;
  if (!fitsInventoryChanges(inventory, capacity, changes, inventoryCapacity(nextBags, items))) return { ok: false, error: 'bag_no_room' };

  applyChanges(inventory, changes);
  bags[bagIndex] = itemId;
  return previous ? { ok: true, returnedItemId: previous } : { ok: true };
}

/** Take a bag out of its slot; refused when the smaller backpack couldn't hold everything plus the bag. */
export function unequipBag(
  inventory: Inventory,
  bags: BagSlots,
  bagIndex: number,
  items: Record<string, ItemDefinition>,
): BagResult {
  if (!Number.isInteger(bagIndex) || bagIndex < 0 || bagIndex >= BAG_SLOT_COUNT) return { ok: false, error: 'bag_invalid_slot' };
  const current = bags[bagIndex] ?? null;
  if (!current) return { ok: false, error: 'bag_slot_empty' };

  const capacity = inventoryCapacity(bags, items);
  const nextBags = [...bags];
  nextBags[bagIndex] = null;
  const changes = { [current]: 1 };
  if (!fitsInventoryChanges(inventory, capacity, changes, inventoryCapacity(nextBags, items))) return { ok: false, error: 'bag_no_room' };

  applyChanges(inventory, changes);
  bags[bagIndex] = null;
  return { ok: true, returnedItemId: current };
}

/** Puts the starter bag in the first empty bag slot, else the backpack (ignoring capacity — it's a gift). */
export function grantStarterBag(bags: BagSlots, inventory: Inventory, bagItemId: string = STARTER_BAG_ITEM.id): 'bag_slot' | 'backpack' {
  const free = bags.indexOf(null);
  if (free >= 0) {
    bags[free] = bagItemId;
    return 'bag_slot';
  }
  inventory[bagItemId] = Math.min(MAX_STACK, (inventory[bagItemId] ?? 0) + 1);
  return 'backpack';
}

/** Delivers unattended items (loot, rewards, finished crafts): backpack, then pouch, then lost. Mutates both. */
export function routeIncomingItems(
  inventory: Inventory,
  capacity: number,
  pouch: Inventory,
  itemId: string,
  quantity: number,
): ItemRouting {
  const routing: ItemRouting = { toInventory: 0, toPouch: 0, lost: 0 };
  if (quantity <= 0) return routing;

  routing.toInventory = Math.min(quantity, maxAddable(inventory, capacity, itemId));
  if (routing.toInventory > 0) inventory[itemId] = (inventory[itemId] ?? 0) + routing.toInventory;

  const remaining = quantity - routing.toInventory;
  routing.toPouch = Math.min(remaining, maxAddable(pouch, LOST_AND_FOUND_SLOTS, itemId));
  if (routing.toPouch > 0) pouch[itemId] = (pouch[itemId] ?? 0) + routing.toPouch;

  routing.lost = remaining - routing.toPouch;
  return routing;
}

/** Move as much of one pouch stack (or every stack, when `itemId` is omitted) into the backpack as fits. Returns copies moved. */
export function claimFromPouch(
  inventory: Inventory,
  capacity: number,
  pouch: Inventory,
  itemId?: string,
): number {
  const ids = itemId ? [itemId] : Object.keys(pouch);
  let moved = 0;
  for (const id of ids) {
    const available = pouch[id] ?? 0;
    if (available <= 0) continue;
    const take = Math.min(available, maxAddable(inventory, capacity, id));
    if (take <= 0) continue;
    inventory[id] = (inventory[id] ?? 0) + take;
    if (take === available) delete pouch[id];
    else pouch[id] = available - take;
    moved += take;
  }
  return moved;
}

/** Shape check for an authored bag. Returns an error message, or null when valid. */
export function validateBagItem(def: Pick<ItemDefinition, 'bagSlots' | 'equipSlot'>): string | null {
  if (def.bagSlots === undefined) return null;
  if (!Number.isInteger(def.bagSlots) || def.bagSlots < 1 || def.bagSlots > MAX_BAG_SIZE) return `bagSlots must be a whole number from 1 to ${MAX_BAG_SIZE}.`;
  if (def.equipSlot) return 'A bag cannot also have an equipSlot.';
  return null;
}

function applyChanges(inventory: Inventory, changes: Record<string, number>): void {
  for (const [id, delta] of Object.entries(changes)) {
    const after = (inventory[id] ?? 0) + delta;
    if (after <= 0) delete inventory[id];
    else inventory[id] = after;
  }
}
