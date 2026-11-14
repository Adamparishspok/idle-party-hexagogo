import { describe, expect, it } from 'vitest';
import { SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES } from '@idle-party-rpg/shared';
import { registerSimulatorRoutes } from '../src/admin/simulatorRoutes.js';

type Handler = (req: { body?: unknown }, res: FakeRes) => unknown;
interface FakeRes { code: number; body: unknown; status(c: number): FakeRes; json(b: unknown): void }

function setup() {
  const routes: Record<string, Handler> = {};
  const router = { get: (p: string, h: Handler) => { routes[`GET ${p}`] = h; }, post: (p: string, h: Handler) => { routes[`POST ${p}`] = h; } };
  const store = {
    getAllSkills: () => SEED_SKILLS,
    getAllSkillSlotSchedules: () => SEED_SKILL_SLOT_SCHEDULES,
    getAllMonsters: () => ({ rat: { id: 'rat', name: 'Rat', level: 1, hp: 20, damage: 2, damageType: 'physical', xp: 5, goldMin: 1, goldMax: 1 } }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({ rats: { id: 'rats', name: 'Rats', type: 'explicit', placements: [{ monsterId: 'rat', gridPosition: 4 }] } }),
    getAllDungeons: () => ({}),
    getAllWorldBosses: () => ({}),
    getAllItems: () => ({}),
    getAllSets: () => ({}),
    getHenchman: () => undefined,
  };
  registerSimulatorRoutes(router as never, { playerManager: () => ({}) as never, contentStore: () => store as never });
  const call = async (key: string, body: unknown) => {
    const res: FakeRes = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    await routes[key]({ body }, res);
    return res;
  };
  return { call };
}

describe('simulator route', () => {
  it('runs a built party and returns a report', async () => {
    const { call } = setup();
    const res = await call('POST /simulator/run', {
      party: { members: [{ className: 'Knight', level: 5, equipment: {} }] },
      opponent: { type: 'encounter', id: 'rats' }, battles: 10, seed: 1,
    });
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ battles: 10, winRate: 1 });
  });

  it('rejects a bad opponent, an unknown item and a missing party', async () => {
    const { call } = setup();
    const party = { members: [{ className: 'Knight', level: 5, equipment: {} }] };
    expect((await call('POST /simulator/run', { party, opponent: { type: 'zone', id: 'nope' }, battles: 5 })).code).toBe(400);
    expect((await call('POST /simulator/run', { party: { members: [{ className: 'Knight', level: 5, equipment: { head: 'ghost' } }] }, opponent: { type: 'encounter', id: 'rats' }, battles: 5 })).code).toBe(400);
    expect((await call('POST /simulator/run', { party: {}, opponent: { type: 'encounter', id: 'rats' }, battles: 5 })).code).toBe(400);
  });
});
