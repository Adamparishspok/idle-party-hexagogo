import { describe, it, expect, vi } from 'vitest';
import { worldBossCooldownMs, worldBossShare, validateWorldBossDefinition } from '@idle-party-rpg/shared';
import type { MonsterDefinition, PartyCombatState, WorldBossDefinition } from '@idle-party-rpg/shared';
import { WorldBossSystem } from '../src/game/WorldBossSystem.js';
import { creditBossDamage } from '../src/game/PartyBattleManager.js';
import { PlayerSession } from '../src/game/PlayerSession.js';

const T0 = 1_000_000;

function makeBoss(over: Partial<WorldBossDefinition> = {}): WorldBossDefinition {
  return {
    id: 'ashmaw', name: 'Ashmaw', monsterId: 'dragon', maxHp: 1000, tileIds: ['room-a'],
    respawnMinSec: 60, respawnMaxSec: 120,
    retryCooldownSec: 60, retryCooldownStepSec: 30, retryCooldownMaxSec: 120,
    rewardXp: 1000, rewardGold: 500, minContributionPct: 0.1,
    ...over,
  };
}

const DRAGON: MonsterDefinition = { id: 'dragon', name: 'Dragon', hp: 50, damage: 9, damageType: 'physical', xp: 10, goldMin: 0, goldMax: 0 };

function makeSystem(defs: Record<string, WorldBossDefinition> = { ashmaw: makeBoss() }, rng = () => 0.5) {
  const reward = vi.fn();
  const onChanged = vi.fn();
  const system = new WorldBossSystem({ getDefinitions: () => defs, getMonster: id => (id === 'dragon' ? DRAGON : undefined), reward, onChanged, rng });
  return { system, reward, onChanged, defs };
}

describe('world boss rules', () => {
  it('escalates the retry cooldown per failed attempt, up to the cap', () => {
    const boss = makeBoss();
    expect(worldBossCooldownMs(boss, 1)).toBe(60_000);
    expect(worldBossCooldownMs(boss, 2)).toBe(90_000);
    expect(worldBossCooldownMs(boss, 3)).toBe(120_000);
    expect(worldBossCooldownMs(boss, 10)).toBe(120_000);
  });

  it('pays a share of the pools by damage, nothing below the threshold', () => {
    const boss = makeBoss();
    expect(worldBossShare(boss, 250)).toBe(0.25);
    expect(worldBossShare(boss, 99)).toBe(0);
    expect(worldBossShare(boss, 5000)).toBe(1);
  });

  it('validates definitions', () => {
    expect(validateWorldBossDefinition(makeBoss())).toBeNull();
    expect(validateWorldBossDefinition(makeBoss({ tileIds: [] }))).toMatch(/spawn room/);
    expect(validateWorldBossDefinition(makeBoss({ respawnMinSec: 10, respawnMaxSec: 5 }))).toMatch(/respawn/);
  });
});

