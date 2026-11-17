import { describe, expect, it } from 'vitest';
import {
  BOARD_HEIGHT as H, BOARD_WIDTH as W, AFTER_CLEAR_TICKS, LAND_TICKS, SOFT_DROP_TICKS, bugCount, bugZoneRows, packLog, unpackLog, addBugs, currentLevel, ARRIVE_TICKS, FULL_BOARD_LEVEL, createGame, FINAL_LEVEL, MAX_LEVEL, isEndless, gravityInterval, deserialize, emptyBoard, findMatches, idx,
  removeCells, pieceCells, replay, SLO_MO, serialize, settleStep, step, type Action, type GameEvent, type Cell, type GameState,
} from '../src';

const cfg = { seed: 12345, level: 5, speed: 1 as const, colors: 3 };

/** A scripted "player": a cheap deterministic action pattern. */
function scripted(tick: number): Action[] {
  const pattern: Action[][] = [['left'], [], ['rotCW'], [], ['right'], ['softOn'], [], ['softOff']];
  return tick % 7 === 0 ? pattern[(tick / 7) % pattern.length]! : [];
}

function play(s: GameState, ticks: number) {
  for (let i = 0; i < ticks && s.phase !== 'won' && s.phase !== 'lost'; i++) step(s, scripted(s.tick));
}

describe('setup', () => {
  it('places the right number of bugs, in the bug zone, with no ready-made matches', () => {
    for (const level of [0, 5, 10, 20]) {
      const s = createGame({ ...cfg, level });
      const bugs = s.board.filter(c => c?.t === 'bug');
      expect(bugs.length).toBe(bugCount(level));
      expect(s.bugsLeft).toBe(bugCount(level));
      expect(s.board.slice(0, W * 3).every(c => c === null)).toBe(true);
      expect(findMatches(s.board)).toEqual([]);
    }
  });

  it('uses only the configured colors', () => {
    const s = createGame({ ...cfg, colors: 2, level: 10 });
    expect(new Set(s.board.filter(Boolean).map(c => c!.c))).toEqual(new Set([0, 1]));
  });

  it('is deterministic for a seed and different across seeds', () => {
    expect(serialize(createGame(cfg))).toBe(serialize(createGame(cfg)));
    expect(serialize(createGame(cfg))).not.toBe(serialize(createGame({ ...cfg, seed: 999 })));
  });
});

describe('board rules', () => {
  it('finds runs of four or more, horizontally and vertically', () => {
    const b = emptyBoard();
    for (let x = 1; x <= 4; x++) b[idx(x, 15)] = { t: 'bug', c: 1 };
    for (let y = 10; y <= 12; y++) b[idx(7, y)] = { t: 'half', c: 2, l: null };
    expect(findMatches(b)).toEqual([idx(1, 15), idx(2, 15), idx(3, 15), idx(4, 15)]);
    b[idx(7, 13)] = { t: 'half', c: 2, l: null };
    expect(findMatches(b)).toHaveLength(8);
  });

  it('turns a half into a lone half when its partner is removed', () => {
    const b = emptyBoard();
    b[idx(2, 15)] = { t: 'half', c: 0, l: 'R' };
    b[idx(3, 15)] = { t: 'half', c: 1, l: 'L' };
    removeCells(b, [idx(3, 15)]);
    expect(b[idx(2, 15)]).toEqual({ t: 'half', c: 0, l: null });
  });

  it('drops loose halves and keeps pairs together', () => {
    const b: Cell[] = emptyBoard();
    b[idx(0, 10)] = { t: 'half', c: 0, l: null }; // lone half falls
    b[idx(2, 10)] = { t: 'half', c: 0, l: 'R' }; // sideways pair, one foot supported: stays
    b[idx(3, 10)] = { t: 'half', c: 1, l: 'L' };
    b[idx(3, 11)] = { t: 'bug', c: 2 };
    b[idx(5, 9)] = { t: 'half', c: 0, l: 'D' }; // upright pair falls as one
    b[idx(5, 10)] = { t: 'half', c: 1, l: 'U' };
    while (settleStep(b));
    expect(b[idx(0, H - 1)]).toMatchObject({ t: 'half' });
    expect(b[idx(2, 10)]).toMatchObject({ l: 'R' });
    expect(b[idx(5, H - 1)]).toMatchObject({ l: 'U' });
    expect(b[idx(5, H - 2)]).toMatchObject({ l: 'D' });
  });
});

