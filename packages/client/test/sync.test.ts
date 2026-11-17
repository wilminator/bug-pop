import { describe, expect, it } from 'vitest';
import { applySynced, pickSynced, syncedDiffer } from '../src/sync';
import { defaultSettings } from '../src/storage';

describe('settings that follow the player', () => {
  it('sends only the game settings, never touch buttons or look', () => {
    const s = { ...defaultSettings, touchLayout: 'four' as const, look: 'test' as const, level: 12 };
    expect(Object.keys(pickSynced(s)).sort()).toEqual(['autoNext', 'colors', 'exit', 'music', 'shapesOnPieces', 'sound', 'speed']);
  });

  it('takes the account settings, keeping this device’s touch buttons and look', () => {
    const local = { ...defaultSettings, touchLayout: 'four' as const, look: 'test' as const };
    const out = applySynced(local, { speed: 3, colors: 5, shapesOnPieces: false, exit: 'fade', autoNext: true, sound: false, music: false, touchLayout: 'edges' });
    expect(out).toEqual({ ...local, speed: 3, colors: 5, shapesOnPieces: false, exit: 'fade', autoNext: true, sound: false, music: false });
  });

  it('ignores damaged or unknown values', () => {
    const out = applySynced(defaultSettings, { speed: 9, colors: '4', sound: 'yes', exit: 'teleport', future: 1 });
    expect(out).toEqual(defaultSettings);
    expect(applySynced(defaultSettings, null)).toEqual(defaultSettings);
  });

  it('notices only changes to the synced settings', () => {
    expect(syncedDiffer(defaultSettings, { ...defaultSettings, touchLayout: 'four' })).toBe(false);
    expect(syncedDiffer(defaultSettings, { ...defaultSettings, music: false })).toBe(true);
  });
});
