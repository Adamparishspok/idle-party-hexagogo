import { describe, expect, it } from 'vitest';
import {
  accrueRested,
  applyRestedBonus,
  canStore,
  emptyHouse,
  houseSellPrice,
  isWellRested,
  RESTED_CAP_MS,
  RESTED_MS_PER_SIT_MS,
} from '../src/systems/HousingTypes';
import type { HouseDefinition } from '../src/systems/HousingTypes';

const COTTAGE: HouseDefinition = {
  id: 'cottage', name: 'Cottage', tier: 1, price: 1001, storageSlots: 2, displaySlots: 3, emoji: '🏠',
};

describe('housing rules', () => {
  it('refunds half the price, floored', () => {
    expect(houseSellPrice(COTTAGE)).toBe(500);
  });

  it('accrues rested time from now when not rested', () => {
    const now = 1_000_000;
    expect(accrueRested(undefined, now - 60_000, now)).toBe(now + 60_000 * RESTED_MS_PER_SIT_MS);
  });

  it('extends an active buff and caps the remaining time', () => {
    const now = 1_000_000;
    expect(accrueRested(now + 1000, now - 1000, now)).toBe(now + 1000 + 1000 * RESTED_MS_PER_SIT_MS);
    expect(accrueRested(now + RESTED_CAP_MS - 10, now - 3_600_000, now)).toBe(now + RESTED_CAP_MS);
  });

  it('ignores a sit start in the future', () => {
    expect(accrueRested(undefined, 2000, 1000)).toBe(1000);
  });

  it('applies the bonus only while rested', () => {
    expect(isWellRested(2000, 1000)).toBe(true);
    expect(isWellRested(1000, 1000)).toBe(false);
    expect(applyRestedBonus(100, 2000, 1000)).toBe(110);
    expect(applyRestedBonus(100, undefined, 1000)).toBe(100);
  });

  it('stores into existing stacks and free slots only', () => {
    const house = emptyHouse(COTTAGE, 0);
    expect(house.displays).toEqual([null, null, null]);
    expect(canStore(house, COTTAGE, 'a', 1)).toBe(true);
    house.storage = { a: 1, b: 2 };
    expect(canStore(house, COTTAGE, 'a', 5)).toBe(true);
    expect(canStore(house, COTTAGE, 'c', 1)).toBe(false);
    expect(canStore(house, COTTAGE, 'a', 0)).toBe(false);
  });
});
