// Board rules: where pieces fit, what matches, what falls.
// These are pure functions over a Cell[]; game.ts decides when to call them.

import { randInt } from './rng';
import { BOARD_HEIGHT as H, BOARD_WIDTH as W, type Cell, type Color, type Link, type Piece } from './types';

export const MATCH_LENGTH = 4;

export const idx = (x: number, y: number): number => y * W + x;
export const inBounds = (x: number, y: number): boolean => x >= 0 && x < W && y >= 0 && y < H;

export function emptyBoard(): Cell[] {
  return new Array<Cell>(W * H).fill(null);
}

export type PlacedHalf = { x: number; y: number; c: Color; l: Link };

/** The two cells a piece covers, each with the link pointing at its partner. */
export function pieceCells(p: Piece): [PlacedHalf, PlacedHalf] {
  const { x, y, a, b } = p;
  switch (p.rot) {
    case 0: return [{ x, y, c: a, l: 'R' }, { x: x + 1, y, c: b, l: 'L' }];
    case 1: return [{ x, y, c: a, l: 'U' }, { x, y: y - 1, c: b, l: 'D' }];
    case 2: return [{ x, y, c: b, l: 'R' }, { x: x + 1, y, c: a, l: 'L' }];
    case 3: return [{ x, y, c: b, l: 'U' }, { x, y: y - 1, c: a, l: 'D' }];
  }
}

export function fits(board: Cell[], p: Piece): boolean {
  return pieceCells(p).every(h => inBounds(h.x, h.y) && board[idx(h.x, h.y)] === null);
}

/** All cells that sit in a horizontal or vertical run of MATCH_LENGTH+ of one color. */
export function findMatches(board: Cell[]): number[] {
  const hit = new Set<number>();
  const scan = (cells: number[]) => {
    let start = 0;
    for (let i = 1; i <= cells.length; i++) {
      const prev = board[cells[i - 1]!];
      const cur = i < cells.length ? board[cells[i]!] : null;
      if (cur && prev && cur.c === prev.c) continue;
      if (prev && i - start >= MATCH_LENGTH) for (let k = start; k < i; k++) hit.add(cells[k]!);
      start = i;
    }
  };
  for (let y = 0; y < H; y++) scan(Array.from({ length: W }, (_, x) => idx(x, y)));
  for (let x = 0; x < W; x++) scan(Array.from({ length: H }, (_, y) => idx(x, y)));
  return [...hit].sort((p, q) => p - q);
}

const partnerOffset: Record<Exclude<Link, null>, [number, number]> = { L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1] };

/** Remove cells; any half whose partner was removed becomes a lone half. Returns bugs removed. */
export function removeCells(board: Cell[], cells: number[]): number {
  let bugs = 0;
  for (const i of cells) {
    const cell = board[i];
    if (!cell) continue;
    if (cell.t === 'bug') bugs++;
    else if (cell.l) {
      const [dx, dy] = partnerOffset[cell.l];
      const partner = board[i + dx + dy * W];
      if (partner && partner.t === 'half') partner.l = null;
    }
    board[i] = null;
  }
  return bugs;
}

/**
 * Drop every unsupported piece half by one row. Returns true if anything moved.
 * Bugs never fall. A sideways pair falls only if both cells below are empty.
 * Scanning from the bottom up lets a whole loose stack fall together.
 */
export function settleStep(board: Cell[]): boolean {
  let moved = false;
  const empty = (x: number, y: number) => y < H && board[idx(x, y)] === null;
  const move = (x: number, y: number) => {
    board[idx(x, y + 1)] = board[idx(x, y)]!;
    board[idx(x, y)] = null;
  };
  for (let y = H - 2; y >= 0; y--) {
    for (let x = 0; x < W; x++) {
      const cell = board[idx(x, y)];
      if (!cell || cell.t !== 'half') continue;
      if (cell.l === null && empty(x, y + 1)) { move(x, y); moved = true; }
      else if (cell.l === 'R' && empty(x, y + 1) && empty(x + 1, y + 1)) { move(x, y); move(x + 1, y); moved = true; }
      else if (cell.l === 'U' && empty(x, y + 1)) { move(x, y); move(x, y - 1); moved = true; }
      // 'L' and 'D' halves move with their partner above.
    }
  }
  return moved;
}

/** Bugs on level 0, and the most a board ever gets. */
export const FIRST_BUGS = 4, MAX_BUGS = 84;
/** 4 more bugs every this many levels, so level 100 is the first with all 84 bugs in the tallest area (Mike, 2026-11-17). */
export const LEVELS_PER_4_BUGS = 5;
export const FULL_BOARD_LEVEL = ((MAX_BUGS - FIRST_BUGS) / 4) * LEVELS_PER_4_BUGS;

export function bugCount(level: number): number {
  return Math.min(MAX_BUGS, FIRST_BUGS + 4 * Math.floor(level / LEVELS_PER_4_BUGS));
}

/** How many rows from the bottom may hold bugs: the zone grows as the count gets crowded. */
export function bugZoneRows(level: number): number {
  const n = bugCount(level);
  return n >= 80 ? 13 : n >= 72 ? 12 : n >= 64 ? 11 : 10;
}

/**
 * Scatter bugs for a level. Colors cycle so they stay balanced, and we avoid
 * placing three of one color in a line so the opening board is fair.
 */
export function placeBugs(board: Cell[], holder: { rng: number }, level: number, colors: number): number {
  const count = bugCount(level);
  const top = H - bugZoneRows(level);
  const sameRun = (x: number, y: number, c: Color, dx: number, dy: number) => {
    let n = 0;
    for (let s = 1; s <= 2; s++) {
      const nx = x + dx * s, ny = y + dy * s;
      const cell = inBounds(nx, ny) ? board[idx(nx, ny)] : null;
      if (!cell || cell.c !== c) break;
      n++;
    }
    return n;
  };
  const wouldLine = (x: number, y: number, c: Color) =>
    sameRun(x, y, c, -1, 0) + sameRun(x, y, c, 1, 0) >= 2 || sameRun(x, y, c, 0, -1) + sameRun(x, y, c, 0, 1) >= 2;

  let placed = 0;
  for (let i = 0; i < count; i++) {
    const want = i % colors;
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = randInt(holder, W);
      const y = top + randInt(holder, H - top);
      if (board[idx(x, y)] !== null) continue;
      // Try the wanted color first, then the others; relax the rule late on.
      let chosen = -1;
      for (let k = 0; k < colors; k++) {
        const c = (want + k) % colors;
        if (!wouldLine(x, y, c) || attempt > 150) { chosen = c; break; }
      }
      if (chosen < 0) continue;
      board[idx(x, y)] = { t: 'bug', c: chosen };
      placed++;
      break;
    }
  }
  return placed;
}
