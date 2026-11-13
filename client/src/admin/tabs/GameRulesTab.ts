import {
  ALL_CLASS_NAMES,
  ATTRIBUTE_ABBREVIATIONS,
  BACKPACK_BASE_SLOTS,
  BAG_SLOT_COUNT,
  BANK_BASE_TABS,
  BANK_SLOTS_PER_TAB,
  BANK_TAB_PRICES,
  CLASS_ATTRIBUTE_PROFILES,
  COMBAT_TICK_MS,
  CRIT_PER_AGILITY,
  DODGE_PER_AGILITY,
  HOUSE_SELL_REFUND,
  INTELLECT_HEAL_RATE,
  INTELLECT_PER_RESIST,
  LOST_AND_FOUND_SLOTS,
  MAX_ATTRIBUTE_CRIT,
  MAX_ATTRIBUTE_DODGE,
  MAX_BAG_SIZE,
  MAX_BANK_TABS,
  MAX_CRAFT_QUEUE,
  MAX_GOLD,
  MAX_HENCHMEN_PER_PARTY,
  MAX_PARTY_SIZE,
  MAX_STACK,
  RARITY_ATTRIBUTE_BUDGET,
  RESTED_CAP_MS,
  RESTED_MS_PER_SIT_MS,
  RUN_AVAILABLE_ROUNDS,
  STARTER_BAG_ITEM,
  STRENGTH_PER_ARMOR,
  WELL_RESTED_BONUS,
} from '@idle-party-rpg/shared';
import type { Tab } from './Tab';
import { escapeHtml } from '../api';

export interface GameRule {
  label: string;
  value: string;
}

export interface GameRuleSection {
  title: string;
  rules: GameRule[];
}

/** Every hardcoded gameplay rule worth showing a content author, read live from shared constants. */
export function buildGameRuleSections(): GameRuleSection[] {
  return [
    {
      title: 'Combat & Party',
      rules: [
        { label: 'Combat tick', value: `${COMBAT_TICK_MS / 1000}s` },
        { label: 'Run available after', value: `${RUN_AVAILABLE_ROUNDS} rounds` },
        { label: 'Max party size', value: `${MAX_PARTY_SIZE}` },
        { label: 'Max henchmen per party', value: `${MAX_HENCHMEN_PER_PARTY}` },
      ],
    },
    {
      title: 'Backpack & Bags',
      rules: [
        { label: 'Backpack base slots', value: `${BACKPACK_BASE_SLOTS}` },
        { label: 'Bag slots', value: `${BAG_SLOT_COUNT}` },
        { label: 'Max bag size', value: `${MAX_BAG_SIZE} slots` },
        { label: 'Starter bag', value: `${STARTER_BAG_ITEM.name} (${STARTER_BAG_ITEM.bagSlots ?? 0} slots)` },
        { label: 'Max backpack capacity', value: `${BACKPACK_BASE_SLOTS + BAG_SLOT_COUNT * MAX_BAG_SIZE} slots` },
        { label: 'Lost & Found slots', value: `${LOST_AND_FOUND_SLOTS}` },
        { label: 'Max stack', value: `${MAX_STACK}` },
      ],
    },
    {
      title: 'Bank',
      rules: [
        { label: 'Free tabs', value: `${BANK_BASE_TABS}` },
        { label: 'Slots per tab', value: `${BANK_SLOTS_PER_TAB}` },
        { label: 'Max tabs', value: `${MAX_BANK_TABS}` },
        ...BANK_TAB_PRICES.map((price, i) => ({
          label: `Tab ${BANK_BASE_TABS + i + 1} price`,
          value: `${formatNumber(price)} gold`,
        })),
      ],
    },
    {
      title: 'Attributes',
      rules: [
        { label: 'Armor', value: `1 per ${STRENGTH_PER_ARMOR} STR` },
        { label: 'Magic resist', value: `1 per ${INTELLECT_PER_RESIST} INT` },
        { label: 'Crit chance', value: `${formatPercent(CRIT_PER_AGILITY)} per AGI, max ${formatPercent(MAX_ATTRIBUTE_CRIT)}` },
        { label: 'Dodge chance', value: `${formatPercent(DODGE_PER_AGILITY)} per AGI, max ${formatPercent(MAX_ATTRIBUTE_DODGE)}` },
        { label: 'Heal rate', value: `${INTELLECT_HEAL_RATE}× class damage growth per gear INT` },
      ],
    },
    {
      title: 'Class Profiles',
      rules: ALL_CLASS_NAMES.map(cls => {
        const p = CLASS_ATTRIBUTE_PROFILES[cls];
        const primary = ATTRIBUTE_ABBREVIATIONS[p.primary];
        return {
          label: cls,
          value: `${primary} primary · ${p.hpPerStamina} HP per STA · ${p.damagePerPrimary} dmg per ${primary}`,
        };
      }),
    },
    {
      title: 'Attribute Budget by Rarity',
      rules: Object.entries(RARITY_ATTRIBUTE_BUDGET).map(([rarity, factor]) => ({
        label: capitalize(rarity),
        value: rarity === 'heirloom' ? 'set per level' : `${factor}×`,
      })),
    },
    {
      title: 'Housing & Rest',
      rules: [
        { label: 'Sell refund', value: formatPercent(HOUSE_SELL_REFUND) },
        { label: 'Rested earned', value: `${RESTED_MS_PER_SIT_MS} min per min at a campfire` },
        { label: 'Rested cap', value: `${RESTED_CAP_MS / 3_600_000}h` },
        { label: 'Well Rested bonus', value: `+${formatPercent(WELL_RESTED_BONUS - 1)} XP and gold` },
      ],
    },
    {
      title: 'Economy & Crafting',
      rules: [
        { label: 'Max gold', value: formatNumber(MAX_GOLD) },
        { label: 'Craft queue size', value: `${MAX_CRAFT_QUEUE}` },
      ],
    },
  ];
}

export class GameRulesTab implements Tab {
  render(container: HTMLElement): void {
    const cards = buildGameRuleSections().map(section => `
      <div class="admin-card">
        <div class="admin-card-title">${escapeHtml(section.title)}</div>
        <dl class="game-rules-list">
          ${section.rules.map(r => `<dt>${escapeHtml(r.label)}</dt><dd>${escapeHtml(r.value)}</dd>`).join('')}
        </dl>
      </div>
    `).join('');

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Game Rules</h2></div>
        <p class="admin-page-subtitle">These rules are set in code. Ask a developer to change them.</p>
        <div class="game-rules-grid">${cards}</div>
      </div>
    `;
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatPercent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(2))}%`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
