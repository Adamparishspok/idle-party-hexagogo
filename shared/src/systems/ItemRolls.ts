import type { ItemDefinition } from './ItemTypes.js';
import type { AttributeName } from './AttributeTypes.js';

// See docs/architecture/gear-stats-bank.md → Random stat rolls.

export type RollStatKey =
  | 'bonusAttackMin' | 'bonusAttackMax'
  | 'damageReductionMin' | 'damageReductionMax'
  | 'magicReductionMin' | 'magicReductionMax'
  | AttributeName;

export interface RollRange {
  min: number;
  max: number;
}

export interface ItemRollTable {
  /** Bumped by the content store whenever the ranges change; existing items keep resolving against their own version. */
  version: number;
  stats: Partial<Record<RollStatKey, RollRange>>;
}

export interface ParsedRolledId {
  templateId: string;
  version: number;
  seed: number;
}

export const ROLL_ID_SEPARATOR = '~';

export const ROLL_STAT_KEYS: RollStatKey[] = [
  'bonusAttackMin', 'bonusAttackMax',
  'damageReductionMin', 'damageReductionMax',
  'magicReductionMin', 'magicReductionMax',
  'strength', 'agility', 'intellect', 'stamina',
];

const ATTRIBUTE_ROLL_KEYS = new Set<RollStatKey>(['strength', 'agility', 'intellect', 'stamina']);
const MIN_MAX_PAIRS: [RollStatKey, RollStatKey][] = [
  ['bonusAttackMin', 'bonusAttackMax'],
  ['damageReductionMin', 'damageReductionMax'],
  ['magicReductionMin', 'magicReductionMax'],
];
const SEED_PATTERN = /^[0-9a-z]{1,7}$/;
const MAX_SEED = 0xffffffff;

export function hasRollTable(def: ItemDefinition | undefined): boolean {
  return !!def?.rolls && Object.keys(def.rolls.stats ?? {}).length > 0;
}

export function parseRolledItemId(id: string): ParsedRolledId | null {
  const parts = id.split(ROLL_ID_SEPARATOR);
  if (parts.length !== 3) return null;
  const [templateId, versionStr, seedStr] = parts;
  if (!templateId || !/^[1-9]\d{0,5}$/.test(versionStr) || !SEED_PATTERN.test(seedStr)) return null;
  const seed = parseInt(seedStr, 36);
  if (seed > MAX_SEED) return null;
  return { templateId, version: Number(versionStr), seed };
}

export function isRolledItemId(id: string): boolean {
  return parseRolledItemId(id) !== null;
}

/** The authored template behind an item id; plain ids map to themselves. */
export function templateIdOf(id: string): string {
  return parseRolledItemId(id)?.templateId ?? id;
}

export function makeRolledItemId(templateId: string, version: number, seed: number): string {
  return [templateId, version, (seed >>> 0).toString(36)].join(ROLL_ID_SEPARATOR);
}

/** A freshly rolled id for `template`, or the template id itself when it has no roll table. */
export function rollNewItemId(template: ItemDefinition, random: () => number = Math.random): string {
  if (!hasRollTable(template)) return template.id;
  const seed = Math.floor(random() * (MAX_SEED + 1)) >>> 0;
  return makeRolledItemId(template.id, template.rolls!.version, seed);
}

export function findRollTable(template: ItemDefinition, version: number): ItemRollTable | undefined {
  if (template.rolls?.version === version) return template.rolls;
  return template.rollHistory?.find(t => t.version === version);
}

/** Deterministic stats for (template, table, seed). `quality` is 0–100: how high the rolls landed in their ranges. */
export function rollItemStats(
  templateId: string,
  table: ItemRollTable,
  seed: number,
): { stats: Partial<Record<RollStatKey, number>>; quality: number } {
  const random = mulberry32(hashString(`${templateId}|${table.version}|${seed >>> 0}`));
  const stats: Partial<Record<RollStatKey, number>> = {};
  let fractionSum = 0;
  let rolled = 0;
  for (const key of ROLL_STAT_KEYS) {
    const range = table.stats[key];
    const r = random();
    if (!range) continue;
    const lo = Math.round(Math.min(range.min, range.max));
    const hi = Math.round(Math.max(range.min, range.max));
    const value = Math.min(hi, lo + Math.floor(r * (hi - lo + 1)));
    stats[key] = value;
    fractionSum += hi === lo ? 1 : (value - lo) / (hi - lo);
    rolled++;
  }
  for (const [minKey, maxKey] of MIN_MAX_PAIRS) {
    const lo = stats[minKey];
    const hi = stats[maxKey];
    if (lo !== undefined && hi !== undefined && hi < lo) stats[maxKey] = lo;
  }
  return { stats, quality: rolled === 0 ? 100 : Math.round((fractionSum / rolled) * 100) };
}

export function rollQualityLabel(quality: number): string | undefined {
  if (quality >= 95) return 'Perfect';
  if (quality >= 80) return 'Superior';
  if (quality < 20) return 'Flawed';
  return undefined;
}

const resolvedCache = new WeakMap<ItemDefinition, Map<string, ItemDefinition | null>>();

