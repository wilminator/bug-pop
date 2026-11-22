import { describe, expect, it } from 'vitest';
import { inWindow, lookChoices, seasonKey } from '../src/skin';

const winter = { from: '12-01', to: '02-29' }, spring = { from: '03-01', to: '05-31' };
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);

describe('season windows', () => {
  it('handles a window inside one year', () => {
    expect(inWindow(spring, day(2027, 3, 1))).toBe(true);
    expect(inWindow(spring, day(2027, 5, 31))).toBe(true);
    expect(inWindow(spring, day(2027, 6, 1))).toBe(false);
  });
  it('handles a window that wraps the new year, leap day or not', () => {
    expect(inWindow(winter, day(2026, 11, 30))).toBe(false);
    expect(inWindow(winter, day(2026, 12, 1))).toBe(true);
    expect(inWindow(winter, day(2027, 1, 15))).toBe(true);
    expect(inWindow(winter, day(2027, 2, 28))).toBe(true);
    expect(inWindow(winter, day(2028, 2, 29))).toBe(true);
    expect(inWindow(winter, day(2027, 3, 1))).toBe(false);
  });
  it('names one winter by the year it starts, so the note shows once per winter', () => {
    expect(seasonKey(winter, day(2026, 12, 5))).toBe('12-01@2026');
    expect(seasonKey(winter, day(2027, 2, 10))).toBe('12-01@2026');
    expect(seasonKey(winter, day(2027, 12, 5))).toBe('12-01@2027');
    expect(seasonKey(winter, day(2027, 6, 1))).toBe('');
  });
});

describe('look choices', () => {
  const looks = [
    { id: 'winter', name: 'Snowy', skin: 'a.json', season: winter },
    { id: 'spring', name: 'Spring', skin: 'b.json', season: spring },
    { id: 'always', name: 'Always', skin: 'c.json' },
    { id: 'test', name: 'Sneaky', skin: 'd.json' },
  ];
  it('lists only looks in season, never reusing the built-in ids', () => {
    expect(lookChoices(looks, day(2026, 12, 25)).map(l => l.id)).toEqual(['winter', 'always']);
    expect(lookChoices(looks, day(2027, 4, 1)).map(l => l.id)).toEqual(['spring', 'always']);
    expect(lookChoices(undefined)).toEqual([]);
  });
  it('lists every look on a testing site, whatever the date', () => {
    expect(lookChoices(looks, day(2026, 12, 25), true).map(l => l.id)).toEqual(['winter', 'spring', 'always']);
  });
});
