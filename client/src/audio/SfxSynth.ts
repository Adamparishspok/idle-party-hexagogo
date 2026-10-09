import type { SfxId } from '@idle-party-rpg/shared';

/**
 * Procedural placeholder sounds, synthesized with plain Web Audio nodes.
 *
 * These are the audio twin of the CSS fallbacks behind painted UI chrome:
 * every sound event has one, so the game is never silent, and a real file
 * dropped into `data/sfx/{id}.ogg` (or `.mp3`) replaces it with no code change.
 *
 * Design rules for the recipes: short (most under 300ms, jingles under ~1s),
 * soft attacks so nothing clicks, quick exponential decays so overlapping
 * combat sounds don't smear into mush, and peak levels kept low because a
 * tap sound you hear 500 times a session must never be grating.
 */

/** Where a recipe draws: the context, the node to feed, and the start time. */
export interface SynthTarget {
  ctx: BaseAudioContext;
  dest: AudioNode;
  t: number;
}

/** A recipe schedules its nodes and returns its length in seconds. */
export type SynthRecipe = (o: SynthTarget) => number;

interface ToneSpec {
  type?: OscillatorType;
  freq: number;
  /** Glide target; the pitch sweeps exponentially to it across `dur`. */
  freqEnd?: number;
  start?: number;
  dur: number;
  gain: number;
  attack?: number;
}

interface NoiseSpec {
  filter: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  start?: number;
  dur: number;
  gain: number;
  attack?: number;
}

/** Exponential ramps can't touch zero, so envelopes decay to this instead. */
const SILENT = 0.0001;

/** One second of white noise per context, reused by every noise voice. */
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(ctx);
  if (buf) return buf;
  buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffers.set(ctx, buf);
  return buf;
}

