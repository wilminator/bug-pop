// Online tables of 2 to 4 seats without a network: several TableMatch devices joined by a fake
// relay that passes every message to every other device after a delay, like the room server.
import { describe, expect, it } from 'vitest';
import { Bot, BOT_SKILLS, type Action } from '@bug-pop/engine';
import { TableMatch, parseTableRaw, parseTableStart, type SeatInfo, type TableOut, type TableStart } from '../src';

const SEATS: SeatInfo[] = [
  { name: 'Ann', level: 4, speed: 1 }, { name: 'Bo', level: 4, speed: 1 },
  { name: 'Cy', level: 4, speed: 1 }, { name: 'Di', level: 4, speed: 1 },
];

/**
 * A table: `devices` lists the person seats each device plays; `cpus` seats are computers run by
 * device 0. People are played by Hard bots handing in actions, like fingers would.
 */
function table(opts: { devices: number[][]; seats?: SeatInfo[]; cpus?: number[]; watchers?: number; delay?: number; target?: 'leader' | 'random' | 'everyone'; tamper?: (from: number, m: TableOut) => TableOut | null }) {
  const seats = (opts.seats ?? SEATS.slice(0, opts.devices.flat().length + (opts.cpus?.length ?? 0))).map((p, s) => (opts.cpus?.includes(s) ? { ...p, name: 'Computer', cpu: 'medium' as const } : p));
  const delay = opts.delay ?? 6;
  const base = { t: 'tstart' as const, table: 1, seed: 4242, botSeed: 99, colors: 3, rule: 'race' as const, target: opts.target ?? 'leader', power: false, seats, round: 1, wins: seats.map(() => 0) };
  const plan = [...opts.devices.map((mine, d) => ({ mine, runs: d === 0 ? opts.cpus ?? [] : [] })), ...Array.from({ length: opts.watchers ?? 0 }, () => ({ mine: [] as number[], runs: [] as number[] }))];
  const queue: { at: number; to: number; raw: string }[] = [];
  let now = 0;
  const done: (number | null)[][] = plan.map(() => []);
  const devices = plan.map((p, d) => {
    // The start goes through the real checks, as it would from the relay.
    const start = parseTableStart(JSON.stringify({ ...base, ...p }))!;
    expect(start).not.toBeNull();
    return new TableMatch(start, m => {
      const msg = opts.tamper ? opts.tamper(d, m) : m;
      if (!msg) return;
      if (msg.t === 'tdone') { done[d]!.push(msg.winner); return; }
      if (msg.t === 'flag') return;
      for (let to = 0; to < plan.length; to++) if (to !== d) queue.push({ at: now + delay, to, raw: JSON.stringify(msg) });
    });
  });
  const people = new Map<number, Bot>(opts.devices.flat().map(s => [s, new Bot(BOT_SKILLS.hard, 1000 + s)]));
  const run = (ticks: number) => {
    for (let i = 0; i < ticks && !devices.every(d => d.result || d.flagged); i++, now++) {
      devices.forEach((dev, d) => {
        const acts = new Map<number, Action[]>();
        for (const s of plan[d]!.mine) acts.set(s, people.get(s)!.act(dev.boards[s]!.state));
        dev.tick(acts);
      });
      while (queue.length && queue[0]!.at <= now) { const q = queue.shift()!; devices[q.to]!.receive(parseTableRaw(q.raw) as never); }
    }
    // Whatever is still on its way arrives.
    while (queue.length) { const q = queue.shift()!; devices[q.to]!.receive(parseTableRaw(q.raw) as never); }
  };
  return { devices, run, done, start: base as Omit<TableStart, 'mine' | 'runs'> };
}

const boardsMatch = (devices: TableMatch[]) => {
  for (const d of devices.slice(1)) d.boards.forEach((b, s) => expect(b.state.board, `seat ${s}`).toEqual(devices[0]!.boards[s]!.state.board));
};

