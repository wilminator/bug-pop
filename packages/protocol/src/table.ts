// One device's view of an online table: 2 to 4 boards, some played here (by people on this device,
// or computers it runs), the rest rebuilt from the moves other devices send. No network code: the
// caller moves the messages. A device that plays no seats is a watcher.
//
//   const t = new TableMatch(start, msg => socket.send(JSON.stringify(msg)));
//   every tick:             t.tick(new Map([[seat, actions]]))   // the boards played here
//   on each relay message:  t.receive(msg)                        // everyone else's boards
//   t.boards[s].state is an ordinary GameState to draw; t.result is set once the round is decided.
//
// Attacks (Mike, 2026-11-22: up to 4 players): nobody picks a target. An attack made when its board
// had played k ticks waits until every board has played k ticks (usually a fraction of a second).
// Then every device works out the target the same way from that same moment: the leader (fewest
// bugs left; a tie goes by the seed), someone at random (from the seed), or everyone still playing.
// The target's device drops it on its board and says when ('ttook'). Every device checks every
// board it rebuilds: moves in order, every attack taken by the right seat, on time and unchanged,
// and computers' moves exactly what the computer would play.

import { BOT_SKILLS, Bot, createGame, receiveAttack, step, ACTIONS, type Action, type GameConfig, type GameEvent, type GameState } from '@bug-pop/engine';
import { MAX_ACTIONS_PER_TICK, SEND_EVERY, type ResumeMark, type TableDone, type TableMsg, type TableStart } from './messages';
import { STAND_IN_SKILL, TOOK_LATE } from './match';

export type TableOut = TableMsg | TableDone | { t: 'flag'; why: string };
export type TableResult = { winner: number | null };

/** The game each seat plays: the table's seed and colors, the seat's own level and speed. */
export function tableConfig(start: TableStart, s: number): GameConfig {
  const p = start.seats[s]!;
  return { seed: start.seed, level: p.level, speed: p.speed, colors: start.colors, versus: true, endless: start.rule === 'last' || undefined, ...(start.power ? { powerUps: true } : {}) };
}

/** A well-mixed 32-bit number from two (seeds for bots and the random target). */
export function mix(a: number, b: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 1, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  return (h ^ (h >>> 16)) | 0;
}

/**
 * Who plays a board from a tick on, when it isn't a person: the seat's computer, or the stand-in
 * for a person who dropped out. Both follow only from the round's botSeed, the seat and that tick,
 * so every device can play them again and check every move.
 */
export type Driver = { from: number; kind: 'cpu' | 'standin' };
export function driverBot(start: TableStart, s: number, d: Driver): Bot {
  const skill = d.kind === 'cpu' ? BOT_SKILLS[start.seats[s]!.cpu ?? 'medium'] : STAND_IN_SKILL;
  return new Bot(skill, mix(mix(start.botSeed, s + (d.kind === 'cpu' ? 16 : 0)), d.from));
}

/** An attack: made when its board had played k ticks; `to` is worked out once every board has too. */
type AttackRec = { k: number; n: number; r: number; to: number[] | null };
type Took = { k: number; n: number; r: number; from: number; i: number };

export type Board = {
  readonly s: number;
  readonly state: GameState;
  /** Played on this device: by a person here, or by a computer this device runs. */
  local: boolean;
  /** The computer or stand-in playing it here (local), or checking its moves (rebuilt). */
  bot: { bot: Bot; d: Driver } | null;
  /** Where computers and stand-ins played this board this round (for checking). */
  drivers: Driver[];
  /** Rebuilt boards: their clock and moves as far as their device has told us. */
  clock: number;
  moves: Map<number, Action[]>;
  /** Attacks this board took, waiting for the rebuilt board to reach that tick. */
  took: Took[];
  /** Attacks on their way to a local board, landing at its next tick. */
  incoming: { from: number; i: number; n: number; r: number }[];
  /** Every attack this board made, in order. */
  attacks: AttackRec[];
  sentLog: number;
  /** Bugs left over time: [ticks played, bugs left], a new entry each time it changes. */
  bugs: [number, number][];
  end: { tick: number; won: boolean } | null;
  /** Ticks where the person took the board back from the stand-in. */
  handedAt?: number[];
};

