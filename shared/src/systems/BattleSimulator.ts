import type { ClassName } from './CharacterStats.js';
import { createPartyCombatState, processPartyTick } from './CombatEngine.js';
import type { PartyCombatant, PartyCombatState } from './CombatEngine.js';
import { computeDerivedStats, derivedToEquipmentBonuses } from './AttributeTypes.js';
import { COMBAT_TICK_MS, RESULT_PAUSE, MOVE_DURATION } from './BattleTypes.js';
import { createEncounter, resolveEncounter } from './EncounterTypes.js';
import type { EncounterDefinition } from './EncounterTypes.js';
import { createMonsterInstance } from './MonsterTypes.js';
import type { MonsterDefinition, MonsterInstance } from './MonsterTypes.js';
import { rollDrops } from './ItemTypes.js';
import type { ItemDefinition } from './ItemTypes.js';
import { computeActiveSetBonuses } from './SetTypes.js';
import type { SetDefinition } from './SetTypes.js';
import type { SkillContent } from './SkillTypes.js';
import { canEquipSkill, getSlotSchedule, getSkillsForClass, getUnlockedSkillsForLevel } from './SkillTypes.js';
import type { SkillDefinition } from './SkillTypes.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type { ZoneDefinition } from './ZoneTypes.js';
import { rewardAppliesToClass, rollDungeonRewards } from './DungeonTypes.js';
import type { DungeonDefinition, DungeonReward } from './DungeonTypes.js';
import type { WorldBossDefinition } from './WorldBossTypes.js';

/** Everything the simulator reads; the server passes live ContentStore tables. */
export interface SimContent extends SkillContent {
  monsters: Record<string, MonsterDefinition>;
  zones: Record<string, ZoneDefinition>;
  encounters: Record<string, EncounterDefinition>;
  dungeons: Record<string, DungeonDefinition>;
  worldBosses: Record<string, WorldBossDefinition>;
  items: Record<string, ItemDefinition>;
  sets: Record<string, SetDefinition>;
}

export interface SimOpponent { type: 'encounter' | 'zone' | 'dungeon' | 'worldBoss'; id: string }

export interface SimMemberSpec {
  username: string;
  className: ClassName;
  level: number;
  equipment: Record<string, string | null>;
  gridPosition: PartyGridPosition;
  /** Absent → auto-filled from the class tree for the level. */
  skillIds?: (string | null)[];
}

export const SIM_MAX_BATTLES = 1000;
export const SIM_MAX_TICKS = 600;
/** Time between one battle's last tick and the next battle's first (matches ServerBattleTimer). */
export const BATTLE_OVERHEAD_MS = COMBAT_TICK_MS + RESULT_PAUSE + MOVE_DURATION;
export const EFFECTS_BUCKET = '(effects)';

export interface SimInput {
  players: PartyCombatant[];
  opponent: SimOpponent;
  content: SimContent;
  battles: number;
  seed: number;
}

export interface SimStats { avg: number; median: number; p90: number; max: number }

export interface SimMemberReport {
  name: string;
  className: ClassName;
  level: number;
  isHenchman: boolean;
  maxHp: number;
  damageDealt: number;
  damageTaken: number;
  deathsPerBattle: number;
}

export interface SimReport {
  opponent: string;
  battles: number;
  seed: number;
  winRate: number;
  wins: number;
  losses: number;
  stalemates: number;
  ticks: SimStats;
  /** Average wall-clock seconds per battle including result pause and movement. */
  cycleSeconds: number;
  deathsPerBattle: number;
  members: SimMemberReport[];
  effectsDamageDealt: number;
  /** Per human player, from the same split the server uses (henchmen share and lose their cut). */
  xpPerBattle: number;
  goldPerBattle: number;
  xpPerHour: number;
  goldPerHour: number;
  worldBoss?: { maxHp: number; damage: SimStats; damagePct: SimStats };
  /** Items that reach human players (henchman shares excluded), whole party combined. */
  drops: SimDrop[];
  /** Dungeon only: one-time rewards a player gets on their first clear, not part of the hourly figures. */
  firstClear?: { gold: number; xp: number; items: { itemId: string; name: string; expected: number }[] };
}

