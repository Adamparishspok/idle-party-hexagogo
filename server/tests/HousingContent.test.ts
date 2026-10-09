import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import type { HouseDefinition, ShopDefinition } from '@idle-party-rpg/shared';
import { SEED_HOUSES } from '@idle-party-rpg/shared';

// ContentStore reads its data dir from cwd at module load — chdir before the dynamic imports.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;
type VersionStoreCtor = typeof import('../src/game/VersionStore.js').VersionStore;
type DraftEditorCtor = typeof import('../src/game/DraftEditor.js').DraftEditor;
type AssetStoreCtor = typeof import('../src/game/AssetStore.js').AssetStore;
type McpToolDeps = import('../src/mcp/tools/McpToolDeps.js').McpToolDeps;

let ContentStore: ContentStoreCtor;
let VersionStore: VersionStoreCtor;
let DraftEditor: DraftEditorCtor;
let AssetStore: AssetStoreCtor;
let readTools: typeof import('../src/mcp/tools/readTools.js');
let validateDraft: typeof import('../src/mcp/tools/validateTools.js').validateDraft;
let createAdminRoutes: typeof import('../src/admin/adminRoutes.js').createAdminRoutes;
let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'housing-content-'));
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
  ({ VersionStore } = await import('../src/game/VersionStore.js'));
  ({ DraftEditor } = await import('../src/game/DraftEditor.js'));
  ({ AssetStore } = await import('../src/game/AssetStore.js'));
  readTools = await import('../src/mcp/tools/readTools.js');
  ({ validateDraft } = await import('../src/mcp/tools/validateTools.js'));
  ({ createAdminRoutes } = await import('../src/admin/adminRoutes.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

async function loadFreshStore(): Promise<ContentStoreInstance> {
  const store = new ContentStore();
  await store.load();
  return store;
}

async function setupDeps() {
  const contentStore = await loadFreshStore();
  const versionStore = new VersionStore();
  await versionStore.load();
  const draftEditor = new DraftEditor(versionStore, () => contentStore);
  const deps: McpToolDeps = {
    contentStore: () => contentStore,
    versionStore: () => versionStore,
    draftEditor,
    assetStore: new AssetStore(),
    callerLabel: 'test',
  };
  return { deps, contentStore, versionStore, draftEditor };
}

function makeHouse(id: string, overrides: Partial<HouseDefinition> = {}): HouseDefinition {
  return { id, name: `House ${id}`, tier: 1, price: 100, storageSlots: 2, displaySlots: 1, emoji: '🏠', ...overrides };
}

function makeShop(id: string, houseIds?: string[]): ShopDefinition {
  return { id, name: `Shop ${id}`, inventory: [], houseIds };
}

describe('ContentStore houses', () => {
  it('seeds the starter houses into a fresh world', async () => {
    const store = await loadFreshStore();
    expect(Object.keys(store.getAllHouses()).sort()).toEqual(Object.keys(SEED_HOUSES).sort());
  });

  it('round-trips a house through add/get/delete and persists it to disk', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateHouse(makeHouse('villa', { name: 'Villa' }));

    const reloaded = await loadFreshStore();
    expect(reloaded.getHouse('villa')?.name).toBe('Villa');

    expect((await reloaded.deleteHouse('villa')).success).toBe(true);
    expect(reloaded.getHouse('villa')).toBeUndefined();
  });

  it('refuses to delete a house while a shop sells it, naming the shop', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateHouse(makeHouse('villa'));
    await store.addOrUpdateShop(makeShop('agent', ['villa']));

    const result = await store.deleteHouse('villa');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Shop agent');
    expect(store.getHouse('villa')).toBeDefined();
  });

  it('ships houses in the snapshot, keeps them when the key is absent, clears them on []', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateHouse(makeHouse('villa'));
    const snapshot = store.toSnapshot();
    expect(snapshot.houses.map(h => h.id)).toContain('villa');

    const legacy = { ...snapshot } as Partial<typeof snapshot>;
    delete legacy.houses;
    await store.replaceAll(legacy as typeof snapshot);
    expect(store.getHouse('villa')).toBeDefined();

    await store.replaceAll({ ...snapshot, houses: [makeHouse('cabin')] });
    expect(store.getHouse('villa')).toBeUndefined();
    expect(store.getHouse('cabin')).toBeDefined();

    await store.replaceAll({ ...snapshot, houses: [] });
    expect(Object.keys(store.getAllHouses())).toEqual([]);
  });
});

