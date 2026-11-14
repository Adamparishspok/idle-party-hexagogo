/**
 * InventoryView — read-only views over inventory + equipment for any character.
 *
 * A character's items live in two places that are mutually exclusive:
 *   - `inventory: Record<string, number>` — unequipped copies, keyed by item ID
 *   - `equipment: Record<string, string | null>` — slot → equipped item ID
 *
 * `equipItem`/`unequipItem` move items between them, so an equipped item is
 * NEVER counted in `inventory`. Several past bugs came from forgetting that
 * invariant (filtering inventory by "is this ID equipped?", or subtracting
 * an equipped count from an inventory count). Use these helpers instead of
 * iterating the maps directly so the rule lives in one place.
 *
 * These functions take their data as arguments and have no global state, so
 * they work for the current player AND for any other player whose data you
 * have a reference to (e.g. a remote player's profile equipment in the
 * `view_player` response). Helpers that only need `equipment` are the ones
 * to use for remote profiles, since `inventory` is private and not shared
 * across players.
 *
 * Pure functions, no state. Safe to call from client or server.
 */

import { templateIdOf, resolveItem } from './ItemRolls.js';
import type { ItemDefinition } from './ItemTypes.js';

type Inventory = Record<string, number>;
type Equipment = Record<string, string | null>;
/** Bags sitting in bag slots: outside both `inventory` and `equipment`. */
type Bags = readonly (string | null)[];

/** Number of bag slots holding `itemId`. */
export function getBagCount(itemId: string, bags: Bags = []): number {
  return bags.filter(id => id === itemId).length;
}

// ── Counts ───────────────────────────────────────────────────────────────────

/** Number of equipped slots holding `itemId` (a 2H weapon counts once per slot it occupies). */
export function getEquippedCount(itemId: string, equipment: Equipment): number {
  let n = 0;
  for (const id of Object.values(equipment)) {
    if (id === itemId) n++;
  }
  return n;
}

/** Number of unequipped copies of `itemId` (i.e. how many can be traded, sold, or destroyed). */
export function getUnequippedCount(itemId: string, inventory: Inventory): number {
  return inventory[itemId] ?? 0;
}

/** Total copies of `itemId` the player has (unequipped + equipped slots + bag slots). */
export function getOwnedCount(itemId: string, inventory: Inventory, equipment: Equipment, bags: Bags = []): number {
  return getUnequippedCount(itemId, inventory) + getEquippedCount(itemId, equipment) + getBagCount(itemId, bags);
}

// ── Template-matched requirements ────────────────────────────────────────────

/** Unequipped copies whose template is `templateId`: the plain id plus every rolled copy. */
export function countByTemplate(inventory: Inventory, templateId: string): number {
  let n = 0;
  for (const [id, count] of Object.entries(inventory)) {
    if (count > 0 && templateIdOf(id) === templateId) n += count;
  }
  return n;
}

/**
 * Which stacks to spend for `count` copies of `templateId`: the plain id first, then rolled copies
 * from lowest quality up. Returns id → amount, or null when the backpack holds too few. Pure: spend it with `spendPicked`.
 */
export function pickForConsumption(
  inventory: Inventory,
  templateId: string,
  count: number,
  items?: Record<string, ItemDefinition>,
): Record<string, number> | null {
  if (count <= 0) return {};
  const rank = (id: string): number => (id === templateId ? -1 : (items ? resolveItem(id, items)?.rollQuality ?? 100 : 100));
  const ids = Object.keys(inventory)
    .filter(id => inventory[id] > 0 && templateIdOf(id) === templateId)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const picked: Record<string, number> = {};
  let left = count;
  for (const id of ids) {
    const take = Math.min(left, inventory[id]);
    picked[id] = take;
    left -= take;
    if (left === 0) return picked;
  }
  return null;
}

export function spendPicked(inventory: Inventory, picked: Record<string, number>): void {
  for (const [id, n] of Object.entries(picked)) {
    if (inventory[id] - n <= 0) delete inventory[id];
    else inventory[id] -= n;
  }
}

/** Pick and spend in one step. Returns false (and changes nothing) when short. */
export function consumeByTemplate(
  inventory: Inventory,
  templateId: string,
  count: number,
  items?: Record<string, ItemDefinition>,
): boolean {
  const picked = pickForConsumption(inventory, templateId, count, items);
  if (!picked) return false;
  spendPicked(inventory, picked);
  return true;
}

// ── Booleans ─────────────────────────────────────────────────────────────────

/** True iff any slot holds `itemId`. Works on the current player's or any other player's equipment. */
export function hasItemEquipped(itemId: string, equipment: Equipment): boolean {
  return getEquippedCount(itemId, equipment) > 0;
}

/** True iff the player has at least one unequipped copy of `itemId` (i.e. tradeable / sellable). */
export function hasUnequipped(itemId: string, inventory: Inventory): boolean {
  return getUnequippedCount(itemId, inventory) > 0;
}

/** True iff the player owns at least one copy of `itemId`, whether equipped or not. */
export function ownsItem(itemId: string, inventory: Inventory, equipment: Equipment, bags: Bags = []): boolean {
  return hasUnequipped(itemId, inventory) || hasItemEquipped(itemId, equipment) || getBagCount(itemId, bags) > 0;
}

// ── Sets ─────────────────────────────────────────────────────────────────────

/** Set of distinct item IDs currently equipped (deduped across slots), plus the template id of each rolled item. */
export function getEquippedItemIds(equipment: Equipment): Set<string> {
  const ids = new Set<string>();
  for (const id of Object.values(equipment)) {
    if (id) addWithTemplate(ids, id);
  }
  return ids;
}

/** Set of distinct item IDs the player owns (unequipped + equipped + bag slots), plus the template id of each rolled item. */
export function getOwnedItemIds(inventory: Inventory, equipment: Equipment, bags: Bags = []): Set<string> {
  const ids = new Set<string>();
  for (const id of bags) {
    if (id) addWithTemplate(ids, id);
  }
  for (const [id, count] of Object.entries(inventory)) {
    if (count > 0) addWithTemplate(ids, id);
  }
  for (const id of Object.values(equipment)) {
    if (id) addWithTemplate(ids, id);
  }
  return ids;
}

function addWithTemplate(ids: Set<string>, id: string): void {
  ids.add(id);
  ids.add(templateIdOf(id));
}

// ── Lists ────────────────────────────────────────────────────────────────────

/**
 * Entries `[itemId, count]` for every unequipped item with count > 0.
 * Use this for trade pickers, shop sell lists, drop pickers, etc.
 * The returned counts are the number of copies eligible for the action —
 * do NOT subtract equipped counts from these.
 */
export function listUnequippedEntries(inventory: Inventory): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [id, count] of Object.entries(inventory)) {
    if (count > 0) out.push([id, count]);
  }
  return out;
}
