// Saving. The fix for "the phone closed my game": the whole game state is
// written synchronously to localStorage whenever a piece lands and the moment
// the page is hidden. localStorage is synchronous, so the write is finished
// before iOS can freeze or kill the page.

import { deserialize, serialize, type GameState, type Speed } from '@bug-pop/engine';
import type { ExitStyle } from './skin';

const SAVE_KEY = 'bugpop.save.v1';
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
  return write(SAVE_KEY, serialize(s));
}

export function loadGame(): GameState | null {
  const raw = read(SAVE_KEY);
  if (!raw) return null;
  try { return deserialize(raw); } catch { return null; }
}

export function clearGame() {
  write(SAVE_KEY, null);
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
