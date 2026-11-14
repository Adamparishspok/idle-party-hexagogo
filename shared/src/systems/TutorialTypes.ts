/** Nav tabs a tutorial step can unlock. Combat is never gated. See docs/architecture/tutorial.md. */
export const TUTORIAL_FEATURES = ['items', 'map', 'craft', 'quests', 'social', 'chat'] as const;
export type TutorialFeature = typeof TUTORIAL_FEATURES[number];

export type TutorialTrigger =
  | { type: 'winBattles'; count: number }
  | { type: 'equipItem' }
  /** With `tileId`: standing in that room. Without: arriving in a different room than before. */
  | { type: 'enterRoom'; tileId?: string }
  | { type: 'completeQuest'; questId: string }
  | { type: 'openScreen'; screen: TutorialFeature };

export type TutorialEvent =
  | { type: 'battleWon' }
  | { type: 'equipItem' }
  | { type: 'enterRoom'; tileId: string; moved: boolean }
  | { type: 'questCompleted'; questId: string }
  | { type: 'openScreen'; screen: string };

export interface TutorialStepDefinition {
  id: string;
  /** Steps run in ascending order. */
  order: number;
  title: string;
  body: string;
  trigger: TutorialTrigger;
  unlocks?: TutorialFeature[];
}

export interface TutorialProgress {
  completedStepIds: string[];
  /** Skipped or finished: nothing is gated and no step shows. */
  done: boolean;
  /** Progress toward the current step's `winBattles` count. */
  count: number;
}

/** What the client needs: the step to show and the tabs to hide. */
export interface ClientTutorialState {
  step: TutorialStepDefinition | null;
  count: number;
  locked: TutorialFeature[];
}

export const TUTORIAL_TRIGGER_TYPES = ['winBattles', 'equipItem', 'enterRoom', 'completeQuest', 'openScreen'] as const;

export function newTutorialProgress(): TutorialProgress {
  return { completedStepIds: [], done: false, count: 0 };
}

/** keep-legacy: a save without tutorial progress belongs to an existing player, who keeps everything. */
export function restoreTutorialProgress(saved: TutorialProgress | undefined): TutorialProgress {
  if (!saved) return { completedStepIds: [], done: true, count: 0 };
  return { completedStepIds: [...saved.completedStepIds], done: saved.done, count: saved.count };
}

export function orderedTutorialSteps(steps: readonly TutorialStepDefinition[]): TutorialStepDefinition[] {
  return [...steps].sort((a, b) => a.order - b.order);
}

export function currentTutorialStep(
  steps: readonly TutorialStepDefinition[],
  progress: TutorialProgress,
): TutorialStepDefinition | null {
  if (progress.done) return null;
  return orderedTutorialSteps(steps).find(s => !progress.completedStepIds.includes(s.id)) ?? null;
}

/** Features some step unlocks that this player has not unlocked yet. No steps, or done: nothing locked. */
export function lockedTutorialFeatures(
  steps: readonly TutorialStepDefinition[],
  progress: TutorialProgress,
): TutorialFeature[] {
  if (progress.done) return [];
  const unlocked = new Set<TutorialFeature>();
  for (const s of steps) {
    if (progress.completedStepIds.includes(s.id)) for (const f of s.unlocks ?? []) unlocked.add(f);
  }
  const gated = new Set<TutorialFeature>();
  for (const s of steps) for (const f of s.unlocks ?? []) gated.add(f);
  return TUTORIAL_FEATURES.filter(f => gated.has(f) && !unlocked.has(f));
}

export function buildClientTutorialState(
  steps: readonly TutorialStepDefinition[],
  progress: TutorialProgress,
): ClientTutorialState | undefined {
  const step = currentTutorialStep(steps, progress);
  const locked = lockedTutorialFeatures(steps, progress);
  if (!step && locked.length === 0) return undefined;
  return { step, count: progress.count, locked };
}

