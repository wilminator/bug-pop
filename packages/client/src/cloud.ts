// Cloud save: a signed-in player's single-player game follows them to any
// device. This is a login perk; without an account (or on the open-source
// build, which has no server) everything here quietly does nothing.
//
// Only single player uses this. Other modes (co-op, PvP, online) never read or
// write the save, so starting one of those can't clobber it.
//
// Server API (same origin, cookie session, see bug-pop-server docs/api.md):
//   GET    /api/me            200 {sub, name?, supporter, ads, settings} when signed in, else 401
//   GET    /api/saves/single  200 SaveRecord, or 404 when there is none
//   PUT    /api/saves/single  body SaveRecord; 204. Last write wins: whoever paused last.
//   DELETE /api/saves/single  204

import { deserialize, serialize, type GameState } from '@bug-pop/engine';

/** One saved game, wherever it is stored. */
export type SaveRecord = {
  /** The whole game state, as the engine serializes it. */
  state: string;
  /** When it was saved (ms since 1970, the saving device's clock). */
  savedAt: number;
  /** A friendly name for the device that saved it ("iPhone", "Windows PC"). */
  device: string;
};

export interface CloudSave {
  /** True once we know there's a signed-in player. */
  readonly signedIn: boolean;
  /** Check the session. Safe to call any time; never throws. */
  check(): Promise<boolean>;
  get(): Promise<SaveRecord | null>;
  /** Fire-and-forget upload. Uses keepalive so it survives the page being hidden. */
  put(rec: SaveRecord): void;
  remove(): void;
}

/** Used when the deployment has no server (the open-source build). */
export const noCloud: CloudSave = {
  signedIn: false,
  check: async () => false,
  get: async () => null,
  put: () => undefined,
  remove: () => undefined,
};

/** Talks to the game server at apiBase (normally "/api"). */
export function httpCloud(apiBase: string, timeoutMs = 2500): CloudSave {
  const base = apiBase.replace(/\/$/, '');
  let signedIn = false;
  // Don't make the player wait on a slow network: give up and play locally.
  const timed = (url: string, init: RequestInit = {}) =>
    fetch(url, { credentials: 'include', ...init, signal: AbortSignal.timeout(timeoutMs) });
  return {
    get signedIn() { return signedIn; },
    async check() {
      try {
        const res = await timed(`${base}/me`);
        signedIn = res.ok;
      } catch {
        signedIn = false;
      }
      return signedIn;
    },
    async get() {
      if (!signedIn) return null;
      try {
        const res = await timed(`${base}/saves/single`);
        if (!res.ok) return null;
        const rec = (await res.json()) as SaveRecord;
        return isRecord(rec) ? rec : null;
      } catch {
        return null;
      }
    },
    put(rec) {
      if (!signedIn) return;
      // keepalive lets the request finish even if iOS suspends the page right after.
      fetch(`${base}/saves/single`, {
        method: 'PUT',
        credentials: 'include',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec),
      }).catch(() => undefined);
    },
    remove() {
      if (!signedIn) return;
      fetch(`${base}/saves/single`, { method: 'DELETE', credentials: 'include', keepalive: true }).catch(() => undefined);
    },
  };
}

function isRecord(r: unknown): r is SaveRecord {
  const o = r as SaveRecord;
  return !!o && typeof o.state === 'string' && typeof o.savedAt === 'number' && typeof o.device === 'string';
}

export function makeRecord(state: GameState, savedAt = Date.now()): SaveRecord {
  return { state: serialize(state), savedAt, device: deviceName() };
}

/** Turn a record back into a game, or null if it's damaged or from an incompatible version. */
export function recordState(rec: SaveRecord): GameState | null {
  try { return deserialize(rec.state); } catch { return null; }
}

/** The more recent of two saves (either may be missing). */
export function newest(a: SaveRecord | null, b: SaveRecord | null): SaveRecord | null {
  if (!a) return b;
  if (!b) return a;
  return b.savedAt > a.savedAt ? b : a;
}

/** A rough, privacy-friendly device label. No fingerprinting, just the platform family. */
export function deviceName(ua = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'another device';
}

/** "just now", "5 minutes ago", "yesterday"... */
export function timeAgo(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
