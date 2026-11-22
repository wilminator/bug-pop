// The player's Wilminator Games account, as the title page sees it.
//
// The browser never holds a token. The game server (bug-pop-server, private) runs the
// sign-in and keeps its own session cookie; this file only asks it "who is signed in?"
// and sends the browser to the server's sign-in and sign-out addresses.
//
// Server API (same origin, under config.json's `api`, normally "/api"):
//   GET  /api/me              200 Me when signed in, 401 when not
//   GET  /api/auth/login      starts sign-in at the account site, then returns to ?return=
//   POST /api/auth/logout     ends this browser's session; 204
//
// The open-source build has no server, so all of this stays switched off there.

/** What GET /api/me answers for a signed-in player. Unknown fields are ignored. */
export type Me = {
  sub: string;
  /** The account handle. Absent when the player chose to hide it. */
  name?: string;
  /** Patreon supporter, decided by the account site alone. null = not a supporter. */
  supporter: { tier: string } | null;
  /** The account's decision: may this player be shown ads? */
  ads: boolean;
  settings?: {
    privacy?: { hide_name?: boolean; hide_supporter?: boolean; personalized_ads?: boolean | null };
    accessibility?: { reduced_motion?: boolean | null; high_contrast?: boolean | null };
  };
};

/**
 * off          no server in this build (open-source build)
 * unavailable  a server is configured but didn't answer properly (down, slow, not built yet)
 * signedOut    the server answered 401
 * signedIn     the server answered 200 with the player
 */
export type AccountStatus =
  | { kind: 'off' }
  | { kind: 'unavailable' }
  | { kind: 'signedOut' }
  | { kind: 'signedIn'; me: Me };

export async function fetchAccount(apiBase: string | undefined, timeoutMs = 2500): Promise<AccountStatus> {
  if (!apiBase) return { kind: 'off' };
  try {
    const res = await fetch(`${trim(apiBase)}/me`, { credentials: 'include', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401) return { kind: 'signedOut' };
    if (!res.ok) return { kind: 'unavailable' };
    const me = (await res.json()) as Me;
    return isMe(me) ? { kind: 'signedIn', me } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Where the Sign in button sends the browser. The server brings the player back to `returnTo`. */
export function loginUrl(apiBase: string, returnTo: string): string {
  return `${trim(apiBase)}/auth/login?return=${encodeURIComponent(returnTo)}`;
}

/** Ends this browser's session. The server wants JSON on every write (it blocks forged requests). */
export async function logout(apiBase: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(`${trim(apiBase)}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok || res.status === 401; // already signed out counts as done
  } catch {
    return false;
  }
}

/**
 * The name to show on the title page. Players always see their own name, but if they chose
 * to hide it from others we don't put it on screen either: someone on the couch could see it.
 */
export function shownName(me: Me): string | null {
  if (me.settings?.privacy?.hide_name) return null;
  return me.name ?? null;
}

/** A supporter badge, unless the player turned public badges off ("Supporter", or null). */
export function supporterBadge(me: Me): string | null {
  if (!me.supporter || me.settings?.privacy?.hide_supporter) return null;
  return 'Supporter';
}

/**
 * Should the title page show an ad?
 * - Only when the deployment's config.json turns ads on (never in the open-source build).
 * - Only once the server has confirmed who is playing (Mike, 2026-11-17): signed-out players
 *   see them; signed-in players only when their account's `ads` says so (supporters don't).
 * - Until the server answers, or if it can't be reached, no ad: a supporter must never see one.
 * - A build with no sign-in server at all ('off') has nobody to exempt, so ads show there.
 */
export function wantsAds(adsOn: boolean, status: AccountStatus): boolean {
  if (!adsOn) return false;
  if (status.kind === 'signedIn') return status.me.ads === true;
  return status.kind === 'signedOut' || status.kind === 'off';
}

/** false = non-personalized ads only; null = let the consent banner decide. */
export function personalizedAds(status: AccountStatus): boolean | null {
  if (status.kind !== 'signedIn') return null;
  const p = status.me.settings?.privacy?.personalized_ads;
  return p === false ? false : null;
}

const trim = (base: string) => base.replace(/\/$/, '');

function isMe(m: unknown): m is Me {
  const o = m as Me;
  return !!o && typeof o.sub === 'string' && typeof o.ads === 'boolean';
}

/**
 * Is this player in an unfinished online match (GET /api/play/active, signed in only)? Going back
 * into Multiplayer then rejoins it. Any failure counts as no.
 */
export async function activeMatch(apiBase: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${trim(apiBase)}/play/active`, { credentials: 'include', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && ((await res.json()) as { active?: unknown }).active === true;
  } catch {
    return false;
  }
}
