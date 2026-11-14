import type { Router } from 'express';
import {
  ALL_CLASS_NAMES,
  BattleSimulation,
  MAX_PARTY_SIZE,
  SIM_MAX_BATTLES,
  buildHenchmanCombatant,
  buildSimCombatant,
  henchmanDisplayNames,
} from '@idle-party-rpg/shared';
import type { ClassName, HenchmanDefinition, SkillSlot, PartyCombatant, PartyGridPosition, SimContent, SimOpponent, SimReport } from '@idle-party-rpg/shared';
import type { ContentStore } from '../game/ContentStore.js';
import type { ContentSnapshot, VersionStore } from '../game/VersionStore.js';
import { toRecord } from '../game/DraftEditor.js';
import type { PlayerManager } from '../game/PlayerManager.js';

export interface SimulatorRouteOptions {
  playerManager: () => PlayerManager;
  contentStore: () => ContentStore;
  versionStore: () => VersionStore;
}

export type SimRunContent = SimContent & { henchmen: Record<string, HenchmanDefinition> };

const OPPONENT_TYPES: SimOpponent['type'][] = ['encounter', 'zone', 'dungeon', 'worldBoss'];
const GRID_ORDER: PartyGridPosition[] = [4, 3, 5, 1, 7, 0, 2, 6, 8];
const SLICE_MS = 25;

class SimRequestError extends Error {}

interface SimJob {
  sim: BattleSimulation;
  state: 'running' | 'done' | 'cancelled' | 'error';
  cancelled: boolean;
  report?: SimReport;
  error?: string;
}

let job: SimJob | null = null;

interface MemberBody {
  className?: unknown;
  level?: unknown;
  equipment?: unknown;
  skillIds?: unknown;
  gridPosition?: unknown;
}

function simContent(store: ContentStore): SimRunContent {
  return {
    henchmen: store.getAllHenchmen(),
    skills: store.getAllSkills(),
    slotSchedules: store.getAllSkillSlotSchedules(),
    monsters: store.getAllMonsters(),
    zones: store.getAllZones(),
    encounters: store.getAllEncounters(),
    dungeons: store.getAllDungeons(),
    worldBosses: store.getAllWorldBosses(),
    items: store.getAllItems(),
    sets: store.getAllSets(),
  };
}

/** A draft snapshot as simulator content; tables the snapshot predates fall back to live, like `GET /versions/:id/content`. */
export function draftSimContent(snapshot: ContentSnapshot, store: ContentStore): SimRunContent {
  const live = simContent(store);
  const schedules: Record<string, SkillSlot[]> = snapshot.skillSlotSchedules
    ? Object.fromEntries(snapshot.skillSlotSchedules.map(e => [e.className, e.slots]))
    : live.slotSchedules;
  return {
    skills: snapshot.skills ? toRecord(snapshot.skills) : live.skills,
    slotSchedules: schedules,
    monsters: toRecord(snapshot.monsters),
    zones: toRecord(snapshot.zones),
    encounters: toRecord(snapshot.encounters ?? []),
    dungeons: toRecord(snapshot.dungeons ?? []),
    worldBosses: snapshot.worldBosses ? toRecord(snapshot.worldBosses) : live.worldBosses,
    items: toRecord(snapshot.items),
    sets: toRecord(snapshot.sets ?? []),
    henchmen: snapshot.henchmen ? toRecord(snapshot.henchmen) : live.henchmen,
  };
}

function takeGrid(taken: Set<number>, wanted: unknown): PartyGridPosition {
  const requested = Number(wanted);
  const pos = Number.isInteger(requested) && requested >= 0 && requested <= 8 && !taken.has(requested)
    ? requested as PartyGridPosition
    : GRID_ORDER.find(g => !taken.has(g));
  if (pos === undefined) throw new SimRequestError('No free grid position.');
  taken.add(pos);
  return pos;
}