export class TableMatch {
  readonly boards: Board[];
  result: TableResult | null = null;
  flagged: string | null = null;
  onFlag?: (why: string) => void;
  /** Events of a board (for sound and animation): every board, played here or rebuilt. */
  onEvents?: (s: number, events: GameEvent[]) => void;
  /** My clock: ticks since the start. */
  private ticks = 0;
  private lastSend = 0;
  /** Attacks still waiting for every board to catch up to them. */
  private pending: { from: number; i: number }[] = [];
  /** Attacks with targets whose landings are still being checked. */
  private watching: { from: number; i: number }[] = [];
  /** Every attack taken, by "from:i:seat", for checking. */
  private tooks = new Map<string, Took & { s: number }>();
  /** Takes not yet checked against their attack's targets. */
  private unchecked: (Took & { s: number })[] = [];
  /** Seats this device is coming back to, waiting for the stand-in to hand them over. */
  private claiming = new Set<number>();
  /** Paused for a server restart: no board here plays past this tick (see pause and resume). */
  pauseAt: number | null = null;

  constructor(readonly start: TableStart, private send: (m: TableOut) => void) {
    this.boards = start.seats.map((seat, s) => {
      const cpu = !!seat.cpu;
      const drivers: Driver[] = cpu ? [{ from: 0, kind: 'cpu' }] : [];
      const local = start.mine.includes(s) || start.runs.includes(s);
      return {
        s, state: createGame(tableConfig(start, s)), local, drivers,
        bot: cpu ? { bot: driverBot(start, s, drivers[0]!), d: drivers[0]! } : null,
        clock: 0, moves: new Map(), took: [], incoming: [], attacks: [], sentLog: 0, end: null,
        bugs: [],
      };
    });
    for (const b of this.boards) b.bugs.push([0, b.state.bugsLeft]);
  }

  get clock() { return this.ticks; }
  /** Seats played on this device (people and computers). */
  get localSeats() { return this.boards.filter(b => b.local).map(b => b.s); }
  private clockOf(b: Board) { return b.local ? this.ticks : b.clock; }
  private ended(b: Board) { return b.state.phase === 'won' || b.state.phase === 'lost'; }

  /**
   * One tick of the boards played here. `actions` holds each person's actions by seat; computers
   * and stand-ins choose their own. Returns nothing: events go to onEvents.
   */
  tick(actions: ReadonlyMap<number, readonly Action[]> = new Map()) {
    // Once the round is decided, every board stops where it is (each copy at the same tick).
    if (this.result || this.flagged) return;
    if (this.pauseAt !== null && this.ticks >= this.pauseAt) return;
    for (const b of this.boards) {
      if (!b.local) continue;
      const events: GameEvent[] = [];
      for (const a of b.incoming) {
        const before = b.state.versus?.received.length ?? 0;
        events.push(...receiveAttack(b.state, a));
        if ((b.state.versus?.received.length ?? 0) > before) this.out({ t: 'ttook', s: b.s, k: b.state.tick, n: a.n, r: a.r, from: a.from, i: a.i });
      }
      b.incoming = [];
      const want = this.ended(b) ? [] : b.bot ? b.bot.bot.act(b.state) : [...(actions.get(b.s) ?? [])];
      const at = b.state.tick;
      const ev = step(b.state, want);
      events.push(...ev);
      for (const e of ev) if (e.type === 'attack') this.attackMade(b, at, e.attack.n, e.attack.r);
      this.stepped(b);
      if (events.length) this.onEvents?.(b.s, events);
    }
    this.ticks++;
    for (const b of this.boards) if (b.local) b.clock = this.ticks;
    this.resolve();
    if (this.ticks - this.lastSend >= SEND_EVERY || this.ticks === this.pauseAt || this.boards.some(b => b.local && b.end && b.sentLog < b.state.log.length)) this.flush();
    this.check();
    this.decide();
  }

