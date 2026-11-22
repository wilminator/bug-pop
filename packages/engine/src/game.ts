// The game loop as a pure state machine.
//
// step() advances the game by exactly one tick (1/60 s) given the actions the
// player made during that tick. It never reads the clock, the screen or
// Math.random, so the same config + the same actions always give the same game.

import { BOARD_HEIGHT, BOARD_WIDTH } from './types';
import { addBugs, bugCount, bugZoneRows, emptyBoard, findMatches, fits, idx, matchLines, pieceCells, placeBugs, removeCells, settleStep } from './board';
import { randInt } from './rng';
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { ACTIONS, POWER_KINDS, SOLO_POWER_KINDS, SAVE_VERSION, type Action, type Attack, type ReceivedAttack, type PowerKind, type PowerState, type GameConfig, type GameEvent, type GameState, type Piece } from './types';

export const TICKS_PER_SECOND = 60;
export const CLEAR_TICKS = 20; // how long matched cells flash before vanishing
export const SETTLE_TICKS = 8; // ticks per row while loose halves fall
/** Holding down falls at least this many rows a second... */
export const HELD_MIN_ROWS_PER_SECOND = 6;
/** ...and always at least this much faster than the normal fall (Mike, 2026-11-17). */
export const HELD_EXTRA_ROWS_PER_SECOND = 0.5;
const TIMER_UNITS = 1000; // drop timer counts in thousandths of a tick, so any speed works
// Beats before the next piece appears.
export const LAND_TICKS = 30; // after a piece lands: 0.5 s, past the 1/3 s landing sound
export const AFTER_CLEAR_TICKS = 75; // after a clear: 1.25 s
/** Endless: the beat while a new round's bugs crawl in, before the next piece. */
export const ARRIVE_TICKS = 75;
const SPAWN_X = 3;
// Fall speeds are designed in rows per second (Mike, 2026-11-17): equal steps in ticks feel
// uneven, because speed is 60 / ticks. Every speed climbs evenly from level 1 to FINAL_LEVEL,
// then holds. Mike, 2026-11-19: level 1 starts at 1.0 / 1.5 / 2.0 / 2.5, and each speed ends at
// level 100 on 1.5x the next faster speed's start (fast ends on 5).
/** Rows per second at level 1 and level 100, by speed: low, medium, high (fast), slo-mo. */
const FALL_SPEEDS = [
  { first: 1.5, last: 3.0 }, // low
  { first: 2.0, last: 3.75 }, // medium
  { first: 2.5, last: 5.0 }, // fast
  { first: 1.0, last: 2.25 }, // slo-mo
] as const;
const SPEED_MULTIPLIER = [1, 2, 3, 0.5] as const; // slo-mo bugs are worth 50, so scores stay whole numbers
/** The slowest speed, offered only with 4 or 5 colors. */
export const SLO_MO = 3;
/** Slo-mo needs at least this many colors. */
export const SLO_MO_COLORS = 4;
/** Clearing this level beats the game. */
export const FINAL_LEVEL = 100;
/** Levels past FINAL_LEVEL are Endless: the board never resets and pieces keep level 100's speed. */
export const MAX_LEVEL = 9999;
export const isEndless = (level: number) => level > FINAL_LEVEL;
/** The level being played right now: the starting level plus any Endless rounds cleared. */
export const currentLevel = (s: GameState) => s.config.level + (s.round ?? 0);
/** Is this game an Endless run? (config.endless, or an old save that started past level 100) */
export const endlessGame = (s: GameState) => !!s.config.endless || isEndless(s.config.level);
/** The Endless round being played, counted from 1. */
export const endlessRound = (s: GameState) => currentLevel(s) - (s.config.endless ? s.config.level - 1 : FINAL_LEVEL);

