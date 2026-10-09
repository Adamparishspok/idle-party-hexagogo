import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCraftingState, ServerStateMessage } from '@idle-party-rpg/shared';
import { CraftingScreen } from '../src/screens/CraftingScreen';
import type { GameClient } from '../src/network/GameClient';

function craftState(overrides: Partial<ClientCraftingState> = {}): ClientCraftingState {
  return {
    unlocked: true,
    unlockLevel: 20,
    skillName: 'Smithing',
    skillLevel: 3,
    skillXp: 40,
    skillXpForNext: 100,
    recipes: [
      {
        id: 'r_sword',
        name: 'Iron <Sword>',
        requiredLevel: 1,
        durationSeconds: 90,
        xpReward: 10,
        ingredients: [
          { itemId: 'iron_ore', quantity: 3 },
          { itemId: 'oak_log', quantity: 1 },
        ],
        result: { itemId: 'iron_sword', quantity: 1 },
      },
    ],
    queue: { activeStartedAtMs: null, jobs: [] },
    activeProgress: null,
    itemDefs: {
      iron_ore: { id: 'iron_ore', name: 'Iron Ore', rarity: 'common' },
      oak_log: { id: 'oak_log', name: 'Oak Log', rarity: 'common' },
      iron_sword: { id: 'iron_sword', name: 'Iron Sword', rarity: 'uncommon' },
    },
    ...overrides,
  };
}

function makeState(crafting: ClientCraftingState | undefined, inventory: Record<string, number>): ServerStateMessage {
  return {
    crafting,
    itemDefinitions: {},
    character: { className: 'Knight', level: 25, inventory },
  } as unknown as ServerStateMessage;
}

function makeClient(state: ServerStateMessage) {
  let listener: ((s: ServerStateMessage) => void) | null = null;
  const client = {
    lastState: state,
    subscribe: (fn: (s: ServerStateMessage) => void) => {
      listener = fn;
      return () => { listener = null; };
    },
    sendCraftQueue: vi.fn(),
    sendCraftCancel: vi.fn(),
  };
  return { client, push: (s: ServerStateMessage) => listener?.(s) };
}

describe('CraftingScreen', () => {
  let screen: CraftingScreen | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="screen-craft" class="screen"></div>';
  });

  afterEach(() => {
    screen?.onDeactivate();
    screen = null;
    document.body.innerHTML = '';
  });

  function mount(state: ServerStateMessage) {
    const { client, push } = makeClient(state);
    screen = new CraftingScreen('screen-craft', client as unknown as GameClient);
    screen.onActivate();
    return { client, push };
  }

  it('renders the craft level header and escapes recipe names', () => {
    mount(makeState(craftState(), { iron_ore: 3, oak_log: 1 }));
    const root = document.getElementById('screen-craft')!;
    expect(root.querySelector('.cr-level__num')?.textContent).toBe('3');
    expect(root.querySelector('.cr-header .gc-bar__text')?.textContent).toBe('40 / 100 XP');
    expect(root.querySelector('.cr-recipe__name')?.textContent).toBe('Iron <Sword>');
    expect(root.innerHTML).not.toContain('<Sword>');
  });

  it('marks ingredient chips have/need and shows a friendly idle queue', () => {
    mount(makeState(craftState(), { iron_ore: 1, oak_log: 1 }));
    const chips = [...document.querySelectorAll('.cr-chip')];
    expect(chips.map(c => c.className)).toEqual(['cr-chip is-short', 'cr-chip is-ok']);
    expect(chips[0].querySelector('.cr-chip__count')?.textContent).toBe('1/3');
    expect(document.querySelector('.cr-recipe .cr-status')?.textContent).toBe('Need items');
    expect(document.querySelector('.cr-idle__title')?.textContent).toContain('idle');
  });

  it('opens the detail modal and crafts from it', () => {
    const { client } = mount(makeState(craftState(), { iron_ore: 3, oak_log: 1 }));
    (document.querySelector('.cr-recipe') as HTMLButtonElement).click();
    const craft = document.querySelector('.cr-modal__craft') as HTMLButtonElement;
    expect(craft).not.toBeNull();
    expect(craft.disabled).toBe(false);
    craft.click();
    expect(client.sendCraftQueue).toHaveBeenCalledWith('r_sword');
    // Modal stays open so the recipe can be queued again.
    expect(document.querySelector('.cr-modal')).not.toBeNull();
  });

  it('disables Craft and says exactly what is missing', () => {
    const { push } = mount(makeState(craftState(), { iron_ore: 3, oak_log: 1 }));
    (document.querySelector('.cr-recipe') as HTMLButtonElement).click();
    push(makeState(craftState(), { iron_ore: 1 }));
    const craft = document.querySelector('.cr-modal__craft') as HTMLButtonElement;
    expect(craft.disabled).toBe(true);
    expect(document.querySelector('.cr-modal__why')?.textContent).toBe('Still need 2 Iron Ore, 1 Oak Log.');
  });

  it('cancels a queued job by index', () => {
    const now = Date.now();
    const { client } = mount(makeState(craftState({
      queue: { activeStartedAtMs: now, jobs: [{ recipeId: 'r_sword' }, { recipeId: 'r_sword' }] },
      activeProgress: { recipeId: 'r_sword', startedAtMs: now, durationMs: 90000, elapsedMs: 0, remainingMs: 90000 },
    }), {}));
    expect(document.querySelectorAll('.cr-job').length).toBe(2);
    expect(document.querySelector('.cr-job--active')).not.toBeNull();
    (document.querySelectorAll('[data-cancel-index]')[1] as HTMLButtonElement).click();
    expect(client.sendCraftCancel).toHaveBeenCalledWith(1);
  });

  it('shows the locked state below the unlock level', () => {
    mount(makeState(craftState({ unlocked: false }), {}));
    expect(document.querySelector('.cr-message')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('.cr-message h2')?.textContent).toBe('Workshop Locked');
  });
});
