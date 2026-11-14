import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import { HexGrid, HexTile, offsetToCube, DEFAULT_MAP_ID } from '@idle-party-rpg/shared';
import type { MonsterDefinition, WorldBossDefinition, WorldTileDefinition } from '@idle-party-rpg/shared';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';
import WebSocket from 'ws';

const ROOM = 'tile-lair';
const USERS = ['alice', 'bob'];

function makeBoss(over: Partial<WorldBossDefinition> = {}): WorldBossDefinition {
  return {
    id: 'ashmaw', name: 'Ashmaw', monsterId: 'dragon', maxHp: 100_000, tileIds: [ROOM],
    respawnMinSec: 600, respawnMaxSec: 600,
    retryCooldownSec: 60, retryCooldownStepSec: 60, retryCooldownMaxSec: 600,
    rewardXp: 1000, rewardGold: 400, minContributionPct: 0,
    ...over,
  };
}

function createContent(boss: WorldBossDefinition, dragonDamage: number): ContentStore {
  const lair: WorldTileDefinition = { id: ROOM, mapId: DEFAULT_MAP_ID, col: 0, row: 0, type: 'plains', zone: 'green_fields', name: 'Lair' };
  const monsters: Record<string, MonsterDefinition> = {
    goblin: { id: 'goblin', name: 'Goblin', hp: 10, damage: 1, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0 },
    dragon: { id: 'dragon', name: 'Dragon', hp: 50, damage: dragonDamage, damageType: 'physical', xp: 0, goldMin: 0, goldMax: 0 },
  };
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: (id: string) => monsters[id],
    getItem: () => null,
    getAllMonsters: () => monsters,
    getAllItems: () => ({}),
    getAllZones: () => ({}),
    getAllEncounters: () => ({ auto_goblin: { id: 'auto_goblin', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 } }),
    getTileById: (id: string) => (id === ROOM ? { ...lair, encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }] } : undefined),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getHenchman: () => undefined,
    getAllHenchmen: () => ({}),
    getAllHouses: () => ({}),
    getHouse: () => undefined,
    getWorld: () => ({ tiles: [lair], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuest: () => undefined,
    getDungeon: () => undefined,
    getAllDungeons: () => ({}),
    getAllWorldBosses: () => ({ [boss.id]: boss }),
    ...fakeSkillContent(),
  } as unknown as ContentStore;
}

async function setup(boss = makeBoss(), dragonDamage = 1) {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'plains', 'green_fields', ROOM));
  const accounts: Record<string, Account> = {};
  for (const u of USERS) accounts[u] = { username: u, email: `${u}@x.com`, deactivated: false } as unknown as Account;
  const accountStore = {
    findByUsername: (u: string) => accounts[u] ?? null,
    getAllUsernames: () => USERS,
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    setDeactivated: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
  const store = {
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as GameStateStore;
  const content = createContent(boss, dragonDamage);
  const grids = wrapGrids(grid);
  const pm = new PlayerManager(grids, content, new GuildStore(), accountStore, store);
  pm.worldBosses.tick(Date.now());
  for (const u of USERS) {
    const session = await pm.login({ readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as WebSocket, u);
    session.setClass('Knight');
    pm.ensureParty(u);
    pm.partyBattles.restartBattle(session.getPartyId()!);
  }
  return { pm, grids, content };
}

const bossState = (pm: PlayerManager) => pm.worldBosses.getStates()[0];
const monstersOf = (pm: PlayerManager, u: string) =>
  pm.partyBattles.getBattleState(pm.getSessionByUsername(u)!.getPartyId()!)?.combat?.monsters ?? [];

describe('World boss runtime', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('two parties in the room both fight the boss and wear down the same HP', async () => {
    const { pm } = await setup();
    expect(monstersOf(pm, 'alice')[0]?.name).toBe('Ashmaw');
    expect(monstersOf(pm, 'bob')[0]?.name).toBe('Ashmaw');

    await vi.advanceTimersByTimeAsync(20_000);

    const state = bossState(pm);
    expect(state.contributions.alice).toBeGreaterThan(0);
    expect(state.contributions.bob).toBeGreaterThan(0);
    expect(state.currentHp).toBe(100_000 - state.contributions.alice - state.contributions.bob);
    expect(pm.getSessionByUsername('alice')!.getState([]).worldBosses?.[0]).toMatchObject({ tileId: ROOM, currentHp: state.currentHp });
  });

  it('pays every contributor on the kill and despawns the boss', async () => {
    const { pm } = await setup(makeBoss({ maxHp: 40 }));
    const xpBefore = USERS.map(u => pm.getSessionByUsername(u)!.getState([]).character!.xp);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(bossState(pm)).toMatchObject({ alive: false, currentHp: 0 });
    const xpAfter = USERS.map(u => pm.getSessionByUsername(u)!.getState([]).character!.xp);
    expect(xpAfter[0] + xpAfter[1]).toBeGreaterThan(xpBefore[0] + xpBefore[1]);
    expect(monstersOf(pm, 'alice')[0]?.name).toBe('Goblin');
    expect(pm.getSessionByUsername('alice')!.getState([]).worldBosses).toEqual([]);
  });

  it('a wipe puts members on an escalating cooldown, they fight normal encounters meanwhile, and it survives a save', async () => {
    const { pm, grids, content } = await setup(makeBoss(), 100_000);

    await vi.advanceTimersByTimeAsync(5_000);

    const alice = pm.getSessionByUsername('alice')!;
    const { spawnedAt } = bossState(pm);
    const cooldown = alice.getWorldBossCooldown('ashmaw', spawnedAt)!;
    expect(cooldown.attempts).toBe(1);
    expect(alice.getState([]).worldBosses?.[0].cooldownUntil).toBe(cooldown.until);
    expect(monstersOf(pm, 'alice')[0]?.name).toBe('Goblin');

    const restored = PlayerSession.fromSaveData(alice.toSaveData(), grids, content);
    expect(restored.getWorldBossCooldown('ashmaw', spawnedAt)).toEqual(cooldown);

    await vi.advanceTimersByTimeAsync(cooldown.until - Date.now() + 30_000);
    expect(alice.getWorldBossCooldown('ashmaw', spawnedAt)!.attempts).toBe(2);
  });
});