export function normalizeConfig(c: GameConfig): GameConfig {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(v)));
  const colors = clamp(c.colors, 2, 5);
  let speed = clamp(c.speed, 0, SLO_MO);
  if (speed === SLO_MO && colors < SLO_MO_COLORS) speed = 0; // slo-mo is only for 4 or 5 colors: fall back to low
  return {
    seed: c.seed >>> 0,
    level: clamp(c.level, 0, MAX_LEVEL),
    speed: speed as GameConfig['speed'],
    colors,
    ...(c.startScore ? { startScore: Math.max(0, Math.floor(c.startScore)) } : {}),
    ...(c.cleanSweep === false ? { cleanSweep: false } : {}),
    ...(c.classicScoring ? { classicScoring: true } : {}),
    ...(c.classicBugZone ? { classicBugZone: true } : {}),
    ...(c.endless ? { endless: true } : {}),
    ...(c.powerUps ? { powerUps: true } : {}),
    ...(c.versus ? { versus: true } : {}),
    ...(c.powerUps && c.startPower ? { startPower: {
      meter: clamp(c.startPower.meter, 0, METER_FULL),
      held: POWER_KINDS.includes(c.startPower.held as PowerKind) ? c.startPower.held : null,
    } } : {}),
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
    mult: MULT_MIN,
    chain: 0,
    log: [],
  };
  if (cfg.versus) s.versus = { lines: 0, waiting: [], received: [], fallTicks: null };
  if (cfg.powerUps) s.power = { meter: cfg.startPower?.meter ?? 0, held: cfg.startPower?.held ?? null, freeze: 0, recent: [], queued: null, blast: false };
  s.bugsLeft = placeBugs(s.board, s, cfg.level, cfg.colors, cfg.classicBugZone);
  s.next = randomPair(s);
  spawn(s, []);
  return s;
}

function randomPair(s: GameState) {
  return { a: randInt(s, s.config.colors), b: randInt(s, s.config.colors) };
}

/** Rows per second at a speed and level (no holding down). */
export function fallSpeed(speed: GameConfig['speed'], level: number): number {
  const t = Math.min(1, Math.max(0, level - 1) / (FINAL_LEVEL - 1)); // 0 at level 1, 1 at level 100+
  const { first, last } = FALL_SPEEDS[speed];
  return first + (last - first) * t;
}

/** Ticks per row for the current piece (may be fractional). It doesn't change within a level. */
export function gravityInterval(s: GameState): number {
  return TICKS_PER_SECOND / fallSpeed(s.config.speed, currentLevel(s));
}

/** Ticks per row while "down" is held: 6 rows/s, or the normal speed + 0.5 if that is faster. */
export function softDropInterval(s: GameState): number {
  const normal = fallSpeed(s.config.speed, currentLevel(s));
  return TICKS_PER_SECOND / Math.max(HELD_MIN_ROWS_PER_SECOND, normal + HELD_EXTRA_ROWS_PER_SECOND);
}

function dropLimit(s: GameState): number {
  return Math.round((s.soft ? softDropInterval(s) : gravityInterval(s)) * TIMER_UNITS);
}

/**
 * Press or release "down". The drop timer keeps the same fraction of the way through the
 * current row, so pressing down never lets the time saved up at the slow speed spill out as
 * a burst of fast rows (it used to drop two rows at once, then settle to the held speed).
 */
function setSoft(s: GameState, on: boolean) {
  if (s.soft === on) return;
  const before = dropLimit(s);
  s.soft = on;
  s.dropTimer = Math.floor(Math.min(s.dropTimer, before) * dropLimit(s) / before);
}

function spawn(s: GameState, events: GameEvent[]) {
  const queued = s.power?.queued;
  const piece: Piece = { x: SPAWN_X, y: 0, rot: 0, a: s.next.a, b: s.next.b };
  if (queued) {
    // A used power-up drops now; the piece that was next stays next (it was pushed back one turn).
    s.power!.queued = null;
    if (queued === 'wild') piece.w = true; // a wildcard piece; its colors only matter for drawing
    else piece.k = queued;
  } else s.next = randomPair(s);
  s.piecesSpawned++;
  s.dropTimer = 0;
  s.dropBugs = 0;
  s.chain = 0;
  if (s.versus) s.versus.lines = 0;
  s.mult = Math.max(MULT_MIN, (s.mult ?? MULT_MIN) - MULT_DECAY); // each new piece cools the multiplier a little
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
  if (p.k) return false; // a bomb or drill has nothing to turn
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
  if (s.piece!.k) { detonate(s, events); return; }
  const cells = pieceCells(s.piece!);
  // Landing while still poking above the top line means the stack has reached the top.
  if (cells.some(h => h.y < 0)) {
    s.phase = 'lost';
    events.push({ type: 'lost' });
    return;
  }
  for (const h of cells) s.board[idx(h.x, h.y)] = s.piece!.w ? { t: 'half', c: h.c, l: h.l, w: true } : { t: 'half', c: h.c, l: h.l };
  s.piece = null;
  events.push({ type: 'lock' });
  resolve(s, events);
}

