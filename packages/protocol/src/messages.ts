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

export const PROTOCOL_VERSION = 4; // 2: rounds (best of 3), rejoining a match. 3: the stand-in computer runs on the other player's device. 4: the match settings card (lobby), Ready and power-ups
/** Moves go out in small batches: every this many ticks (50 ms at 60 ticks a second). */
export const SEND_EVERY = 3;
/** A message bigger than this is refused (a batch of moves is a few dozen bytes). */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** A rejoin carries every move of the round so far, so it may be much bigger. */
export const MAX_RESUME_BYTES = 2 * 1024 * 1024;
/** More actions than this in one tick is not a person (a fast swipe can make several). */
export const MAX_ACTIONS_PER_TICK = 16;

/**
 * The win rules an online match can use. best3 and best5: rounds of 'race' with the same opponent
 * until someone wins 2 or 3 (Mike, 2026-11-22); a drawn round doesn't count.
 */
export type OnlineRule = 'race' | 'best3' | 'best5' | 'last';
const RULES: readonly unknown[] = ['race', 'best3', 'best5', 'last'];
/** Round wins that take the match: 2 for best of 3, 3 for best of 5, otherwise one game decides. */
export const winsNeeded = (rule: string): number => (rule === 'best5' ? 3 : rule === 'best3' ? 2 : 1);

export type PlayerInfo = { level: number; speed: Speed; name: string };
/**
 * Once both players are Ready, the round starts this long after (Mike, 2026-11-22). Anyone
 * turning Ready off during the countdown stops it.
 */
export const COUNTDOWN_MS = 3000;

// ---- Client to relay ----
/**
 * Join with my level and speed (each player's own handicap). No `room`: quick match.
 * `room: 'new'` opens a room and the relay answers with its code; a 4-letter code joins that room.
 * (The reference relay has quick match only and refuses rooms.)
 */
export type Hello = { t: 'hello'; v: number; level: number; speed: Speed; room?: string; power?: boolean; people?: string[] };
/**
 * My choices on the match settings card, sent whenever one changes: my level and speed, whether I
 * want power-ups (they're on only if both players want them, Mike 2026-11-22), and Ready.
 */
export type SetUp = { t: 'set'; level: number; speed: Speed; power: boolean; ready: boolean };
/** My moves: engine log codes (tick * 8 + action) for every tick before `k`, which is my clock. */
export type Inputs = { t: 'in'; k: number; a: number[] };
/** An attack landed on my board at my tick `k` (n halves at r ticks a row). */
export type Took = { t: 'took'; k: number; n: number; r: number };
/** The match is over on my device: who won (seat 0 or 1), or null for a draw. */
export type Done = { t: 'done'; winner: 0 | 1 | null };
/** My copy of the opponent's game broke a rule. */
export type Flag = { t: 'flag'; why: string };
/**
 * The stand-in computer (Mike, 2026-11-22). When the other player drops out, my device plays their
 * board with the round's `botSeed`, in step with mine, and sends its moves ('bin', like 'in') and
 * the attacks it dropped on their board ('btook', like 'took'). The relay keeps them for that
 * player, who checks every one of them when they rejoin (OnlineMatch.rebuild).
 */
export type BotInputs = { t: 'bin'; k: number; a: number[] };
export type BotTook = { t: 'btook'; k: number; n: number; r: number };
/** I stopped the stand-in at its tick `k` (the other player is back): they carry on from there. */
export type Handed = { t: 'handed'; k: number };
/** I'm leaving the match on purpose (it ends now, and the other player wins). */
export type Quit = { t: 'quit' };
export type ClientMsg = Hello | Inputs | Took | Done | Flag | Quit | BotInputs | BotTook | Handed | SetUp;

// ---- Relay to client ----
/** Queued: waiting for an opponent. */
export type Wait = { t: 'wait' };
/** My room is open: give this code (4 letters) to a friend. */
export type Room = { t: 'room'; code: string };
/**
 * Matched, or the next round of the match. `seat` is which of `players` I am; both boards use
 * `seed` and `colors`. `round` counts from 1 and `wins` is the rounds each seat has won so far.
 * `botSeed` is the stand-in computer's, should either player drop out this round.
 */
