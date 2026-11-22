// Power-ups (Freeze, Bomb, Drill): opt-in, so every vanilla rule must stay exactly as it was.
import { describe, expect, it } from 'vitest';
import {
  createGame, step, findMatches, replay, serialize, deserialize, idx, emptyBoard, METER_FULL, FREEZE_TICKS, SAVE_VERSION,
  BOARD_WIDTH as W, BOARD_HEIGHT as H, type GameState, type GameEvent, type Action, type PowerKind,
} from '../src';

const cfg = { seed: 4242, level: 5, speed: 1 as const, colors: 3, powerUps: true };

/** A save made by the build before power-ups (format 2), mid-game. */
const V2_SAVE = 'z2:7VOxTsMwFGx2RkamJ0YPSVphajEhxm50KwxO4rQRrh3ZSSkK3fiAfDLnqEiAoKhiQmJ5Uu7euzsruo42JFJGuTVltSTRkVeqIME5Z6TVRmkSY0a+HtAkLGrrPMAdI2dwkcQxn8Z8nE4ZNVX+QGISx4wyKx0uFqbVmv2PPzw6akhQ1i4Jf59EvDvIfUKS99tfnaQH5D5wx0b7dust0o9Jjxn3jOqV9AqKpdS6QjOAVCoH0tEW2Rg9wQRdcha+aJIcipcNscmoLdAugKAA4u3kbQkQel4xKpyt59VaOWxccA6hwXAPQT7XSrpgLBYhTfD2t7V8NPvm4qV+poLiJaRz6xANZ0H3GtTwsW51CBfUVrIyIdto1Ec3s5fopI8md81ZH53rgvXR6fP8qo9+Tb0C';

function run(s: GameState, ticks: number, actions: (t: number) => Action[] = () => []) {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks && s.phase !== 'won' && s.phase !== 'lost'; i++) events.push(...step(s, actions(s.tick)));
  return events;
}

/** Run (holding down) until a new piece comes in; returns everything that happened. */
function untilSpawn(s: GameState): GameEvent[] {
  const events: GameEvent[] = [];
  while (!events.some(e => e.type === 'spawn' || e.type === 'lost')) events.push(...run(s, 1, () => ['softOn']));
  return events;
}

/** Use the held power-up now; it drops as the next piece. Returns the piece that was next. */
function useNow(s: GameState) {
  const next = { ...s.next };
  run(s, 1, () => ['power']);
  untilSpawn(s);
  run(s, 1, () => ['softOff']);
  return next;
}

/** Run until the falling piece is ready to be steered. */
function untilFalling(s: GameState) {
  run(s, 1);
  while (s.phase !== 'falling' && s.phase !== 'won' && s.phase !== 'lost') step(s);
}

/**
 * A board with three color-0 bugs stacked in column 0 and one spare bug far away (so the level
 * doesn't end), and a standing piece above column 0 whose bottom half is color 0: it lands and pops 3 bugs.
 */
function setUpPop(s: GameState) {
  s.board = emptyBoard();
  for (const y of [H - 1, H - 2, H - 3]) s.board[idx(0, y)] = { t: 'bug', c: 0 };
  s.board[idx(W - 1, H - 1)] = { t: 'bug', c: 1 };
  s.bugsLeft = 4;
  s.phase = 'falling';
  s.piece = { x: 0, y: 2, rot: 1, a: 0, b: 2 };
  s.soft = true;
}

describe('power-ups switched off', () => {
  it('leaves no trace in a vanilla game', () => {
    const s = createGame({ ...cfg, powerUps: false });
    expect(s.power).toBeUndefined();
    expect(s.config.powerUps).toBeUndefined();
    const before = serialize(s);
    run(s, 5, () => ['power']); // the button does nothing, and isn't even recorded
    expect(s.power).toBeUndefined();
    expect(s.log).toEqual([]);
    expect(serialize(createGame({ ...cfg, powerUps: false }))).toBe(before);
  });

  it('loads a save from before the update as a game with power-ups off', () => {
    const s = deserialize(V2_SAVE);
    expect(s.v).toBe(SAVE_VERSION);
    expect(s.power).toBeUndefined();
    expect(s.config.powerUps).toBeUndefined();
    expect(s.tick).toBe(400);
    run(s, 600); // and it plays on
    expect(s.tick).toBeGreaterThan(400);
  });
});

