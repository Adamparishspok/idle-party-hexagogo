/**
 * Copies the art/audio mapped in an asset-import manifest into a local data
 * folder (and, optionally, into an upload-ready tree for `tools/assets-cli.mjs`).
 *
 *   bun scripts/asset-import/apply-manifest.ts [--overwrite] [--data-dir server/data]
 *       [--manifest scripts/asset-import/bloodconquest-manifest.json] [--cli-dir <dir>]
 *
 * - Never overwrites an existing file unless `--overwrite` is passed — whatever
 *   is already in the data folder is treated as the user's real art.
 * - Image asset kinds are written as `<data-dir>/<kind dir>/<id>.png`, with the
 *   folder taken from `ASSET_KIND_INFO`. Non-square sources for square kinds are
 *   padded (transparent, centred) so they also pass the upload API's shape rule.
 *   JPEG sources can't become PNG without an image library, so they're skipped
 *   for asset kinds (staging kinds keep the .jpg).
 * - `nav-icon` entries are staged to `nav-icons-import/` rather than the live
 *   `nav-icons/` folder so the current icons can be compared before swapping.
 * - Audio goes to `<data-dir>/sfx/<id>.ogg`. Non-ogg sources are transcoded with
 *   ffmpeg when it is on PATH; otherwise they're copied with their own extension.
 * - `--cli-dir` additionally writes every real asset kind (nav icons included)
 *   as `<cli-dir>/<kind>/<id>.png`, the layout `node tools/assets-cli.mjs push`
 *   expects for uploading to production.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { ASSET_KIND_INFO, type AssetKind } from '../../shared/src/assets/AssetKinds.ts';

interface ManifestEntry {
  kind: string;
  id: string;
  source: string;
  note?: string;
}

interface Target {
  /** Folder under the data dir. */
  dir: string;
  /** Real asset kind (drives shape rules, lowercasing and the CLI export). */
  assetKind?: AssetKind;
  media: 'image' | 'audio';
}

/** Upload ceiling enforced by `AssetStore.write`. */
const MAX_ASSET_BYTES = 512 * 1024;

/** Kinds that only stage files for review — not served by the game yet. */
const STAGING_TARGETS: Record<string, Target> = {
  'nav-icon': { dir: 'nav-icons-import', assetKind: 'nav-icon', media: 'image' },
  'nav-icon-alt': { dir: 'nav-icons-import', media: 'image' },
  'map-prop': { dir: 'map-props', media: 'image' },
  'ui-candidate': { dir: 'ui-artwork-candidates', media: 'image' },
  sfx: { dir: 'sfx', media: 'audio' },
};

const args = process.argv.slice(2);
const overwrite = args.includes('--overwrite');
const dataDir = resolve(argValue('--data-dir') ?? 'server/data');
const manifestPath = resolve(argValue('--manifest') ?? join(import.meta.dir, 'bloodconquest-manifest.json'));
const cliDirArg = argValue('--cli-dir');
const cliDir = cliDirArg ? resolve(cliDirArg) : null;
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

type Outcome = 'written' | 'exists' | 'missing-source' | 'unsupported' | 'unknown-kind';
const tally = new Map<string, Record<Outcome, number>>();
const notes: string[] = [];
/** Lazily built CRC-32 table for the PNG encoder. */
let crcTable: Uint32Array | null = null;

main();

function main(): void {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestEntry[];
  console.log(`Manifest: ${manifestPath} (${manifest.length} entries)`);
  console.log(`Data dir: ${dataDir}${overwrite ? '  [--overwrite]' : ''}`);
  if (cliDir) console.log(`CLI dir:  ${cliDir}`);

  for (const entry of manifest) {
    record(entry.kind, applyEntry(entry));
  }

  console.log('\nSummary (kind: written / already present / missing source / unsupported)');
  for (const [kind, t] of tally) {
    const extra = t['unknown-kind'] ? `  unknown kind: ${t['unknown-kind']}` : '';
    console.log(`  ${kind.padEnd(14)} ${t.written} / ${t.exists} / ${t['missing-source']} / ${t.unsupported}${extra}`);
  }
  if (notes.length > 0) {
    console.log('\nNotes:');
    for (const n of notes) console.log(`  - ${n}`);
  }
}

function applyEntry(entry: ManifestEntry): Outcome {
  const target = resolveTarget(entry.kind);
  if (!target) {
    notes.push(`${entry.kind}/${entry.id}: unknown kind, skipped`);
    return 'unknown-kind';
  }
  if (!existsSync(entry.source)) {
    notes.push(`${entry.kind}/${entry.id}: source not found (${entry.source})`);
    return 'missing-source';
  }
  return target.media === 'audio' ? applyAudio(entry, target) : applyImage(entry, target);
}

