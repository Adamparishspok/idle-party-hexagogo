import { describe, expect, it } from 'vitest';
import { MOVE_DURATION } from '@idle-party-rpg/shared';
import { MarkerGlide, isSingleHop } from '../src/ui/map/markerMotion';

describe('MarkerGlide', () => {
  it('glides from the old room to the new one over the server move window', () => {
    const g = new MarkerGlide({ x: 0, y: 0 });
    g.moveTo({ x: 100, y: 40 }, 1000, true);
    expect(g.at(1000)).toEqual({ x: 0, y: 0 });
    expect(g.at(1000 + MOVE_DURATION / 2)).toEqual({ x: 50, y: 20 });
    expect(g.at(1000 + MOVE_DURATION)).toEqual({ x: 100, y: 40 });
    expect(g.isMoving(1000 + MOVE_DURATION / 2)).toBe(true);
    expect(g.isMoving(1000 + MOVE_DURATION)).toBe(false);
  });

  it('eases in and out', () => {
    const g = new MarkerGlide({ x: 0, y: 0 });
    g.moveTo({ x: 100, y: 0 }, 0, true);
    expect(g.at(MOVE_DURATION / 4).x).toBeLessThan(25);
    expect(g.at((MOVE_DURATION * 3) / 4).x).toBeGreaterThan(75);
  });

  it('retargets mid-hop from where the marker is drawn', () => {
    const g = new MarkerGlide({ x: 0, y: 0 });
    g.moveTo({ x: 100, y: 0 }, 0, true);
    const mid = g.at(MOVE_DURATION / 2);
    g.moveTo({ x: 100, y: 100 }, MOVE_DURATION / 2, true);
    expect(g.at(MOVE_DURATION / 2)).toEqual(mid);
    expect(g.at(MOVE_DURATION * 2)).toEqual({ x: 100, y: 100 });
  });

  it('snaps when not gliding', () => {
    const g = new MarkerGlide({ x: 0, y: 0 });
    g.moveTo({ x: 300, y: 0 }, 0, false);
    expect(g.at(0)).toEqual({ x: 300, y: 0 });
    expect(g.isMoving(0)).toBe(false);
  });
});

describe('isSingleHop', () => {
  it('is true only for neighbouring rooms', () => {
    expect(isSingleHop({ col: 3, row: 3 }, { col: 4, row: 3 })).toBe(true);
    expect(isSingleHop({ col: 3, row: 3 }, { col: 3, row: 4 })).toBe(true);
    expect(isSingleHop({ col: 3, row: 3 }, { col: 3, row: 3 })).toBe(false);
    expect(isSingleHop({ col: 3, row: 3 }, { col: 5, row: 3 })).toBe(false);
  });
});
