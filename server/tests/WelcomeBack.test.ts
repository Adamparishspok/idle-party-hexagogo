import { describe, it, expect, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';
import { HexGrid, HexTile, offsetToCube, xpForNextLevel, DEFAULT_MAP_ID } from '@idle-party-rpg/shared';
import type { ItemDefinition, ServerWelcomeBackMessage } from '@idle-party-rpg/shared';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { PlayerSession, WELCOME_BACK_MIN_AWAY_MS } from '../src/game/PlayerSession.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { WorldGrids } from '../src/game/WorldGrids.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';

const MIN = 60 * 1000;

const ITEMS: Record<string, ItemDefinition> = {
  wolf_pelt: { id: 'wolf_pelt', name: 'Wolf Pelt', rarity: 'common' } as ItemDefinition,
  ruby: { id: 'ruby', name: 'Ruby', rarity: 'rare' } as ItemDefinition,
};

function createGrid(): HexGrid {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', 'hatchetmill', 'tile-start'));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'forest', 'darkwood', 'tile-other'));
  return grid;
}

function createContent(): ContentStore {
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: (id: string) => ITEMS[id] ?? null,
    getAllMonsters: () => ({}),
    getAllItems: () => ITEMS,
    getZone: () => ({ id: 'hatchetmill', name: 'Hatchet Mill', encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({
      auto_goblin: { id: 'auto_goblin', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 },
    }),
    getTileById: () => undefined,
    getAllShops: () => ({}),
    getShop: () => undefined,
    getWorld: () => ({ tiles: [], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuest: () => undefined,
    ...fakeSkillContent(),
  } as unknown as ContentStore;
}

function createAccountStore(...usernames: string[]): AccountStore {
  const accounts: Account[] = usernames.map(u => ({
    email: `${u}@test.com`,
    username: u,
    verified: true,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  }));
  return {
    findByUsername: (username: string) => accounts.find(a => a.username === username) ?? null,
    getAllUsernames: () => accounts.map(a => a.username!),
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    setDeactivated: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
}

function createStore(): GameStateStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

function welcomeMessages(ws: WebSocket): ServerWelcomeBackMessage[] {
  return (ws.send as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => JSON.parse(call[0] as string))
    .filter((m: { type: string }) => m.type === 'welcome_back');
}

function knightSave(overrides: Partial<PlayerSaveData> = {}): PlayerSaveData {
  return {
    username: 'alice',
    battleCount: 10,
    combatLog: [],
    unlockedKeys: ['tile-start'],
    position: { col: 0, row: 0 },
    target: null,
    movementQueue: [],
    character: { className: 'Knight', level: 1, xp: 0, gold: 50, inventory: { wolf_pelt: 3 } },
    ...overrides,
  };
}

describe('PlayerSession welcome-back snapshot', () => {
  let grids: WorldGrids;
  let content: ContentStore;
  let tile: HexTile;

  beforeEach(() => {
    grids = wrapGrids(createGrid());
    content = createContent();
    tile = grids.getOrThrow(DEFAULT_MAP_ID).getTile(offsetToCube({ col: 0, row: 0 }))!;
  });

  it('computes deltas across level-ups, wins and positive item gains only', () => {
    const session = PlayerSession.fromSaveData(knightSave(), grids, content);
    session.captureAwaySnapshot(0);

    const xp = xpForNextLevel(1) + xpForNextLevel(2) + 100;
    for (let i = 0; i < 4; i++) session.incrementBattleCount();
    session.handleVictory({ xp, gold: 120, items: ['ruby', 'ruby'] }, tile, { unlockTiles: false });
    session.handleVictory({ xp: 0, gold: 0, items: [] }, tile, { unlockTiles: false });
    session.removeFromInventory('wolf_pelt', 2);

    const msg = session.consumeWelcomeBack(3 * 60 * MIN)!;
    expect(msg).not.toBeNull();
    expect(msg.type).toBe('welcome_back');
    expect(msg.awayMs).toBe(3 * 60 * MIN);
    expect(msg.level).toBe(3);
    expect(msg.levelsGained).toBe(2);
    expect(msg.xpGained).toBe(xp);
    expect(msg.goldGained).toBe(120);
    expect(msg.battlesFought).toBe(4);
    expect(msg.battlesWon).toBe(2);
    expect(msg.items).toEqual([{ itemId: 'ruby', count: 2 }]);
    expect(msg.itemDefinitions.ruby.name).toBe('Ruby');
    expect(msg.itemDefinitions.wolf_pelt).toBeUndefined();
  });

  it('returns nothing under the threshold and clears the snapshot', () => {
    const session = PlayerSession.fromSaveData(knightSave(), grids, content);
    session.captureAwaySnapshot(0);
    session.incrementBattleCount();
    expect(session.consumeWelcomeBack(WELCOME_BACK_MIN_AWAY_MS - 1)).toBeNull();
    expect(session.getAwaySnapshot()).toBeNull();
  });

  it('returns nothing when the party earned nothing', () => {
    const session = PlayerSession.fromSaveData(knightSave(), grids, content);
    session.captureAwaySnapshot(0);
    expect(session.consumeWelcomeBack(60 * MIN)).toBeNull();
  });

  it('does not snapshot a characterless player', () => {
    const session = PlayerSession.fromSaveData(knightSave({ character: undefined }), grids, content);
    session.captureAwaySnapshot(0);
    expect(session.getAwaySnapshot()).toBeNull();
  });

  it('round-trips the snapshot (including live win count) through save data', () => {
    const session = PlayerSession.fromSaveData(knightSave(), grids, content);
    session.captureAwaySnapshot(1000);
    session.incrementBattleCount();
    session.handleVictory({ xp: 10, gold: 5, items: ['wolf_pelt'] }, tile, { unlockTiles: false });

    const save = JSON.parse(JSON.stringify(session.toSaveData())) as PlayerSaveData;
    expect(save.awaySnapshot).toEqual({
      at: 1000, level: 1, xp: 0, gold: 50, battleCount: 10, battlesWon: 1, inventory: { wolf_pelt: 3 },
    });

    const restored = PlayerSession.fromSaveData(save, grids, content);
    const msg = restored.consumeWelcomeBack(1000 + 10 * MIN)!;
    expect(msg.battlesWon).toBe(1);
    expect(msg.battlesFought).toBe(1);
    expect(msg.goldGained).toBe(5);
    expect(msg.items).toEqual([{ itemId: 'wolf_pelt', count: 1 }]);
    expect(restored.toSaveData().awaySnapshot).toBeUndefined();
  });
});

describe('PlayerManager welcome-back delivery', () => {
  let pm: PlayerManager;
  let grids: WorldGrids;

  beforeEach(() => {
    grids = wrapGrids(createGrid());
    pm = new PlayerManager(grids, createContent(), new GuildStore(), createAccountStore('alice'), createStore());
    pm.restoreFromSaveData([knightSave()]);
  });

  it('snapshots only when the last connection closes', async () => {
    const tab1 = createWs();
    const tab2 = createWs();
    await pm.login(tab1, 'alice');
    pm.sendWelcomeBack(tab1, 'alice', 0);
    await pm.login(tab2, 'alice');
    const session = pm.getSessionByUsername('alice')!;

    pm.removeConnection(tab1, 1000);
    expect(session.getAwaySnapshot()).toBeNull();

    pm.removeConnection(tab2, 2000);
    expect(session.getAwaySnapshot()?.at).toBe(2000);
  });

  it('delivers the summary once per absence, to the reconnecting socket only', async () => {
    const first = createWs();
    await pm.login(first, 'alice');
    pm.sendWelcomeBack(first, 'alice', 0);
    pm.removeConnection(first, 0);

    const session = pm.getSessionByUsername('alice')!;
    session.incrementBattleCount();
    session.grantGold(30);

    const tabA = createWs();
    const tabB = createWs();
    await pm.login(tabA, 'alice');
    pm.sendWelcomeBack(tabA, 'alice', 30 * MIN);
    await pm.login(tabB, 'alice');
    pm.sendWelcomeBack(tabB, 'alice', 30 * MIN);

    const sent = welcomeMessages(tabA);
    expect(sent).toHaveLength(1);
    expect(sent[0].goldGained).toBe(30);
    expect(sent[0].awayMs).toBe(30 * MIN);
    expect(welcomeMessages(tabB)).toHaveLength(0);
    expect(welcomeMessages(first)).toHaveLength(0);
  });

  it('sends nothing for a short absence', async () => {
    const ws = createWs();
    await pm.login(ws, 'alice');
    pm.sendWelcomeBack(ws, 'alice', 0);
    pm.removeConnection(ws, 0);
    pm.getSessionByUsername('alice')!.incrementBattleCount();

    const again = createWs();
    await pm.login(again, 'alice');
    pm.sendWelcomeBack(again, 'alice', 2 * MIN);
    expect(welcomeMessages(again)).toHaveLength(0);
    expect(pm.getSessionByUsername('alice')!.getAwaySnapshot()).toBeNull();
  });

  it('gives restored sessions a baseline so a restart does not lose the absence', () => {
    expect(pm.getSessionByUsername('alice')!.getAwaySnapshot()).not.toBeNull();
  });
});
