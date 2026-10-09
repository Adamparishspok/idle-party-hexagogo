import fs from 'fs/promises';
import path from 'path';
import { ASSET_KIND_INFO, isValidAssetId, canonicalAssetId, assetPublicPath, assetFileExtension, assetFileExtensions, isAudioAssetKind } from '@idle-party-rpg/shared';
import type { AssetKind, AssetFileFormat } from '@idle-party-rpg/shared';

/**
 * Swappable store for the game's imagery, satisfying the data-folder rule in
 * `docs/architecture/persistence.md`: artwork used to be written with raw
 * `fs.writeFile` calls straight out of the admin routes, which was the one
 * `data/` consumer with no store behind it.
 *
 * Every path is resolved from the process working directory, exactly like
 * `ContentStore` and `VersionStore`, so dev (cwd = `server/`) and production
 * (cwd = the deploy root) keep their own art without a hard-coded repo path.
 */

/** The 8 bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Upload ceiling, matching the multer limit the admin routes have always used. */
export const MAX_ASSET_BYTES = 512 * 1024;

export interface AssetFileInfo {
  id: string;
  kind: AssetKind;
  /** Public URL including a cache-busting version stamp. */
  url: string;
  bytes: number;
  /** Pixel width. Always 0 for audio kinds (`sfx`), which have no dimensions. */
  width: number;
  /** Pixel height. Always 0 for audio kinds. */
  height: number;
  /** ISO timestamp of the file's last write. */
  updatedAt: string;
}

/** Thrown for caller mistakes — routes map this to 400, MCP tools to an `error` field. */
export class AssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetValidationError';
  }
}

export interface PngHeader {
  width: number;
  height: number;
}

/**
 * Verify the bytes really are a PNG and pull the dimensions out of the IHDR
 * chunk. The old upload path trusted the client-declared multipart mime type
 * and then read offsets 16/20 regardless, so any file at all could be stored
 * as `.png` and any two garbage words could pass the square check.
 *
 * PNG layout: 8-byte signature, then the IHDR chunk as 4 bytes length,
 * the literal `IHDR`, 4 bytes width, 4 bytes height.
 */
export function inspectPng(buf: Buffer): PngHeader {
  if (buf.length < 24) throw new AssetValidationError('Not a valid PNG file — too small to contain a header.');
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new AssetValidationError('Not a valid PNG file — missing the PNG signature.');
  }
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new AssetValidationError('Not a valid PNG file — missing the IHDR header chunk.');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) throw new AssetValidationError('Not a valid PNG file — zero width or height.');
  return { width, height };
}


/**
 * Work out which audio format the bytes really are. There's no cheap
 * duration/dimension to pull out of audio, so this is purely a "is this really
 * a sound file" gate, mirroring why `inspectPng` exists: the multipart mime
 * type is caller-declared and can't be trusted.
 *
 * - OGG: every Ogg page starts with the capture pattern `OggS`.
 * - MP3: either an ID3v2 tag (`ID3`) or a bare MPEG audio frame sync (11 set
 *   bits) at offset 0.
 *
 * Returns the detected format so `write` can file the upload under the
 * extension its bytes actually are, whatever the uploader called it.
 */
export function inspectAudio(buf: Buffer, accepted: readonly AssetFileFormat[]): AssetFileFormat {
  const list = accepted.map(f => f.toUpperCase()).join(' or ');
  if (buf.length < 4) throw new AssetValidationError(`Not a valid ${list} file — too small to contain a header.`);
  let detected: AssetFileFormat | null = null;
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') detected = 'ogg';
  else if (buf.subarray(0, 3).toString('latin1') === 'ID3') detected = 'mp3';
  else if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) detected = 'mp3';
  if (!detected || !accepted.includes(detected)) {
    throw new AssetValidationError(`Not a valid ${list} file — sound effects must be ${list} (WAV and other formats are not accepted; convert first).`);
  }
  return detected;
}

export class AssetStore {
  /** Absolute path of a kind's folder. Resolved per call so tests can chdir. */
  private dirFor(kind: AssetKind): string {
    return path.resolve(ASSET_KIND_INFO[kind].dir);
  }

  /**
   * Resolve an id to its on-disk path, refusing anything that escapes the
   * kind's folder. The pattern check rejects separators and `..` runs up front;
   * the containment assertion is the belt-and-braces second gate, because this
   * id now arrives from bearer-token MCP clients and not just from an admin
   * clicking a modal.
   */
  private fileFor(kind: AssetKind, id: string, format: AssetFileFormat = assetFileExtension(kind)): string {
    if (!isValidAssetId(id)) {
      throw new AssetValidationError(`Invalid asset id "${id}" — letters, numbers, spaces, dots, dashes, and underscores only.`);
    }
    const canonical = canonicalAssetId(kind, id);
    const dir = this.dirFor(kind);
    const name = `${canonical}.${format}`;
    const file = path.resolve(dir, name);
    if (file !== path.join(dir, name) || !file.startsWith(dir + path.sep)) {
      throw new AssetValidationError(`Invalid asset id "${id}" — resolves outside the ${kind} folder.`);
    }
    return file;
  }

  private urlFor(kind: AssetKind, id: string, format: AssetFileFormat, version: number): string {
    return `${assetPublicPath(kind, id, format)}?v=${Math.floor(version)}`;
  }

