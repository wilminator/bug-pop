// What a client and a relay say to each other in online versus (multiplayer stage 2).
//
// The design is an INPUT RELAY: each player's own board runs on their own device, and the relay
// only passes each player's moves to the other. Every device rebuilds the opponent's board from
// those moves with the same engine, so nobody has to trust the other's picture of the game.
//
// Attacks are never sent as messages. When my copy of your board makes two lines at once, my
// device sees the attack itself and drops it on my board. I then tell you the tick it landed on
// ('took'), so your copy of my board takes it at exactly the same moment and stays identical.
//
// Every message is one JSON object with a `t` (type) field. All numbers are whole numbers.

import type { Speed } from '@bug-pop/engine';

export const PROTOCOL_VERSION = 2; // 2: rounds (best of 3), rejoining a match
/** Moves go out in small batches: every this many ticks (50 ms at 60 ticks a second). */
export const SEND_EVERY = 3;
/** A message bigger than this is refused (a batch of moves is a few dozen bytes). */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** A rejoin carries every move of the round so far, so it may be much bigger. */
export const MAX_RESUME_BYTES = 2 * 1024 * 1024;
/** More actions than this in one tick is not a person (a fast swipe can make several). */
export const MAX_ACTIONS_PER_TICK = 16;

/**
 * The win rules an online match can use. best3: rounds of 'race' with the same opponent until
 * someone wins 2 (Mike, 2026-11-22); a drawn round doesn't count.
 */
export type OnlineRule = 'race' | 'best3' | 'last';
const RULES: readonly unknown[] = ['race', 'best3', 'last'];

export type PlayerInfo = { level: number; speed: Speed; name: string };

// ---- Client to relay ----
/**
 * Join with my level and speed (each player's own handicap). No `room`: quick match.
 * `room: 'new'` opens a room and the relay answers with its code; a 4-letter code joins that room.
 * (The reference relay has quick match only and refuses rooms.)
 */
export type Hello = { t: 'hello'; v: number; level: number; speed: Speed; room?: string };
/** My moves: engine log codes (tick * 8 + action) for every tick before `k`, which is my clock. */
export type Inputs = { t: 'in'; k: number; a: number[] };
/** An attack landed on my board at my tick `k` (n halves at r ticks a row). */
export type Took = { t: 'took'; k: number; n: number; r: number };
/** The match is over on my device: who won (seat 0 or 1), or null for a draw. */
export type Done = { t: 'done'; winner: 0 | 1 | null };
/** My copy of the opponent's game broke a rule. */
export type Flag = { t: 'flag'; why: string };
/** I'm leaving the match on purpose (it ends now, and the other player wins). */
export type Quit = { t: 'quit' };
export type ClientMsg = Hello | Inputs | Took | Done | Flag | Quit;

// ---- Relay to client ----
/** Queued: waiting for an opponent. */
export type Wait = { t: 'wait' };
/** My room is open: give this code (4 letters) to a friend. */
export type Room = { t: 'room'; code: string };
/**
 * Matched, or the next round of the match. `seat` is which of `players` I am; both boards use
 * `seed` and `colors`. `round` counts from 1 and `wins` is the rounds each seat has won so far.
 */
export type Start = { t: 'start'; seat: 0 | 1; seed: number; colors: number; rule: OnlineRule; players: [PlayerInfo, PlayerInfo]; round: number; wins: [number, number] };
/** One seat's side of a round so far: every move, every attack taken, and its clock. */
export type SeatLog = { moves: number[]; took: { k: number; n: number; r: number }[]; clock: number };
/**
 * Back in a match I dropped out of (Mike, 2026-11-22: going back into Multiplayer rejoins it).
 * While I was away the computer played my board; `mine` includes its moves. Rebuild both boards
 * with OnlineMatch.rebuild and play on from my clock.
 */
export type Resume = { t: 'resume'; start: Start; mine: SeatLog; theirs: SeatLog };
/** The other player dropped out: the computer plays their board for up to `seconds`. */
export type Away = { t: 'away'; seconds: number };
/** The other player is back. */
export type Back = { t: 'back' };
/** The opponent's moves and the attacks they took are passed on unchanged (Inputs, Took). */
export type End = { t: 'end'; why: 'result' | 'left' | 'flag' | 'disagree'; winner: 0 | 1 | null };
export type Refused = { t: 'error'; why: string };
export type ServerMsg = Wait | Room | Start | Inputs | Took | End | Refused | Resume | Away | Back;

// ---- Checking what comes in (never trust the other end) ----
const int = (x: unknown, min: number, max: number): x is number => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;
const speed = (x: unknown): x is Speed => int(x, 0, 3);
const seat = (x: unknown): x is 0 | 1 | null => x === 0 || x === 1 || x === null;
const MAX_TICK = 60 * 60 * 60 * 3; // three hours
/** A room code: 4 capital letters, or 'new' to open a room. */
export const ROOM_CODE = /^(?:[A-Z]{4}|new)$/;

