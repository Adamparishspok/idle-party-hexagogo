import type { ClassName, DamageType } from './CharacterStats.js';
import { CLASS_DEFINITIONS, calculateBaseDamage, calculateMaxHp } from './CharacterStats.js';
import type { EquipmentBonuses, ItemDefinition, ItemRarity } from './ItemTypes.js';
import { computeEquipmentBonuses } from './ItemTypes.js';
import type { SetBonuses, SetDefinition } from './SetTypes.js';
import { computeActiveSetBonuses, getActiveBreakpoint, setAppliesToClass } from './SetTypes.js';

// See docs/architecture/gear-stats-bank.md for the formulas and worked numbers.

// --- Types ---

export type AttributeName = 'strength' | 'agility' | 'intellect' | 'stamina';

/** The attributes that can be a class's primary (Stamina is everyone's HP stat). */
export type PrimaryAttribute = Exclude<AttributeName, 'stamina'>;

export type AttributeBlock = Record<AttributeName, number>;

export type PartialAttributes = Partial<AttributeBlock>;

export interface DerivedStats {
  className: ClassName;
  level: number;
  damageType: DamageType;
  primaryAttribute: PrimaryAttribute;
  /** What the class has naked at this level. */
  baseAttributes: AttributeBlock;
  /** Equipped items (heirlooms level-scaled) plus active set tiers. */
  gearAttributes: AttributeBlock;
  /** `baseAttributes + gearAttributes`. */
  attributes: AttributeBlock;
  maxHp: number;
  /** Damage before variance, gear attack range, and combat multipliers. */
  damage: number;
  attackBonusMin: number;
  attackBonusMax: number;
  /** Flat physical reduction per hit (legacy DR + Strength). */
  armorMin: number;
  armorMax: number;
  /** Flat magical reduction per hit (legacy MR + Intellect). */
  resistMin: number;
  resistMax: number;
  /** 0..1, from Agility only — skill crit (Pierce) adds on top in combat. */
  critChance: number;
  /** 0..1, personal; Bard Nimble adds on top in combat. */
  dodgeChance: number;
  damagePercent: number;
  damageResistancePercent: number;
  cooldownReduction: number;
}

export interface ClassAttributeProfile {
  primary: PrimaryAttribute;
  hpPerStamina: number;
  damagePerPrimary: number;
}

export interface DerivedStatsInput {
  className: ClassName;
  level: number;
  equipment: Record<string, string | null>;
  items: Record<string, ItemDefinition>;
  sets?: Record<string, SetDefinition>;
}

// --- Constants ---

export const ATTRIBUTE_NAMES: AttributeName[] = ['strength', 'agility', 'intellect', 'stamina'];

export const ATTRIBUTE_LABELS: Record<AttributeName, string> = {
  strength: 'Strength',
  agility: 'Agility',
  intellect: 'Intellect',
  stamina: 'Stamina',
};

export const ATTRIBUTE_ABBREVIATIONS: Record<AttributeName, string> = {
  strength: 'STR',
  agility: 'AGI',
  intellect: 'INT',
  stamina: 'STA',
};

export const CLASS_ATTRIBUTE_PROFILES: Record<ClassName, ClassAttributeProfile> = {
  Knight: { primary: 'strength', hpPerStamina: 2, damagePerPrimary: 0.5 },
  Archer: { primary: 'agility', hpPerStamina: 1, damagePerPrimary: 1 },
  Priest: { primary: 'intellect', hpPerStamina: 1.5, damagePerPrimary: 0.5 },
  Mage: { primary: 'intellect', hpPerStamina: 1, damagePerPrimary: 1 },
  Bard: { primary: 'agility', hpPerStamina: 1, damagePerPrimary: 0.5 },
};

