import { addBankTab, bankDeposit, bankMove, bankWithdraw, nextBankTabPrice } from '@idle-party-rpg/shared';
import type { BankErrorCode, ClientBankMessage, PlayerBank } from '@idle-party-rpg/shared';
import type { PlayerSession } from '../PlayerSession.js';

export interface BankRefusal {
  code: BankErrorCode;
  message: string;
}

export const BANK_MESSAGE_TYPES: ReadonlySet<string> = new Set<ClientBankMessage['type']>([
  'bank_deposit', 'bank_withdraw', 'bank_move', 'bank_buy_tab',
]);

export const BANK_ERROR_MESSAGES: Record<BankErrorCode, string> = {
  bank_not_here: 'You need to be in a banker\'s room to use your bank.',
  bank_invalid_request: 'Invalid bank request.',
  bank_item_missing: "You don't have that many.",
  bank_tab_full: 'That bank tab is full.',
  bank_bag_full: 'Your backpack is full.',
  bank_cannot_afford: 'Not enough gold.',
  bank_max_tabs: 'You already own every bank tab.',
};

type BankSession = Pick<PlayerSession,
  | 'isInBankerRoom' | 'getBank' | 'getInventoryForUpdate' | 'getInventoryCapacity'
  | 'deductGold' | 'addLogEntry'>;

export interface BankDeps {
  getSession(username: string): BankSession | undefined;
  pushState(username: string): void;
}

function refuse(code: BankErrorCode): BankRefusal {
  return { code, message: BANK_ERROR_MESSAGES[code] };
}

/** Bank rules at banker rooms. Every request re-checks the party's room. See docs/architecture/gear-stats-bank.md. */
export class BankService {
  constructor(private deps: BankDeps) {}

  /** Returns the refusal to send the player, or null on success. */
  handle(username: string, msg: ClientBankMessage): BankRefusal | null {
    const session = this.deps.getSession(username);
    if (!session || !session.isInBankerRoom()) return refuse('bank_not_here');
    const refusal = this.apply(session, msg);
    if (!refusal) this.deps.pushState(username);
    return refusal;
  }

  private apply(session: BankSession, msg: ClientBankMessage): BankRefusal | null {
    const bank = session.getBank();
    const inventory = session.getInventoryForUpdate();
    if (!inventory) return refuse('bank_not_here');
    switch (msg.type) {
      case 'bank_deposit': {
        if (typeof msg.itemId !== 'string' || (msg.tab !== undefined && typeof msg.tab !== 'number')) return refuse('bank_invalid_request');
        const result = bankDeposit(bank, inventory, msg.itemId, msg.quantity, msg.tab);
        return result.ok ? null : refuse(result.error);
      }
      case 'bank_withdraw': {
        if (typeof msg.itemId !== 'string') return refuse('bank_invalid_request');
        const result = bankWithdraw(bank, inventory, session.getInventoryCapacity(), msg.tab, msg.itemId, msg.quantity);
        return result.ok ? null : refuse(result.error);
      }
      case 'bank_move': {
        if (typeof msg.itemId !== 'string') return refuse('bank_invalid_request');
        const result = bankMove(bank, msg.fromTab, msg.toTab, msg.itemId, msg.quantity);
        return result.ok ? null : refuse(result.error);
      }
      case 'bank_buy_tab':
        return this.buyTab(session, bank);
      default:
        return refuse('bank_invalid_request');
    }
  }

  private buyTab(session: BankSession, bank: PlayerBank): BankRefusal | null {
    const price = nextBankTabPrice(bank);
    if (price === null) return refuse('bank_max_tabs');
    if (!session.deductGold(price)) return refuse('bank_cannot_afford');
    addBankTab(bank);
    session.addLogEntry(`Bought bank tab ${bank.tabs.length} for ${price} gold`, 'victory');
    return null;
  }
}
