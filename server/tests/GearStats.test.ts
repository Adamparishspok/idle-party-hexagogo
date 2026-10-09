import { describe, expect, it } from 'vitest';
import { ALL_CLASS_NAMES, calculateBaseDamage, calculateMaxHp } from '@idle-party-rpg/shared';
import type { CharacterState, ItemDefinition } from '@idle-party-rpg/shared';
import { gearKit } from './gearTestKit.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';

function character(session: PlayerSession): CharacterState {
  return session['character']!;
}

const ITEMS: Record<string, ItemDefinition> = {
  might_helm: { id: 'might_helm', name: 'Helm of Might', rarity: 'uncommon', equipSlot: 'head', attributes: { strength: 30, stamina: 10 } },
  swift_boots: { id: 'swift_boots', name: 'Swift Boots', rarity: 'uncommon', equipSlot: 'foot', attributes: { agility: 100 } },
  sage_ring: { id: 'sage_ring', name: 'Sage Ring', rarity: 'uncommon', equipSlot: 'ring', attributes: { intellect: 22 } },
  old_shield: { id: 'old_shield', name: 'Old Shield', rarity: 'common', equipSlot: 'offhand', damageReductionMin: 2, damageReductionMax: 3 },
};

describe('derived stats on the server', () => {
  it('keeps naked HP and damage identical to the class curves', () => {
    const kit = gearKit(ITEMS);
    for (const className of ALL_CLASS_NAMES) {
      const session = kit.newSession(`p_${className}`, className);
      for (const level of [1, 10, 25, 60]) {
        character(session).level = level;
        const info = session.getCombatInfo();
        expect(info.maxHp).toBe(calculateMaxHp(level, className));
        expect(info.baseDamage).toBe(calculateBaseDamage(level, className));
      }
    }
  });

  it('feeds attribute gear into combat: HP, damage and armor on top of legacy armor', () => {
    const kit = gearKit(ITEMS);
    const session = kit.newSession('knight', 'Knight');
    character(session).level = 10;
    character(session).equipment.head = 'might_helm';
    character(session).equipment.offhand = 'old_shield';
    const info = session.getCombatInfo();
    expect(info.maxHp).toBe(calculateMaxHp(10, 'Knight') + 20);
    expect(info.baseDamage).toBe(calculateBaseDamage(10, 'Knight') + 15);
    expect(info.equipBonuses?.damageReductionMin).toBe(2 + 3);
    expect(info.equipBonuses?.damageReductionMax).toBe(3 + 3);
  });

  it('gives Agility crit and dodge, and gear Intellect a healing multiplier', () => {
    const kit = gearKit(ITEMS);
    const archer = kit.newSession('archer', 'Archer');
    character(archer).equipment.foot = 'swift_boots';
    const a = archer.getCombatInfo();
    expect(a.critChance).toBeCloseTo((15 + 100) * 0.001);
    expect(a.dodgeChance).toBeCloseTo((15 + 100) * 0.0005);

    const priest = kit.newSession('priest', 'Priest');
    expect(priest.getCombatInfo().healingMultiplier).toBe(1);
    character(priest).level = 20;
    character(priest).equipment.ring = 'sage_ring';
    const p = priest.getCombatInfo();
    expect(p.healingMultiplier).toBeCloseTo(1 + (22 * 0.5) / calculateBaseDamage(20, 'Priest'));
  });

  it('sends derived stats in the state push, matching maxHp and baseDamage', () => {
    const kit = gearKit(ITEMS);
    const session = kit.newSession('knight', 'Knight');
    character(session).equipment.head = 'might_helm';
    const state = session.getState([]);
    const c = state.character!;
    expect(c.derivedStats.maxHp).toBe(c.maxHp);
    expect(c.derivedStats.damage).toBe(c.baseDamage);
    expect(c.derivedStats.gearAttributes.strength).toBe(30);
    expect(c.derivedStats.primaryAttribute).toBe('strength');
  });
});
