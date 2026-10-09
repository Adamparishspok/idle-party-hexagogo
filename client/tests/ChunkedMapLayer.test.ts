import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ChunkedMapLayer, CHUNK_SIZE, lodScale } from '../src/ui/map/ChunkedMapLayer';
import type { PaintTile } from '../src/ui/map/terrainPainter';

function tile(key: string, x: number, y: number, over: Partial<PaintTile> = {}): PaintTile {
  return {
    key, x, y,
    type: 'plains', color: '#7ec850', zone: 'z1', traversable: true,
    fog: 'open', dimmed: false, neighborKeys: [],
    ...over,
  };
}

describe('lodScale', () => {
  it('picks the smallest bake scale that still covers the pixel density', () => {
    expect(lodScale(0.3)).toBe(0.5);
    expect(lodScale(0.5)).toBe(0.5);
    expect(lodScale(0.9)).toBe(1);
    expect(lodScale(1.4)).toBe(2);
  });

  it('caps at the highest detail and floors at the lowest', () => {
    expect(lodScale(6)).toBe(2);
    expect(lodScale(0.01)).toBe(0.125);
  });
});

describe('ChunkedMapLayer', () => {
  it('buckets tiles by the chunk their center falls in', () => {
    const layer = new ChunkedMapLayer(new THREE.Scene(), { getArt: () => null, onBaked: () => {} });
    layer.setTiles([tile('a', 10, 10), tile('b', CHUNK_SIZE + 10, 10)]);
    expect(layer.getTile('a')?.x).toBe(10);
    expect(layer.getTile('b')?.x).toBe(CHUNK_SIZE + 10);
    expect(layer.getTile('missing')).toBeUndefined();
    layer.dispose();
  });

  it('replaces tile state on re-sync', () => {
    const layer = new ChunkedMapLayer(new THREE.Scene(), { getArt: () => null, onBaked: () => {} });
    layer.setTiles([tile('a', 10, 10, { fog: 'fog' })]);
    layer.setTiles([tile('a', 10, 10, { fog: 'open' })]);
    expect(layer.getTile('a')?.fog).toBe('open');
    layer.dispose();
  });
});
