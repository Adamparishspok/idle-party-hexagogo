import type { RoomEntryFailure } from '@idle-party-rpg/shared';

export interface FollowLocation {
  partyId: string;
  mapId: string;
  col: number;
  row: number;
  /** In a dungeon or a home: not a room anyone can path to. */
  sealed: boolean;
}

export interface FollowHost {
  isOnline(username: string): boolean;
  canMoveParty(username: string): boolean;
  location(username: string): FollowLocation | null;
  isDiscovered(follower: string, target: string): boolean;
  moveParty(partyId: string, col: number, row: number): { success: true } | { success: false; blocked?: RoomEntryFailure };
  tell(username: string, message: string): void;
  pushState(username: string): void;
}

/** Keeps a player's party walking to another (non-party) player's room. See docs/architecture/social.md. */
export class FollowSystem {
  private targets = new Map<string, string>();

  constructor(private host: FollowHost) {}

  getTarget(follower: string): string | null {
    return this.targets.get(follower) ?? null;
  }

  /** Rehydrate a saved follow; validated on the target's next move. */
  restore(follower: string, target: string | null | undefined): void {
    if (target) this.targets.set(follower, target);
  }

  start(follower: string, target: string): string | null {
    if (follower === target) return 'You cannot follow yourself.';
    if (!this.host.canMoveParty(follower)) return 'Only owners and leaders can move the party.';
    if (!this.host.isOnline(target)) return `${target} is offline.`;
    const problem = this.repath(follower, target);
    if (problem) return problem;
    this.targets.set(follower, target);
    this.host.pushState(follower);
    return null;
  }

  stop(follower: string): void {
    if (!this.targets.delete(follower)) return;
    this.host.pushState(follower);
  }

  stopForUsers(usernames: Iterable<string>): void {
    for (const u of usernames) this.stop(u);
  }

  /** The target went offline: nobody keeps following them. */
  stopFollowing(target: string): void {
    for (const [follower, t] of [...this.targets]) {
      if (t !== target) continue;
      this.stop(follower);
      this.host.tell(follower, `${target} went offline. You stopped following.`);
    }
  }

  forget(username: string): void {
    this.targets.delete(username);
    this.stopFollowing(username);
  }

  rename(oldName: string, newName: string): void {
    const own = this.targets.get(oldName);
    if (own !== undefined) {
      this.targets.delete(oldName);
      this.targets.set(newName, own);
    }
    for (const [follower, t] of this.targets) {
      if (t === oldName) this.targets.set(follower, newName);
    }
  }

  /** Joining the target's party ends the follow. */
  reconcileParties(): void {
    for (const [follower, target] of [...this.targets]) {
      const mine = this.host.location(follower);
      const theirs = this.host.location(target);
      if (mine && theirs && mine.partyId === theirs.partyId) this.stop(follower);
    }
  }

  /** A party moved: re-path everyone following one of its members. */
  onPartyMoved(members: ReadonlySet<string>): void {
    for (const [follower, target] of [...this.targets]) {
      if (!members.has(target)) continue;
      const problem = this.repath(follower, target);
      if (!problem) continue;
      this.stop(follower);
      this.host.tell(follower, `${problem} You stopped following.`);
    }
  }

  private repath(follower: string, target: string): string | null {
    if (!this.host.isOnline(target)) return `${target} is offline.`;
    if (!this.host.canMoveParty(follower)) return 'You can no longer move the party.';
    const mine = this.host.location(follower);
    const theirs = this.host.location(target);
    if (!mine || !theirs) return `${target} is unreachable.`;
    if (mine.partyId === theirs.partyId) return `${target} is already in your party.`;
    if (mine.sealed || theirs.sealed) return `${target} is somewhere you cannot follow.`;
    if (mine.mapId !== theirs.mapId) return `${target} is on another map.`;
    if (!this.host.isDiscovered(follower, target)) return `You have not discovered ${target}'s room.`;
    const result = this.host.moveParty(mine.partyId, theirs.col, theirs.row);
    if (result.success) return null;
    return result.blocked?.reason ?? `You cannot reach ${target}'s room.`;
  }
}
