import { describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import { HexGrid, HexTile, offsetToCube, DEFAULT_MAP_ID, RESTED_MS_PER_SIT_MS, WELL_RESTED_BONUS } from '@idle-party-rpg/shared';
import type { HouseDefinition, ItemDefinition, ServerStateMessage, WorldTileDefinition } from '@idle-party-rpg/shared';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import { HOME_INVITE_TTL_MS } from '../src/game/housing/HousingService.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';

const MIN = 60 * 1000;
const AGENT_TILE = 'tile-agent';
const PLAIN_TILE = 'tile-plain';

const COTTAGE: HouseDefinition = { id: 'cottage', name: 'Cottage', tier: 1, price: 1000, storageSlots: 2, displaySlots: 2, emoji: '🛖' };
const MANOR: HouseDefinition = { id: 'manor', name: 'Manor', tier: 3, price: 5000, storageSlots: 4, displaySlots: 3, emoji: '🏰' };

const ITEMS: Record<string, ItemDefinition> = {
  pelt: { id: 'pelt', name: 'Pelt', rarity: 'common' } as ItemDefinition,
  ruby: { id: 'ruby', name: 'Ruby', rarity: 'rare' } as ItemDefinition,
  fang: { id: 'fang', name: 'Fang', rarity: 'common' } as ItemDefinition,
  sword: { id: 'sword', name: 'Sword', rarity: 'common', equipSlot: 'mainhand' } as ItemDefinition,
};

function createGrid(): HexGrid {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', 'hatchetmill', AGENT_TILE));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'plains', 'hatchetmill', PLAIN_TILE));
  return grid;
}

function createContent(houses: Record<string, HouseDefinition>): ContentStore {
  const agentTile: WorldTileDefinition = {
    id: AGENT_TILE, mapId: DEFAULT_MAP_ID, col: 0, row: 0, type: 'town', zone: 'hatchetmill', name: 'Estate Agent', shopId: 'agent',
  };
  const plainTile: WorldTileDefinition = {
    id: PLAIN_TILE, mapId: DEFAULT_MAP_ID, col: 1, row: 0, type: 'plains', zone: 'hatchetmill', name: 'Field',
  };
  const shop = { id: 'agent', name: 'Estate Agent', inventory: [], houseIds: ['cottage', 'manor'] };
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: (id: string) => ITEMS[id],
    getAllMonsters: () => ({}),
    getAllItems: () => ITEMS,
    getZone: () => ({ id: 'hatchetmill', name: 'Hatchetmill', encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({ auto_goblin: { id: 'auto_goblin', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 } }),
    getTileById: (id: string) => (id === AGENT_TILE ? agentTile : id === PLAIN_TILE ? plainTile : undefined),
    getAllShops: () => ({ agent: shop }),
    getShop: (id: string) => (id === 'agent' ? shop : undefined),
    getHenchman: () => undefined,
    getAllHenchmen: () => ({}),
    getHouse: (id: string) => houses[id],
    getAllHouses: () => houses,
    getWorld: () => ({ tiles: [agentTile, plainTile], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuest: () => undefined,
    getDungeon: () => undefined,
    getAllDungeons: () => ({}),
    ...fakeSkillContent(),
  } as unknown as ContentStore;
}

function createAccountStore(usernames: string[]): AccountStore {
  const accounts: Record<string, Account> = {};
  for (const u of usernames) accounts[u] = { username: u, email: `${u}@x.com`, deactivated: false } as unknown as Account;
  return {
    findByUsername: (u: string) => accounts[u] ?? null,
    getAllUsernames: () => usernames,
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
  } as unknown as GameStateStore;
}

function createWs(): WebSocket {
  return { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as WebSocket;
}

const PLAYERS = ['alice', 'bob', 'carol', 'dave'];

async function setup(houses: Record<string, HouseDefinition> = { cottage: COTTAGE, manor: MANOR }) {
  const grid = createGrid();
  const content = createContent(houses);
  const pm = new PlayerManager(wrapGrids(grid), content, new GuildStore(), createAccountStore(PLAYERS), createStore());
  const sockets: Record<string, WebSocket> = {};
  for (const name of PLAYERS) {
    sockets[name] = createWs();
    const session = await pm.login(sockets[name], name);
    session.setClass('Knight');
    pm.ensureParty(name);
  }
  const session = (name: string) => pm.getSessionByUsername(name)!;
  return { pm, sockets, session, grid, content, houses };
}

function lastState(ws: WebSocket): ServerStateMessage {
  const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(c => JSON.parse(c[0] as string));
  const states = calls.filter(m => m.type === 'state');
  return states[states.length - 1];
}

function sentCount(ws: WebSocket): number {
  return (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
}

async function withHouse(houses?: Record<string, HouseDefinition>) {
  const ctx = await setup(houses);
  ctx.session('alice').grantGold(10_000);
  expect(ctx.pm.housing.buy('alice', 'cottage')).toBeNull();
  return ctx;
}

describe('buying and selling', () => {
  it('buys from the estate agent, deducting gold, and sends houseOffers + house state', async () => {
    const { pm, sockets, session } = await setup();
    session('alice').grantGold(1500);

    pm.sendStateToPlayer('alice');
    expect(lastState(sockets.alice).houseOffers?.map(o => o.houseId)).toEqual(['cottage', 'manor']);

    expect(pm.housing.buy('alice', 'cottage', 1234)).toBeNull();
    expect(session('alice').getGold()).toBe(500);
    const state = lastState(sockets.alice);
    expect(state.house?.definition.id).toBe('cottage');
    expect(state.house?.house).toEqual({ houseId: 'cottage', purchasedAt: 1234, tileId: AGENT_TILE, storage: {}, displays: [null, null] });
    expect(state.house?.location).toMatchObject({ tileId: AGENT_TILE, col: 0, row: 0, roomName: 'Estate Agent' });
  });

  it('refuses when broke, already owning, or away from a shop that sells it', async () => {
    const { pm, session } = await setup();
    expect(pm.housing.buy('alice', 'cottage')?.code).toBe('house_cannot_afford');
    expect(session('alice').getGold()).toBe(0);

    session('alice').grantGold(10_000);
    expect(pm.housing.buy('alice', 'castle')?.code).toBe('house_not_for_sale');
    expect(pm.housing.buy('alice', 'cottage')).toBeNull();
    expect(pm.housing.buy('alice', 'manor')?.code).toBe('house_already_owned');

    session('bob').grantGold(10_000);
    session('bob').getCurrentTile = () => null;
    expect(pm.housing.buy('bob', 'cottage')?.code).toBe('house_not_for_sale');
  });

  it('sells for half the price, refusing while the chest or a shelf holds anything', async () => {
    const { pm, session } = await withHouse();
    const goldAfterBuy = session('alice').getGold();
    session('alice').addToInventory('pelt', 1);
    pm.housing.store('alice', 'pelt', 1);

    expect(pm.housing.sell('alice')?.code).toBe('house_not_empty');
    pm.housing.display('alice', 0, 'pelt');
    expect(pm.housing.sell('alice')?.code).toBe('house_not_empty');

    pm.housing.display('alice', 0, null);
    pm.housing.withdraw('alice', 'pelt', 1);
    expect(pm.housing.sell('alice')).toBeNull();
    expect(session('alice').getHouse()).toBeNull();
    expect(session('alice').getGold()).toBe(goldAfterBuy + 500);
  });

  it('marks owners in the social player list', async () => {
    const { pm } = await withHouse();
    const players = pm.getSocialState('bob').allPlayers;
    expect(players.find(p => p.username === 'alice')?.hasHouse).toBe(true);
    expect(players.find(p => p.username === 'bob')?.hasHouse).toBeUndefined();
  });
});

describe('chest and shelves', () => {
  it('stores and withdraws within the chest slot limit', async () => {
    const { pm, session } = await withHouse();
    const alice = session('alice');
    alice.addToInventory('pelt', 5);
    alice.addToInventory('ruby', 1);
    alice.addToInventory('fang', 1);

    expect(pm.housing.store('alice', 'pelt', 3)).toBeNull();
    expect(pm.housing.store('alice', 'pelt', 2)).toBeNull();
    expect(pm.housing.store('alice', 'ruby', 1)).toBeNull();
    expect(pm.housing.store('alice', 'fang', 1)?.code).toBe('home_chest_full');
    expect(alice.getHouse()!.storage).toEqual({ pelt: 5, ruby: 1 });
    expect(alice.getInventoryCount('pelt')).toBe(0);

    expect(pm.housing.withdraw('alice', 'pelt', 6)?.code).toBe('home_item_missing');
    expect(pm.housing.withdraw('alice', 'pelt', 5)).toBeNull();
    expect(alice.getHouse()!.storage).toEqual({ ruby: 1 });
    expect(alice.getInventoryCount('pelt')).toBe(5);
    expect(pm.housing.store('alice', 'fang', 1)).toBeNull();
  });

  it('only stores unequipped items and rejects bad quantities', async () => {
    const { pm, session } = await withHouse();
    const alice = session('alice');
    alice.addToInventory('sword', 1);
    expect(alice.handleEquipItem('sword')).toBe(true);

    expect(pm.housing.store('alice', 'sword', 1)?.code).toBe('home_item_missing');
    expect(pm.housing.store('alice', 'pelt', 0)?.code).toBe('home_invalid_request');
    expect(pm.housing.store('alice', 'pelt', 1.5)?.code).toBe('home_invalid_request');
  });

  it('moves items between chest and shelf, swapping an occupied shelf', async () => {
    const { pm, session } = await withHouse();
    const house = () => session('alice').getHouse()!;
    session('alice').addToInventory('pelt', 2);
    session('alice').addToInventory('ruby', 1);
    pm.housing.store('alice', 'pelt', 2);
    pm.housing.store('alice', 'ruby', 1);

    expect(pm.housing.display('alice', 0, 'pelt')).toBeNull();
    expect(house().displays).toEqual(['pelt', null]);
    expect(house().storage).toEqual({ pelt: 1, ruby: 1 });

    expect(pm.housing.display('alice', 0, 'ruby')).toBeNull();
    expect(house().displays).toEqual(['ruby', null]);
    expect(house().storage).toEqual({ pelt: 2 });

    expect(pm.housing.display('alice', 5, 'pelt')?.code).toBe('home_invalid_request');
    expect(pm.housing.display('alice', 1, 'fang')?.code).toBe('home_item_missing');
  });

  it('refuses a swap only when the returning item has no chest slot left', async () => {
    const { pm, session } = await withHouse();
    const house = () => session('alice').getHouse()!;
    session('alice').addToInventory('pelt', 3);
    session('alice').addToInventory('ruby', 1);
    session('alice').addToInventory('fang', 1);
    pm.housing.store('alice', 'fang', 1);
    pm.housing.display('alice', 0, 'fang');
    pm.housing.store('alice', 'pelt', 3);
    pm.housing.store('alice', 'ruby', 1);

    expect(pm.housing.display('alice', 0, 'pelt')?.code).toBe('home_chest_full');
    expect(house().displays).toEqual(['fang', null]);
    expect(house().storage).toEqual({ pelt: 3, ruby: 1 });

    expect(pm.housing.display('alice', 0, 'ruby')).toBeNull();
    expect(house().displays).toEqual(['ruby', null]);
    expect(house().storage).toEqual({ pelt: 3, fang: 1 });

    expect(pm.housing.display('alice', 0, null)?.code).toBe('home_chest_full');
  });
});

describe('visiting', () => {
  it('lets the owner in and refuses a stranger', async () => {
    const { pm, sockets } = await withHouse();
    expect(pm.housing.enter('alice', undefined)).toBeNull();
    expect(pm.housing.enter('carol', 'alice')?.code).toBe('home_access_denied');
    expect(pm.housing.enter('bob', 'bob')?.code).toBe('house_not_owned');

    const view = lastState(sockets.alice).homeVisit!;
    expect(view.owner).toBe('alice');
    expect(view.storage).toEqual({});
    expect(view.occupants.map(o => o.username)).toEqual(['alice']);
  });

  it('admits friends and party members, hiding the chest from visitors', async () => {
    const { pm, sockets, session } = await withHouse();
    pm.friends.sendRequest('alice', 'bob');
    pm.friends.acceptRequest('bob', 'alice');
    session('dave').setPartyId(session('alice').getPartyId());

    expect(pm.housing.enter('bob', 'alice')).toBeNull();
    expect(pm.housing.enter('dave', 'alice')).toBeNull();
    const view = lastState(sockets.bob).homeVisit!;
    expect(view.storage).toBeUndefined();
    expect(view.occupants.map(o => o.username).sort()).toEqual(['bob', 'dave']);
  });

  it('lets an invited player in once, within 30 minutes, and notifies them with the owner', async () => {
    const { pm } = await withHouse();
    const notify = vi.spyOn(pm.notify, 'notify');

    expect(pm.housing.invite('alice', 'carol', 0)).toBeNull();
    expect(notify).toHaveBeenCalledWith('carol', 'home_invite', expect.objectContaining({ payload: { owner: 'alice' } }));
    expect(pm.housing.enter('carol', 'alice', 10 * MIN)).toBeNull();
    pm.housing.leave('carol', 11 * MIN);
    expect(pm.housing.enter('carol', 'alice', 12 * MIN)?.code).toBe('home_access_denied');

    pm.housing.invite('alice', 'carol', 0);
    expect(pm.housing.enter('carol', 'alice', HOME_INVITE_TTL_MS + 1)?.code).toBe('home_access_denied');
  });

  it('refuses invites from non-owners, to yourself, or to blockers', async () => {
    const { pm, session } = await withHouse();
    expect(pm.housing.invite('bob', 'alice')?.code).toBe('house_not_owned');
    expect(pm.housing.invite('alice', 'alice')?.code).toBe('home_invite_refused');
    expect(pm.housing.invite('alice', 'nobody')?.code).toBe('home_invite_refused');
    session('carol').setBlockedUsers({ alice: 'all' } as never);
    expect(pm.housing.invite('alice', 'carol')?.code).toBe('home_invite_refused');
  });

  it('pushes everyone inside when someone arrives or a shelf changes', async () => {
    const { pm, sockets, session } = await withHouse();
    pm.housing.enter('alice', undefined);
    pm.housing.invite('alice', 'carol');
    const before = sentCount(sockets.alice);
    pm.housing.enter('carol', 'alice');
    expect(sentCount(sockets.alice)).toBeGreaterThan(before);
    expect(lastState(sockets.alice).homeVisit!.occupants).toHaveLength(2);

    session('alice').addToInventory('ruby', 1);
    pm.housing.store('alice', 'ruby', 1);
    pm.housing.display('alice', 1, 'ruby');
    const visitorView = lastState(sockets.carol).homeVisit!;
    expect(visitorView.displays).toEqual([null, 'ruby']);
    expect(visitorView.itemDefinitions.ruby?.name).toBe('Ruby');
  });

  it('ejects everyone when the owner sells', async () => {
    const { pm, sockets } = await withHouse();
    pm.housing.enter('alice', undefined);
    pm.housing.invite('alice', 'carol');
    pm.housing.enter('carol', 'alice');

    expect(pm.housing.sell('alice')).toBeNull();
    expect(pm.housing.homeOf('carol')).toBeUndefined();
    expect(pm.housing.homeOf('alice')).toBeUndefined();
    expect(lastState(sockets.carol).homeVisit).toBeUndefined();
  });

  it('leaves the home when the last connection closes', async () => {
    const { pm, sockets } = await withHouse();
    pm.housing.enter('alice', undefined);
    pm.removeConnection(sockets.alice);
    expect(pm.housing.homeOf('alice')).toBeUndefined();
  });

  it('keeps a home usable after its definition is deleted', async () => {
    const houses = { cottage: COTTAGE, manor: MANOR };
    const { pm, sockets } = await withHouse(houses);
    delete (houses as Record<string, HouseDefinition>).cottage;
    expect(pm.housing.enter('alice', undefined)).toBeNull();
    expect(lastState(sockets.alice).house?.definition.displaySlots).toBe(2);
  });
});

function standIn(ctx: { session: (name: string) => PlayerSession; grid: HexGrid }, name: string, col: number) {
  const tile = ctx.grid.getTile(offsetToCube({ col, row: 0 })) ?? null;
  ctx.session(name).getCurrentTile = () => tile;
}

describe('homes are places', () => {
  it('only lets you in while your party stands in the home\'s room', async () => {
    const ctx = await withHouse();
    standIn(ctx, 'alice', 1);
    const refusal = ctx.pm.housing.enter('alice', undefined);
    expect(refusal?.code).toBe('home_too_far');
    expect(refusal?.message).toContain('Estate Agent');
    expect(ctx.pm.housing.homeOf('alice')).toBeUndefined();

    standIn(ctx, 'alice', 0);
    expect(ctx.pm.housing.enter('alice', undefined)).toBeNull();
  });

  it('keeps an invite when a guest is refused for being too far away', async () => {
    const ctx = await withHouse();
    ctx.pm.housing.invite('alice', 'dave');
    standIn(ctx, 'dave', 1);
    expect(ctx.pm.housing.enter('dave', 'alice')?.code).toBe('home_too_far');
    standIn(ctx, 'dave', 0);
    expect(ctx.pm.housing.enter('dave', 'alice')).toBeNull();
  });

  it('puts you out, settling rest, when your party walks away', async () => {
    const ctx = await withHouse();
    ctx.pm.housing.enter('alice', undefined, 0);
    ctx.pm.housing.sit('alice', 0);
    standIn(ctx, 'alice', 1);
    ctx.pm.housing.onMembersMoved(['alice'], 10 * MIN);
    expect(ctx.pm.housing.homeOf('alice')).toBeUndefined();
    expect(ctx.session('alice').getWellRestedUntil()).toBe(10 * MIN + 10 * MIN * RESTED_MS_PER_SIT_MS);
  });

  it('also puts out anyone moved away by other means on the rest tick', async () => {
    const ctx = await withHouse();
    ctx.pm.housing.enter('alice', undefined);
    standIn(ctx, 'alice', 1);
    ctx.pm.housing.tickResting();
    expect(ctx.pm.housing.homeOf('alice')).toBeUndefined();
  });

  it('walks the party home and lets you in on arrival', async () => {
    const ctx = await withHouse();
    standIn(ctx, 'alice', 1);
    const move = vi.spyOn(ctx.pm.partyBattles, 'handleMove').mockReturnValue({ success: true });
    expect(ctx.pm.housing.travel('alice', undefined)).toBeNull();
    expect(move).toHaveBeenCalledWith(ctx.session('alice').getPartyId(), 0, 0);

    ctx.pm.housing.onMembersMoved(['alice']);
    expect(ctx.pm.housing.homeOf('alice')).toBeUndefined();
    standIn(ctx, 'alice', 0);
    ctx.pm.housing.onMembersMoved(['alice']);
    expect(ctx.pm.housing.homeOf('alice')).toBe('alice');
  });

  it('enters straight away when travelling to a home you are already at', async () => {
    const ctx = await withHouse();
    expect(ctx.pm.housing.travel('alice', undefined)).toBeNull();
    expect(ctx.pm.housing.homeOf('alice')).toBe('alice');
  });

  it('refuses travel for strangers and explains a failed move', async () => {
    const ctx = await withHouse();
    standIn(ctx, 'dave', 1);
    expect(ctx.pm.housing.travel('dave', 'alice')?.code).toBe('home_access_denied');

    standIn(ctx, 'alice', 1);
    vi.spyOn(ctx.pm.partyBattles, 'handleMove').mockReturnValue({ success: false });
    expect(ctx.pm.housing.travel('alice', undefined)?.code).toBe('home_cannot_travel');
  });

  it('places a home bought before homes had a room at an estate agent that sells it', async () => {
    const ctx = await withHouse();
    delete ctx.session('alice').getHouse()!.tileId;
    standIn(ctx, 'alice', 1);
    expect(ctx.pm.housing.enter('alice', undefined)?.code).toBe('home_too_far');
    expect(ctx.session('alice').getHouse()!.tileId).toBe(AGENT_TILE);
  });

  it('lets you in from anywhere when no room can be found for the home', async () => {
    const ctx = await withHouse({ cottage: COTTAGE, manor: MANOR });
    const house = ctx.session('alice').getHouse()!;
    house.tileId = 'deleted-room';
    house.houseId = 'unsold';
    standIn(ctx, 'alice', 1);
    expect(ctx.pm.housing.enter('alice', undefined)).toBeNull();
  });
});

describe('Well Rested', () => {
  it('accrues on stand and on leave, and only while sitting inside a home', async () => {
    const { pm, session } = await withHouse();
    expect(pm.housing.sit('alice', 0)?.code).toBe('home_not_inside');

    pm.housing.enter('alice', undefined, 0);
    pm.housing.sit('alice', 0);
    pm.housing.stand('alice', 10 * MIN);
    expect(session('alice').getWellRestedUntil()).toBe(10 * MIN + 10 * MIN * RESTED_MS_PER_SIT_MS);

    pm.housing.sit('alice', 20 * MIN);
    pm.housing.leave('alice', 25 * MIN);
    expect(session('alice').getWellRestedUntil()).toBe(10 * MIN + 15 * MIN * RESTED_MS_PER_SIT_MS);
  });

  it('banks rest periodically while sitting, without double counting', async () => {
    const { pm, session, sockets } = await withHouse();
    pm.housing.enter('alice', undefined, 0);
    pm.housing.sit('alice', 0);
    pm.housing.tickResting(MIN);
    expect(session('alice').getWellRestedUntil()).toBe(MIN + MIN * RESTED_MS_PER_SIT_MS);
    expect(lastState(sockets.alice).homeVisit!.occupants[0].sitting).toBe(true);

    pm.housing.stand('alice', 2 * MIN);
    expect(session('alice').getWellRestedUntil()).toBe(MIN + 2 * MIN * RESTED_MS_PER_SIT_MS);
  });

  it('boosts victory XP and gold while rested', () => {
    const tile = new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', 'hatchetmill', AGENT_TILE);
    const run = async (wellRestedUntil: number | undefined) => {
      const { session } = await setup();
      const alice = session('alice');
      alice.setWellRestedUntil(wellRestedUntil);
      const goldBefore = alice.getGold();
      const xpBefore = (alice as unknown as { character: { xp: number } }).character.xp;
      alice.handleVictory({ xp: 20, gold: 100, items: [] }, tile, { unlockTiles: false }, 1000);
      return {
        gold: alice.getGold() - goldBefore,
        xp: (alice as unknown as { character: { xp: number } }).character.xp - xpBefore,
      };
    };
    return Promise.all([run(undefined), run(5000), run(500)]).then(([plain, rested, expired]) => {
      expect(plain).toEqual({ gold: 100, xp: 20 });
      expect(rested).toEqual({ gold: Math.floor(100 * WELL_RESTED_BONUS), xp: Math.floor(20 * WELL_RESTED_BONUS) });
      expect(expired).toEqual(plain);
    });
  });
});

describe('persistence', () => {
  it('round-trips the house and Well Rested through save data', async () => {
    const { pm, session, grid, content } = await withHouse();
    session('alice').addToInventory('ruby', 2);
    pm.housing.store('alice', 'ruby', 2);
    pm.housing.display('alice', 1, 'ruby');
    session('alice').setWellRestedUntil(Date.now() + 60 * MIN);

    const save = session('alice').toSaveData();
    const restored = PlayerSession.fromSaveData(JSON.parse(JSON.stringify(save)), wrapGrids(grid), content);

    expect(restored.getHouse()).toEqual({ houseId: 'cottage', purchasedAt: expect.any(Number), tileId: AGENT_TILE, storage: { ruby: 1 }, displays: [null, 'ruby'] });
    expect(restored.getWellRestedUntil()).toBe(save.wellRestedUntil);
  });
});