/** After anything lands or falls: start a clear, or hand over to the next piece. */
function resolve(s: GameState, events: GameEvent[]) {
  const cells = findMatches(s.board);
  const v = s.versus;
  if (v) v.fallTicks = null; // attack halves (if any) have landed
  if (cells.length === 0) {
    s.phase = 'waiting';
    s.phaseTimer = s.chain > 0 ? AFTER_CLEAR_TICKS : LAND_TICKS;
    if (v && v.lines >= 2) events.push({ type: 'attack', attack: { n: Math.min(v.lines, MAX_WAITING), r: attackRate(s) } });
    if (v && v.lines > 0) v.lines = 0;
    if (s.bugsLeft <= 0) {
      if (endlessGame(s)) nextRound(s, events); // Endless: everything has settled, bring in more bugs
      else win(s, events); // the board has settled after the last bug: the level is won
    }
    if (v && v.waiting.length && s.phase === 'waiting') dropAttack(s, events);
    return;
  }
  if (v && v.lines >= 0) v.lines += Math.max(1, matchLines(s.board));
  s.chain++;
  s.clearing = cells;
  s.phase = 'clearing';
  s.phaseTimer = CLEAR_TICKS;
  const bugs = cells.filter(i => s.board[i]?.t === 'bug').length;
  events.push({ type: 'match', cells, bugs, chain: s.chain });
}

/** The last bug is gone and everything has stopped moving: check the sweep, then the level is won. */
function win(s: GameState, events: GameEvent[]) {
  checkCleanSweep(s, events);
  s.phase = 'won';
  events.push({ type: 'won' });
}

/**
 * Endless is continuous: when a round's bugs are all gone, the next round's bugs
 * arrive around whatever is on the board, and play goes on with no break.
 */
function nextRound(s: GameState, events: GameEvent[]) {
  checkCleanSweep(s, events); // Endless: the board has settled, so this is the sweep check for the round just cleared
  s.round = (s.round ?? 0) + 1;
  const lvl = currentLevel(s);
  const { cells, replaced } = addBugs(s.board, s, bugCount(lvl), s.config.colors, bugZoneRows(lvl, s.config.classicBugZone));
  s.bugsLeft = cells.length;
  s.phaseTimer = Math.max(s.phaseTimer, ARRIVE_TICKS);
  events.push({ type: 'arrive', cells, replaced, round: s.round });
}

/** Clean-sweep bonus before the speed multiplier: a base plus a step per level (Endless counts as level 100). */
export const SWEEP_BASE = 1000;
export const SWEEP_PER_LEVEL = 100;

/** Points for a clean sweep at this speed and level (Jeanne's idea, 2026-11-17). */
export function cleanSweepBonus(speed: GameConfig['speed'], level: number): number {
  return (SWEEP_BASE + SWEEP_PER_LEVEL * Math.min(level, FINAL_LEVEL)) * SPEED_MULTIPLIER[speed];
}

/** If no piece halves are left on the board, add the clean-sweep bonus (unless the config turns it off). */
function checkCleanSweep(s: GameState, events: GameEvent[]) {
  if (s.config.cleanSweep === false) return;
  if (s.board.some(cell => cell?.t === 'half')) return;
  const bonus = cleanSweepBonus(s.config.speed, currentLevel(s));
  s.score += bonus;
  events.push({ type: 'cleanSweep', bonus });
}

