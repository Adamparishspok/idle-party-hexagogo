import type { ClassName } from './CharacterStats.js';
import type { EquipSlot, ItemDefinition, ItemRarity } from './ItemTypes.js';
import type { SkillDefinition } from './SkillTypes.js';
import type { AttributeName, DerivedStats, DerivedStatsInput } from './AttributeTypes.js';
import { ATTRIBUTE_LABELS, ATTRIBUTE_NAMES, CLASS_ATTRIBUTE_PROFILES, computeDerivedStats, itemAttributes } from './AttributeTypes.js';
import { isBag } from './BagTypes.js';

// Pure helpers behind the gear picker, item tooltip and compare view. See docs/architecture/gear-stats-bank.md → Client UX.

// --- Types ---

export interface SlotCandidate {
  itemId: string;
  count: number;
  def: ItemDefinition;
}

export type ItemStatLineKind =
  | 'slot'
  | 'attribute'
  | 'attack'
  | 'armor'
  | 'resist'
  | 'bag'
  | 'grant'
  | 'classes'
  | 'heirloom'
  | 'consumable'
  | 'material';

export interface ItemStatLine {
  kind: ItemStatLineKind;
  text: string;
  attribute?: AttributeName;
  /** Attribute lines only: true when it is the viewer's class primary. */
  primary?: boolean;
  slot?: EquipSlot;
}

export type DerivedStatKey =
  | AttributeName
  | 'maxHp'
  | 'damage'
  | 'attackBonus'
  | 'armor'
  | 'resist'
  | 'critChance'
  | 'dodgeChance';

export interface StatDeltaLine {
  key: DerivedStatKey;
  label: string;
  before: string;
  after: string;
  /** Change in the stat (range stats compare their midpoints). Positive is always better. */
  delta: number;
}

// --- Constants ---

const RARITY_ORDER: Record<ItemRarity, number> = {
  janky: 0, common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, heirloom: 6,
};

const SLOT_TEXT: Record<EquipSlot, string> = {
  head: 'Head', shoulders: 'Shoulders', chest: 'Chest', bracers: 'Bracers', gloves: 'Gloves',
  mainhand: 'Main Hand', offhand: 'Off Hand', twohanded: 'Two-Handed', foot: 'Feet',
  ring: 'Ring', necklace: 'Necklace', back: 'Back', relic: 'Relic',
};

// --- Pure functions ---

export function canClassUse(def: ItemDefinition, className: string | null | undefined): boolean {
  if (!def.classRestriction || def.classRestriction.length === 0) return true;
  return !!className && def.classRestriction.includes(className);
}

/** Whether an item with `equipSlot` can go in the equipment-record key `slot` (2H weapons fit either hand). */
export function slotAccepts(slot: EquipSlot, itemSlot: EquipSlot | undefined): boolean {
  if (!itemSlot) return false;
  if (itemSlot === slot) return true;
  return itemSlot === 'twohanded' && (slot === 'mainhand' || slot === 'offhand');
}

/** Backpack items the class can put in `slot`, best rarity first, then by name. */
export function itemsForSlot(
  slot: EquipSlot,
  inventory: Record<string, number>,
  items: Record<string, ItemDefinition>,
  className: string | null | undefined,
): SlotCandidate[] {
  const out: SlotCandidate[] = [];
  for (const [itemId, count] of Object.entries(inventory)) {
    if (count <= 0) continue;
    const def = items[itemId];
    if (!def || !slotAccepts(slot, def.equipSlot) || !canClassUse(def, className)) continue;
    out.push({ itemId, count, def });
  }
  return out.sort((a, b) => (RARITY_ORDER[b.def.rarity] - RARITY_ORDER[a.def.rarity]) || a.def.name.localeCompare(b.def.name));
}

/** The equipment record after equipping `itemId`, mirroring `equipItem`'s 2H rules. Does not touch inventory. */
export function previewEquip(
  equipment: Record<string, string | null>,
  itemId: string,
  items: Record<string, ItemDefinition>,
): Record<string, string | null> {
  const next = { ...equipment };
  const slot = items[itemId]?.equipSlot;
  if (!slot) return next;
  const twoHandedNow = !!next.mainhand && items[next.mainhand]?.equipSlot === 'twohanded';
  if (slot === 'twohanded' || ((slot === 'mainhand' || slot === 'offhand') && twoHandedNow)) {
    next.mainhand = null;
    next.offhand = null;
  }
  if (slot === 'twohanded') {
    next.mainhand = itemId;
    next.offhand = itemId;
  } else {
    next[slot] = itemId;
  }
  return next;
}

