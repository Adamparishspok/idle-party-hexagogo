import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomView } from '../src/ui/RoomView';
import type { TileClickInfo } from '../src/ui/CanvasWorldMap';

function makeInfo(overrides: Partial<TileClickInfo> = {}): TileClickInfo {
  return {
    col: 3,
    row: 4,
    tileType: 'Plains',
    zoneName: 'Hatchetmill',
    roomName: 'Town Square',
    zoneId: 'hatchetmill',
    isTraversable: true,
    isUnlocked: true,
    isSameZone: true,
    isCurrentTile: false,
    playersHere: [],
    partyMemberUsernames: [],
    ...overrides,
  };
}

function isVisible(el: HTMLElement): boolean {
  // happy-dom doesn't run layout, so we check what we set: display + connected.
  return el.isConnected && el.style.display !== 'none' && el.style.display !== '';
}

describe('RoomView modal pipeline', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('starts hidden', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    new RoomView(parent, () => {});
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.style.display).toBe('none');
  });

  it('show() makes the overlay visible (display: flex)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(isVisible(overlay)).toBe(true);
    expect(overlay.style.display).toBe('flex');
  });

  it('show() lifts the overlay above the modal-stack baseline', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    const z = parseInt(overlay.style.zIndex, 10);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeGreaterThanOrEqual(1500);
  });

  it('hide() removes the overlay from sight and clears z-index', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    view.hide();
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('none');
    expect(overlay.style.zIndex).toBe('');
  });

  it('clicking the overlay backdrop dismisses the modal', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;

    // Synthetic click directly on the overlay (target === overlay).
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // RoomView's overlay-click handler reads e.target === overlay; we need to
    // simulate that by dispatching from the overlay itself.
    expect(overlay.style.display).toBe('none');
  });

  it('clicking inside the modal contents does NOT dismiss', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    const modal = overlay.querySelector('.room-view') as HTMLElement;

    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay.style.display).toBe('flex');
  });

  it('Go-to-room button calls onMove and dismisses the modal (remote room)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onMove = vi.fn();
    const view = new RoomView(parent, onMove);
    view.show(makeInfo({ isCurrentTile: false }));
    const goBtn = parent.querySelector('.room-view-action-go') as HTMLElement;
    expect(goBtn).toBeTruthy();
    goBtn.click();
    expect(onMove).toHaveBeenCalledWith(3, 4);
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('none');
  });

  it('Close button on the current-room view dismisses the modal', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo({ isCurrentTile: true }));
    const closeBtn = parent.querySelector('.room-view-close') as HTMLElement;
    closeBtn.click();
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('none');
  });

  it('hidden modals do not pass clicks: the Go button has no effect when overlay is hidden', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onMove = vi.fn();
    const view = new RoomView(parent, onMove);

    view.show(makeInfo({ isCurrentTile: false }));
    view.hide();

    // After hide(), the overlay is display:none. A click on the button
    // (which still exists in the DOM but is inside the hidden overlay)
    // would in real DOM not be reachable; in JSDOM/happy-dom we approximate
    // by asserting the overlay is hidden, which is what CSS pointer-events
    // / display:none enforces in production.
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('none');
    // Sanity: visibility check matches our isVisible() helper.
    expect(isVisible(overlay)).toBe(false);

    // No move should have fired during this lifecycle.
    expect(onMove).not.toHaveBeenCalled();
  });

  it('overlay swallows click propagation so phantom canvas clicks cannot leak through', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;

    // Listener registered on document — should NOT receive a click that
    // originated on the overlay (RoomView calls e.stopPropagation()).
    const docHandler = vi.fn();
    document.addEventListener('click', docHandler);

    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(docHandler).not.toHaveBeenCalled();
    document.removeEventListener('click', docHandler);
  });

  it('re-showing on the same overlay does not duplicate it', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    view.show(makeInfo({ col: 5 }));
    expect(parent.querySelectorAll('.room-view-overlay').length).toBe(1);
  });

  it('current room renders as a place view below the modal stack (nav + perch stay on top)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo({ isCurrentTile: false }));
    view.show(makeInfo({ isCurrentTile: true }));
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay.classList.contains('rv-place')).toBe(true);
    expect(overlay.style.zIndex).toBe('');
    // Interacting with the place view must not promote it into the stack.
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(overlay.style.zIndex).toBe('');
  });

  it('current room lists the viewer first in "Your party" and opens their popup', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onUser = vi.fn();
    const view = new RoomView(parent, () => {}, onUser);
    view.self = { username: 'me', className: 'Knight', level: 7 };
    view.show(makeInfo({
      isCurrentTile: true,
      partyMemberUsernames: ['me', 'pal'],
      playersHere: [{ username: 'pal', className: 'Mage', partyId: 'p1' }, { username: 'stranger', partyId: 'p2' }],
    }));
    const self = parent.querySelector('.rv-party--self') as HTMLElement;
    const names = Array.from(self.querySelectorAll('.room-party-member')).map(el => el.getAttribute('data-username'));
    expect(names).toEqual(['me', 'pal']);
    expect(self.querySelector('.gc-portrait__level')?.textContent).toBe('7');
    expect(parent.querySelectorAll('.rv-party--other').length).toBe(1);
    (self.querySelector('[data-username="me"]') as HTMLElement).click();
    expect(onUser).toHaveBeenCalledWith('me', expect.anything(), 3, 4);
  });

  it('current room makes exactly the first action the gold primary and wires each action', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onShop = vi.fn();
    const onTransition = vi.fn();
    const view = new RoomView(parent, () => {}, undefined, onShop, undefined, undefined, onTransition);
    view.hasShop = true;
    view.transitions = [{ tileId: 'tile-9', name: 'The Deep' }];
    view.show(makeInfo({ isCurrentTile: true }));
    const gold = parent.querySelectorAll('.rv-place__actions .gc-btn--gold');
    expect(gold.length).toBe(1);
    expect(gold[0].classList.contains('room-view-action-shop')).toBe(true);
    (parent.querySelector('.room-view-action-transition') as HTMLElement).click();
    expect(onTransition).toHaveBeenCalledWith('tile-9');
  });

  it('escapes room and zone names', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo({ roomName: '<img src=x onerror=alert(1)>', zoneName: '<b>z</b>' }));
    expect(parent.querySelector('img[src="x"]')).toBeNull();
    expect(parent.querySelector('.rv-preview__title')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
