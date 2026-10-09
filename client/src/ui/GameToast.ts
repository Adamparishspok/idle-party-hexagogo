import type { BankErrorCode, InventoryErrorCode, ServerErrorCode } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import '../styles/screens/gear.css';

const TOAST_MS = 3500;

export const GEAR_ERROR_TEXT: Record<InventoryErrorCode | BankErrorCode, string> = {
  inventory_full: 'Your bags are full. Free a slot or add a bag first.',
  bag_invalid_slot: "That bag slot doesn't exist.",
  bag_not_a_bag: "That item isn't a bag.",
  bag_item_missing: "That bag isn't in your backpack any more.",
  bag_slot_empty: 'That bag slot is already empty.',
  bag_no_room: 'Your backpack would be too small without that bag. Make some room first.',
  lost_found_item_missing: 'That item is no longer in Lost & Found.',
  bank_not_here: "You need to be in a banker's room to use your bank.",
  bank_invalid_request: "The bank couldn't do that.",
  bank_item_missing: "You don't have that many to move.",
  bank_tab_full: 'That bank tab is full.',
  bank_bag_full: 'Your bags are full. Make room before taking items out.',
  bank_cannot_afford: "You don't have enough gold for a new tab.",
  bank_max_tabs: 'You already own every bank tab.',
};

export function isGearErrorCode(code: ServerErrorCode | string | undefined): code is InventoryErrorCode | BankErrorCode {
  return !!code && code in GEAR_ERROR_TEXT;
}

export function isBankErrorCode(code: string | undefined): code is BankErrorCode {
  return !!code && code.startsWith('bank_') && code in GEAR_ERROR_TEXT;
}

export function gearErrorText(message: string, code: InventoryErrorCode | BankErrorCode): string {
  return message.trim() || GEAR_ERROR_TEXT[code];
}

let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showGameToast(message: string): HTMLElement {
  toastEl?.remove();
  if (toastTimer) clearTimeout(toastTimer);
  const toast = document.createElement('div');
  toast.className = 'gs-toast';
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  toast.addEventListener('click', () => toast.remove());
  document.body.appendChild(toast);
  toastEl = toast;
  toastTimer = setTimeout(() => {
    toast.remove();
    if (toastEl === toast) toastEl = null;
  }, TOAST_MS);
  return toast;
}

/** Toasts bag, Lost & Found and bank refusals. `claimedElsewhere` lets an open screen show the error inline instead. */
export function installGearErrorToasts(gameClient: GameClient, claimedElsewhere: (code: string) => boolean = () => false): () => void {
  return gameClient.onServerError((message, code) => {
    if (!isGearErrorCode(code) || claimedElsewhere(code)) return;
    showGameToast(gearErrorText(message, code));
  });
}