/** Changed derived stats between two snapshots, in sheet order. */
export function statDelta(before: DerivedStats, after: DerivedStats, includeUnchanged: boolean = false): StatDeltaLine[] {
  const rows: Array<[DerivedStatKey, string, number, number, string, string]> = [];
  for (const name of ATTRIBUTE_NAMES) {
    rows.push([name, ATTRIBUTE_LABELS[name], before.attributes[name], after.attributes[name], `${before.attributes[name]}`, `${after.attributes[name]}`]);
  }
  rows.push(['maxHp', 'Max HP', before.maxHp, after.maxHp, `${before.maxHp}`, `${after.maxHp}`]);
  rows.push(['damage', 'Damage', before.damage, after.damage, `${before.damage}`, `${after.damage}`]);
  rows.push(rangeRow('attackBonus', 'Bonus Attack', before.attackBonusMin, before.attackBonusMax, after.attackBonusMin, after.attackBonusMax));
  rows.push(rangeRow('armor', 'Armor', before.armorMin, before.armorMax, after.armorMin, after.armorMax));
  rows.push(rangeRow('resist', 'Resist', before.resistMin, before.resistMax, after.resistMin, after.resistMax));
  rows.push(['critChance', 'Crit', before.critChance, after.critChance, percent(before.critChance), percent(after.critChance)]);
  rows.push(['dodgeChance', 'Dodge', before.dodgeChance, after.dodgeChance, percent(before.dodgeChance), percent(after.dodgeChance)]);

  const out: StatDeltaLine[] = [];
  for (const [key, label, b, a, beforeText, afterText] of rows) {
    const delta = roundDelta(a - b);
    if (delta === 0 && !includeUnchanged) continue;
    out.push({ key, label, before: beforeText, after: afterText, delta });
  }
  return out;
}

/** Stat changes if `itemId` replaced what's in its slot now. */
export function compareEquip(input: DerivedStatsInput, itemId: string): StatDeltaLine[] {
  const before = computeDerivedStats(input);
  const after = computeDerivedStats({ ...input, equipment: previewEquip(input.equipment, itemId, input.items) });
  return statDelta(before, after);
}

/**
 * Structured tooltip lines for an item. Heirloom values are shown as worn at
 * `level` when given; `className` marks the viewer's primary attribute.
 */
export function describeItemStats(
  def: ItemDefinition,
  opts: { level?: number; className?: ClassName | null; skills?: Record<string, SkillDefinition> } = {},
): ItemStatLine[] {
  const lines: ItemStatLine[] = [];
  const isHeirloom = def.rarity === 'heirloom';
  const scale = isHeirloom ? (opts.level ?? 1) : 1;
  const primary = opts.className ? CLASS_ATTRIBUTE_PROFILES[opts.className].primary : undefined;

  if (def.equipSlot) lines.push({ kind: 'slot', text: SLOT_TEXT[def.equipSlot] ?? def.equipSlot, slot: def.equipSlot });
  if (isBag(def)) lines.push({ kind: 'bag', text: `${def.bagSlots}-slot bag` });

  const attrs = itemAttributes(def, opts.level ?? 1);
  for (const name of ATTRIBUTE_NAMES) {
    const value = attrs[name];
    if (value === 0) continue;
    lines.push({ kind: 'attribute', text: `${signed(value)} ${ATTRIBUTE_LABELS[name]}`, attribute: name, primary: name === primary });
  }

  pushRange(lines, 'attack', 'Attack', def.bonusAttackMin, def.bonusAttackMax, scale);
  pushRange(lines, 'armor', 'Armor', def.damageReductionMin, def.damageReductionMax, scale);
  pushRange(lines, 'resist', 'Resist', def.magicReductionMin, def.magicReductionMax, scale);

  for (const skillId of def.grantedSkillIds ?? []) {
    lines.push({ kind: 'grant', text: `Grants skill: ${opts.skills?.[skillId]?.name ?? skillId}` });
  }
  if (isHeirloom && lines.some(l => l.kind === 'attribute' || l.kind === 'attack' || l.kind === 'armor' || l.kind === 'resist')) {
    lines.push({ kind: 'heirloom', text: 'Grows stronger with your level' });
  }
  if (def.classRestriction && def.classRestriction.length > 0) {
    lines.push({ kind: 'classes', text: `Classes: ${def.classRestriction.join(', ')}` });
  }
  if (def.consumable) lines.push({ kind: 'consumable', text: 'Consumable' });
  if (!def.equipSlot && !isBag(def) && !def.consumable) lines.push({ kind: 'material', text: 'Material' });
  return lines;
}

function rangeRow(key: DerivedStatKey, label: string, bMin: number, bMax: number, aMin: number, aMax: number): [DerivedStatKey, string, number, number, string, string] {
  return [key, label, (bMin + bMax) / 2, (aMin + aMax) / 2, rangeText(bMin, bMax), rangeText(aMin, aMax)];
}

function rangeText(min: number, max: number): string {
  return min === max ? `${min}` : `${min}–${max}`;
}

function pushRange(lines: ItemStatLine[], kind: ItemStatLineKind, label: string, min: number | undefined, max: number | undefined, scale: number): void {
  const hi = (max ?? 0) * scale;
  if (hi <= 0) return;
  lines.push({ kind, text: `+${rangeText((min ?? 0) * scale, hi)} ${label}` });
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function roundDelta(value: number): number {
  return Math.round(value * 10000) / 10000;
}
