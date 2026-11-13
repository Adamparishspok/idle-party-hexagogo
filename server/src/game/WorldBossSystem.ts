import { createMonsterInstance, worldBossShare } from '@idle-party-rpg/shared';
import type { ClientWorldBoss, MonsterDefinition, MonsterInstance, WorldBossCooldown, WorldBossDefinition, WorldBossState } from '@idle-party-rpg/shared';

export interface WorldBossDeps {
  getDefinitions(): Record<string, WorldBossDefinition>;
  getMonster(id: string): MonsterDefinition | undefined;
  /** Pay one contributor of a killed boss; `share` is 0..1 of the reward pools. */
  reward(username: string, def: WorldBossDefinition, share: number): void;
  /** A boss spawned, died or left. */
  onChanged(): void;
  rng?: () => number;
}

export interface LiveWorldBoss {
  def: WorldBossDefinition;
  state: WorldBossState;
}

/** Spawn schedule and shared HP for every world boss. See docs/architecture/combat.md → World bosses. */
export class WorldBossSystem {
  private states = new Map<string, WorldBossState>();
  private deps: WorldBossDeps;
  private rng: () => number;

  constructor(deps: WorldBossDeps) {
    this.deps = deps;
    this.rng = deps.rng ?? Math.random;
  }

  restore(states: readonly WorldBossState[]): void {
    this.states.clear();
    for (const s of states) this.states.set(s.bossId, { ...s, contributions: { ...s.contributions } });
  }

  getStates(): WorldBossState[] {
    return [...this.states.values()].map(s => ({ ...s, contributions: { ...s.contributions } }));
  }

  /** Spawn bosses that are due, send off those whose time is up, forget deleted ones. */
  tick(now: number = Date.now()): void {
    const defs = this.deps.getDefinitions();
    let changed = false;
    for (const id of this.states.keys()) {
      if (!defs[id]) {
        changed ||= this.states.get(id)!.alive;
        this.states.delete(id);
      }
    }
    for (const def of Object.values(defs)) {
      const state = this.states.get(def.id);
      if (!state || (!state.alive && (state.nextSpawnAt ?? 0) <= now)) {
        this.spawn(def, now);
        changed = true;
      } else if (state.alive && state.despawnAt !== undefined && state.despawnAt <= now) {
        this.retire(def, state, now);
        changed = true;
      }
    }
    if (changed) this.deps.onChanged();
  }

  liveAt(tileId: string): LiveWorldBoss | undefined {
    for (const state of this.states.values()) {
      if (!state.alive || state.tileId !== tileId) continue;
      const def = this.deps.getDefinitions()[state.bossId];
      if (def) return { def, state };
    }
    return undefined;
  }

  /** The boss as a combat monster starting at its shared HP; undefined when its monster is missing. */
  createInstance({ def, state }: LiveWorldBoss): MonsterInstance | undefined {
    const monster = this.deps.getMonster(def.monsterId);
    if (!monster) return undefined;
    const instance = createMonsterInstance(monster);
    instance.name = def.name;
    instance.maxHp = def.maxHp;
    instance.currentHp = Math.min(state.currentHp, def.maxHp);
    return instance;
  }

  /**
   * Apply damage from one party's fight to the shared HP and return what is left.
   * Returns 0 when that spawn is already gone (killed by another party or left).
   */
  dealDamage(bossId: string, spawnedAt: number, credits: Record<string, number>, now: number = Date.now()): number {
    const state = this.states.get(bossId);
    const def = this.deps.getDefinitions()[bossId];
    if (!state || !def || !state.alive || state.spawnedAt !== spawnedAt) return 0;
    for (const [username, credit] of Object.entries(credits)) {
      const amount = Math.min(credit, state.currentHp);
      if (amount <= 0) continue;
      state.contributions[username] = (state.contributions[username] ?? 0) + amount;
      state.currentHp -= amount;
    }
    if (state.currentHp > 0) return state.currentHp;
    for (const [username, damage] of Object.entries(state.contributions)) {
      const share = worldBossShare(def, damage);
      if (share > 0) this.deps.reward(username, def, share);
    }
    this.retire(def, state, now);
    this.deps.onChanged();
    return 0;
  }

  clientList(cooldownOf: (bossId: string, spawnedAt: number) => WorldBossCooldown | undefined, now: number = Date.now()): ClientWorldBoss[] {
    if (this.states.size === 0) return [];
    const defs = this.deps.getDefinitions();
    const list: ClientWorldBoss[] = [];
    for (const state of this.states.values()) {
      const def = defs[state.bossId];
      if (!def || !state.alive) continue;
      const cooldown = cooldownOf(state.bossId, state.spawnedAt);
      list.push({
        bossId: def.id,
        name: def.name,
        tileId: state.tileId,
        currentHp: state.currentHp,
        maxHp: def.maxHp,
        ...(cooldown && cooldown.until > now ? { cooldownUntil: cooldown.until } : {}),
      });
    }
    return list;
  }

  private spawn(def: WorldBossDefinition, now: number): void {
    const tileId = def.tileIds[Math.floor(this.rng() * def.tileIds.length)];
    this.states.set(def.id, {
      bossId: def.id,
      alive: true,
      tileId,
      currentHp: def.maxHp,
      spawnedAt: now,
      ...(def.despawnAfterSec !== undefined ? { despawnAt: now + def.despawnAfterSec * 1000 } : {}),
      contributions: {},
    });
  }

  private retire(def: WorldBossDefinition, state: WorldBossState, now: number): void {
    const delaySec = def.respawnMinSec + this.rng() * (def.respawnMaxSec - def.respawnMinSec);
    state.alive = false;
    state.currentHp = 0;
    state.contributions = {};
    state.despawnAt = undefined;
    state.nextSpawnAt = now + Math.round(delaySec * 1000);
  }
}