export const STRENGTH_PER_ARMOR = 15;
export const INTELLECT_PER_RESIST = 15;
export const CRIT_PER_AGILITY = 0.001;
export const DODGE_PER_AGILITY = 0.0005;
export const MAX_ATTRIBUTE_CRIT = 0.25;
export const MAX_ATTRIBUTE_DODGE = 0.15;

/** Heirlooms are authored per level, so their factor is unused — see `suggestedAttributeBudget`. */
export const RARITY_ATTRIBUTE_BUDGET: Record<ItemRarity, number> = {
  janky: 0.5, common: 0.75, uncommon: 1, rare: 1.25, epic: 1.5, legendary: 2, heirloom: 0,
};

// --- Pure functions ---

export function emptyAttributes(): AttributeBlock {
  return { strength: 0, agility: 0, intellect: 0, stamina: 0 };
}

export function addAttributes(target: AttributeBlock, add: PartialAttributes | undefined, scale: number = 1): AttributeBlock {
  if (!add) return target;
  for (const name of ATTRIBUTE_NAMES) target[name] += Math.floor((add[name] ?? 0) * scale);
  return target;
}

export function hasAttributes(attrs: PartialAttributes | undefined): boolean {
  if (!attrs) return false;
  return ATTRIBUTE_NAMES.some(name => (attrs[name] ?? 0) !== 0);
}

/** Naked attributes, for display and secondary stats only — HP and damage read the class curves directly. */
export function classBaseAttributes(level: number, className: ClassName): AttributeBlock {
  const profile = CLASS_ATTRIBUTE_PROFILES[className];
  const attrs = emptyAttributes();
  attrs.stamina = Math.floor(calculateMaxHp(level, className) / profile.hpPerStamina);
  attrs[profile.primary] = Math.floor(calculateBaseDamage(level, className) / profile.damagePerPrimary);
  return attrs;
}

/** An item's attributes as worn at `level` (heirlooms multiply by level, like their legacy stats). */
export function itemAttributes(def: ItemDefinition, level: number = 1): AttributeBlock {
  const scale = def.rarity === 'heirloom' ? level : 1;
  return addAttributes(emptyAttributes(), def.attributes, scale);
}

/** Sum of attributes across equipped items; a 2H weapon (same id in mainhand+offhand) counts once. */
export function equipmentAttributes(
  equipment: Record<string, string | null>,
  items: Record<string, ItemDefinition>,
  level: number = 1,
): AttributeBlock {
  const total = emptyAttributes();
  const skip2H = equipment.mainhand && equipment.mainhand === equipment.offhand;
  for (const [slot, itemId] of Object.entries(equipment)) {
    if (!itemId) continue;
    if (skip2H && slot === 'offhand') continue;
    const def = items[itemId];
    if (!def) continue;
    addAttributes(total, def.attributes, def.rarity === 'heirloom' ? level : 1);
  }
  return total;
}

/** Attributes from the highest unlocked tier of every active set that applies to the class. */
export function computeSetAttributes(
  equipment: Record<string, string | null>,
  sets: Record<string, SetDefinition>,
  className?: string | null,
): AttributeBlock {
  const total = emptyAttributes();
  const equipped = new Set<string>();
  for (const id of Object.values(equipment)) if (id) equipped.add(id);
  for (const set of Object.values(sets)) {
    if (!setAppliesToClass(set, className)) continue;
    const count = set.itemIds.filter(id => equipped.has(id)).length;
    if (count === 0) continue;
    addAttributes(total, getActiveBreakpoint(set, count)?.bonuses.attributes);
  }
  return total;
}

