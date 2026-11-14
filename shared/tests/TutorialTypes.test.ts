import { describe, it, expect } from 'vitest';
import {
  SEED_TUTORIAL_STEPS,
  newTutorialProgress,
  restoreTutorialProgress,
  currentTutorialStep,
  lockedTutorialFeatures,
  buildClientTutorialState,
  advanceTutorial,
  skipTutorial,
  validateTutorialStep,
} from '../src/systems/TutorialTypes';
import type { TutorialStepDefinition } from '../src/systems/TutorialTypes';

const steps = SEED_TUTORIAL_STEPS;

describe('trigger evaluation', () => {
  it('winBattles counts only battle wins toward the current step', () => {
    const p = newTutorialProgress();
    expect(advanceTutorial(steps, p, { type: 'battleWon' })).toBeNull();
    expect(advanceTutorial(steps, p, { type: 'equipItem' })).toBeNull();
    expect(advanceTutorial(steps, p, { type: 'battleWon' })).toBeNull();
    expect(advanceTutorial(steps, p, { type: 'battleWon' })?.id).toBe('fight');
    expect(p.count).toBe(0);
    expect(currentTutorialStep(steps, p)?.id).toBe('gear');
  });

  it('does not bank battle wins for later steps', () => {
    const p = newTutorialProgress();
    p.completedStepIds = ['fight'];
    advanceTutorial(steps, p, { type: 'battleWon' });
    expect(p.count).toBe(0);
  });

  it('only the current step can complete', () => {
    const p = newTutorialProgress();
    expect(advanceTutorial(steps, p, { type: 'openScreen', screen: 'quests' })).toBeNull();
    expect(p.completedStepIds).toEqual([]);
  });

  const single = (trigger: TutorialStepDefinition['trigger']): TutorialStepDefinition[] =>
    [{ id: 's', order: 1, title: 't', body: 'b', trigger }];

  it('enterRoom without tileId needs a move; with tileId needs that room', () => {
    expect(advanceTutorial(single({ type: 'enterRoom' }), newTutorialProgress(), { type: 'enterRoom', tileId: 'a', moved: false })).toBeNull();
    expect(advanceTutorial(single({ type: 'enterRoom' }), newTutorialProgress(), { type: 'enterRoom', tileId: 'a', moved: true })).not.toBeNull();
    expect(advanceTutorial(single({ type: 'enterRoom', tileId: 'x' }), newTutorialProgress(), { type: 'enterRoom', tileId: 'a', moved: true })).toBeNull();
    expect(advanceTutorial(single({ type: 'enterRoom', tileId: 'x' }), newTutorialProgress(), { type: 'enterRoom', tileId: 'x', moved: false })).not.toBeNull();
  });

  it('completeQuest matches the quest id; openScreen matches the screen', () => {
    expect(advanceTutorial(single({ type: 'completeQuest', questId: 'q1' }), newTutorialProgress(), { type: 'questCompleted', questId: 'q2' })).toBeNull();
    expect(advanceTutorial(single({ type: 'completeQuest', questId: 'q1' }), newTutorialProgress(), { type: 'questCompleted', questId: 'q1' })).not.toBeNull();
    expect(advanceTutorial(single({ type: 'openScreen', screen: 'map' }), newTutorialProgress(), { type: 'openScreen', screen: 'craft' })).toBeNull();
    expect(advanceTutorial(single({ type: 'openScreen', screen: 'map' }), newTutorialProgress(), { type: 'openScreen', screen: 'map' })).not.toBeNull();
  });

  it('finishing the last step marks the tutorial done', () => {
    const p = newTutorialProgress();
    advanceTutorial(single({ type: 'equipItem' }), p, { type: 'equipItem' });
    expect(p.done).toBe(true);
  });
});

describe('unlock logic', () => {
  it('locks every gated tab at the start and releases them as steps complete', () => {
    const p = newTutorialProgress();
    expect(lockedTutorialFeatures(steps, p)).toEqual(['items', 'map', 'craft', 'quests', 'social', 'chat']);
    for (let i = 0; i < 3; i++) advanceTutorial(steps, p, { type: 'battleWon' });
    expect(lockedTutorialFeatures(steps, p)).not.toContain('items');
    expect(lockedTutorialFeatures(steps, p)).toContain('map');
  });

  it('skipping unlocks everything and hides the step', () => {
    const p = newTutorialProgress();
    skipTutorial(p);
    expect(lockedTutorialFeatures(steps, p)).toEqual([]);
    expect(buildClientTutorialState(steps, p)).toBeUndefined();
  });

  it('gates nothing when the content has no steps', () => {
    const p = newTutorialProgress();
    expect(lockedTutorialFeatures([], p)).toEqual([]);
    expect(buildClientTutorialState([], p)).toBeUndefined();
  });

  it('never gates a tab no step unlocks', () => {
    const only: TutorialStepDefinition[] = [{ id: 'a', order: 1, title: 't', body: 'b', trigger: { type: 'equipItem' }, unlocks: ['map'] }];
    expect(lockedTutorialFeatures(only, newTutorialProgress())).toEqual(['map']);
  });

  it('a step added after progress was saved still gates only what it unlocks', () => {
    const p = newTutorialProgress();
    p.completedStepIds = steps.map(s => s.id);
    p.done = true;
    expect(lockedTutorialFeatures(steps, p)).toEqual([]);
  });
});

describe('legacy save migration', () => {
  it('a save with no tutorial field is completed with nothing locked', () => {
    const p = restoreTutorialProgress(undefined);
    expect(p.done).toBe(true);
    expect(lockedTutorialFeatures(steps, p)).toEqual([]);
    expect(currentTutorialStep(steps, p)).toBeNull();
  });

  it('restores saved progress without sharing the array', () => {
    const saved = { completedStepIds: ['fight'], done: false, count: 0 };
    const p = restoreTutorialProgress(saved);
    p.completedStepIds.push('gear');
    expect(saved.completedStepIds).toEqual(['fight']);
  });
});

describe('validateTutorialStep', () => {
  it('accepts every seed step', () => {
    for (const s of SEED_TUTORIAL_STEPS) expect(validateTutorialStep(s)).toBeNull();
  });

  it('rejects bad triggers and unlocks', () => {
    const base = SEED_TUTORIAL_STEPS[0];
    expect(validateTutorialStep({ ...base, trigger: { type: 'winBattles', count: 0 } })).toMatch(/count/);
    expect(validateTutorialStep({ ...base, trigger: { type: 'openScreen', screen: 'combat' as never } })).toMatch(/screen/);
    expect(validateTutorialStep({ ...base, trigger: { type: 'nope' } as never })).toMatch(/Unknown trigger/);
    expect(validateTutorialStep({ ...base, unlocks: ['bogus' as never] })).toMatch(/unlocks/);
    expect(validateTutorialStep({ ...base, title: ' ' })).toMatch(/title/);
  });
});
