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
  fall: { wave: 'triangle', from: 330, to: 260, dur: 0.05, vol: 0.10 },
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
  private musicIndex = -1; // the first new game advances this to track 0
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

  // ---- Music: decoded once and looped through Web Audio, which loops without a gap ----
  private musicBuffers = new Map<string, Promise<AudioBuffer | null>>();
  private musicSource: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private musicStartedAt = 0; // ctx time when the current loop position was 0
  private musicOffset = 0; // seconds into the track when paused
  private musicToken = 0;

  private trackBuffer(url: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx!;
    let p = this.musicBuffers.get(url);
    if (!p) {
      p = fetch(url).then(r => r.arrayBuffer()).then(d => ctx.decodeAudioData(d)).catch(() => null);
      this.musicBuffers.set(url, p);
    }
    return p;
  }

  /** Start or resume background music; nextTrack moves on to the next song. */
  startMusic(nextTrack = false) {
    const tracks = this.skin.music ?? [];
    const ctx = this.ctx;
    if (!this.musicOn || !ctx || tracks.length === 0) return;
    if (nextTrack) { this.stopMusic(); this.musicIndex = (this.musicIndex + 1) % tracks.length; }
    if (this.musicSource) return;
    if (this.musicIndex < 0) this.musicIndex = 0;
    const token = ++this.musicToken;
    void this.trackBuffer(tracks[this.musicIndex]!).then(buf => {
      if (!buf || token !== this.musicToken || !this.musicOn) return;
      this.musicGain ??= ctx.createGain();
      this.musicGain.gain.value = 0.45;
      this.musicGain.connect(ctx.destination);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.musicGain);
      const offset = this.musicOffset % buf.duration;
      src.start(0, offset);
      this.musicStartedAt = ctx.currentTime - offset;
      this.musicSource = src;
    });
  }

  pauseMusic() {
    if (this.musicSource && this.ctx) this.musicOffset = this.ctx.currentTime - this.musicStartedAt;
    this.haltSource();
  }

  stopMusic() {
    this.haltSource();
    this.musicOffset = 0;
  }

  // ---- Title music: its own loop for the menus, separate from the in-game playlist ----
  private titleSource: AudioBufferSourceNode | null = null;
  private titleGain: GainNode | null = null;
  private titleToken = 0;

  /** Play (true) or fade out (false) the skin's title music. Needs unlock() first. */
  title(on: boolean) {
    const ctx = this.ctx;
    const url = this.skin.titleMusic;
    if (!on || !this.musicOn) {
      this.titleToken++;
      const src = this.titleSource, gain = this.titleGain;
      this.titleSource = null;
      if (src && gain && ctx) {
        // A short fade sounds nicer than a hard cut when a game starts.
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
        setTimeout(() => { try { src.stop(); } catch { /* stopped */ } src.disconnect(); }, 600);
      }
      this.titleGain = null;
      return;
    }
    if (this.titleSource || !ctx || !url) return;
    const token = ++this.titleToken;
    void this.trackBuffer(url).then(buf => {
      if (!buf || token !== this.titleToken || !this.musicOn || this.titleSource) return;
      const gain = ctx.createGain();
      gain.gain.value = 0.4;
      gain.connect(ctx.destination);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      src.start();
      this.titleSource = src;
      this.titleGain = gain;
    });
  }

  private haltSource() {
    this.musicToken++;
    try { this.musicSource?.stop(); } catch { /* already stopped */ }
    this.musicSource?.disconnect();
    this.musicSource = null;
  }
}
