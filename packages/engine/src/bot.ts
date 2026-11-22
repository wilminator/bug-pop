// A computer player.
//
// The bot looks at the board the way a person would: for the piece in play it tries every turn
// and column the piece can reach, scores where each would land, picks one, then steers the piece
// there with the same actions a player sends (left, right, turn, drop). It never touches the game
// state, so its moves go into the move log like anyone's and a replay reproduces them.
//
// It is NOT deterministic on purpose (Mike, 2026-11-22): it has its own random numbers, seeded by
// the caller (the client seeds it from the browser's random source), so two games against it
// never play out the same way. Skill levels differ in how long it thinks, how fast it moves and
// how often it picks a worse spot.

import { BOARD_HEIGHT, BOARD_WIDTH, type Action, type Cell, type GameState, type Piece } from './types';
import { findMatches, fits, idx, pieceCells, removeCells, settleStep } from './board';
import { nextU32 } from './rng';

export type BotSkill = {
  /** Ticks it waits after a new piece appears before it starts moving. */
  think: number;
  /** Ticks between its moves (1 = a move every tick). */
  moveEvery: number;
  /** Chance (0 to 1) of settling for a weaker spot than its best. */
  slip: number;
  /** Holds down once the piece is lined up. Off for a stand-in bot (Mike, 2026-11-22). */
  drop: boolean;
  /** Plans two pieces ahead: where this one goes, judged by the best spot for the next one. */
  lookahead?: boolean;
  /**
   * Chance (0 to 1) that a piece is placed the old way: no thought for buried bugs and no
   * planning ahead. Medium mixes the two (Mike, 2026-11-22), so it sits between Easy and Hard.
   */
  oldWay?: number;
};

export const BOT_SKILLS = {
  easy: { think: 40, moveEvery: 12, slip: 0.35, drop: false },
  medium: { think: 20, moveEvery: 6, slip: 0.12, drop: true, oldWay: 0.5 },
  hard: { think: 8, moveEvery: 3, slip: 0.02, drop: true, lookahead: true }, // plans one piece ahead (Mike, 2026-11-22: Hard only)
} as const satisfies Record<string, BotSkill>;
export type BotLevel = keyof typeof BOT_SKILLS;

/** A spot a piece can land on: its turn and column, and how good it is. */
export type Plan = { rot: Piece['rot']; x: number; score: number };

/** Can the piece get from where it is to (rot, x) by turning in place, then sliding sideways? */
function reachable(board: Cell[], from: Piece, rot: Piece['rot'], x: number): Piece | null {
  let p = from;
  // Turn first, one quarter at a time (the same way the game turns it, without its wall kick).
  for (let k = 0; k < 4 && p.rot !== rot; k++) {
    const turned = { ...p, rot: ((p.rot + 1) % 4) as Piece['rot'] };
    if (fits(board, turned)) p = turned;
    else {
      const kicked = { ...turned, x: turned.x - 1 }; // the game's wall kick when turning flat
      if (turned.rot % 2 === 0 && fits(board, kicked)) p = kicked; else return null;
    }
  }
  while (p.x !== x) {
    const moved = { ...p, x: p.x + Math.sign(x - p.x) };
    if (!fits(board, moved)) return null;
    p = moved;
  }
  return p;
}

/** Where the piece comes to rest if it drops straight down from here. */
function dropped(board: Cell[], p: Piece): Piece {
  let q = p;
  while (fits(board, { ...q, y: q.y + 1 })) q = { ...q, y: q.y + 1 };
  return q;
}

/** A board after a piece lands and everything it sets off has popped and fallen, and its score. */
type Landed = { board: Cell[]; score: number };

/** Weights for how the bot judges a spot (exported so tests can compare settings). */
export const BOT_WEIGHTS = {
  /** Each cell of another color stacked over a bug's own color run (it must pop before the bug can). */
  buried: 3,
};

/**
 * Put the piece on a copy of the board, play out what it sets off, and score it: pops are best,
 * then neat stacking; building high is bad. Null if the piece would stick out of the top.
 */
function land(board: Cell[], p: Piece, buried: number): Landed | null {
  const b = board.map(c => (c ? { ...c } : null)); // removeCells re-links halves: never touch the real board
  const cells = pieceCells(p);
  if (cells.some(h => h.y < 0)) return null;
  for (const h of cells) b[idx(h.x, h.y)] = { t: 'half', c: h.c, l: h.l };
  let score = 0;
  // Play the clears out: every bug popped (also by chains) counts a lot.
  for (let round = 0; round < 10; round++) {
    const hit = findMatches(b);
    if (!hit.length) break;
    const bugs = removeCells(b, hit);
    score += bugs * 120 + (hit.length - bugs) * 8 + round * 40;
    while (settleStep(b)) { /* let loose halves fall */ }
  }
  // Same colors touching: a match on the way (down counts more, it is what lines up columns).
  for (const h of cells) {
    const look = (dx: number, dy: number, w: number) => {
      const x = h.x + dx, y = h.y + dy;
      if (x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_HEIGHT) return;
      const c = b[idx(x, y)];
      if (!c) return;
      if (c.c === h.c) score += w * (c.t === 'bug' ? 1.5 : 1);
      else if (dy === 1) score -= c.t === 'bug' ? 10 : 4; // covering another color, worst on a bug
    };
    look(0, 1, 9); look(-1, 0, 4); look(1, 0, 4); look(0, -1, 3);
  }
  // Keep the stack low, and the entry columns clearest of all.
  for (let x = 0; x < BOARD_WIDTH; x++) {
    let top = BOARD_HEIGHT;
    for (let y = 0; y < BOARD_HEIGHT; y++) if (b[idx(x, y)]) { top = y; break; }
    const height = BOARD_HEIGHT - top;
    if (height > 10) score -= (height - 10) * (x === 3 || x === 4 ? 30 : 10);
  }
  // Easy to recover from? (Mike, 2026-11-22.) Count only what this piece made worse or better.
  if (buried) score += trouble(board, buried) - trouble(b, buried);
  return { board: b, score };
}

