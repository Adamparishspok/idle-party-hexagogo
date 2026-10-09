import { describe, it, expect } from 'vitest';
import {
  ASSET_KINDS,
  ASSET_KIND_INFO,
  MANAGED_ASSET_KINDS,
  DEFERRED_ASSET_KINDS,
  isAssetKind,
  isManagedAssetKind,
  isDeferredAssetKind,
  isValidAssetId,
  assetPublicPath,
  canonicalAssetId,
  assetFileExtension,
  assetFileExtensions,
  isAudioAssetKind,
  SFX_IDS,
} from '../src/index.js';

describe('asset kind registry', () => {
  it('splits every kind into exactly one of managed or deferred', () => {
    // The guard behind the registry: a kind added to ASSET_KINDS without being
    // classified would silently be invisible to both the API and the docs.
    const managed = new Set<string>(MANAGED_ASSET_KINDS);
    const deferred = new Set<string>(DEFERRED_ASSET_KINDS);

    for (const kind of ASSET_KINDS) {
      expect(managed.has(kind) || deferred.has(kind), `"${kind}" is neither managed nor deferred`).toBe(true);
      expect(managed.has(kind) && deferred.has(kind), `"${kind}" is both managed and deferred`).toBe(false);
    }
    expect(managed.size + deferred.size).toBe(ASSET_KINDS.length);
  });

  it('only lists real kinds as managed or deferred', () => {
    for (const kind of [...MANAGED_ASSET_KINDS, ...DEFERRED_ASSET_KINDS]) {
      expect(isAssetKind(kind)).toBe(true);
    }
  });

  it('gives every kind a distinct folder and mount', () => {
    const dirs = ASSET_KINDS.map(kind => ASSET_KIND_INFO[kind].dir);
    const mounts = ASSET_KINDS.map(kind => ASSET_KIND_INFO[kind].mount);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(new Set(mounts).size).toBe(mounts.length);
    for (const mount of mounts) expect(mount.startsWith('/')).toBe(true);
  });

  it('points every declared fallback at a kind that exists', () => {
    for (const kind of ASSET_KINDS) {
      for (const fallback of ASSET_KIND_INFO[kind].fallbacks ?? []) {
        expect(isAssetKind(fallback.kind)).toBe(true);
      }
    }
  });

  it('narrows kinds without being fooled by inherited object keys', () => {
    // The allow-list is scanned as an array precisely so these don't pass.
    expect(isAssetKind('constructor')).toBe(false);
    expect(isAssetKind('__proto__')).toBe(false);
    expect(isAssetKind('toString')).toBe(false);
    expect(isManagedAssetKind('constructor')).toBe(false);
    expect(isDeferredAssetKind('constructor')).toBe(false);
  });

  it('reports deferred kinds as unmanaged and vice versa', () => {
    expect(isDeferredAssetKind('shop')).toBe(true);
    expect(isManagedAssetKind('shop')).toBe(false);
    expect(isDeferredAssetKind('set')).toBe(true);
    expect(isManagedAssetKind('set')).toBe(false);
    expect(isManagedAssetKind('monster')).toBe(true);
    expect(isDeferredAssetKind('monster')).toBe(false);
  });

  it('rejects ids that could climb out of a kind folder', () => {
    expect(isValidAssetId('goblin_king')).toBe(true);
    expect(isValidAssetId('hatchetmill-3-7')).toBe(true);
    expect(isValidAssetId('../escape')).toBe(false);
    expect(isValidAssetId('a/b')).toBe(false);
    expect(isValidAssetId('a\\b')).toBe(false);
    expect(isValidAssetId('.hidden')).toBe(false);
    expect(isValidAssetId('nested..name')).toBe(false);
    expect(isValidAssetId('')).toBe(false);
  });

  it('folds class ids to one canonical spelling so all three render sites agree', () => {
    expect(canonicalAssetId('class', 'Knight')).toBe('knight');
    expect(assetPublicPath('class', 'Knight')).toBe('/class-artwork/knight.png');
    // class-icon deliberately keeps its casing — CLASS_ICONS requests Knight.png.
    expect(canonicalAssetId('class-icon', 'Knight')).toBe('Knight');
    expect(assetPublicPath('class-icon', 'Knight')).toBe('/class-icons/Knight.png');
  });

  it('serves every image kind as .png only, and the sound kind as .ogg then .mp3', () => {
    for (const kind of ASSET_KINDS) {
      if (kind === 'sfx') continue;
      expect(assetFileExtensions(kind)).toEqual(['png']);
      expect(isAudioAssetKind(kind)).toBe(false);
    }
    expect(assetFileExtensions('sfx')).toEqual(['ogg', 'mp3']);
    expect(assetFileExtension('sfx')).toBe('ogg');
    expect(isAudioAssetKind('sfx')).toBe(true);
    expect(assetPublicPath('sfx', 'level-up')).toBe('/sfx/level-up.ogg');
    expect(assetPublicPath('sfx', 'level-up', 'mp3')).toBe('/sfx/level-up.mp3');
    expect(assetPublicPath('monster', 'goblin')).toBe('/monster-artwork/goblin.png');
  });

  it('requires a sound file for exactly the fixed sound-event ids', () => {
    expect(ASSET_KIND_INFO.sfx.idSource).toBe('fixed');
    expect(ASSET_KIND_INFO.sfx.fixedIds).toEqual(SFX_IDS);
    expect(new Set(SFX_IDS).size).toBe(SFX_IDS.length);
    for (const id of SFX_IDS) expect(isValidAssetId(id)).toBe(true);
  });
});
