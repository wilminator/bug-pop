// Friends (Mike, 2026-11-22; plan: https://claude.ai/artifact/V2QMJbmyhasyReZvbFfYtW), talking to
// the private server's /api/friends calls (bug-pop-server server/src/friends.ts):
//   GET  /api/friends          { me, friends, waiting, asked, blocked } (each a FriendRow list)
//   POST /api/friends          { fid, on }    add (or add back) / remove my side
//   POST /api/friends/nick     { fid, nick }  my private nickname for a friend
//   POST /api/friends/block    { fid, on }    block / unblock
//   GET  /api/friends/rooms    { rooms }      the rooms my friends are in right now
//   POST /api/friends/invite   { fid, room }  invite a friend to the room I'm in (Mike, 2026-11-22)
// Invites waiting for me come with the lists (`invites`): shown in the app for 10 minutes.
// A friendship counts only when both people added each other. People are named by friend handle
// (fid), never by account id. Without a server (the open-source build) none of this shows.

/** One person: their friend handle, the name others may see, and my private nickname for them. */
export type FriendRow = { fid: string; name: string; nick: string | null };
/** A friend asks me into their room: `from` is how I see them (my nickname, else their name). */
export type FriendInvite = { code: string; from: string; fid: string | null };
export type FriendLists = { me: string; friends: FriendRow[]; waiting: FriendRow[]; asked: FriendRow[]; blocked: FriendRow[]; invites?: FriendInvite[] };
/** One row of the friends' rooms list. */
export type FriendRoom = { code: string; friends: string[]; people: number; max: number; open: number; tour: boolean };
/** Where someone stands with me. */
export type Standing = 'me' | 'friend' | 'waiting' | 'asked' | 'blocked' | 'none';

const trim = (base: string) => base.replace(/\/$/, '');

export class Friends {
  lists: FriendLists | null = null;
  /** Lists changed: everything that shows them redraws. */
  private listeners = new Set<() => void>();
  listen(fn: () => void) { this.listeners.add(fn); }
  private loading: Promise<void> | null = null;

  constructor(private api: string) {}

  /** Load again after a change: waits out a load already on its way (it may predate the change). */
  private async reload() {
    if (this.loading) await this.loading;
    await this.refresh();
  }

  /** Load (again). Signed out or offline: the lists stay as they were (null at first). */
  refresh(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const res = await fetch(`${trim(this.api)}/friends`, { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (res.status === 401) this.lists = null;
        else if (res.ok) this.lists = (await res.json()) as FriendLists;
        for (const fn of this.listeners) fn();
      } catch { /* offline: keep what we had */ } finally { this.loading = null; }
    })();
    return this.loading;
  }

  standing(fid: string | undefined): Standing {
    const l = this.lists;
    if (!fid || !l) return 'none';
    if (fid === l.me) return 'me';
    const has = (xs: FriendRow[]) => xs.some(x => x.fid === fid);
    return has(l.friends) ? 'friend' : has(l.waiting) ? 'waiting' : has(l.asked) ? 'asked' : has(l.blocked) ? 'blocked' : 'none';
  }

  /** How I see someone: my nickname for them, else their name. */
  label(fid: string | undefined, name: string): string {
    const l = this.lists;
    const r = l && fid ? [...l.friends, ...l.asked].find(x => x.fid === fid) : undefined;
    return r?.nick ?? name;
  }

  add(fid: string) { return this.post('friends', { fid, on: true }); }
  remove(fid: string) { return this.post('friends', { fid, on: false }); }
  block(fid: string, on: boolean) { return this.post('friends/block', { fid, on }); }
  nick(fid: string, nick: string) { return this.post('friends/nick', { fid, nick }); }
  invite(fid: string, room: string) { return this.post('friends/invite', { fid, room }); }

  /** My friend link's code (`fresh`: a new one, which stops the old link), or null (offline). */
  async code(fresh = false): Promise<string | null> {
    try {
      const res = await fetch(`${trim(this.api)}/friends/code`, {
        method: fresh ? 'POST' : 'GET', credentials: 'include', signal: AbortSignal.timeout(8000),
        ...(fresh ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      });
      return res.ok ? ((await res.json()) as { code: string }).code : null;
    } catch { return null; }
  }

  /** Opened someone's friend link: add them. Their friend handle, or null if the link is old or wrong. */
  async link(code: string): Promise<string | null> {
    let fid: string | null = null;
    try {
      const res = await fetch(`${trim(this.api)}/friends/link`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }), signal: AbortSignal.timeout(8000),
      });
      fid = ((await res.json()) as { fid?: string }).fid ?? null;
    } catch { /* offline */ }
    await this.reload();
    return fid;
  }

  /** The rooms my friends are in, or null (signed out, offline). */
  async rooms(): Promise<FriendRoom[] | null> {
    try {
      const res = await fetch(`${trim(this.api)}/friends/rooms`, { credentials: 'include', signal: AbortSignal.timeout(8000) });
      return res.ok ? ((await res.json()) as { rooms: FriendRoom[] }).rooms : null;
    } catch { return null; }
  }

  /** A change, then the lists again. True if the server took it. */
  private async post(path: string, body: unknown): Promise<boolean> {
    let ok = false;
    try {
      const res = await fetch(`${trim(this.api)}/${path}`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
      ok = res.ok;
    } catch { /* offline */ }
    await this.reload();
    return ok;
  }
}

/**
 * The friend buttons for one person (room People list, result cards): Add friend, Add back, or a
 * note that we're friends or that they haven't added back yet; Block where it fits.
 */
export function friendButtons(f: Friends, fid: string, opts: { block?: boolean; play?: () => void } = {}): HTMLElement | null {
  const st = f.standing(fid);
  if (st === 'me' || st === 'blocked') return null;
  const box = document.createElement('span');
  box.className = 'friend-btns';
  const btn = (text: string, run: () => Promise<boolean>, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', () => { opts.play?.(); b.disabled = true; void run(); });
    box.append(b);
  };
  const note = (text: string) => { const s = document.createElement('span'); s.className = 'friend-note'; s.textContent = text; box.append(s); };
  if (st === 'friend') note('★ Friend');
  else if (st === 'asked') note('Friend asked');
  else if (st === 'waiting') btn('Add back', () => f.add(fid), 'primary');
  else btn('Add friend', () => f.add(fid));
  if (opts.block && st !== 'friend') btn('Block', () => f.block(fid, true));
  return box;
}
