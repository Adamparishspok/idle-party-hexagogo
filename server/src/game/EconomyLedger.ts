import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import type { GoldSource } from '@idle-party-rpg/shared';

export interface GoldFlow { earned: number; spent: number }
/** UTC day (YYYY-MM-DD) → source → totals. */
export type EconomyData = Record<string, Partial<Record<GoldSource, GoldFlow>>>;

export interface EconomyStore {
  load(): Promise<EconomyData>;
  save(data: EconomyData): Promise<void>;
}

const RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const ECONOMY_DIR = path.resolve('data', 'economy');

export class EconomyLedger {
  private days: EconomyData = {};

  constructor(private readonly now: () => number = Date.now) {}

  restore(data: EconomyData): void {
    this.days = data;
    this.prune();
  }

  record(source: GoldSource, earned: number, spent: number): void {
    if (earned <= 0 && spent <= 0) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const flow = ((this.days[day] ??= {})[source] ??= { earned: 0, spent: 0 });
    flow.earned += earned;
    flow.spent += spent;
  }

  /** Totals per source over the last `days` UTC days, today included. */
  summary(days: number): Partial<Record<GoldSource, GoldFlow>> {
    const out: Partial<Record<GoldSource, GoldFlow>> = {};
    for (const [day, sources] of Object.entries(this.days)) {
      if (day < this.cutoff(days)) continue;
      for (const [source, flow] of Object.entries(sources) as [GoldSource, GoldFlow][]) {
        const total = (out[source] ??= { earned: 0, spent: 0 });
        total.earned += flow.earned;
        total.spent += flow.spent;
      }
    }
    return out;
  }

  toData(): EconomyData {
    this.prune();
    return this.days;
  }

  private cutoff(days: number): string {
    return new Date(this.now() - (days - 1) * MS_PER_DAY).toISOString().slice(0, 10);
  }

  private prune(): void {
    const cutoff = this.cutoff(RETENTION_DAYS);
    for (const day of Object.keys(this.days)) {
      if (day < cutoff) delete this.days[day];
    }
  }
}

export class JsonEconomyStore implements EconomyStore {
  private readonly file: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string = ECONOMY_DIR) {
    this.file = path.join(dir, 'ledger.json');
  }

  async load(): Promise<EconomyData> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    try {
      const data = JSON.parse(raw) as EconomyData;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Not a ledger');
      return data;
    } catch (err) {
      const aside = `${this.file}.unreadable-${Date.now()}`;
      await rename(this.file, aside);
      console.error(`[EconomyStore] Moved an unreadable file to ${aside}:`, err);
      return {};
    }
  }

  save(data: EconomyData): Promise<void> {
    const json = JSON.stringify(data);
    this.writeQueue = this.writeQueue.then(() => this.write(json), () => this.write(json));
    return this.writeQueue;
  }

  private async write(json: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, json, 'utf-8');
    await rename(tmp, this.file);
  }
}
