// Online versus without a network: two OnlineMatch sides joined by a fake relay with a delay.
import { describe, expect, it } from 'vitest';
import { Bot, BOT_SKILLS, replay, type Action } from '@bug-pop/engine';
import { OnlineMatch, parseClient, parseServer, seatConfig, type ClientMsg, type SeatLog, type Start } from '../src';

const start = (seat: 0 | 1, seed = 4242, rule: 'race' | 'last' = 'race'): Start => ({
  t: 'start', seat, seed, colors: 3, rule,
  players: [{ level: 3, speed: 1, name: 'Ann' }, { level: 5, speed: 2, name: 'Bo' }], round: 1, wins: [0, 0],
});

/** Messages travel through JSON and arrive `delay` ticks later, like a real connection. */
function pair(opts: { delay?: number; seed?: number; rule?: 'race' | 'last'; tamper?: (from: 0 | 1, m: ClientMsg) => ClientMsg | null } = {}) {
  const delay = opts.delay ?? 6;
  const queue: { at: number; to: 0 | 1; raw: string }[] = [];
  let now = 0;
  const sides: OnlineMatch[] = [];
  const done: (ClientMsg & { t: 'done' })[][] = [[], []];
  // What the relay keeps of each seat, as the hosted relay does (for rejoining).
  const logs: SeatLog[] = [{ moves: [], took: [], clock: 0 }, { moves: [], took: [], clock: 0 }];
  const relay = (seat: 0 | 1) => (m: ClientMsg) => {
    const msg = opts.tamper ? opts.tamper(seat, m) : m;
    if (!msg) return;
    if (msg.t === 'done') done[seat]!.push(msg);
    // The relay checks each message and passes moves and attacks taken to the other player.
    const checked = parseClient(JSON.stringify(msg));
    if (checked?.t === 'in') { logs[seat]!.moves.push(...checked.a); logs[seat]!.clock = checked.k; }
    if (checked?.t === 'took') logs[seat]!.took.push({ k: checked.k, n: checked.n, r: checked.r });
    if (checked && (checked.t === 'in' || checked.t === 'took')) queue.push({ at: now + delay, to: (1 - seat) as 0 | 1, raw: JSON.stringify(checked) });
  };
  for (const seat of [0, 1] as const) sides[seat] = new OnlineMatch(start(seat, opts.seed, opts.rule), relay(seat));
  const run = (ticks: number, act: (seat: 0 | 1, m: OnlineMatch) => Action[]) => {
    for (let i = 0; i < ticks && !(sides[0]!.result && sides[1]!.result); i++, now++) {
      for (const seat of [0, 1] as const) sides[seat]!.tick(act(seat, sides[seat]!));
      while (queue.length && queue[0]!.at <= now) { const q = queue.shift()!; sides[q.to]!.receive(parseServer(q.raw)); }
    }
  };
  const clone = (l: SeatLog): SeatLog => JSON.parse(JSON.stringify(l)) as SeatLog;
  /** Seat 1 drops out (its unsent moves are lost) and comes back, rebuilt from the relay's logs. */
  const rejoin = () => {
    queue.splice(0, queue.length, ...queue.filter(q => q.to !== 1)); // what was on its way to them is gone too
    sides[1] = OnlineMatch.rebuild(start(1, opts.seed, opts.rule), relay(1), clone(logs[1]!), clone(logs[0]!));
    return sides[1];
  };
  return { a: sides[0]!, b: sides[1]!, sides, run, done, rejoin };
}

