// Settings and unlocked levels that follow a signed-in player between devices.
//
// Only the game settings travel (speed, colors, shapes, how bugs leave, auto-next, sound, music).
// Touch buttons and the look stay on each device: a phone and a PC want different ones.
// Unlocked levels are merged by keeping the higher level per speed, so devices never undo each other.
//
// Server API (same origin, cookie session, see bug-pop-server docs/api.md):
//   GET  /api/settings   200 {settings, updatedAt}, 404 when none are stored
//   PUT  /api/settings   body {settings}; 204. Last write wins
//   POST /api/progress   body {beaten}; 200 {beaten} merged
//
// Like the cloud save, all of this quietly does nothing when signed out or offline.

import type { Settings } from './storage';

/** The settings that follow the player. Everything else in Settings stays on the device. */
export const SYNCED_KEYS = ['speed', 'colors', 'shapesOnPieces', 'exit', 'autoNext', 'sound', 'music'] as const;
export type SyncedSettings = Pick<Settings, (typeof SYNCED_KEYS)[number]>;

export const pickSynced = (s: Settings): SyncedSettings =>
  Object.fromEntries(SYNCED_KEYS.map(k => [k, s[k]])) as SyncedSettings;

export const syncedDiffer = (a: Settings, b: Settings) => SYNCED_KEYS.some(k => a[k] !== b[k]);

/**
 * Copy the server's settings onto this device's, taking only keys with a sensible value.
 * A newer game version may send keys this one doesn't know; they are ignored.
 */
export function applySynced(local: Settings, remote: unknown): Settings {
  const r = (remote && typeof remote === 'object' ? remote : {}) as Record<string, unknown>;
  const out = { ...local };
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (int(r.speed, 0, 3)) out.speed = r.speed as Settings['speed'];
  if (int(r.colors, 2, 5)) out.colors = r.colors as number;
  for (const k of ['shapesOnPieces', 'autoNext', 'sound', 'music'] as const) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  if (r.exit === '' || r.exit === 'fly' || r.exit === 'fall' || r.exit === 'explode' || r.exit === 'fade') out.exit = r.exit;
  return out;
}

export interface Sync {
  pullSettings(): Promise<{ settings: unknown; updatedAt: number } | null>;
  /** Fire-and-forget. */
  pushSettings(s: SyncedSettings): void;
  /** Send this device's unlocked levels; answers the merged result, or null when it can't. */
  mergeProgress(beaten: number[]): Promise<number[] | null>;
}

export const noSync: Sync = {
  pullSettings: async () => null,
  pushSettings: () => undefined,
  mergeProgress: async () => null,
};

export function httpSync(apiBase: string, timeoutMs = 2500): Sync {
  const base = apiBase.replace(/\/$/, '');
  const json = { 'content-type': 'application/json' };
  return {
    async pullSettings() {
      try {
        const res = await fetch(`${base}/settings`, { credentials: 'include', signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const body = (await res.json()) as { settings?: unknown; updatedAt?: unknown };
        return typeof body.updatedAt === 'number' ? { settings: body.settings, updatedAt: body.updatedAt } : null;
      } catch {
        return null;
      }
    },
    pushSettings(s) {
      fetch(`${base}/settings`, { method: 'PUT', credentials: 'include', keepalive: true, headers: json, body: JSON.stringify({ settings: s }) })
        .catch(() => undefined);
    },
    async mergeProgress(beaten) {
      try {
        const res = await fetch(`${base}/progress`, {
          method: 'POST', credentials: 'include', headers: json, body: JSON.stringify({ beaten }), signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const b = ((await res.json()) as { beaten?: unknown }).beaten;
        return Array.isArray(b) && b.every(n => Number.isInteger(n)) ? (b as number[]) : null;
      } catch {
        return null;
      }
    },
  };
}