export type Start = { t: 'start'; seat: 0 | 1; seed: number; botSeed: number; colors: number; rule: OnlineRule; players: [PlayerInfo, PlayerInfo]; round: number; wins: [number, number]; power: boolean };
/** One player on the match settings card. */
export type LobbyPlayer = PlayerInfo & { power: boolean; ready: boolean };
/**
 * The match settings card (before every round): both players, their choices and who is Ready.
 * Sent again whenever anything changes. `startsIn` is the countdown in ms once both are Ready
 * (0 while not counting down); the 'start' follows when it runs out.
 */
export type Lobby = { t: 'lobby'; seat: 0 | 1; round: number; wins: [number, number]; players: [LobbyPlayer, LobbyPlayer]; startsIn: number };
/** One seat's side of a round so far: every move, every attack taken, and its clock. */
export type SeatLog = { moves: number[]; took: { k: number; n: number; r: number }[]; clock: number };
/** Where the stand-in computer played my board this round: my ticks from `from` up to `to`. */
export type StandIn = { from: number; to: number };
/**
 * Back in a match I dropped out of (Mike, 2026-11-22: going back into Multiplayer rejoins it).
 * While I was away the other player's device ran the stand-in computer on my board; `mine`
 * includes its moves, and `standIns` says where. Rebuild both boards with OnlineMatch.rebuild
 * (which checks the stand-in's every move) and play on from my clock.
 */
export type Resume = { t: 'resume'; start: Start; mine: SeatLog; theirs: SeatLog; standIns: StandIn[]; earlier: RoundLog[] };
/**
 * An earlier round of this match that the stand-in played part of for me (it may have decided
 * that round), so my device checks it too.
 */
export type RoundLog = { start: Start; mine: SeatLog; theirs: SeatLog; standIns: StandIn[] };
/** The other player dropped out: run the stand-in computer on their board (up to `seconds`). */
export type Away = { t: 'away'; seconds: number };
/** The other player is back: stop the stand-in and answer 'handed'. */
export type Back = { t: 'back' };
/** The opponent's moves and the attacks they took are passed on unchanged (Inputs, Took). */
export type End = { t: 'end'; why: 'result' | 'left' | 'flag' | 'disagree'; winner: 0 | 1 | null };
export type Refused = { t: 'error'; why: string };
export type ServerMsg = Wait | Room | Start | Inputs | Took | End | Refused | Resume | Away | Back | Lobby;

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
      if (m.power !== undefined && typeof m.power !== 'boolean') return null;
      const hello: Hello = { t: 'hello', v: m.v, level: m.level, speed: m.speed, ...(m.power ? { power: true } : {}) };
      // Protocol 5 rooms: up to 3 more people playing on this device, by the names typed on it.
      if (m.people !== undefined) {
        if (!Array.isArray(m.people) || m.people.length > MAX_PER_DEVICE - 1 || !m.people.every(n => typeof n === 'string' && n.trim())) return null;
        hello.people = (m.people as string[]).map(n => n.trim().slice(0, 40));
      }
      if (m.room === undefined) return hello;
      return typeof m.room === 'string' && ROOM_CODE.test(m.room) ? { ...hello, room: m.room } : null;
    }
    case 'in': return inputs(m);
    case 'took': return took(m);
    case 'done': return seat(m.winner) ? { t: 'done', winner: m.winner } : null;
    case 'flag': return typeof m.why === 'string' ? { t: 'flag', why: m.why.slice(0, 200) } : null;
    case 'quit': return { t: 'quit' };
    case 'bin': { const i = inputs(m); return i && { ...i, t: 'bin' }; }
    case 'btook': { const t = took(m); return t && { ...t, t: 'btook' }; }
    case 'handed': return int(m.k, 0, MAX_TICK) ? { t: 'handed', k: m.k } : null;
    case 'set':
      return int(m.level, 1, 100) && speed(m.speed) && typeof m.power === 'boolean' && typeof m.ready === 'boolean'
        ? { t: 'set', level: m.level, speed: m.speed, power: m.power, ready: m.ready } : null;
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
  if (!int(m.botSeed, -0x80000000, 0xffffffff)) return null;
  if (!int(m.round, 1, 100) || !Array.isArray(m.wins) || m.wins.length !== 2 || !m.wins.every(w => int(w, 0, 100))) return null;
  if (typeof m.power !== 'boolean') return null;
  const [a, b] = players as PlayerInfo[];
  const clean = (p: PlayerInfo): PlayerInfo => ({ level: p.level, speed: p.speed, name: p.name.slice(0, 40) });
  return { t: 'start', seat: m.seat, seed: m.seed, botSeed: m.botSeed, colors: m.colors, rule: m.rule as OnlineRule, players: [clean(a!), clean(b!)], round: m.round, wins: [m.wins[0] as number, m.wins[1] as number], power: m.power };
}