function buildMember(raw: MemberBody, index: number, taken: Set<number>, content: SimContent): PartyCombatant {
  const className = raw.className as ClassName;
  if (!ALL_CLASS_NAMES.includes(className)) throw new SimRequestError(`Member ${index + 1}: unknown class.`);
  const level = Number(raw.level);
  if (!Number.isInteger(level) || level < 1 || level > 200) throw new SimRequestError(`Member ${index + 1}: level must be 1-200.`);
  const equipment: Record<string, string | null> = {};
  for (const [slot, itemId] of Object.entries((raw.equipment ?? {}) as Record<string, unknown>)) {
    if (typeof itemId !== 'string' || !itemId) continue;
    if (!content.items[itemId]) throw new SimRequestError(`Member ${index + 1}: unknown item "${itemId}".`);
    equipment[slot] = itemId;
  }
  const skillIds = Array.isArray(raw.skillIds)
    ? raw.skillIds.map(s => (typeof s === 'string' && content.skills[s] ? s : null))
    : undefined;
  return buildSimCombatant(
    { username: `${className} ${index + 1}`, className, level, equipment, skillIds, gridPosition: takeGrid(taken, raw.gridPosition) },
    content,
  );
}

function copyParty(username: string, pm: PlayerManager, content: SimRunContent): PartyCombatant[] {
  const partyId = pm.getSessionByUsername(username)?.getPartyId();
  const party = partyId ? pm.parties.getParty(partyId) : undefined;
  if (!partyId || !party) throw new SimRequestError(`No loaded party for "${username}".`);
  const players: PartyCombatant[] = [];
  for (const member of party.members) {
    const session = pm.getSessionByUsername(member.username);
    if (!session?.hasCharacter()) continue;
    players.push({ ...session.getCombatInfo(), gridPosition: member.gridPosition });
  }
  const hires = pm.parties.getHenchmen(partyId)
    .map(hired => ({ hired, def: content.henchmen[hired.henchmanId] }))
    .filter((h): h is typeof h & { def: NonNullable<typeof h.def> } => !!h.def);
  const names = henchmanDisplayNames(hires.map(h => h.def.name), players.map(p => p.username));
  hires.forEach(({ hired, def }, i) => players.push(buildHenchmanCombatant(def, hired, id => content.skills[id], names[i])));
  return players;
}

function buildParty(body: Record<string, unknown>, pm: PlayerManager, content: SimRunContent): PartyCombatant[] {
  const spec = (body.party ?? {}) as { copyFrom?: unknown; members?: unknown; henchmanIds?: unknown };
  if (typeof spec.copyFrom === 'string' && spec.copyFrom) return copyParty(spec.copyFrom, pm, content);
  if (!Array.isArray(spec.members) || spec.members.length === 0) throw new SimRequestError('Party needs at least one member.');
  const taken = new Set<number>();
  const players = (spec.members as MemberBody[]).map((m, i) => buildMember(m ?? {}, i, taken, content));
  const henchmanIds = Array.isArray(spec.henchmanIds) ? spec.henchmanIds.filter((h): h is string => typeof h === 'string') : [];
  const defs = henchmanIds.map(id => {
    const def = content.henchmen[id];
    if (!def) throw new SimRequestError(`Unknown henchman "${id}".`);
    return def;
  });
  const names = henchmanDisplayNames(defs.map(d => d.name), players.map(p => p.username));
  defs.forEach((def, i) => {
    const hired = { instanceId: `sim-${i}`, henchmanId: def.id, gridPosition: takeGrid(taken, undefined), mapId: '' };
    players.push(buildHenchmanCombatant(def, hired, id => content.skills[id], names[i]));
  });
  return players;
}

function parseOpponent(raw: unknown, content: SimContent): SimOpponent {
  const { type, id } = (raw ?? {}) as Partial<SimOpponent>;
  if (!type || !OPPONENT_TYPES.includes(type) || typeof id !== 'string') throw new SimRequestError('Pick an opponent.');
  const table = { encounter: content.encounters, zone: content.zones, dungeon: content.dungeons, worldBoss: content.worldBosses }[type];
  if (!table[id]) throw new SimRequestError(`Unknown ${type} "${id}".`);
  return { type, id };
}

