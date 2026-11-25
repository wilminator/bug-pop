// A fingerprint of how the engine plays: the same moves must always give the same boards. If this
// test fails, the engine now plays differently. Bump GAME_RULES in src/messages.ts and paste the new
// fingerprint below: a round saved before a server restart then gets played again from its start,
// because its saved moves would no longer give the same boards (Mike, 2026-11-22).
import { describe, expect, it } from 'vitest';
import { Bot, BOT_SKILLS } from '@bug-pop/engine';
import { GAME_RULES, TableMatch, type TableStart } from '../src';

function play(power: boolean, target: TableStart['target']) {
  const seats = [{ name: 'A', level: 8, speed: 1 as const }, { name: 'B', level: 8, speed: 2 as const, cpu: 'hard' as const }, { name: 'C', level: 8, speed: 0 as const, cpu: 'medium' as const }];
  const t = new TableMatch({ t: 'tstart', table: 1, seed: 777, botSeed: 31, colors: 4, rule: 'race', target, power, seats, round: 1, wins: [0, 0, 0], mine: [0], runs: [1, 2] }, () => undefined);
  const me = new Bot(BOT_SKILLS.hard, 5);
  for (let i = 0; i < 60 * 60 && !t.result; i++) t.tick(new Map([[0, me.act(t.boards[0]!.state)]]));
  return JSON.stringify([t.result, t.boards.map(b => [b.state.tick, b.state.score, b.state.board])]);
}

/** FNV-1a, 32 bits, as hex. */
const hash = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16); };

describe('game rules fingerprint', { timeout: 30_000 }, () => {
  it(`matches GAME_RULES ${GAME_RULES}`, () => {
    const h = hash(play(false, 'leader') + play(true, 'random'));
    expect(h, 'The engine plays differently now: bump GAME_RULES and update this fingerprint').toBe('792fd1bd');
  });
});
