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
};

export const defaultSettings: Settings = { level: 0, speed: 1, colors: 3, shapesOnPieces: true, sound: true, music: true, exit: '', look: 'site' };

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