describe('online match', () => {
  it('each side rebuilds the other board exactly, attacks included, and both agree who won', () => {
    const { a, b, run, done } = pair({ delay: 9 });
    const bots = [new Bot(BOT_SKILLS.hard, 11), new Bot(BOT_SKILLS.hard, 22)];
    run(60 * 60 * 8, (seat, m) => bots[seat]!.act(m.me));
    expect(a.flagged).toBeNull();
    expect(b.flagged).toBeNull();
    expect(a.result).not.toBeNull();
    expect(a.result).toEqual(b.result);
    expect(done[0]![0]!.winner).toBe(done[1]![0]!.winner);
    // My copy of your board is your board.
    expect(a.them.board).toEqual(b.me.board);
    expect(b.them.board).toEqual(a.me.board);
    // And a server can replay either board from its moves and the attacks it took.
    const again = replay(seatConfig(a.start, 0), a.me.log, a.me.tick, undefined, a.me.versus!.received);
    expect(again.board).toEqual(a.me.board);
  });

  it('attacks really cross over in a long match', () => {
    const { a, b, run } = pair({ delay: 4, seed: 9, rule: 'last' });
    const bots = [new Bot(BOT_SKILLS.hard, 5), new Bot(BOT_SKILLS.medium, 6)];
    run(60 * 60 * 6, (seat, m) => bots[seat]!.act(m.me));
    const took = a.me.versus!.received.length + b.me.versus!.received.length;
    expect(took).toBeGreaterThan(0);
    expect(a.flagged ?? b.flagged).toBeNull();
    expect(a.them.board).toEqual(b.me.board);
  });

  it('a player who drops out and rejoins is rebuilt exactly and plays on', () => {
    const { sides, run, done, rejoin } = pair({ delay: 5, seed: 9 });
    const bots = [new Bot(BOT_SKILLS.hard, 5), new Bot(BOT_SKILLS.medium, 6)];
    run(60 * 30, (seat, m) => bots[seat]!.act(m.me));
    const b = rejoin();
    // The rebuilt board is the board seat 0 has been watching.
    expect(b.me.board).toEqual(sides[0]!.them.board);
    run(60 * 60 * 8, (seat, m) => bots[seat]!.act(m.me));
    expect(sides[0]!.me.versus!.received.length + b.me.versus!.received.length).toBeGreaterThan(0);
    expect(sides[0]!.flagged).toBeNull();
    expect(b.flagged).toBeNull();
    expect(sides[0]!.result).not.toBeNull();
    expect(sides[0]!.result).toEqual(b.result);
    expect(done[0]!.at(-1)!.winner).toBe(done[1]!.at(-1)!.winner);
    expect(sides[0]!.them.board).toEqual(b.me.board);
  });

  it('rounds and rejoins come through the relay intact', () => {
    const st = start(1);
    expect(parseServer(JSON.stringify(st))).toEqual(st);
    expect(parseServer(JSON.stringify({ ...st, rule: 'best3', round: 2, wins: [1, 0] }))).toMatchObject({ rule: 'best3', round: 2, wins: [1, 0] });
    const log: SeatLog = { moves: [8, 17], took: [{ k: 40, n: 2, r: 30 }], clock: 50 };
    expect(parseServer(JSON.stringify({ t: 'resume', start: st, mine: log, theirs: log }))).toEqual({ t: 'resume', start: st, mine: log, theirs: log });
    expect(parseServer(JSON.stringify({ t: 'resume', start: st, mine: { ...log, clock: -1 }, theirs: log }))).toBeNull();
    expect(parseServer('{"t":"away","seconds":60}')).toEqual({ t: 'away', seconds: 60 });
  });

  it('a player who quietly ignores attacks is flagged', () => {
    // Seat 1 never reports taking anything (as if it skipped the halves).
    const { a, run } = pair({ delay: 4, seed: 9, rule: 'last', tamper: (from, m) => (from === 1 && m.t === 'took' ? null : m) });
    const bots = [new Bot(BOT_SKILLS.hard, 5), new Bot(BOT_SKILLS.medium, 6)];
    run(60 * 60 * 6, (seat, m) => bots[seat]!.act(m.me));
    expect(a.flagged).toMatch(/never taken|different|wrong time/);
  });

  it('moves out of order are flagged', () => {
    const m = new OnlineMatch(start(0), () => undefined);
    m.receive({ t: 'in', k: 10, a: [8 * 5, 8 * 2] });
    expect(m.flagged).toBe('moves out of order');
  });

  it('the relay refuses messages that are not ours', () => {
    expect(parseClient('{"t":"in","k":5,"a":[1.5]}')).toBeNull();
    expect(parseClient('{"t":"took","k":5,"n":9,"r":30}')).toBeNull();
    expect(parseClient('nonsense')).toBeNull();
    expect(parseClient('{"t":"hello","v":1,"level":0,"speed":1}')).toBeNull();
    expect(parseClient('{"t":"hello","v":1,"level":7,"speed":1}')).toEqual({ t: 'hello', v: 1, level: 7, speed: 1 });
  });
});
