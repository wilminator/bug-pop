// The game loop as a pure state machine.
//
// step() advances the game by exactly one tick (1/60 s) given the actions the
// player made during that tick. It never reads the clock, the screen or
// Math.random, so the same config + the same actions always give the same game.

import { addBugs, bugCount, bugZoneRows, emptyBoard, findMatches, fits, idx, pieceCells, placeBugs, removeCells, settleStep } from './board';
import { randInt } from './rng';
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { ACTIONS, SAVE_VERSION, type Action, type GameConfig, type GameEvent, type GameState, type Piece } from './types';

export const TICKS_PER_SECOND = 60;
export const CLEAR_TICKS = 20; // how long matched cells flash before vanishing
export const SETTLE_TICKS = 8; // ticks per row while loose halves fall
/**
 * Ticks per row while "down" is held: 2.5, i.e. 24 rows a second (it was 2; Jeanne found that
 * too fast). Half a tick can't happen, so the drop timer counts in half-ticks and alternates
 * 3-tick and 2-tick rows, which averages exactly 2.5.
 */
export const SOFT_DROP_TICKS = 2.5;
const HALF = 2; // drop timer units per tick
// Beats before the next piece appears. Both are whole soft-drop steps (10 and 30 of them),
// so they line up with the rhythm of a held "down".
export const LAND_TICKS = 25; // after a piece lands: about 0.42 s, just past the 1/3 s landing sound
export const AFTER_CLEAR_TICKS = 75; // after a clear: 1.25 s
/** Endless: the beat while a new round's bugs crawl in, before the next piece (also whole soft-drop steps). */
export const ARRIVE_TICKS = 75;
const SPAWN_X = 3;
const BASE_INTERVAL = [40, 25, 15] as const; // ticks per row at low / medium / high
const MIN_INTERVAL = 6;
const SPEED_MULTIPLIER = [1, 2, 3] as const;
/** Clearing this level beats the game. */
export const FINAL_LEVEL = 100;
/** Levels past FINAL_LEVEL are Endless mode: the board stays full and pieces keep speeding up to the limit. */
export const MAX_LEVEL = 9999;
export const isEndless = (level: number) => level > FINAL_LEVEL;
/** The level being played right now: the starting level plus any Endless rounds cleared. */
export const currentLevel = (s: GameState) => s.config.level + (s.round ?? 0);
/** After level 20, every 4 levels pieces fall a little faster. (The bug count keeps growing until FULL_BOARD_LEVEL.) */
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
  const overtime = Math.floor(Math.max(0, currentLevel(s) - OVERTIME_FROM) / OVERTIME_EVERY);
  return Math.max(MIN_INTERVAL, BASE_INTERVAL[s.config.speed] - overtime - Math.floor(s.piecesSpawned / 10));
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
  const cells = pieceCells(s.piece!);
  // Landing while still poking above the top line means the stack has reached the top.
  if (cells.some(h => h.y < 0)) {
    s.phase = 'lost';
    events.push({ type: 'lost' });
    return;
  }
  for (const h of cells) s.board[idx(h.x, h.y)] = { t: 'half', c: h.c, l: h.l };
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
    if (s.bugsLeft <= 0) nextRound(s, events); // Endless: everything has settled, bring in more bugs
    return;
  }
  s.chain++;
  s.clearing = cells;
  s.phase = 'clearing';
  s.phaseTimer = CLEAR_TICKS;
  const bugs = cells.filter(i => s.board[i]?.t === 'bug').length;
  events.push({ type: 'match', cells, bugs, chain: s.chain });
}

/**
 * Endless is continuous: when a round's bugs are all gone, the next round's bugs
 * arrive around whatever is on the board, and play goes on with no break.
 */
