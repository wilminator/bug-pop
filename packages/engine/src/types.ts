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
export const SAVE_VERSION = 3;
// 3: power-ups (GameConfig.powerUps, GameState.power, Piece.k). Every new field is optional and
// absent means "off", so a version 2 save loads as a game with power-ups off: nothing to convert.

/** A color index, 0 .. colors-1. Skins decide what each index looks like. */
export type Color = number;

/** Which side a piece half's partner is on, or null for a lone half. */
export type Link = 'L' | 'R' | 'U' | 'D' | null;

export type BugCell = { t: 'bug'; c: Color };
/** w: a wildcard half (power-ups only) that counts as every color. Its c is kept only for drawing. */
export type HalfCell = { t: 'half'; c: Color; l: Link; w?: true };
export type Cell = BugCell | HalfCell | null;

/**
 * A falling two-part piece. (x, y) is always its bottom-left cell.
 * rot 0: a left,  b right   rot 1: a bottom, b top
 * rot 2: b left,  a right   rot 3: b bottom, a top
 * Adding 1 to rot turns the piece a quarter counterclockwise.
 */
export type Piece = {
  x: number; y: number; rot: 0 | 1 | 2 | 3; a: Color; b: Color;
  /**
   * Power-ups: a bomb or drill is a one-cell piece at (x, y); a and b are unused.
   * Absent means an ordinary two-part piece.
   */
  k?: 'bomb' | 'drill';
  /** Power-ups: both halves are wildcards that match any color. */
  w?: true;
};

/** The three power-ups (single player). Skins give each its own name and art. */
export type PowerKind = 'freeze' | 'bomb' | 'drill' | 'wild';
/** Every kind the engine knows. Freeze is kept for later (versus play) but no longer given out. */
export const POWER_KINDS: readonly PowerKind[] = ['freeze', 'bomb', 'drill', 'wild'];
/** The kinds the meter hands out in single player (Mike, 2026-11-21: Wildcard replaces Freeze). */
export const SOLO_POWER_KINDS: readonly PowerKind[] = ['bomb', 'drill', 'wild'];

/** Power-up progress. Only present when config.powerUps is on. */
export type PowerState = {
  meter: number; // bug credit toward the next power-up, 0 .. METER_FULL
  held: PowerKind | null; // at most one held at a time
  freeze: number; // ticks of Freeze left (0 = not frozen)
  recent: PowerKind[]; // the last two power-ups given, so the same kind never comes three times running
  /**
   * A power-up the player used, waiting to drop: it is the next piece, and the piece shown as next
   * waits one turn behind it (Mike, 2026-11-21). The Next window shows it.
   */
  queued: 'bomb' | 'drill' | 'wild' | null;
  blast: boolean; // true while cells cleared by a bomb or drill are flashing (they score at half value)
};

/** 0 low, 1 medium, 2 high, 3 slo-mo (slowest; only with 4 or 5 colors). */
export type Speed = 0 | 1 | 2 | 3;

export type GameConfig = {
  seed: number;
  level: number; // 1 .. 100 is the game (clearing 100 beats it). Old saves may hold 0, or 101+ (old Endless)
  /**
   * Endless mode (Mike, 2026-11-19): starts as `level` (normally 1: its bugs and speed) and climbs
   * one level per round with no break; past 100 the speed holds. Never won, only lost.
   */
  endless?: boolean;
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
  /**
   * true: classic scoring, where each extra bug cleared by the same piece doubles
   * (x32 at most) and nothing carries over between pieces. Absent or false: the
   * running multiplier (see GameState.mult).
   */
  classicScoring?: boolean;
  /**
   * true: the classic lock, where a piece is placed at the first fall step it can't make (one
   * step's time on the ground, as short as 1/6 s holding down). Absent or false: the grace
   * before a resting piece is placed (see LOCK_TICKS), so it can still slide at the last moment.
   */
  classicLock?: boolean;
  /**
   * true: bugs fill the classic tall area from level 1 (10 rows or more). Absent or
   * false: early levels keep their bugs low, from the bottom third on level 1 up to
   * the normal height by the mid-40s (see bugZoneRows).
   */
  classicBugZone?: boolean;
  /**
   * true: power-ups are on (Freeze, Bomb, Drill; opt-in, Mike 2026-11-19). Absent or false: the
   * engine never touches any power-up code, so vanilla games, saves and replays are unchanged.
   */
  powerUps?: boolean;
  /** Power-up progress carried in from the previous level of the same run (like startScore). */
  startPower?: { meter: number; held: PowerKind | null };
  /**
   * Versus play (multiplayer, Mike 2026-11-22): big chains send loose halves to an opponent, and
   * halves sent here drop in after the next piece settles. Absent: single player, untouched.
   */
  versus?: boolean;
};

