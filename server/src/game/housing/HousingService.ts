import { accrueRested, canStore, emptyHouse, houseSellPrice } from '@idle-party-rpg/shared';
import type { ClientHousingMessage, ServerErrorCode, HomeView, HouseDefinition, ItemDefinition, PlayerHouse } from '@idle-party-rpg/shared';
import type { PlayerSession } from '../PlayerSession.js';
import type { ContentStore } from '../ContentStore.js';
import { HomeOccupancy } from './HomeOccupancy.js';

export interface HousingRefusal {
  code: ServerErrorCode;
  message: string;
}

function refuse(code: ServerErrorCode, message: string): HousingRefusal {
  return { code, message };
}

export const HOME_INVITE_TTL_MS = 30 * 60 * 1000;

export const HOUSING_MESSAGE_TYPES: ReadonlySet<string> = new Set<ClientHousingMessage['type']>([
  'buy_house', 'sell_house', 'enter_home', 'leave_home', 'home_store', 'home_withdraw',
  'home_display', 'campfire_sit', 'campfire_stand', 'home_invite',
]);

type HousingSession = Pick<PlayerSession,
  | 'getHouse' | 'setHouse' | 'getWellRestedUntil' | 'setWellRestedUntil' | 'getCurrentShop'
  | 'getGold' | 'deductGold' | 'grantGold' | 'getInventoryCount' | 'removeFromInventory'
  | 'addToInventory' | 'addLogEntry' | 'getPartyId' | 'getClassName' | 'getLevel'>;

export interface HousingDeps {
  content: Pick<ContentStore, 'getHouse' | 'getItem'>;
  getSession(username: string): HousingSession | undefined;
  areFriends(a: string, b: string): boolean;
  isBlocked(a: string, b: string): boolean;
  pushState(username: string): void;
  notify(username: string, eventKey: string, message: { title: string; body: string; payload?: Record<string, unknown> }): void;
}

/** Definition for an owned house, kept usable even after its content entry is deleted. */
export function houseDefinitionFor(house: PlayerHouse, getHouse: (id: string) => HouseDefinition | undefined): HouseDefinition {
  const def = getHouse(house.houseId);
  if (def) return def;
  const usedSlots = Object.values(house.storage).filter(n => n > 0).length;
  return {
    id: house.houseId,
    name: 'Home',
    tier: 1,
    price: 0,
    storageSlots: usedSlots,
    displaySlots: house.displays.length,
    emoji: '🏠',
  };
}

/** Housing rules, home occupancy and Well Rested accrual. See docs/architecture/housing.md. */
export class HousingService {
  private occupancy = new HomeOccupancy();
  /** target → owner → expiry. */
  private invites = new Map<string, Map<string, number>>();

  constructor(private deps: HousingDeps) {}

  /** Returns the refusal to send the player, or null on success. */
  handle(username: string, msg: ClientHousingMessage, now = Date.now()): HousingRefusal | null {
    switch (msg.type) {
      case 'buy_house':
        return typeof msg.houseId === 'string' ? this.buy(username, msg.houseId, now) : refuse('home_invalid_request', 'Invalid request.');
      case 'sell_house':
        return this.sell(username, now);
      case 'enter_home':
        if (msg.owner !== undefined && typeof msg.owner !== 'string') return refuse('home_invalid_request', 'Invalid request.');
        return this.enter(username, msg.owner, now);
      case 'leave_home':
        return this.leave(username, now);
      case 'home_store':
        return this.store(username, msg.itemId, msg.quantity);
      case 'home_withdraw':
        return this.withdraw(username, msg.itemId, msg.quantity);
      case 'home_display':
        return this.display(username, msg.slot, msg.itemId);
      case 'campfire_sit':
        return this.sit(username, now);
      case 'campfire_stand':
        return this.stand(username, now);
      case 'home_invite':
        return typeof msg.username === 'string' ? this.invite(username, msg.username, now) : refuse('home_invalid_request', 'Invalid request.');
    }
  }

  buy(username: string, houseId: string, now = Date.now()): HousingRefusal | null {
    const session = this.deps.getSession(username);
    if (!session) return refuse('home_invalid_request', 'No session.');
    if (!session.getCurrentShop()?.houseIds?.includes(houseId)) return refuse('house_not_for_sale', 'That house is not for sale here.');
    const def = this.deps.content.getHouse(houseId);
    if (!def) return refuse('house_not_for_sale', 'That house is no longer for sale.');
    if (session.getHouse()) return refuse('house_already_owned', 'You already own a house. Sell it first.');
    if (!session.deductGold(def.price)) return refuse('house_cannot_afford', 'Not enough gold.');
    session.setHouse(emptyHouse(def, now));
    session.addLogEntry(`Bought a ${def.name} for ${def.price} gold`, 'victory');
    this.deps.pushState(username);
    return null;
  }