function nextRound(s: GameState, events: GameEvent[]) {
  s.round = (s.round ?? 0) + 1;
  const lvl = currentLevel(s);
  const { cells, replaced } = addBugs(s.board, s, bugCount(lvl), s.config.colors, bugZoneRows(lvl));
  s.bugsLeft = cells.length;
  s.phaseTimer = Math.max(s.phaseTimer, ARRIVE_TICKS);
  events.push({ type: 'arrive', cells, replaced, round: s.round });
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
      s.dropTimer += HALF;
      const limit = (s.soft ? SOFT_DROP_TICKS : gravityInterval(s)) * HALF;
      if (s.dropTimer >= limit) {
        s.dropTimer -= limit; // keep the leftover half-tick so 3,2,3,2... averages 2.5
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
      // In Endless the board carries on: the next round starts once things settle (see resolve).
      if (s.bugsLeft <= 0 && !isEndless(currentLevel(s))) {
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

// Both exist in every browser and in Node 16+; the engine's TypeScript setup leaves out the DOM types.
declare function btoa(data: string): string;
declare function atob(data: string): string;

/**
 * Pack a move record into bytes. Each entry is stored as the difference from the
 * one before (usually a small number), zigzag-encoded so a rare negative difference
 * still works, as a variable-length run of bytes (7 bits each): about 2 bytes an
 * entry instead of about 7 characters of JSON.
 */
export function packLog(log: readonly number[]): Uint8Array {
  const bytes: number[] = [];
  let prev = 0;
  for (const code of log) {
    const d = code - prev;
    prev = code;
    let z = d >= 0 ? d * 2 : -d * 2 - 1; // zigzag: 0, -1, 1, -2, 2 ... -> 0, 1, 2, 3, 4 ...
    while (z >= 0x80) { bytes.push((z % 0x80) | 0x80); z = Math.floor(z / 0x80); }
    bytes.push(z);
  }
  return Uint8Array.from(bytes);
}

export function unpackLog(bytes: Uint8Array): number[] {
  const log: number[] = [];
  let prev = 0, z = 0, scale = 1;
  for (const b of bytes) {
    z += (b & 0x7f) * scale;
    if (b & 0x80) { scale *= 0x80; continue; }
    prev += z % 2 === 0 ? z / 2 : -(z + 1) / 2;
    log.push(prev);
    z = 0;
    scale = 1;
  }
  return log;
}

const toBase64 = (u: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));

/** Saves in format 2 start with this; format 1 saves are plain JSON and start with "{". */
const PACKED_PREFIX = 'z2:';

/**
 * The saved form of a game, as text (it goes in localStorage and in the cloud save).
 * Format 2: the game as JSON without its move record, a zero byte, the packed move
 * record, all deflate-compressed and base64-encoded. Deflate (no gzip header, so no
 * timestamp) keeps it deterministic: the same game always gives the same text.
 */
export function serialize(s: GameState): string {
  const { log, ...rest } = s;
  const head = strToU8(JSON.stringify({ ...rest, v: SAVE_VERSION }));
  const body = packLog(log);
  const all = new Uint8Array(head.length + 1 + body.length);
  all.set(head, 0);
  all.set(body, head.length + 1); // the byte between stays 0; JSON text never contains one
  return PACKED_PREFIX + toBase64(deflateSync(all, { level: 9 }));
}

export function deserialize(text: string): GameState {
  let s: GameState | null;
  if (text.startsWith(PACKED_PREFIX)) {
    const all = inflateSync(fromBase64(text.slice(PACKED_PREFIX.length)));
    const zero = all.indexOf(0);
    if (zero < 0) throw new Error('unsupported save');
    s = { ...(JSON.parse(strFromU8(all.subarray(0, zero))) as Omit<GameState, 'log'>), log: unpackLog(all.subarray(zero + 1)) };
  } else {
    s = JSON.parse(text) as GameState | null; // format 1: plain JSON, the record as a number array
    if (!s || s.v !== 1 || !Array.isArray(s.log)) throw new Error('unsupported save');
  }
  if (!s || !Array.isArray(s.board)) throw new Error('unsupported save');
  return { ...s, v: SAVE_VERSION };
}