// The running multiplier, in tenths so it never drifts (floating 0.1 steps would).
const MULT_MIN = 10; // x1.0
const MULT_GAIN = 2; // +0.2 for every bug popped
const MULT_DECAY = 1; // -0.1 for every new piece

/** The running multiplier (1.0, 1.2, ...); classic scoring has none, so it shows the chain bonus instead. */
export function scoreMultiplier(s: GameState): number {
  return s.config.classicScoring ? 2 ** Math.min(s.dropBugs, 5) : (s.mult ?? MULT_MIN) / 10;
}

/**
 * Each bug is worth 100 x chain bonus x running multiplier x speed multiplier (Mike, 2026-11-17).
 * Chain bonus: doubles for each extra bug cleared by the same piece (x1, x2, x4... capped at x32).
 * Running multiplier: climbs 0.2 per bug and carries over from piece to piece (see GameState.mult).
 * Classic scoring keeps only the chain bonus.
 */
function scoreBugs(s: GameState, bugs: number) {
  if (s.power?.blast) { scoreBlastBugs(s, bugs); return; }
  for (let i = 0; i < bugs; i++) {
    if (s.config.classicScoring) {
      s.score += 100 * 2 ** Math.min(s.dropBugs, 5) * SPEED_MULTIPLIER[s.config.speed];
    } else {
      const m = s.mult ?? MULT_MIN;
      // 100 x chain bonus x (m / 10) x speed: whole points at every speed.
      s.score += 10 * m * 2 ** Math.min(s.dropBugs, 5) * SPEED_MULTIPLIER[s.config.speed];
      s.mult = m + MULT_GAIN;
    }
    s.dropBugs++;
  }
}

function applyAction(s: GameState, a: Action, events: GameEvent[]) {
  if (a === 'softOn' || a === 'softOff') { setSoft(s, a === 'softOn'); return; }
  if (a === 'power') { usePower(s, events); return; }
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
    if (a === 'power' && !s.power) continue; // power-ups off: not even recorded, so vanilla logs stay as they were
    s.log.push(s.tick * 8 + ACTIONS.indexOf(a));
    applyAction(s, a, events);
  }

  switch (s.phase) {
    case 'falling': {
      if (s.power && s.power.freeze > 0 && !s.soft) break; // Freeze: the piece hangs still unless held down
      s.dropTimer += TIMER_UNITS;
      const limit = dropLimit(s);
      if (s.dropTimer >= limit) {
        s.dropTimer -= limit; // keep any leftover (only matters for fractional intervals)
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
      const blast = !!s.power?.blast;
      scoreBugs(s, bugs);
      if (s.power) {
        if (!blast) fillMeter(s, bugs, events);
        s.power.blast = false;
      }
      events.push({ type: 'cleared', bugs, chainBonus: bugs && !blast ? 2 ** Math.min(s.dropBugs - 1, 5) : 1 });
      // Even after the last bug, loose halves fall and any chain plays out before the level ends
      // (Mike, 2026-11-19): a better chance at a clean sweep. See resolve().
      s.phase = 'settling';
      s.phaseTimer = settleTicks(s);
      break;
    }
    case 'settling': {
      if (--s.phaseTimer > 0) break;
      if (settleStep(s.board)) { s.phaseTimer = settleTicks(s); events.push({ type: 'fall' }); }
      else resolve(s, events);
      break;
    }
    case 'waiting': {
      if (--s.phaseTimer <= 0) spawn(s, events);
      break;
    }
  }
  if (s.power && s.power.freeze > 0 && --s.power.freeze === 0) events.push({ type: 'thaw' });
  s.tick++;
  return events;
}

// ---- Power-ups (Freeze, Bomb, Drill), only when config.powerUps is on --------------------

/** Bug credit that fills the meter and gives a power-up. */
export const METER_FULL = 8;
/** A bug popped in a chain (the second match round from one piece, or later) gives this much credit. */
export const CHAIN_CREDIT = 2;
/** How long Freeze holds the piece still. */
export const FREEZE_TICKS = 8 * TICKS_PER_SECOND;
/** How deep a drill bores below where it lands. */
export const DRILL_DEPTH = 3;
/** Points for a bug a bomb or drill destroys, before multipliers: half of a popped bug's 100. */
export const BLAST_BUG_POINTS = 50;
/** Running-multiplier gain per blasted bug, in tenths: +0.1, half of a popped bug's +0.2. */
const BLAST_MULT_GAIN = 1;