describe('play', () => {
  it('pieces fall, lock and the next one spawns', () => {
    const s = createGame(cfg);
    const first = s.piecesSpawned;
    play(s, 60 * 30);
    expect(s.piecesSpawned).toBeGreaterThan(first);
    expect(s.board.some(c => c?.t === 'half')).toBe(true);
  });

  it('held-down drop averages 2.5 ticks a row, and the beats are whole drop steps', () => {
    const s = createGame({ ...cfg, level: 0 });
    s.board = emptyBoard(); s.bugsLeft = 1; s.board[idx(7, 15)] = { t: 'bug', c: 2 };
    s.piece = { x: 0, y: 0, rot: 0, a: 0, b: 1 };
    step(s, ['softOn']);
    const y0 = s.piece!.y; let ticks = 1;
    while (s.piece && s.piece.y < y0 + 10) { step(s); ticks++; }
    expect(ticks).toBeGreaterThanOrEqual(24); expect(ticks).toBeLessThanOrEqual(26); // 10 rows ~ 25 ticks
    expect(LAND_TICKS % SOFT_DROP_TICKS).toBe(0);
    expect(AFTER_CLEAR_TICKS % SOFT_DROP_TICKS).toBe(0);
  });

  it('waits a beat after a landing, and longer after a clear, before the next piece', () => {
    const s = createGame({ ...cfg, level: 0 });
    s.board = emptyBoard();
    s.board[idx(7, 15)] = { t: 'bug', c: 2 }; s.bugsLeft = 1;
    s.piece = { x: 0, y: 14, rot: 0, a: 0, b: 1 };
    let t = 0; const events: string[] = [];
    while (s.phase === 'falling' && t++ < 500) events.push(...step(s).map(e => e.type));
    expect(s.phase).toBe('waiting');
    let wait = 0;
    while ((s.phase as string) === 'waiting') { step(s); wait++; }
    expect(wait).toBe(LAND_TICKS);
    // Now a clear: three halves and a piece that completes four, plus a loose half that falls.
    s.board = emptyBoard();
    s.board[idx(7, 15)] = { t: 'bug', c: 2 };
    for (const y of [15, 14, 13]) s.board[idx(0, y)] = { t: 'half', c: 1, l: null };
    s.board[idx(3, 9)] = { t: 'half', c: 0, l: null }; // floating, so it falls once the board settles
    s.bugsLeft = 1;
    s.piece = { x: 0, y: 8, rot: 1, a: 1, b: 1 }; // vertical, lands on the three: five in a column
    const seen: string[] = [];
    for (let i = 0; i < 2000 && (s.phase as string) !== 'waiting'; i++) seen.push(...step(s).map(e => e.type));
    expect(seen).toContain('match');
    expect(seen).toContain('fall');
    wait = 0;
    while ((s.phase as string) === 'waiting') { step(s); wait++; }
    expect(wait).toBe(AFTER_CLEAR_TICKS);
  });

  it('ends in a loss when the spawn point is blocked', () => {
    const s = createGame(cfg);
    // Block the cells under the spawn point: the piece locks at the top,
    // and the next piece has nowhere to appear.
    s.board[idx(3, 1)] = { t: 'half', c: 0, l: null };
    s.board[idx(4, 1)] = { t: 'half', c: 1, l: null };
    const events = [];
    for (let i = 0; i < 300 && (s.phase === 'falling' || s.phase === 'waiting'); i++) events.push(...step(s));
    expect(s.phase).toBe('lost');
    expect(events.map(e => e.type)).toContain('lost');
  });

  it('clears a match, scores it and wins when the last bug goes', () => {
    const s = createGame({ ...cfg, level: 0 });
    // Hand-build a board with one bug and three matching halves above it.
    s.board = emptyBoard();
    s.board[idx(0, 15)] = { t: 'bug', c: 1 };
    s.board[idx(0, 14)] = { t: 'half', c: 1, l: null };
    s.board[idx(0, 13)] = { t: 'half', c: 1, l: null };
    s.bugsLeft = 1;
    s.piece = { x: 0, y: 12, rot: 1, a: 1, b: 0 }; // a lands on top, completing four
    const events = [];
    for (let i = 0; i < 400 && s.phase !== 'won'; i++) events.push(...step(s));
    expect(s.phase).toBe('won');
    expect(s.score).toBeGreaterThan(0);
    expect(events.map(e => e.type)).toContain('match');
  });
});

