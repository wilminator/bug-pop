// The game loop as a pure state machine.
//
// step() advances the game by exactly one tick (1/60 s) given the actions the
// player made during that tick. It never reads the clock, the screen or
// Math.random, so the same config + the same actions always give the same game.

import { emptyBoard, findMatches, fits, idx, pieceCells, placeBugs, removeCells, settleStep } from './board';
import { randInt } from './rng';
import { ACTIONS, SAVE_VERSION, type Action, type GameConfig, type GameEvent, type GameState, type Piece } from './types';

export const TICKS_PER_SECOND = 60;
export const CLEAR_TICKS = 20; // how long matched cells flash before vanishing
export const SETTLE_TICKS = 8; // ticks per row while loose halves fall
/** Ticks per row while "down" is held, at low / medium / high speed: slow is 3x slower than fast. */
export const SOFT_DROP_TICKS = [6, 4, 2] as const;
// Beats before the next piece appears. Both are whole soft-drop steps at every speed
// (multiples of 6, 4 and 2), so they line up with the rhythm of a held "down".
export const LAND_TICKS = 24; // after a piece lands: 0.4 s, just past the 1/3 s landing sound
export const AFTER_CLEAR_TICKS = 72; // after a clear: 1.2 s
const SPAWN_X = 3;
const BASE_INTERVAL = [45, 25, 15] as const; // ticks per row at low / medium / high (slow = 3x fast)
const MIN_INTERVAL = 6;
const SPEED_MULTIPLIER = [1, 2, 3] as const;
export const MAX_LEVEL = 99;
/** The board is full of bugs by level 20; after that, every 4 levels pieces fall a little faster. */
const OVERTIME_FROM = 20, OVERTIME_EVERY = 4;

export function normalizeConfig(c: GameConfig): GameConfig {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(v)));
  return {
    seed: c.seed >>> 0,
    level: clamp(c.level, 0, MAX_LEVEL),
    speed: clamp(c.speed, 0, 2) as GameConfig['speed'],
    colors: clamp(c.colors, 2, 5),
    ...(c.startScore ? { startScore: Math.max(0, Math.floor(c.startScore)) } : {}),
  };
}

export function createGame(config: GameConfig): GameState {
  const cfg = normalizeConfig(config);
  const s: GameState = {
    v: SAVE_VERSION,
    config: cfg,
    rng: cfg.seed,
    tick: 0,
    board: emptyBoard(),
    phase: 'falling',
    piece: null,
    next: { a: 0, b: 0 },
    soft: false,
    dropTimer: 0,
    phaseTimer: 0,
    clearing: [],
    piecesSpawned: 0,
    bugsLeft: 0,
    score: cfg.startScore ?? 0,
    dropBugs: 0,
    chain: 0,
    log: [],
  };
  s.bugsLeft = placeBugs(s.board, s, cfg.level, cfg.colors);
  s.next = randomPair(s);
  spawn(s, []);
  return s;
}

function randomPair(s: GameState) {
  return { a: randInt(s, s.config.colors), b: randInt(s, s.config.colors) };
}

/** Ticks per row for the current piece; the game speeds up every 10 pieces. */
export function gravityInterval(s: GameState): number {
  const overtime = Math.floor(Math.max(0, s.config.level - OVERTIME_FROM) / OVERTIME_EVERY);
  return Math.max(MIN_INTERVAL, BASE_INTERVAL[s.config.speed] - overtime - Math.floor(s.piecesSpawned / 10));
}

/** Holding down is never slower than just letting the piece fall. */
export function softDropInterval(s: GameState): number {
  return Math.min(SOFT_DROP_TICKS[s.config.speed], gravityInterval(s));
}

function spawn(s: GameState, events: GameEvent[]) {
  const piece: Piece = { x: SPAWN_X, y: 0, rot: 0, a: s.next.a, b: s.next.b };
  s.next = randomPair(s);
  s.piecesSpawned++;
  s.dropTimer = 0;
  s.dropBugs = 0;
  s.chain = 0;
  if (!fits(s.board, piece)) {
    s.piece = null;
    s.phase = 'lost';
    events.push({ type: 'lost' });
    return;
  }
  s.piece = piece;
  s.phase = 'falling';
  events.push({ type: 'spawn' });
}

function tryMove(s: GameState, dx: number): boolean {
  const p = s.piece!;
  const moved = { ...p, x: p.x + dx };
  if (!fits(s.board, moved)) return false;
  s.piece = moved;
  return true;
}

function tryRotate(s: GameState, dir: 1 | -1): boolean {
  const p = s.piece!;
  const rot = ((p.rot + (dir === 1 ? 1 : 3)) % 4) as Piece['rot'];
  const turned = { ...p, rot };
  if (fits(s.board, turned)) { s.piece = turned; return true; }
  // Turning flat against a wall or a block: nudge one cell left ("wall kick").
  if (rot % 2 === 0) {
    const kicked = { ...turned, x: p.x - 1 };
    if (fits(s.board, kicked)) { s.piece = kicked; return true; }
  }
  return false;
}