function triggerMet(step: TutorialStepDefinition, event: TutorialEvent, count: number): boolean {
  const t = step.trigger;
  switch (t.type) {
    case 'winBattles': return event.type === 'battleWon' && count >= t.count;
    case 'equipItem': return event.type === 'equipItem';
    case 'enterRoom':
      return event.type === 'enterRoom' && (t.tileId ? event.tileId === t.tileId : event.moved);
    case 'completeQuest': return event.type === 'questCompleted' && event.questId === t.questId;
    case 'openScreen': return event.type === 'openScreen' && event.screen === t.screen;
    default: return false;
  }
}

/** Applies one event to the current step. Returns the step it completed, if any; mutates `progress`. */
export function advanceTutorial(
  steps: readonly TutorialStepDefinition[],
  progress: TutorialProgress,
  event: TutorialEvent,
): TutorialStepDefinition | null {
  const step = currentTutorialStep(steps, progress);
  if (!step) return null;
  if (event.type === 'battleWon' && step.trigger.type === 'winBattles') progress.count++;
  if (!triggerMet(step, event, progress.count)) return null;
  progress.completedStepIds.push(step.id);
  progress.count = 0;
  if (!currentTutorialStep(steps, progress)) progress.done = true;
  return step;
}

export function skipTutorial(progress: TutorialProgress): void {
  progress.done = true;
  progress.count = 0;
}

export function validateTutorialStep(step: Partial<TutorialStepDefinition>): string | null {
  if (typeof step.id !== 'string' || !step.id) return 'Tutorial step needs an id.';
  if (typeof step.order !== 'number' || !Number.isFinite(step.order)) return 'Tutorial step needs a numeric order.';
  if (typeof step.title !== 'string' || !step.title.trim()) return 'Tutorial step needs a title.';
  if (typeof step.body !== 'string' || !step.body.trim()) return 'Tutorial step needs a body.';
  const t = step.trigger;
  if (!t || typeof t !== 'object') return 'Tutorial step needs a trigger.';
  switch (t.type) {
    case 'winBattles':
      if (!Number.isInteger(t.count) || t.count < 1) return 'winBattles count must be a whole number, 1 or more.';
      break;
    case 'equipItem': break;
    case 'enterRoom':
      if (t.tileId !== undefined && (typeof t.tileId !== 'string' || !t.tileId)) return 'enterRoom tileId must be a non-empty string when set.';
      break;
    case 'completeQuest':
      if (typeof t.questId !== 'string' || !t.questId) return 'completeQuest needs a questId.';
      break;
    case 'openScreen':
      if (!(TUTORIAL_FEATURES as readonly string[]).includes(t.screen)) return `openScreen screen must be one of: ${TUTORIAL_FEATURES.join(', ')}.`;
      break;
    default: return `Unknown trigger type. Use one of: ${TUTORIAL_TRIGGER_TYPES.join(', ')}.`;
  }
  const unlocks = step.unlocks ?? [];
  if (!Array.isArray(unlocks) || unlocks.some(f => !(TUTORIAL_FEATURES as readonly string[]).includes(f))) {
    return `Tutorial unlocks must be from: ${TUTORIAL_FEATURES.join(', ')}.`;
  }
  return null;
}

export const SEED_TUTORIAL_STEPS: TutorialStepDefinition[] = [
  { id: 'fight', order: 1, title: 'Your party fights on its own', body: 'Win 3 battles to get started.', trigger: { type: 'winBattles', count: 3 }, unlocks: ['items'] },
  { id: 'gear', order: 2, title: 'Gear up', body: 'Open Character and equip an item from your bag.', trigger: { type: 'equipItem' }, unlocks: ['map'] },
  { id: 'explore', order: 3, title: 'Explore', body: 'Open the Map and tap a nearby room to travel there.', trigger: { type: 'enterRoom' }, unlocks: ['quests'] },
  { id: 'quests', order: 4, title: 'Quests', body: 'People you meet offer quests. Open your quest log.', trigger: { type: 'openScreen', screen: 'quests' }, unlocks: ['craft'] },
  { id: 'craft', order: 5, title: 'Crafting', body: 'Turn materials into gear. Open Craft.', trigger: { type: 'openScreen', screen: 'craft' }, unlocks: ['social', 'chat'] },
  { id: 'social', order: 6, title: 'Find a party', body: 'You are strong together. Open Social to find friends.', trigger: { type: 'openScreen', screen: 'social' } },
];
