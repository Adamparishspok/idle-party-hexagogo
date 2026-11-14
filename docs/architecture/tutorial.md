# New-player tutorial

Ordered steps stored as content (`TutorialStepDefinition`, `shared/src/systems/TutorialTypes.ts`), progress saved per player, nav tabs unlocked step by step.

## Content

- A step has `id`, `order`, `title`, `body`, a `trigger`, and optional `unlocks` (nav tabs: `items`, `map`, `craft`, `quests`, `social`, `chat`; Combat is never gated).
- Triggers: `winBattles {count}`, `equipItem`, `enterRoom {tileId?}` (no `tileId` means arriving in a different room than before), `completeQuest {questId}`, `openScreen {screen}`.
- Stored in `data/tutorial-steps.json`, included in `ContentSnapshot.tutorialSteps` (keep-when-absent in `replaceAll`), the admin REST routes (`/api/admin/tutorial-steps`, `/content`, version content), and MCP (`get_content_schema`, read, and write through the generic `DRAFT_CONTENT_TYPES`). Edited in the World Manager Tutorial tab.
- Fresh worlds seed `SEED_TUTORIAL_STEPS` (6 steps). Existing worlds have no steps until an admin authors some, so nothing is gated.

## Runtime

- `PlayerSession.handleTutorialEvent` feeds `advanceTutorial`; only the current step can complete. Hooks: battle victory, equip (both paths), battle start (room), quest turn-in, and the `tutorial_open_screen` client message sent by the bottom nav while a step is active.
- Progress is `{ completedStepIds, done, count }` in `PlayerSaveData.tutorial`. `count` is the `winBattles` progress for the current step.
- A tab is locked when some step unlocks it and none of the completed steps does. `done` (finished or skipped), or no steps, means nothing is locked.
- **Legacy saves**: `restoreTutorialProgress(undefined)` returns `done: true`, so any save that predates the field keeps every tab. Only sessions created fresh start the tutorial.
- Gating is UI-only: the server does not refuse actions from a hidden tab.
- `ServerStateMessage.tutorial` carries the current step, count and locked tabs, and is absent when there is nothing to show. `tutorial_skip` marks the tutorial done.

## Client

`TutorialPanel` shows the step in a small card above the nav (Hide dismisses that step only; Skip tutorial unlocks everything). `BottomNav.setLockedTabs` hides locked tabs. The coach-mark tour does not auto-start while a tutorial is active.
