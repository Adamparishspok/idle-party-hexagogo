import { describe, expect, it } from 'vitest';
import { selectVisiblePlayers, roomKey } from '../src/systems/RoomPlayerCap.js';
import type { OtherPlayerState } from '../src/systems/BattleTypes.js';

function player(username: string, partyId: string, col = 1, row = 1): OtherPlayerState {
  return { username, col, row, mapId: 'm', zone: 'z', partyId };
}

function crowd(): OtherPlayerState[] {
  return [
    player('a1', 'pa'), player('a2', 'pa'), player('a3', 'pa'),
    player('b1', 'pb'), player('b2', 'pb'),
    player('c1', 'pc'), player('d1', 'pd'),
  ];
}

describe('selectVisiblePlayers', () => {
  it('shows everyone at or under the cap', () => {
    const { visible, hiddenByRoom } = selectVisiblePlayers(crowd(), new Set(), 7);
    expect(visible).toHaveLength(7);
    expect(hiddenByRoom).toEqual({});
  });

  it('caps per room, biggest parties first, and counts the hidden', () => {
    const { visible, hiddenByRoom } = selectVisiblePlayers(crowd(), new Set(), 4);
    expect(visible.map(p => p.username).sort()).toEqual(['a1', 'a2', 'a3', 'b1']);
    expect(hiddenByRoom).toEqual({ [roomKey(player('x', 'p'))]: 3 });
  });

  it('caps each room separately', () => {
    const others = [...crowd(), player('e1', 'pe', 2, 2)];
    const { visible } = selectVisiblePlayers(others, new Set(), 4);
    expect(visible.map(p => p.username)).toContain('e1');
  });

  it('shows alwaysShow players first, even past the cap', () => {
    const { visible, hiddenByRoom } = selectVisiblePlayers(crowd(), new Set(['d1', 'c1', 'b2']), 2);
    expect(visible.map(p => p.username).sort()).toEqual(['b2', 'c1', 'd1']);
    expect(Object.values(hiddenByRoom)).toEqual([4]);
  });

  it('is stable regardless of input order', () => {
    const forward = selectVisiblePlayers(crowd(), new Set(), 3).visible.map(p => p.username).sort();
    const reversed = selectVisiblePlayers(crowd().reverse(), new Set(), 3).visible.map(p => p.username).sort();
    expect(reversed).toEqual(forward);
  });
});
