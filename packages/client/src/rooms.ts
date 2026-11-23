// An online room (protocol 5, Mike 2026-11-22): friends gather, then play games of 2 to 4 people
// (computers fill empty seats) or a tournament, and anyone can watch any game. The room screen
// lists the people and the games; the owner sets the rules. A game this device plays or watches
// is shown by the versus screen (versus.ts playTable), but its clock is kept here, so a board this
// device plays (its people, the computers it runs, a dropped friend's stand-in) keeps going even
// while the room screen is up.
//
// The server only passes moves along (bug-pop-server rooms.ts); every device plays its own boards
// and rebuilds the rest (packages/protocol table.ts and room.ts).

import { TICKS_PER_SECOND, type Speed } from '@bug-pop/engine';
import { MAX_PER_DEVICE, ROOM_VERSION, RoomSession, parseRoomServer, type GameRules, type RoomGame, type RoomPerson, type RoomState, type TourRules } from '@bug-pop/protocol';
import qrcode from 'qrcode-generator';
import type { AudioManager } from './audio';
import { friendButtons, type Friends } from './friends';
import type { Versus } from './versus';

const TICK_MS = 1000 / TICKS_PER_SECOND;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const RULE_TEXT = { race: 'First to clear their bugs', best3: 'Best of 3', best5: 'Best of 5', last: 'Last one standing' } as const;
const TOUR_HELP = {
  best3: 'Best of 3 bracket: each pairing plays until someone wins 2; the winner moves on.',
  best5: 'Best of 5 bracket: each pairing plays until someone wins 3; the winner moves on.',
  single: 'Single elimination: one game a pairing; lose once and you are out.',
  double: 'Double elimination: out after 2 losses; players with the same losses meet first.',
} as const;
const TOUR_TEXT = { best3: 'Bracket, best of 3 matches', best5: 'Bracket, best of 5 matches', single: 'Single elimination', double: 'Double elimination' } as const;
const TARGET_TEXT = { leader: 'attacks go to the leader', random: 'attacks go to someone at random', everyone: 'attacks go to everyone' } as const;
/** A game's rules in a few words, e.g. "Best of 3, 3 colors, attacks go to the leader". */
const rulesText = (r: GameRules, seats: number) => [RULE_TEXT[r.rule], `${r.colors} colors`, seats > 2 ? TARGET_TEXT[r.target] : ''].filter(Boolean).join(', ');
const tourText = (r: TourRules) => [TOUR_TEXT[r.kind], `${r.colors} colors`, r.levels === 'same' ? `everyone at level ${r.level}` : 'players choose level and speed'].join(', ');

