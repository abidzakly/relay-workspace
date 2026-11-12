import { useUiStore } from '@/store/ui';

/**
 * Reward sounds: marimba, wood and a toy whistle, all synthesised with Web Audio, so there are no remote assets.
 * Off by default. Nothing plays before the first user gesture, even when it is turned on, and the audio context is not
 * even created until then. It never plays in a hidden tab.
 */
export type SoundLevel = 'tick' | 'pop' | 'burst' | 'event';

type AudioContextClass = typeof AudioContext;

let ctx: AudioContext | null = null;
let gestured = false;
let listening = false;

function onGesture() {
  gestured = true;
  document.removeEventListener('pointerdown', onGesture, true);
  document.removeEventListener('keydown', onGesture, true);
}

/** Watches for the first gesture. Call once when the app mounts; calling again is harmless. */
export function listenForFirstGesture(): void {
  if (listening || gestured) return;
  listening = true;
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);
}

function context(): AudioContext | null {
  if (!gestured) return null;
  if (ctx) return ctx;
  const Ctor: AudioContextClass | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** A marimba bar: a sine with a quiet fourth-harmonic partial, both decaying fast. */
function marimba(c: AudioContext, freq: number, at: number, gain = 0.22): void {
  for (const [ratio, level, decay] of [
    [1, 1, 0.5],
    [4, 0.25, 0.14],
  ] as const) {
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * ratio;
    amp.gain.setValueAtTime(gain * level, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(amp).connect(c.destination);
    osc.start(at);
    osc.stop(at + decay + 0.02);
  }
}

/** A wooden tap: a very short burst of band-passed noise. */
function wood(c: AudioContext, at: number, gain = 0.3): void {
  const length = Math.floor(c.sampleRate * 0.04);
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const source = c.createBufferSource();
  source.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1100;
  filter.Q.value = 3;
  const amp = c.createGain();
  amp.gain.value = gain;
  source.connect(filter).connect(amp).connect(c.destination);
  source.start(at);
}

/** A toy whistle: a sine gliding up, with a short fade at each end. */
function whistle(c: AudioContext, from: number, to: number, at: number, length: number): void {
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(0.12, at + 0.04);
  amp.gain.setValueAtTime(0.12, at + length - 0.06);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(amp).connect(c.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

const SCORE: Record<SoundLevel, (c: AudioContext, t: number) => void> = {
  tick: (c, t) => wood(c, t),
  pop: (c, t) => {
    wood(c, t, 0.18);
    marimba(c, 659.25, t + 0.02);
  },
  burst: (c, t) => {
    marimba(c, 523.25, t);
    marimba(c, 659.25, t + 0.1);
    marimba(c, 783.99, t + 0.2);
  },
  event: (c, t) => {
    whistle(c, 880, 1320, t, 0.45);
    marimba(c, 523.25, t + 0.4);
    marimba(c, 659.25, t + 0.5);
    marimba(c, 783.99, t + 0.6);
    marimba(c, 1046.5, t + 0.72, 0.26);
  },
};

/** Best effort: a browser that refuses audio simply stays silent. Visual feedback never depends on this. */
export function playSound(level: SoundLevel): void {
  if (!useUiStore.getState().soundOn || document.hidden) return;
  const c = context();
  if (!c) return;
  try {
    if (c.state === 'suspended') void c.resume();
    SCORE[level](c, c.currentTime + 0.01);
  } catch {
    /* silence is fine */
  }
}
