import { describe, it, expect } from 'vitest';
import { SEED_TUTORIAL_STEPS } from '@idle-party-rpg/shared';
import type { ItemDefinition } from '@idle-party-rpg/shared';
import type { PlayerSaveData } from '../src/game/GameStateStore.js';
import { gearKit } from './gearTestKit.js';

function kitWithTutorial(steps = SEED_TUTORIAL_STEPS) {
  const kit = gearKit({ sword: { id: 'sword', name: 'Sword', rarity: 'common', equipSlot: 'weapon' } as ItemDefinition });
  (kit.content as unknown as { getAllTutorialSteps: () => unknown }).getAllTutorialSteps =
    () => Object.fromEntries(steps.map(s => [s.id, s]));
  return kit;
}

describe('tutorial progress on PlayerSession', () => {
  it('a new session starts the tutorial with gated tabs locked', () => {
    const state = kitWithTutorial().newSession('alice').getState([]);
    expect(state.tutorial?.step?.id).toBe('fight');
    expect(state.tutorial?.locked).toContain('items');
  });

  it('a save predating the field restores completed and fully unlocked', () => {
    const kit = kitWithTutorial();
    const save = JSON.parse(JSON.stringify(kit.newSession('old').toSaveData())) as PlayerSaveData;
    delete save.tutorial;
    expect(kit.restore(save).getState([]).tutorial).toBeUndefined();
  });

  it('progress survives a save round trip', () => {
    const kit = kitWithTutorial();
    const session = kit.newSession('alice');
    session.handleTutorialEvent({ type: 'battleWon' });
    const restored = kit.roundTrip(session);
    expect(restored.toSaveData().tutorial?.count).toBe(1);
    expect(restored.getState([]).tutorial?.step?.id).toBe('fight');
  });

  it('skip unlocks everything', () => {
    const session = kitWithTutorial().newSession('alice');
    session.handleTutorialSkip();
    expect(session.getState([]).tutorial).toBeUndefined();
  });

  it('is never gated when the world has no tutorial steps', () => {
    expect(kitWithTutorial([]).newSession('alice').getState([]).tutorial).toBeUndefined();
  });

  it('only counts a room as travelled to once the party has moved', () => {
    const session = kitWithTutorial().newSession('alice');
    session.handleTutorialSkip();
    const fresh = kitWithTutorial().newSession('bob');
    for (let i = 0; i < 3; i++) fresh.handleTutorialEvent({ type: 'battleWon' });
    fresh.handleTutorialEvent({ type: 'equipItem' });
    fresh.noteTutorialRoom('tile-start');
    expect(fresh.getState([]).tutorial?.step?.id).toBe('explore');
    fresh.noteTutorialRoom('tile-other');
    expect(fresh.getState([]).tutorial?.step?.id).toBe('quests');
  });
});
