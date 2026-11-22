import { describe, expect, it } from 'vitest';
import { InputManager, REPEAT_DELAY, TOUCH_REPEAT_DELAY } from '../src/input';
import { createGame } from '@bug-pop/engine';

// A fake on-screen button: just enough of an element for attachTouchButtons.
function fakeBar(what: string) {
  const btn = new EventTarget() as EventTarget & { dataset: Record<string, string>; setPointerCapture(): void };
  btn.dataset = { input: what };
  btn.setPointerCapture = () => {};
  const root = { querySelectorAll: () => [btn] } as unknown as HTMLElement;
  const ev = (type: string) => Object.assign(new Event(type), { pointerId: 1, pointerType: 'touch' });
  return { root, down: () => btn.dispatchEvent(ev('pointerdown')), up: () => btn.dispatchEvent(ev('pointerup')) };
}

/** Hold a button for `ticks` game ticks and count how many moves come out. */
function movesForHold(ticks: number) {
  const input = new InputManager(new EventTarget() as unknown as Window);
  const bar = fakeBar('left');
  input.attachTouchButtons(bar.root);
  const state = createGame({ seed: 1 });
  let moves = 0;
  bar.down();
  for (let t = 0; t < ticks; t++) moves += input.poll(state).actions.filter(a => a === 'left').length;
  bar.up();
  for (let t = 0; t < 5; t++) moves += input.poll(state).actions.filter(a => a === 'left').length;
  return moves;
}

describe('on-screen buttons (Jeanne: one tap moved the piece twice)', () => {
  it('a slow tap (a quarter second) moves the piece once', () => {
    expect(REPEAT_DELAY).toBeLessThan(15); // the keyboard delay alone would have moved twice
    expect(movesForHold(15)).toBe(1);
  });
  it('holding the button still repeats after the touch delay', () => {
    expect(movesForHold(TOUCH_REPEAT_DELAY + 1)).toBe(2);
    expect(movesForHold(TOUCH_REPEAT_DELAY + 7)).toBe(4);
  });
});