  /** Send the moves of every board played here. */
  flush() {
    this.lastSend = this.ticks;
    for (const b of this.boards) {
      if (!b.local) continue;
      const a = b.state.log.slice(b.sentLog);
      b.sentLog = b.state.log.length;
      this.out({ t: 'tin', s: b.s, k: this.ticks, a });
    }
  }

  /** After a board's tick: note its bugs left, and whether it just ended. */
  private stepped(b: Board) {
    const last = b.bugs[b.bugs.length - 1]!;
    if (last[1] !== b.state.bugsLeft) b.bugs.push([b.state.tick, b.state.bugsLeft]);
    if (!b.end && this.ended(b)) b.end = { tick: b.state.tick, won: b.state.phase === 'won' };
  }

  /** Bugs left on a board once it had played `k` ticks. */
  private bugsAt(b: Board, k: number) {
    for (let j = b.bugs.length - 1; j >= 0; j--) if (b.bugs[j]![0] <= k) return b.bugs[j]![1];
    return b.bugs[0]![1];
  }

  /** An attack board `b` made in its tick `at`: its target is worked out once everyone gets there. */
  private attackMade(b: Board, at: number, n: number, r: number) {
    b.attacks.push({ k: at + 1, n, r, to: null });
    this.pending.push({ from: b.s, i: b.attacks.length - 1 });
  }

  /** Work out the targets of every attack the whole table has caught up to. */
  private resolve() {
    if (!this.pending.length) return;
    const behind = Math.min(...this.boards.map(b => (b.end ? Infinity : b.state.tick)));
    const still: { from: number; i: number }[] = [];
    for (const p of this.pending) {
      const rec = this.boards[p.from]!.attacks[p.i]!;
      if (rec.k > behind) { still.push(p); continue; }
      rec.to = this.targets(p.from, p.i, rec.k);
      this.watching.push(p);
      for (const s of rec.to) {
        const t = this.boards[s]!;
        if (t.local && !this.ended(t) && !this.result) t.incoming.push({ from: p.from, i: p.i, n: rec.n, r: rec.r });
      }
    }
    this.pending = still;
  }

  /**
   * Who attack `i` from seat `from` hits, from the boards once they had all played `k` ticks: the
   * same answer on every device. Only boards still playing then can be hit.
   */
  targets(from: number, i: number, k: number): number[] {
    const others = this.boards.filter(o => o.s !== from && !(o.end && o.end.tick <= k));
    if (!others.length) return [];
    if (this.start.target === 'everyone') return others.map(o => o.s);
    const roll = (list: Board[]) => [list[(mix(mix(this.start.botSeed, from + 32), i) >>> 0) % list.length]!.s];
    if (others.length === 1 || this.start.target === 'random') return roll(others);
    const fewest = Math.min(...others.map(o => this.bugsAt(o, k)));
    return roll(others.filter(o => this.bugsAt(o, k) === fewest));
  }