function applyImage(entry: ManifestEntry, target: Target): Outcome {
  const info = target.assetKind ? ASSET_KIND_INFO[target.assetKind] : undefined;
  const id = info?.lowercaseIds ? entry.id.toLowerCase() : entry.id;
  const ext = extname(entry.source).toLowerCase();

  if (ext !== '.png') {
    if (target.assetKind) {
      notes.push(`${entry.kind}/${id}: ${ext} source can't be served as a PNG asset, skipped`);
      return 'unsupported';
    }
    // Staging folders keep the original format.
    return writeOnce(join(dataDir, target.dir, `${id}${ext}`), () => readFileSync(entry.source));
  }

  let png = readFileSync(entry.source);
  if (info?.shape === 'square') {
    const padded = padToSquare(png);
    if (padded === null) {
      notes.push(`${entry.kind}/${id}: non-square and in a PNG format this script can't re-encode — copied as-is`);
    } else {
      png = padded;
    }
  }
  if (target.assetKind && png.length > MAX_ASSET_BYTES) {
    notes.push(`${entry.kind}/${id}: ${(png.length / 1024).toFixed(0)} KB exceeds the 512 KB upload cap (local copy still works)`);
  }

  const outcome = writeOnce(join(dataDir, target.dir, `${id}.png`), () => png);
  if (cliDir && target.assetKind) {
    writeOnce(join(cliDir, target.assetKind, `${id}.png`), () => png);
  }
  return outcome;
}

function applyAudio(entry: ManifestEntry, target: Target): Outcome {
  const ext = extname(entry.source).toLowerCase();
  if (ext === '.ogg') {
    return writeOnce(join(dataDir, target.dir, `${entry.id}.ogg`), () => readFileSync(entry.source));
  }
  if (hasFfmpeg) {
    const dest = join(dataDir, target.dir, `${entry.id}.ogg`);
    if (existsSync(dest) && !overwrite) return 'exists';
    mkdirSync(dirname(dest), { recursive: true });
    // The native vorbis encoder is always built in; libvorbis often isn't.
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', entry.source,
      '-c:a', 'vorbis', '-strict', '-2', '-ac', '2', '-q:a', '5', dest]);
    if (r.status === 0) {
      notes.push(`sfx/${entry.id}: transcoded ${ext} -> .ogg`);
      return 'written';
    }
    notes.push(`sfx/${entry.id}: ffmpeg failed (${r.stderr?.toString().trim()}), copying ${ext} as-is`);
  } else {
    notes.push(`sfx/${entry.id}: no ffmpeg on PATH, kept as ${ext}`);
  }
  return writeOnce(join(dataDir, target.dir, `${entry.id}${ext}`), () => readFileSync(entry.source));
}

function resolveTarget(kind: string): Target | null {
  const staged = STAGING_TARGETS[kind];
  if (staged) return staged;
  if (kind in ASSET_KIND_INFO) {
    const assetKind = kind as AssetKind;
    return { dir: ASSET_KIND_INFO[assetKind].dir.replace(/^data\//, ''), assetKind, media: 'image' };
  }
  return null;
}

function writeOnce(dest: string, content: () => Buffer): Outcome {
  if (existsSync(dest) && !overwrite) return 'exists';
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content());
  return 'written';
}

function record(kind: string, outcome: Outcome): void {
  let t = tally.get(kind);
  if (!t) {
    t = { written: 0, exists: 0, 'missing-source': 0, unsupported: 0, 'unknown-kind': 0 };
    tally.set(kind, t);
  }
  t[outcome]++;
}

function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ── Minimal PNG re-encoder (8-bit, non-interlaced) ──────────────────────────

/**
 * Returns the PNG padded to a transparent square, the original buffer when it
 * is already square, or null for formats this decoder doesn't handle.
 */
function padToSquare(png: Buffer): Buffer | null {
  const decoded = decodePng(png);
  if (!decoded) {
    const { width, height } = readIhdr(png);
    return width === height ? png : null;
  }
  const { width, height, rgba } = decoded;
  if (width === height) return png;
  const size = Math.max(width, height);
  const out = Buffer.alloc(size * size * 4);
  const ox = Math.floor((size - width) / 2);
  const oy = Math.floor((size - height) / 2);
  for (let y = 0; y < height; y++) {
    rgba.copy(out, ((y + oy) * size + ox) * 4, y * width * 4, (y + 1) * width * 4);
  }
  return encodePng(size, size, out);
}

function readIhdr(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } | null {
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + len;
  }
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (bitDepth !== 8 || interlace !== 0 || channels === undefined) return null;
  if (colorType === 3 && !palette) return null;

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      pixels[y * stride + x] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    const o = i * 4;
    if (colorType === 6) pixels.copy(rgba, o, p, p + 4);
    else if (colorType === 2) {
      rgba[o] = pixels[p]; rgba[o + 1] = pixels[p + 1]; rgba[o + 2] = pixels[p + 2]; rgba[o + 3] = 255;
    } else if (colorType === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[p]; rgba[o + 3] = 255;
    } else if (colorType === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[p]; rgba[o + 3] = pixels[p + 1];
    } else {
      const idx = pixels[p];
      rgba[o] = palette![idx * 3]; rgba[o + 1] = palette![idx * 3 + 1]; rgba[o + 2] = palette![idx * 3 + 2];
      rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
