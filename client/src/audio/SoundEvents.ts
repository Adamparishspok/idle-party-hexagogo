import type { SfxId, ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { sound } from './SoundManager';
import type { SoundManager } from './SoundManager';

/**
 * Central wiring for sounds that aren't owned by one screen.
 *
 * Kept in one place on purpose: per-button or per-reward sound calls scattered
 * across the UI would drift (some buttons click, some don't) and would each
 * need their own "don't fire on initial load" guard. Instead:
 *
 * - `installUiSounds` — one delegated listener for every press, which also
 *   unlocks the AudioContext on the first gesture (iOS requirement).
 * - `wireGameSounds` — one GameClient subscriber that diffs consecutive
 *   states for level-ups, gold, loot, equips and finished crafts, plus the
 *   chat/notification/error message streams.
 *
 * Owned elsewhere: modal open/close (ModalStack), bottom-nav switches
 * (BottomNav), combat hits/victory/defeat (CombatScreen).
 */

/** Presses that make the generic tap sound. */
const TAP_SELECTOR = [
  '.gc-btn',
  '.gc-tab',
  '.gc-row',
  '.gc-item',
  '.gc-switch-row',
  'button',
  '[role="button"]',
  '[role="tab"]',
  'input[type="checkbox"]',
].join(', ');

/**
 * Presses that stay silent here because something else voices them: nav tabs
 * (BottomNav's tab-switch), close buttons (ModalStack's ui-close), and anything
 * explicitly opted out with `data-sfx="none"`.
 */
const TAP_EXCLUDE = '.nav-tab, .nav-submenu-item, .gc-close, .gc-modal__close, [data-sfx="none"]';

/**
 * Pick the sound for a press on `target`, or null for none. An element (or
 * ancestor) can name a specific sound with `data-sfx="<id>"`.
 */
export function tapSoundFor(target: Element | null): SfxId | 'none' | null {
  if (!target) return null;
  const hit = target.closest(TAP_SELECTOR);
  if (!hit) return null;
  if (hit.closest(TAP_EXCLUDE)) return 'none';
  if ((hit as HTMLButtonElement).disabled || hit.getAttribute('aria-disabled') === 'true') return 'none';
  const override = hit.closest<HTMLElement>('[data-sfx]')?.dataset.sfx;
  return (override as SfxId | undefined) ?? 'ui-tap';
}

/** Install the global gesture-unlock + tap listener. Call once at startup. */
export function installUiSounds(root: Document = document, mgr: SoundManager = sound): void {
  // Several event types because iOS only counts some of them as activation
  // for audio (touchend/click), while pointerdown gives the snappiest tap.
  const unlock = () => mgr.unlock();
  for (const type of ['touchend', 'click', 'keydown'] as const) {
    root.addEventListener(type, unlock, { capture: true, passive: true });
  }
  root.addEventListener('pointerdown', (e) => {
    mgr.unlock();
    // Only primary presses — a right-click or second finger isn't a tap.
    if (e.button !== 0 || !e.isPrimary) return;
    const id = tapSoundFor(e.target as Element | null);
    if (id && id !== 'none') mgr.play(id);
  }, { capture: true, passive: true });
}

/** The slice of character state the reward diff looks at. */
export interface RewardSnapshot {
  level: number;
  gold: number;
  /** Total item count across the inventory stacks. */
  items: number;
  /** Stable signature of what's equipped in each slot. */
  equipment: string;
  craftLevel: number;
  craftXp: number;
}

export function rewardSnapshot(state: ServerStateMessage): RewardSnapshot | null {
  const c = state.character;
  if (!c) return null;
  return {
    level: c.level,
    gold: c.gold,
    items: Object.values(c.inventory ?? {}).reduce((sum, n) => sum + n, 0),
    equipment: Object.keys(c.equipment ?? {}).sort().map(slot => `${slot}=${c.equipment[slot] ?? ''}`).join('|'),
    craftLevel: c.craftLevel ?? 0,
    craftXp: c.craftXp ?? 0,
  };
}

/**
 * The single most important reward between two consecutive states, or null.
 * One sound per state change: several rewards often land in the same tick
 * (a victory gives gold and loot and maybe a level), and stacking jingles
 * sounds like noise, so the rarest/biggest one wins.
 */
export function rewardSoundFor(prev: RewardSnapshot, next: RewardSnapshot): SfxId | null {
  if (next.level > prev.level) return 'level-up';
  // Craft XP only moves when a craft finishes; it may roll over on a craft
  // level-up, so compare the (level, xp) pair.
  if (next.craftLevel > prev.craftLevel || (next.craftLevel === prev.craftLevel && next.craftXp > prev.craftXp)) {
    return 'craft-complete';
  }
  // Equipping moves an item out of the bag, so check it before the item count.
  if (next.equipment !== prev.equipment) return 'equip';
  // Buying also adds an item but costs gold — that's a purchase, already
  // voiced by the button tap, not a loot drop.
  if (next.items > prev.items && next.gold >= prev.gold) return 'loot';
  if (next.gold > prev.gold) return 'coin';
  return null;
}

/**
 * Per-sound loudness for rewards. Idle combat pays out every few seconds on
 * every screen, so the routine ones sit well below the special ones.
 */
const REWARD_VOLUME: Partial<Record<SfxId, number>> = {
  coin: 0.5,
  loot: 0.7,
};

/** Subscribe the reward/chat/notification/error sounds to a GameClient. */
export function wireGameSounds(gameClient: GameClient, mgr: SoundManager = sound): void {
  let prev: RewardSnapshot | null = null;

  gameClient.subscribe((state) => {
    const next = rewardSnapshot(state);
    // `isInitialState` is true for the first state after connect, reconnect,
    // or a tab resume — everything in it may have happened while we weren't
    // looking, so it only resets the baseline.
    if (next && prev && !gameClient.isInitialState) {
      const id = rewardSoundFor(prev, next);
      if (id) mgr.play(id, { volume: REWARD_VOLUME[id] ?? 1 });
    }
    prev = next;
  });

  // Live chat only — the history backlog arrives via sync_chat, not here.
  gameClient.onChat((msg) => {
    if (msg.senderUsername === gameClient.lastState?.username) return;
    mgr.play('chat-message');
  });

  gameClient.onNotification(() => mgr.play('notification'));

  const onError = () => mgr.play('error');
  gameClient.onServerError(onError);
  gameClient.onEquipBlocked(onError);
  gameClient.onMoveBlocked(onError);
}
