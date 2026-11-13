import type { OtherPlayerState } from './BattleTypes.js';

export const MAX_VISIBLE_PLAYERS_PER_ROOM = 12;

export interface VisiblePlayers {
  visible: OtherPlayerState[];
  /** Players left out per room, keyed by `roomKey`. Rooms with none hidden are absent. */
  hiddenByRoom: Record<string, number>;
}

export function roomKey(player: { mapId?: string; col: number; row: number }): string {
  return `${player.mapId ?? ''}:${player.col},${player.row}`;
}

/**
 * At most `cap` other players per room: `alwaysShow` first (they can push a room past the cap),
 * then the largest parties, ties by partyId then username.
 */
export function selectVisiblePlayers(
  others: OtherPlayerState[],
  alwaysShow: ReadonlySet<string>,
  cap: number = MAX_VISIBLE_PLAYERS_PER_ROOM,
): VisiblePlayers {
  const byRoom = new Map<string, OtherPlayerState[]>();
  for (const player of others) {
    const key = roomKey(player);
    const room = byRoom.get(key);
    if (room) room.push(player);
    else byRoom.set(key, [player]);
  }

  const visible: OtherPlayerState[] = [];
  const hiddenByRoom: Record<string, number> = {};
  for (const [key, room] of byRoom) {
    if (room.length <= cap) {
      visible.push(...room);
      continue;
    }
    const partySize = new Map<string, number>();
    for (const p of room) if (p.partyId) partySize.set(p.partyId, (partySize.get(p.partyId) ?? 0) + 1);
    const pinned = (p: OtherPlayerState): number => (alwaysShow.has(p.username) ? 0 : 1);
    const ranked = [...room].sort((a, b) =>
      pinned(a) - pinned(b)
      || (partySize.get(b.partyId ?? '') ?? 0) - (partySize.get(a.partyId ?? '') ?? 0)
      || (a.partyId ?? '').localeCompare(b.partyId ?? '')
      || a.username.localeCompare(b.username));

    let shown = 0;
    for (const p of ranked) {
      if (pinned(p) === 0 || shown < cap) {
        visible.push(p);
        shown++;
      }
    }
    if (shown < room.length) hiddenByRoom[key] = room.length - shown;
  }
  return { visible, hiddenByRoom };
}