function lobby(m: Record<string, unknown>): Lobby | null {
  const player = (p: unknown): LobbyPlayer | null => {
    const q = p as Record<string, unknown> | null;
    if (!q || !int(q.level, 1, 100) || !speed(q.speed) || typeof q.name !== 'string' || typeof q.power !== 'boolean' || typeof q.ready !== 'boolean') return null;
    return { level: q.level, speed: q.speed, name: q.name.slice(0, 40), power: q.power, ready: q.ready };
  };
  if ((m.seat !== 0 && m.seat !== 1) || !int(m.round, 1, 100) || !int(m.startsIn, 0, 60_000)) return null;
  if (!Array.isArray(m.wins) || m.wins.length !== 2 || !m.wins.every(w => int(w, 0, 100))) return null;
  if (!Array.isArray(m.players) || m.players.length !== 2) return null;
  const a = player(m.players[0]), b = player(m.players[1]);
  if (!a || !b) return null;
  return { t: 'lobby', seat: m.seat, round: m.round, wins: [m.wins[0] as number, m.wins[1] as number], players: [a, b], startsIn: m.startsIn };
}

function seatLog(x: unknown): SeatLog | null {
  const m = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  if (!m || !int(m.clock, 0, MAX_TICK) || !Array.isArray(m.moves) || !Array.isArray(m.took)) return null;
  if (!m.moves.every(c => int(c, 0, MAX_TICK * 8))) return null;
  const took = m.took.map(t => (t && typeof t === 'object' ? (t as Record<string, unknown>) : {}));
  if (!took.every(t => int(t.k, 0, MAX_TICK) && int(t.n, 1, 4) && int(t.r, 1, 10000))) return null;
  return { moves: m.moves as number[], took: took.map(t => ({ k: t.k as number, n: t.n as number, r: t.r as number })), clock: m.clock };
}

function roundLog(x: unknown): RoundLog | null {
  const m = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  if (!m) return null;
  const st = m.start && typeof m.start === 'object' ? start(m.start as Record<string, unknown>) : null;
  const mine = seatLog(m.mine), theirs = seatLog(m.theirs);
  const standIns = Array.isArray(m.standIns) ? m.standIns.map(x => x as Record<string, unknown>) : null;
  if (!st || !mine || !theirs || !standIns) return null;
  if (!standIns.every(x => x && int(x.from, 0, MAX_TICK) && int(x.to, 0, MAX_TICK) && (x.to as number) >= (x.from as number))) return null;
  return { start: st, mine, theirs, standIns: standIns.map(x => ({ from: x.from as number, to: x.to as number })) };
}

