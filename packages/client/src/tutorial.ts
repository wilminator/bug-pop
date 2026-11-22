// The guided first level: a tiny scripted board and a coach banner that walks a new
// player through moving, turning, dropping and popping, one step at a time.
//
// It runs the real engine, so what it teaches is always how the game really plays.
// The board and the pieces are scripted instead of random, and the coach holds the
// first piece still (gravity off) until the player has tried moving and turning it.
// The tutorial game is never saved: main.ts keeps it apart from the single-player save.

import { createGame, idx, SLO_MO, type GameEvent, type GameState } from '@bug-pop/engine';
import { diagram } from './render';
import type { Skin, SpriteImages } from './skin';

export type Device = 'touch' | 'keyboard' | 'mouse' | 'gamepad';
type StepId = 'move' | 'turn' | 'drop' | 'pop' | 'next' | 'finish';

const SEEN_KEY = 'bugpop.tutorial.v1';
/** Has this device been offered the tutorial (or played it)? Then Single player won't offer it again. */
export function tutorialSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) !== null; } catch { return true; } // no storage: don't nag every time
}
export function markTutorialSeen() {
  try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* private mode */ }
}

// Colors used: 1 (blue) and 2 (yellow). Three blue bugs stand in a column on the left,
// two yellow bugs on the right.
const BLUE = 1, YELLOW = 2;
const BUGS: [x: number, y: number, c: number][] = [
  [1, 13, BLUE], [1, 14, BLUE], [1, 15, BLUE],
  [6, 14, YELLOW], [6, 15, YELLOW],
];
// The first piece is for practice. Then a blue pair for the first pop, then pieces that
// help finish: a yellow pair stood upright clears the yellow bugs.
const FIRST = { a: YELLOW, b: BLUE };
const FEED = [{ a: BLUE, b: BLUE }, { a: YELLOW, b: YELLOW }, { a: BLUE, b: YELLOW }, { a: YELLOW, b: YELLOW }, { a: BLUE, b: BLUE }];

/** A fresh tutorial game: level 0 at Slo-mo (one row a second, as at level 1), with the scripted board. */
export function createTutorialGame(): GameState {
  // 4 colors so Slo-mo is allowed; only blue and yellow ever appear.
  const s = createGame({ seed: 1, level: 0, speed: SLO_MO, colors: 4 });
  s.board.fill(null);
  for (const [x, y, c] of BUGS) s.board[idx(x, y)] = { t: 'bug', c };
  s.bugsLeft = BUGS.length;
  s.piece = { ...s.piece!, a: FIRST.a, b: FIRST.b };
  s.next = { ...FEED[0]! };
  return s;
}

/** The words for each step, per device. `{half}` and `{bug}` become little pictures. */
const WORDS: Record<StepId, { title: string; text: string | Record<Device, string> }> = {
  move: {
    title: 'Move the piece',
    text: {
      touch: 'Tap ◀ or ▶, or drag sideways on the board.',
      keyboard: 'Press ← or →.',
      mouse: 'Move the mouse left and right. The piece follows it.',
      gamepad: 'Push the d-pad or stick left and right.',
    },
  },
  turn: {
    title: 'Turn it',
    text: {
      touch: 'Tap ⟳, or tap the board. Turn it a few times.',
      keyboard: 'Press ↑ or X to turn right, Z to turn left.',
      mouse: 'Click, or roll the wheel.',
      gamepad: 'Press A to turn right, B to turn left.',
    },
  },
  drop: {
    title: 'Let it fall',
    text: {
      touch: 'It falls on its own. Hold ▼, or drag down, to drop it faster.',
      keyboard: 'It falls on its own. Hold ↓ to drop it faster.',
      mouse: 'It falls on its own. Hold the right button to drop it faster.',
      gamepad: 'It falls on its own. Hold down to drop it faster.',
    },
  },
  pop: {
    title: 'Pop some bugs',
    text: 'Four of one color in a line pop. Land a {half} on the three {bug} bugs.',
  },
  next: {
    // Mike, 2026-11-21: easy to miss when you're focused on the board.
    title: 'Look ahead',
    text: 'The glowing NEXT box shows the piece that drops after this one. Plan where it will go.',
  },
  finish: {
    title: 'Clear the board',
    text: 'Pop the last bugs to win. Lines work up and down too: try standing a piece upright.',
  },
};
const ORDER: StepId[] = ['move', 'turn', 'drop', 'pop', 'next', 'finish'];

/**
 * Follows the game's events and moves through the steps. Steps can be finished early:
 * a player who pops bugs during "Let it fall" goes straight on.
 */
export class Coach {
  private i = 0;
  private moves = 0;
  private fed = 1; // FEED[0] is already waiting as the next piece
  constructor(private el: HTMLElement, private skin: Skin, private images: SpriteImages | null, private shapes: boolean) {}

  get step(): StepId { return ORDER[this.i]!; }
  /** While true, main.ts holds the piece still so the player can practise without it falling. */
  get frozen(): boolean { return this.step === 'move' || this.step === 'turn'; }

  private next() {
    if (this.i < ORDER.length - 1) this.i++;
  }

  /** Feed the scripted pieces and advance the steps. */
  onEvents(events: GameEvent[], s: GameState) {
    for (const e of events) {
      if (e.type === 'spawn') s.next = { ...FEED[this.fed++ % FEED.length]! };
      if (this.step === 'move' && e.type === 'move' && ++this.moves >= 2) this.next();
      else if (this.step === 'turn' && e.type === 'rotate') this.next();
      else if (this.step === 'drop' && e.type === 'lock') this.next();
      else if (this.step === 'pop' && e.type === 'cleared' && e.bugs > 0) this.next();
      else if (this.step === 'next' && e.type === 'lock') this.next(); // one piece landed while watching Next
      else if ((this.step === 'move' || this.step === 'turn') && e.type === 'lock') this.i = ORDER.indexOf('pop'); // dropped before trying everything
    }
  }

  /** Draw the banner for the current step. */
  show(device: Device) {
    const w = WORDS[this.step];
    const title = document.createElement('p');
    title.className = 'coach-title';
    title.textContent = `${this.i + 1} of ${ORDER.length}: ${w.title}`;
    const text = document.createElement('p');
    text.className = 'coach-text';
    // Swap {half} and {bug} for little pictures in the skin's art.
    for (const part of (typeof w.text === 'string' ? w.text : w.text[device]).split(/(\{half\}|\{bug\})/)) {
      if (part === '{half}') text.append(diagram(['h1'], this.skin, this.images, this.shapes, 20));
      else if (part === '{bug}') text.append(diagram(['b1'], this.skin, this.images, this.shapes, 20));
      else text.append(part);
    }
    this.el.querySelector('.coach-body')!.replaceChildren(title, text);
  }
}
