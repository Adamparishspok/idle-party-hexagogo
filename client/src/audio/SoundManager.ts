import { SFX_IDS, assetFileExtensions, assetPublicPath } from '@idle-party-rpg/shared';
import type { SfxId } from '@idle-party-rpg/shared';
import { SFX_RECIPES } from './SfxSynth';

/**
 * Game-wide sound effects.
 *
 * `sound.play(id)` is the whole API callers need. For each sound-event id the
 * manager first looks for a real file — `/sfx/{id}.ogg`, then `/sfx/{id}.mp3`
 * (the `sfx` asset kind's formats, in order) — and otherwise synthesizes a
 * procedural placeholder (`SfxSynth.ts`). That mirrors the art pipeline: files
 * are upgrades dropped into `data/sfx/`, never requirements.
 *
 * Constraints it handles so call sites don't have to:
 * - **iOS unlock**: browsers (iOS Safari especially) only let an AudioContext
 *   start inside a user gesture, so the context is created lazily on the first
 *   tap/key press and `play()` is a silent no-op before then. That doubles as
 *   "start muted until the player interacts".
 * - **Spam**: combat can produce several damage deltas per tick, and idle
 *   rewards arrive constantly. Each id has a minimum re-trigger interval, and
 *   the total number of overlapping voices is capped.
 * - **Missing files**: every URL that 404s (or comes back as the SPA's HTML
 *   fallback, or fails to decode — e.g. an Ogg file on an old Safari) is
 *   remembered and never fetched again this session; the id falls back to its
 *   placeholder.
 */

export interface PlayOptions {
  /** 0..1 multiplier on top of the master volume. */
  volume?: number;
}

/** Everything environment-specific, injectable so the logic is unit-testable. */
export interface SoundManagerDeps {
  createContext: () => AudioContext | null;
  fetch: (url: string) => Promise<Response>;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  now: () => number;
  /**
   * True while the page is in a background tab. Combat and rewards keep
   * ticking server-side, so without this a hidden tab would keep chiming.
   */
  isHidden?: () => boolean;
}

const VOLUME_KEY = 'idleparty.sfxVolume';
const MUTED_KEY = 'idleparty.sfxMuted';
/** Moderate by default — loud enough to notice, quiet enough not to startle. */
export const DEFAULT_VOLUME = 0.6;
/** Overlapping voices beyond this are dropped rather than queued. */
export const MAX_VOICES = 8;
/** Re-trigger floor for ids without their own entry below. */
const DEFAULT_MIN_INTERVAL_MS = 40;

/**
 * Per-id minimum gap between plays. Tuned so bursts read as one event: a tick
 * that damages three units makes one hit, and gold/loot from back-to-back idle
 * battles don't become a constant jingle.
 */
export const SFX_MIN_INTERVAL_MS: Partial<Record<SfxId, number>> = {
  'hit': 90,
  'hit-crit': 150,
  'miss': 150,
  'heal': 200,
  'skill': 200,
  'victory': 1000,
  'defeat': 1000,
  'level-up': 1500,
  'coin': 1500,
  'loot': 800,
  'equip': 150,
  'craft-complete': 600,
  'chat-message': 1000,
  'notification': 800,
  'error': 300,
};

/** Every URL tried for an id, in preference order (`.ogg` then `.mp3`). */
export function sfxCandidateUrls(id: SfxId): string[] {
  return assetFileExtensions('sfx').map(format => assetPublicPath('sfx', id, format));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * `decodeAudioData` is promise-based in modern browsers but callback-only in
 * older Safari, so accept whichever one fires.
 */
function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const maybe = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
  });
}