/**
 * Turns any item id into its full definition: a template id returns the template, a rolled id
 * returns the template with its rolled stats applied. Malformed or unresolvable ids return undefined.
 */
export function resolveItem(id: string, items: Record<string, ItemDefinition>): ItemDefinition | undefined {
  if (Object.prototype.hasOwnProperty.call(items, id)) return items[id];
  const parsed = parseRolledItemId(id);
  if (!parsed || !Object.prototype.hasOwnProperty.call(items, parsed.templateId)) return undefined;
  const template = items[parsed.templateId];
  let cache = resolvedCache.get(template);
  if (!cache) {
    cache = new Map();
    resolvedCache.set(template, cache);
  }
  if (!cache.has(id)) cache.set(id, buildRolledDefinition(id, template, parsed) ?? null);
  return cache.get(id) ?? undefined;
}

/**
 * Wraps an item record so `items[rolledId]` and `rolledId in items` resolve rolled ids.
 * Iteration (keys/values/JSON) still sees only the authored templates.
 */
export function withRolledItems(items: Record<string, ItemDefinition>): Record<string, ItemDefinition> {
  return new Proxy(items, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop.includes(ROLL_ID_SEPARATOR) && !Reflect.has(target, prop)) {
        return resolveItem(prop, target);
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (Reflect.has(target, prop)) return true;
      return typeof prop === 'string' && prop.includes(ROLL_ID_SEPARATOR) && resolveItem(prop, target) !== undefined;
    },
  });
}

/**
 * Keeps every roll table an existing item could have been rolled against. Call on each save:
 * a changed table gets a fresh version and the previous one moves into `rollHistory`.
 */
export function carryRollHistory(prev: ItemDefinition | undefined, next: ItemDefinition): ItemDefinition {
  const history = new Map<number, ItemRollTable>();
  for (const t of [...(prev?.rollHistory ?? []), ...(next.rollHistory ?? [])]) {
    if (!history.has(t.version)) history.set(t.version, t);
  }
  if (prev?.rolls && !history.has(prev.rolls.version)) history.set(prev.rolls.version, prev.rolls);

  let rolls = hasRollTable(next) ? { version: next.rolls!.version, stats: { ...next.rolls!.stats } } : undefined;
  if (rolls) {
    const sameAsPrev = prev?.rolls && sameRanges(prev.rolls.stats, rolls.stats);
    const taken = history.get(rolls.version);
    if (sameAsPrev) {
      rolls.version = prev!.rolls!.version;
    } else if (!Number.isInteger(rolls.version) || rolls.version < 1 || (taken && !sameRanges(taken.stats, rolls.stats))) {
      rolls.version = Math.max(0, ...history.keys()) + 1;
    }
    history.delete(rolls.version);
  }

  const out: ItemDefinition = { ...next };
  delete out.rolls;
  delete out.rollHistory;
  if (rolls) out.rolls = rolls;
  if (history.size > 0) out.rollHistory = [...history.values()].sort((a, b) => a.version - b.version);
  return out;
}

/** Shape check for an authored roll table. Returns an error message, or null. */
export function validateRollTable(table: ItemRollTable | undefined): string | null {
  if (table === undefined) return null;
  if (typeof table !== 'object' || table === null || typeof table.stats !== 'object' || table.stats === null) {
    return 'rolls must be { version, stats }.';
  }
  for (const [key, range] of Object.entries(table.stats)) {
    if (!ROLL_STAT_KEYS.includes(key as RollStatKey)) return `rolls: unknown stat "${key}".`;
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return `rolls.${key} needs numeric min and max.`;
    if (!Number.isInteger(range.min) || !Number.isInteger(range.max)) return `rolls.${key} min and max must be whole numbers.`;
    if (range.min > range.max) return `rolls.${key}: min is greater than max.`;
  }
  return null;
}

function buildRolledDefinition(id: string, template: ItemDefinition, parsed: ParsedRolledId): ItemDefinition | undefined {
  const table = findRollTable(template, parsed.version);
  if (!table) return undefined;
  const { stats, quality } = rollItemStats(template.id, table, parsed.seed);
  const def: ItemDefinition = { ...template, id, templateId: template.id, rollQuality: quality };
  delete def.rolls;
  delete def.rollHistory;
  const attributes = { ...(template.attributes ?? {}) };
  let hasAttributeRoll = false;
  for (const [key, value] of Object.entries(stats) as [RollStatKey, number][]) {
    if (ATTRIBUTE_ROLL_KEYS.has(key)) {
      attributes[key as AttributeName] = value;
      hasAttributeRoll = true;
    } else {
      def[key as Exclude<RollStatKey, AttributeName>] = value;
    }
  }
  if (hasAttributeRoll) def.attributes = attributes;
  const label = rollQualityLabel(quality);
  if (label) def.name = `${label} ${template.name}`;
  return def;
}

function sameRanges(a: ItemRollTable['stats'], b: ItemRollTable['stats']): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<RollStatKey>;
  for (const key of keys) {
    if (a[key]?.min !== b[key]?.min || a[key]?.max !== b[key]?.max) return false;
  }
  return true;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
