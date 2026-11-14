import { describe, it, expect } from 'vitest';
import {
  BattleSimulation, SEED_ITEMS, SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES, buildSimCombatant, sanitizeSkillLoadout, simSlotChoices,
} from '../src/index.js';
import type { SimContent, SimOpponent } from '../src/index.js';

const itemIds = Object.keys(SEED_ITEMS);
const [guaranteed, never] = itemIds;

function content(overrides: Partial<SimContent> = {}): SimContent {
  return {
    skills: SEED_SKILLS,
    slotSchedules: SEED_SKILL_SLOT_SCHEDULES,
    monsters: {
      dummy: { id: 'dummy', name: 'Dummy', hp: 1, damage: 0, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0, drops: [{ itemId: guaranteed, chance: 1 }, { itemId: never, chance: 0 }] },
    },
    zones: {},
    encounters: { e: { id: 'e', name: 'E', type: 'random', monsterPool: [{ monsterId: 'dummy', min: 2, max: 2 }], roomMax: 9 } },
    dungeons: {
      d: {
        id: 'd', name: 'D',
        floors: [1, 2].map(floorNumber => ({
          floorNumber, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'e', weight: 1 }],
          rewards: [{ itemId: never, chance: 1, minQty: 3, maxQty: 3 }],
        })),
        firstClearRewards: [{ itemId: guaranteed, chance: 0.5, minQty: 1, maxQty: 3 }],
        firstClearGold: 50,
      },
    },
    worldBosses: {},
    items: SEED_ITEMS,
    sets: {},
    ...overrides,
  };
}

function run(opponent: SimOpponent, c: SimContent, humans = 1, henchmen = 0) {
  const spec = (i: number) => buildSimCombatant(
    { username: `p${i}`, className: 'Knight', level: 50, equipment: {}, gridPosition: ([4, 3, 5, 1][i]) as 4 },
    c,
  );
  const players = Array.from({ length: humans + henchmen }, (_, i) => ({ ...spec(i), isHenchman: i >= humans }));
  const sim = new BattleSimulation({ players, opponent, content: c, battles: 20, seed: 1 });
  while (!sim.done) sim.step(Infinity);
  return sim.report();
}

describe('simulator drops', () => {
  it('counts every guaranteed monster drop and ignores zero-chance ones', () => {
    const r = run({ type: 'encounter', id: 'e' }, content());
    expect(r.drops).toHaveLength(1);
    expect(r.drops[0]).toMatchObject({ itemId: guaranteed, perBattle: 2 });
    expect(r.drops[0].perHour).toBeCloseTo(2 * 3_600 / r.cycleSeconds);
  });

  it('loses the henchman share of drops', () => {
    const r = run({ type: 'encounter', id: 'e' }, content(), 1, 1);
    expect(r.drops[0].perBattle).toBeGreaterThan(0.5);
    expect(r.drops[0].perBattle).toBeLessThan(1.5);
  });

  it('adds dungeon floor rewards per human per floor and reports first-clear rewards separately', () => {
    const r = run({ type: 'dungeon', id: 'd' }, content(), 2, 1);
    expect(r.drops.find(d => d.itemId === never)?.perBattle).toBe(3 * 2 * 2);
    expect(r.firstClear).toMatchObject({ gold: 50 });
    expect(r.firstClear!.items[0].expected).toBeCloseTo(1);
  });
});

describe('simulator skill loadouts', () => {
  it('only offers class skills of the slot type and drops invalid picks', () => {
    const c = content();
    const choices = simSlotChoices('Knight', 50, c);
    expect(choices.length).toBeGreaterThan(0);
    for (const slot of choices) for (const s of slot.options) {
      expect(s.className).toBe('Knight');
      expect(s.type).toBe(slot.type);
    }
    const valid = choices.find(slot => slot.options.length > 0)!;
    const picked = sanitizeSkillLoadout(choices.map(() => 'nonsense'), 'Knight', 50, c);
    expect(picked.every(p => p === null)).toBe(true);
    const ok = choices.map(slot => (slot === valid ? slot.options[0].id : null));
    expect(sanitizeSkillLoadout(ok, 'Knight', 50, c)[valid.slotIndex]).toBe(valid.options[0].id);
  });
});
