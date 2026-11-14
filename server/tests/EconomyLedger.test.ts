import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { EconomyLedger, JsonEconomyStore } from '../src/game/EconomyLedger.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 10, 12);

function makeTile(): HexTile {
  return new HexTile(offsetToCube({ col: 0, row: 0 }), 'plains', 'zone', 'tile-start');
}

function makeSession(ledger: EconomyLedger): PlayerSession {
  const grid = new HexGrid();
  grid.addTile(makeTile());
  const content = {
    getStartTile: () => ({ col: 0, row: 0 }),
    getWorld: () => ({ tiles: [], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getItem: () => undefined,
    getAllItems: () => ({}),
    getAllSets: () => ({}),
    getAllQuests: () => ({}),
    getQuestRevision: () => 0,
    getAllNpcs: () => ({}),
    getAllMonsters: () => ({}),
    getAllZones: () => ({}),
    ...fakeSkillContent(),
  } as unknown as ContentStore;
  const session = new PlayerSession('alice', wrapGrids(grid), content);
  session.setClass('Knight');
  session.economy = ledger;
  return session;
}

describe('gold tagging through PlayerSession', () => {
  it('records each source on grant and deduct', () => {
    const ledger = new EconomyLedger(() => T0);
    const session = makeSession(ledger);

    session.handleVictory({ xp: 0, gold: 10, items: [] }, makeTile(), { unlockTiles: false });
    session.grantGold(7, 'dungeon_first_clear');
    session.grantGold(5, 'shop_sell');
    expect(session.deductGold(12, 'shop_buy')).toBe(true);
    expect(session.deductGold(10_000, 'shop_buy')).toBe(false);

    expect(ledger.summary(1)).toEqual({
      combat: { earned: 10, spent: 0 },
      dungeon_first_clear: { earned: 7, spent: 0 },
      shop_sell: { earned: 5, spent: 0 },
      shop_buy: { earned: 0, spent: 12 },
    });
  });
});

describe('EconomyLedger', () => {
  it('aggregates per UTC day and windows by day count', () => {
    let now = T0;
    const ledger = new EconomyLedger(() => now);
    ledger.record('combat', 10, 0);
    now += 3 * DAY;
    ledger.record('combat', 5, 0);
    ledger.record('shop_buy', 0, 4);
    expect(ledger.summary(1)).toEqual({ combat: { earned: 5, spent: 0 }, shop_buy: { earned: 0, spent: 4 } });
    expect(ledger.summary(7).combat).toEqual({ earned: 15, spent: 0 });
  });

  it('drops days older than 90 and ignores zero amounts', () => {
    let now = T0;
    const ledger = new EconomyLedger(() => now);
    ledger.record('combat', 1, 0);
    ledger.record('quest', 0, 0);
    now += 95 * DAY;
    ledger.record('combat', 2, 0);
    expect(Object.keys(ledger.toData())).toHaveLength(1);
    expect(ledger.summary(90)).toEqual({ combat: { earned: 2, spent: 0 } });
  });
});

describe('JsonEconomyStore', () => {
  let dir: string;
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('round-trips and starts empty with no file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'economy-'));
    const store = new JsonEconomyStore(dir);
    expect(await store.load()).toEqual({});
    const ledger = new EconomyLedger(() => T0);
    ledger.record('quest', 3, 1);
    await store.save(ledger.toData());
    const restored = new EconomyLedger(() => T0);
    restored.restore(await store.load());
    expect(restored.summary(1)).toEqual({ quest: { earned: 3, spent: 1 } });
  });
});