describe('save and replay', () => {
  it('a saved game resumes exactly where it stopped', () => {
    const a = createGame(cfg);
    play(a, 2000);
    const b = deserialize(serialize(a));
    play(a, 3000);
    play(b, 3000);
    expect(serialize(b)).toBe(serialize(a));
  });

  it('replaying the input log reproduces the game exactly', () => {
    const live = createGame(cfg);
    play(live, 60 * 120);
    const rebuilt = replay(cfg, live.log, live.tick);
    expect(serialize(rebuilt)).toBe(serialize(live));
  });

  it('a carried-over score starts the next level and replays exactly', () => {
    const next = { ...cfg, level: 1, startScore: 1200 };
    expect(createGame(next).score).toBe(1200);
    expect(createGame(cfg).score).toBe(0);
    const live = createGame(next);
    play(live, 60 * 120);
    expect(live.score).toBeGreaterThanOrEqual(1200);
    expect(serialize(replay(next, live.log, live.tick))).toBe(serialize(live));
    // Claiming a bigger carry-in than the run had changes the replayed result.
    expect(replay({ ...next, startScore: 5000 }, live.log, live.tick).score).not.toBe(live.score);
  });

  it('bugs grow 4 every 3 levels from 4, reaching 84 at level 60', () => {
    expect([0, 2, 3, 10, 20, 59, 60, 90].map(bugCount)).toEqual([4, 4, 8, 16, 28, 80, 84, 84]);
    expect(FULL_BOARD_LEVEL).toBe(60);
  });

  it('the bug area grows a row as it gets crowded, 12 rows at most until level 61, then 13', () => {
    expect([0, 44, 45, 51, 57, 60, 61, 100].map(bugZoneRows)).toEqual([10, 10, 11, 12, 12, 12, 13, 13]);
  });

  it('every bug fits on a crowded level-60 board (84 bugs in 12 rows) without opening matches', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = createGame({ ...cfg, seed, level: 60, colors: 2 + (seed % 4) });
      expect(s.bugsLeft).toBe(84);
      expect(s.board.slice(0, (H - 12) * W).every(c => c === null || c.t !== 'bug')).toBe(true);
      expect(findMatches(s.board).length).toBe(0);
    }
  });

  it('plays on past the full board: same bug count, pieces fall a little faster', () => {
    const lFull = createGame({ ...cfg, speed: 0, level: 61 }), l90 = createGame({ ...cfg, speed: 0, level: 90 });
    expect(l90.config.level).toBe(90);
    expect(l90.bugsLeft).toBe(lFull.bugsLeft);
    expect(gravityInterval(l90)).toBeLessThan(gravityInterval(lFull));
    expect(createGame({ ...cfg, level: 50000 }).config.level).toBe(MAX_LEVEL);
  });

  it('level 100 is the final level; Endless levels past it keep speeding up to the limit', () => {
    expect(isEndless(FINAL_LEVEL)).toBe(false);
    expect(isEndless(FINAL_LEVEL + 1)).toBe(true);
    const last = createGame({ ...cfg, speed: 0, level: FINAL_LEVEL });
    const endless = createGame({ ...cfg, speed: 0, level: FINAL_LEVEL + 40 });
    expect(endless.config.level).toBe(FINAL_LEVEL + 40);
    expect(endless.bugsLeft).toBe(last.bugsLeft);
    expect(gravityInterval(endless)).toBeLessThan(gravityInterval(last));
    expect(gravityInterval(createGame({ ...cfg, level: 5000 }))).toBe(6);
  });

  it('a piece can be turned upright the moment it appears, poking above the top line', () => {
    for (const action of ['rotCW', 'rotCCW'] as const) {
      const g = createGame(cfg);
      expect(g.piece!.y).toBe(0);
      step(g, [action]);
      expect(g.piece!.rot % 2).toBe(1);
      expect(g.piece!.y).toBe(0); // stays on the top row; its upper half pokes above the line
      expect(pieceCells(g.piece!).map(h => h.y).sort()).toEqual([-1, 0]);
      step(g, [action]); // and back to flat
      expect(g.piece!.rot % 2).toBe(0);
    }
  });

  it('landing while poking above the top line ends the game', () => {
    const g = createGame(cfg);
    const x = g.piece!.x;
    g.board[idx(x, 1)] = { t: 'bug', c: 0 }; // something right under the spawn spot
    step(g, ['rotCW']);
    expect(g.piece!.y).toBe(0);
    for (let i = 0; i < 200 && g.phase === 'falling'; i++) step(g, []);
    expect(g.phase).toBe('lost');
  });

  /** An Endless game one move from clearing its last two bugs, with some loose halves lying around. */
  function lastBugsEndless(seed = 1) {
    const g = createGame({ ...cfg, seed, level: FINAL_LEVEL + 1 });
    g.board = emptyBoard();
    g.board[idx(5, 15)] = { t: 'bug', c: 1 };
    g.board[idx(5, 14)] = { t: 'bug', c: 1 };
    g.board[idx(0, 15)] = { t: 'half', c: 0, l: 'R' };
    g.board[idx(1, 15)] = { t: 'half', c: 2, l: 'L' };
    g.bugsLeft = 2;
    g.piece = { x: 5, y: 2, rot: 1, a: 1, b: 1 };
    return g;
  }

  it('Endless is continuous: clearing a round brings the next bugs in around the pieces, never matching', () => {
    const g = lastBugsEndless();
    const events: GameEvent[] = [];
    step(g, ['softOn']);
    for (let i = 0; i < 2000 && !events.some(e => e.type === 'arrive'); i++) events.push(...step(g));
    const arrive = events.find(e => e.type === 'arrive') as Extract<GameEvent, { type: 'arrive' }>;
    expect(arrive).toBeTruthy();
    expect(events.some(e => e.type === 'won')).toBe(false);
    expect(g.round).toBe(1);
    expect(currentLevel(g)).toBe(FINAL_LEVEL + 2);
    expect(arrive.cells.length).toBe(bugCount(FINAL_LEVEL + 2));
    expect(g.bugsLeft).toBe(arrive.cells.length);
    expect(findMatches(g.board)).toEqual([]);
    expect(g.board[idx(0, 15)]).toEqual({ t: 'half', c: 0, l: 'R' }); // pieces already there stay put
    expect(g.phase).toBe('waiting');
    expect(g.phaseTimer).toBeGreaterThanOrEqual(ARRIVE_TICKS - 1);
    for (let i = 0; i < ARRIVE_TICKS + 5 && g.phase !== 'falling'; i++) step(g);
    expect(g.phase).toBe('falling'); // and play goes straight on
  });

  it('Endless rounds replay exactly from the log', () => {
    const g = lastBugsEndless(9);
    const start = serialize(g);
    for (let t = 0; t < 600; t++) step(g, t === 0 ? ['softOn'] : t > 300 && t % 13 === 0 ? ['left'] : []);
    expect(g.round).toBe(1);
    const again = deserialize(start);
    const byTick = new Map<number, Action[]>();
    for (const code of g.log) { const tk = Math.floor(code / 8); byTick.set(tk, [...(byTick.get(tk) ?? []), (['left','right','rotCW','rotCCW','softOn','softOff'] as Action[])[code % 8]!]); }
    while (again.tick < g.tick) step(again, byTick.get(again.tick) ?? []);
    expect(serialize(again)).toBe(serialize(g));
  });

  it('arriving bugs take over same-color halves only as a last resort, and never make a match', () => {
    for (let seed = 1; seed <= 100; seed++) {
      // A crowded board: bug area full of loose halves except a few holes.
      const board = emptyBoard();
      const holder = { rng: seed * 7919 };
      for (let y = 3; y < H; y++) for (let x = 0; x < W; x++) {
        if ((x + y * 3 + seed) % 9 === 0) continue;
        board[idx(x, y)] = { t: 'half', c: (x + 2 * y) % 3, l: null };
      }
      board[idx(0, 15)] = { t: 'half', c: 0, l: 'R' };
      board[idx(1, 15)] = { t: 'half', c: 0, l: 'L' };
      expect(findMatches(board)).toEqual([]);
      const holes = board.slice(3 * W).filter(c => c === null).length;
      const { cells, replaced } = addBugs(board, holder, 84, 3, 13);
      expect(cells.length).toBe(84);
      expect(replaced.length).toBeGreaterThanOrEqual(84 - holes);
      expect(findMatches(board)).toEqual([]);
      for (const i of replaced) expect(board[i]!.t).toBe('bug');
      // a taken-over half leaves its partner as a lone half
      const left = board[idx(0, 15)]!, right = board[idx(1, 15)]!;
      if (left.t === 'bug' && right.t === 'half') expect(right.l).toBe(null);
      if (right.t === 'bug' && left.t === 'half') expect(left.l).toBe(null);
    }
  });

  it('the packed move record round-trips, including out-of-order and huge entries', () => {
    const logs = [[], [0], [5, 3, 3, 900000, 8, 2 ** 31 + 7], Array.from({ length: 5000 }, (_, i) => i * 37 + (i % 6))];
    for (const log of logs) expect(unpackLog(packLog(log))).toEqual(log);
  });

  it('saves are packed and compressed, and old (version 1) saves still load', () => {
    const live = createGame(cfg);
    play(live, 60 * 120);
    const packed = serialize(live);
    const plain = JSON.stringify({ ...live, v: 1 }); // how version 1 wrote the same game
    expect(packed.length).toBeLessThan(plain.length);
    expect(plain.length / packed.length).toBeGreaterThan(2.5);
    expect(serialize(deserialize(packed))).toBe(packed); // same game, same text (no timestamps inside)
    expect(deserialize(plain)).toEqual(deserialize(packed));
    expect(deserialize(plain).v).toBe(2);
  });

  it('a forged log does not reproduce the score', () => {
    const live = createGame(cfg);
    play(live, 60 * 120);
    const forged = live.log.slice(0, Math.floor(live.log.length / 2));
    expect(serialize(replay(cfg, forged, live.tick))).not.toBe(serialize(live));
  });
});

describe('slo-mo', () => {
  it('is slower than low, and only with 4 or 5 colors', () => {
    const slo = createGame({ ...cfg, speed: SLO_MO, colors: 4 });
    const low = createGame({ ...cfg, speed: 0, colors: 4 });
    expect(slo.config.speed).toBe(SLO_MO);
    expect(gravityInterval(slo)).toBeGreaterThan(gravityInterval(low));
    expect(createGame({ ...cfg, speed: SLO_MO, colors: 5 }).config.speed).toBe(SLO_MO);
    // With 2 or 3 colors a slo-mo request falls back to low.
    expect(createGame({ ...cfg, speed: SLO_MO, colors: 3 }).config.speed).toBe(0);
  });
});