export interface SimDrop { itemId: string; name: string; perBattle: number; perHour: number }

export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fills each unlocked slot with the class's first available skill of the slot's type. */
export function autoSkillLoadout(className: ClassName, level: number, content: SkillContent): (string | null)[] {
  const tree = getSkillsForClass(className, content)
    .filter(s => s.unlockLevel !== null && s.unlockLevel <= level)
    .sort((a, b) => (a.unlockLevel ?? 0) - (b.unlockLevel ?? 0) || a.sortOrder - b.sortOrder);
  const used = new Set<string>();
  return getSlotSchedule(className, content).map(slot => {
    if (level < slot.unlocksAtLevel) return null;
    const pick = tree.find(s => s.type === slot.type && !used.has(s.id));
    if (!pick) return null;
    used.add(pick.id);
    return pick.id;
  });
}

export interface SimSlotChoice { slotIndex: number; type: string; unlocked: boolean; options: SkillDefinition[] }

/** Per slot, the skills a character of this class and level may equip there. */
export function simSlotChoices(className: ClassName, level: number, content: SkillContent): SimSlotChoice[] {
  const unlocked = getUnlockedSkillsForLevel(className, level, content);
  return getSlotSchedule(className, content).map((slot, slotIndex) => ({
    slotIndex,
    type: slot.type,
    unlocked: level >= slot.unlocksAtLevel,
    options: getSkillsForClass(className, content).filter(s => canEquipSkill(s.id, slotIndex, className, level, unlocked, [], content)),
  }));
}

/** Drops anything the class/level cannot equip in that slot, and repeats of one skill. */
export function sanitizeSkillLoadout(raw: (string | null)[], className: ClassName, level: number, content: SkillContent): (string | null)[] {
  const unlocked = getUnlockedSkillsForLevel(className, level, content);
  const used = new Set<string>();
  return getSlotSchedule(className, content).map((_, slotIndex) => {
    const id = raw[slotIndex];
    if (!id || used.has(id) || !canEquipSkill(id, slotIndex, className, level, unlocked, [], content)) return null;
    used.add(id);
    return id;
  });
}

/** Same stat pipeline as PlayerSession.getCombatInfo, from a spec instead of a live session. */
export function buildSimCombatant(spec: SimMemberSpec, content: SimContent): PartyCombatant {
  const stats = computeDerivedStats({
    className: spec.className, level: spec.level, equipment: spec.equipment, items: content.items, sets: content.sets,
  });
  const setBonuses = computeActiveSetBonuses(spec.equipment, content.sets, spec.className).bonuses;
  const skillIds = spec.skillIds
    ? sanitizeSkillLoadout(spec.skillIds, spec.className, spec.level, content)
    : autoSkillLoadout(spec.className, spec.level, content);
  const equippedSkills = skillIds.map(id => (id ? content.skills[id] ?? null : null));
  return {
    username: spec.username,
    maxHp: stats.maxHp,
    currentHp: stats.maxHp,
    baseDamage: stats.damage,
    playerDamageType: stats.damageType,
    equipBonuses: derivedToEquipmentBonuses(stats),
    setBonuses,
    critChance: stats.critChance,
    dodgeChance: stats.dodgeChance,
    healingMultiplier: stats.healingMultiplier,
    gridPosition: spec.gridPosition,
    className: spec.className,
    level: spec.level,
    equippedSkills,
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
  };
}

interface FightOutcome {
  result: 'victory' | 'defeat' | 'stalemate';
  ticks: number;
  deaths: number;
  dealt: Map<string, number>;
  taken: Map<string, number>;
  xp: number;
  gold: number;
  bossDamage: number;
  drops: Map<string, number>;
}