function lock(s: GameState, events: GameEvent[]) {
  for (const h of pieceCells(s.piece!)) s.board[idx(h.x, h.y)] = { t: 'half', c: h.c, l: h.l };
  s.piece = null;
  events.push({ type: 'lock' });
  resolve(s, events);
}

/** After anything lands or falls: start a clear, or hand over to the next piece. */
function resolve(s: GameState, events: GameEvent[]) {
  const cells = findMatches(s.board);
  if (cells.length === 0) {
    s.phase = 'waiting';
    s.phaseTimer = s.chain > 0 ? AFTER_CLEAR_TICKS : LAND_TICKS;
    return;
  }
  s.chain++;
  s.clearing = cells;
  s.phase = 'clearing';
  s.phaseTimer = CLEAR_TICKS;
  const bugs = cells.filter(i => s.board[i]?.t === 'bug').length;
  events.push({ type: 'match', cells, bugs, chain: s.chain });
}

/** Score doubles for each extra bug cleared by the same piece, capped at x32. */
function scoreBugs(s: GameState, bugs: number) {
  for (let i = 0; i < bugs; i++) {
    s.score += 100 * 2 ** Math.min(s.dropBugs, 5) * SPEED_MULTIPLIER[s.config.speed];
    s.dropBugs++;
  }
}

function applyAction(s: GameState, a: Action, events: GameEvent[]) {
  if (a === 'softOn') { s.soft = true; return; }
  if (a === 'softOff') { s.soft = false; return; }
  if (s.phase !== 'falling' || !s.piece) return;
  const ok =
    a === 'left' ? tryMove(s, -1) :
    a === 'right' ? tryMove(s, 1) :
    a === 'rotCW' ? tryRotate(s, -1) :
    tryRotate(s, 1);
  if (ok) events.push({ type: a === 'left' || a === 'right' ? 'move' : 'rotate' });
}

/** Advance one tick. Mutates `s` and returns what happened, for sound and visuals. */
export function step(s: GameState, actions: readonly Action[] = []): GameEvent[] {
  const events: GameEvent[] = [];
  if (s.phase === 'won' || s.phase === 'lost') return events;

  for (const a of actions) {
    s.log.push(s.tick * 8 + ACTIONS.indexOf(a));
    applyAction(s, a, events);
  }

  switch (s.phase) {
    case 'falling': {
      s.dropTimer++;
      if (s.dropTimer >= (s.soft ? softDropInterval(s) : gravityInterval(s))) {
        s.dropTimer = 0;
        const p = s.piece!;
        const lower = { ...p, y: p.y + 1 };
        if (fits(s.board, lower)) s.piece = lower;
        else lock(s, events);
      }
      break;
    }
    case 'clearing': {
      if (--s.phaseTimer > 0) break;
      const bugs = removeCells(s.board, s.clearing);
      s.clearing = [];
      s.bugsLeft -= bugs;
      scoreBugs(s, bugs);
      events.push({ type: 'cleared', bugs });
      if (s.bugsLeft <= 0) {
        s.phase = 'won';
        events.push({ type: 'won' });
        break;
      }
      s.phase = 'settling';
      s.phaseTimer = SETTLE_TICKS;
      break;
    }
    case 'settling': {
      if (--s.phaseTimer > 0) break;
      if (settleStep(s.board)) { s.phaseTimer = SETTLE_TICKS; events.push({ type: 'fall' }); }
      else resolve(s, events);
      break;
    }
    case 'waiting': {
      if (--s.phaseTimer <= 0) spawn(s, events);
      break;
    }
  }
  s.tick++;
  return events;
}

/** Decode the input log into per-tick action lists. */
export function decodeLog(log: readonly number[]): Map<number, Action[]> {
  const byTick = new Map<number, Action[]>();
  for (const code of log) {
    const tick = Math.floor(code / 8);
    const action = ACTIONS[code % 8];
    if (!action) throw new Error(`bad log entry ${code}`);
    const list = byTick.get(tick) ?? [];
    list.push(action);
    byTick.set(tick, list);
  }
  return byTick;
}

/**
 * Rebuild a game from its config and input log. A server can run this to check
 * that a submitted score is real. `untilTick` stops early (default: run until
 * the last logged tick, then until the game ends or maxTicks passes).
 */
export function replay(config: GameConfig, log: readonly number[], untilTick?: number, maxTicks = 60 * 60 * 60 * 3): GameState {
  const s = createGame(config);
  const byTick = decodeLog(log);
  const end = untilTick ?? maxTicks;
  while (s.tick < end && s.phase !== 'won' && s.phase !== 'lost') step(s, byTick.get(s.tick) ?? []);
  return s;
}

export function serialize(s: GameState): string {
  return JSON.stringify(s);
}

export function deserialize(json: string): GameState {
  const s = JSON.parse(json) as GameState;
  if (!s || s.v !== SAVE_VERSION || !Array.isArray(s.board)) throw new Error('unsupported save');
  return s;
}