  sell(username: string, now = Date.now()): HousingRefusal | null {
    const session = this.deps.getSession(username);
    const house = session?.getHouse();
    if (!session || !house) return refuse('house_not_owned', "You don't own a house.");
    if (Object.values(house.storage).some(n => n > 0) || house.displays.some(d => d !== null)) {
      return refuse('house_not_empty', 'Empty your chest and shelves before selling.');
    }
    const def = houseDefinitionFor(house, id => this.deps.content.getHouse(id));
    const refund = houseSellPrice(def);
    const evicted = this.occupancy.evict(username);
    for (const entry of evicted) this.settleSitting(entry.username, entry.sitStart, now);
    session.setHouse(null);
    session.grantGold(refund);
    session.addLogEntry(`Sold your ${def.name} for ${refund} gold`, 'victory');
    for (const entry of evicted) if (entry.username !== username) this.deps.pushState(entry.username);
    this.deps.pushState(username);
    return null;
  }

  enter(username: string, ownerName: string | undefined, now = Date.now()): HousingRefusal | null {
    const owner = ownerName ?? username;
    const ownerSession = this.deps.getSession(owner);
    if (!ownerSession?.getHouse()) return owner === username ? refuse('house_not_owned', "You don't own a house.") : refuse('house_not_owned', "They don't own a house.");
    if (this.occupancy.homeOf(username) === owner) {
      this.deps.pushState(username);
      return null;
    }
    if (owner !== username && !this.mayVisit(username, owner, now)) return refuse('home_access_denied', "You haven't been invited to that home.");
    const left = this.occupancy.enter(username, owner);
    if (left) this.afterLeaving(left.owner, username, left.sitStart, now);
    this.pushHome(owner);
    return null;
  }

  leave(username: string, now = Date.now()): HousingRefusal | null {
    const left = this.occupancy.leave(username);
    if (!left) return null;
    this.afterLeaving(left.owner, username, left.sitStart, now);
    this.deps.pushState(username);
    return null;
  }

  handleDisconnect(username: string, now = Date.now()): void {
    const left = this.occupancy.leave(username);
    if (left) this.afterLeaving(left.owner, username, left.sitStart, now);
  }

  store(username: string, itemId: unknown, quantity: unknown): HousingRefusal | null {
    if (typeof itemId !== 'string' || !isPositiveInt(quantity)) return refuse('home_invalid_request', 'Invalid quantity.');
    const session = this.deps.getSession(username);
    const house = session?.getHouse();
    if (!session || !house) return refuse('house_not_owned', "You don't own a house.");
    if (session.getInventoryCount(itemId) < quantity) return refuse('home_item_missing', 'You can only store items in your bag, not equipped ones.');
    if (!canStore(house, this.definitionOf(house), itemId, quantity)) return refuse('home_chest_full', 'Your chest is full.');
    session.removeFromInventory(itemId, quantity);
    house.storage[itemId] = (house.storage[itemId] ?? 0) + quantity;
    this.pushOwnerAndHome(username);
    return null;
  }

  withdraw(username: string, itemId: unknown, quantity: unknown): HousingRefusal | null {
    if (typeof itemId !== 'string' || !isPositiveInt(quantity)) return refuse('home_invalid_request', 'Invalid quantity.');
    const session = this.deps.getSession(username);
    const house = session?.getHouse();
    if (!session || !house) return refuse('house_not_owned', "You don't own a house.");
    if ((house.storage[itemId] ?? 0) < quantity) return refuse('home_item_missing', "That isn't in your chest.");
    if (!session.addToInventory(itemId, quantity)) return refuse('home_bag_full', 'Your bag cannot hold that many.');
    removeFromStorage(house, itemId, quantity);
    this.pushOwnerAndHome(username);
    return null;
  }