  /**
   * Ids present in a kind's folder. Cheap — a single readdir, no per-file stat.
   * This is what the coverage report joins against. An id stored under more
   * than one accepted format (sound effects) is listed once.
   */
  async listIds(kind: AssetKind): Promise<string[]> {
    const exts = assetFileExtensions(kind).map(f => `.${f}`);
    try {
      const entries = await fs.readdir(this.dirFor(kind), { withFileTypes: true });
      const ids = new Set<string>();
      for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = exts.find(x => e.name.toLowerCase().endsWith(x));
        if (ext) ids.add(e.name.slice(0, -ext.length));
      }
      return [...ids];
    } catch {
      // A kind with no folder yet simply has no art.
      return [];
    }
  }

  /** Full info for every asset of a kind, sorted by id. */
  async list(kind: AssetKind): Promise<AssetFileInfo[]> {
    const ids = await this.listIds(kind);
    const infos = await Promise.all(ids.sort().map(id => this.stat(kind, id)));
    return infos.filter((info): info is AssetFileInfo => info !== null);
  }

  /**
   * Info for one asset, or null when it doesn't exist. For multi-format kinds
   * the formats are tried in the same order the client tries them, so the
   * reported file is the one players actually hear.
   */
  async stat(kind: AssetKind, id: string): Promise<AssetFileInfo | null> {
    for (const format of assetFileExtensions(kind)) {
      const info = await this.statFormat(kind, id, format);
      if (info) return info;
    }
    return null;
  }

  /** True when a kind's folder holds art for this id. */
  async has(kind: AssetKind, id: string): Promise<boolean> {
    return (await this.stat(kind, id)) !== null;
  }

  /**
   * Validate and store a file — a PNG for image kinds, an OGG or MP3 for the
   * audio kind — replacing any existing asset for the id.
   * Throws `AssetValidationError` for anything the caller can fix.
   */
  async write(kind: AssetKind, id: string, data: Buffer): Promise<AssetFileInfo> {
    // Validate the id before touching the payload so a bad id is reported as such.
    this.fileFor(kind, id);
    const audio = isAudioAssetKind(kind);
    if (data.length === 0) throw new AssetValidationError('Uploaded file is empty.');
    if (data.length > MAX_ASSET_BYTES) {
      const noun = audio ? 'Sound' : 'Image';
      throw new AssetValidationError(`${noun} is ${Math.ceil(data.length / 1024)} KB — the limit is ${MAX_ASSET_BYTES / 1024} KB.`);
    }
    let format: AssetFileFormat = 'png';
    if (audio) {
      format = inspectAudio(data, assetFileExtensions(kind));
    } else {
      const { width, height } = inspectPng(data);
      if (ASSET_KIND_INFO[kind].shape === 'square' && width !== height) {
        throw new AssetValidationError(`${ASSET_KIND_INFO[kind].label} art must be square. Got ${width}x${height}.`);
      }
    }
    const file = this.fileFor(kind, id, format);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    // Drop the id's files in the kind's other formats: the client tries the
    // primary format first, so a stale `.ogg` would otherwise shadow a fresh
    // `.mp3` upload forever.
    for (const other of assetFileExtensions(kind)) {
      if (other === format) continue;
      await fs.unlink(this.fileFor(kind, id, other)).catch(() => undefined);
    }
    const info = await this.statFormat(kind, id, format);
    // statFormat() only returns null if the write vanished underneath us.
    if (!info) throw new Error(`Failed to read back ${kind} artwork "${id}" after writing it.`);
    return info;
  }

  /** Delete art for an id (in every accepted format). Returns whether a file was actually removed. */
  async remove(kind: AssetKind, id: string): Promise<boolean> {
    let removed = false;
    for (const format of assetFileExtensions(kind)) {
      const file = this.fileFor(kind, id, format);
      try {
        await fs.unlink(file);
        removed = true;
      } catch {
        // Not stored in this format.
      }
    }
    return removed;
  }

  private async statFormat(kind: AssetKind, id: string, format: AssetFileFormat): Promise<AssetFileInfo | null> {
    let file: string;
    try {
      file = this.fileFor(kind, id, format);
    } catch {
      // An unreadable id can't name an existing file.
      return null;
    }
    try {
      const stats = await fs.stat(file);
      if (!stats.isFile()) return null;
      // Only the 24-byte header is needed for dimensions — never read the body.
      const handle = await fs.open(file, 'r');
      try {
        const header = Buffer.alloc(24);
        const { bytesRead } = await handle.read(header, 0, 24, 0);
        let width = 0;
        let height = 0;
        if (format === 'png') {
          ({ width, height } = inspectPng(header.subarray(0, bytesRead)));
        } else if (inspectAudio(header.subarray(0, bytesRead), [format]) !== format) {
          return null;
        }
        return {
          // Report the spelling the file is actually stored under, which for
          // lowercase-folded kinds may differ from what the caller passed.
          id: canonicalAssetId(kind, id),
          kind,
          url: this.urlFor(kind, id, format, stats.mtimeMs),
          bytes: stats.size,
          width,
          height,
          updatedAt: new Date(stats.mtimeMs).toISOString(),
        };
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }
}