describe('earning', () => {
  it('fills the meter by one per popped bug', () => {
    const s = createGame(cfg);
    setUpPop(s);
    run(s, 200);
    expect(s.bugsLeft).toBe(1);
    expect(s.power!.meter).toBe(3);
    expect(s.power!.held).toBeNull();
  });

  it('gives a power-up when the meter fills, and waits while one is held', () => {
    const s = createGame(cfg);
    setUpPop(s);
    s.power!.meter = METER_FULL - 1;
    const got = run(s, 200).filter(e => e.type === 'powerGot');
    expect(got).toHaveLength(1);
    expect(s.power!.held).not.toBeNull();
    expect(s.power!.meter).toBe(METER_FULL);
    const held = s.power!.held;
    setUpPop(s);
    run(s, 200);
    expect(s.power!.held).toBe(held); // still the same one: nothing more until it is used
  });

  it('never gives the same kind three times running', () => {
    const s = createGame(cfg);
    const kinds: PowerKind[] = [];
    for (let n = 0; n < 60; n++) {
      setUpPop(s);
      s.power!.meter = METER_FULL - 1;
      s.power!.held = null;
      run(s, 200);
      kinds.push(s.power!.held!);
    }
    expect(new Set(kinds).size).toBe(3);
    for (let i = 2; i < kinds.length; i++) expect(kinds[i] === kinds[i - 1] && kinds[i] === kinds[i - 2]).toBe(false);
  });

  it('carries progress into the next level through the config', () => {
    const s = createGame({ ...cfg, startPower: { meter: 5, held: 'bomb' } });
    expect(s.power).toMatchObject({ meter: 5, held: 'bomb' });
  });
});

