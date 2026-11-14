import { describe, expect, it } from 'vitest';
import type { ItemDefinition } from '../src/index.js';
import { computeDerivedStats, compareEquip, reconcileSockets, socketCapacity, socketJewel, validateSocketItem } from '../src/index.js';

const items: Record<string, ItemDefinition> = {
  helm: { id: 'helm', name: 'Helm', rarity: 'common', equipSlot: 'head', sockets: 2 },
  helm2: { id: 'helm2', name: 'Helm 2', rarity: 'common', equipSlot: 'head', sockets: 2 },
  axe: { id: 'axe', name: 'Axe', rarity: 'common', equipSlot: 'twohanded', sockets: 3 },
  gem: { id: 'gem', name: 'Gem', rarity: 'common', jewel: true, attributes: { strength: 4 }, bonusAttackMin: 1, bonusAttackMax: 2 },
};

describe('sockets', () => {
  it('2H offhand mirror has no sockets of its own', () => {
    const eq = { mainhand: 'axe', offhand: 'axe' };
    expect(socketCapacity(eq, 'mainhand', items)).toBe(3);
    expect(socketCapacity(eq, 'offhand', items)).toBe(0);
  });

  it('socketJewel consumes one copy and respects capacity', () => {
    const inv = { gem: 3 };
    const socketed = {};
    const eq = { head: 'helm' };
    expect(socketJewel(inv, eq, socketed, 'head', 'gem', items).ok).toBe(true);
    expect(socketJewel(inv, eq, socketed, 'head', 'gem', items).ok).toBe(true);
    expect(socketJewel(inv, eq, socketed, 'head', 'gem', items)).toEqual({ ok: false, error: 'socket_no_free_socket' });
    expect(inv.gem).toBe(1);
  });

  it('reconcile returns all jewels of a changed slot and pops extras of an unchanged one', () => {
    const socketed = { head: ['gem', 'gem'], chest: ['gem', 'gem'] };
    const prev = { head: 'helm', chest: 'helm' };
    const removed = reconcileSockets(socketed, prev, { head: 'helm2', chest: 'helm' }, { ...items, helm: { ...items.helm, sockets: 1 } });
    expect(removed).toEqual(['gem', 'gem', 'gem']);
    expect(socketed).toEqual({ chest: ['gem'] });
  });

  it('jewels feed attributes and attack range, but ignore unsocketed slots', () => {
    const base = { className: 'Knight' as const, level: 10, equipment: { head: 'helm' }, items };
    const plain = computeDerivedStats(base);
    const geared = computeDerivedStats({ ...base, socketedJewels: { head: ['gem', 'gem', 'gem'] } });
    expect(geared.gearAttributes.strength).toBe(8);
    expect(geared.attackBonusMax).toBe(plain.attackBonusMax + 4);
    expect(computeDerivedStats({ ...base, socketedJewels: { chest: ['gem'] } }).gearAttributes.strength).toBe(0);
  });

  it('compareEquip drops jewels when the slot item changes', () => {
    const input = { className: 'Knight' as const, level: 10, equipment: { head: 'helm' }, items, socketedJewels: { head: ['gem'] } };
    const strength = compareEquip(input, 'helm2').find(l => l.key === 'strength');
    expect(strength?.delta).toBe(-4);
  });

  it('validates authored fields', () => {
    expect(validateSocketItem({ sockets: 4, equipSlot: 'head' })).toMatch(/0 to 3/);
    expect(validateSocketItem({ sockets: 1 })).toMatch(/equippable/);
    expect(validateSocketItem({ jewel: true, equipSlot: 'head' })).toMatch(/jewel/i);
    expect(validateSocketItem({ sockets: 2, equipSlot: 'head' })).toBeNull();
  });
});
