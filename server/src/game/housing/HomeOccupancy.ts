export interface HomeOccupantEntry {
  username: string;
  /** Epoch ms the occupant sat down at the campfire, or null when standing. */
  sitStart: number | null;
}

/** Who is inside each home, in memory only. One home per player at a time. */
export class HomeOccupancy {
  private homes = new Map<string, Map<string, HomeOccupantEntry>>();
  private locations = new Map<string, string>();

  homeOf(username: string): string | undefined {
    return this.locations.get(username);
  }

  occupants(owner: string): HomeOccupantEntry[] {
    return Array.from(this.homes.get(owner)?.values() ?? []);
  }

  /** Puts `username` inside `owner`'s home, leaving any other home first. Returns what that leave released. */
  enter(username: string, owner: string): HomeOccupantEntry & { owner: string } | null {
    if (this.locations.get(username) === owner) return null;
    const left = this.leave(username);
    let home = this.homes.get(owner);
    if (!home) {
      home = new Map();
      this.homes.set(owner, home);
    }
    home.set(username, { username, sitStart: null });
    this.locations.set(username, owner);
    return left;
  }

  leave(username: string): HomeOccupantEntry & { owner: string } | null {
    const owner = this.locations.get(username);
    if (owner === undefined) return null;
    const home = this.homes.get(owner);
    const entry = home?.get(username);
    home?.delete(username);
    if (home && home.size === 0) this.homes.delete(owner);
    this.locations.delete(username);
    return { owner, username, sitStart: entry?.sitStart ?? null };
  }

  /** Empties `owner`'s home and returns everyone who was inside. */
  evict(owner: string): HomeOccupantEntry[] {
    const evicted = this.occupants(owner);
    for (const entry of evicted) this.locations.delete(entry.username);
    this.homes.delete(owner);
    return evicted;
  }

  /** Returns false when `username` isn't inside a home or is already sitting. */
  sit(username: string, now: number): boolean {
    const entry = this.entryOf(username);
    if (!entry || entry.sitStart !== null) return false;
    entry.sitStart = now;
    return true;
  }

  /** Returns the sit start time, or null when `username` wasn't sitting. */
  stand(username: string): number | null {
    const entry = this.entryOf(username);
    if (!entry || entry.sitStart === null) return null;
    const sitStart = entry.sitStart;
    entry.sitStart = null;
    return sitStart;
  }

  everyone(): string[] {
    return Array.from(this.locations.keys());
  }

  sitters(): HomeOccupantEntry[] {
    const result: HomeOccupantEntry[] = [];
    for (const home of this.homes.values()) {
      for (const entry of home.values()) if (entry.sitStart !== null) result.push(entry);
    }
    return result;
  }

  private entryOf(username: string): HomeOccupantEntry | undefined {
    const owner = this.locations.get(username);
    return owner === undefined ? undefined : this.homes.get(owner)?.get(username);
  }
}