  /** A message from the relay (another device's seats). */
  receive(msg: TableMsg | null) {
    if (!msg || this.flagged) return;
    const b = this.boards[msg.s];
    if (!b) return void this.flag('a seat that is not at this table');
    if (b.local) return; // my own seats come back to me only by mistake
    if (msg.t === 'thand') {
      if (msg.k !== b.clock) return void this.flag('handed over at the wrong time');
      if (this.claiming.has(msg.s)) this.claim(b, msg.k);
      else this.handed(msg.s, msg.k);
    } else if (msg.t === 'ttook') {
      const key = `${msg.from}:${msg.i}:${msg.s}`;
      if (this.tooks.has(key)) return void this.flag('an attack taken twice');
      if (msg.k < b.clock) return void this.flag('took an attack at the wrong time');
      const tk = { k: msg.k, n: msg.n, r: msg.r, from: msg.from, i: msg.i };
      this.tooks.set(key, { ...tk, s: msg.s });
      this.unchecked.push({ ...tk, s: msg.s });
      b.took.push(tk);
    } else {
      // Moves: for ticks from its last clock up to k, in order, never too many at once.
      if (msg.k < b.clock) return void this.flag('moves went back in time');
      let prev = b.clock * 8;
      const perTick = new Map<number, number>();
      for (const code of msg.a) {
        const tick = Math.floor(code / 8);
        if (code < prev || tick >= msg.k || !ACTIONS[code % 8]) return void this.flag('moves out of order');
        prev = code;
        const n = (perTick.get(tick) ?? 0) + 1;
        if (n > MAX_ACTIONS_PER_TICK) return void this.flag('too many moves in one tick');
        perTick.set(tick, n);
        const list = b.moves.get(tick) ?? [];
        list.push(ACTIONS[code % 8]!);
        b.moves.set(tick, list);
      }
      b.clock = msg.k;
      this.advance(b);
      this.resolve();
    }
    this.check();
    this.decide();
  }

  /** Rebuild a board up to its clock, exactly as its device played it. */
  private advance(b: Board) {
    const t = b.state, out: GameEvent[] = [];
    while (t.tick < b.clock && !this.ended(b)) {
      b.took.sort((x, y) => x.k - y.k);
      while (b.took.length && b.took[0]!.k <= t.tick) out.push(...receiveAttack(t, b.took.shift()!));
      const logged = b.moves.get(t.tick) ?? [];
      b.moves.delete(t.tick);
      // A computer or stand-in played this tick: its moves must be exactly the computer's.
      const d = [...b.drivers].reverse().find(x => x.from <= t.tick && (x.kind === 'cpu' || this.standInAt(b, x, t.tick)));
      if (d) {
        if (b.bot?.d !== d) b.bot = { bot: driverBot(this.start, b.s, d), d };
        const want = b.bot.bot.act(t);
        if (want.length !== logged.length || want.some((a, i) => a !== logged[i])) { this.flag(d.kind === 'cpu' ? "a computer's moves were changed" : "the stand-in computer's moves were changed"); return; }
      }
      const at = t.tick;
      const ev = step(t, logged);
      for (const e of ev) if (e.type === 'attack') this.attackMade(b, at, e.attack.n, e.attack.r);
      out.push(...ev);
      this.stepped(b);
    }
    if (out.length) this.onEvents?.(b.s, out);
  }

  /** Stand-in segments end when the person comes back ('handed' marks it with a 'person' gap). */
  private standInAt(b: Board, d: Driver, tick: number) {
    const i = b.drivers.indexOf(d);
    const next = b.drivers[i + 1];
    return d.kind === 'standin' && (!next || tick < next.from) && !(b.handedAt !== undefined && b.handedAt.some(h => h > d.from && tick >= h));
  }

  /**
   * Every attack must be taken by each of its targets soon after it was made, unchanged, and by
   * nobody else. Checked against the target's clock (it has played on without taking it).
   */
  private check() {
    if (this.flagged) return;
    this.unchecked = this.unchecked.filter(tk => {
      const rec = this.boards[tk.from]!.attacks[tk.i];
      if (!rec?.to || this.flagged) return true; // its attack isn't worked out yet here
      if (!rec.to.includes(tk.s)) this.flag('took an attack aimed at someone else');
      else if (tk.n !== rec.n || tk.r !== rec.r) this.flag('took a different attack than was sent');
      else if (tk.k < rec.k || tk.k > rec.k + TOOK_LATE) this.flag('took an attack at the wrong time');
      return false;
    });
    if (this.flagged) return;
    this.watching = this.watching.filter(({ from, i }) => {
      const rec = this.boards[from]!.attacks[i]!;
      let open = false;
      for (const s of rec.to!) {
        const t = this.boards[s]!;
        if (this.tooks.has(`${from}:${i}:${s}`) || t.local || t.end) continue;
        if (this.clockOf(t) > rec.k + TOOK_LATE) { this.flag('an attack was never taken'); return false; }
        open = true;
      }
      return open;
    });
  }