interface Iteration {
  win: boolean;
  stalemate: boolean;
  ticks: number;
  fights: number;
  deaths: number;
  deathsBy: Map<string, number>;
  dealt: Map<string, number>;
  taken: Map<string, number>;
  xp: number;
  gold: number;
  bossDamage: number;
  drops: Map<string, number>;
}

function bump(map: Map<string, number>, key: string, amount: number): void {
  if (amount > 0) map.set(key, (map.get(key) ?? 0) + amount);
}

function stats(values: number[]): SimStats {
  if (values.length === 0) return { avg: 0, median: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { avg: sorted.reduce((s, v) => s + v, 0) / sorted.length, median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}

function xpMultiplier(players: PartyCombatant[]): number {
  let multiplier = 1;
  for (const p of players) {
    for (const skill of p.equippedSkills) {
      for (const effect of skill?.passiveEffects ?? []) {
        if (effect.kind === 'xp_bonus') multiplier += effect.flatValue ?? 0;
      }
    }
  }
  return multiplier;
}

/**
 * A batch of headless battles on the real CombatEngine. Each battle gets its own seeded RNG, so a
 * run is reproducible and independent of how it is chunked. Touches no live state; inputs are copied.
 * See docs/architecture/admin-dashboard.md → Simulator.
 */
export class BattleSimulation {
  private input: SimInput;
  private iterations: Iteration[] = [];
  private mult: number;

  constructor(input: SimInput) {
    this.input = { ...input, battles: Math.max(1, Math.min(SIM_MAX_BATTLES, Math.floor(input.battles))) };
    this.mult = xpMultiplier(input.players);
  }

  get completed(): number {
    return this.iterations.length;
  }

  get total(): number {
    return this.input.battles;
  }

  get done(): boolean {
    return this.iterations.length >= this.input.battles;
  }

  /** Runs whole battles until the time budget is spent (always at least one). */
  step(budgetMs: number): void {
    const deadline = Date.now() + budgetMs;
    const realRandom = Math.random;
    try {
      do {
        const index = this.iterations.length;
        Math.random = createSeededRng(this.input.seed + Math.imul(index + 1, 0x9E3779B1));
        this.iterations.push(this.runIteration());
      } while (!this.done && Date.now() < deadline);
    } finally {
      Math.random = realRandom;
    }
  }

  report(): SimReport {
    const { players, opponent, content } = this.input;
    const its = this.iterations;
    const n = its.length;
    const total = (pick: (i: Iteration) => number) => its.reduce((s, i) => s + pick(i), 0);
    const wins = its.filter(i => i.win).length;
    const stalemates = its.filter(i => i.stalemate).length;
    const cycleMs = total(i => i.ticks * COMBAT_TICK_MS + i.fights * BATTLE_OVERHEAD_MS) / n;
    const shareCount = players.length;
    const perHour = (perBattle: number) => (cycleMs > 0 ? perBattle * 3_600_000 / cycleMs : 0);
    const avgOf = (key: 'dealt' | 'taken', name: string) => total(i => i[key].get(name) ?? 0) / n;
    const xpPerBattle = total(i => i.xp) / n / shareCount;
    const goldPerBattle = total(i => i.gold) / n / shareCount;

    const dropTotals = new Map<string, number>();
    for (const i of its) for (const [id, qty] of i.drops) bump(dropTotals, id, qty);
    const drops: SimDrop[] = [...dropTotals].map(([itemId, qty]) => ({
      itemId, name: content.items[itemId]?.name ?? itemId, perBattle: qty / n, perHour: perHour(qty / n),
    })).sort((a, b) => b.perHour - a.perHour);

    const report: SimReport = {
      opponent: opponentLabel(opponent, content),
      battles: n,
      seed: this.input.seed,
      winRate: wins / n,
      wins,
      losses: n - wins - stalemates,
      stalemates,
      ticks: stats(its.map(i => i.ticks)),
      cycleSeconds: cycleMs / 1000,
      deathsPerBattle: total(i => i.deaths) / n,
      members: players.map(p => ({
        name: p.username,
        className: p.className,
        level: p.level,
        isHenchman: !!p.isHenchman,
        maxHp: p.maxHp,
        damageDealt: avgOf('dealt', p.username),
        damageTaken: avgOf('taken', p.username),
        deathsPerBattle: total(i => i.deathsBy.get(p.username) ?? 0) / n,
      })),
      effectsDamageDealt: avgOf('dealt', EFFECTS_BUCKET),
      xpPerBattle,
      goldPerBattle,
      xpPerHour: perHour(xpPerBattle),
      goldPerHour: perHour(goldPerBattle),
      drops,
    };
    const dungeon = opponent.type === 'dungeon' ? content.dungeons[opponent.id] : undefined;
    if (dungeon) {
      const humans = players.filter(p => !p.isHenchman);
      const rewards = dungeon.firstClearRewards ?? [];
      report.firstClear = {
        gold: dungeon.firstClearGold ?? 0,
        xp: dungeon.firstClearXp ?? 0,
        items: [...new Set(rewards.map(r => r.itemId))].map(itemId => ({
          itemId,
          name: content.items[itemId]?.name ?? itemId,
          expected: humans.length === 0 ? 0 : humans.reduce((sum, p) => sum + expectedQty(rewards.filter(r => r.itemId === itemId && rewardAppliesToClass(r, p.className))), 0) / humans.length,
        })),
      };
    }
    if (opponent.type === 'worldBoss') {
      const maxHp = content.worldBosses[opponent.id]?.maxHp ?? 0;
      const damage = its.map(i => i.bossDamage);
      report.worldBoss = { maxHp, damage: stats(damage), damagePct: stats(damage.map(d => (maxHp > 0 ? d / maxHp : 0))) };
    }
    return report;
  }

  private runIteration(): Iteration {
    const { opponent, content } = this.input;
    const it: Iteration = {
      win: false, stalemate: false, ticks: 0, fights: 0, deaths: 0,
      deathsBy: new Map(), dealt: new Map(), taken: new Map(), xp: 0, gold: 0, bossDamage: 0, drops: new Map(),
    };
    const floors = opponent.type === 'dungeon' ? content.dungeons[opponent.id]?.floors.length ?? 0 : 1;
    for (let floor = 0; floor < Math.max(1, floors); floor++) {
      const fight = this.fight(this.monstersFor(floor));
      it.fights++;
      it.ticks += fight.ticks;
      it.deaths += fight.deaths;
      it.bossDamage += fight.bossDamage;
      for (const [k, v] of fight.dealt) bump(it.dealt, k, v);
      for (const [k, v] of fight.taken) bump(it.taken, k, v);
      for (const [k, v] of fight.deathNames) bump(it.deathsBy, k, v);
      if (fight.result !== 'victory') {
        it.stalemate = fight.result === 'stalemate';
        return it;
      }
      it.xp += fight.xp;
      it.gold += fight.gold;
      for (const [k, v] of fight.drops) bump(it.drops, k, v);
      if (opponent.type === 'dungeon') this.rollFloorRewards(content.dungeons[opponent.id]?.floors[floor]?.rewards, it.drops);
    }
    it.win = true;
    return it;
  }

  private rollFloorRewards(rewards: DungeonReward[] | undefined, into: Map<string, number>): void {
    for (const p of this.input.players) {
      if (p.isHenchman) continue;
      const eligible = (rewards ?? []).filter(r => rewardAppliesToClass(r, p.className));
      for (const { itemId, quantity } of rollDungeonRewards(eligible)) bump(into, itemId, quantity);
    }
  }

  private rollMonsterDrops(monsters: MonsterInstance[]): Map<string, number> {
    const { players, content } = this.input;
    const drops = new Map<string, number>();
    for (const m of monsters) {
      for (const itemId of rollDrops(content.monsters[m.id]?.drops ?? [])) {
        const restriction = content.items[itemId]?.classRestriction;
        const matching = restriction && restriction.length > 0 ? players.filter(p => restriction.includes(p.className)) : [];
        const eligible = matching.length > 0 ? matching : players;
        const recipient = eligible[Math.floor(Math.random() * eligible.length)];
        if (!recipient.isHenchman) bump(drops, itemId, 1);
      }
    }
    return drops;
  }

  private monstersFor(floor: number): MonsterInstance[] {
    const { opponent, content } = this.input;
    const { monsters, zones, encounters } = content;
    switch (opponent.type) {
      case 'encounter': {
        const def = encounters[opponent.id];
        return def ? resolveEncounter(def, monsters) : [];
      }
      case 'zone':
        return createEncounter(opponent.id, monsters, zones, encounters);
      case 'dungeon': {
        const table = content.dungeons[opponent.id]?.floors[floor]?.encounterTable;
        return createEncounter(undefined, monsters, zones, encounters, table);
      }
      case 'worldBoss': {
        const boss = content.worldBosses[opponent.id];
        const monster = boss ? monsters[boss.monsterId] : undefined;
        if (!boss || !monster) return [];
        const instance = createMonsterInstance(monster);
        instance.name = boss.name;
        instance.maxHp = boss.maxHp;
        instance.currentHp = boss.maxHp;
        return [instance];
      }
    }
  }

  private fight(monsters: MonsterInstance[]): FightOutcome & { deathNames: Map<string, number> } {
    const { players, content } = this.input;
    const state: PartyCombatState = createPartyCombatState(players, monsters);
    const dealt = new Map<string, number>();
    const taken = new Map<string, number>();
    const hp = () => state.monsters.reduce((s, m) => s + Math.max(0, m.currentHp), 0);
    const startingMonsterHp = hp();
    let ticks = 0;
    while (!state.finished && ticks < SIM_MAX_TICKS) {
      const before = new Map(state.players.map(p => [p.username, p.currentHp]));
      const monsterHpBefore = hp();
      processPartyTick(state);
      ticks++;
      const action = state.lastAction;
      const actor = action?.attackerSide === 'player'
        ? state.players.find(p => p.gridPosition === action.attackerPos)?.username
        : undefined;
      bump(dealt, actor ?? EFFECTS_BUCKET, monsterHpBefore - hp());
      for (const p of state.players) bump(taken, p.username, (before.get(p.username) ?? 0) - p.currentHp);
    }
    const deathNames = new Map<string, number>();
    for (const p of state.players) if (p.currentHp <= 0) deathNames.set(p.username, 1);
    const result = state.result ?? 'stalemate';
    let xp = 0;
    let gold = 0;
    let drops = new Map<string, number>();
    if (result === 'victory') {
      if (this.input.opponent.type !== 'worldBoss') drops = this.rollMonsterDrops(monsters);
      xp = Math.ceil(monsters.reduce((s, m) => s + m.xp, 0) * this.mult);
      for (const m of monsters) {
        const def = content.monsters[m.id];
        if (def) gold += def.goldMin + Math.floor(Math.random() * (def.goldMax - def.goldMin + 1));
      }
    }
    return {
      result, ticks, deaths: deathNames.size, dealt, taken, xp, gold, deathNames, drops,
      bossDamage: startingMonsterHp - hp(),
    };
  }
}

function expectedQty(rewards: DungeonReward[]): number {
  return rewards.reduce((sum, r) => sum + r.chance * ((r.minQty ?? 1) + Math.max(r.minQty ?? 1, r.maxQty ?? r.minQty ?? 1)) / 2, 0);
}

function opponentLabel(opponent: SimOpponent, content: SimContent): string {
  const names: Record<SimOpponent['type'], string | undefined> = {
    encounter: content.encounters[opponent.id]?.name,
    zone: content.zones[opponent.id]?.displayName,
    dungeon: content.dungeons[opponent.id]?.name,
    worldBoss: content.worldBosses[opponent.id]?.name,
  };
  return `${opponent.type}: ${names[opponent.type] ?? opponent.id}`;
}

export function runBattleSimulation(input: SimInput): SimReport {
  const sim = new BattleSimulation(input);
  while (!sim.done) sim.step(Infinity);
  return sim.report();
}
