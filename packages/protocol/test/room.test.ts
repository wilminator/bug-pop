import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, RoomSession, parseClient, parseRoomClient, parseRoomServer, type RoomClientMsg, type RoomState } from '../src';

const state: RoomState = {
  t: 'rstate', code: 'ABCD', owner: 'p1', rules: DEFAULT_RULES,
  people: [{ pid: 'p1', name: 'Mike', mine: true, watch: false, here: true, game: 1 }, { pid: 'p2', name: 'Jeanne', mine: false, watch: false, here: true, game: 1 }],
  games: [{ g: 1, seats: [{ name: 'Mike', pid: 'p1' }, { name: 'Jeanne', pid: 'p2' }, { name: 'Computer', cpu: 'medium' }], round: 1, wins: [0, 0, 0], phase: 'lobby', tour: false }],
  tour: { kind: 'double', players: [{ pid: 'p1', name: 'Mike', wins: 1, losses: 0, out: false }], matches: [{ a: 'p1', b: 'p2', winner: 'p1', g: null, round: 1 }], champion: null },
};

describe('room messages', () => {
  it('room state survives the trip', () => {
    expect(parseRoomServer(JSON.stringify(state))).toEqual(state);
    expect(parseRoomServer(JSON.stringify({ ...state, code: 'abcd' }))).toBeNull();
    expect(parseRoomServer(JSON.stringify({ ...state, rules: { ...DEFAULT_RULES, target: 'me' } }))).toBeNull();
  });

  it('client room messages are checked', () => {
    expect(parseRoomClient(JSON.stringify({ t: 'rnew', by: 'p1', size: 4 }))).toEqual({ t: 'rnew', by: 'p1', size: 4 });
    expect(parseRoomClient(JSON.stringify({ t: 'rnew', by: 'p1', size: 5 }))).toBeNull();
    expect(parseRoomClient(JSON.stringify({ t: 'g', g: 1, m: { t: 'tin', s: 0, k: 3, a: [1] } }))).toEqual({ t: 'g', g: 1, m: { t: 'tin', s: 0, k: 3, a: [1] } });
    expect(parseRoomClient(JSON.stringify({ t: 'g', g: 1, m: { t: 'flag', why: 'x' } }))).toEqual({ t: 'g', g: 1, m: { t: 'flag', why: 'x' } });
    expect(parseRoomClient(JSON.stringify({ t: 'radd', name: '  ' }))).toBeNull();
    expect(parseClient(JSON.stringify({ t: 'hello', v: 5, level: 5, speed: 1, room: 'new', people: ['Jeanne'] }))).toMatchObject({ people: ['Jeanne'] });
    expect(parseClient(JSON.stringify({ t: 'hello', v: 5, level: 5, speed: 1, room: 'new', people: ['a', 'b', 'c', 'd'] }))).toBeNull();
  });

  it('a session builds its tables from the start, or catches up from the record', () => {
    const sent: RoomClientMsg[] = [];
    const room = new RoomSession(m => sent.push(m));
    room.receive(state);
    expect(room.isOwner).toBe(true);
    const start = { t: 'tstart' as const, table: 1, seed: 5, botSeed: 6, colors: 3, rule: 'race' as const, target: 'leader' as const, power: false, seats: [{ name: 'Mike', level: 3, speed: 1 as const }, { name: 'Jeanne', level: 3, speed: 1 as const }], mine: [0], runs: [], round: 1, wins: [0, 0] };
    room.receive(parseRoomServer(JSON.stringify(start)));
    for (let i = 0; i < 9; i++) room.tick();
    expect(sent.some(m => m.t === 'g' && m.m.t === 'tin')).toBe(true);
    const watcher = new RoomSession(() => undefined);
    const tins = sent.filter(m => m.t === 'g').map(m => (m as Extract<RoomClientMsg, { t: 'g' }>).m);
    watcher.receive(parseRoomServer(JSON.stringify({ t: 'gcatch', g: 1, start: { ...start, mine: [] }, steps: tins, claim: [] })));
    expect(watcher.tables.get(1)!.boards[0]!.state.tick).toBe(room.tables.get(1)!.boards[0]!.state.tick);
  });
});

describe('best of 5', () => {
  it('needs 3 round wins and is a valid room rule and tournament kind', async () => {
    const { winsNeeded, parseRules, DEFAULT_RULES } = await import('../src/messages');
    expect([winsNeeded('race'), winsNeeded('best3'), winsNeeded('best5'), winsNeeded('last')]).toEqual([1, 2, 3, 1]);
    expect(parseRules({ ...DEFAULT_RULES, rule: 'best5' })?.rule).toBe('best5');
    expect(parseRules({ ...DEFAULT_RULES, mode: 'tour', tour: 'best5' })?.tour).toBe('best5');
    expect(parseRules({ ...DEFAULT_RULES, rule: 'best7' })).toBeNull();
  });
});