/**
 * Versus: an attack that reached this board. n halves (1 to 4) fall at r ticks per row, which is
 * half the sender's normal speed. Every arrival is recorded with its tick (t) so a replay of this
 * board, which can't see the sender, lands the same halves at the same moment.
 */
export type Attack = { n: number; r: number };
export type ReceivedAttack = Attack & { t: number };

/** Versus progress. Only present when config.versus is on. */
export type VersusState = {
  /** Lines matched since the current piece landed (two or more make an attack). */
  lines: number;
  /** Attacks waiting to drop, 4 halves at most in all (Mike, 2026-11-22: extras are thrown away). */
  waiting: Attack[];
  /** Every attack that arrived, in order (part of the record, like the move log). */
  received: ReceivedAttack[];
  /** While attack halves fall: ticks per row (they fall slowly; the wait is part of the penalty). */
  fallTicks: number | null;
};

/** 'waiting' is the short beat after things land, before the next piece appears. */
export type Phase = 'falling' | 'clearing' | 'settling' | 'waiting' | 'won' | 'lost';

export type Action = 'left' | 'right' | 'rotCW' | 'rotCCW' | 'softOn' | 'softOff' | 'power';
/** Order matters: the move log stores each action's index (0 .. 7), so new actions only go on the end. */
export const ACTIONS: readonly Action[] = ['left', 'right', 'rotCW', 'rotCCW', 'softOn', 'softOff', 'power'];

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
  /**
   * Ticks the piece has rested on something (it can't fall). It is placed once this reaches
   * lockTicks(). Absent while it can still fall, and in older saves.
   */
  lockTimer?: number;
  /** Moves and turns that restarted lockTimer for this piece (at most LOCK_RESETS). */
  lockResets?: number;
  phaseTimer: number;
  clearing: number[]; // board indices being cleared right now
  piecesSpawned: number;
  bugsLeft: number;
  score: number;
  dropBugs: number; // bugs cleared since the current piece landed (for classic scoring)
  /**
   * The running score multiplier in tenths (10 = x1.0). Every bug popped scores at the
   * current multiplier and then raises it by 0.2; every new piece lowers it by 0.1,
   * never below x1.0 (Mike, 2026-11-17). Absent in older saves, which means x1.0.
   */
  mult?: number;
  chain: number; // match rounds since the current piece landed
  /**
   * Endless rounds cleared so far in this game (continuous play). The level being
   * played is config.level + round. Absent in older saves, which means 0.
   */
  round?: number;
  /** Power-ups (only when config.powerUps is on). */
  power?: PowerState;
  /** Versus play (only when config.versus is on). */
  versus?: VersusState;
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
  /** chainBonus: the doubling the last bug of this clear scored at (x1, x2 ... x32), 1 if no bugs. */
  | { type: 'cleared'; bugs: number; chainBonus: number }
  | { type: 'won' }
  /** The level's (or Endless round's) last bug went with no piece halves left on the board. */
  | { type: 'cleanSweep'; bonus: number }
  /** Endless: a round was cleared and the next round's bugs came in (cells), some taking over halves (replaced). */
  | { type: 'arrive'; cells: number[]; replaced: number[]; round: number }
  | { type: 'lost' }
  /** Power-ups: the meter filled and gave one. */
  | { type: 'powerGot'; kind: PowerKind }
  /** Power-ups: the player used the one they held. */
  | { type: 'powerUse'; kind: PowerKind }
  /** Freeze ran out. */
  | { type: 'thaw' }
  /** Versus: this board's chain made an attack to send to an opponent. */
  | { type: 'attack'; attack: Attack }
  /** Versus: an attack arrived (waiting shows how many halves wait now; dropped ones were over the cap). */
  | { type: 'incoming'; waiting: number; dropped: number }
  /** Versus: waiting attack halves appeared at the top of these cells and start to fall. */
  | { type: 'garbage'; cells: number[] }
  /** A bomb or drill went off: these cells are cleared (they flash like a match first). */
  | { type: 'blast'; kind: 'bomb' | 'drill'; cells: number[]; bugs: number };