export function computeDerivedStats(input: DerivedStatsInput): DerivedStats {
  const { className, level, equipment, items } = input;
  const sets = input.sets ?? {};
  const profile = CLASS_ATTRIBUTE_PROFILES[className];
  const primaryAttribute = profile.primary;

  const baseAttributes = classBaseAttributes(level, className);
  const gearAttributes = equipmentAttributes(equipment, items, level);
  addAttributes(gearAttributes, computeSetAttributes(equipment, sets, className));
  const attributes = addAttributes({ ...baseAttributes }, gearAttributes);

  const legacy = computeEquipmentBonuses(equipment, items, level);
  const setBonuses: SetBonuses = computeActiveSetBonuses(equipment, sets, className).bonuses;

  const flatHp = setBonuses.flatHp ?? 0;
  const percentHp = setBonuses.percentHp ?? 0;
  const hpBeforeSets = calculateMaxHp(level, className) + gearAttributes.stamina * profile.hpPerStamina;
  const maxHp = Math.max(1, Math.floor((hpBeforeSets + flatHp) * (1 + percentHp / 100)));
  const damage = Math.max(0, Math.floor(calculateBaseDamage(level, className) + gearAttributes[primaryAttribute] * profile.damagePerPrimary));

  const armor = Math.floor(Math.max(0, attributes.strength) / STRENGTH_PER_ARMOR);
  const resist = Math.floor(Math.max(0, attributes.intellect) / INTELLECT_PER_RESIST);
  const agility = Math.max(0, attributes.agility);

  return {
    className,
    level,
    damageType: CLASS_DEFINITIONS[className].damageType,
    primaryAttribute,
    baseAttributes,
    gearAttributes,
    attributes,
    maxHp,
    damage,
    attackBonusMin: legacy.bonusAttackMin + (setBonuses.bonusAttackMin ?? 0),
    attackBonusMax: legacy.bonusAttackMax + (setBonuses.bonusAttackMax ?? 0),
    armorMin: legacy.damageReductionMin + (setBonuses.damageReductionMin ?? 0) + armor,
    armorMax: legacy.damageReductionMax + (setBonuses.damageReductionMax ?? 0) + armor,
    resistMin: legacy.magicReductionMin + (setBonuses.magicReductionMin ?? 0) + resist,
    resistMax: legacy.magicReductionMax + (setBonuses.magicReductionMax ?? 0) + resist,
    critChance: Math.min(MAX_ATTRIBUTE_CRIT, agility * CRIT_PER_AGILITY),
    dodgeChance: Math.min(MAX_ATTRIBUTE_DODGE, agility * DODGE_PER_AGILITY),
    damagePercent: setBonuses.damagePercent ?? 0,
    damageResistancePercent: setBonuses.damageResistancePercent ?? 0,
    cooldownReduction: setBonuses.cooldownReduction ?? 0,
  };
}

/** The flat ranges the combat engine reads from `PartyCombatant.equipBonuses`. */
export function derivedToEquipmentBonuses(stats: DerivedStats): EquipmentBonuses {
  return {
    bonusAttackMin: stats.attackBonusMin,
    bonusAttackMax: stats.attackBonusMax,
    damageReductionMin: stats.armorMin,
    damageReductionMax: stats.armorMax,
    magicReductionMin: stats.resistMin,
    magicReductionMax: stats.resistMax,
  };
}

/** Authoring guideline: total attribute points for an item meant for `itemLevel`. Heirlooms are per level. */
export function suggestedAttributeBudget(itemLevel: number, rarity: ItemRarity, twoHanded: boolean = false): number {
  const points = rarity === 'heirloom' ? 1 : Math.max(1, Math.round((Math.max(1, itemLevel) * RARITY_ATTRIBUTE_BUDGET[rarity]) / 4));
  return twoHanded ? points * 2 : points;
}

/** Shape check for authored attribute blocks. Returns an error message, or null when valid. */
export function validateAttributes(attrs: unknown): string | null {
  if (attrs === undefined) return null;
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return 'attributes must be an object.';
  for (const [key, value] of Object.entries(attrs)) {
    if (!ATTRIBUTE_NAMES.includes(key as AttributeName)) return `Unknown attribute "${key}".`;
    if (!Number.isInteger(value)) return `Attribute ${key} must be a whole number.`;
  }
  return null;
}
