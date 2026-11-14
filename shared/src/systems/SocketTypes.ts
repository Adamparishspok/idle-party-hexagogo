import type { ItemDefinition } from './ItemTypes.js';

// See docs/architecture/gear-stats-bank.md → Sockets and jewels.

type Inventory = Record<string, number>;
type Equipment = Record<string, string | null>;

/** Jewel item ids per equipment slot key. Socketed jewels are not in `inventory`. */
export type SocketedJewels = Record<string, string[]>;

export type SocketErrorCode =
  | 'socket_invalid_slot'
  | 'socket_not_a_jewel'
  | 'socket_jewel_missing'
  | 'socket_no_free_socket'
  | 'socket_invalid_index'
  | 'socket_inventory_full';

export type SocketResult = { ok: true } | { ok: false; error: SocketErrorCode };

export interface ClientSocketJewelMessage { type: 'socket_jewel'; slot: string; itemId: string }
export interface ClientUnsocketJewelMessage { type: 'unsocket_jewel'; slot: string; index: number }
export type ClientSocketMessage = ClientSocketJewelMessage | ClientUnsocketJewelMessage;

export const MAX_SOCKETS = 3;

export function isJewel(def: ItemDefinition | undefined): boolean {
  return !!def && def.jewel === true;
}

/** Sockets on the item worn in `slot`. A 2H weapon's offhand mirror has none: its sockets live on mainhand. */
export function socketCapacity(equipment: Equipment, slot: string, items: Record<string, ItemDefinition>): number {
  const itemId = equipment[slot];
  if (!itemId) return 0;
  if (slot === 'offhand' && equipment.mainhand === itemId) return 0;
  return items[itemId]?.sockets ?? 0;
}

/** Jewels that actually count: unknown ids are dropped and each slot is clipped to its socket count. */
export function activeJewelIds(
  equipment: Equipment,
  socketed: SocketedJewels | undefined,
  items: Record<string, ItemDefinition>,
): string[] {
  const out: string[] = [];
  for (const [slot, ids] of Object.entries(socketed ?? {})) {
    const cap = socketCapacity(equipment, slot, items);
    for (const id of ids.slice(0, cap)) if (isJewel(items[id])) out.push(id);
  }
  return out;
}

/**
 * Removes jewels that no longer belong: every jewel of a slot whose item changed since `previous`,
 * then extras beyond the item's socket count (last socketed first). Returns the removed jewel ids.
 */
export function reconcileSockets(
  socketed: SocketedJewels,
  previous: Equipment,
  equipment: Equipment,
  items: Record<string, ItemDefinition>,
): string[] {
  const removed: string[] = [];
  for (const slot of Object.keys(socketed)) {
    const ids = socketed[slot];
    const keep = equipment[slot] === previous[slot] ? socketCapacity(equipment, slot, items) : 0;
    removed.push(...ids.splice(keep));
    if (ids.length === 0) delete socketed[slot];
  }
  return removed;
}

export function socketJewel(
  inventory: Inventory,
  equipment: Equipment,
  socketed: SocketedJewels,
  slot: string,
  jewelId: string,
  items: Record<string, ItemDefinition>,
): SocketResult {
  const capacity = socketCapacity(equipment, slot, items);
  if (capacity <= 0) return { ok: false, error: 'socket_invalid_slot' };
  if (!isJewel(items[jewelId])) return { ok: false, error: 'socket_not_a_jewel' };
  if ((inventory[jewelId] ?? 0) < 1) return { ok: false, error: 'socket_jewel_missing' };
  const ids = socketed[slot] ?? [];
  if (ids.length >= capacity) return { ok: false, error: 'socket_no_free_socket' };
  if (inventory[jewelId] === 1) delete inventory[jewelId];
  else inventory[jewelId]--;
  socketed[slot] = [...ids, jewelId];
  return { ok: true };
}

/** Pure part of unsocketing: pops the jewel at `index`. The caller checks backpack room first (see `peekSocketedJewel`). */
export function peekSocketedJewel(socketed: SocketedJewels, slot: string, index: number): string | null {
  return Number.isInteger(index) ? socketed[slot]?.[index] ?? null : null;
}

export function removeSocketedJewel(socketed: SocketedJewels, slot: string, index: number): void {
  const ids = socketed[slot];
  if (!ids) return;
  ids.splice(index, 1);
  if (ids.length === 0) delete socketed[slot];
}

/** Restores a saved record: drops non-array rows and non-string ids. */
export function normalizeSocketedJewels(saved: SocketedJewels | undefined): SocketedJewels {
  const out: SocketedJewels = {};
  for (const [slot, ids] of Object.entries(saved ?? {})) {
    if (!Array.isArray(ids)) continue;
    const clean = ids.filter((id): id is string => typeof id === 'string');
    if (clean.length > 0) out[slot] = clean;
  }
  return out;
}

/** Shape check for authored `sockets` / `jewel`. Returns an error message, or null when valid. */
export function validateSocketItem(def: Pick<ItemDefinition, 'sockets' | 'jewel' | 'equipSlot' | 'bagSlots'>): string | null {
  if (def.jewel !== undefined && typeof def.jewel !== 'boolean') return 'jewel must be true or false.';
  if (def.sockets !== undefined) {
    if (!Number.isInteger(def.sockets) || def.sockets < 0 || def.sockets > MAX_SOCKETS) return `sockets must be a whole number from 0 to ${MAX_SOCKETS}.`;
    if (def.sockets > 0 && !def.equipSlot) return 'Only equippable items can have sockets.';
  }
  if (def.jewel && (def.equipSlot || (def.bagSlots ?? 0) > 0 || (def.sockets ?? 0) > 0)) return 'A jewel cannot be equipment, a bag, or have sockets.';
  return null;
}

/** Jewels a fresh world's content starts with. Live servers author their own. */
export const SEED_JEWEL_ITEMS: ItemDefinition[] = [
  { id: 'rough_ruby', name: 'Rough Ruby', rarity: 'common', jewel: true, attributes: { strength: 2 }, value: 20, iconEmoji: '🔴' },
  { id: 'rough_sapphire', name: 'Rough Sapphire', rarity: 'common', jewel: true, attributes: { intellect: 2 }, value: 20, iconEmoji: '🔷' },
  { id: 'rough_emerald', name: 'Rough Emerald', rarity: 'common', jewel: true, attributes: { agility: 2 }, value: 20, iconEmoji: '🟢' },
  { id: 'rough_topaz', name: 'Rough Topaz', rarity: 'common', jewel: true, attributes: { stamina: 3 }, value: 20, iconEmoji: '🟡' },
];
