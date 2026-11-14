import { describe, it, expect } from 'vitest';
import { MaintenanceMode, maintenanceGate, normalizeMaintenance, versionMismatch } from '../src/game/MaintenanceMode.js';
import type { MaintenanceState, MaintenanceStore } from '../src/game/MaintenanceMode.js';

const ON: MaintenanceState = { enabled: true, message: 'Patching', eta: '2026-11-14T10:00:00.000Z' };

describe('maintenanceGate', () => {
  it('refuses non-admins with the maintenance payload while on', () => {
    expect(maintenanceGate(ON, false)).toEqual({ type: 'maintenance', message: 'Patching', eta: ON.eta });
  });

  it('lets admins through while on', () => {
    expect(maintenanceGate(ON, true)).toBeNull();
  });

  it('lets everyone through while off', () => {
    expect(maintenanceGate({ ...ON, enabled: false }, false)).toBeNull();
  });
});

describe('normalizeMaintenance', () => {
  it('trims and caps the message, drops a bad ETA, and requires enabled === true', () => {
    expect(normalizeMaintenance({ enabled: 'yes', message: '  hi  ', eta: 'soon' })).toEqual({ enabled: false, message: 'hi', eta: null });
    expect(normalizeMaintenance({ enabled: true, message: 'x'.repeat(900) }).message).toHaveLength(500);
    expect(normalizeMaintenance(null)).toEqual({ enabled: false, message: '', eta: null });
  });
});

describe('MaintenanceMode', () => {
  it('persists through the store and survives a reload', async () => {
    let saved: MaintenanceState | null = null;
    const store: MaintenanceStore = {
      load: async () => saved ?? { enabled: false, message: '', eta: null },
      save: async (s) => { saved = s; },
    };
    const mode = new MaintenanceMode(store);
    await mode.set(ON);
    const reloaded = new MaintenanceMode(store);
    await reloaded.load();
    expect(reloaded.gate(false)).not.toBeNull();
    expect(reloaded.gate(true)).toBeNull();
  });
});

describe('versionMismatch', () => {
  it('flags only a reported build that differs', () => {
    expect(versionMismatch('1', '2')).toEqual({ type: 'version_mismatch', serverVersion: '2' });
    expect(versionMismatch('2', '2')).toBeNull();
    expect(versionMismatch(null, '2')).toBeNull();
  });
});