describe('WorldBossSystem', () => {
  it('spawns a new boss at full HP in one of its rooms and starts fights at the shared HP', () => {
    const { system, onChanged } = makeSystem();
    system.tick(T0);
    expect(onChanged).toHaveBeenCalledTimes(1);
    const live = system.liveAt('room-a')!;
    expect(live.state.currentHp).toBe(1000);
    system.dealDamage('ashmaw', live.state.spawnedAt, { alice: 100 }, T0);
    const instance = system.createInstance(system.liveAt('room-a')!)!;
    expect(instance).toMatchObject({ name: 'Ashmaw', maxHp: 1000, currentHp: 900, damage: 9 });
  });

  it('lets concurrent parties chip at one HP pool and tracks contributions by username', () => {
    const { system } = makeSystem();
    system.tick(T0);
    const { spawnedAt } = system.liveAt('room-a')!.state;
    expect(system.dealDamage('ashmaw', spawnedAt, { alice: 150 })).toBe(850);
    expect(system.dealDamage('ashmaw', spawnedAt, { bob: 50, cara: 50 })).toBe(750);
    expect(system.dealDamage('ashmaw', spawnedAt, { alice: 50 })).toBe(700);
    expect(system.getStates()[0].contributions).toEqual({ alice: 200, bob: 50, cara: 50 });
  });

  it('on the kill pays every contributor over the threshold, despawns and schedules the respawn', () => {
    const { system, reward, onChanged } = makeSystem();
    system.tick(T0);
    const { spawnedAt } = system.liveAt('room-a')!.state;
    system.dealDamage('ashmaw', spawnedAt, { offline_bob: 50, alice: 300 });
    expect(system.dealDamage('ashmaw', spawnedAt, { cara: 700 }, T0 + 10)).toBe(0);

    expect(reward.mock.calls.map(([u, , share]) => [u, share]).sort()).toEqual([['alice', 0.3], ['cara', 0.65]]);
    expect(system.liveAt('room-a')).toBeUndefined();
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(system.getStates()[0]).toMatchObject({ alive: false, nextSpawnAt: T0 + 10 + 90_000, contributions: {} });

    system.tick(T0 + 10 + 89_999);
    expect(system.liveAt('room-a')).toBeUndefined();
    system.tick(T0 + 10 + 90_000);
    expect(system.liveAt('room-a')?.state.currentHp).toBe(1000);
  });

  it('ignores damage from a fight against a spawn that is already gone', () => {
    const { system, reward } = makeSystem();
    system.tick(T0);
    const { spawnedAt } = system.liveAt('room-a')!.state;
    system.dealDamage('ashmaw', spawnedAt, { alice: 1000 }, T0);
    expect(system.dealDamage('ashmaw', spawnedAt, { bob: 40 }, T0)).toBe(0);
    expect(reward).toHaveBeenCalledTimes(1);
  });

  it('leaves unbeaten after despawnAfterSec without paying anyone', () => {
    const { system, reward } = makeSystem({ ashmaw: makeBoss({ despawnAfterSec: 600 }) });
    system.tick(T0);
    system.dealDamage('ashmaw', T0, { alice: 500 });
    system.tick(T0 + 600_000);
    expect(system.liveAt('room-a')).toBeUndefined();
    expect(reward).not.toHaveBeenCalled();
  });

  it('keeps shared HP and contributions across a restart', () => {
    const first = makeSystem();
    first.system.tick(T0);
    first.system.dealDamage('ashmaw', T0, { alice: 400 });
    const saved = JSON.parse(JSON.stringify(first.system.getStates()));

    const second = makeSystem();
    second.system.restore(saved);
    second.system.tick(T0 + 1000);
    expect(second.onChanged).not.toHaveBeenCalled();
    expect(second.system.liveAt('room-a')!.state).toMatchObject({ currentHp: 600, spawnedAt: T0, contributions: { alice: 400 } });
  });

  it('forgets a boss whose definition was deleted', () => {
    const { system, defs } = makeSystem({ ashmaw: makeBoss() });
    system.tick(T0);
    delete defs.ashmaw;
    system.tick(T0 + 1);
    expect(system.getStates()).toEqual([]);
  });

  it('lists live bosses with the viewer\'s active cooldown only', () => {
    const { system } = makeSystem();
    system.tick(T0);
    const list = system.clientList(() => ({ spawnedAt: T0, attempts: 1, until: T0 + 5000 }), T0);
    expect(list).toEqual([{ bossId: 'ashmaw', name: 'Ashmaw', tileId: 'room-a', currentHp: 1000, maxHp: 1000, cooldownUntil: T0 + 5000 }]);
    expect(system.clientList(() => ({ spawnedAt: T0, attempts: 1, until: T0 }), T0 + 1)[0].cooldownUntil).toBeUndefined();
  });
});

describe('creditBossDamage', () => {
  const players = [
    { username: 'alice', gridPosition: 4 },
    { username: 'bob', gridPosition: 1 },
    { username: 'Grim', gridPosition: 7, isHenchman: true },
  ];
  const combat = (lastAction: PartyCombatState['lastAction']) => ({ players, lastAction }) as unknown as PartyCombatState;

  it('credits the human who acted', () => {
    expect(creditBossDamage(combat({ attackerSide: 'player', attackerPos: 1, targetPos: 4, targetSide: 'monster', dodged: false }), 30)).toEqual({ bob: 30 });
  });

  it('splits damage dealt outside a human\'s turn across the humans', () => {
    expect(creditBossDamage(combat({ attackerSide: 'monster', attackerPos: 4, targetPos: 4, targetSide: 'player', dodged: false }), 7)).toEqual({ alice: 4, bob: 3 });
    expect(creditBossDamage(combat({ attackerSide: 'player', attackerPos: 7, targetPos: 4, targetSide: 'monster', dodged: false }), 2)).toEqual({ alice: 1, bob: 1 });
  });
});

describe('PlayerSession world boss cooldowns', () => {
  function makeSession(): PlayerSession {
    return Object.create(PlayerSession.prototype) as PlayerSession;
  }

  it('escalates per attempt against one spawn and resets for a new spawn', () => {
    const session = makeSession();
    session['worldBossCooldowns'] = {};
    const boss = makeBoss();
    expect(session.recordWorldBossDefeat(boss, T0, T0).until).toBe(T0 + 60_000);
    expect(session.recordWorldBossDefeat(boss, T0, T0).until).toBe(T0 + 90_000);
    expect(session.isOnWorldBossCooldown('ashmaw', T0, T0 + 89_999)).toBe(true);
    expect(session.isOnWorldBossCooldown('ashmaw', T0, T0 + 90_000)).toBe(false);
    expect(session.isOnWorldBossCooldown('ashmaw', T0 + 5, T0)).toBe(false);
    expect(session.recordWorldBossDefeat(boss, T0 + 5, T0).attempts).toBe(1);
  });
});
