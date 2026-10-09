import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPartyCombatState, processPartyTick } from '../src/systems/CombatEngine';
import type { PartyCombatant } from '../src/systems/CombatEngine';
import { createMonsterInstance, SEED_MONSTERS } from '../src/systems/MonsterTypes';
import { CLASS_DEFINITIONS } from '../src/systems/CharacterStats';
import type { ClassName } from '../src/systems/CharacterStats';
import type { PartyGridPosition } from '../src/systems/SocialTypes';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import type { SkillDefinition } from '../src/systems/SkillTypes';

function combatant(username: string, pos: PartyGridPosition, className: ClassName, extra: Partial<PartyCombatant> = {}): PartyCombatant {
  return {
    username,
    maxHp: 500,
    currentHp: 500,
    baseDamage: 10,
    playerDamageType: CLASS_DEFINITIONS[className].damageType,
    gridPosition: pos,
    className,
    level: 5,
    equippedSkills: [null, null, null, null, null] as (SkillDefinition | null)[],
    attackCount: 0,
    stunTurns: 0,
    dots: [],
    hots: [],
    damageShield: 0,
    debuffs: [],
    consecutiveHits: 0,
    lastTargetId: '',
    hasResurrected: false,
    martyrBonus: 0,
    braceActive: false,
    braceDamageTaken: 0,
    interceptActive: false,
    activeSkillCount: 0,
    ...extra,
  };
}

function bigGoblin() {
  const m = createMonsterInstance(SEED_MONSTERS.goblin, 4);
  m.maxHp = 10_000;
  m.currentHp = 10_000;
  m.resistances = [];
  return m;
}

function hitAmount(lines: string[]): number {
  const line = lines.find(l => / hits .* for \d+/.test(l))!;
  return Number(/for (\d+)/.exec(line)![1]);
}

afterEach(() => vi.restoreAllMocks());

describe('derived stats in combat', () => {
  it('attribute crit doubles a hit', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.4);
    const plain = createPartyCombatState([combatant('A', 2, 'Archer')], [bigGoblin()]);
    const critting = createPartyCombatState([combatant('A', 2, 'Archer', { critChance: 0.5 })], [bigGoblin()]);
    const normal = hitAmount(processPartyTick(plain).logEntries);
    const crit = hitAmount(processPartyTick(critting).logEntries);
    expect(crit).toBe(normal * 2);
  });

  it('no crit roll is consumed when crit chance is zero', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.4);
    processPartyTick(createPartyCombatState([combatant('A', 2, 'Archer', { critChance: 0 })], [bigGoblin()]));
    const callsWithout = spy.mock.calls.length;
    spy.mockClear();
    processPartyTick(createPartyCombatState([combatant('A', 2, 'Archer', { critChance: 0.1 })], [bigGoblin()]));
    expect(spy.mock.calls.length).toBe(callsWithout + 1);
  });

  it('personal dodge avoids monster attacks', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const state = createPartyCombatState([combatant('A', 0, 'Archer', { dodgeChance: 0.15 })], [bigGoblin()]);
    processPartyTick(state);
    const monsterTurn = processPartyTick(state);
    expect(monsterTurn.logEntries.some(l => l.includes('dodges'))).toBe(true);
    expect(state.players[0].currentHp).toBe(500);
  });

  it('healing multiplier scales direct heals', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const run = (healingMultiplier?: number) => {
      const priest = combatant('P', 2, 'Priest', {
        equippedSkills: [SEED_SKILLS.priest_bless, SEED_SKILLS.priest_minor_heal, null, null, null],
        healingMultiplier,
      });
      const tank = combatant('T', 0, 'Knight');
      const state = createPartyCombatState([priest, tank], [bigGoblin()]);
      state.players.find(p => p.username === 'T')!.currentHp = 100;
      processPartyTick(state);
      return state.players.find(p => p.username === 'T')!.currentHp - 100;
    };
    const base = run();
    expect(base).toBeGreaterThan(0);
    expect(run(2)).toBe(base * 2);
  });

  it('healing multiplier scales heal-over-time', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const mending = SEED_SKILLS.priest_mending;
    const run = (healingMultiplier?: number) => {
      const priest = combatant('P', 2, 'Priest', { equippedSkills: [SEED_SKILLS.priest_bless, mending, null, null, null], healingMultiplier });
      const state = createPartyCombatState([priest], [bigGoblin()]);
      state.players[0].currentHp = 50;
      for (let i = 0; i < 4; i++) {
        const line = processPartyTick(state).logEntries.find(l => l.includes('applies Mending'));
        if (line) return Number(/\((\d+) HP\/tick/.exec(line)![1]);
      }
      return 0;
    };
    const base = run();
    expect(base).toBeGreaterThan(0);
    expect(run(1.5)).toBe(Math.floor(base * 1.5));
  });
});