/** `/api/admin/simulator/*` — admin-gated by the router; runs headless and touches no live state. */
export function registerSimulatorRoutes(router: Router, { playerManager, contentStore, versionStore }: SimulatorRouteOptions): void {
  router.get('/simulator/parties', (_req, res) => {
    const pm = playerManager();
    const seen = new Set<string>();
    const parties: { username: string; members: { username: string; className: ClassName; level: number }[] }[] = [];
    for (const session of pm.getAllSessions()) {
      const partyId = session.getPartyId();
      const party = partyId ? pm.parties.getParty(partyId) : undefined;
      if (!partyId || !party || seen.has(partyId)) continue;
      seen.add(partyId);
      const members = party.members.flatMap(m => {
        const s = pm.getSessionByUsername(m.username);
        const className = s?.getClassName();
        return s && className ? [{ username: m.username, className, level: s.getLevel() }] : [];
      });
      if (members.length > 0) parties.push({ username: members[0].username, members });
    }
    res.json({ parties, maxPartySize: MAX_PARTY_SIZE, maxBattles: SIM_MAX_BATTLES });
  });

  router.post('/simulator/run', async (req, res) => {
    if (job?.state === 'running') { res.status(429).json({ error: 'A simulation is already running.' }); return; }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const store = contentStore();
      const content = typeof body.versionId === 'string' && body.versionId
        ? await loadDraftContent(body.versionId, store, versionStore())
        : simContent(store);
      const players = buildParty(body, playerManager(), content);
      if (players.length === 0) throw new SimRequestError('Party is empty.');
      if (players.length > MAX_PARTY_SIZE) throw new SimRequestError(`Party is limited to ${MAX_PARTY_SIZE}.`);
      const opponent = parseOpponent(body.opponent, content);
      const battles = Math.floor(Number(body.battles));
      if (!Number.isFinite(battles) || battles < 1) throw new SimRequestError('battles must be at least 1.');
      const seed = Number.isFinite(Number(body.seed)) && body.seed !== undefined && body.seed !== '' ? Number(body.seed) : Date.now() % 2 ** 31;
      const sim = new BattleSimulation({ players, opponent, content, battles, seed });
      const current: SimJob = { sim, state: 'running', cancelled: false };
      job = current;
      void drive(current);
      res.json({ total: sim.total });
    } catch (err) {
      if (err instanceof SimRequestError) res.status(400).json({ error: err.message });
      else {
        console.error('[Simulator]', err);
        res.status(500).json({ error: 'Simulation failed.' });
      }
    }
  });

  router.get('/simulator/status', (_req, res) => {
    if (!job) { res.json({ state: 'idle' }); return; }
    res.json({ state: job.state, completed: job.sim.completed, total: job.sim.total, report: job.report, error: job.error });
  });

  router.post('/simulator/cancel', (_req, res) => {
    if (job?.state === 'running') job.cancelled = true;
    res.json({ success: true });
  });
}

async function loadDraftContent(versionId: string, store: ContentStore, versions: VersionStore): Promise<SimRunContent> {
  const version = versions.get(versionId);
  if (!version) throw new SimRequestError('Draft not found.');
  return draftSimContent(await versions.loadSnapshot(versionId), store);
}

async function drive(job: SimJob): Promise<void> {
  try {
    while (!job.sim.done) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (job.cancelled) break;
      job.sim.step(SLICE_MS);
    }
    if (job.cancelled) job.state = 'cancelled';
    else { job.report = job.sim.report(); job.state = 'done'; }
  } catch (err) {
    console.error('[Simulator]', err);
    job.error = 'Simulation failed.';
    job.state = 'error';
  }
}
