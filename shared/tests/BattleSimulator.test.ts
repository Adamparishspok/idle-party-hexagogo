import { describe, expect, it } from 'vitest';
import { BATTLE_OVERHEAD_MS, BattleSimulation, buildSimCombatant, runBattleSimulation } from '../src/systems/BattleSimulator';
import type { SimContent, SimInput } from '../src/systems/BattleSimulator';
import { SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES } from '../src/systems/SkillTypes';
import type { MonsterDefinition } from '../src/systems/MonsterTypes';

const rat: MonsterDefinition = { id: 'rat', name: 'Rat', level: 1, hp: 30, damage: 3, damageType: 'physical', xp: 10, goldMin: 2, goldMax: 4 };
const ogre: MonsterDefinition = { id: 'ogre', name: 'Ogre', level: 9, hp: 100000, damage: 200, damageType: 'physical', xp: 500, goldMin: 0, goldMax: 0 };

const content: SimContent = {
  skills: SEED_SKILLS,
  slotSchedules: SEED_SKILL_SLOT_SCHEDULES,
  monsters: { rat, ogre },
  zones: { meadow: { id: 'meadow', displayName: 'Meadow', levelRange: [1, 3], encounterTable: [{ encounterId: 'rats', weight: 1 }] } },
  encounters: {
    rats: { id: 'rats', name: 'Rats', type: 'explicit', placements: [{ monsterId: 'rat', gridPosition: 4 }, { monsterId: 'rat', gridPosition: 1 }] },
    ogre: { id: 'ogre', name: 'Ogre', type: 'explicit', placements: [{ monsterId: 'ogre', gridPosition: 4 }] },
  },
  dungeons: {
    cave: {
      id: 'cave', name: 'Cave', description: '',
      floors: [
        { floorNumber: 1, grid: { rows: 3, cols: 3 }, encounterTable: [{ encounterId: 'rats', weight: 1 }] },
        { floorNumber: 2, grid: { rows: 3, cols: 3 }, encounterTable: [{ encounterId: 'rats', weight: 1 }] },
      ],
    } as never,
  },
  worldBosses: {
    ogreboss: {
      id: 'ogreboss', name: 'Big Ogre', monsterId: 'ogre', maxHp: 5000, tileIds: [], respawnMinSec: 1, respawnMaxSec: 2,
      retryCooldownSec: 1, retryCooldownStepSec: 1, retryCooldownMaxSec: 1, rewardXp: 0, rewardGold: 0, minContributionPct: 0,
    },
  },
  items: {},
  sets: {},
};

const party = () => [
  buildSimCombatant({ username: 'a', className: 'Knight', level: 10, equipment: {}, gridPosition: 4 }, content),
  buildSimCombatant({ username: 'b', className: 'Mage', level: 10, equipment: {}, gridPosition: 3 }, content),
];

const input = (opponent: SimInput['opponent'], battles = 30, seed = 7): SimInput => ({ players: party(), opponent, content, battles, seed });

describe('BattleSimulation', () => {
  it('is deterministic for a fixed seed and independent of chunking', () => {
    const a = runBattleSimulation(input({ type: 'zone', id: 'meadow' }));
    const b = runBattleSimulation(input({ type: 'zone', id: 'meadow' }));
    const chunked = new BattleSimulation(input({ type: 'zone', id: 'meadow' }));
    while (!chunked.done) chunked.step(0);
    expect(b).toEqual(a);
    expect(chunked.report()).toEqual(a);
  });

  it('does not mutate its inputs or leave Math.random replaced', () => {
    const before = Math.random;
    const i = input({ type: 'encounter', id: 'rats' });
    const snapshot = JSON.stringify(i);
    runBattleSimulation(i);
    expect(JSON.stringify(i)).toBe(snapshot);
    expect(Math.random).toBe(before);
  });

  it('reports wins, rewards split across the party, and hourly rates from the real tick length', () => {
    const r = runBattleSimulation(input({ type: 'encounter', id: 'rats' }));
    expect(r.winRate).toBe(1);
    expect(r.xpPerBattle).toBe(10);
    expect(r.goldPerBattle).toBeGreaterThanOrEqual(2);
    expect(r.cycleSeconds * 1000).toBeCloseTo(r.ticks.avg * 1000 + BATTLE_OVERHEAD_MS);
    expect(r.xpPerHour).toBeCloseTo(10 * 3600 / r.cycleSeconds);
    expect(r.members.map(m => m.name)).toEqual(['a', 'b']);
    expect(r.members.reduce((s, m) => s + m.damageDealt, 0) + r.effectsDamageDealt).toBeGreaterThan(0);
  });

  it('runs every dungeon floor in one run', () => {
    const r = runBattleSimulation(input({ type: 'dungeon', id: 'cave' }, 5));
    expect(r.winRate).toBe(1);
    expect(r.xpPerBattle).toBe(20);
  });

  it('reports damage dealt to a world boss per attempt', () => {
    const r = runBattleSimulation(input({ type: 'worldBoss', id: 'ogreboss' }, 5));
    expect(r.winRate).toBe(0);
    expect(r.worldBoss!.maxHp).toBe(5000);
    expect(r.worldBoss!.damage.avg).toBeGreaterThan(0);
    expect(r.worldBoss!.damage.avg).toBeLessThanOrEqual(5000);
  });
});
