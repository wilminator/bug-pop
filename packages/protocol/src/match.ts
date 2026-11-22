// One player's side of an online match, with no network code in it (the caller moves the
// messages), so the browser, the relay's tests and a server-side stand-in bot can all use it.
//
//   const m = new OnlineMatch(start, msg => socket.send(JSON.stringify(msg)));
//   every tick:            events = m.tick(myActions)          // my board, one tick
//   on each relay message: m.receive(parseServer(data))         // their moves rebuild their board
//   m.me / m.them are ordinary GameStates to draw; m.result is set once the winner is known.
//
// Live checking (anti-cheat, plan section "Cheating"): while rebuilding the opponent's board this
// side checks that their moves are well formed and that they really took every attack sent to
// them, on time and unchanged. A broken rule raises a flag (sent to the relay, and onFlag).

import { createGame, receiveAttack, step, ACTIONS, type Action, type Attack, type GameConfig, type GameEvent, type GameState } from '@bug-pop/engine';
import { MAX_ACTIONS_PER_TICK, SEND_EVERY, type ClientMsg, type SeatLog, type ServerMsg, type Start } from './messages';

/**
 * How far apart the two players' tick clocks may be when an attack lands. Both clocks start when
 * the relay says "start", so they differ by the network delay plus any hiccups. A player whose
 * page was frozen in the background falls behind, so this is generous.
 */
export const TOOK_EARLY = 5 * 60; // their clock may be up to 5 s behind mine...
export const TOOK_LATE = 10 * 60; // ...and must take it within 10 s of my sending it

export type Seat = 0 | 1;
export type MatchResult = { winner: Seat | null };

/** The game config each seat plays (same seed and colors, each player's own level and speed). */
export function seatConfig(start: Start, seat: Seat): GameConfig {
  const p = start.players[seat];
  return { seed: start.seed, level: p.level, speed: p.speed, colors: start.colors, versus: true, endless: start.rule === 'last' || undefined };
}

type Ended = { tick: number; won: boolean };

export class OnlineMatch {
  readonly seat: Seat;
  /** My board (I play it) and theirs (rebuilt from their moves). */
  readonly me: GameState;
  readonly them: GameState;
  result: MatchResult | null = null;
  flagged: string | null = null;
  onFlag?: (why: string) => void;

  /** My clock: ticks since the start. It keeps running after my board ends, so they can decide. */
  private ticks = 0;
  private sentLog = 0; // how much of me.log has gone out
  private lastSend = 0;
  /** Their clock as far as their moves have told me. */
  private theirClock = 0;
  private theirMoves = new Map<number, Action[]>();
  /** Attacks their board made, waiting to drop on mine at my next tick. */
  private incoming: Attack[] = [];
  /** Attacks my board made, in order, and when: they must take each of them. */
  private sent: { k: number; n: number; r: number; taken: boolean }[] = [];
  /** Attacks they took, waiting for their rebuilt board to reach that tick. */
  private theirTook: { k: number; n: number; r: number }[] = [];
  private tookCount = 0;
  private myEnd: Ended | null = null;
  private theirEnd: Ended | null = null;

  constructor(readonly start: Start, private send: (m: ClientMsg) => void) {
    this.seat = start.seat;
    this.me = createGame(seatConfig(start, start.seat));
    this.them = createGame(seatConfig(start, (1 - start.seat) as Seat));
  }

  /**
   * Rebuild a round in progress from both seats' logs (rejoining after a disconnect, or the
   * relay's stand-in computer taking over a board). The result is exactly the match the
   * original device had: same boards, same attacks owed, same clocks. Then play on with tick().
   */
  static rebuild(start: Start, send: (m: ClientMsg) => void, mine: SeatLog, theirs: SeatLog): OnlineMatch {
    const m = new OnlineMatch(start, () => undefined);
    const moves = new Map<number, Action[]>();
    for (const code of mine.moves) {
      const a = ACTIONS[code % 8];
      if (!a) continue;
      const t = Math.floor(code / 8);
      moves.set(t, [...(moves.get(t) ?? []), a]);
    }
    // My board, tick by tick, taking each attack at the tick I took it before.
    const took = [...mine.took];
    while (m.ticks < mine.clock) {
      while (took.length && took[0]!.k <= m.me.tick) { const t = took.shift()!; m.incoming.push({ n: t.n, r: t.r }); }
      m.tick(moves.get(m.me.tick) ?? []);
    }
    // Their board, from what they sent: the attacks they took, then their moves.
    for (const t of theirs.took) m.onTook(t.k, t.n, t.r);
    m.receive({ t: 'in', k: theirs.clock, a: theirs.moves });
    // Their attacks I already took are done; any after those are still on their way to me.
    m.incoming = m.incoming.slice(mine.took.length);
    m.sentLog = m.me.log.length;
    m.lastSend = m.ticks;
    m.send = send;
    if (m.result) send({ t: 'done', winner: m.result.winner });
    return m;
  }

  /** My clock: ticks played since the start. */
  get clock() { return this.ticks; }
  get name() { return this.start.players[this.seat].name; }
  get theirName() { return this.start.players[1 - this.seat as Seat].name; }