export class SoundManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume: number;
  private muted: boolean;
  private lastPlayed = new Map<SfxId, number>();
  /** End times (ms, deps.now clock) of voices still sounding. */
  private voiceEnds: number[] = [];
  /** Resolved file per id; `null` means "no usable file, use the placeholder". */
  private buffers = new Map<SfxId, AudioBuffer | null>();
  private loading = new Map<SfxId, Promise<AudioBuffer | null>>();
  /** URLs known not to hold a playable file — never fetched again. */
  private missingUrls = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private deps: SoundManagerDeps) {
    const storedVolume = this.read(VOLUME_KEY);
    this.volume = storedVolume === null ? DEFAULT_VOLUME : clamp01(Number(storedVolume));
    this.muted = this.read(MUTED_KEY) === 'true';
  }

  /**
   * Play a sound event. Returns whether a voice actually started — false when
   * muted, not yet unlocked, throttled, or over the voice cap.
   */
  play(id: SfxId, opts: PlayOptions = {}): boolean {
    if (this.muted || this.volume <= 0) return false;
    if (this.deps.isHidden?.()) return false;
    const ctx = this.ctx;
    if (!ctx || !this.master) return false;
    // A context the OS suspended (iOS backgrounding, phone call) can only be
    // resumed from a gesture; the gesture listener handles that, so don't
    // pile up voices that would all fire at once on resume.
    if (ctx.state !== 'running') return false;

    const now = this.deps.now();
    const minGap = SFX_MIN_INTERVAL_MS[id] ?? DEFAULT_MIN_INTERVAL_MS;
    const last = this.lastPlayed.get(id);
    if (last !== undefined && now - last < minGap) return false;

    this.voiceEnds = this.voiceEnds.filter(end => end > now);
    if (this.voiceEnds.length >= MAX_VOICES) return false;
    this.lastPlayed.set(id, now);

    const gain = ctx.createGain();
    gain.gain.value = clamp01(opts.volume ?? 1);
    gain.connect(this.master);

    let durationSec: number;
    const buffer = this.buffers.get(id);
    if (buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.start();
      durationSec = buffer.duration;
    } else {
      // No file (yet). Kick off the lookup if it hasn't run — this play uses
      // the placeholder so a tap never waits on the network.
      if (!this.buffers.has(id)) void this.loadFile(id);
      durationSec = SFX_RECIPES[id]({ ctx, dest: gain, t: ctx.currentTime });
    }
    this.voiceEnds.push(now + durationSec * 1000);
    return true;
  }

  /**
   * Create/resume the AudioContext. Must run inside a user-gesture handler to
   * satisfy iOS. Safe to call repeatedly.
   */
  unlock(): void {
    if (!this.ctx) {
      const ctx = this.deps.createContext();
      if (!ctx) return;
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(ctx.destination);
      // Resolve every id's file up front so the first real play of each one
      // already uses it instead of the placeholder.
      for (const id of SFX_IDS) void this.loadFile(id);
    }
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
  }

  /** True once an AudioContext exists (i.e. after the first gesture). */
  isUnlocked(): boolean {
    return this.ctx !== null;
  }

  getVolume(): number {
    return this.volume;
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume);
    if (this.master) this.master.gain.value = this.volume;
    this.write(VOLUME_KEY, String(this.volume));
    this.emit();
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.write(MUTED_KEY, muted ? 'true' : 'false');
    this.emit();
  }

  /** Subscribe to volume/mute changes. Returns unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * Resolve an id to a decoded file, trying each candidate URL in order and
   * remembering failures per URL. Resolves to null when only the placeholder
   * is available. Concurrent calls share one lookup.
   */
  loadFile(id: SfxId): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    const inFlight = this.loading.get(id);
    if (inFlight) return inFlight;
    const ctx = this.ctx;
    // Decoding needs a context; before unlock there's nothing to do yet, and
    // nothing is cached so the lookup reruns after unlock.
    if (!ctx) return Promise.resolve(null);

    const run = (async (): Promise<AudioBuffer | null> => {
      for (const url of sfxCandidateUrls(id)) {
        if (this.missingUrls.has(url)) continue;
        try {
          const res = await this.deps.fetch(url);
          // In production a missing static file falls through to the SPA's
          // index.html with a 200, so an HTML body counts as "not found".
          const type = res.headers.get('content-type') ?? '';
          if (!res.ok || type.includes('text/html')) {
            this.missingUrls.add(url);
            continue;
          }
          const buffer = await decode(ctx, await res.arrayBuffer());
          this.buffers.set(id, buffer);
          return buffer;
        } catch {
          // Network failure or an undecodable file (e.g. Ogg on Safari < 17.4):
          // remember it for the session and try the next format.
          this.missingUrls.add(url);
        }
      }
      this.buffers.set(id, null);
      return null;
    })();
    this.loading.set(id, run);
    void run.finally(() => this.loading.delete(id));
    return run;
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* a broken listener must not block the others */ }
    }
  }

  private read(key: string): string | null {
    try {
      return this.deps.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.deps.storage?.setItem(key, value);
    } catch {
      // Private mode / quota — the setting just won't persist.
    }
  }
}

function browserDeps(): SoundManagerDeps {
  const hasWindow = typeof window !== 'undefined';
  return {
    createContext: () => {
      if (!hasWindow) return null;
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        return new Ctor();
      } catch {
        return null;
      }
    },
    fetch: (url) => fetch(url),
    storage: (() => {
      try {
        return hasWindow ? window.localStorage : null;
      } catch {
        return null;
      }
    })(),
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  };
}

/** The game's one sound manager. */
export const sound = new SoundManager(browserDeps());
