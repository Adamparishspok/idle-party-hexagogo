import type {
  BagSlots,
  ClassName,
  ClientBankState,
  DerivedStats,
  DerivedStatKey,
  DerivedStatsInput,
  EquipSlot,
  ItemDefinition,
  ServerStateMessage,
  StatDeltaLine,
} from '@idle-party-rpg/shared';
import {
  BAG_SLOT_COUNT,
  CLASS_ATTRIBUTE_PROFILES,
  compareEquip,
  computeDerivedStats,
  describeItemStats,
  inventoryCapacity,
  isBag,
  itemsForSlot,
  listUnequippedEntries,
  normalizeBagSlots,
  usedInventorySlots,
} from '@idle-party-rpg/shared';

export interface SlotCandidateView {
  itemId: string;
  count: number;
  def: ItemDefinition;
  deltas: StatDeltaLine[];
  keyStat: string | null;
}

export interface SlotPickerModel {
  slot: EquipSlot;
  equipped: { itemId: string; def: ItemDefinition } | null;
  candidates: SlotCandidateView[];
}

export interface DeltaChip {
  text: string;
  better: boolean;
}

export interface BagSlotView {
  index: number;
  itemId: string | null;
  def: ItemDefinition | undefined;
  size: number;
}

export interface BagBarModel {
  used: number;
  capacity: number;
  full: boolean;
  over: boolean;
  slots: BagSlotView[];
  bagsInBackpack: Array<[string, number]>;
  pouch: Array<[string, number]>;
}

export interface BankTabView {
  index: number;
  entries: Array<[string, number]>;
  used: number;
  slots: number;
}

const CHIP_ORDER: DerivedStatKey[] = [
  'damage', 'maxHp', 'armor', 'resist', 'critChance', 'dodgeChance', 'healing', 'attackBonus',
  'strength', 'agility', 'intellect', 'stamina',
];

const CHIP_LABELS: Record<DerivedStatKey, string> = {
  strength: 'STR', agility: 'AGI', intellect: 'INT', stamina: 'STA',
  maxHp: 'HP', damage: 'Dmg', attackBonus: 'Atk', armor: 'Armor', resist: 'Resist',
  critChance: 'Crit', dodgeChance: 'Dodge', healing: 'Heal',
};

const PERCENT_KEYS = new Set<DerivedStatKey>(['critChance', 'dodgeChance', 'healing']);

export function isKnownClass(className: string | null | undefined): className is ClassName {
  return !!className && className in CLASS_ATTRIBUTE_PROFILES;
}

export function allItemDefs(state: ServerStateMessage): Record<string, ItemDefinition> {
  return { ...(state.bank?.itemDefinitions ?? {}), ...(state.itemDefinitions ?? {}) };
}

export function derivedInputFromState(state: ServerStateMessage | null): DerivedStatsInput | null {
  const char = state?.character;
  if (!state || !char || !isKnownClass(char.className)) return null;
  return {
    className: char.className,
    level: char.level,
    equipment: char.equipment,
    items: allItemDefs(state),
    sets: state.setDefinitions ?? {},
  };
}

/** The server's numbers when it sends them, else the same formula run locally. */
export function currentDerivedStats(state: ServerStateMessage | null): DerivedStats | null {
  if (state?.character?.derivedStats) return state.character.derivedStats;
  const input = derivedInputFromState(state);
  return input ? computeDerivedStats(input) : null;
}

/** Short headline stat for a picker row: the viewer's primary attribute first, else the first stat line. */
export function keyStatText(def: ItemDefinition, className: ClassName | null, level: number): string | null {
  const lines = describeItemStats(def, { className, level });
  const primary = lines.find(l => l.kind === 'attribute' && l.primary);
  if (primary) return primary.text;
  const stat = lines.find(l => l.kind === 'attribute' || l.kind === 'attack' || l.kind === 'armor' || l.kind === 'resist');
  return stat?.text ?? null;
}

export function slotPickerModel(slot: EquipSlot, state: ServerStateMessage): SlotPickerModel | null {
  const char = state.character;
  const input = derivedInputFromState(state);
  if (!char || !input) return null;
  const equippedId = char.equipment[slot] ?? null;
  const equippedDef = equippedId ? input.items[equippedId] : undefined;
  const candidates = itemsForSlot(slot, char.inventory, input.items, char.className).map(c => ({
    itemId: c.itemId,
    count: c.count,
    def: c.def,
    deltas: compareEquip(input, c.itemId),
    keyStat: keyStatText(c.def, input.className, char.level),
  }));
  return {
    slot,
    equipped: equippedId && equippedDef ? { itemId: equippedId, def: equippedDef } : null,
    candidates,
  };
}

export function formatDelta(line: StatDeltaLine): string {
  const sign = line.delta > 0 ? '+' : '−';
  const magnitude = Math.abs(line.delta);
  if (PERCENT_KEYS.has(line.key)) {
    const pct = Math.round(magnitude * 1000) / 10;
    return `${sign}${pct}%`;
  }
  return `${sign}${Math.round(magnitude * 10) / 10}`;
}

/** The few changes worth a chip on a picker row: combat stats before raw attributes. */
export function deltaChips(lines: StatDeltaLine[], max: number = 3): DeltaChip[] {
  const byKey = new Map(lines.map(l => [l.key, l]));
  const out: DeltaChip[] = [];
  for (const key of CHIP_ORDER) {
    const line = byKey.get(key);
    if (!line) continue;
    out.push({ text: `${formatDelta(line)} ${CHIP_LABELS[key]}`, better: line.delta > 0 });
    if (out.length >= max) break;
  }
  return out;
}

export function bagBarModel(state: ServerStateMessage): BagBarModel | null {
  const char = state.character;
  if (!char) return null;
  const defs = allItemDefs(state);
  const bags: BagSlots = normalizeBagSlots(char.bags);
  const capacity = char.inventoryCapacity ?? inventoryCapacity(bags, defs);
  const used = usedInventorySlots(char.inventory);
  const slots: BagSlotView[] = [];
  for (let index = 0; index < BAG_SLOT_COUNT; index++) {
    const itemId = bags[index] ?? null;
    const def = itemId ? defs[itemId] : undefined;
    slots.push({ index, itemId, def, size: def?.bagSlots ?? 0 });
  }
  const bagsInBackpack = listUnequippedEntries(char.inventory).filter(([id]) => isBag(defs[id]));
  const pouch = Object.entries(char.lostAndFound ?? {}).filter(([, n]) => n > 0);
  return { used, capacity, full: used >= capacity, over: used > capacity, slots, bagsInBackpack, pouch };
}

export function bankTabs(bank: ClientBankState): BankTabView[] {
  return bank.tabs.map((tab, index) => {
    const entries = Object.entries(tab).filter(([, n]) => n > 0);
    return { index, entries, used: entries.length, slots: bank.slotsPerTab };
  });
}

/** Backpack stacks that can go in the bank (equipped gear and bags in bag slots never sit in `inventory`). */
export function depositableEntries(state: ServerStateMessage): Array<[string, number]> {
  return listUnequippedEntries(state.character?.inventory ?? {});
}
