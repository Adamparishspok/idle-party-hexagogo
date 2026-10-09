import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { STARTER_BAG_ITEM, SEED_BAG_ITEMS } from '@idle-party-rpg/shared';
import type { ItemDefinition } from '@idle-party-rpg/shared';

// ContentStore/VersionStore resolve data dirs from process.cwd() at import time. Mirrors DraftEditor.test.ts.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type VersionStoreCtor = typeof import('../src/game/VersionStore.js').VersionStore;
type DraftEditorCtor = typeof import('../src/game/DraftEditor.js').DraftEditor;

let ContentStore: ContentStoreCtor;
let VersionStore: VersionStoreCtor;
let DraftEditor: DraftEditorCtor;
let AssetStore: typeof import('../src/game/AssetStore.js').AssetStore;
let validateDraft: typeof import('../src/mcp/tools/validateTools.js').validateDraft;
let getContentSchema: typeof import('../src/mcp/tools/readTools.js').getContentSchema;
let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gear-content-'));
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
  ({ VersionStore } = await import('../src/game/VersionStore.js'));
  ({ DraftEditor } = await import('../src/game/DraftEditor.js'));
  ({ AssetStore } = await import('../src/game/AssetStore.js'));
  ({ validateDraft } = await import('../src/mcp/tools/validateTools.js'));
  ({ getContentSchema } = await import('../src/mcp/tools/readTools.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

async function writeCoreDataFiles(items: ItemDefinition[] = []): Promise<void> {
  const dataDir = path.join(tmpDir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'monsters.json'), '[]');
  await fs.writeFile(path.join(dataDir, 'items.json'), JSON.stringify(items));
  await fs.writeFile(path.join(dataDir, 'zones.json'), '[]');
  await fs.writeFile(path.join(dataDir, 'world.json'), JSON.stringify({ startTile: { col: 0, row: 0 }, tiles: [] }));
}

async function draftSetup() {
  const contentStore = new ContentStore();
  await contentStore.load();
  const versionStore = new VersionStore();
  await versionStore.load();
  const draftEditor = new DraftEditor(versionStore, () => contentStore);
  const version = await versionStore.createDraft('gear', null, contentStore.toSnapshot());
  const deps = {
    contentStore: () => contentStore,
    versionStore: () => versionStore,
    draftEditor,
    assetStore: new AssetStore(),
    callerLabel: 'test',
  };
  return { contentStore, versionStore, draftEditor, versionId: version.id, deps };
}

describe('starter bag in content', () => {
  it('seeds the starter bag and the seed bags into a fresh world', async () => {
    const store = new ContentStore();
    await store.load();
    expect(store.getItem(STARTER_BAG_ITEM.id)?.bagSlots).toBe(12);
    for (const bag of SEED_BAG_ITEMS) expect(store.getItem(bag.id)).toBeDefined();
  });

  it('adds the starter bag to an existing install that lacks it, but only the starter bag', async () => {
    await writeCoreDataFiles();
    const store = new ContentStore();
    await store.load();
    expect(store.getItem(STARTER_BAG_ITEM.id)).toBeDefined();
    for (const bag of SEED_BAG_ITEMS) expect(store.getItem(bag.id)).toBeUndefined();
  });

  it("never overwrites an operator's edits to the starter bag", async () => {
    await writeCoreDataFiles([{ ...STARTER_BAG_ITEM, name: 'Pilgrim Sack', bagSlots: 10 }]);
    const store = new ContentStore();
    await store.load();
    expect(store.getItem(STARTER_BAG_ITEM.id)).toMatchObject({ name: 'Pilgrim Sack', bagSlots: 10 });
  });

  it('refuses to delete the starter bag, live or in a draft', async () => {
    const { contentStore, draftEditor, versionId } = await draftSetup();
    expect((await contentStore.deleteItem(STARTER_BAG_ITEM.id)).success).toBe(false);
    expect((await draftEditor.deleteItem(versionId, STARTER_BAG_ITEM.id)).success).toBe(false);
  });

  it('restores the starter bag after deploying a snapshot without it', async () => {
    const store = new ContentStore();
    await store.load();
    const snapshot = store.toSnapshot();
    snapshot.items = snapshot.items.filter(i => i.id !== STARTER_BAG_ITEM.id);
    await store.replaceAll(snapshot);
    expect(store.getItem(STARTER_BAG_ITEM.id)).toBeDefined();
  });
});

describe('item attribute and bag validation', () => {
  it('rejects unknown attributes, fractional values and bags with an equip slot', async () => {
    const { contentStore, draftEditor, versionId } = await draftSetup();
    const bad: ItemDefinition[] = [
      { id: 'x1', name: 'X', rarity: 'common', attributes: { luck: 3 } as never },
      { id: 'x2', name: 'X', rarity: 'common', attributes: { strength: 1.5 } },
      { id: 'x3', name: 'X', rarity: 'common', bagSlots: 6, equipSlot: 'back' },
      { id: 'x4', name: 'X', rarity: 'common', bagSlots: 99 },
    ];
    for (const item of bad) {
      expect(await contentStore.addOrUpdateItem(item)).toBeTypeOf('string');
      expect(contentStore.getItem(item.id)).toBeUndefined();
      expect((await draftEditor.upsertItem(versionId, item)).success).toBe(false);
    }
  });

  it('accepts attribute gear and bags', async () => {
    const { contentStore, draftEditor, versionId } = await draftSetup();
    const helm: ItemDefinition = { id: 'helm', name: 'Helm', rarity: 'rare', equipSlot: 'head', attributes: { strength: 3, stamina: 2 } };
    const bag: ItemDefinition = { id: 'bag', name: 'Bag', rarity: 'common', bagSlots: 10 };
    expect(await contentStore.addOrUpdateItem(helm)).toBeNull();
    expect(await contentStore.addOrUpdateItem(bag)).toBeNull();
    expect((await draftEditor.upsertItem(versionId, helm)).success).toBe(true);
  });
});

describe('MCP authoring of gear', () => {
  it('validate_draft flags bad bags and attributes on items and sets', async () => {
    const { contentStore, versionStore, deps } = await draftSetup();
    const snapshot = contentStore.toSnapshot();
    snapshot.items.push({ id: 'bad_bag', name: 'Bad Bag', rarity: 'common', bagSlots: 5, equipSlot: 'back' });
    snapshot.items.push({ id: 'bad_attr', name: 'Bad', rarity: 'common', attributes: { luck: 1 } as never });
    snapshot.sets = [{ id: 's', name: 'S', itemIds: [], breakpoints: [{ piecesRequired: 1, bonuses: { attributes: { strength: 0.5 } } }] }];
    const version = await versionStore.createDraft('bad', null, snapshot);
    const result = await validateDraft(deps, version.id);
    expect(result.problems?.some(p => p.includes("Item 'bad_bag'"))).toBe(true);
    expect(result.problems?.some(p => p.includes("Item 'bad_attr'"))).toBe(true);
    expect(result.problems?.some(p => p.includes("Set 's' breakpoint 0 attributes"))).toBe(true);
  });

  it('documents the new item, set and shop fields in get_content_schema', async () => {
    const items = JSON.stringify(await getContentSchema({ type: 'items' }));
    expect(items).toContain('bagSlots');
    expect(items).toContain('attributes');
    expect(JSON.stringify(await getContentSchema({ type: 'sets' }))).toContain('attributes');
  });
});