/** Attack-then-exponential-decay envelope on a fresh gain node. */
function envelope(o: SynthTarget, start: number, dur: number, peak: number, attack: number): GainNode {
  const g = o.ctx.createGain();
  const t0 = o.t + start;
  g.gain.setValueAtTime(SILENT, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(SILENT, t0 + dur);
  g.connect(o.dest);
  return g;
}

function tone(o: SynthTarget, s: ToneSpec): void {
  const start = s.start ?? 0;
  const t0 = o.t + start;
  const osc = o.ctx.createOscillator();
  osc.type = s.type ?? 'sine';
  osc.frequency.setValueAtTime(s.freq, t0);
  if (s.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(s.freqEnd, t0 + s.dur);
  osc.connect(envelope(o, start, s.dur, s.gain, s.attack ?? 0.005));
  osc.start(t0);
  osc.stop(t0 + s.dur + 0.02);
}

function noise(o: SynthTarget, s: NoiseSpec): void {
  const start = s.start ?? 0;
  const t0 = o.t + start;
  const src = o.ctx.createBufferSource();
  src.buffer = noiseBuffer(o.ctx);
  const filter = o.ctx.createBiquadFilter();
  filter.type = s.filter;
  filter.Q.value = s.q ?? 1;
  filter.frequency.setValueAtTime(s.freq, t0);
  if (s.freqEnd !== undefined) filter.frequency.exponentialRampToValueAtTime(s.freqEnd, t0 + s.dur);
  src.connect(filter);
  filter.connect(envelope(o, start, s.dur, s.gain, s.attack ?? 0.003));
  src.start(t0);
  src.stop(t0 + s.dur + 0.02);
}

// Note frequencies (Hz) for the jingles.
const C4 = 261.63, EB4 = 311.13, G4 = 392.0;
const C5 = 523.25, E5 = 659.25, G5 = 783.99, B5 = 987.77;
const C6 = 1046.5, D6 = 1174.66, E6 = 1318.51, G6 = 1567.98;
const C7 = 2093.0, E7 = 2637.02;

export const SFX_RECIPES: Record<SfxId, SynthRecipe> = {
  // A soft wooden "tick": a falling triangle blip plus a breath of air.
  'ui-tap': (o) => {
    tone(o, { type: 'triangle', freq: 1100, freqEnd: 700, dur: 0.05, gain: 0.22 });
    noise(o, { filter: 'highpass', freq: 3000, dur: 0.015, gain: 0.06 });
    return 0.06;
  },
  // Rising "whoop" — a panel sliding up.
  'ui-open': (o) => {
    tone(o, { type: 'triangle', freq: 440, freqEnd: 880, dur: 0.12, gain: 0.16 });
    tone(o, { freq: 660, freqEnd: 1320, start: 0.03, dur: 0.12, gain: 0.08 });
    noise(o, { filter: 'bandpass', freq: 800, freqEnd: 2400, dur: 0.12, gain: 0.05, attack: 0.03 });
    return 0.16;
  },
  // The open sound in reverse, slightly shorter so dismissing feels snappy.
  'ui-close': (o) => {
    tone(o, { type: 'triangle', freq: 880, freqEnd: 440, dur: 0.1, gain: 0.15 });
    noise(o, { filter: 'bandpass', freq: 2400, freqEnd: 800, dur: 0.1, gain: 0.04, attack: 0.02 });
    return 0.12;
  },
  // A rounded "tock" with a faint chime overtone — distinct from ui-tap.
  'tab-switch': (o) => {
    tone(o, { freq: 520, freqEnd: 640, dur: 0.07, gain: 0.22 });
    tone(o, { type: 'triangle', freq: 1240, start: 0.02, dur: 0.06, gain: 0.07 });
    noise(o, { filter: 'bandpass', freq: 1800, dur: 0.02, gain: 0.05, q: 2 });
    return 0.09;
  },
  // Punchy thud: a filtered noise smack over a falling sub "body".
  hit: (o) => {
    noise(o, { filter: 'lowpass', freq: 1800, freqEnd: 400, dur: 0.12, gain: 0.3 });
    tone(o, { freq: 160, freqEnd: 55, dur: 0.12, gain: 0.35 });
    return 0.14;
  },
  // Bigger hit: brighter crack on top, a gritty square layer, deeper boom.
  'hit-crit': (o) => {
    noise(o, { filter: 'highpass', freq: 5000, dur: 0.05, gain: 0.12 });
    noise(o, { filter: 'lowpass', freq: 3000, freqEnd: 500, dur: 0.2, gain: 0.38 });
    tone(o, { type: 'square', freq: 220, freqEnd: 70, dur: 0.18, gain: 0.1 });
    tone(o, { freq: 120, freqEnd: 40, dur: 0.22, gain: 0.45 });
    return 0.24;
  },
  // A blade cutting air: a swept band of noise with a slow-ish attack.
  miss: (o) => {
    noise(o, { filter: 'bandpass', freq: 2500, freqEnd: 500, q: 2, dur: 0.18, gain: 0.16, attack: 0.04 });
    return 0.2;
  },
  // Gentle rising sparkle arpeggio (G5–B5–D6–G6) with a shimmering tail.
  heal: (o) => {
    [G5, B5, D6, G6].forEach((f, i) => tone(o, { freq: f, start: i * 0.06, dur: 0.25, gain: 0.1 }));
    tone(o, { type: 'triangle', freq: G6 * 2, start: 0.18, dur: 0.3, gain: 0.03 });
    return 0.5;
  },
  // Magical "power up" swoosh: two rising sweeps plus a brightening noise band.
  skill: (o) => {
    tone(o, { type: 'square', freq: 260, freqEnd: 1040, dur: 0.22, gain: 0.05 });
    tone(o, { freq: 520, freqEnd: 2080, dur: 0.22, gain: 0.1 });
    noise(o, { filter: 'bandpass', freq: 1000, freqEnd: 4000, dur: 0.22, gain: 0.07, attack: 0.05 });
    return 0.26;
  },
  // Short major fanfare: C–E–G then a held high C with a bell overtone.
  victory: (o) => {
    [C5, E5, G5].forEach((f, i) => tone(o, { type: 'triangle', freq: f, start: i * 0.09, dur: 0.14, gain: 0.18 }));
    tone(o, { type: 'triangle', freq: C6, start: 0.27, dur: 0.45, gain: 0.2 });
    tone(o, { freq: E6, start: 0.27, dur: 0.45, gain: 0.06 });
    return 0.75;
  },
  // Slow descending minor triad (G–Eb–C) over a low drone — sad, not harsh.
  defeat: (o) => {
    [G4, EB4, C4].forEach((f, i) => tone(o, { type: 'triangle', freq: f, start: i * 0.18, dur: i === 2 ? 0.6 : 0.3, gain: 0.18 }));
    tone(o, { freq: C4 / 2, start: 0.36, dur: 0.6, gain: 0.12, attack: 0.05 });
    return 1.0;
  },
  // The big one: fast climbing arpeggio, a bright chord, and a sparkle wash.
  'level-up': (o) => {
    [C5, E5, G5, C6, E6, G6].forEach((f, i) => {
      tone(o, { type: 'triangle', freq: f, start: i * 0.07, dur: 0.18, gain: 0.13 });
      tone(o, { type: 'square', freq: f, start: i * 0.07, dur: 0.12, gain: 0.03 });
    });
    [C6, E6, G6].forEach((f) => tone(o, { freq: f, start: 0.42, dur: 0.6, gain: 0.09 }));
    noise(o, { filter: 'highpass', freq: 6000, start: 0.42, dur: 0.4, gain: 0.03, attack: 0.05 });
    return 1.05;
  },
  // Classic two-note coin "bling" (B5 → E6).
  coin: (o) => {
    tone(o, { type: 'square', freq: B5, dur: 0.06, gain: 0.07 });
    tone(o, { type: 'square', freq: E6, start: 0.06, dur: 0.25, gain: 0.07 });
    return 0.32;
  },
  // Treasure glint: three quick high pings and a whisper of air.
  loot: (o) => {
    [G6, C7, E7].forEach((f, i) => tone(o, { freq: f, start: i * 0.05, dur: 0.2, gain: 0.1 }));
    noise(o, { filter: 'highpass', freq: 7000, dur: 0.25, gain: 0.025 });
    return 0.35;
  },
  // Armour clank: a metallic click, a low knock, and two inharmonic rings.
  equip: (o) => {
    noise(o, { filter: 'highpass', freq: 2000, dur: 0.06, gain: 0.16 });
    tone(o, { type: 'square', freq: 330, freqEnd: 220, dur: 0.08, gain: 0.07 });
    tone(o, { freq: 1400, dur: 0.3, gain: 0.07 });
    tone(o, { freq: 2150, dur: 0.2, gain: 0.035 });
    return 0.32;
  },
  // Anvil "ding" (bell partials) followed by a satisfied two-note rise.
  'craft-complete': (o) => {
    noise(o, { filter: 'highpass', freq: 3000, dur: 0.03, gain: 0.16 });
    tone(o, { freq: C6, dur: 0.7, gain: 0.13 });
    tone(o, { freq: C6 * 2.52, dur: 0.4, gain: 0.05 });
    tone(o, { type: 'triangle', freq: E6, start: 0.12, dur: 0.35, gain: 0.09 });
    tone(o, { type: 'triangle', freq: G6, start: 0.2, dur: 0.45, gain: 0.09 });
    return 0.75;
  },
  // Two tiny rising "bloops" — noticeable but very quiet.
  'chat-message': (o) => {
    tone(o, { freq: 1200, freqEnd: 1500, dur: 0.05, gain: 0.07 });
    tone(o, { freq: 1500, freqEnd: 1800, start: 0.07, dur: 0.05, gain: 0.05 });
    return 0.14;
  },
  // Soft two-tone doorbell (E6 → B5).
  notification: (o) => {
    tone(o, { freq: E6, dur: 0.25, gain: 0.12 });
    tone(o, { type: 'triangle', freq: E7, dur: 0.1, gain: 0.025 });
    tone(o, { freq: B5, start: 0.12, dur: 0.35, gain: 0.1 });
    return 0.5;
  },
  // Low double buzz — "nope" — kept short and quiet so it never feels punishing.
  error: (o) => {
    tone(o, { type: 'square', freq: 180, dur: 0.09, gain: 0.07 });
    tone(o, { type: 'square', freq: 150, start: 0.12, dur: 0.12, gain: 0.07 });
    return 0.26;
  },
};
