// Plain data types for the game state.
//
// Everything here is JSON-safe on purpose: saving a game is JSON.stringify,
// loading one is JSON.parse. No classes, no Maps, no floating-point timers.

export const BOARD_WIDTH = 8;
export const BOARD_HEIGHT = 16;
/**
 * Saved-game format. 1: the move record as a JSON number array.
 * 2: the move record packed into bytes (see packLog) and the whole save deflate-compressed.
 * deserialize() still reads version 1, so older saves keep working.
 */
export const SAVE_VERSION = 2;

/** A color index, 0 .. colors-1. Skins decide what each index looks like. */
export type Color = number;

/** Which side a piece half's partner is on, or null for a lone half. */
export type Link = 'L' | 'R' | 'U' | 'D' | null;

export type BugCell = { t: 'bug'; c: Color };
export type HalfCell = { t: 'half'; c: Color; l: Link };
export type Cell = BugCell | HalfCell | null;

/**
 * A falling two-part piece. (x, y) is always its bottom-left cell.
 * rot 0: a left,  b right   rot 1: a bottom, b top
 * rot 2: b left,  a right   rot 3: b bottom, a top
 * Adding 1 to rot turns the piece a quarter counterclockwise.
 */
export type Piece = { x: number; y: number; rot: 0 | 1 | 2 | 3; a: Color; b: Color };

/** 0 low, 1 medium, 2 high, 3 slo-mo (slowest; only with 4 or 5 colors). */
export type Speed = 0 | 1 | 2 | 3;

export type GameConfig = {
  seed: number;
  level: number; // 0 .. 100 is the game (clearing 100 beats it); 101 and up is Endless
  speed: Speed; // 0 low, 1 medium, 2 high, 3 slo-mo
  colors: number; // 2 .. 5
  /**
   * Score carried in from earlier levels of the same run (default 0). It is part of
   * the config, so replay() still reproduces the final score exactly. To verify a
   * multi-level run, replay each level and check its startScore equals the previous
   * level's verified final score.
   */
  startScore?: number;
  /**
   * false turns off the clean-sweep bonus (for a future "classic" mode). Absent or
   * true: clearing a level's last bug with no piece halves left on the board scores
   * a bonus (see cleanSweepBonus).
   */
  cleanSweep?: boolean;
};

/** 'waiting' is the short beat after things land, before the next piece appears. */
export type Phase = 'falling' | 'clearing' | 'settling' | 'waiting' | 'won' | 'lost';

export type Action = 'left' | 'right' | 'rotCW' | 'rotCCW' | 'softOn' | 'softOff';
export const ACTIONS: readonly Action[] = ['left', 'right', 'rotCW', 'rotCCW', 'softOn', 'softOff'];

export type GameState = {
  v: number;
  config: GameConfig;
  rng: number;
  tick: number;
  board: Cell[]; // row-major, index = y * BOARD_WIDTH + x, y = 0 is the top
  phase: Phase;
  piece: Piece | null;
  next: { a: Color; b: Color };
  soft: boolean; // soft drop held
  dropTimer: number; // in thousandths of a tick (see SOFT_DROP_TICKS)
  phaseTimer: number;
  clearing: number[]; // board indices being cleared right now
  piecesSpawned: number;
  bugsLeft: number;
  score: number;
  dropBugs: number; // bugs cleared since the current piece landed (for scoring)
  chain: number; // match rounds since the current piece landed
  /**
   * Endless rounds cleared so far in this game (continuous play). The level being
   * played is config.level + round. Absent in older saves, which means 0.
   */
  round?: number;
  /**
   * Every action ever passed to step(), encoded as tick * 8 + action index.
   * Together with config this replays the game exactly.
   */
  log: number[];
};

export type GameEvent =
  | { type: 'spawn' }
  | { type: 'move' }
  | { type: 'rotate' }
  | { type: 'lock' }
  | { type: 'fall' } // loose halves dropped one row
  | { type: 'match'; cells: number[]; bugs: number; chain: number }
  | { type: 'cleared'; bugs: number }
  | { type: 'won' }
  /** The level's (or Endless round's) last bug went with no piece halves left on the board. */
  | { type: 'cleanSweep'; bonus: number }
  /** Endless: a round was cleared and the next round's bugs came in (cells), some taking over halves (replaced). */
  | { type: 'arrive'; cells: number[]; replaced: number[]; round: number }
  | { type: 'lost' };
