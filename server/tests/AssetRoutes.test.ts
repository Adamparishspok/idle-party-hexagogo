import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';

// ContentStore and AssetStore resolve their folders from process.cwd(), so chdir before the dynamic imports.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type AssetStoreCtor = typeof import('../src/game/AssetStore.js').AssetStore;

let ContentStore: ContentStoreCtor;
let AssetStore: AssetStoreCtor;
let assetRoutes: typeof import('../src/admin/assetRoutes.js');
let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-routes-'));
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
  ({ AssetStore } = await import('../src/game/AssetStore.js'));
  assetRoutes = await import('../src/admin/assetRoutes.js');
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([signature, ihdr]);
}

async function startServer(): Promise<{ server: Server; base: string }> {
  const content = new ContentStore();
  await content.load();
  const router = express.Router();
  assetRoutes.registerAssetRoutes(router, { contentStore: () => content, assetStore: new AssetStore() });
  router.use(assetRoutes.assetUploadErrorHandler);
  const app = express();
  app.use('/api/admin', router);
  const server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}/api/admin` };
}

function upload(base: string, kind: string, id: string, png: Buffer): Promise<Response> {
  const form = new FormData();
  form.append('artwork', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${id}.png`);
  return fetch(`${base}/assets/${kind}/${encodeURIComponent(id)}`, { method: 'POST', body: form });
}

describe('asset routes', () => {
  it('accepts shop uploads keyed by shop id now that shop is no longer deferred', async () => {
    const { server, base } = await startServer();
    try {
      const res = await upload(base, 'shop', 'emberfall_general', makePng(64, 64));
      expect(res.status).toBe(200);
      const body = await res.json() as { asset: { url: string } };
      expect(body.asset.url.startsWith('/shop-artwork/emberfall_general.png')).toBe(true);

      const kinds = await (await fetch(`${base}/assets`)).json() as { kinds: Record<string, unknown>; deferred: { kind: string }[] };
      expect(kinds.kinds.shop).toBeDefined();
      expect(kinds.deferred.map(d => d.kind)).not.toContain('shop');
    } finally {
      server.close();
    }
  });

  it('still refuses the deferred set kind', async () => {
    const { server, base } = await startServer();
    try {
      expect((await upload(base, 'set', 'iron_set', makePng(64, 64))).status).toBe(400);
      expect((await fetch(`${base}/assets/coverage?kind=set`)).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('accepts room-GUID and zone-id keys for the backdrop kinds, and entity ids for npc and henchman', async () => {
    const { server, base } = await startServer();
    try {
      const wide = makePng(640, 320);
      const guid = '8c1e2f9a-3b4d-4e5f-9a6b-7c8d9e0f1a2b';
      expect((await upload(base, 'room-bg', guid, wide)).status).toBe(200);
      expect((await upload(base, 'combat-bg', 'hatchetmill', wide)).status).toBe(200);
      expect((await upload(base, 'tile', guid, makePng(64, 64))).status).toBe(200);
      expect((await upload(base, 'npc', 'old_tom', makePng(64, 64))).status).toBe(200);
      expect((await upload(base, 'henchman', 'brutus', makePng(64, 64))).status).toBe(200);

      const listed = await (await fetch(`${base}/assets/room-bg`)).json() as { assets: { id: string }[] };
      expect(listed.assets.map(a => a.id)).toContain(guid);
    } finally {
      server.close();
    }
  });

  it('serves the coverage report with shop included', async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/assets/coverage`);
      expect(res.status).toBe(200);
      const report = await res.json() as { kinds: { kind: string }[] };
      expect(report.kinds.map(k => k.kind)).toContain('shop');
      expect(report.kinds.map(k => k.kind)).not.toContain('set');
    } finally {
      server.close();
    }
  });
});
