import { describe, expect, it } from 'vitest';
import { createGame } from '@bug-pop/engine';
import { deviceName, makeRecord, newest, recordState, timeAgo, type SaveRecord } from '../src/cloud';

const rec = (savedAt: number, device = 'Mac'): SaveRecord => ({ state: '{}', savedAt, device });

describe('cloud save helpers', () => {
  it('picks the most recent save, tolerating missing ones', () => {
    expect(newest(null, null)).toBeNull();
    expect(newest(rec(5), null)?.savedAt).toBe(5);
    expect(newest(null, rec(7))?.savedAt).toBe(7);
    expect(newest(rec(5, 'a'), rec(9, 'b'))?.device).toBe('b');
    expect(newest(rec(9, 'a'), rec(5, 'b'))?.device).toBe('a');
    expect(newest(rec(5, 'a'), rec(5, 'b'))?.device).toBe('a'); // a tie keeps this device's copy
  });

  it('round-trips a game through a record and rejects damaged ones', () => {
    const g = createGame({ seed: 42, level: 3, speed: 1, colors: 3 });
    const back = recordState(makeRecord(g, 1000));
    expect(back?.config.level).toBe(3);
    expect(back?.board).toEqual(g.board);
    expect(recordState(rec(1))).toBeNull();
  });

  it('names devices by platform family only', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(deviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari')).toBe('Android phone');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows PC');
  });

  it('says how long ago in plain words', () => {
    const now = 10_000_000_000;
    expect(timeAgo(now - 5_000, now)).toBe('just now');
    expect(timeAgo(now - 60_000, now)).toBe('1 minute ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(timeAgo(now - 26 * 3_600_000, now)).toBe('yesterday');
  });
});
