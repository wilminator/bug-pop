// Versus play (multiplayer stage 1): attacks, the slow-falling halves, and the bot.
import { describe, expect, it } from 'vitest';
import {
  createGame, step, replay, receiveAttack, serialize, deserialize, emptyBoard, idx, plans, Bot, BOT_SKILLS,
  MAX_WAITING, ENTRY_COLUMNS, BOARD_WIDTH as W, attackRate, gravityInterval,
  type GameState, type GameEvent, type Action,
} from '../src';

const cfg = { seed: 777, level: 3, speed: 1 as const, colors: 3, versus: true };

function run(s: GameState, ticks: number, actions: (t: number) => Action[] = () => []) {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks && s.phase !== 'won' && s.phase !== 'lost'; i++) events.push(...step(s, actions(s.tick)));
  return events;
}

/** Hold down until the next piece appears (or the game ends). */
function untilSpawn(s: GameState): GameEvent[] {
  const events: GameEvent[] = [];
  while (s.phase !== 'won' && s.phase !== 'lost' && !events.some(e => e.type === 'spawn')) events.push(...step(s, ['softOn']));
  return events;
}

/** A board with nothing on it but one far-away bug (so clearing never wins the level). */
function bare(s: GameState) {
  s.board = emptyBoard();
  s.board[idx(0, 8)] = { t: 'bug', c: 2 };
  s.bugsLeft = 1;
}

describe('versus is opt-in', () => {
  it('a game without versus has no versus state and ignores attacks', () => {
    const s = createGame({ ...cfg, versus: undefined });
    expect(s.versus).toBeUndefined();
    expect(receiveAttack(s, { n: 3, r: 40 })).toEqual([]);
    expect(serialize(s)).not.toContain('versus');
  });
});

describe('attacks arriving', () => {
  it('at most 4 halves wait; the rest are thrown away', () => {
    const s = createGame(cfg);
    expect(receiveAttack(s, { n: 3, r: 40 })).toEqual([{ type: 'incoming', waiting: 3, dropped: 0 }]);
    expect(receiveAttack(s, { n: 3, r: 40 })).toEqual([{ type: 'incoming', waiting: MAX_WAITING, dropped: 2 }]);
    expect(s.versus!.received).toHaveLength(2);
  });

  it('they drop after the piece lands, outside the entry columns, slowly, and the next piece waits', () => {
    const s = createGame(cfg);
    bare(s);
    receiveAttack(s, { n: 3, r: 50 });
    const before = s.piecesSpawned;
    const events: GameEvent[] = [];
    while (!events.some(e => e.type === 'garbage')) events.push(...step(s, ['softOn']));
    const g = events.find(e => e.type === 'garbage') as Extract<GameEvent, { type: 'garbage' }>;
    expect(g.cells).toHaveLength(3);
    for (const cell of g.cells) {
      expect(cell).toBeLessThan(W); // the top row
      expect(ENTRY_COLUMNS).not.toContain(cell % W);
    }
    expect(s.piecesSpawned).toBe(before); // no new piece yet
    expect(s.phase).toBe('settling');
    // They fall one row every 50 ticks: about 15 rows takes about 750 ticks before the next piece.
    const t0 = s.tick;
    const rest = untilSpawn(s);
    expect(rest.filter(e => e.type === 'fall').length).toBeGreaterThan(10);
    expect(s.tick - t0).toBeGreaterThan(50 * 10);
  });

  it('the entry columns are used last', () => {
    const s = createGame(cfg);
    bare(s);
    // Every other column is blocked at the top (bugs, alternating colors, so nothing pops).
    for (let x = 0; x < W; x++) if (!ENTRY_COLUMNS.includes(x)) s.board[idx(x, 0)] = { t: 'bug', c: x % 2 };
    s.bugsLeft += W - ENTRY_COLUMNS.length;
    receiveAttack(s, { n: 2, r: 30 });
    const events: GameEvent[] = [];
    while (!events.some(e => e.type === 'garbage' || e.type === 'lost')) events.push(...step(s, ['softOn']));
    const g = events.find(e => e.type === 'garbage') as Extract<GameEvent, { type: 'garbage' }>;
    expect(g.cells.map(c => c % W).sort()).toEqual([...ENTRY_COLUMNS]);
  });

  it('no room at the top for every half tops you out', () => {
    const s = createGame(cfg);
    bare(s);
    for (let x = 0; x < W; x++) if (x !== 0) s.board[idx(x, 0)] = { t: 'bug', c: x % 2 };
    s.bugsLeft += W - 1;
    receiveAttack(s, { n: 2, r: 30 });
    const events: GameEvent[] = [];
    while (s.phase !== 'lost' && s.phase !== 'won' && events.length < 100000) events.push(...step(s, ['softOn']));
    expect(s.phase).toBe('lost');
  });
});

