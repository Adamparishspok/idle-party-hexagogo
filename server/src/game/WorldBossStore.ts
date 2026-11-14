import fs from 'fs/promises';
import path from 'path';
import type { WorldBossState } from '@idle-party-rpg/shared';

const WORLD_BOSSES_FILE = path.resolve('data', 'world-bosses.json');

/** Persists live world boss state (shared HP, schedule, contributions). */
export interface WorldBossStore {
  load(): Promise<WorldBossState[]>;
  save(states: WorldBossState[]): Promise<void>;
}

export class JsonWorldBossStore implements WorldBossStore {
  async load(): Promise<WorldBossState[]> {
    try {
      const arr = JSON.parse(await fs.readFile(WORLD_BOSSES_FILE, 'utf-8')) as WorldBossState[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  async save(states: WorldBossState[]): Promise<void> {
    await fs.mkdir(path.dirname(WORLD_BOSSES_FILE), { recursive: true });
    await fs.writeFile(WORLD_BOSSES_FILE, JSON.stringify(states, null, 2));
  }
}