/** Credit popped bugs to the meter; a full meter gives a power-up if none is held. */
function fillMeter(s: GameState, bugs: number, events: GameEvent[]) {
  const p = s.power!;
  if (bugs === 0) return;
  p.meter = Math.min(METER_FULL, p.meter + bugs * (s.chain >= 2 ? CHAIN_CREDIT : 1));
  if (p.meter >= METER_FULL && p.held === null) {
    // Random from the seeded generator (so replays agree), but never the same kind three times running.
    const last2 = p.recent.length === 2 && p.recent[0] === p.recent[1] ? p.recent[0] : null;
    const pool = SOLO_POWER_KINDS.filter(k => k !== last2);
    const kind = pool[randInt(s, pool.length)]!;
    p.held = kind;
    p.recent = [...p.recent, kind].slice(-2);
    events.push({ type: 'powerGot', kind });
  }
}

/**
 * Use the held power-up. It becomes the next piece to drop, and the piece that was next waits one
 * turn behind it (Mike, 2026-11-21), so the player sees it coming. Usable any time during play.
 */
function usePower(s: GameState, events: GameEvent[]) {
  const p = s.power;
  if (!p || !p.held || p.queued || s.phase === 'won' || s.phase === 'lost') return;
  const kind = p.held;
  p.held = null;
  p.meter = 0; // the meter starts filling again from empty
  if (kind === 'freeze') p.freeze = FREEZE_TICKS; // kept for versus play later; not given out in single player
  else p.queued = kind;
  events.push({ type: 'powerUse', kind });
}

/** A bomb or drill has landed: mark what it destroys, then flash and clear it like a match. */
function detonate(s: GameState, events: GameEvent[]) {
  const { x, y, k } = s.piece!;
  const cells: number[] = [];
  if (k === 'bomb') {
    // The square is centered on the cell the bomb landed on (or on the bomb, on the floor),
    // so it digs two rows into what it hit, plus the row it sits in.
    const cy = y + 1 < BOARD_HEIGHT ? y + 1 : y;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = cy + dy;
      if (nx >= 0 && nx < BOARD_WIDTH && ny >= 0 && ny < BOARD_HEIGHT && s.board[idx(nx, ny)]) cells.push(idx(nx, ny));
    }
  } else {
    for (let d = 1; d <= DRILL_DEPTH && y + d < BOARD_HEIGHT; d++) if (s.board[idx(x, y + d)]) cells.push(idx(x, y + d));
  }
  s.piece = null;
  const bugs = cells.filter(i => s.board[i]?.t === 'bug').length;
  events.push({ type: 'blast', kind: k!, cells, bugs });
  if (cells.length === 0) { resolve(s, events); return; }
  s.power!.blast = true;
  s.clearing = cells.sort((p, q) => p - q);
  s.phase = 'clearing';
  s.phaseTimer = CLEAR_TICKS;
}

/** Bugs a bomb or drill destroys: 50 x running multiplier x speed, no chain bonus, +0.1 multiplier each. */
function scoreBlastBugs(s: GameState, bugs: number) {
  for (let i = 0; i < bugs; i++) {
    if (s.config.classicScoring) {
      s.score += BLAST_BUG_POINTS * SPEED_MULTIPLIER[s.config.speed];
    } else {
      const m = s.mult ?? MULT_MIN;
      s.score += Math.floor((BLAST_BUG_POINTS / 10) * m * SPEED_MULTIPLIER[s.config.speed]); // whole points (slo-mo can land on a half)
      s.mult = m + BLAST_MULT_GAIN;
    }
  }
}

// ---- Versus play (only when config.versus is on) -----------------------------------------

/** The most attack halves that can wait for a player at once; more are thrown away (Mike, 2026-11-22). */
export const MAX_WAITING = 4;
/** The two middle columns, where new pieces come in. Attack halves use them last. */
export const ENTRY_COLUMNS: readonly number[] = [SPAWN_X, SPAWN_X + 1];

