// Sound. If the skin names sound files we play those; otherwise we synthesize
// small blips with Web Audio so the game is never silent while assets are
// being chosen. Browsers (iOS especially) only allow audio after a tap or key
// press, so unlock() must be called from such an event.

import type { Skin, SoundName } from './skin';

type Blip = { wave: OscillatorType; from: number; to: number; dur: number; vol: number; notes?: number[] };

const GENERATED: Record<SoundName, Blip> = {
  move: { wave: 'square', from: 520, to: 520, dur: 0.04, vol: 0.05 },
  rotate: { wave: 'square', from: 640, to: 900, dur: 0.06, vol: 0.05 },
  lock: { wave: 'triangle', from: 220, to: 110, dur: 0.09, vol: 0.18 },
  pop: { wave: 'sine', from: 500, to: 1400, dur: 0.12, vol: 0.2 },
  chain: { wave: 'sine', from: 700, to: 2000, dur: 0.14, vol: 0.2 },
  win: { wave: 'square', from: 0, to: 0, dur: 0.12, vol: 0.08, notes: [523, 659, 784, 1047] },
  lose: { wave: 'triangle', from: 0, to: 0, dur: 0.18, vol: 0.18, notes: [392, 330, 262, 196] },
  select: { wave: 'square', from: 880, to: 880, dur: 0.05, vol: 0.05 },
  pause: { wave: 'triangle', from: 660, to: 440, dur: 0.1, vol: 0.12 },
};

export class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private musicEl: HTMLAudioElement | null = null;
  private musicIndex = 0;
  soundOn = true;
  musicOn = true;

  constructor(private skin: Skin) {}

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      void this.loadSkinSounds();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private async loadSkinSounds() {
    const ctx = this.ctx;
    if (!ctx || !this.skin.sounds) return;
    await Promise.all(Object.entries(this.skin.sounds).map(async ([name, url]) => {
      try {
        const data = await (await fetch(url)).arrayBuffer();
        this.buffers.set(name as SoundName, await ctx.decodeAudioData(data));
      } catch { /* fall back to the generated sound */ }
    }));
  }

  play(name: SoundName, pitch = 1) {
    const ctx = this.ctx;
    if (!this.soundOn || !ctx || ctx.state !== 'running') return;
    const buf = this.buffers.get(name);
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pitch;
      src.connect(ctx.destination);
      src.start();
      return;
    }
    const b = GENERATED[name];
    const notes = b.notes ?? [b.from];
    notes.forEach((freq, i) => {
      const t0 = ctx.currentTime + i * b.dur;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = b.wave;
      osc.frequency.setValueAtTime(freq * pitch, t0);
      if (!b.notes) osc.frequency.exponentialRampToValueAtTime(Math.max(1, b.to * pitch), t0 + b.dur);
      gain.gain.setValueAtTime(b.vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + b.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + b.dur + 0.02);
    });
  }

  /** Start (or keep playing) background music; each new game moves to the next track. */
  startMusic(nextTrack = false) {
    const tracks = this.skin.music ?? [];
    if (!this.musicOn || tracks.length === 0) return;
    if (nextTrack || !this.musicEl) {
      this.stopMusic();
      if (nextTrack) this.musicIndex = (this.musicIndex + 1) % tracks.length;
      this.musicEl = new Audio(tracks[this.musicIndex]);
      this.musicEl.loop = true;
      this.musicEl.volume = 0.45;
    }
    void this.musicEl.play().catch(() => undefined);
  }

  pauseMusic() {
    this.musicEl?.pause();
  }

  stopMusic() {
    if (this.musicEl) { this.musicEl.pause(); this.musicEl.src = ''; this.musicEl = null; }
  }
}