/** Read a message from the relay, or null if it isn't a valid one. */
export function parseServer(raw: string): ServerMsg | null {
  const m = obj(raw, MAX_RESUME_BYTES);
  switch (m?.t) {
    case 'wait': return { t: 'wait' };
    case 'room': return typeof m.code === 'string' && ROOM_CODE.test(m.code) && m.code !== 'new' ? { t: 'room', code: m.code } : null;
    case 'start': return start(m);
    case 'lobby': return lobby(m);
    case 'resume': {
      const now = roundLog(m);
      const earlier = Array.isArray(m.earlier) ? m.earlier.map(roundLog) : null;
      if (!now || !earlier || earlier.length > 2 || !earlier.every(r => r)) return null;
      return { t: 'resume', ...now, earlier: earlier as RoundLog[] };
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

// ---- Tables: online games of 2 to 4 seats (protocol 5, Mike 2026-11-22) ----------------------
//
// A table is one game in a room (or a quick match). Every seat is a person on some device or a
// computer, and one device may play several seats (two people sharing a tablet, or the computers
// the room gives it to run). Every device rebuilds every board from the moves, so anyone in the
// room can watch any table (a watcher plays no seats).
//
// Attacks still never travel as messages. Every device works out each attack's target the same way
// (see table.ts); the target's device drops the attack on its board and says when ('ttook'), so
// every copy of every board stays the same. Every device checks every board it rebuilds.

/** At most this many seats at a table. */
export const MAX_SEATS = 4;
/**
 * Who gets attacked with 3 or 4 players: the leader (fewest bugs left), someone at random, or
 * everyone still playing (Mike 2026-11-22: fine without teams; teams would need more thought).
 */
export type Target = 'leader' | 'random' | 'everyone';
export const TARGETS: readonly Target[] = ['leader', 'random', 'everyone'];
export type BotName = 'easy' | 'medium' | 'hard';
/** One seat: a person (with their name) or a computer at a skill. */
export type SeatInfo = { name: string; level: number; speed: Speed; cpu?: BotName };
/**
 * A round at a table starts. Every device at the table (players and watchers) gets the same
 * start, except `mine` (the seats this device plays with people) and `runs` (the computers it plays).
 */
export type TableStart = {
  t: 'tstart'; table: number; seed: number; botSeed: number; colors: number; rule: OnlineRule; target: Target; power: boolean;
  seats: SeatInfo[]; mine: number[]; runs: number[]; round: number; wins: number[];
};
/** Seat `s`'s moves up to its clock `k` (like 'in'). */
export type TableInputs = { t: 'tin'; s: number; k: number; a: number[] };
/** Seat `s` took attack number `i` from seat `from` at its tick `k` (n halves, r ticks a row). */
export type TableTook = { t: 'ttook'; s: number; k: number; n: number; r: number; from: number; i: number };
/** The round is over on my device: the winning seat, or null for a draw. */
export type TableDone = { t: 'tdone'; winner: number | null };
/** The stand-in stopped playing seat `s` at its tick `k`: the person plays it again from there. */
export type TableHand = { t: 'thand'; s: number; k: number };
export type TableMsg = TableInputs | TableTook | TableHand;

const seatNo = (x: unknown): x is number => int(x, 0, MAX_SEATS - 1);

/** Read a table message (from a client, or passed on by the relay), or null. */
export function parseTable(m: Record<string, unknown> | null): TableMsg | TableDone | null {
  switch (m?.t) {
    case 'tin': {
      if (!seatNo(m.s)) return null;
      const i = inputs(m);
      return i && { t: 'tin', s: m.s, k: i.k, a: i.a };
    }
    case 'ttook': {
      if (!seatNo(m.s) || !seatNo(m.from) || m.from === m.s || !int(m.i, 0, 100_000)) return null;
      const tk = took(m);
      return tk && { t: 'ttook', s: m.s, k: tk.k, n: tk.n, r: tk.r, from: m.from, i: m.i };
    }
    case 'thand': return seatNo(m.s) && int(m.k, 0, 10_000_000) ? { t: 'thand', s: m.s, k: m.k } : null;
    case 'tdone': return m.winner === null || seatNo(m.winner) ? { t: 'tdone', winner: m.winner as number | null } : null;
    default: return null;
  }
}
/** The same, from raw text. */
export function parseTableRaw(raw: string): TableMsg | TableDone | null { return parseTable(obj(raw)); }

/** Read a table start from the relay, or null. */
export function parseTableStart(raw: string): TableStart | null {
  const m = obj(raw);
  if (m?.t !== 'tstart') return null;
  const seats = Array.isArray(m.seats) ? m.seats : [];
  const seat = (x: unknown): SeatInfo | null => {
    const q = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
    if (!q || !int(q.level, 1, 100) || !speed(q.speed) || typeof q.name !== 'string') return null;
    if (q.cpu !== undefined && q.cpu !== 'easy' && q.cpu !== 'medium' && q.cpu !== 'hard') return null;
    return { name: q.name.slice(0, 40), level: q.level, speed: q.speed, ...(q.cpu ? { cpu: q.cpu as BotName } : {}) };
  };
  const list = seats.map(seat);
  const seatList = (x: unknown) => Array.isArray(x) && x.every(v => int(v, 0, list.length - 1)) ? (x as number[]) : null;
  const mine = seatList(m.mine), runs = seatList(m.runs);
  if (list.length < 2 || list.length > MAX_SEATS || !list.every(Boolean) || !mine || !runs) return null;
  if (!int(m.table, 0, 1_000_000) || !int(m.seed, -0x80000000, 0xffffffff) || !int(m.botSeed, -0x80000000, 0xffffffff) || !int(m.colors, 2, 5)) return null;
  if (!RULES.includes(m.rule) || !TARGETS.includes(m.target as Target) || typeof m.power !== 'boolean') return null;
  if (!int(m.round, 1, 100) || !Array.isArray(m.wins) || m.wins.length !== list.length || !m.wins.every(w => int(w, 0, 100))) return null;
  return {
    t: 'tstart', table: m.table, seed: m.seed, botSeed: m.botSeed, colors: m.colors, rule: m.rule as OnlineRule, target: m.target as Target, power: m.power,
    seats: list as SeatInfo[], mine, runs, round: m.round, wins: m.wins as number[],
  };
}

// ---- Rooms (protocol 5, Mike 2026-11-22) -----------------------------------------------------
//
// Friends gather in a room of up to 16 people; a device may bring up to 4 of them (people sharing
// a phone or tablet). The room's owner (whoever made it) sets the room rules; every game in the
// room uses them, and they can't change while a game is going. Two ways to play:
//   Open pool: anyone not playing starts a game of 2 to 4; seats left over get computers at the
//     people's average. Between rounds the rotation picks who plays next. Several games at once.
//   Tournament: always 1 against 1, up to two games at once, everyone else watches.
// Each person can give up their seat or say Watch only at any time, and take a computer's seat.
// Every device can watch any game: it rebuilds every board from the moves, like the players do.

/** Rooms speak protocol 5 (the 1 against 1 relay stays on PROTOCOL_VERSION until it moves to tables). */
export const ROOM_VERSION = 6;
/** At most this many people in a room, and on one device. */
export const MAX_ROOM = 16;
export const MAX_PER_DEVICE = 4;
/** Who plays the next round of a game: the winner keeps their seat, or a draw that favours who sat out. */
export type Rotation = 'winner' | 'random';
/** Tournament kinds: a bracket of best-of-3 or best-of-5 matches, a bracket of single games, or out at 2 losses. */
export type TourKind = 'best3' | 'best5' | 'single' | 'double';
const TOUR_KINDS: readonly unknown[] = ['best3', 'best5', 'single', 'double'];
export type RoomRules = {
  mode: 'pool' | 'tour';
  /** How a game is won (a tournament's best3 or best5 plays rounds of 'race'). */
  rule: OnlineRule;
  rotation: Rotation;
  target: Target;
  colors: number;
  tour: TourKind;
  /** Tournament level and speed: the same for everyone (below), or each player chooses. */
  tourLevels: 'same' | 'choose';
  level: number;
  speed: Speed;
};
export const DEFAULT_RULES: RoomRules = { mode: 'pool', rule: 'race', rotation: 'winner', target: 'leader', colors: 3, tour: 'single', tourLevels: 'choose', level: 5, speed: 1 };

// Client to server, in a room. People are named by `pid`, which the server hands out.
/** The owner changes the room rules (refused while a game is going). */
export type SetRules = { t: 'rrules'; rules: RoomRules };
/** Add someone else on this device (a name typed on it), or take them out of the room. */
export type AddPerson = { t: 'radd'; name: string };
export type DropPerson = { t: 'rdel'; pid: string };
/** `by` starts a new game of `size` seats in the open pool. */
export type NewGame = { t: 'rnew'; by: string; size: number };
/** Watch only (never picked to play), or not. */
export type WatchOnly = { t: 'rwatch'; pid: string; watch: boolean };
/** Give up my seat: from the next round someone else (or a computer) plays it. */
export type GiveUp = { t: 'rfree'; pid: string };
/** Take a computer's seat `s` at game `g`, from its next round. */
export type TakeSeat = { t: 'rtake'; pid: string; g: number; s: number };
/** Which game this device watches (it gets that game's moves), or none. */
export type View = { t: 'rview'; g: number | null };
/** The owner starts the tournament with everyone not on Watch only. */
export type StartTour = { t: 'rtour' };
/** A person's choices on a game's settings card (like 'set'). */
export type GameSet = { t: 'gset'; g: number; pid: string; level: number; speed: Speed; power: boolean; ready: boolean };
/** A table message for game `g` (moves, takes, hand-backs, my result). */
export type GameMsg = { t: 'g'; g: number; m: TableMsg | TableDone | Flag };
export type RoomClientMsg = SetRules | AddPerson | DropPerson | NewGame | WatchOnly | GiveUp | TakeSeat | View | StartTour | GameSet | GameMsg | Quit;

// Server to client, in a room.
export type RoomPerson = { pid: string; name: string; mine: boolean; watch: boolean; here: boolean; game: number | null };
export type RoomSeat = { name: string; pid?: string; cpu?: BotName };
export type RoomGame = { g: number; seats: RoomSeat[]; round: number; wins: number[]; phase: 'lobby' | 'playing'; tour: boolean };
export type TourPlayer = { pid: string; name: string; wins: number; losses: number; out: boolean };
export type TourMatch = { a: string; b: string; winner: string | null; g: number | null; round: number };
export type TourInfo = { kind: TourKind; players: TourPlayer[]; matches: TourMatch[]; champion: string | null };
/** Everything about the room, sent whenever it changes. */
export type RoomState = { t: 'rstate'; code: string; owner: string; rules: RoomRules; people: RoomPerson[]; games: RoomGame[]; tour: TourInfo | null };
export type LobbySeat = { name: string; level: number; speed: Speed; power: boolean; ready: boolean; pid?: string; cpu?: BotName };
/** A game's settings card before each round (like 'lobby'). */
export type GameLobby = { t: 'globby'; g: number; round: number; wins: number[]; seats: LobbySeat[]; startsIn: number };
/** A dropped device's seat: `you` play it with the stand-in from here (takeOver), or someone else does (away). */
export type GameDrop = { t: 'gdrop'; g: number; s: number; you: boolean };
/** The person is back: stop the stand-in on seat `s` and hand it over (handOver). */
export type GameBack = { t: 'gback'; g: number; s: number };
/** One step of a game's record, for a device catching up: a table message or a seat dropping. */
export type RecordStep = TableMsg | { t: 'drop'; s: number };
/** Catch up on a game in progress (joining late, watching, or coming back); then claim `claim` seats. */
export type GameCatchUp = { t: 'gcatch'; g: number; start: TableStart; steps: RecordStep[]; claim: number[] };
export type GameEnd = { t: 'gend'; g: number; why: 'result' | 'flag' | 'disagree' | 'empty'; winner: number | null };
export type RoomServerMsg = RoomState | GameLobby | TableStart | GameMsg | GameDrop | GameBack | GameCatchUp | GameEnd | Refused;

const PID = /^p[0-9]{1,4}$/;
const pid = (x: unknown): x is string => typeof x === 'string' && PID.test(x);
const gameNo = (x: unknown): x is number => int(x, 0, 1_000_000);
const botName = (x: unknown): x is BotName => x === 'easy' || x === 'medium' || x === 'hard';
const name40 = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 40) : null);

/** Read room rules, or null. */
export function parseRules(x: unknown): RoomRules | null {
  const m = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  if (!m || (m.mode !== 'pool' && m.mode !== 'tour') || !RULES.includes(m.rule) || (m.rotation !== 'winner' && m.rotation !== 'random')) return null;
  if (!TARGETS.includes(m.target as Target) || !int(m.colors, 2, 5) || !TOUR_KINDS.includes(m.tour)) return null;
  if ((m.tourLevels !== 'same' && m.tourLevels !== 'choose') || !int(m.level, 1, 100) || !speed(m.speed)) return null;
  return { mode: m.mode, rule: m.rule as OnlineRule, rotation: m.rotation, target: m.target as Target, colors: m.colors, tour: m.tour as TourKind, tourLevels: m.tourLevels, level: m.level, speed: m.speed };
}

/** Read a room message from a client, or null. */
export function parseRoomClient(raw: string): RoomClientMsg | null {
  const m = obj(raw);
  switch (m?.t) {
    case 'rrules': { const rules = parseRules(m.rules); return rules && { t: 'rrules', rules }; }
    case 'radd': { const n = name40(m.name); return n ? { t: 'radd', name: n } : null; }
    case 'rdel': return pid(m.pid) ? { t: 'rdel', pid: m.pid } : null;
    case 'rnew': return pid(m.by) && int(m.size, 2, MAX_SEATS) ? { t: 'rnew', by: m.by, size: m.size } : null;
    case 'rwatch': return pid(m.pid) && typeof m.watch === 'boolean' ? { t: 'rwatch', pid: m.pid, watch: m.watch } : null;
    case 'rfree': return pid(m.pid) ? { t: 'rfree', pid: m.pid } : null;
    case 'rtake': return pid(m.pid) && gameNo(m.g) && seatNo(m.s) ? { t: 'rtake', pid: m.pid, g: m.g, s: m.s } : null;
    case 'rview': return m.g === null || gameNo(m.g) ? { t: 'rview', g: m.g as number | null } : null;
    case 'rtour': return { t: 'rtour' };
    case 'gset':
      return gameNo(m.g) && pid(m.pid) && int(m.level, 1, 100) && speed(m.speed) && typeof m.power === 'boolean' && typeof m.ready === 'boolean'
        ? { t: 'gset', g: m.g, pid: m.pid, level: m.level, speed: m.speed, power: m.power, ready: m.ready } : null;
    case 'g': {
      if (!gameNo(m.g)) return null;
      const q = m.m && typeof m.m === 'object' ? (m.m as Record<string, unknown>) : null;
      if (q?.t === 'flag') return typeof q.why === 'string' ? { t: 'g', g: m.g, m: { t: 'flag', why: q.why.slice(0, 200) } } : null;
      const inner = parseTable(q);
      return inner && { t: 'g', g: m.g, m: inner };
    }
    case 'quit': return { t: 'quit' };
    default: return null;
  }
}

function lobbySeat(x: unknown): LobbySeat | null {
  const q = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  const n = q && name40(q.name);
  if (!q || !n || !int(q.level, 1, 100) || !speed(q.speed) || typeof q.power !== 'boolean' || typeof q.ready !== 'boolean') return null;
  if ((q.pid !== undefined && !pid(q.pid)) || (q.cpu !== undefined && !botName(q.cpu))) return null;
  return { name: n, level: q.level, speed: q.speed, power: q.power, ready: q.ready, ...(q.pid ? { pid: q.pid as string } : {}), ...(q.cpu ? { cpu: q.cpu as BotName } : {}) };
}

function roomState(m: Record<string, unknown>): RoomState | null {
  const rules = parseRules(m.rules);
  if (!rules || typeof m.code !== 'string' || !/^[A-Z]{4}$/.test(m.code) || !pid(m.owner)) return null;
  const list = (x: unknown) => (Array.isArray(x) ? (x as unknown[]).map(v => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})) : null);
  const people = list(m.people), games = list(m.games);
  if (!people || people.length > MAX_ROOM || !games || games.length > MAX_ROOM) return null;
  const ps: RoomPerson[] = [];
  for (const p of people) {
    const n = name40(p.name);
    if (!pid(p.pid) || !n || typeof p.mine !== 'boolean' || typeof p.watch !== 'boolean' || typeof p.here !== 'boolean' || !(p.game === null || gameNo(p.game))) return null;
    ps.push({ pid: p.pid, name: n, mine: p.mine, watch: p.watch, here: p.here, game: p.game as number | null });
  }
  const gs: RoomGame[] = [];
  for (const g of games) {
    const seats = list(g.seats);
    if (!gameNo(g.g) || !seats || seats.length < 2 || seats.length > MAX_SEATS || !int(g.round, 1, 100) || (g.phase !== 'lobby' && g.phase !== 'playing') || typeof g.tour !== 'boolean') return null;
    if (!Array.isArray(g.wins) || g.wins.length !== seats.length || !g.wins.every(w => int(w, 0, 100))) return null;
    const ss: RoomSeat[] = [];
    for (const s of seats) {
      const n = name40(s.name);
      if (!n || (s.pid !== undefined && !pid(s.pid)) || (s.cpu !== undefined && !botName(s.cpu))) return null;
      ss.push({ name: n, ...(s.pid ? { pid: s.pid as string } : {}), ...(s.cpu ? { cpu: s.cpu as BotName } : {}) });
    }
    gs.push({ g: g.g, seats: ss, round: g.round, wins: g.wins as number[], phase: g.phase, tour: g.tour });
  }
  let tour: TourInfo | null = null;
  if (m.tour !== null) {
    const t = m.tour && typeof m.tour === 'object' ? (m.tour as Record<string, unknown>) : null;
    const players = list(t?.players), matches = list(t?.matches);
    if (!t || !TOUR_KINDS.includes(t.kind) || !players || !matches || !(t.champion === null || pid(t.champion))) return null;
    const tp: TourPlayer[] = [];
    for (const p of players) {
      const n = name40(p.name);
      if (!pid(p.pid) || !n || !int(p.wins, 0, 1000) || !int(p.losses, 0, 1000) || typeof p.out !== 'boolean') return null;
      tp.push({ pid: p.pid, name: n, wins: p.wins, losses: p.losses, out: p.out });
    }
    const tm: TourMatch[] = [];
    for (const x of matches) {
      if (!pid(x.a) || !pid(x.b) || !(x.winner === null || pid(x.winner)) || !(x.g === null || gameNo(x.g)) || !int(x.round, 1, 100)) return null;
      tm.push({ a: x.a, b: x.b, winner: x.winner as string | null, g: x.g as number | null, round: x.round });
    }
    tour = { kind: t.kind as TourKind, players: tp, matches: tm, champion: t.champion as string | null };
  }
  return { t: 'rstate', code: m.code, owner: m.owner, rules, people: ps, games: gs, tour };
}

