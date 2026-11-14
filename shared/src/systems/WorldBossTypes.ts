import type { DungeonReward } from './DungeonTypes.js';

/** A rare boss whose HP persists across fights. See docs/architecture/combat.md → World bosses. */
export interface WorldBossDefinition {
  id: string;
  name: string;
  /** Monster whose damage, skills and resistances the boss fights with. */
  monsterId: string;
  /** Replaces the monster's hp. */
  maxHp: number;
  /** Room GUIDs it may spawn in; each spawn picks one at random. */
  tileIds: string[];
  respawnMinSec: number;
  respawnMaxSec: number;
  /** Leaves unbeaten (no rewards) this long after spawning. Absent → stays until killed. */
  despawnAfterSec?: number;
  /** Cooldown after a party's first failed attempt. */
  retryCooldownSec: number;
  /** Added per further failed attempt against the same spawn. */
  retryCooldownStepSec: number;
  retryCooldownMaxSec: number;
  /** Pools paid out by damage share (damage / maxHp). */
  rewardXp: number;
  rewardGold: number;
  /** Rolled once per rewarded contributor. */
  rewardItems?: DungeonReward[];
  /** 0..1 share of maxHp a player must deal to be rewarded. */
  minContributionPct: number;
}

/** Shared HP and schedule for one boss, persisted by `WorldBossStore`. */
export interface WorldBossState {
  bossId: string;
  alive: boolean;
  tileId: string;
  currentHp: number;
  /** Identifies the spawn; cooldowns from an older spawn no longer apply. */
  spawnedAt: number;
  despawnAt?: number;
  nextSpawnAt?: number;
  /** Damage dealt this spawn, by username. */
  contributions: Record<string, number>;
}

/** A player's failed attempts against one spawn. */
export interface WorldBossCooldown {
  spawnedAt: number;
  attempts: number;
  until: number;
}

/** A live world boss as one player sees it. */
export interface ClientWorldBoss {
  bossId: string;
  name: string;
  tileId: string;
  currentHp: number;
  maxHp: number;
  /** Epoch ms this player may fight it again. */
  cooldownUntil?: number;
}

/** Cooldown after the `attempts`-th failed attempt (1-based). */
export function worldBossCooldownMs(def: WorldBossDefinition, attempts: number): number {
  const sec = def.retryCooldownSec + def.retryCooldownStepSec * Math.max(0, attempts - 1);
  return Math.min(sec, def.retryCooldownMaxSec) * 1000;
}

/** Fraction of the reward pools a contributor earns; 0 below the threshold. */
export function worldBossShare(def: WorldBossDefinition, damage: number): number {
  const share = Math.min(1, damage / def.maxHp);
  return share > 0 && share >= def.minContributionPct ? share : 0;
}

export function validateWorldBossDefinition(def: Partial<WorldBossDefinition>): string | null {
  const nonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (typeof def.id !== 'string' || !def.id) return 'World boss needs an id.';
  if (typeof def.name !== 'string' || !def.name.trim()) return 'World boss needs a name.';
  if (typeof def.monsterId !== 'string' || !def.monsterId) return 'World boss needs a monsterId.';
  if (!Number.isInteger(def.maxHp) || def.maxHp! < 1) return 'World boss maxHp must be a whole number, 1 or more.';
  if (!Array.isArray(def.tileIds) || def.tileIds.length === 0) return 'World boss needs at least one spawn room.';
  if (!nonNeg(def.respawnMinSec) || !nonNeg(def.respawnMaxSec) || def.respawnMaxSec! < def.respawnMinSec!) return 'World boss respawn delay needs 0 <= min <= max.';
  if (def.despawnAfterSec !== undefined && !(nonNeg(def.despawnAfterSec) && def.despawnAfterSec > 0)) return 'World boss despawnAfterSec must be more than 0 when set.';
  if (!nonNeg(def.retryCooldownSec) || !nonNeg(def.retryCooldownStepSec) || !nonNeg(def.retryCooldownMaxSec)) return 'World boss retry cooldowns must be 0 or more.';
  if (!nonNeg(def.rewardXp) || !nonNeg(def.rewardGold)) return 'World boss rewards must be 0 or more.';
  if (!nonNeg(def.minContributionPct) || def.minContributionPct! > 1) return 'World boss minContributionPct must be from 0 to 1.';
  return null;
}
