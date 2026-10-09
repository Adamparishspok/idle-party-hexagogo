import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SFX_IDS } from '@idle-party-rpg/shared';
import { DEFAULT_VOLUME, MAX_VOICES, SoundManager, sfxCandidateUrls } from '../src/audio/SoundManager';
import type { SoundManagerDeps } from '../src/audio/SoundManager';
import { SFX_RECIPES } from '../src/audio/SfxSynth';

/**
 * Just enough of the Web Audio API for the manager and the synth recipes to
 * run: every node is a no-op that records what was started, so tests can tell
 * a decoded file (buffer source with a buffer) from a placeholder.
 */
function param() {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

class FakeAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = {};
  started: Array<{ kind: 'osc' | 'source'; buffer?: unknown }> = [];
  decodeAudioData = vi.fn(async (data: ArrayBuffer) => ({ duration: 0.2, tag: new TextDecoder().decode(data) }));
  resume = vi.fn(async () => { this.state = 'running'; });

  createGain() {
    return { gain: param(), connect: vi.fn() };
  }
  createOscillator() {
    const node = { type: 'sine', frequency: param(), connect: vi.fn(), start: () => this.started.push({ kind: 'osc' }), stop: vi.fn() };
    return node;
  }
  createBufferSource() {
    const node: { buffer: unknown; connect: unknown; start: () => void; stop: unknown } = {
      buffer: null,
      connect: vi.fn(),
      start: () => this.started.push({ kind: 'source', buffer: node.buffer }),
      stop: vi.fn(),
    };
    return node;
  }
  createBiquadFilter() {
    return { type: 'lowpass', Q: param(), frequency: param(), connect: vi.fn() };
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    data,
  };
}

function audioResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'audio/ogg' } });
}
const notFound = () => new Response('nope', { status: 404 });

interface Harness {
  mgr: SoundManager;
  ctx: FakeAudioContext;
  fetch: ReturnType<typeof vi.fn>;
  storage: ReturnType<typeof memoryStorage>;
  clock: { t: number };
}

function setup(opts: { files?: Record<string, () => Response>; storage?: Record<string, string>; hidden?: boolean } = {}): Harness {
  const ctx = new FakeAudioContext();
  const clock = { t: 1000 };
  const storage = memoryStorage(opts.storage);
  const files = opts.files ?? {};
  const fetch = vi.fn(async (url: string) => (files[url] ? files[url]() : notFound()));
  const deps: SoundManagerDeps = {
    createContext: () => ctx as unknown as AudioContext,
    fetch,
    storage,
    now: () => clock.t,
    isHidden: () => !!opts.hidden,
  };
  return { mgr: new SoundManager(deps), ctx, fetch, storage, clock };
}