  /** One tick of my board with my actions. Returns my board's events (for sound and animation). */
  tick(actions: readonly Action[]): GameEvent[] {
    const events: GameEvent[] = [];
    // Attacks their board sent land first, and I tell them the tick, so their copy of my board matches.
    for (const a of this.incoming) {
      const before = this.me.versus?.received.length ?? 0;
      events.push(...receiveAttack(this.me, a));
      if ((this.me.versus?.received.length ?? 0) > before) this.out({ t: 'took', k: this.me.tick, n: a.n, r: a.r });
    }
    this.incoming = [];
    const done = this.me.phase === 'won' || this.me.phase === 'lost';
    events.push(...step(this.me, done || this.result ? [] : actions));
    for (const e of events) if (e.type === 'attack') this.sent.push({ k: this.ticks, n: e.attack.n, r: e.attack.r, taken: false });
    this.ticks++;
    if (!this.myEnd && (this.me.phase === 'won' || this.me.phase === 'lost')) {
      this.myEnd = { tick: this.me.tick, won: this.me.phase === 'won' };
      this.flush();
    }
    if (this.ticks - this.lastSend >= SEND_EVERY) this.flush();
    this.decide();
    return events;
  }

  /** Send my moves so far (also called on its own every few ticks). */
  flush() {
    const a = this.me.log.slice(this.sentLog);
    this.sentLog = this.me.log.length;
    this.lastSend = this.ticks;
    this.out({ t: 'in', k: this.ticks, a });
  }

  /** A message from the relay. Returns their board's events (for sound and animation). */
  receive(msg: ServerMsg | null): GameEvent[] {
    if (!msg || this.flagged) return [];
    if (msg.t === 'took') return this.onTook(msg.k, msg.n, msg.r);
    if (msg.t !== 'in') return [];
    // Their moves: for ticks from their last clock up to k, in order, never too many at once.
    if (msg.k < this.theirClock) return this.flag('moves went back in time');
    let prev = this.theirClock * 8;
    const perTick = new Map<number, number>();
    for (const code of msg.a) {
      const tick = Math.floor(code / 8);
      if (code < prev || tick >= msg.k || !ACTIONS[code % 8]) return this.flag('moves out of order');
      prev = code;
      const n = (perTick.get(tick) ?? 0) + 1;
      if (n > MAX_ACTIONS_PER_TICK) return this.flag('too many moves in one tick');
      perTick.set(tick, n);
      const list = this.theirMoves.get(tick) ?? [];
      list.push(ACTIONS[code % 8]!);
      this.theirMoves.set(tick, list);
    }
    this.theirClock = msg.k;
    const events = this.advanceThem();
    // Every attack I sent must have been taken soon after I sent it (unless their game is over).
    if (!this.theirEnd) for (const s of this.sent) if (!s.taken && this.theirClock > s.k + TOOK_LATE) return [...events, ...this.flag('an attack was never taken')];
    this.decide();
    return events;
  }

  private onTook(k: number, n: number, r: number): GameEvent[] {
    const s = this.sent[this.tookCount];
    if (!s) return this.flag('took an attack that was never sent');
    if (s.n !== n || s.r !== r) return this.flag('took a different attack than was sent');
    if (k < s.k - TOOK_EARLY || k > s.k + TOOK_LATE || k < this.theirClock) return this.flag('took an attack at the wrong time');
    s.taken = true;
    this.tookCount++;
    this.theirTook.push({ k, n, r });
    return [];
  }

  /** Rebuild their board up to their clock, exactly as their device played it. */
  private advanceThem(): GameEvent[] {
    const out: GameEvent[] = [];
    const t = this.them;
    while (t.tick < this.theirClock && t.phase !== 'won' && t.phase !== 'lost') {
      while (this.theirTook.length && this.theirTook[0]!.k <= t.tick) out.push(...receiveAttack(t, this.theirTook.shift()!));
      const ev = step(t, this.theirMoves.get(t.tick) ?? []);
      this.theirMoves.delete(t.tick - 1);
      for (const e of ev) if (e.type === 'attack' && !this.myEnd) this.incoming.push(e.attack);
      out.push(...ev);
    }
    if (!this.theirEnd && (t.phase === 'won' || t.phase === 'lost')) this.theirEnd = { tick: t.tick, won: t.phase === 'won' };
    return out;
  }

  /**
   * The winner is whoever's game ended first, by tick, and both devices work it out the same
   * way: clearing your bugs first wins, topping out first loses. Same tick: a clear beats a top-out,
   * and two of the same are a draw. One board ending only decides once the other has played past it.
   */
  private decide() {
    if (this.result) return;
    const mine = this.myEnd, theirs = this.theirEnd;
    let winner: Seat | null | undefined;
    const me = this.seat, them = (1 - this.seat) as Seat;
    const by = (e: Ended, who: Seat): Seat => (e.won ? who : ((1 - who) as Seat));
    if (mine && theirs) {
      if (mine.tick < theirs.tick) winner = by(mine, me);
      else if (theirs.tick < mine.tick) winner = by(theirs, them);
      else winner = mine.won === theirs.won ? null : mine.won ? me : them;
    } else if (mine && this.theirClock > mine.tick) winner = by(mine, me);
    else if (theirs && this.ticks > theirs.tick) winner = by(theirs, them);
    if (winner === undefined) return;
    this.result = { winner };
    this.flush();
    this.out({ t: 'done', winner });
  }

  private flag(why: string): GameEvent[] {
    if (!this.flagged) {
      this.flagged = why;
      this.out({ t: 'flag', why });
      this.onFlag?.(why);
    }
    return [];
  }

  private out(m: ClientMsg) { this.send(m); }
}