  display(username: string, slot: unknown, itemId: unknown): HousingRefusal | null {
    if (itemId !== null && typeof itemId !== 'string') return refuse('home_invalid_request', 'Invalid request.');
    const session = this.deps.getSession(username);
    const house = session?.getHouse();
    if (!session || !house) return refuse('house_not_owned', "You don't own a house.");
    if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= house.displays.length) return refuse('home_invalid_request', 'No such shelf.');
    const shelf = slot as number;
    const current = house.displays[shelf];
    if (itemId === null) {
      if (current === null) return refuse('home_invalid_request', 'That shelf is already empty.');
      if (!canStore(house, this.definitionOf(house), current, 1)) return refuse('home_chest_full', 'Your chest is full.');
      house.storage[current] = (house.storage[current] ?? 0) + 1;
      house.displays[shelf] = null;
    } else {
      if ((house.storage[itemId] ?? 0) < 1) return refuse('home_item_missing', "That isn't in your chest.");
      removeFromStorage(house, itemId, 1);
      if (current !== null && !canStore(house, this.definitionOf(house), current, 1)) {
        house.storage[itemId] = (house.storage[itemId] ?? 0) + 1;
        return refuse('home_chest_full', 'Your chest is full.');
      }
      if (current !== null) house.storage[current] = (house.storage[current] ?? 0) + 1;
      house.displays[shelf] = itemId;
    }
    this.pushOwnerAndHome(username);
    return null;
  }

  sit(username: string, now = Date.now()): HousingRefusal | null {
    const owner = this.occupancy.homeOf(username);
    if (owner === undefined) return refuse('home_not_inside', "You're not inside a home.");
    if (!this.occupancy.sit(username, now)) return null;
    this.pushHome(owner);
    return null;
  }

  stand(username: string, now = Date.now()): HousingRefusal | null {
    const owner = this.occupancy.homeOf(username);
    if (owner === undefined) return refuse('home_not_inside', "You're not inside a home.");
    const sitStart = this.occupancy.stand(username);
    if (sitStart === null) return null;
    this.settleSitting(username, sitStart, now);
    this.pushHome(owner);
    return null;
  }

  invite(owner: string, target: string, now = Date.now()): HousingRefusal | null {
    const ownerSession = this.deps.getSession(owner);
    const house = ownerSession?.getHouse();
    if (!ownerSession || !house) return refuse('house_not_owned', "You don't own a house.");
    if (target === owner) return refuse('home_invite_refused', "You can't invite yourself.");
    if (!this.deps.getSession(target)) return refuse('home_invite_refused', 'Player not found.');
    if (this.deps.isBlocked(owner, target)) return refuse('home_invite_refused', "You can't invite that player.");
    let pending = this.invites.get(target);
    if (!pending) {
      pending = new Map();
      this.invites.set(target, pending);
    }
    pending.set(owner, now + HOME_INVITE_TTL_MS);
    const def = this.definitionOf(house);
    this.deps.notify(target, 'home_invite', {
      title: 'Home invite',
      body: `${owner} invited you to visit their ${def.name}.`,
      payload: { owner },
    });
    return null;
  }

  /** Accrues Well Rested for everyone sitting, so a crash loses at most one tick. */
  tickResting(now = Date.now()): void {
    for (const entry of this.occupancy.sitters()) {
      if (entry.sitStart === null) continue;
      this.settleSitting(entry.username, entry.sitStart, now);
      entry.sitStart = now;
      this.deps.pushState(entry.username);
    }
  }

  homeOf(username: string): string | undefined {
    return this.occupancy.homeOf(username);
  }

  getHomeView(viewer: string): HomeView | undefined {
    const owner = this.occupancy.homeOf(viewer);
    if (owner === undefined) return undefined;
    const house = this.deps.getSession(owner)?.getHouse();
    if (!house) return undefined;
    const isOwner = owner === viewer;
    const itemIds = new Set(house.displays.filter((id): id is string => id !== null));
    if (isOwner) for (const id of Object.keys(house.storage)) itemIds.add(id);
    const itemDefinitions: Record<string, ItemDefinition> = {};
    for (const id of itemIds) {
      const def = this.deps.content.getItem(id);
      if (def) itemDefinitions[id] = def;
    }
    return {
      owner,
      definition: this.definitionOf(house),
      displays: [...house.displays],
      storage: isOwner ? { ...house.storage } : undefined,
      occupants: this.occupancy.occupants(owner).map(entry => {
        const session = this.deps.getSession(entry.username);
        return {
          username: entry.username,
          className: session?.getClassName() ?? undefined,
          level: session?.getLevel() || undefined,
          sitting: entry.sitStart !== null,
        };
      }),
      itemDefinitions,
    };
  }

  private mayVisit(visitor: string, owner: string, now: number): boolean {
    if (this.deps.areFriends(owner, visitor)) return true;
    const ownerParty = this.deps.getSession(owner)?.getPartyId();
    if (ownerParty && ownerParty === this.deps.getSession(visitor)?.getPartyId()) return true;
    return this.consumeInvite(visitor, owner, now);
  }

  private consumeInvite(target: string, owner: string, now: number): boolean {
    const pending = this.invites.get(target);
    const expiresAt = pending?.get(owner);
    if (!pending || expiresAt === undefined) return false;
    pending.delete(owner);
    if (pending.size === 0) this.invites.delete(target);
    return expiresAt > now;
  }

  private settleSitting(username: string, sitStart: number | null, now: number): void {
    if (sitStart === null) return;
    const session = this.deps.getSession(username);
    if (!session) return;
    session.setWellRestedUntil(accrueRested(session.getWellRestedUntil(), sitStart, now));
  }

  private afterLeaving(owner: string, username: string, sitStart: number | null, now: number): void {
    this.settleSitting(username, sitStart, now);
    this.pushHome(owner);
  }

  private definitionOf(house: PlayerHouse): HouseDefinition {
    return houseDefinitionFor(house, id => this.deps.content.getHouse(id));
  }

  private pushHome(owner: string): void {
    for (const entry of this.occupancy.occupants(owner)) this.deps.pushState(entry.username);
  }

  private pushOwnerAndHome(owner: string): void {
    this.pushHome(owner);
    if (this.occupancy.homeOf(owner) !== owner) this.deps.pushState(owner);
  }
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function removeFromStorage(house: PlayerHouse, itemId: string, quantity: number): void {
  const remaining = (house.storage[itemId] ?? 0) - quantity;
  if (remaining > 0) house.storage[itemId] = remaining;
  else delete house.storage[itemId];
}