/** Let every pending fetch/decode settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise(r => setTimeout(r, 0));
}

describe('SoundManager unlock', () => {
  it('stays silent until a user gesture unlocks the AudioContext', () => {
    const { mgr, ctx } = setup();
    expect(mgr.play('ui-tap')).toBe(false);
    expect(ctx.started).toHaveLength(0);
    mgr.unlock();
    expect(mgr.isUnlocked()).toBe(true);
    expect(mgr.play('ui-tap')).toBe(true);
    expect(ctx.started.length).toBeGreaterThan(0);
  });

  it('does not play while the page is hidden', () => {
    const { mgr } = setup({ hidden: true });
    mgr.unlock();
    expect(mgr.play('ui-tap')).toBe(false);
  });

  it('does not queue voices on a context the OS suspended', () => {
    const { mgr, ctx } = setup();
    mgr.unlock();
    ctx.state = 'suspended';
    expect(mgr.play('hit')).toBe(false);
  });
});

describe('SoundManager throttling', () => {
  it('drops rapid repeats of the same id but lets them through after the gap', () => {
    const { mgr, clock } = setup();
    mgr.unlock();
    expect(mgr.play('hit')).toBe(true);
    clock.t += 30;
    expect(mgr.play('hit')).toBe(false);
    clock.t += 100;
    expect(mgr.play('hit')).toBe(true);
  });

  it('throttles each id independently', () => {
    const { mgr } = setup();
    mgr.unlock();
    expect(mgr.play('hit')).toBe(true);
    expect(mgr.play('miss')).toBe(true);
    expect(mgr.play('heal')).toBe(true);
  });

  it('caps concurrent voices and frees slots as voices end', () => {
    const { mgr, clock } = setup();
    mgr.unlock();
    // Distinct ids so the per-id throttle doesn't interfere.
    const ids = SFX_IDS.slice(0, MAX_VOICES + 2);
    const results = ids.map(id => mgr.play(id));
    expect(results.filter(Boolean)).toHaveLength(MAX_VOICES);
    expect(results.slice(MAX_VOICES).every(r => !r)).toBe(true);
    // Every placeholder is well under 2s, so all slots are free again.
    clock.t += 2000;
    expect(mgr.play(ids[MAX_VOICES])).toBe(true);
  });
});

describe('SoundManager file lookup', () => {
  it('lists .ogg before .mp3 for every id', () => {
    expect(sfxCandidateUrls('level-up')).toEqual(['/sfx/level-up.ogg', '/sfx/level-up.mp3']);
  });

  it('prefers the .ogg file when it exists', async () => {
    const { mgr, fetch } = setup({ files: { '/sfx/hit.ogg': () => audioResponse('ogg'), '/sfx/hit.mp3': () => audioResponse('mp3') } });
    mgr.unlock();
    const buf = await mgr.loadFile('hit') as unknown as { tag: string };
    expect(buf.tag).toBe('ogg');
    expect(fetch.mock.calls.map(c => c[0])).not.toContain('/sfx/hit.mp3');
  });

  it('falls back to .mp3 when .ogg is missing', async () => {
    const { mgr } = setup({ files: { '/sfx/hit.mp3': () => audioResponse('mp3') } });
    mgr.unlock();
    const buf = await mgr.loadFile('hit') as unknown as { tag: string };
    expect(buf.tag).toBe('mp3');
  });

  it('falls back to .mp3 when the .ogg file cannot be decoded (e.g. older Safari)', async () => {
    const { mgr, ctx } = setup({ files: { '/sfx/hit.ogg': () => audioResponse('ogg'), '/sfx/hit.mp3': () => audioResponse('mp3') } });
    ctx.decodeAudioData.mockImplementationOnce(async () => { throw new Error('EncodingError'); });
    mgr.unlock();
    const buf = await mgr.loadFile('hit') as unknown as { tag: string };
    expect(buf.tag).toBe('mp3');
  });

  it('treats the SPA HTML fallback as a missing file', async () => {
    const html = () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const { mgr, ctx } = setup({ files: { '/sfx/hit.ogg': html, '/sfx/hit.mp3': html } });
    mgr.unlock();
    expect(await mgr.loadFile('hit')).toBeNull();
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
  });

  it('remembers 404s and never fetches the same URL twice', async () => {
    const { mgr, fetch } = setup();
    mgr.unlock(); // preloads every id once
    await flush();
    const callsAfterPreload = fetch.mock.calls.length;
    expect(callsAfterPreload).toBe(SFX_IDS.length * 2);
    expect(new Set(fetch.mock.calls.map(c => c[0])).size).toBe(callsAfterPreload);

    for (let i = 0; i < 5; i++) {
      await mgr.loadFile('hit');
      mgr.play('hit');
    }
    await flush();
    expect(fetch.mock.calls.length).toBe(callsAfterPreload);
  });

  it('shares one lookup between concurrent requests for the same id', async () => {
    const { mgr, fetch } = setup();
    mgr.unlock();
    // unlock() already started coin's lookup; these join it instead of refetching.
    await Promise.all([mgr.loadFile('coin'), mgr.loadFile('coin'), mgr.loadFile('coin')]);
    const coinCalls = fetch.mock.calls.filter(c => String(c[0]).startsWith('/sfx/coin')).length;
    expect(coinCalls).toBe(2); // one .ogg + one .mp3, once
  });

  it('plays the decoded file once resolved, and the placeholder otherwise', async () => {
    const { mgr, ctx, clock } = setup({ files: { '/sfx/coin.ogg': () => audioResponse('ogg') } });
    mgr.unlock();
    await flush();

    ctx.started = [];
    mgr.play('coin');
    expect(ctx.started).toEqual([{ kind: 'source', buffer: expect.objectContaining({ tag: 'ogg' }) }]);

    ctx.started = [];
    clock.t += 5000;
    mgr.play('loot');
    // Placeholder: oscillators and/or a noise source without a decoded file.
    expect(ctx.started.length).toBeGreaterThan(0);
    expect(ctx.started.some(s => s.kind === 'source' && (s.buffer as { tag?: string } | null)?.tag)).toBe(false);
  });

  it('does not fetch anything before unlock', async () => {
    const { mgr, fetch } = setup();
    expect(await mgr.loadFile('hit')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('SoundManager settings persistence', () => {
  it('defaults to unmuted at a moderate volume', () => {
    const { mgr } = setup();
    expect(mgr.isMuted()).toBe(false);
    expect(mgr.getVolume()).toBe(DEFAULT_VOLUME);
  });

  it('restores volume and mute from storage', () => {
    const { mgr } = setup({ storage: { 'idleparty.sfxVolume': '0.25', 'idleparty.sfxMuted': 'true' } });
    expect(mgr.getVolume()).toBe(0.25);
    expect(mgr.isMuted()).toBe(true);
  });

  it('writes changes back and clamps the volume to 0..1', () => {
    const { mgr, storage } = setup();
    mgr.setVolume(1.7);
    expect(mgr.getVolume()).toBe(1);
    mgr.setVolume(0.4);
    mgr.setMuted(true);
    expect(storage.data.get('idleparty.sfxVolume')).toBe('0.4');
    expect(storage.data.get('idleparty.sfxMuted')).toBe('true');
  });

  it('ignores a corrupt stored volume', () => {
    const { mgr } = setup({ storage: { 'idleparty.sfxVolume': 'loud' } });
    expect(mgr.getVolume()).toBe(0);
  });

  it('plays nothing when muted or at zero volume', () => {
    const { mgr, clock } = setup();
    mgr.unlock();
    mgr.setMuted(true);
    expect(mgr.play('ui-tap')).toBe(false);
    mgr.setMuted(false);
    mgr.setVolume(0);
    clock.t += 1000;
    expect(mgr.play('ui-tap')).toBe(false);
  });

  it('notifies listeners of changes', () => {
    const { mgr } = setup();
    const cb = vi.fn();
    const off = mgr.onChange(cb);
    mgr.setVolume(0.3);
    mgr.setMuted(true);
    off();
    mgr.setMuted(false);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('placeholder recipes', () => {
  let ctx: FakeAudioContext;
  beforeEach(() => { ctx = new FakeAudioContext(); });

  it('has a short recipe for every sound id that schedules at least one voice', () => {
    for (const id of SFX_IDS) {
      ctx.started = [];
      const dur = SFX_RECIPES[id]({ ctx: ctx as unknown as BaseAudioContext, dest: {} as AudioNode, t: 0 });
      expect(dur, id).toBeGreaterThan(0);
      expect(dur, id).toBeLessThanOrEqual(1.2);
      expect(ctx.started.length, id).toBeGreaterThan(0);
    }
  });
});
