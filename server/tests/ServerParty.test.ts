import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HexGrid, HexTile, offsetToCube, DEFAULT_MAP_ID, RESULT_PAUSE } from '@idle-party-rpg/shared';
import type { PartyCombatState } from '@idle-party-rpg/shared';
import { ServerParty } from '../src/game/ServerParty.js';
import { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';

function corridor(length: number): HexGrid {
  const grid = new HexGrid();
  for (let col = 0; col < length; col++) {
    grid.addTile(new HexTile(offsetToCube({ col, row: 0 }), 'plains', 'briar_hollow', `room-${col}`));
  }
  return grid;
}

function tileAt(grid: HexGrid, col: number): HexTile {
  return grid.getTile(offsetToCube({ col, row: 0 }))!;
}

describe('ServerParty.setDestination', () => {
  it('queues the path to another room', () => {
    const grid = corridor(4);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);

    expect(party.setDestination(tileAt(grid, 3))).toBe(true);
    expect(party.remainingPath.map(t => t.id)).toEqual(['room-1', 'room-2', 'room-3']);
  });

  it('stops a party mid-route when the destination is the room it is standing on', () => {
    const grid = corridor(4);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);
    party.setDestination(tileAt(grid, 3));
    party.moveToNextTile();

    expect(party.setDestination(tileAt(grid, 1))).toBe(true);
    expect(party.hasDestination).toBe(false);
    expect(party.tile.id).toBe('room-1');
  });

  it('turns a party around when it has already left the requested room', () => {
    const grid = corridor(4);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);
    party.setDestination(tileAt(grid, 3));
    party.moveToNextTile();
    party.moveToNextTile();

    expect(party.setDestination(tileAt(grid, 1))).toBe(true);
    expect(party.remainingPath.map(t => t.id)).toEqual(['room-1']);
  });

  it('accepts the current room while idle without queuing anything', () => {
    const grid = corridor(2);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);

    expect(party.setDestination(tileAt(grid, 0))).toBe(true);
    expect(party.hasDestination).toBe(false);
  });
});

describe('ServerBattleTimer stepping after a battle', () => {
  const finishedCombat = () => ({ finished: true }) as unknown as PartyCombatState;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('takes the queued step once the result pause is over', () => {
    const grid = corridor(4);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);
    party.setDestination(tileAt(grid, 3));
    const onMove = vi.fn();
    const timer = new ServerBattleTimer(party, finishedCombat, { onMove, canMoveToNextTile: () => true });

    timer.escapeBattle();
    vi.advanceTimersByTime(RESULT_PAUSE + 1);

    expect(onMove).toHaveBeenCalledOnce();
    expect(party.tile.id).toBe('room-1');
    timer.destroy();
  });

  it('does not report a move when the party stops during the result pause', () => {
    const grid = corridor(4);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);
    party.setDestination(tileAt(grid, 3));
    const onMove = vi.fn();
    const timer = new ServerBattleTimer(party, finishedCombat, { onMove, canMoveToNextTile: () => true });

    timer.escapeBattle();
    party.setDestination(tileAt(grid, 0));
    vi.advanceTimersByTime(RESULT_PAUSE + 1);

    expect(onMove).not.toHaveBeenCalled();
    expect(party.tile.id).toBe('room-0');
    timer.destroy();
  });
});