function obj(raw: string, max = MAX_MESSAGE_BYTES): Record<string, unknown> | null {
  if (raw.length > max) return null;
  try {
    const m: unknown = JSON.parse(raw);
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function inputs(m: Record<string, unknown>): Inputs | null {
  if (!int(m.k, 0, MAX_TICK) || !Array.isArray(m.a) || !m.a.every(c => int(c, 0, MAX_TICK * 8))) return null;
  return { t: 'in', k: m.k, a: m.a as number[] };
}
function took(m: Record<string, unknown>): Took | null {
  return int(m.k, 0, MAX_TICK) && int(m.n, 1, 4) && int(m.r, 1, 10000) ? { t: 'took', k: m.k, n: m.n, r: m.r } : null;
}

/** Read a message from a client, or null if it isn't a valid one. */
export function parseClient(raw: string): ClientMsg | null {
  const m = obj(raw);
  switch (m?.t) {
    case 'hello': {
      if (!int(m.v, 0, 1000) || !int(m.level, 1, 100) || !speed(m.speed)) return null;
      if (m.room === undefined) return { t: 'hello', v: m.v, level: m.level, speed: m.speed };
      return typeof m.room === 'string' && ROOM_CODE.test(m.room) ? { t: 'hello', v: m.v, level: m.level, speed: m.speed, room: m.room } : null;
    }
    case 'in': return inputs(m);
    case 'took': return took(m);
    case 'done': return seat(m.winner) ? { t: 'done', winner: m.winner } : null;
    case 'flag': return typeof m.why === 'string' ? { t: 'flag', why: m.why.slice(0, 200) } : null;
    case 'quit': return { t: 'quit' };
    default: return null;
  }
}

function start(m: Record<string, unknown>): Start | null {
  const players = m.players;
  const player = (p: unknown): p is PlayerInfo => {
    const q = p as Record<string, unknown> | null;
    return !!q && int(q.level, 1, 100) && speed(q.speed) && typeof q.name === 'string';
  };
  if ((m.seat !== 0 && m.seat !== 1) || !int(m.seed, -0x80000000, 0xffffffff) || !int(m.colors, 2, 5) || !RULES.includes(m.rule)) return null;
  if (!Array.isArray(players) || players.length !== 2 || !players.every(player)) return null;
  if (!int(m.round, 1, 100) || !Array.isArray(m.wins) || m.wins.length !== 2 || !m.wins.every(w => int(w, 0, 100))) return null;
  const [a, b] = players as PlayerInfo[];
  const clean = (p: PlayerInfo): PlayerInfo => ({ level: p.level, speed: p.speed, name: p.name.slice(0, 40) });
  return { t: 'start', seat: m.seat, seed: m.seed, colors: m.colors, rule: m.rule as OnlineRule, players: [clean(a!), clean(b!)], round: m.round, wins: [m.wins[0] as number, m.wins[1] as number] };
}

function seatLog(x: unknown): SeatLog | null {
  const m = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  if (!m || !int(m.clock, 0, MAX_TICK) || !Array.isArray(m.moves) || !Array.isArray(m.took)) return null;
  if (!m.moves.every(c => int(c, 0, MAX_TICK * 8))) return null;
  const took = m.took.map(t => (t && typeof t === 'object' ? (t as Record<string, unknown>) : {}));
  if (!took.every(t => int(t.k, 0, MAX_TICK) && int(t.n, 1, 4) && int(t.r, 1, 10000))) return null;
  return { moves: m.moves as number[], took: took.map(t => ({ k: t.k as number, n: t.n as number, r: t.r as number })), clock: m.clock };
}

/** Read a message from the relay, or null if it isn't a valid one. */
export function parseServer(raw: string): ServerMsg | null {
  const m = obj(raw, MAX_RESUME_BYTES);
  switch (m?.t) {
    case 'wait': return { t: 'wait' };
    case 'room': return typeof m.code === 'string' && ROOM_CODE.test(m.code) && m.code !== 'new' ? { t: 'room', code: m.code } : null;
    case 'start': return start(m);
    case 'resume': {
      const st = m.start && typeof m.start === 'object' ? start(m.start as Record<string, unknown>) : null;
      const mine = seatLog(m.mine), theirs = seatLog(m.theirs);
      return st && mine && theirs ? { t: 'resume', start: st, mine, theirs } : null;
    }
    case 'away': return int(m.seconds, 0, 600) ? { t: 'away', seconds: m.seconds } : null;
    case 'back': return { t: 'back' };
    case 'in': return inputs(m);
    case 'took': return took(m);
    case 'end': {
      const why = m.why;
      return (why === 'result' || why === 'left' || why === 'flag' || why === 'disagree') && seat(m.winner) ? { t: 'end', why, winner: m.winner } : null;
    }
    case 'error': return typeof m.why === 'string' ? { t: 'error', why: m.why.slice(0, 200) } : null;
    default: return null;
  }
}
