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
function table(opts: {
  devices: number[][]; seats?: SeatInfo[]; cpus?: number[]; watchers?: number; delay?: number; target?: 'leader' | 'random' | 'everyone';
  tamper?: (from: number, m: TableOut) => TableOut | null;
  /** A device drops at tick `at`; device `to` plays its seats with the stand-in; it comes `back` (a fresh device) later. */
  drop?: { device: number; at: number; to: number; back?: number };
}) {
  const seats = (opts.seats ?? SEATS.slice(0, opts.devices.flat().length + (opts.cpus?.length ?? 0))).map((p, s) => (opts.cpus?.includes(s) ? { ...p, name: 'Computer', cpu: 'medium' as const } : p));
  const delay = opts.delay ?? 6;
  const base = { t: 'tstart' as const, table: 1, seed: 4242, botSeed: 99, colors: 3, rule: 'race' as const, target: opts.target ?? 'leader', power: false, seats, round: 1, wins: seats.map(() => 0) };
  const plan = [...opts.devices.map((mine, d) => ({ mine, runs: d === 0 ? opts.cpus ?? [] : [] })), ...Array.from({ length: opts.watchers ?? 0 }, () => ({ mine: [] as number[], runs: [] as number[] }))];
  // The relay: messages on their way (in order), and its record of everything passed on.
  type Q = { at: number; to: number; raw: string; drop?: number; back?: number };
  const queue: Q[] = [];
  const record: string[] = [];
  let now = 0;
  const done: (number | null)[][] = plan.map(() => []);
  let gone = -1;
  const device = (d: number, p: { mine: number[]; runs: number[] }) => {
    // The start goes through the real checks, as it would from the relay.
    const start = parseTableStart(JSON.stringify({ ...base, ...p }))!;
    expect(start).not.toBeNull();
    return new TableMatch(start, m => {
      const msg = opts.tamper ? opts.tamper(d, m) : m;
      if (!msg || d === gone) return;
      if (msg.t === 'tdone') { done[d]!.push(msg.winner); return; }
      if (msg.t === 'flag') return;
      record.push(JSON.stringify(msg));
      for (let to = 0; to < plan.length; to++) if (to !== d) queue.push({ at: now + delay, to, raw: JSON.stringify(msg) });
    });
  };
  const devices = plan.map((p, d) => device(d, p));
  const people = new Map<number, Bot>(opts.devices.flat().map(s => [s, new Bot(BOT_SKILLS.hard, 1000 + s)]));
  const deliver = (q: Q) => {
    if (q.to === gone) return;
    const dev = devices[q.to]!;
    if (q.drop !== undefined) for (const s of [...plan[q.drop]!.mine, ...plan[q.drop]!.runs]) (q.to === opts.drop!.to ? dev.takeOver(s) : dev.away(s));
    else if (q.back !== undefined) { for (const s of plan[q.back]!.mine) dev.handOver(s); }
    else dev.receive(parseTableRaw(q.raw) as never);
  };
  const run = (ticks: number) => {
    for (let i = 0; i < ticks && !devices.every((d, n) => n === gone || d.result || d.flagged); i++, now++) {
      const dr = opts.drop;
      // A device drops: it stops. After its last moves, the relay tells everyone and one device plays its seats.
      if (dr && now === dr.at) {
        gone = dr.device;
        for (let to = 0; to < plan.length; to++) if (to !== gone) queue.push({ at: now + delay, to, raw: '', drop: gone });
      }
      // It comes back as a fresh device: it catches up from the relay's record, then asks for its seats back.
      if (dr?.back !== undefined && now === dr.back) {
        const d = dr.device;
        gone = -1;
        for (let k = queue.length - 1; k >= 0; k--) if (queue[k]!.to === d) queue.splice(k, 1);
        const fresh = device(d, { mine: [], runs: [] });
        devices[d] = fresh;
        for (const raw of record) fresh.receive(parseTableRaw(raw) as never);
        for (const s of plan[d]!.mine) fresh.rejoin(s);
        queue.push({ at: now + delay, to: dr.to, raw: '', back: d });
      }
      devices.forEach((dev, d) => {
        if (d === gone) return;
        const acts = new Map<number, Action[]>();
        for (const s of plan[d]!.mine) acts.set(s, people.get(s)!.act(dev.boards[s]!.state));
        dev.tick(acts);
      });
      while (queue.length && queue[0]!.at <= now) deliver(queue.shift()!);
    }
    // Whatever is still on its way arrives.
    while (queue.length) deliver(queue.shift()!);
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

  it('a device that drops out: its board is played by the stand-in on another device, and everyone agrees', () => {
    const { devices, run } = table({ devices: [[0], [1], [2]], delay: 6, drop: { device: 1, at: 1500, to: 2 } });
    run(60 * 60 * 10);
    const left = [devices[0]!, devices[2]!];
    expect(left.map(d => d.flagged), JSON.stringify(left.map(d => d.flagged))).toEqual([null, null]);
    expect(left[0]!.result).not.toBeNull();
    expect(left[1]!.result).toEqual(left[0]!.result);
    boardsMatch(left);
    expect(devices[2]!.boards[1]!.local).toBe(true);
    expect(devices[0]!.boards[1]!.state.tick).toBeGreaterThan(1600);
  });

  it('the dropped person comes back on a fresh device and takes their seat back from the stand-in', () => {
    const { devices, run } = table({ devices: [[0], [1], [2]], delay: 6, drop: { device: 1, at: 1500, to: 2, back: 2400 } });
    run(60 * 60 * 10);
    expect(devices.map(d => d.flagged)).toEqual([null, null, null]);
    expect(devices[0]!.result).not.toBeNull();
    for (const d of devices) expect(d.result).toEqual(devices[0]!.result);
    boardsMatch(devices);
    // Seat 1 is played on device 1 again, not by the stand-in on device 2.
    expect(devices[1]!.boards[1]!.local).toBe(true);
    expect(devices[2]!.boards[1]!.local).toBe(false);
    expect(devices[0]!.boards[1]!.handedAt?.length).toBe(1);
  });

  it('the device running the computer drops: another device carries the computer on, in step', () => {
    const { devices, run } = table({ devices: [[0], [1], [2]], cpus: [3], delay: 6, drop: { device: 0, at: 1200, to: 1 } });
    run(60 * 60 * 10);
    const left = [devices[1]!, devices[2]!];
    expect(left.map(d => d.flagged)).toEqual([null, null]);
    expect(left[0]!.result).not.toBeNull();
    expect(left[1]!.result).toEqual(left[0]!.result);
    boardsMatch(left);
    expect(devices[1]!.boards[3]!.local).toBe(true);
    expect(devices[1]!.boards[3]!.drivers.map(d => d.kind)).toEqual(['cpu']);
    expect(devices[1]!.boards[0]!.drivers.map(d => d.kind)).toEqual(['standin']);
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
