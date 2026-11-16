// Noticing a new version of the game.
//
// Each build carries an id (__BUILD_ID__, set in vite.config.ts) and publishes the same
// id in version.json. A tab or home-screen app can stay open for days, so before a game
// starts or resumes we fetch version.json fresh and compare.
//
//   - Single player may carry on with the old version (the player is asked).
//   - Multiplayer must run the same version as everyone else: requireLatest() reloads.
//
// Updating saves first, throws away every cached file, and reloads with a cache-busting
// query, so the new version arrives even if a cache somewhere is holding the old one.

declare const __BUILD_ID__: string;
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

let latest: string | null = null; // last version.json answer
let declined: string | null = null; // version the player said "not now" to

/** The deployed version, or null if it can't be checked (offline, slow, dev server). */
export async function deployedVersion(timeoutMs = 2000): Promise<string | null> {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const v = ((await res.json()) as { version?: unknown }).version;
    latest = typeof v === 'string' ? v : null;
  } catch {
    // Offline or slow: keep the last answer we had.
  }
  return latest;
}

/** True when a different build has been deployed since this page loaded. */
export async function updateAvailable(timeoutMs?: number): Promise<boolean> {
  if (BUILD_ID === 'dev') return false;
  const v = await deployedVersion(timeoutMs);
  return !!v && v !== BUILD_ID;
}

/** Single player: should we offer the update? (Not again for a version they declined.) */
export async function shouldOffer(): Promise<boolean> {
  return (await updateAvailable()) && latest !== declined;
}

export function decline() { declined = latest; }

/** Fetch the new version for sure: drop caches and the service worker's copy, then reload. */
export async function updateNow(beforeReload?: () => void): Promise<never> {
  beforeReload?.();
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map(r => r.update().catch(() => undefined)));
  } catch { /* no service worker */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch { /* Cache API unavailable */ }
  const url = new URL(location.href);
  url.searchParams.set('v', latest ?? String(Date.now()));
  location.replace(url.toString());
  return new Promise<never>(() => undefined); // the page is going away
}

/** Multiplayer: everyone must run the same build. Reloads (after saving) if this one is out of date. */
export async function requireLatest(beforeReload?: () => void): Promise<void> {
  if (await updateAvailable(4000)) await updateNow(beforeReload);
}

/** After an update reload, tidy the ?v= marker out of the address bar. */
export function cleanUpdateMarker() {
  const url = new URL(location.href);
  if (!url.searchParams.has('v')) return;
  url.searchParams.delete('v');
  history.replaceState(null, '', url.toString());
}
