import { describe, it, expect, beforeEach } from 'vitest';
import { FollowSystem } from '../src/game/social/FollowSystem.js';
import type { FollowHost, FollowLocation } from '../src/game/social/FollowSystem.js';

function setup() {
  const online = new Set(['alice', 'bob']);
  const movers = new Set(['alice']);
  const locations: Record<string, FollowLocation> = {
    alice: { partyId: 'pa', mapId: 'm1', col: 0, row: 0, sealed: false },
    bob: { partyId: 'pb', mapId: 'm1', col: 3, row: 2, sealed: false },
  };
  const moves: Array<[string, number, number]> = [];
  const told: Array<[string, string]> = [];
  const state = { moveOk: true, discovered: true, undiscoveredPath: false };
  const host: FollowHost = {
    isOnline: (u) => online.has(u),
    canMoveParty: (u) => movers.has(u),
    location: (u) => locations[u] ?? null,
    isDiscovered: () => state.discovered,
    moveParty: (p, c, r) => {
      moves.push([p, c, r]);
      if (state.undiscoveredPath) return { success: false, undiscovered: true };
      return state.moveOk ? { success: true } : { success: false };
    },
    tell: (u, m) => told.push([u, m]),
    pushState: () => {},
  };
  return { sys: new FollowSystem(host), online, movers, locations, moves, told, state };
}

describe('FollowSystem', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('starts by pathing the party to the target room', () => {
    expect(t.sys.start('alice', 'bob')).toBeNull();
    expect(t.moves).toEqual([['pa', 3, 2]]);
    expect(t.sys.getTarget('alice')).toBe('bob');
  });

  it.each([
    ['yourself', () => t.sys.start('alice', 'alice')],
    ['non-movers', () => t.sys.start('bob', 'alice')],
  ])('refuses to follow %s', (_n, run) => {
    expect(run()).toBeTypeOf('string');
    expect(t.sys.getTarget('alice')).toBeNull();
  });

  it('refuses offline, same-party, sealed, cross-map, undiscovered and blocked targets', () => {
    t.online.delete('bob');
    expect(t.sys.start('alice', 'bob')).toMatch(/offline/);
    t.online.add('bob');
    t.locations.bob.partyId = 'pa';
    expect(t.sys.start('alice', 'bob')).toMatch(/already in your party/);
    t.locations.bob.partyId = 'pb';
    t.locations.bob.sealed = true;
    expect(t.sys.start('alice', 'bob')).toMatch(/cannot follow/);
    t.locations.bob.sealed = false;
    t.locations.bob.mapId = 'm2';
    expect(t.sys.start('alice', 'bob')).toMatch(/another map/);
    t.locations.bob.mapId = 'm1';
    t.state.discovered = false;
    expect(t.sys.start('alice', 'bob')).toMatch(/not discovered/);
    t.state.discovered = true;
    t.state.moveOk = false;
    expect(t.sys.start('alice', 'bob')).toMatch(/cannot reach/);
    expect(t.sys.getTarget('alice')).toBeNull();
  });

  it('re-paths when the target moves, ignoring other parties', () => {
    t.sys.start('alice', 'bob');
    t.moves.length = 0;
    t.sys.onPartyMoved(new Set(['carol']));
    expect(t.moves).toEqual([]);
    t.locations.bob.col = 5;
    t.sys.onPartyMoved(new Set(['bob']));
    expect(t.moves).toEqual([['pa', 5, 2]]);
  });

  it('stops and tells the follower when the target becomes unreachable', () => {
    t.sys.start('alice', 'bob');
    t.state.moveOk = false;
    t.sys.onPartyMoved(new Set(['bob']));
    expect(t.sys.getTarget('alice')).toBeNull();
    expect(t.told[0][0]).toBe('alice');
  });

  it('stops when the target goes offline', () => {
    t.sys.start('alice', 'bob');
    t.sys.stopFollowing('bob');
    expect(t.sys.getTarget('alice')).toBeNull();
    expect(t.told[0][1]).toMatch(/offline/);
  });

  it('stops when the follower joins the target party', () => {
    t.sys.start('alice', 'bob');
    t.locations.alice.partyId = 'pb';
    t.sys.reconcileParties();
    expect(t.sys.getTarget('alice')).toBeNull();
  });

  it('stops when the follower loses the right to move the party', () => {
    t.sys.start('alice', 'bob');
    t.movers.delete('alice');
    t.sys.onPartyMoved(new Set(['bob']));
    expect(t.sys.getTarget('alice')).toBeNull();
  });

  it('stops on cancel or manual move, and restores a saved follow', () => {
    t.sys.start('alice', 'bob');
    t.sys.stopForUsers(['alice']);
    expect(t.sys.getTarget('alice')).toBeNull();
    t.sys.restore('alice', 'bob');
    expect(t.sys.getTarget('alice')).toBe('bob');
    t.sys.rename('bob', 'bobby');
    expect(t.sys.getTarget('alice')).toBe('bobby');
  });

  it('refuses to start and tells the player when the path crosses undiscovered rooms', () => {
    t.state.undiscoveredPath = true;
    expect(t.sys.start('alice', 'bob')).toMatch(/not discovered/);
    expect(t.sys.getTarget('alice')).toBeNull();
  });

  it('stops with a reason instead of stalling when a re-path crosses undiscovered rooms', () => {
    t.sys.start('alice', 'bob');
    t.state.undiscoveredPath = true;
    t.sys.onPartyMoved(new Set(['bob']));
    expect(t.sys.getTarget('alice')).toBeNull();
    expect(t.told[0]).toEqual(['alice', expect.stringMatching(/not discovered.*stopped following/)]);
  });
});
