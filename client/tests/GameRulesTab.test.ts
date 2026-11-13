import { describe, expect, it } from 'vitest';
import {
  ALL_CLASS_NAMES,
  BACKPACK_BASE_SLOTS,
  BANK_TAB_PRICES,
  BANK_SLOTS_PER_TAB,
} from '@idle-party-rpg/shared';
import { buildGameRuleSections, GameRulesTab } from '../src/admin/tabs/GameRulesTab';

function rule(section: string, label: string): string | undefined {
  return buildGameRuleSections().find(s => s.title === section)?.rules.find(r => r.label === label)?.value;
}

describe('buildGameRuleSections', () => {
  it('reads values from the shared constants', () => {
    expect(rule('Backpack & Bags', 'Backpack base slots')).toBe(`${BACKPACK_BASE_SLOTS}`);
    expect(rule('Bank', 'Slots per tab')).toBe(`${BANK_SLOTS_PER_TAB}`);
    expect(rule('Combat & Party', 'Combat tick')).toBe('1s');
  });

  it('lists one price per buyable bank tab and one profile per class', () => {
    const bank = buildGameRuleSections().find(s => s.title === 'Bank')!;
    expect(bank.rules.filter(r => r.label.endsWith('price'))).toHaveLength(BANK_TAB_PRICES.length);
    expect(rule('Bank', 'Tab 2 price')).toBe('1,000 gold');
    const classes = buildGameRuleSections().find(s => s.title === 'Class Profiles')!;
    expect(classes.rules.map(r => r.label)).toEqual(ALL_CLASS_NAMES);
  });

  it('formats percentages and rested rules', () => {
    expect(rule('Housing & Rest', 'Sell refund')).toBe('50%');
    expect(rule('Housing & Rest', 'Rested cap')).toBe('8h');
    expect(rule('Housing & Rest', 'Well Rested bonus')).toBe('+10% XP and gold');
    expect(rule('Attributes', 'Crit chance')).toBe('0.1% per AGI, max 25%');
  });
});

describe('GameRulesTab', () => {
  it('renders the developer note and one card per section', () => {
    const el = document.createElement('div');
    new GameRulesTab().render(el);
    expect(el.textContent).toContain('These rules are set in code. Ask a developer to change them.');
    expect(el.querySelectorAll('.admin-card')).toHaveLength(buildGameRuleSections().length);
  });
});
