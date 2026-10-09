import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';

vi.mock('three', () => {
  class Stub {
    position = { x: 0, y: 0, z: 0, set() {} };
    color = { setHex() {} };
    map: unknown = null;
    needsUpdate = false;
    repeat = { set() {} };
    geometry = { dispose() {} };
    constructor(..._args: unknown[]) {}
    setClearColor() {} setPixelRatio() {} setSize() {} render() {} dispose() {}
    add() {} remove() {} updateProjectionMatrix() {} load() {}
  }
  return {
    WebGLRenderer: Stub, Scene: Stub, OrthographicCamera: Stub, MeshBasicMaterial: Stub, Color: Stub,
    TextureLoader: Stub, CanvasTexture: Stub, Mesh: Stub, PlaneGeometry: Stub,
    SRGBColorSpace: 'srgb', LinearFilter: 1, RepeatWrapping: 1,
  };
});

import { ThreeWorldMap } from '../src/ui/ThreeWorldMap';
import { WorldCache } from '../src/network/WorldCache';

const TILES = [
  { id: 't-home', mapId: 'overworld', col: 0, row: 0, type: 'plains', zone: 'z', zoneName: 'Zone', name: 'Home', npcId: 'mira', dungeonId: 'caves' },
  { id: 't-shop', mapId: 'overworld', col: 1, row: 0, type: 'plains', zone: 'z', zoneName: 'Zone', name: 'Market', shopId: 'store' },
  { id: 't-fog', mapId: 'overworld', col: 2, row: 0, type: 'plains', zone: 'z', zoneName: 'Zone', name: 'Secret', npcId: 'mira' },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function makeCache(): Promise<WorldCache> {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/world') return json({
      startTile: { col: 0, row: 0 },
      maps: [{ id: 'overworld', name: 'Overworld', startTile: { col: 0, row: 0 } }],
      tiles: TILES,
      tileTypes: { plains: { id: 'plains', name: 'Plains', icon: '', color: '#00ff00', traversable: true } },
      shops: { store: { id: 'store', name: 'General Store', sellsItems: true, hiresHenchmen: false } },
    });
    if (url === '/api/npcs') return json({ npcs: { mira: { id: 'mira', name: 'Mira', emoji: '🧙', greeting: '', questIds: ['q1'] } } });
    if (url === '/api/dungeons') return json({ dungeons: { caves: { id: 'caves', name: 'Crystal Caves', floors: [] } } });
    return json({});
  }));
  const cache = new WorldCache();
  await cache.loadWorld();
  return cache;
}

function makeState(overrides: Partial<ServerStateMessage> = {}): ServerStateMessage {
  return {
    type: 'state', username: 'me',
    party: { col: 0, row: 0, state: 'idle', path: [] },
    battle: { visual: 'none' } as ServerStateMessage['battle'],
    unlocked: ['t-home', 't-shop'], mapSize: 0, currentMapId: 'overworld',
    otherPlayers: [
      { username: 'alice', col: 0, row: 0, zone: 'z', mapId: 'overworld', partyId: 'pa', inDungeon: true, dungeonName: 'Crystal Caves' },
      { username: 'bob', col: 1, row: 0, zone: 'z', mapId: 'overworld', partyId: 'pb', inDungeon: true },
      { username: 'carl', col: 1, row: 0, zone: 'z', mapId: 'overworld', partyId: 'pb' },
      { username: 'buddy', col: 0, row: 0, zone: 'z', mapId: 'overworld', partyId: 'mine' },
    ],
    combatLog: [], battleCount: 0, character: null, zoneName: 'Zone', itemDefinitions: {}, serverVersion: 'x',
    social: { party: { members: [{ username: 'me' }, { username: 'buddy' }] } } as unknown as ServerStateMessage['social'],
    ...overrides,
  } as ServerStateMessage;
}

describe('ThreeWorldMap overlays', () => {
  let container: HTMLElement;
  beforeEach(() => { document.body.innerHTML = ''; container = document.createElement('div'); document.body.appendChild(container); });

  it('marks explored rooms only, with a quest pip once a quest is ready', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    const markers = [...container.querySelectorAll('.three-map-marker')];
    expect(markers.map(m => m.textContent)).toEqual(['🧙🗝️', '🪙']);
    expect(container.querySelector('.quest-ready-pip')).toBeNull();

    const before = markers[0];
    map.applyServerState(makeState());
    expect(container.querySelector('.three-map-marker')).toBe(before);

    map.applyServerState(makeState({ activeQuests: [{ questId: 'q1', status: 'ready', progress: [], acceptedAt: '' }] }));
    expect(container.querySelector('.three-map-marker')).not.toBe(before);
    expect(container.querySelectorAll('.quest-ready-pip')).toHaveLength(1);

    map.applyServerState(makeState({ unlocked: ['t-home', 't-shop', 't-fog'] }));
    expect(container.querySelectorAll('.three-map-marker')).toHaveLength(3);
  });

  it('counts others outside my party and keys every room a party is delving from', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    expect(map.countOthersAt(0, 0)).toBe(1);
    expect(map.countOthersAt(1, 0)).toBe(2);
    const badges = [...container.querySelectorAll<HTMLElement>('.three-map-badge')].map(b => b.textContent);
    expect(badges.sort()).toEqual(['+1', '×2']);
    expect(container.querySelectorAll('.three-map-dungeon-key')).toHaveLength(2);
  });

  it('builds the tile info for the current room', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    const info = map.getTileInfo(0, 0)!;
    expect(info.isCurrentTile).toBe(true);
    expect(info.roomName).toBe('Home');
    expect(info.playersHere.map(p => p.username).sort()).toEqual(['alice', 'buddy']);
    expect(map.getTileInfo(2, 0)!.roomName).toBe('Unexplored Room');
    expect(map.getTileInfo(9, 9)).toBeNull();
  });

  it('tooltip lists actions and a player count, never names', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    const canvas = container.querySelector('canvas')!;
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0, bubbles: true }));
    const tip = container.querySelector('.canvas-map-tooltip') as HTMLElement;
    expect(tip.style.display).toBe('block');
    expect([...tip.children].map(c => c.textContent)).toEqual(['Zone: Home', '🧙 Mira', '🗝️ Crystal Caves', '👥 1 player here']);
  });
});
