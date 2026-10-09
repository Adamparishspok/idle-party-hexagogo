import { accrueRested, canStore, describeHomeLocation, emptyHouse, houseSellPrice } from '@idle-party-rpg/shared';
import type { ClientHousingMessage, HomeLocation, ServerErrorCode, HomeView, HouseDefinition, ItemDefinition, PlayerHouse, WorldTileDefinition } from '@idle-party-rpg/shared';
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
  'home_display', 'campfire_sit', 'campfire_stand', 'home_invite', 'travel_home',
]);

type HousingSession = Pick<PlayerSession,
  | 'getHouse' | 'setHouse' | 'getWellRestedUntil' | 'setWellRestedUntil' | 'getCurrentShop'
  | 'getGold' | 'deductGold' | 'grantGold' | 'getInventoryCount' | 'removeFromInventory'
  | 'addToInventory' | 'addLogEntry' | 'getPartyId' | 'getClassName' | 'getLevel'>;

export interface HousingDeps {
  content: Pick<ContentStore, 'getHouse' | 'getItem' | 'getTileById' | 'getZone' | 'getShop' | 'getWorld'>;
  getSession(username: string): HousingSession | undefined;
  currentTileId(username: string): string | undefined;
  /** Sends `username`'s party walking to `tile`. Returns why it can't, or null. */
  moveParty(username: string, tile: WorldTileDefinition): string | null;
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
  /** traveller → the home they are walking to. */
  private travels = new Map<string, { owner: string; tileId: string; expiresAt: number }>();

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
      case 'travel_home':
        if (msg.owner !== undefined && typeof msg.owner !== 'string') return refuse('home_invalid_request', 'Invalid request.');
        return this.travel(username, msg.owner, now);
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
    session.setHouse(emptyHouse(def, now, this.deps.currentTileId(username)));
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
    const house = this.deps.getSession(owner)?.getHouse();
    if (!house) return owner === username ? refuse('house_not_owned', "You don't own a house.") : refuse('house_not_owned', "They don't own a house.");
    if (this.occupancy.homeOf(username) === owner) {
      this.deps.pushState(username);
      return null;
    }
    if (owner !== username && !this.mayVisit(username, owner, now, false)) return refuse('home_access_denied', "You haven't been invited to that home.");
    const tileId = this.homeTileId(house);
    if (tileId && this.deps.currentTileId(username) !== tileId) {
      return refuse('home_too_far', `${this.homeTitle(owner, username, house)} is in ${this.whereIs(tileId)}. Travel there to go inside.`);
    }
    if (owner !== username) this.mayVisit(username, owner, now, true);
    this.travels.delete(username);
    const left = this.occupancy.enter(username, owner);
    if (left) this.afterLeaving(left.owner, username, left.sitStart, now);
    this.pushHome(owner);
    return null;
  }

  travel(username: string, ownerName: string | undefined, now = Date.now()): HousingRefusal | null {
    const owner = ownerName ?? username;
    const house = this.deps.getSession(owner)?.getHouse();
    if (!house) return owner === username ? refuse('house_not_owned', "You don't own a house.") : refuse('house_not_owned', "They don't own a house.");
    if (owner !== username && !this.mayVisit(username, owner, now, false)) return refuse('home_access_denied', "You haven't been invited to that home.");
    const tileId = this.homeTileId(house);
    if (!tileId || this.deps.currentTileId(username) === tileId) return this.enter(username, ownerName, now);
    const tile = this.deps.content.getTileById(tileId);
    if (!tile) return this.enter(username, ownerName, now);
    const why = this.deps.moveParty(username, tile);
    if (why) return refuse('home_cannot_travel', why);
    this.travels.set(username, { owner, tileId, expiresAt: now + HOME_INVITE_TTL_MS });
    return null;
  }

  /** After a party steps: puts out anyone whose party left their home's room, and lets arriving travellers in. */
  onMembersMoved(usernames: Iterable<string>, now = Date.now()): void {
    for (const username of usernames) {
      this.leaveIfAway(username, now);
      const trip = this.travels.get(username);
      if (!trip) continue;
      if (trip.expiresAt <= now) {
        this.travels.delete(username);
        continue;
      }
      if (this.deps.currentTileId(username) !== trip.tileId) continue;
      this.travels.delete(username);
      this.enter(username, trip.owner === username ? undefined : trip.owner, now);
    }
  }

  homeLocation(house: PlayerHouse): HomeLocation | undefined {
    const tileId = this.homeTileId(house);
    const tile = tileId ? this.deps.content.getTileById(tileId) : undefined;
    if (!tile) return undefined;
    return {
      tileId: tile.id,
      mapId: tile.mapId,
      col: tile.col,
      row: tile.row,
      roomName: tile.name,
      zoneName: this.deps.content.getZone(tile.zone)?.displayName,
    };
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
    for (const username of this.occupancy.everyone()) this.leaveIfAway(username, now);
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
      location: this.homeLocation(house),
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

  private mayVisit(visitor: string, owner: string, now: number, consume: boolean): boolean {
    if (this.deps.areFriends(owner, visitor)) return true;
    const ownerParty = this.deps.getSession(owner)?.getPartyId();
    if (ownerParty && ownerParty === this.deps.getSession(visitor)?.getPartyId()) return true;
    return this.checkInvite(visitor, owner, now, consume);
  }

  private checkInvite(target: string, owner: string, now: number, consume: boolean): boolean {
    const pending = this.invites.get(target);
    const expiresAt = pending?.get(owner);
    if (!pending || expiresAt === undefined) return false;
    if (expiresAt <= now) {
      pending.delete(owner);
      if (pending.size === 0) this.invites.delete(target);
      return false;
    }
    if (consume) {
      pending.delete(owner);
      if (pending.size === 0) this.invites.delete(target);
    }
    return true;
  }

  /** The home's room, falling back to an estate agent that sells it for homes with no (or a deleted) room. */
  private homeTileId(house: PlayerHouse): string | undefined {
    if (house.tileId && this.deps.content.getTileById(house.tileId)) return house.tileId;
    const agent = this.deps.content.getWorld().tiles.find(t => {
      const shop = t.shopId ? this.deps.content.getShop(t.shopId) : undefined;
      return !!shop?.houseIds?.includes(house.houseId);
    });
    if (agent) house.tileId = agent.id;
    return agent?.id;
  }

  private whereIs(tileId: string): string {
    const tile = this.deps.content.getTileById(tileId);
    if (!tile) return 'a faraway room';
    return describeHomeLocation({ roomName: tile.name, zoneName: this.deps.content.getZone(tile.zone)?.displayName });
  }

  private homeTitle(owner: string, viewer: string, house: PlayerHouse): string {
    const name = this.definitionOf(house).name;
    return owner === viewer ? `Your ${name}` : `${owner}'s ${name}`;
  }

  private leaveIfAway(username: string, now: number): void {
    const owner = this.occupancy.homeOf(username);
    if (owner === undefined) return;
    const house = this.deps.getSession(owner)?.getHouse();
    const tileId = house ? this.homeTileId(house) : undefined;
    if (!tileId || this.deps.currentTileId(username) === tileId) return;
    this.leave(username, now);
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
