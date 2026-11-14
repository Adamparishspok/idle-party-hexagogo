import { isJewel, socketCapacity } from '@idle-party-rpg/shared';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { escapeHtml } from './ItemIcon';
import { allItemDefs } from './GearModel';
import { renderItemStatBlock } from './ItemStats';
import type { ItemStatViewer } from './ItemStats';

/** Sockets list with Remove / Socket buttons for the item worn in `slot`; empty string when it has none. Shared by the gear picker and the item popup. */
export function renderSocketsSection(state: ServerStateMessage, slot: string, viewer: ItemStatViewer): string {
  const char = state.character;
  if (!char) return '';
  const items = allItemDefs(state);
  const capacity = socketCapacity(char.equipment, slot, items);
  if (capacity === 0) return '';
  const socketed = char.socketedJewels?.[slot] ?? [];
  const cells = Array.from({ length: capacity }, (_, i) => {
    const id = socketed[i];
    const def = id ? items[id] : undefined;
    if (!id) return '<li class="gp-socket is-empty">Empty socket</li>';
    return `<li class="gp-socket">
        <span class="gp-name gc-rarity-text" data-rarity="${escapeHtml(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? id)}</span>
        ${def ? renderItemStatBlock(def, viewer) : ''}
        <button type="button" class="gc-btn gc-btn--steel" data-gp-action="unsocket" data-index="${i}">Remove</button>
      </li>`;
  }).join('');
  const jewels = socketed.length < capacity
    ? Object.entries(char.inventory).filter(([id, n]) => n > 0 && isJewel(items[id]))
    : [];
  const available = jewels.map(([id]) => `<button type="button" class="gc-btn gc-btn--green" data-gp-action="socket" data-item-id="${escapeHtml(id)}">Socket ${escapeHtml(items[id].name)}</button>`).join('');
  return `<div class="gp-sockets"><span class="gp-equipped__label">Sockets</span><ul class="gp-socket-list">${cells}</ul>${available}</div>`;
}

/** Sends the socket/unsocket message for a clicked `data-gp-action` button. Returns true when it handled one. */
export function handleSocketAction(action: HTMLElement | null, slot: string, gameClient: GameClient): boolean {
  if (action?.dataset.gpAction === 'socket' && action.dataset.itemId) {
    gameClient.sendSocketJewel(slot, action.dataset.itemId);
    return true;
  }
  if (action?.dataset.gpAction === 'unsocket') {
    gameClient.sendUnsocketJewel(slot, Number(action.dataset.index));
    return true;
  }
  return false;
}
