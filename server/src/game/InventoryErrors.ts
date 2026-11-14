import type { InventoryErrorCode, SocketErrorCode } from '@idle-party-rpg/shared';

export const INVENTORY_ERROR_MESSAGES: Record<InventoryErrorCode, string> = {
  inventory_full: 'Your backpack is full.',
  bag_invalid_slot: 'No such bag slot.',
  bag_not_a_bag: "That isn't a bag.",
  bag_item_missing: "That bag isn't in your backpack.",
  bag_slot_empty: 'That bag slot is empty.',
  bag_no_room: "Your backpack wouldn't have room for everything without that bag.",
  lost_found_item_missing: "That isn't in Lost & Found.",
};

export const INVENTORY_MESSAGE_TYPES: ReadonlySet<string> = new Set(['equip_bag', 'unequip_bag', 'claim_lost_found', 'discard_lost_found']);

export const SOCKET_ERROR_MESSAGES: Record<SocketErrorCode, string> = {
  socket_invalid_slot: 'That item has no sockets.',
  socket_not_a_jewel: "That isn't a jewel.",
  socket_jewel_missing: "That jewel isn't in your backpack.",
  socket_no_free_socket: 'All sockets on that item are full.',
  socket_invalid_index: 'No jewel in that socket.',
  socket_inventory_full: 'Your backpack is full.',
};

export const SOCKET_MESSAGE_TYPES: ReadonlySet<string> = new Set(['socket_jewel', 'unsocket_jewel']);