  /**
   * Who won, worked out the same way on every device. Clearing your bugs first (by tick) wins;
   * topping out puts you out, and the last one going wins. Same tick: a draw. A board's end only
   * decides once every other board has played past it.
   */
  private decide() {
    if (this.result || this.flagged) return;
    const bs = this.boards;
    let winner: number | null | undefined;
    const wins = bs.filter(b => b.end?.won);
    if (wins.length) {
      const w = Math.min(...wins.map(b => b.end!.tick));
      if (!bs.every(b => b.end || this.clockOf(b) > w)) return;
      const first = wins.filter(b => b.end!.tick === w);
      winner = first.length === 1 ? first[0]!.s : null;
    } else {
      const going = bs.filter(b => !b.end);
      if (going.length > 1) return;
      const last = Math.max(...bs.filter(b => b.end).map(b => b.end!.tick));
      if (going.length === 1) {
        if (this.clockOf(going[0]!) <= last) return;
        winner = going[0]!.s;
      } else {
        const at = bs.filter(b => b.end!.tick === last);
        winner = at.length === 1 ? at[0]!.s : null;
      }
    }
    this.result = { winner };
    if (this.localSeats.length) { this.flush(); this.out({ t: 'tdone', winner }); }
  }

  /**
   * A person dropped out and this device plays their board with the stand-in from its clock on
   * (the relay picks one device). Attacks they said they took ahead of the moves they sent never
   * happened on their board: the stand-in takes them again.
   */
  takeOver(s: number) {
    const b = this.boards[s];
    if (!b || b.local || this.result) return;
    this.forgetAhead(b);
    // A computer's board, or one a stand-in already plays (its device dropped too): the same
    // player carries on here (this device has been checking it move by move, so it's in step).
    const now = this.driving(b);
    if (now) { if (b.bot?.d !== now) b.bot = { bot: driverBot(this.start, s, now), d: now }; }
    else {
      const d: Driver = { from: b.state.tick, kind: 'standin' };
      b.drivers.push(d);
      b.bot = { bot: driverBot(this.start, s, d), d };
    }
    b.local = true;
    b.sentLog = b.state.log.length;
    // Attacks already aimed at it but not taken yet come to it now (later ones as they're worked out).
    for (const o of this.boards) o.attacks.forEach((a, i) => { if (a.to?.includes(s) && !this.tooks.has(`${o.s}:${i}:${s}`)) b.incoming.push({ from: o.s, i, n: a.n, r: a.r }); });
    // Catch it up to my clock (its device was behind mine).
    while (b.state.tick < this.ticks && !this.ended(b)) {
      for (const a of b.incoming) { receiveAttack(b.state, a); this.out({ t: 'ttook', s, k: b.state.tick, n: a.n, r: a.r, from: a.from, i: a.i }); }
      b.incoming = [];
      const want = b.bot.bot.act(b.state);
      const at = b.state.tick;
      for (const e of step(b.state, want)) if (e.type === 'attack') this.attackMade(b, at, e.attack.n, e.attack.r);
      this.stepped(b);
    }
    this.resolve();
  }

  /** Someone else's device plays a dropped seat now: drop what it said it took ahead of its moves. */
  away(s: number) {
    const b = this.boards[s];
    if (!b || b.local) return;
    this.forgetAhead(b);
    if (!this.driving(b)) b.drivers.push({ from: b.clock, kind: 'standin' });
  }

  /** The computer or stand-in playing a board at its current tick, if one is. */
  private driving(b: Board): Driver | null {
    const t = b.state.tick;
    return [...b.drivers].reverse().find(x => x.from <= t && (x.kind === 'cpu' || this.standInAt(b, x, t))) ?? null;
  }