describe('DraftEditor houses', () => {
  it('upserts a valid house, rejects an invalid one, and guards delete while a shop sells it', async () => {
    const { contentStore, versionStore, draftEditor } = await setupDeps();
    const version = await versionStore.createDraft('houses', null, contentStore.toSnapshot());

    expect((await draftEditor.upsertContent('houses', version.id, makeHouse('villa'))).success).toBe(true);
    const bad = await draftEditor.upsertContent('houses', version.id, makeHouse('broken', { tier: 9 }));
    expect(bad.success).toBe(false);

    await draftEditor.upsertShop(version.id, makeShop('agent', ['villa']));
    const refused = await draftEditor.deleteContent('houses', version.id, 'villa');
    expect(refused.success).toBe(false);

    await draftEditor.upsertShop(version.id, makeShop('agent', []));
    expect((await draftEditor.deleteContent('houses', version.id, 'villa')).success).toBe(true);
  });
});

describe('MCP house tools', () => {
  it('lists and fetches live houses, counts them and describes the schema', async () => {
    const { deps } = await setupDeps();
    const listed = await readTools.listContent(deps, { type: 'houses' });
    expect('entries' in listed && listed.entries.map(e => e.id)).toContain('cottage');

    const fetched = await readTools.getContent(deps, { type: 'houses', id: 'cottage' });
    expect(fetched).toMatchObject({ id: 'cottage', price: SEED_HOUSES.cottage.price });

    const overview = await readTools.getOverview(deps);
    expect('counts' in overview && overview.counts.houses).toBe(Object.keys(SEED_HOUSES).length);

    const schema = await readTools.getContentSchema({ type: 'houses' });
    expect('description' in schema && schema.description).toContain('storageSlots');
  });

  it('flags a shop selling an unknown house', async () => {
    const { deps, contentStore, versionStore, draftEditor } = await setupDeps();
    const version = await versionStore.createDraft('bad agent', null, contentStore.toSnapshot());
    await draftEditor.upsertShop(version.id, makeShop('agent', ['nowhere']));

    const result = await validateDraft(deps, version.id);
    expect(result.problems).toContain("Shop 'agent' houseIds references unknown house 'nowhere' (index 0).");
  });
});

describe('REST house routes', () => {
  async function startServer(): Promise<{ server: Server; base: string; contentStore: ContentStoreInstance }> {
    const { contentStore, versionStore } = await setupDeps();
    const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
    const router = createAdminRoutes({
      playerManager: () => { throw new Error('unused'); },
      accountStore: {} as never,
      inviteListStore: {} as never,
      apiTokenStore: {} as never,
      adminAuth: { requireAdmin: passThrough, requireSession: passThrough, requireSuperAdmin: passThrough } as never,
      contentStore: () => contentStore,
      versionStore: () => versionStore,
      assetStore: new AssetStore(),
      rebuildGrid: () => 0,
      deployVersion: async () => ({ success: true }),
    });
    const app = express();
    app.use(express.json());
    app.use('/api/admin', router);
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    return { server, base: `http://127.0.0.1:${port}/api/admin`, contentStore };
  }

  it('exports houses in the full content dump and supports CRUD', async () => {
    const { server, base, contentStore } = await startServer();
    try {
      const content = await (await fetch(`${base}/content`)).json() as { houses: Record<string, HouseDefinition> };
      expect(content.houses.cottage).toBeDefined();

      const put = await fetch(`${base}/houses/villa`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeHouse('villa')),
      });
      expect(put.status).toBe(200);
      expect(contentStore.getHouse('villa')).toBeDefined();

      const invalid = await fetch(`${base}/houses/villa`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeHouse('villa', { price: -5 })),
      });
      expect(invalid.status).toBe(400);

      await contentStore.addOrUpdateShop(makeShop('agent', ['villa']));
      expect((await fetch(`${base}/houses/villa`, { method: 'DELETE' })).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
