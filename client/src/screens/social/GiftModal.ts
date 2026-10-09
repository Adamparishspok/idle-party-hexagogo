import type { ServerStateMessage, TradeOfferItem } from '@idle-party-rpg/shared';
import { listUnequippedEntries } from '@idle-party-rpg/shared';
import type { GameClient } from '../../network/GameClient';
import type { WorldCache } from '../../network/WorldCache';
import { esc, portraitHtml } from './socialHtml';
import { openSocModal, setHtmlKeepScroll } from './socialModal';
import type { SocModal } from './socialModal';
import { applyStep, offerSideHtml, pickerHtml } from './itemPicker';
import type { PickerCtx } from './itemPicker';

/**
 * "Send gift" dialog. Each picked stack is sent as its own gift so the
 * recipient's mailbox gets separate entries (they accept or decline each;
 * declined gifts come back to the sender's mailbox).
 */
export class GiftModal {
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private getState: () => ServerStateMessage | null;
  private getClassName: (username: string) => string | undefined;

  private modal: SocModal | null = null;
  private target: string | null = null;
  private selected = new Map<string, number>();

  constructor(
    gameClient: GameClient,
    worldCache: WorldCache,
    getState: () => ServerStateMessage | null,
    getClassName: (username: string) => string | undefined,
  ) {
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.getState = getState;
    this.getClassName = getClassName;
  }

  open(targetUsername: string): void {
    this.modal?.close();
    this.target = targetUsername;
    this.selected = new Map();
    const modal = openSocModal({
      title: `Gift for ${targetUsername}`,
      variant: 'gift',
      onClose: () => {
        if (this.modal !== modal) return;
        this.modal = null;
        this.target = null;
        this.selected = new Map();
      },
    });
    this.modal = modal;
    modal.root.addEventListener('click', (e) => this.onClick(e));
    this.render();
  }

  dismiss(): void {
    this.modal?.close();
  }

  private render(): void {
    const modal = this.modal;
    if (!modal) return;
    const state = this.getState();
    const inventory = state?.character?.inventory ?? {};
    const ctx: PickerCtx = {
      itemDefs: state?.itemDefinitions ?? {},
      skillDefs: this.worldCache.getSkillContent().skills,
    };
    const target = this.target ?? '';
    const ids = listUnequippedEntries(inventory).map(([id]) => id);
    const sel: TradeOfferItem[] = Array.from(this.selected.entries()).map(([itemId, quantity]) => ({ itemId, quantity }));

    setHtmlKeepScroll(modal.body, `
      <div class="soc-trade-head">
        ${portraitHtml({ name: target, className: this.getClassName(target), size: 'md' })}
        <p class="soc-status soc-status--act">Gifts land in ${esc(target)}'s mailbox. If they decline, it comes back to yours.</p>
      </div>
      ${offerSideHtml('You will gift', sel, ctx, 'Pick items below')}
      <div class="gc-divider soc-divider">Your bag</div>
      ${pickerHtml(ids, inventory, this.selected, ctx, 'gift', 'Nothing to gift — only unequipped items can be sent.')}
    `);
    modal.footer.innerHTML = `
      <button type="button" class="gc-btn gc-btn--gold gc-btn--lg gc-btn--block" data-action="gift-send"${sel.length ? '' : ' disabled'}>Send Gift</button>
    `;
  }

  private onClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!btn || btn.disabled) return;
    if (btn.getAttribute('data-action') === 'gift-send') {
      if (!this.target) return;
      for (const [itemId, quantity] of this.selected) {
        this.gameClient.sendGift(this.target, itemId, quantity);
      }
      this.dismiss();
      return;
    }
    const inventory = this.getState()?.character?.inventory ?? {};
    if (applyStep(btn, 'gift', this.selected, inventory)) this.render();
  }
}