describe('using', () => {
  it('Freeze holds the piece still for 8 seconds, but holding down still drops it', () => {
    const s = createGame({ ...cfg, startPower: { meter: METER_FULL, held: 'freeze' } });
    untilFalling(s);
    const y = s.piece!.y;
    const used = run(s, 1, () => ['power']);
    expect(used).toContainEqual({ type: 'powerUse', kind: 'freeze' });
    expect(s.power!.meter).toBe(0);
    run(s, FREEZE_TICKS - 10);
    expect(s.piece!.y).toBe(y);
    const thaw = run(s, 60);
    expect(thaw).toContainEqual({ type: 'thaw' });
    expect(s.piece!.y).toBeGreaterThan(y);

    const t = createGame({ ...cfg, startPower: { meter: METER_FULL, held: 'freeze' } });
    untilFalling(t);
    run(t, 1, () => ['power', 'softOn']);
    const y2 = t.piece!.y;
    run(t, 60);
    expect(t.piece!.y).toBeGreaterThan(y2);
  });

  it('a used power-up drops as the next piece, and the piece that was next comes right after it', () => {
    const s = createGame({ ...cfg, startPower: { meter: METER_FULL, held: 'bomb' } });
    untilFalling(s);
    const current = { ...s.piece! };
    const used = run(s, 1, () => ['power']);
    expect(used).toContainEqual({ type: 'powerUse', kind: 'bomb' });
    expect(s.piece).toMatchObject({ a: current.a, b: current.b }); // the falling piece is not touched
    expect(s.power).toMatchObject({ held: null, queued: 'bomb', meter: 0 });
    const next = { ...s.next };
    run(s, 1, () => ['power']); // nothing more to use
    untilSpawn(s);
    expect(s.piece!.k).toBe('bomb');
    expect(s.next).toEqual(next); // pushed back one turn, not lost
    untilSpawn(s);
    expect(s.piece).toMatchObject({ a: next.a, b: next.b });
    expect(s.piece!.k).toBeUndefined();
  });

  it('Bomb clears a 3x3 square around what it lands on, at half points', () => {
    const s = createGame({ ...cfg, startPower: { meter: METER_FULL, held: 'bomb' } });
    untilFalling(s);
    useNow(s);
    expect(s.piece!.k).toBe('bomb');
    s.board = emptyBoard();
    for (let x = 2; x <= 5; x++) for (let y = H - 3; y < H; y++) s.board[idx(x, y)] = { t: 'bug', c: (x + y) % 3 };
    s.bugsLeft = 12;
    s.mult = 10;
    s.score = 0;
    const events = untilSpawn(s);
    // It lands on column 3's top bug: the square around that bug takes rows H-3 and H-2 of columns 2 to 4.
    expect(events.find(e => e.type === 'blast')).toMatchObject({ kind: 'bomb', bugs: 6 });
    // 6 bugs at 50 x running multiplier (x1.0, +0.1 each) x medium speed (x2): (50+55+60+65+70+75) x 2
    expect(s.score).toBe(750);
    expect(s.bugsLeft).toBe(6);
  });

  it('Drill clears the 3 cells under where it lands', () => {
    const s = createGame({ ...cfg, startPower: { meter: METER_FULL, held: 'drill' } });
    untilFalling(s);
    useNow(s);
    expect(s.piece!.k).toBe('drill');
    s.board = emptyBoard();
    const x = s.piece!.x;
    for (let y = H - 5; y < H; y++) s.board[idx(x, y)] = { t: 'bug', c: y % 3 };
    s.board[idx(0, H - 1)] = { t: 'bug', c: 0 };
    s.bugsLeft = 6;
    while (!run(s, 1, () => ['softOn']).some(e => e.type === 'blast')) { /* drop the drill */ }
    run(s, 25); // the flash, then the clear
    expect(s.board[idx(x, H - 5)]).toBeNull();
    expect(s.board[idx(x, H - 3)]).toBeNull();
    expect(s.board[idx(x, H - 2)]).not.toBeNull();
    expect(s.bugsLeft).toBe(3);
  });

  it('Wildcard turns the falling piece wild, and a wild half completes a line of any color', () => {
    const s = createGame({ ...cfg, startPower: { meter: METER_FULL, held: 'wild' } });
    untilFalling(s);
    useNow(s);
    expect(s.piece!.w).toBe(true);
    // Column 0 holds three bugs of color 1 and column 1 three of color 2; a flat wild piece on top pops both.
    s.board = emptyBoard();
    for (const y of [H - 1, H - 2, H - 3]) { s.board[idx(0, y)] = { t: 'bug', c: 1 }; s.board[idx(1, y)] = { t: 'bug', c: 2 }; }
    s.board[idx(W - 1, H - 1)] = { t: 'bug', c: 0 };
    s.bugsLeft = 7;
    s.piece = { ...s.piece!, x: 0, y: 2, rot: 0 };
    const events: GameEvent[] = [];
    while (!events.some(e => e.type === 'cleared')) events.push(...run(s, 1, () => ['softOn']));
    expect(events.find(e => e.type === 'match')).toMatchObject({ bugs: 6 });
    expect(s.bugsLeft).toBe(1);
  });

  it('a wild half can sit in two different colors\' lines at once', () => {
    const b = emptyBoard();
    b[idx(3, 10)] = { t: 'half', c: 0, l: null, w: true };
    for (const x of [0, 1, 2]) b[idx(x, 10)] = { t: 'bug', c: 1 }; // row: three 1s then the wild
    for (const y of [11, 12, 13]) b[idx(3, y)] = { t: 'bug', c: 2 }; // column: the wild then three 2s
    expect(findMatches(b).length).toBe(7);
    // but a wild next to two different colors in one line is not a line of four
    const c = emptyBoard();
    c[idx(2, 10)] = { t: 'half', c: 0, l: null, w: true };
    c[idx(0, 10)] = { t: 'bug', c: 1 }; c[idx(1, 10)] = { t: 'bug', c: 1 }; c[idx(3, 10)] = { t: 'bug', c: 2 };
    expect(findMatches(c)).toEqual([]);
  });

  it('a game that uses power-ups replays exactly', () => {
    const s = createGame({ ...cfg, startPower: { meter: METER_FULL, held: 'bomb' } });
    const acts = (t: number): Action[] => t === 40 ? ['power'] : t % 11 === 0 ? ['left'] : t % 17 === 0 ? ['rotCW'] : t % 5 === 0 ? ['softOn'] : [];
    run(s, 3000, acts);
    expect(s.log.some(c => c % 8 === 6)).toBe(true); // 'power' is in the move log
    const r = replay(s.config, s.log, s.tick);
    expect(serialize(r)).toBe(serialize(s));
    expect(serialize(deserialize(serialize(s)))).toBe(serialize(s));
  });
});
