// Saving. The fix for "the phone closed my game": the whole game state is
// written synchronously to localStorage whenever a piece lands and the moment
// the page is hidden. localStorage is synchronous, so the write is finished
// before iOS can freeze or kill the page.

import { deserialize, serialize, type GameState, type Speed } from '@bug-pop/engine';
import type { ExitStyle } from './skin';
import { deviceName, type SaveRecord } from './cloud';

const SAVE_KEY = 'bugpop.save.v1';
const SAVED_AT_KEY = 'bugpop.save.at.v1';
const SETTINGS_KEY = 'bugpop.settings.v1';

export type Settings = {
  level: number;
  speed: Speed;
  colors: number;
  shapesOnPieces: boolean;
  sound: boolean;
  music: boolean;
  exit: ExitStyle | '';
  look: 'site' | 'test';
  /** After clearing a level, start the next one by itself. */
  autoNext: boolean;
  /** Which on-screen button row touch players see (see layouts.ts). */
  touchLayout: 'edges' | 'four' | 'original';
};

export const defaultSettings: Settings = { level: 0, speed: 1, colors: 3, shapesOnPieces: true, sound: true, music: true, exit: '', look: 'site', autoNext: false, touchLayout: 'edges' };

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // private mode or storage full: the game still plays
  }
}

export function saveGame(s: GameState): boolean {
  const json = serialize(s);
  // Only a real change gets a new timestamp. Otherwise a device sitting paused
  // in the background would look "newer" than progress made on another device.
  if (read(SAVE_KEY) === json) return true;
  write(SAVED_AT_KEY, String(Date.now()));
  return write(SAVE_KEY, json);
}

/** The local save as a record, so it can be compared with the cloud copy. */
export function loadRecord(): SaveRecord | null {
  const state = read(SAVE_KEY);
  if (!state) return null;
  return { state, savedAt: Number(read(SAVED_AT_KEY)) || 0, device: deviceName() };
}

export function loadGame(): GameState | null {
  const raw = read(SAVE_KEY);
  if (!raw) return null;
  try { return deserialize(raw); } catch { return null; }
}

export function clearGame() {
  write(SAVE_KEY, null);
  write(SAVED_AT_KEY, null);
}

export function loadSettings(): Settings {
  try {
    return { ...defaultSettings, ...(JSON.parse(read(SETTINGS_KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(s: Settings) {
  write(SETTINGS_KEY, JSON.stringify(s));
}

/** Ask the browser not to evict our storage under pressure (best effort). */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => undefined);
}

// ---- Progress: the highest level beaten at each speed (Low, Medium, High, Slo-mo) ----
// Kept apart from the game save, so finishing or abandoning a game never loses it.
// localStorage writes are synchronous, so it survives the app being killed right after.
const PROGRESS_KEY = 'bugpop.progress.v1';
/** Levels anyone may start on, before beating anything. */
export const OPEN_LEVELS = 20;
/** beaten[speed] is the highest level cleared at that speed, or -1 for none. */
export type Progress = { beaten: [number, number, number, number] };

export function loadProgress(): Progress {
  try {
    const p = JSON.parse(read(PROGRESS_KEY) ?? 'null') as { beaten?: number[] } | null;
    const b = p?.beaten;
    if (Array.isArray(b) && (b.length === 3 || b.length === 4) && b.every(n => Number.isInteger(n))) {
      if (b.length === 3) b.push(-1); // saved before Slo-mo existed
      return { beaten: b as Progress['beaten'] };
    }
  } catch { /* damaged: start over below */ }
  // First run with progress tracking: credit whatever level an existing saved game reached.
  const fresh: Progress = { beaten: [-1, -1, -1, -1] };
  const save = loadGame();
  if (save) fresh.beaten[save.config.speed] = save.config.level - 1;
  write(PROGRESS_KEY, JSON.stringify(fresh)); // keep that credit even if the save is later abandoned
  return fresh;
}

/** Record a cleared level. Returns the updated progress. */
export function recordBeaten(speed: Speed, level: number): Progress {
  const p = loadProgress();
  if (level > p.beaten[speed]) {
    p.beaten[speed] = level;
    write(PROGRESS_KEY, JSON.stringify(p));
  }
  return p;
}

/** The top of the level slider at a speed: the first level not yet beaten, never below OPEN_LEVELS, at most finalLevel. */
export function sliderMax(p: Progress, speed: Speed, finalLevel: number): number {
  return Math.min(finalLevel, Math.max(OPEN_LEVELS, p.beaten[speed] + 1));
}