describe('online tables (2 to 4 seats)', { timeout: 30_000 }, () => {
  it('two devices, one seat each: same boards, same winner, no flags', () => {
    const { devices, run, done } = table({ devices: [[0], [1]], delay: 9 });
    run(60 * 60 * 8);
    expect(devices.map(d => d.flagged)).toEqual([null, null]);
    expect(devices[0]!.result).not.toBeNull();
    expect(devices[1]!.result).toEqual(devices[0]!.result);
    expect(done[0]).toEqual(done[1]);
    boardsMatch(devices);
  });

  it('four seats on three devices, a computer included, with a watcher: everyone agrees', () => {
    const { devices, run } = table({ devices: [[0], [1, 2]], cpus: [3], watchers: 1, delay: 7 });
    run(60 * 60 * 10);
    expect(devices.map(d => d.flagged)).toEqual([null, null, null]);
    const r = devices[0]!.result;
    expect(r).not.toBeNull();
    for (const d of devices) expect(d.result).toEqual(r);
    boardsMatch(devices);
    // Attacks really flew between boards.
    expect(devices[0]!.boards.reduce((n, b) => n + b.attacks.length, 0)).toBeGreaterThan(0);
  });

  it('random targets are the same on every device', () => {
    const { devices, run } = table({ devices: [[0], [1], [2]], delay: 5, target: 'random' });
    run(60 * 60 * 10);
    expect(devices.map(d => d.flagged)).toEqual([null, null, null]);
    for (const d of devices) expect(d.result).toEqual(devices[0]!.result);
    boardsMatch(devices);
  });

  it('attacks on everyone land on every other board, the same on every device', () => {
    const { devices, run } = table({ devices: [[0], [1], [2]], delay: 6, target: 'everyone' });
    run(60 * 60 * 10);
    expect(devices.map(d => d.flagged)).toEqual([null, null, null]);
    for (const d of devices) expect(d.result).toEqual(devices[0]!.result);
    boardsMatch(devices);
    const made = devices[0]!.boards.flatMap(b => b.attacks).filter(a => a.to?.length);
    expect(made.length).toBeGreaterThan(0);
    // Each landed on both other boards (while they were still playing).
    expect(made.some(a => a.to!.length === 2)).toBe(true);
  });

  it("a changed computer move is caught by every other device", () => {
    let changed = false;
    const { devices, run } = table({
      devices: [[0], [1]], cpus: [2], delay: 4,
      tamper: (from, m) => {
        if (from !== 0 || m.t !== 'tin' || m.s !== 2 || changed || !m.a.length || m.k < 300) return m;
        changed = true;
        return { ...m, a: [...m.a.slice(0, -1), (Math.floor(m.a.at(-1)! / 8)) * 8 + ((m.a.at(-1)! % 8) === 0 ? 1 : 0)] };
      },
    });
    run(60 * 60 * 4);
    expect(changed).toBe(true);
    expect(devices[1]!.flagged).toMatch(/computer/);
  });

  it('taking a smaller attack than was sent is caught', () => {
    let changed = false;
    const { devices, run } = table({
      devices: [[0], [1], [2]], delay: 4,
      tamper: (from, m) => {
        if (from !== 0 || m.t !== 'ttook' || changed) return m;
        changed = true;
        return { ...m, n: m.n - 1 };
      },
    });
    run(60 * 60 * 6);
    expect(changed).toBe(true);
    expect(devices[1]!.flagged).toMatch(/different attack/);
    expect(devices[2]!.flagged).toMatch(/different attack/);
  });

  it('an attack that is never taken is caught', () => {
    const { devices, run } = table({ devices: [[0], [1], [2]], delay: 4, tamper: (from, m) => (from === 0 && m.t === 'ttook' ? null : m) });
    run(60 * 60 * 6);
    expect(devices[1]!.flagged ?? devices[2]!.flagged).toMatch(/never taken|wrong time/);
  });
});
