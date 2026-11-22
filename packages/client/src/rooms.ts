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
import { MAX_PER_DEVICE, ROOM_VERSION, RoomSession, parseRoomServer, type RoomRules, type RoomState } from '@bug-pop/protocol';
import qrcode from 'qrcode-generator';
import type { AudioManager } from './audio';
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

export type RoomJoin = { room: string; level: number; speed: Speed; power: boolean };
export type RoomDeps = {
  url: string;
  audio: AudioManager;
  versus: Versus;
  /** Show the room screen, the versus screen, or (on leaving) the Multiplayer screen. */
  show: (m: 'room' | 'versus' | 'versusSetup') => void;
  /** Is the room screen (or a game from it) on show? */
  here: () => boolean;
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

  constructor(private deps: RoomDeps) {
    $('roomLeave').addEventListener('click', () => { deps.audio.play('select'); this.leave(); });
    $('roomShareBtn').addEventListener('click', () => void this.share());
    $('roomStart').addEventListener('click', () => {
      const s = this.session, by = $<HTMLSelectElement>('roomBy').value;
      if (!s || !by) return;
      deps.audio.play('select');
      s.newGame(by, Number($<HTMLSelectElement>('roomSize').value));
    });
    $('roomTourStart').addEventListener('click', () => { deps.audio.play('select'); this.session?.startTour(); });
    $('roomAddForm').addEventListener('submit', e => {
      e.preventDefault();
      const input = $<HTMLInputElement>('roomAddName'), name = input.value.trim();
      if (!name || !this.session) return;
      deps.audio.play('select');
      this.session.addPerson(name);
      input.value = '';
    });
    const rules = $<HTMLFormElement>('roomRules');
    rules.addEventListener('change', () => this.sendRules());
    $<HTMLInputElement>('rrLevel').addEventListener('input', () => { $<HTMLOutputElement>('rrLevelOut').value = $<HTMLInputElement>('rrLevel').value; });
  }

  get open() { return !!this.session; }

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
    $('roomStatus').textContent = 'Connecting...';
    this.deps.show('room');
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
    ws.addEventListener('close', () => {
      if (this.ws !== ws || this.leaving) return;
      this.ws = null;
      const code = this.session?.state?.code;
      // Lost the connection: back in the same room (the server keeps my seats; the stand-in plays meanwhile).
      if (code && this.tries < 5) {
        this.tries++;
        $('roomStatus').textContent = 'Connection lost. Reconnecting...';
        window.setTimeout(() => { if (this.session && !this.leaving) this.connect(code); }, 1500);
        return;
      }
      $('roomStatus').textContent = this.session?.error ?? "Couldn't reach the game server. Check your connection and try again.";
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

  /** The room changed: redraw it, and bring up any game of mine that needs me. */
  private changed() {
    const s = this.session;
    if (!s?.state) { if (s?.error) $('roomStatus').textContent = s.error; return; }
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
    const owner = s.isOwner;
    $('roomTitle').textContent = `Room ${st.code}`;
    $('roomCodeText').textContent = st.code;
    this.drawQr(st.code);
    const ownerName = st.people.find(p => p.pid === st.owner)?.name ?? 'someone';
    $('roomStatus').textContent = owner ? 'You own this room: you set the rules.' : `${ownerName} owns this room and sets the rules.`;

    // People: who's here, Watch only, and the people on this device.
    $('roomPeople').replaceChildren(...st.people.map(p => {
      const li = el('li', p.here ? '' : 'away');
      li.append(el('b', '', p.name));
      const notes = [p.pid === st.owner ? 'owner' : '', p.mine ? 'on this device' : '', !p.here ? 'away' : '', p.game !== null ? `in game ${p.game}` : p.watch ? 'watching' : 'free'].filter(Boolean);
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
      }
      return li;
    }));
    $('roomAddForm').hidden = s.mine.length >= MAX_PER_DEVICE;

    // Games: who's at each, and what I can do there.
    const free = s.mine.filter(p => p.game === null);
    $('roomGames').replaceChildren(...(st.games.length ? st.games.map(game => {
      const box = el('div', 'room-game');
      box.append(el('b', '', `Game ${game.g}${game.tour ? ' (tournament)' : ''}: ${game.phase === 'playing' ? `playing round ${game.round}` : 'getting ready'}`));
      const seats = el('div', 'room-seats');
      game.seats.forEach((seat, i) => {
        const chip = el('span', `room-seat${seat.pid && mine.has(seat.pid) ? ' me' : ''}`, `${seat.name}${game.wins[i] ? ` (${game.wins[i]})` : ''}`);
        seats.append(chip);
        // A person can take a computer's seat (from its next round).
        if (seat.cpu && free.length && !game.tour) {
          const take = el('button', '', free.length === 1 ? 'Take this seat' : `Take this seat for ${free[0]!.name}`);
          take.addEventListener('click', () => { this.deps.audio.play('select'); s.takeSeat(free[0]!.pid, game.g, i); });
          seats.append(take);
        }
      });
      box.append(seats);
      const seated = game.seats.some(x => x.pid && mine.has(x.pid));
      const row = el('div', 'room-row');
      if (seated) {
        const go = el('button', 'primary', 'Go to my game');
        go.addEventListener('click', () => { this.deps.audio.play('select'); this.goTo(game.g); });
        row.append(go);
      } else {
        const watch = el('button', '', 'Watch');
        watch.addEventListener('click', () => { this.deps.audio.play('select'); this.watch(game.g); });
        row.append(watch);
      }
      box.append(row);
      return box;
    }) : [el('p', 'fine', st.rules.mode === 'tour' ? 'No tournament games yet.' : 'No games yet. Start one below.')]));

    // Starting a game (open pool only).
    const pool = st.rules.mode === 'pool';
    $('roomNew').hidden = !pool || !free.length;
    $('roomNewNote').hidden = !pool;
    const by = $<HTMLSelectElement>('roomBy');
    const keep = by.value;
    by.replaceChildren(...free.map(p => { const o = el('option', '', p.name); o.value = p.pid; return o; }));
    if (free.some(p => p.pid === keep)) by.value = keep;
    $('roomByRow').hidden = free.length < 2;

    // The tournament: standings, matches, and the owner's Start.
    $('roomTour').hidden = pool;
    if (!pool) {
      const t = st.tour;
      $('roomTourTitle').textContent = t ? (t.champion ? `${st.people.find(p => p.pid === t.champion)?.name ?? 'Someone'} won the tournament` : `Tournament: ${TOUR_TEXT[t.kind]}`) : `Tournament: ${TOUR_TEXT[st.rules.tour]}`;
      const rows: HTMLTableRowElement[] = [];
      if (t) {
        const head = el('tr');
        head.append(el('th', '', 'Player'), el('th', '', 'Won'), el('th', '', 'Lost'));
        rows.push(head);
        for (const p of t.players) {
          const tr = el('tr', p.out ? 'out' : '');
          tr.append(el('td', '', p.name), el('td', '', String(p.wins)), el('td', '', String(p.losses)));
          rows.push(tr);
        }
      }
      $('roomTourTable').replaceChildren(...rows);
      $('roomTourStart').hidden = !owner || (!!t && !t.champion) || st.games.length > 0;
      $('roomTourStart').textContent = t?.champion ? 'Start another tournament' : 'Start the tournament';
    }

    // The rules: the owner changes them while no game is going.
    const locked = !owner || st.games.length > 0 || (!!st.tour && !st.tour.champion);
    $('roomRulesNote').textContent = !owner ? `${ownerName} sets these.` : locked ? "The rules can't change while a game is going." : 'Every game in the room uses these.';
    this.fillRules(st.rules, locked);
  }

  private fillRules(r: RoomRules, locked: boolean) {
    const set = (id: string, v: string) => { const e = $<HTMLSelectElement | HTMLInputElement>(id); if (document.activeElement !== e) e.value = v; e.disabled = locked; };
    set('rrMode', r.mode); set('rrRule', r.rule); set('rrRotation', r.rotation); set('rrTarget', r.target); set('rrColors', String(r.colors));
    set('rrTour', r.tour); set('rrLevels', r.tourLevels); set('rrLevel', String(r.level)); set('rrSpeed', String(r.speed));
    $<HTMLOutputElement>('rrLevelOut').value = String(r.level);
    const tour = r.mode === 'tour';
    for (const e of document.querySelectorAll<HTMLElement>('#roomRules .rr-pool')) e.hidden = tour;
    for (const e of document.querySelectorAll<HTMLElement>('#roomRules .rr-tour')) e.hidden = !tour;
    for (const e of document.querySelectorAll<HTMLElement>('#roomRules .rr-same')) e.hidden = !tour || r.tourLevels !== 'same';
    // What the choices mean, in a line.
    $('roomRulesHelp').textContent = tour
      ? `${TOUR_HELP[r.tour]} Always 1 against 1, two games at a time; everyone else watches.`
      : `Open pool: anyone not playing starts a game of 2 to 4, computers fill empty seats. ${r.rotation === 'winner' ? 'Winner stays: the winner keeps their seat and the others come from whoever is waiting.' : 'Random draw: the next players are drawn at random, and people who sat out the last game go first.'} ${r.target === 'leader' ? 'Attacks go to the leader (fewest bugs left).' : r.target === 'random' ? 'Attacks go to someone at random.' : 'Attacks go to everyone.'}`;
    // A tournament's best of 3 or 5 is its own setting; How to win picks the rule for each game.
    const rule = $<HTMLSelectElement>('rrRule');
    for (const o of rule.querySelectorAll<HTMLOptionElement>('option[value^=best]')) o.hidden = tour;
  }

  private sendRules() {
    const s = this.session;
    if (!s?.state || !s.isOwner) return;
    const v = (id: string) => $<HTMLSelectElement | HTMLInputElement>(id).value;
    const mode = v('rrMode') as RoomRules['mode'];
    let rule = v('rrRule') as RoomRules['rule'];
    if (mode === 'tour' && (rule === 'best3' || rule === 'best5')) rule = 'race';
    s.rules({
      mode, rule, rotation: v('rrRotation') as RoomRules['rotation'], target: v('rrTarget') as RoomRules['target'], colors: Number(v('rrColors')),
      tour: v('rrTour') as RoomRules['tour'], tourLevels: v('rrLevels') as RoomRules['tourLevels'], level: Number(v('rrLevel')), speed: Number(v('rrSpeed')) as Speed,
    });
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
