import { describe, expect, it } from 'vitest';
import {
  BOARD_HEIGHT as H, BOARD_WIDTH as W, bugCount, createGame, deserialize, emptyBoard, findMatches, idx,
  removeCells, replay, serialize, settleStep, step, type Action, type Cell, type GameState,
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

  it('ends in a loss when the spawn point is blocked', () => {
    const s = createGame(cfg);
    // Block the cells under the spawn point: the piece locks at the top,
    // and the next piece has nowhere to appear.
    s.board[idx(3, 1)] = { t: 'half', c: 0, l: null };
    s.board[idx(4, 1)] = { t: 'half', c: 1, l: null };
    const events = [];
    for (let i = 0; i < 200 && s.phase === 'falling'; i++) events.push(...step(s));
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

  it('a forged log does not reproduce the score', () => {
    const live = createGame(cfg);
    play(live, 60 * 120);
    const forged = live.log.slice(0, Math.floor(live.log.length / 2));
    expect(serialize(replay(cfg, forged, live.tick))).not.toBe(serialize(live));
  });
});
