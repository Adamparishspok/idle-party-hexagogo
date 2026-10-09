import type { GameClient } from '../network/GameClient';
import type { DungeonDefinition } from '@idle-party-rpg/shared';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { renderKitItem } from './KitItem';
import '../styles/screens/map.css';

const ICON_KEY = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M11.5 11.5 20 20M16 16l2.5-2.5M18.5 18.5 21 16" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/></svg>';

/**
 * Confirmation popup shown when a player taps "Enter {dungeon}" in the room
 * view: a parchment modal with the dungeon's flavor, floor count, entry
 * requirements (a required key item shows as an item frame), and the
 * defeat warning. Entry is server-authoritative — if requirements aren't
 * met, the server replies with an error toast.
 */
export class DungeonEntryPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'gc-modal dg-modal';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    wireFocusOnInteract(this.overlay);
    document.body.appendChild(this.overlay);
  }

  show(dungeon: DungeonDefinition, col: number, row: number): void {
    const floors = dungeon.floors.length;
    const description = dungeon.description?.trim();
    const descHtml = description
      ? `<p class="dg-modal__desc">"${this.escape(description)}"</p>`
      : '';

    this.overlay.innerHTML = `
      <div class="gc-modal__panel gc-parchment dg-modal__panel" role="dialog" aria-modal="true" aria-label="${this.escape(dungeon.name)}">
        <div class="gc-modal__portrait dg-modal__emblem" aria-hidden="true">${ICON_KEY}</div>
        <div class="gc-title-tab gc-modal__title dg-modal__title"><span class="gc-title-tab__text">${this.escape(dungeon.name)}</span></div>
        <button type="button" class="gc-close gc-modal__close" aria-label="Close"></button>
        <div class="gc-modal__body dg-modal__body">
          ${descHtml}
          <div class="dg-modal__floors">
            <span class="dg-modal__floors-num">${floors}</span>
            <span class="dg-modal__floors-label">floor${floors === 1 ? '' : 's'}<br />clear the last to win</span>
          </div>
          ${this.renderRequirements(dungeon)}
          <p class="dg-modal__warning">If your party is defeated, you'll be sent back to this entrance.</p>
        </div>
        <div class="gc-modal__actions">
          <button type="button" class="gc-btn dg-modal__cancel">Cancel</button>
          <button type="button" class="gc-btn gc-btn--gold gc-btn--lg dg-modal__enter">Enter</button>
        </div>
      </div>
    `;

    this.overlay.querySelector('.gc-modal__close')?.addEventListener('click', () => this.hide());
    this.overlay.querySelector('.dg-modal__cancel')?.addEventListener('click', () => this.hide());
    this.overlay.querySelector('.dg-modal__enter')?.addEventListener('click', () => {
      this.gameClient.sendEnterDungeon(col, row, dungeon.id);
      this.hide();
    });

    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);
    (this.overlay.querySelector('.dg-modal__enter') as HTMLElement).focus({ preventScroll: true });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    release(this.overlay);
  }

  /** Requirement rows (level, party size, classes) plus the key item frame. */
  private renderRequirements(dungeon: DungeonDefinition): string {
    const req = dungeon.entryRequirements;
    if (!req) return '';
    const lines: string[] = [];

    if (req.minLevel !== undefined && req.maxLevel !== undefined) {
      lines.push(`Level ${req.minLevel}–${req.maxLevel}`);
    } else if (req.minLevel !== undefined) {
      lines.push(`Level ${req.minLevel}+`);
    } else if (req.maxLevel !== undefined) {
      lines.push(`Level ${req.maxLevel} or below`);
    }

    if (req.minPartySize !== undefined && req.maxPartySize !== undefined) {
      lines.push(`Party of ${req.minPartySize}–${req.maxPartySize}`);
    } else if (req.minPartySize !== undefined) {
      lines.push(`At least ${req.minPartySize} party member${req.minPartySize === 1 ? '' : 's'}`);
    } else if (req.maxPartySize !== undefined) {
      lines.push(`At most ${req.maxPartySize} party member${req.maxPartySize === 1 ? '' : 's'}`);
    }

    if (req.requiredClasses && req.requiredClasses.length > 0) {
      lines.push(`Classes: ${req.requiredClasses.join(', ')}`);
    }

    let itemHtml = '';
    if (req.requiredItemId) {
      const def = this.gameClient.lastState?.itemDefinitions?.[req.requiredItemId];
      const itemName = def?.name ?? 'a key item';
      itemHtml = `
        <div class="dg-modal__key">
          ${renderKitItem(req.requiredItemId, def, { size: 'sm' })}
          <div class="dg-modal__key-text">
            <span class="dg-modal__key-name">${this.escape(itemName)}</span>
            <span class="dg-modal__key-rule">${req.consumeRequiredItem ? 'Each member spends one to enter' : 'Each member must carry one'}</span>
          </div>
        </div>`;
    }

    if (lines.length === 0 && !itemHtml) return '';
    return `
      <div class="gc-divider dg-modal__divider">Requirements</div>
      ${lines.length > 0 ? `<ul class="dg-modal__reqs">${lines.map(l => `<li>${this.escape(l)}</li>`).join('')}</ul>` : ''}
      ${itemHtml}
    `;
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