/** Ticks per row for loose halves: the quick settle, or the slow fall of attack halves. */
function settleTicks(s: GameState): number {
  return s.versus?.fallTicks ?? SETTLE_TICKS;
}

/**
 * How fast this board's attacks fall on the receiver, in ticks per row: 75% of this board's normal
 * speed (Mike, 2026-11-22; it was 50%, which made the wait too harsh).
 */
export const ATTACK_SPEED = 0.75;
export function attackRate(s: GameState): number {
  return Math.max(1, Math.round(gravityInterval(s) / ATTACK_SPEED));
}

/**
 * An attack reaches this board. Call it between steps (never inside one); it is recorded with the
 * tick it arrived on, so replay() can land it at the same moment. Halves over the cap are thrown away.
 */
export function receiveAttack(s: GameState, attack: Attack): GameEvent[] {
  const v = s.versus;
  if (!v || s.phase === 'won' || s.phase === 'lost') return [];
  const n = Math.max(0, Math.min(MAX_WAITING, Math.floor(attack.n)));
  const r = Math.max(1, Math.floor(attack.r));
  v.received.push({ t: s.tick, n, r });
  return [admit(v, n, r)];
}

function admit(v: NonNullable<GameState['versus']>, n: number, r: number): GameEvent {
  const room = MAX_WAITING - waitingHalves(v);
  const take = Math.max(0, Math.min(n, room));
  if (take > 0) v.waiting.push({ n: take, r });
  return { type: 'incoming', waiting: waitingHalves(v), dropped: n - take };
}

/** Attack halves waiting to drop on this board. */
export function waitingHalves(v: NonNullable<GameState['versus']>): number {
  return v.waiting.reduce((a, w) => a + w.n, 0);
}

/**
 * Drop the waiting attack halves: one per column, in random columns with room at the top, the
 * entry columns only once every other column is full (Mike, 2026-11-22). They fall at the sender's
 * slow rate and the next piece waits for them. No room for them all means the board has topped out.
 */
function dropAttack(s: GameState, events: GameEvent[]) {
  const v = s.versus!;
  const n = waitingHalves(v);
  const r = Math.max(...v.waiting.map(w => w.r));
  v.waiting = [];
  const shuffle = (cols: number[]) => {
    for (let i = cols.length - 1; i > 0; i--) { const j = randInt(s, i + 1); [cols[i], cols[j]] = [cols[j]!, cols[i]!]; }
    return cols;
  };
  const free = (x: number) => s.board[idx(x, 0)] === null;
  const outer = shuffle(Array.from({ length: BOARD_WIDTH }, (_, x) => x).filter(x => free(x) && !ENTRY_COLUMNS.includes(x)));
  const entry = shuffle(ENTRY_COLUMNS.filter(free));
  const cols = [...outer, ...entry].slice(0, n);
  const cells = cols.map(x => {
    s.board[idx(x, 0)] = { t: 'half', c: randInt(s, s.config.colors), l: null };
    return idx(x, 0);
  });
  events.push({ type: 'garbage', cells });
  if (cols.length < n) {
    s.phase = 'lost';
    events.push({ type: 'lost' });
    return;
  }
  v.lines = -1; // whatever these halves set off is not this player's chain: it sends no attack
  v.fallTicks = r;
  s.phase = 'settling';
  s.phaseTimer = r;
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
export function replay(config: GameConfig, log: readonly number[], untilTick?: number, maxTicks = 60 * 60 * 60 * 3, received: readonly ReceivedAttack[] = []): GameState {
  const s = createGame(config);
  const byTick = decodeLog(log);
  const end = untilTick ?? maxTicks;
  let next = 0; // versus: attacks land at the tick they arrived, before that tick's step
  while (s.tick < end && s.phase !== 'won' && s.phase !== 'lost') {
    while (next < received.length && received[next]!.t <= s.tick) receiveAttack(s, received[next++]!);
    step(s, byTick.get(s.tick) ?? []);
  }
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