export type RoomJoin = { room: string; level: number; speed: Speed; power: boolean };
export type RoomDeps = {
  url: string;
  audio: AudioManager;
  versus: Versus;
  /** Show the room screen, the versus screen, or (on leaving or a failed join) the Multiplayer screen. */
  show: (m: 'room' | 'versus' | 'versusSetup') => void;
  /** Is the room screen (or a game from it) on show? */
  here: () => boolean;
  /** The server runs a newer version: update now, and come back to this room after. */
  outdated: () => void;
  /** Friends (signed-in servers only): Add friend / Add back / Block in the People list. */
  friends?: Friends;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export class RoomScreen {
  private ws: WebSocket | null = null;
  private session: RoomSession | null = null;
  private join: RoomJoin | null = null;
  private leaving = false;
  private tries = 0;
  /** When each table's tick 0 was, by the real clock (so every device stays in step). */
  private t0 = new Map<number, number>();
  private pump = 0;
  /** The game this device chose to watch. */
  private watching: number | null = null;
  /** Rounds already put on screen (a game's settings card or its boards come up once each). */
  private seen = new Set<string>();

  /** The server has let this device into the room (its first room state arrived). */
  private entered = false;
  /** Friend lists are read again this often while in a room (someone may have added me). */
  private friendTimer = 0;
  /** "Ann added you" notes put off with Not now (until the room is left). */
  private notNow = new Set<string>();
  constructor(private deps: RoomDeps) {
    deps.friends?.listen(() => { if (this.session?.state && this.entered) this.render(this.session.state); });
    $('roomLeave').addEventListener('click', () => { deps.audio.play('select'); this.leave(); });
    $('roomShareBtn').addEventListener('click', () => void this.share());
    $('roomStart').addEventListener('click', () => { deps.audio.play('select'); this.make(); });
    $('roomAddForm').addEventListener('submit', e => {
      e.preventDefault();
      const input = $<HTMLInputElement>('roomAddName'), name = input.value.trim();
      if (!name || !this.session) return;
      deps.audio.play('select');
      this.session.addPerson(name);
      input.value = '';
    });
    const rules = $<HTMLFormElement>('roomRules');
    rules.addEventListener('change', () => { if (this.session?.state) this.fillForm(this.session.state); });
    $<HTMLInputElement>('rrLevel').addEventListener('input', () => { $<HTMLOutputElement>('rrLevelOut').value = $<HTMLInputElement>('rrLevel').value; });
  }

  get open() { return !!this.session; }
  /** The room this device is in, or joining (null while making a new one). */
  get code(): string | null { return this.session?.state?.code ?? (this.join && this.join.room !== 'new' ? this.join.room : null); }

  /** The join form's line under the code: joining, or why it didn't work. */
  private note(text: string, bad = false) {
    const n = $('vsRoomNote');
    n.hidden = !text;
    n.textContent = text;
    n.classList.toggle('bad', bad);
    for (const id of ['vsCreate', 'vsJoin', 'vsScan']) $<HTMLButtonElement>(id).disabled = !!text && !bad;
  }

  /**
   * Couldn't get into the room (a wrong code, a full room, an old version, no connection):
   * stay on the join form and say why there (Mike, 2026-11-22), rather than on an empty room screen.
   */
  private fail(why: string) {
    this.close();
    this.deps.show('versusSetup');
    this.note(why, true);
  }

  /** Join a room ('new' makes one). */
  start(join: RoomJoin) {
    this.close();
    this.join = join;
    this.leaving = false;
    this.tries = 0;
    this.session = new RoomSession(m => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); });
    this.session.onChange = () => this.changed();
    this.session.onTable = g => {
      const t = this.session!.tables.get(g)!;
      this.t0.set(g, performance.now() - t.clock * TICK_MS);
    };
    $('roomTitle').textContent = 'Room';
    $('roomStatus').textContent = '';
    // The room screen opens once the server lets us in; until then the join form says what's happening.
    this.entered = false;
    this.note(join.room === 'new' ? 'Opening a room...' : `Joining room ${join.room}...`);
    this.connect(join.room);
    window.clearInterval(this.pump);
    this.pump = window.setInterval(() => this.tick(), 16);
  }

  private connect(room: string) {
    const url = new URL(this.deps.url, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
    const ws = new WebSocket(url);
    this.ws = ws;
    const j = this.join!;
    // People already added on this device come back with it.
    const people = this.session?.mine.slice(1).map(p => p.name) ?? [];
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', v: ROOM_VERSION, level: j.level, speed: j.speed, room, ...(j.power ? { power: true } : {}), ...(people.length ? { people } : {}) })));
    ws.addEventListener('message', e => { if (this.ws === ws) { this.tries = 0; this.session?.receive(parseRoomServer(String(e.data))); } });
    ws.addEventListener('close', e => {
      if (this.ws !== ws || this.leaving) return;
      this.ws = null;
      // Refused for an old version (4004): fetch the new one; the page comes back to this room.
      if (e.code === 4004) { this.note('Getting the new version of Bug Pop...'); return this.deps.outdated(); }
      // The server restarted (4007): the room is gone, so don't try to reconnect to it.
      if (e.code === 4007) return this.fail(this.session?.error ?? 'The game server restarted, so the room closed. Open a new room in a minute.');
      const code = this.session?.state?.code;
      // Lost the connection: back in the same room (the server keeps my seats; the stand-in plays meanwhile).
      if (code && this.tries < 5) {
        this.tries++;
        $('roomStatus').textContent = 'Connection lost. Reconnecting...';
        window.setTimeout(() => { if (this.session && !this.leaving) this.connect(code); }, 1500);
        return;
      }
      const why = this.session?.error ?? "Couldn't reach the game server. Check your connection and try again.";
      if (!this.entered) return this.fail(why);
      $('roomStatus').textContent = why;
    });
  }

  /** Leave the room for good. */
  leave() {
    this.session?.quit();
    this.close();
    this.deps.show('versusSetup');
  }

  close() {
    this.leaving = true;
    window.clearInterval(this.pump);
    window.clearInterval(this.friendTimer);
    this.notNow.clear();
    try { this.ws?.close(); } catch { /* closed */ }
    this.ws = null;
    this.session = null;
    this.t0.clear();
    this.seen.clear();
    this.watching = null;
  }

  /** Keep every table this device has in step with the real clock. */
  private tick() {
    const s = this.session;
    if (!s) return;
    const now = performance.now();
    for (const [g, t] of s.tables) {
      if (s.ended.has(g) || t.result || t.flagged) continue;
      let t0 = this.t0.get(g) ?? now;
      // Its clock jumped (taking a seat back): carry on from there.
      if (t.clock > (now - t0) / TICK_MS + 2) { t0 = now - t.clock * TICK_MS; this.t0.set(g, t0); }
      const due = Math.floor((now - t0) / TICK_MS);
      for (let n = 0; n < 600 && t.clock < due && !t.result && !t.flagged; n++) t.tick(this.deps.versus.tableActions(g));
    }
  }

  private mine() { return new Set(this.session?.mine.map(p => p.pid) ?? []); }

  /** The friend handle of whoever sits at seat `s` of game `g` (for a result card's Add friend). */
  fidAt(g: number, seat: number): string | undefined {
    const st = this.session?.state;
    const pid = st?.games.find(x => x.g === g)?.seats[seat]?.pid;
    return pid ? st!.people.find(p => p.pid === pid)?.fid : undefined;
  }

  /** The room changed: redraw it, and bring up any game of mine that needs me. */
  private changed() {
    const s = this.session;
    // Refused at the door: the server closes the connection next, and that says what went wrong.
    if (!s?.state) return;
    if (!this.entered) {
      this.entered = true;
      this.note('');
      this.deps.show('room');
      const f = this.deps.friends;
      if (f) { void f.refresh(); window.clearInterval(this.friendTimer); this.friendTimer = window.setInterval(() => { if (!document.hidden) void f.refresh(); }, 15_000); }
    }
    this.render(s.state);
    const mine = this.mine();
    for (const game of s.state.games) {
      const seated = game.seats.some(x => x.pid && mine.has(x.pid));
      if (!seated && this.watching !== game.g) continue;
      const lobby = s.lobbies.get(game.g), table = s.tables.get(game.g);
      const ended = s.ended.get(game.g);
      if (ended && this.deps.versus.showing(game.g)) this.deps.versus.tableEnded(game.g, ended.why, ended.winner);
      if (game.phase === 'playing' && table && !ended) {
        const key = `${game.g}:${table.start.round}:${table.start.seed}:play`;
        if (!this.seen.has(key)) { this.seen.add(key); this.deps.show('versus'); this.deps.versus.playTable(s, game.g, () => this.back()); }
      } else if (game.phase === 'lobby' && lobby && seated) {
        const key = `${game.g}:${lobby.round}:${game.seats.map(x => x.pid ?? '').join()}:lobby`;
        const fresh = !this.seen.has(key);
        this.seen.add(key);
        if (fresh || this.deps.versus.showing(game.g)) { if (fresh) this.deps.show('versus'); this.deps.versus.showTableLobby(s, lobby, () => this.back()); }
      }
    }
    if (s.error) { $('roomStatus').textContent = s.error; s.error = null; }
  }

  /** From a game back to the room screen. */
  private back() {
    if (this.watching !== null) { this.session?.view(null); this.watching = null; }
    this.deps.show('room');
    if (this.session?.state) this.render(this.session.state);
  }

  private render(st: RoomState) {
    const s = this.session!;
    const mine = this.mine();
    $('roomTitle').textContent = `Room ${st.code}`;
    $('roomCodeText').textContent = st.code;
    this.drawQr(st.code);
    $('roomStatus').textContent = 'Make a game, join one, or watch. Anyone in a game can invite the others.';
    const name = (pid: string | null) => st.people.find(p => p.pid === pid)?.name ?? 'Someone';
    const t = st.tour;
    // People here who could play something now: not in a game, not playing in a running tournament.
    const inTour = (pid: string) => !!t && t.started && !t.champion && t.players.some(p => p.pid === pid && !p.out);
    const isFree = (p: RoomPerson) => p.game === null && !inTour(p.pid);
    const free = s.mine.filter(isFree);

    // Invites to people on this device (Mike, 2026-11-22: invites must be accepted).
    const invites = s.mine.flatMap(p => p.invites.map(v => ({ p, v })));
    // Friend adds from people in this room: "Ann added you" with Add back (Mike, 2026-11-22).
    const f = this.deps.friends;
    const adds = f ? st.people.filter(p => !p.mine && p.fid && f.standing(p.fid) === 'waiting' && !this.notNow.has(p.fid)) : [];
    $('roomInvites').hidden = !invites.length && !adds.length;
    $('roomInvites').replaceChildren(...adds.map(p => {
      const box = el('div', 'room-invite');
      box.append(el('p', '', `${p.name} added you as a friend.`));
      const row = el('div', 'room-row');
      const yes = el('button', 'primary', 'Add back'), no = el('button', '', 'Not now');
      yes.addEventListener('click', () => { this.deps.audio.play('select'); yes.disabled = true; void f!.add(p.fid!); });
      no.addEventListener('click', () => { this.deps.audio.play('select'); this.notNow.add(p.fid!); this.render(st); });
      row.append(yes, no);
      box.append(row);
      return box;
    }), ...invites.map(({ p, v }) => {
      const game = v.g === null ? null : st.games.find(x => x.g === v.g);
      const what = v.g === null ? (t ? `the tournament (${tourText(t.rules)})` : 'the tournament') : `game ${v.g}${game ? ` (${rulesText(game.rules, game.seats.length)})` : ''}`;
      const box = el('div', 'room-invite');
      box.append(el('p', '', `${v.from} invites ${s.mine.length > 1 ? p.name : 'you'} to ${what}.`));
      const row = el('div', 'room-row');
      const yes = el('button', 'primary', 'Accept'), no = el('button', '', 'Decline');
      yes.addEventListener('click', () => { this.deps.audio.play('select'); s.answer(p.pid, v.g, true); });
      no.addEventListener('click', () => { this.deps.audio.play('select'); s.answer(p.pid, v.g, false); });
      row.append(yes, no);
      box.append(row);
      return box;
    }));

    // Invite: someone of mine in this game (or signed up) asks a free person who isn't already asked.
    const inviteRow = (from: string | undefined, g: number | null, taken: (pid: string) => boolean) => {
      const can = st.people.filter(p => isFree(p) && !taken(p.pid) && !p.invites.some(v => v.g === g));
      if (!from || !can.length) return null;
      const row = el('div', 'room-row');
      const pick = el('select');
      pick.setAttribute('aria-label', 'Who to invite');
      pick.append(...can.map(p => { const o = el('option', '', p.name); o.value = p.pid; return o; }));
      const go = el('button', '', 'Invite');
      go.addEventListener('click', () => { this.deps.audio.play('select'); s.invite(from, pick.value, g); });
      row.append(pick, go);
      return row;
    };

    // People: who's here, Watch only, and the people on this device.
    $('roomPeople').replaceChildren(...st.people.map(p => {
      const li = el('li', p.here ? '' : 'away');
      li.append(el('b', '', f ? f.label(p.fid, p.name) : p.name));
      const notes = [p.mine ? 'on this device' : '', !p.here ? 'away' : '', p.game !== null ? `in game ${p.game}` : inTour(p.pid) ? 'in the tournament' : p.watch ? 'watching' : 'free'].filter(Boolean);
      li.append(el('span', 'fine', notes.join(', ')));
      if (p.mine) {
        const box = el('label', 'vs-check');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = p.watch;
        cb.addEventListener('change', () => { this.deps.audio.play('select'); s.watchOnly(p.pid, cb.checked); });
        box.append(cb, ' Watch only');
        li.append(box);
        if (s.mine[0]?.pid !== p.pid) {
          const rm = el('button', '', 'Remove');
          rm.addEventListener('click', () => { this.deps.audio.play('select'); s.dropPerson(p.pid); });
          li.append(rm);
        }
      } else if (f?.lists && p.fid) {
        const fb = friendButtons(f, p.fid, { block: true, play: () => this.deps.audio.play('select') });
        if (fb) li.append(fb);
      }
      return li;
    }));
    $('roomAddForm').hidden = s.mine.length >= MAX_PER_DEVICE;

    // Games: rules, who's at each, and what I can do there.
    const games = st.games.filter(g => !g.tour);
    const tourGames = st.games.filter(g => g.tour);
    const gameBox = (game: RoomGame) => {
      const box = el('div', 'room-game');
      const title = game.tour ? `Tournament game ${game.g}` : `Game ${game.g} by ${name(game.by)}`;
      box.append(el('b', '', `${title}: ${game.phase === 'playing' ? `playing round ${game.round}` : 'getting ready'}`));
      if (!game.tour) box.append(el('span', 'fine', rulesText(game.rules, game.seats.length)));
      const seats = el('div', 'room-seats');
      game.seats.forEach((seat, i) => {
        seats.append(el('span', `room-seat${seat.pid && mine.has(seat.pid) ? ' me' : ''}`, `${seat.name}${game.wins[i] ? ` (${game.wins[i]})` : ''}`));
        // Join: take a computer's seat (on the settings card now, or from the next round).
        if (seat.cpu && free.length && !game.tour) {
          const take = el('button', '', free.length === 1 ? 'Join' : `Join as ${free[0]!.name}`);
          take.addEventListener('click', () => { this.deps.audio.play('select'); s.takeSeat(free[0]!.pid, game.g, i); });
          seats.append(take);
        }
      });
      box.append(seats);
      const mySeat = game.seats.find(x => x.pid && mine.has(x.pid));
      const row = el('div', 'room-row');
      if (mySeat) {
        const go = el('button', 'primary', 'Go to my game');
        go.addEventListener('click', () => { this.deps.audio.play('select'); this.goTo(game.g); });
        // Back out (Mike, 2026-11-22): a computer takes the seat. In a tournament, it forfeits the match.
        const leave = el('button', '', game.tour ? 'Forfeit this match' : game.phase === 'lobby' && game.round === 1 ? 'Not this game' : 'Give up my seat');
        leave.addEventListener('click', () => {
          this.deps.audio.play('select');
          for (const x of game.seats) if (x.pid && mine.has(x.pid)) s.giveUp(x.pid);
        });
        row.append(go, leave);
      } else {
        const watch = el('button', '', 'Watch');
        watch.addEventListener('click', () => { this.deps.audio.play('select'); this.watch(game.g); });
        row.append(watch);
      }
      box.append(row);
      if (mySeat && !game.tour && game.seats.some(x => x.cpu)) {
        const inv = inviteRow(mySeat.pid, game.g, pid => game.seats.some(x => x.pid === pid));
        if (inv) box.append(inv);
      }
      return box;
    };
    $('roomGames').replaceChildren(...(games.length || t ? games.map(gameBox) : [el('p', 'fine', 'No games yet. Make one below.')]));

    // The tournament: sign-up (Sign up, Invite, Start for whoever made it), then standings and its games.
    $('roomTour').hidden = !t;
    if (t) {
      $('roomTourTitle').textContent = t.champion ? `${name(t.champion)} won the tournament` : t.started ? 'Tournament' : `Tournament by ${name(t.by)}: signing up`;
      $('roomTourText').textContent = tourText(t.rules) + '. Always 1 against 1, two games at a time; the others watch.';
      const rows: HTMLTableRowElement[] = [];
      const head = el('tr');
      head.append(el('th', '', 'Player'), ...(t.started ? [el('th', '', 'Won'), el('th', '', 'Lost')] : []));
      rows.push(head);
      for (const p of t.players) {
        const tr = el('tr', p.out ? 'out' : '');
        tr.append(el('td', '', p.name), ...(t.started ? [el('td', '', String(p.wins)), el('td', '', String(p.losses))] : []));
        rows.push(tr);
      }
      $('roomTourTable').replaceChildren(...rows);
      const row = $('roomTourRow');
      row.replaceChildren();
      if (!t.started) {
        const signed = s.mine.filter(p => t.players.some(x => x.pid === p.pid));
        const could = free.filter(p => !signed.includes(p));
        if (could.length) {
          const join = el('button', 'primary', s.mine.length > 1 ? `Sign up ${could[0]!.name}` : 'Sign up');
          join.addEventListener('click', () => { this.deps.audio.play('select'); s.signUp(could[0]!.pid, true); });
          row.append(join);
        }
        for (const p of signed) {
          const off = el('button', '', s.mine.length > 1 ? `Take ${p.name} off` : 'Take my name off');
          off.addEventListener('click', () => { this.deps.audio.play('select'); s.signUp(p.pid, false); });
          row.append(off);
        }
        if (t.by && mine.has(t.by)) {
          const start = el('button', 'primary', 'Start the tournament');
          start.disabled = t.players.length < 2;
          start.addEventListener('click', () => { this.deps.audio.play('select'); s.startTour(t.by!); });
          row.append(start);
        }
        const inv = inviteRow(signed[0]?.pid, null, pid => t.players.some(x => x.pid === pid));
        if (inv) row.append(...inv.childNodes);
      }
    }
    $('roomGames').append(...tourGames.map(gameBox));

    // Making a game or a tournament: for someone on this device who isn't playing.
    $('roomNewCard').hidden = !free.length;
    const by = $<HTMLSelectElement>('roomBy');
    const keep = by.value;
    by.replaceChildren(...free.map(p => { const o = el('option', '', p.name); o.value = p.pid; return o; }));
    if (free.some(p => p.pid === keep)) by.value = keep;
    $('roomByRow').hidden = free.length < 2;
    this.fillForm(st);
  }

  /** The make-a-game form: show the choices that fit a game or a tournament, and say what they mean. */
  private fillForm(st: RoomState) {
    const v = (id: string) => $<HTMLSelectElement | HTMLInputElement>(id).value;
    const modeSel = $<HTMLSelectElement>('rrMode');
    // One tournament at a time.
    const tourOpen = !!st.tour && !st.tour.champion;
    modeSel.querySelector<HTMLOptionElement>('option[value=tour]')!.disabled = tourOpen;
    if (tourOpen && modeSel.value === 'tour') modeSel.value = 'pool';
    const tour = modeSel.value === 'tour';
    for (const e of document.querySelectorAll<HTMLElement>('#roomRules .rr-pool')) e.hidden = tour;
    for (const e of document.querySelectorAll<HTMLElement>('#roomRules .rr-tour')) e.hidden = !tour;
    for (const e of document.querySelectorAll<HTMLElement>('#roomRules .rr-same')) e.hidden = !tour || v('rrLevels') !== 'same';
    // A tournament's best of 3 or 5 is its kind; How to win picks the rule for each game.
    const rule = $<HTMLSelectElement>('rrRule');
    for (const o of rule.querySelectorAll<HTMLOptionElement>('option[value^=best]')) o.hidden = tour;
    if (tour && rule.value.startsWith('best')) rule.value = 'race';
    $<HTMLOutputElement>('rrLevelOut').value = v('rrLevel');
    $('roomStart').textContent = tour ? 'Make the tournament' : 'Make the game';
    const target = v('rrTarget') as GameRules['target'];
    $('roomRulesHelp').textContent = tour
      ? `${TOUR_HELP[v('rrTour') as TourRules['kind']]} People sign up or accept an invite; you start it when everyone's in.`
      : `You play in the first seat; the others start as computers at the players' average. Friends join a computer's seat, or you invite them. With 3 or 4 seats, ${TARGET_TEXT[target]}.`;
  }

  private make() {
    const s = this.session, by = $<HTMLSelectElement>('roomBy').value;
    if (!s || !by) return;
    const v = (id: string) => $<HTMLSelectElement | HTMLInputElement>(id).value;
    const colors = Number(v('rrColors'));
    if (v('rrMode') === 'tour') {
      const rule = v('rrRule') === 'last' ? 'last' : 'race';
      s.newTour(by, { kind: v('rrTour') as TourRules['kind'], rule, colors, levels: v('rrLevels') as TourRules['levels'], level: Number(v('rrLevel')), speed: Number(v('rrSpeed')) as Speed });
    } else {
      s.newGame(by, Number(v('roomSize')), { rule: v('rrRule') as GameRules['rule'], target: v('rrTarget') as GameRules['target'], colors });
    }
  }

  /** Back to my game: its settings card or its boards. */
  private goTo(g: number) {
    const s = this.session!;
    const game = s.state?.games.find(x => x.g === g);
    if (!game) return;
    const table = s.tables.get(g), lobby = s.lobbies.get(g);
    this.deps.show('versus');
    if (game.phase === 'playing' && table) this.deps.versus.playTable(s, g, () => this.back());
    else if (lobby) this.deps.versus.showTableLobby(s, lobby, () => this.back());
  }

  /** Watch a game (it comes up as soon as its record arrives). */
  private watch(g: number) {
    const s = this.session!;
    this.watching = g;
    for (const k of [...this.seen]) if (k.startsWith(`${g}:`)) this.seen.delete(k);
    s.view(g);
  }

  private qrFor = '';
  private link(code: string) {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('room', code);
    return url.toString();
  }

  private drawQr(code: string) {
    if (this.qrFor === code) return;
    this.qrFor = code;
    const qr = qrcode(0, 'M');
    qr.addData(this.link(code));
    qr.make();
    $<HTMLImageElement>('roomQr').src = qr.createDataURL(5, 2);
  }

  private async share() {
    const code = this.session?.state?.code;
    if (!code) return;
    this.deps.audio.play('select');
    const link = this.link(code), btn = $<HTMLButtonElement>('roomShareBtn');
    try {
      if (navigator.share) { await navigator.share({ title: 'Bug Pop', text: `Join my Bug Pop room ${code}`, url: link }); return; }
      await navigator.clipboard.writeText(link);
      btn.textContent = 'Link copied';
    } catch { /* the share sheet was closed */ }
  }

  /** For the update check: a game of mine is being played. */
  get busy() {
    const s = this.session;
    if (!s) return false;
    return [...s.tables.entries()].some(([g, t]) => !s.ended.has(g) && !t.result && t.localSeats.length > 0);
  }

  /** Re-draw on demand (after the screen comes back). */
  refresh() { if (this.session?.state && this.deps.here()) this.render(this.session.state); }
}

export { RULE_TEXT as ROOM_RULE_TEXT };
