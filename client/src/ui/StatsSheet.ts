import type { AttributeName, DerivedStats } from '@idle-party-rpg/shared';
import {
  ATTRIBUTE_ABBREVIATIONS,
  ATTRIBUTE_LABELS,
  ATTRIBUTE_NAMES,
  CLASS_ATTRIBUTE_PROFILES,
  INTELLECT_PER_RESIST,
  MAX_ATTRIBUTE_CRIT,
  MAX_ATTRIBUTE_DODGE,
  STRENGTH_PER_ARMOR,
} from '@idle-party-rpg/shared';
import { escapeHtml } from './ItemIcon';
import '../styles/screens/gear.css';

export interface AttributeView {
  name: AttributeName;
  abbr: string;
  label: string;
  total: number;
  base: number;
  gear: number;
  primary: boolean;
  explain: string;
}

export interface DerivedView {
  key: 'maxHp' | 'damage' | 'armor' | 'resist' | 'crit' | 'dodge' | 'healing';
  label: string;
  value: string;
  sub?: string;
  explain: string;
}

export interface StatsSheetModel {
  attributes: AttributeView[];
  derived: DerivedView[];
}

function range(min: number, max: number): string {
  return min === max ? `${min}` : `${min}–${max}`;
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function attributeExplain(name: AttributeName, stats: DerivedStats): string {
  const profile = CLASS_ATTRIBUTE_PROFILES[stats.className];
  const primaryNote = name === stats.primaryAttribute
    ? `Your primary attribute: each point adds ${profile.damagePerPrimary} damage. `
    : '';
  switch (name) {
    case 'stamina': return `Each point adds ${profile.hpPerStamina} max HP.`;
    case 'strength': return `${primaryNote}Every ${STRENGTH_PER_ARMOR} Strength adds 1 Armor.`;
    case 'agility': return `${primaryNote}Each point adds 0.1% crit and 0.05% dodge.`;
    case 'intellect': return `${primaryNote}Every ${INTELLECT_PER_RESIST} Intellect adds 1 Resist. Intellect from gear makes your heals stronger.`;
  }
}

export function statsSheetModel(stats: DerivedStats): StatsSheetModel {
  const attributes = ATTRIBUTE_NAMES.map(name => ({
    name,
    abbr: ATTRIBUTE_ABBREVIATIONS[name],
    label: ATTRIBUTE_LABELS[name],
    total: stats.attributes[name],
    base: stats.baseAttributes[name],
    gear: stats.gearAttributes[name],
    primary: name === stats.primaryAttribute,
    explain: attributeExplain(name, stats),
  }));
  const primaryLabel = ATTRIBUTE_LABELS[stats.primaryAttribute];
  const healPct = Math.round((stats.healingMultiplier - 1) * 100);
  const hasAttack = stats.attackBonusMax > 0;
  const derived: DerivedView[] = [
    { key: 'maxHp', label: 'Health', value: `${stats.maxHp}`, explain: 'Your maximum health. Grows with level and Stamina.' },
    {
      key: 'damage',
      label: 'Damage',
      value: `${stats.damage}`,
      sub: hasAttack ? `+${range(stats.attackBonusMin, stats.attackBonusMax)} attack` : stats.damageType,
      explain: `Damage per attack, from your level and ${primaryLabel}.${hasAttack ? ' Weapon attack bonuses are added on each hit.' : ''}`,
    },
    { key: 'armor', label: 'Armor', value: range(stats.armorMin, stats.armorMax), explain: `Blocks this much physical damage per hit. Comes from gear and Strength (1 per ${STRENGTH_PER_ARMOR}).` },
    { key: 'resist', label: 'Resist', value: range(stats.resistMin, stats.resistMax), explain: `Blocks this much magical damage per hit. Comes from gear and Intellect (1 per ${INTELLECT_PER_RESIST}). Holy damage ignores it.` },
    { key: 'crit', label: 'Crit', value: pct(stats.critChance), explain: `Chance to land a critical hit. Comes from Agility, up to ${pct(MAX_ATTRIBUTE_CRIT)}.` },
    { key: 'dodge', label: 'Dodge', value: pct(stats.dodgeChance), explain: `Chance to dodge an attack. Comes from Agility, up to ${pct(MAX_ATTRIBUTE_DODGE)}.` },
    { key: 'healing', label: 'Healing', value: `${healPct >= 0 ? '+' : ''}${healPct}%`, explain: 'Bonus to every heal you cast. Comes from Intellect on your gear.' },
  ];
  return { attributes, derived };
}

/** Attributes then derived stats. Every cell carries `data-stat-title`/`data-stat-desc` for the tap explanation. */
export function renderStatsSheet(stats: DerivedStats, opts: { exclude?: DerivedView['key'][]; extraCells?: string } = {}): string {
  const model = statsSheetModel(stats);
  const exclude = new Set(opts.exclude ?? []);
  const attrs = model.attributes.map(a => {
    const breakdown = a.gear !== 0 ? `${a.base} + ${a.gear} gear` : 'base';
    return `<button type="button" class="ss-attr${a.primary ? ' is-primary' : ''}" data-attribute="${a.name}"
      data-stat-title="${escapeHtml(a.label)}${a.primary ? ' (primary)' : ''}" data-stat-desc="${escapeHtml(`${a.explain} ${a.base} base${a.gear !== 0 ? ` + ${a.gear} from gear` : ''}.`)}"
      aria-label="${escapeHtml(`${a.label} ${a.total}${a.primary ? ', primary' : ''}`)}">
      <span class="ss-attr__abbr">${escapeHtml(a.abbr)}</span>
      <span class="ss-attr__value">${a.total}</span>
      <span class="ss-attr__sub">${escapeHtml(breakdown)}</span>
      ${a.primary ? '<span class="ss-attr__tag">Primary</span>' : ''}
    </button>`;
  }).join('');
  const derived = model.derived.filter(d => !exclude.has(d.key)).map(d => `
    <button type="button" class="ss-stat" data-stat="${d.key}" data-stat-title="${escapeHtml(d.label)}" data-stat-desc="${escapeHtml(d.explain)}"
      aria-label="${escapeHtml(`${d.label} ${d.value}`)}">
      <span class="ss-stat__label">${escapeHtml(d.label)}</span>
      <span class="ss-stat__value">${escapeHtml(d.value)}</span>
      ${d.sub ? `<span class="ss-stat__sub">${escapeHtml(d.sub)}</span>` : ''}
    </button>`).join('');
  return `<div class="ss-attrs">${attrs}</div><div class="ss-derived">${derived}${opts.extraCells ?? ''}</div>`;
}