  private forgetAhead(b: Board) {
    for (const t of b.took.filter(t => t.k >= b.clock)) this.tooks.delete(`${t.from}:${t.i}:${b.s}`);
    b.took = b.took.filter(t => t.k < b.clock);
    for (const k of [...b.moves.keys()]) if (k >= b.clock) b.moves.delete(k);
  }

  /** The person is back: stop the stand-in here (send its last moves); their device plays on. */
  handOver(s: number) {
    const b = this.boards[s];
    if (!b?.bot || b.bot.d.kind !== 'standin' || !b.local) return;
    this.flush();
    b.local = false;
    b.bot = null;
    b.clock = this.ticks;
    (b.handedAt ??= []).push(b.state.tick);
    this.out({ t: 'thand', s, k: b.state.tick });
  }

  /** On other devices: the person took their seat back at its tick `k`. */
  handed(s: number, k: number) {
    const b = this.boards[s];
    if (b) (b.handedAt ??= []).push(k);
  }

  /**
   * This device is the person coming back to seat `s` (after catching up from the relay's record).
   * It plays the seat again once the stand-in hands it over ('thand').
   */
  rejoin(s: number) { this.claiming.add(s); }

  private claim(b: Board, k: number) {
    this.claiming.delete(b.s);
    (b.handedAt ??= []).push(k);
    b.local = true;
    b.bot = null;
    b.sentLog = b.state.log.length;
    this.ticks = Math.max(this.ticks, b.clock);
    // Attacks aimed at it that the stand-in hadn't taken yet come to it now.
    for (const o of this.boards) o.attacks.forEach((a, i) => { if (a.to?.includes(b.s) && !this.tooks.has(`${o.s}:${i}:${b.s}`)) b.incoming.push({ from: o.s, i, n: a.n, r: a.r }); });
  }

  /**
   * The server is restarting: play on to tick `k`, send everything up to it, and stop there (a
   * device already past `k` stops now; the server cuts every board back to `k` when it saves).
   */
  pause(k: number) {
    this.pauseAt = Math.max(k, this.ticks);
    if (this.ticks >= this.pauseAt) this.flush();
  }

  /**
   * The round carries on at tick `mark.k` after a restart (every board was rebuilt to it from the
   * saved record). Seats in `standins` are played by the stand-in from there; a person whose seat
   * the stand-in played before is back. Every device notes this, in the record too.
   */
  mark(m: ResumeMark) {
    for (const b of this.boards) {
      if (this.start.seats[b.s]!.cpu) continue;
      const d = this.driving(b);
      if (m.standins.includes(b.s)) { if (d?.kind !== 'standin') b.drivers.push({ from: m.k, kind: 'standin' }); }
      else if (d?.kind === 'standin') (b.handedAt ??= []).push(m.k);
    }
  }

  /** Carry on from the mark: this device plays `mine` (people here) and `runs` (computers, stand-ins). */
  resume(m: ResumeMark, mine: readonly number[], runs: readonly number[]) {
    this.mark(m);
    this.pauseAt = null;
    this.ticks = m.k;
    this.lastSend = m.k;
    for (const b of this.boards) {
      b.clock = m.k;
      b.local = mine.includes(b.s) || runs.includes(b.s);
      if (!b.local) continue;
      b.sentLog = b.state.log.length;
      if (mine.includes(b.s)) b.bot = null;
      else {
        // The same computer that played (or checked) it up to here carries on, so every copy agrees.
        const d = this.driving(b);
        if (d && b.bot?.d !== d) b.bot = { bot: driverBot(this.start, b.s, d), d };
      }
      b.incoming = [];
      for (const o of this.boards) o.attacks.forEach((a, i) => { if (a.to?.includes(b.s) && !this.tooks.has(`${o.s}:${i}:${b.s}`)) b.incoming.push({ from: o.s, i, n: a.n, r: a.r }); });
    }
  }

  private flag(why: string) {
    if (this.flagged) return;
    this.flagged = why;
    this.out({ t: 'flag', why });
    this.onFlag?.(why);
  }

  private out(m: TableOut) { this.send(m); }
}
