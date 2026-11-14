import fs from 'fs/promises';
import path from 'path';
import type { ServerMaintenanceMessage, ServerVersionMismatchMessage } from '@idle-party-rpg/shared';

const MAINTENANCE_FILE = path.resolve('data', 'maintenance.json');
const MAX_MESSAGE_LENGTH = 500;

export interface MaintenanceState {
  enabled: boolean;
  message: string;
  /** ISO timestamp, or null when no estimate is given. */
  eta: string | null;
}

export interface MaintenanceStore {
  load(): Promise<MaintenanceState>;
  save(state: MaintenanceState): Promise<void>;
}

export const DEFAULT_MAINTENANCE: MaintenanceState = { enabled: false, message: '', eta: null };

/** Coerces untrusted input (file or request body) into a valid state; unparseable ETAs become null. */
export function normalizeMaintenance(raw: unknown): MaintenanceState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const eta = typeof r.eta === 'string' && r.eta && !Number.isNaN(Date.parse(r.eta)) ? new Date(r.eta).toISOString() : null;
  return {
    enabled: r.enabled === true,
    message: typeof r.message === 'string' ? r.message.trim().slice(0, MAX_MESSAGE_LENGTH) : '',
    eta,
  };
}

/** The refusal payload a non-admin gets while maintenance is on; null when they may connect. */
export function maintenanceGate(state: MaintenanceState, isAdmin: boolean): ServerMaintenanceMessage | null {
  if (!state.enabled || isAdmin) return null;
  return { type: 'maintenance', message: state.message, eta: state.eta };
}

/** A client that reports a build different from the server's must reload; an absent report is ignored. */
export function versionMismatch(reported: string | null | undefined, serverVersion: string): ServerVersionMismatchMessage | null {
  if (!reported || reported === serverVersion) return null;
  return { type: 'version_mismatch', serverVersion };
}

export class JsonMaintenanceStore implements MaintenanceStore {
  async load(): Promise<MaintenanceState> {
    try {
      return normalizeMaintenance(JSON.parse(await fs.readFile(MAINTENANCE_FILE, 'utf-8')));
    } catch {
      return { ...DEFAULT_MAINTENANCE };
    }
  }

  async save(state: MaintenanceState): Promise<void> {
    await fs.mkdir(path.dirname(MAINTENANCE_FILE), { recursive: true });
    await fs.writeFile(MAINTENANCE_FILE, JSON.stringify(state, null, 2));
  }
}

export class MaintenanceMode {
  private state: MaintenanceState = { ...DEFAULT_MAINTENANCE };

  constructor(private store: MaintenanceStore) {}

  async load(): Promise<void> {
    this.state = await this.store.load();
  }

  get(): MaintenanceState {
    return { ...this.state };
  }

  async set(raw: unknown): Promise<MaintenanceState> {
    this.state = normalizeMaintenance(raw);
    await this.store.save(this.state);
    return this.get();
  }

  gate(isAdmin: boolean): ServerMaintenanceMessage | null {
    return maintenanceGate(this.state, isAdmin);
  }
}