/** Read a room message from the server, or null. */
export function parseRoomServer(raw: string): RoomServerMsg | null {
  const m = obj(raw, MAX_RESUME_BYTES);
  switch (m?.t) {
    case 'rstate': return roomState(m);
    case 'globby': {
      const seats = Array.isArray(m.seats) ? m.seats.map(lobbySeat) : null;
      if (!gameNo(m.g) || !int(m.round, 1, 100) || !int(m.startsIn, 0, 60_000) || !seats || seats.length < 2 || seats.length > MAX_SEATS || !seats.every(Boolean)) return null;
      if (!Array.isArray(m.wins) || m.wins.length !== seats.length || !m.wins.every(w => int(w, 0, 100))) return null;
      return { t: 'globby', g: m.g, round: m.round, wins: m.wins as number[], seats: seats as LobbySeat[], startsIn: m.startsIn };
    }
    case 'tstart': return parseTableStart(raw);
    case 'g': {
      if (!gameNo(m.g)) return null;
      const q = m.m && typeof m.m === 'object' ? (m.m as Record<string, unknown>) : null;
      if (q?.t === 'flag') return typeof q.why === 'string' ? { t: 'g', g: m.g, m: { t: 'flag', why: q.why.slice(0, 200) } } : null;
      const inner = parseTable(q);
      return inner && { t: 'g', g: m.g, m: inner };
    }
    case 'gdrop': return gameNo(m.g) && seatNo(m.s) && typeof m.you === 'boolean' ? { t: 'gdrop', g: m.g, s: m.s, you: m.you } : null;
    case 'gback': return gameNo(m.g) && seatNo(m.s) ? { t: 'gback', g: m.g, s: m.s } : null;
    case 'gcatch': {
      const st = m.start && typeof m.start === 'object' ? parseTableStart(JSON.stringify(m.start)) : null;
      if (!gameNo(m.g) || !st || !Array.isArray(m.steps) || !Array.isArray(m.claim) || !m.claim.every(seatNo)) return null;
      const steps: RecordStep[] = [];
      for (const x of m.steps) {
        const q = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
        if (q?.t === 'drop') { if (!seatNo(q.s)) return null; steps.push({ t: 'drop', s: q.s }); continue; }
        const tm = parseTable(q);
        if (!tm || tm.t === 'tdone') return null;
        steps.push(tm);
      }
      return { t: 'gcatch', g: m.g, start: st, steps, claim: m.claim as number[] };
    }
    case 'gend': {
      const why = m.why;
      return gameNo(m.g) && (why === 'result' || why === 'flag' || why === 'disagree' || why === 'empty') && (m.winner === null || seatNo(m.winner))
        ? { t: 'gend', g: m.g, why, winner: m.winner as number | null } : null;
    }
    case 'error': return typeof m.why === 'string' ? { t: 'error', why: m.why.slice(0, 200) } : null;
    default: return null;
  }
}
