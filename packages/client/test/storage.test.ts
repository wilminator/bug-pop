import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, loadSettings } from '../src/storage';

// A tiny in-memory localStorage, enough for loadSettings.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage = {
  getItem: k => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
  removeItem: k => void store.delete(k),
};
afterEach(() => store.clear());

describe('settings saved by older versions', () => {
  it('gets Animations: Automatic when the saved settings predate it', () => {
    const old = { ...defaultSettings, music: false } as Partial<typeof defaultSettings>;
    delete old.motion;
    store.set('bugpop.settings.v1', JSON.stringify(old));
    expect(loadSettings()).toEqual({ ...defaultSettings, music: false, motion: 'auto' });
  });

  it('keeps a saved choice and replaces a value it does not know', () => {
    store.set('bugpop.settings.v1', JSON.stringify({ ...defaultSettings, motion: 'calm' }));
    expect(loadSettings().motion).toBe('calm');
    store.set('bugpop.settings.v1', JSON.stringify({ ...defaultSettings, motion: 'wobbly' }));
    expect(loadSettings().motion).toBe('auto');
  });
});