/**
 * How hard a board is to dig out of (Mike, 2026-11-22: the bot must think about whether it can
 * still clear what it builds).
 * Buried bugs: a bug pops with a line of 4 through it. Same-color cells stacked right on it are
 * progress, but every cell of another color above that has to be popped first.
 * (Tried and dropped: a cost for gaps under pieces. It made the bot stack worse, not better.)
 */
export function trouble(b: Cell[], buried = BOT_WEIGHTS.buried): number {
  let t = 0;
  for (let x = 0; x < BOARD_WIDTH; x++) {
    let cover = 0; // cells above, in this column
    let runColor = -1, run = 0; // the same-color run directly above the current cell
    for (let y = 0; y < BOARD_HEIGHT; y++) {
      const c = b[idx(x, y)];
      if (!c) continue;
      if (c.c === runColor) run++; else { runColor = c.c; run = 1; }
      if (c.t === 'bug') t += (cover - (run - 1)) * buried; // what sits on its own run
      cover++;
    }
  }
  return t;
}

/** Every resting spot a piece can reach from where it is, with where it ends up. */
function landings(board: Cell[], p: Piece): { rot: Piece['rot']; x: number; at: Piece }[] {
  const out: { rot: Piece['rot']; x: number; at: Piece }[] = [];
  const rots: Piece['rot'][] = p.k ? [p.rot] : [0, 1, 2, 3];
  const seen = new Set<string>();
  for (const rot of rots) {
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const at = reachable(board, p, rot, x);
      if (!at) continue;
      const d = dropped(board, at);
      // Turning a two-color piece twice is a different landing; a one-color piece the same one.
      const cells = pieceCells(d).map(h => `${h.x},${h.y},${h.c}`).sort().join(';');
      if (seen.has(cells)) continue;
      seen.add(cells);
      out.push({ rot, x, at: d });
    }
  }
  return out;
}

/**
 * Every spot the current piece can reach, best first. With `lookahead`, each spot is also judged
 * by the best place for the NEXT piece after it (the piece shown in the Next window), the way a
 * person plans two pieces ahead.
 */
export function plans(s: GameState, lookahead = false, buried: number = BOT_WEIGHTS.buried): Plan[] {
  const p = s.piece;
  if (!p) return [];
  const out: Plan[] = [];
  for (const { rot, x, at } of landings(s.board, p)) {
    const first = land(s.board, at, buried);
    if (!first) { out.push({ rot, x, score: -1e6 }); continue; }
    let score = first.score;
    if (lookahead) {
      const next: Piece = { x: 3, y: 0, rot: 0, a: s.next.a, b: s.next.b };
      let best = -Infinity;
      if (fits(first.board, next)) {
        for (const n of landings(first.board, next)) {
          const second = land(first.board, n.at, buried);
          if (second) best = Math.max(best, second.score);
        }
      }
      // No room for the next piece at all: this spot loses the game.
      score = best === -Infinity ? -1e5 : first.score + 0.8 * best;
    }
    out.push({ rot, x, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * A bot for one board. Call act() once per tick with the board's state; it returns that tick's
 * actions. Seed it with any 32-bit number; a different seed plays differently.
 */
export class Bot {
  private rng: { rng: number };
  private piece = -1; // piecesSpawned when it last planned
  private plan: Plan | null = null;
  private wait = 0;
  private holding = false;

  constructor(public skill: BotSkill, seed: number) {
    this.rng = { rng: seed | 0 };
  }

  private chance(p: number) {
    return nextU32(this.rng) / 0x100000000 < p;
  }

  act(s: GameState): Action[] {
    const actions: Action[] = [];
    if (s.phase !== 'falling' || !s.piece) {
      if (this.holding) { this.holding = false; actions.push('softOff'); }
      return actions;
    }
    if (this.piece !== s.piecesSpawned) {
      // A new piece: look it over (a slightly different pause each time, so it feels alive).
      this.piece = s.piecesSpawned;
      this.plan = null;
      this.wait = this.skill.think + (nextU32(this.rng) % Math.max(1, this.skill.think));
      if (this.holding) { this.holding = false; actions.push('softOff'); }
    }
    if (this.wait > 0) { this.wait--; return actions; }
    if (!this.plan) {
      const old = !!this.skill.oldWay && this.chance(this.skill.oldWay);
      const all = old ? plans(s, false, 0) : plans(s, !!this.skill.lookahead);
      if (!all.length) return actions;
      // Usually the best spot; now and then (more often when easy) one of the next few instead.
      let pick = 0;
      while (pick < Math.min(3, all.length - 1) && this.chance(this.skill.slip)) pick++;
      // Ties are common: choose among equal scores at random, so games differ.
      const ties = all.filter(p => p.score === all[pick]!.score);
      this.plan = ties[nextU32(this.rng) % ties.length]!;
      this.wait = 0;
    }
    const p = s.piece;
    const want = this.plan;
    if (p.rot !== want.rot && !p.k) actions.push('rotCCW'); // rotCCW adds a quarter, as plans() counts them
    else if (p.x !== want.x) actions.push(p.x < want.x ? 'right' : 'left');
    else if (this.skill.drop && !this.holding) { this.holding = true; actions.push('softOn'); }
    if (actions.length && actions[0] !== 'softOn') this.wait = this.skill.moveEvery - 1;
    return actions;
  }
}
