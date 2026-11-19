import { describe, expect, it } from 'vitest';
import {
  BOARD_HEIGHT as H, BOARD_WIDTH as W, AFTER_CLEAR_TICKS, LAND_TICKS, fallSpeed, HELD_EXTRA_ROWS_PER_SECOND, bugCount, bugZoneRows, packLog, unpackLog, addBugs, currentLevel, ARRIVE_TICKS, FULL_BOARD_LEVEL, createGame, FINAL_LEVEL, MAX_LEVEL, isEndless, gravityInterval, softDropInterval, deserialize, emptyBoard, findMatches, idx,
  removeCells, pieceCells, fits, type Piece, cleanSweepBonus, scoreMultiplier, replay, SLO_MO, serialize, settleStep, step, type Action, type GameEvent, type Cell, type GameState,
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

  it('fall speeds are even in rows per second: speeds spread evenly, levels climb evenly to 100', () => {
    const r = (speed: number, level: number) => Math.round(fallSpeed(speed as 0, level) * 1000) / 1000;
    expect([3, 0, 1, 2].map(sp => r(sp, 1))).toEqual([1, 1.667, 2.333, 3]); // slo-mo, low, medium, fast
    expect([3, 0, 1, 2].map(sp => r(sp, 100))).toEqual([2.5, 3.667, 4.833, 6]);
    expect(r(2, 5000)).toBe(6); // Endless holds level 100's speed
    expect(r(2, 0)).toBe(3);
    // Even climb: the same gain from 1->34 as from 34->67
    expect(r(2, 34) - r(2, 1)).toBeCloseTo(r(2, 67) - r(2, 34), 6);
    const g = createGame({ ...cfg, speed: 2, level: 1 });
    g.piecesSpawned = 500;
    expect(gravityInterval(g)).toBe(20); // 3 rows/s, no speed-up as pieces are placed
  });

  it('holding down falls at 6 rows a second, or normal + 0.5 when that is faster', () => {
    const held = (sp: number, lv: number) => 60 / softDropInterval(createGame({ ...cfg, colors: 4, speed: sp as 0, level: lv }));
    expect(held(0, 1)).toBeCloseTo(6, 9); // low, level 1: 1.67 normal -> 6
    expect(held(2, 100)).toBeCloseTo(6.5, 9); // fast, level 100: 6 normal -> 6.5
    expect(held(2, 5000)).toBeCloseTo(6.5, 9);
    for (const sp of [0, 1, 2, 3]) for (const lv of [1, 50, 100, 300]) {
      const s = createGame({ ...cfg, colors: 4, speed: sp as 0, level: lv });
      expect(60 / softDropInterval(s) - 60 / gravityInterval(s)).toBeGreaterThanOrEqual(HELD_EXTRA_ROWS_PER_SECOND - 1e-9);
    }
  });

  it('pressing down mid-row never drops a burst of rows', () => {
    const s = createGame({ ...cfg, speed: 0, level: 1 }); // low: 36 ticks a row; held: 10
    s.board = emptyBoard(); s.bugsLeft = 1; s.board[idx(7, 15)] = { t: 'bug', c: 2 };
    s.piece = { x: 0, y: 0, rot: 0, a: 0, b: 1 }; s.dropTimer = 0;
    for (let i = 0; i < 30; i++) step(s); // most of the way through a slow row
    expect(s.piece!.y).toBe(0);
    step(s, ['softOn']);
    const moves: number[] = []; let y = s.piece!.y;
    for (let t = 1; t <= 40; t++) { step(s); if (s.piece!.y !== y) { moves.push(t); y = s.piece!.y; } }
    expect(moves[0]).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < moves.length; i++) expect(moves[i]! - moves[i - 1]!).toBeGreaterThanOrEqual(9); // no two rows close together
  });

  it('a held-down piece really moves at that rate', () => {
    const s = createGame({ ...cfg, speed: 0, level: 1 });
    s.board = emptyBoard(); s.bugsLeft = 1; s.board[idx(7, 15)] = { t: 'bug', c: 2 };
    s.piece = { x: 0, y: 0, rot: 0, a: 0, b: 1 };
    step(s, ['softOn']);
    const y0 = s.piece!.y; let ticks = 1;
    while (s.piece && s.piece.y < y0 + 5) { step(s); ticks++; }
    expect(Math.abs(ticks - 5 * softDropInterval(s))).toBeLessThanOrEqual(1);
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
    expect(events.map(e => e.type)).not.toContain('cleanSweep'); // the piece's other half is left behind
  });

  /** Level 0: one bug with one matching half on it, and a same-color piece about to land on top. */
  function sweepable(extra: Partial<typeof cfg & { cleanSweep: boolean }> = {}) {
    const s = createGame({ ...cfg, level: 0, ...extra });
    s.board = emptyBoard();
    s.board[idx(0, 15)] = { t: 'bug', c: 1 };
    s.board[idx(0, 14)] = { t: 'half', c: 1, l: null };
    s.bugsLeft = 1;
    s.piece = { x: 0, y: 12, rot: 1, a: 1, b: 1 };
    return s;
  }

  it('a clean sweep (nothing left on the board) adds a bonus before the win', () => {
    const s = sweepable();
    const events: GameEvent[] = [];
    for (let i = 0; i < 400 && s.phase !== 'won'; i++) events.push(...step(s));
    const types = events.map(e => e.type);
    expect(types.indexOf('cleanSweep')).toBeGreaterThan(-1);
    expect(types.indexOf('cleanSweep')).toBeLessThan(types.indexOf('won'));
    const sweep = events.find(e => e.type === 'cleanSweep') as Extract<GameEvent, { type: 'cleanSweep' }>;
    expect(sweep.bonus).toBe(cleanSweepBonus(1, 0));
    expect(s.score).toBe(100 * 2 + sweep.bonus); // one bug at medium, plus the bonus
  });

  it('the bonus grows with level and speed, and Endless counts as level 100', () => {
    expect(cleanSweepBonus(0, 0)).toBe(1000);
    expect(cleanSweepBonus(1, 20)).toBe(6000);
    expect(cleanSweepBonus(2, FINAL_LEVEL)).toBe(33000);
    expect(cleanSweepBonus(SLO_MO, 0)).toBe(500);
    expect(cleanSweepBonus(0, FINAL_LEVEL + 50)).toBe(cleanSweepBonus(0, FINAL_LEVEL));
  });

  /** Two bugs stacked under one half, and a piece that completes the column (two bugs in one clear). */
  function twoBugs(extra: { classicScoring?: boolean } = {}) {
    const s = createGame({ ...cfg, level: 0, cleanSweep: false, ...extra });
    s.board = emptyBoard();
    s.board[idx(0, 15)] = { t: 'bug', c: 1 };
    s.board[idx(0, 14)] = { t: 'bug', c: 1 };
    s.board[idx(3, 15)] = { t: 'bug', c: 0 }; // one more bug, so the level isn't won
    s.bugsLeft = 3;
    s.piece = { x: 0, y: 11, rot: 1, a: 1, b: 1 };
    return s;
  }

  it('both bonuses: the chain bonus doubles per bug of one piece, the running multiplier adds 0.2 per bug and loses 0.1 per piece', () => {
    const s = twoBugs();
    expect(scoreMultiplier(s)).toBe(1);
    const clears: Extract<GameEvent, { type: 'cleared' }>[] = [];
    for (let i = 0; i < 400 && s.piecesSpawned < 2; i++) for (const e of step(s)) if (e.type === 'cleared') clears.push(e);
    // Medium (x2): 1st bug 100 x1 chain x1.0 x2 = 200; 2nd 100 x2 chain x1.2 x2 = 480.
    // Then x1.4, and the new piece makes it x1.3.
    expect(s.score).toBe(680);
    expect(clears.map(e => e.chainBonus)).toEqual([2]); // two bugs in one clear: the 2nd scored at x2
    expect(scoreMultiplier(s)).toBeCloseTo(1.3);
    for (let n = 0; n < 5; n++) { // let five more pieces fall without popping anything
      const before = s.piecesSpawned;
      s.board.fill(null); s.board[idx(3, 15)] = { t: 'bug', c: 0 };
      for (let i = 0; i < 4000 && s.piecesSpawned === before; i++) step(s);
    }
    expect(scoreMultiplier(s)).toBe(1); // 1.3 - 0.5, but never below x1.0
  });

  it('classicScoring: only the chain bonus, no running multiplier', () => {
    const s = twoBugs({ classicScoring: true });
    for (let i = 0; i < 400 && s.piecesSpawned < 2; i++) step(s);
    expect(s.score).toBe(100 * 2 + 200 * 2); // x1 then x2, at medium
    expect(scoreMultiplier(s)).toBe(1);
  });

  it('cleanSweep: false (classic rules) turns the bonus off', () => {
    const s = sweepable({ cleanSweep: false });
    const events: GameEvent[] = [];
    for (let i = 0; i < 400 && s.phase !== 'won'; i++) events.push(...step(s));
    expect(s.phase).toBe('won');
    expect(events.some(e => e.type === 'cleanSweep')).toBe(false);
    expect(s.score).toBe(200);
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

  it('level 100 is the final level; Endless levels past it keep level 100\'s speed', () => {
    expect(isEndless(FINAL_LEVEL)).toBe(false);
    expect(isEndless(FINAL_LEVEL + 1)).toBe(true);
    const last = createGame({ ...cfg, speed: 0, level: FINAL_LEVEL });
    const endless = createGame({ ...cfg, speed: 0, level: FINAL_LEVEL + 40 });
    expect(endless.config.level).toBe(FINAL_LEVEL + 40);
    expect(endless.bugsLeft).toBe(last.bugsLeft);
    expect(gravityInterval(endless)).toBe(gravityInterval(last));
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

  it('Endless: a round cleared with no halves left scores the sweep bonus, just before the next bugs arrive', () => {
    const g = lastBugsEndless();
    g.board[idx(0, 15)] = null;
    g.board[idx(1, 15)] = null;
    const events: GameEvent[] = [];
    step(g, ['softOn']);
    for (let i = 0; i < 2000 && !events.some(e => e.type === 'arrive'); i++) events.push(...step(g));
    const types = events.map(e => e.type);
    expect(types.indexOf('cleanSweep')).toBe(types.indexOf('arrive') - 1);
    expect(types.filter(t => t === 'cleanSweep').length).toBe(1);
  });

  it('Endless: halves left lying around mean no sweep bonus', () => {
    const g = lastBugsEndless();
    const events: GameEvent[] = [];
    step(g, ['softOn']);
    for (let i = 0; i < 2000 && !events.some(e => e.type === 'arrive'); i++) events.push(...step(g));
    expect(events.some(e => e.type === 'cleanSweep')).toBe(false);
  });

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

// Jeanne's report (2026-11-19): two bugs of different colors, one column apart, with three
// empty rows between them. Three pieces fill both columns; only the bottom bug popped.
describe('more than one line at once', () => {
  const RED = 0, BLUE = 1;
  /** A board with the given bugs plus a far-away green one, so clearing them doesn't win. */
  function boardWith(bugs: [number, number, number][]): GameState {
    const s = createGame({ ...cfg, level: 0 });
    s.board = emptyBoard();
    for (const [x, y, c] of bugs) s.board[idx(x, y)] = { t: 'bug', c };
    s.board[idx(7, 15)] = { t: 'bug', c: 2 };
    s.bugsLeft = bugs.length + 1;
    return s;
  }
  /** Lock a piece where it is, then run until the next piece is falling. Returns the match events. */
  function land(s: GameState, piece: Piece) {
    expect(fits(s.board, piece)).toBe(true);
    expect(fits(s.board, { ...piece, y: piece.y + 1 })).toBe(false); // it's resting on something
    s.piece = piece; s.phase = 'falling'; s.dropTimer = 1e12; // lock on the next tick
    const matches: Extract<GameEvent, { type: 'match' }>[] = [];
    for (let i = 0; i < 2000; i++) {
      for (const e of step(s)) if (e.type === 'match') matches.push(e);
      if (s.phase === 'falling' && i > 0) break;
    }
    return matches;
  }
  // Red bug at the bottom of column 2, blue bug in column 3 with rows 12, 13 and 14 empty between.
  const jeanne = () => boardWith([[2, 15, RED], [3, 11, BLUE]]);
  const redPair = { x: 2, y: 14, rot: 1, a: RED, b: RED } as const; // red on rows 14 and 13
  const bluePair = { x: 3, y: 10, rot: 1, a: BLUE, b: BLUE } as const; // blue on rows 10 and 9, above the blue bug
  const bridge = { x: 2, y: 12, rot: 0, a: RED, b: BLUE } as const; // red on (2,12), blue on (3,12) just under the blue bug

  it('pops both bugs when the last piece finishes both columns', () => {
    const s = jeanne();
    expect(land(s, redPair)).toEqual([]);
    expect(land(s, bluePair)).toEqual([]);
    const matches = land(s, bridge); // red finishes column 2, blue finishes column 3
    expect(matches).toHaveLength(1); // one clear takes both lines together
    expect(matches[0]!.bugs).toBe(2);
    expect(s.board[idx(2, 15)]).toBeNull();
    expect(s.board[idx(3, 11)]).toBeNull();
    expect(s.bugsLeft).toBe(1);
  });

  it('a half whose partner pops falls away, so a line it was holding up is no longer whole', () => {
    // The order that leaves the top bug: the bridge goes second. Its red half finishes column 2
    // at once; the blue half under the blue bug loses its partner and drops to the floor.
    const s = jeanne();
    land(s, redPair);
    const first = land(s, bridge);
    expect(first).toHaveLength(1);
    expect(first[0]!.bugs).toBe(1);
    expect(s.board[idx(3, 12)]).toBeNull(); // the blue half fell...
    expect(s.board[idx(3, 15)]).toEqual({ t: 'half', c: BLUE, l: null }); // ...all the way down
    expect(land(s, bluePair)).toEqual([]); // so column 3 has only three blues in a row
    expect(s.board[idx(3, 11)]).toEqual({ t: 'bug', c: BLUE });
  });

  it('pops a row and a column that one piece finishes together', () => {
    // Red bugs: three along row 12 (x 0-2) and three down column 3 (y 13-15). One red half
    // landing on (3,12) is the corner of both: a row of four and a column of four.
    const s = boardWith([[0, 12, RED], [1, 12, RED], [2, 12, RED], [3, 13, RED], [3, 14, RED], [3, 15, RED]]);
    const matches = land(s, { x: 3, y: 12, rot: 1, a: RED, b: BLUE }); // red at (3,12), blue on top
    expect(matches).toHaveLength(1);
    expect(matches[0]!.cells).toEqual([idx(0, 12), idx(1, 12), idx(2, 12), idx(3, 12), idx(3, 13), idx(3, 14), idx(3, 15)]);
    expect(matches[0]!.bugs).toBe(6);
    expect(s.bugsLeft).toBe(1); // only the far-away green bug is left
  });
});