describe('attacks going out', () => {
  it('a piece that makes two lines at once sends 2 halves at half its speed', () => {
    const s = createGame(cfg);
    bare(s);
    for (const x of [0, 1, 2]) s.board[idx(x, 15)] = { t: 'bug', c: 0 };
    for (const x of [5, 6, 7]) s.board[idx(x, 15)] = { t: 'bug', c: 1 };
    s.bugsLeft += 6;
    s.piece = { x: 3, y: 0, rot: 0, a: 0, b: 1 };
    const events = untilSpawn(s);
    const attack = events.find(e => e.type === 'attack') as Extract<GameEvent, { type: 'attack' }>;
    expect(attack.attack.n).toBe(2);
    expect(attack.attack.r).toBe(attackRate(s));
    expect(attackRate(s)).toBe(Math.round(2 * gravityInterval(s)));
  });

  it('one line sends nothing', () => {
    const s = createGame(cfg);
    bare(s);
    for (const x of [0, 1, 2]) s.board[idx(x, 15)] = { t: 'bug', c: 0 };
    s.bugsLeft += 3;
    s.piece = { x: 3, y: 0, rot: 0, a: 0, b: 1 };
    expect(untilSpawn(s).some(e => e.type === 'attack')).toBe(false);
  });
});

describe('replay and saves', () => {
  it('a board that took attacks replays exactly from its moves and arrivals', () => {
    const s = createGame(cfg);
    const bot = new Bot(BOT_SKILLS.hard, 99);
    for (let t = 0; t < 4000 && s.phase !== 'won' && s.phase !== 'lost'; t++) {
      if (t === 300 || t === 1500) receiveAttack(s, { n: t === 300 ? 2 : 4, r: 35 });
      step(s, bot.act(s));
    }
    const again = replay(cfg, s.log, s.tick, undefined, s.versus!.received);
    expect(again.board).toEqual(s.board);
    expect(again.score).toBe(s.score);
    expect(deserialize(serialize(s)).versus).toEqual(s.versus);
  });
});

describe('the bot', () => {
  it('finds spots for the piece, best first', () => {
    const s = createGame(cfg);
    const all = plans(s);
    expect(all.length).toBeGreaterThan(10);
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.score).toBeGreaterThanOrEqual(all[i]!.score);
  });

  it('clears an easy level on its own', () => {
    const c = { seed: 5, level: 1, speed: 1 as const, colors: 3 };
    let wins = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const s = createGame({ ...c, seed });
      const bot = new Bot(BOT_SKILLS.hard, seed * 31);
      for (let t = 0; t < 60 * 60 * 10 && s.phase !== 'won' && s.phase !== 'lost'; t++) step(s, bot.act(s));
      if (s.phase === 'won') wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(3);
  });

  it('plays differently with a different seed (not deterministic between games)', () => {
    const play = (botSeed: number) => {
      const s = createGame({ ...cfg, versus: undefined });
      const bot = new Bot(BOT_SKILLS.medium, botSeed);
      for (let t = 0; t < 3000 && s.phase !== 'won' && s.phase !== 'lost'; t++) step(s, bot.act(s));
      return s.log.join(',');
    };
    expect(play(1)).not.toBe(play(2));
  });

  it('a stand-in bot never holds down', () => {
    const s = createGame(cfg);
    const bot = new Bot({ ...BOT_SKILLS.hard, drop: false }, 3);
    const sent: Action[] = [];
    for (let t = 0; t < 3000 && s.phase !== 'lost' && s.phase !== 'won'; t++) { const a = bot.act(s); sent.push(...a); step(s, a); }
    expect(sent).not.toContain('softOn');
  });
});
