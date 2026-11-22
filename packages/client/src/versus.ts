// Multiplayer on one device: two boards side by side, each played by a person or by the computer.
//
// Each board is an ordinary engine game with `versus: true`. Once per tick both boards step; when
// one sends an attack (two or more matches from one piece) it is handed to the other board with
// receiveAttack(), exactly as the online relay will do later. The engine never knows who is
// playing: a person's moves come from an InputManager, the computer's from a Bot, and both are
// the same actions.
//
// No pause in competitive play: Leave (or Esc, P, Start) opens a "Leave the match?" card while
// both games keep running behind it.

import {
  BOT_SKILLS, BOARD_WIDTH, Bot, TICKS_PER_SECOND, createGame, receiveAttack, step, waitingHalves,
  type BotLevel, type GameEvent, type GameState, type Speed,
} from '@bug-pop/engine';
import type { AudioManager } from './audio';
import { InputManager } from './input';
import { computeLayout, FLOAT_MS, LEAVE_MS, ARRIVE_MS, render, type Float, type Layout, type Leaver } from './render';
import { frameCells, type Skin, type SpriteImages } from './skin';
import type { Motion, Settings } from './storage';

export type Who = 'human-bot' | 'human-human' | 'bot-bot';
/** race: first to clear their bugs. best3: first to win 2 rounds. last: Endless, last one standing. */
export type WinRule = 'race' | 'best3' | 'last';
export type PlayerSetup = { level: number; speed: Speed; bot: BotLevel | null };
export type VersusSetup = { who: Who; rule: WinRule; colors: number; players: [PlayerSetup, PlayerSetup] };

export type VersusDeps = {
  skin: Skin;
  images: SpriteImages | null;
  audio: AudioManager;
  /** The on-screen touch buttons (shared with single player). */
  touchBar: HTMLElement;
  motion: () => Motion;
  settings: () => Settings;
  /** Main menu or the setup screen: the app shell takes over from here. */
  exit: (to: 'menu' | 'setup') => void;
  /** The dramatic pause before a result card, the same as single player's. */
  finishPauseMs: number;
};

const TICK_MS = 1000 / TICKS_PER_SECOND;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const RULE_TEXT: Record<WinRule, string> = { race: 'First to clear their bugs', best3: 'Best of 3', last: 'Last one standing' };
const SKILL_NAME: Record<BotLevel, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

/** A truly random 32-bit number (the bots and the shared piece order are new every game). */
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0]! | 0;

/** One board on screen: its game, who plays it, and its animations. */
type Side = {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  layout: Layout;
  input: InputManager;
  bot: Bot | null;
  name: string;
  state: GameState | null;
  wins: number;
  leavers: Leaver[];
  floats: Float[];
  matched: Leaver[];
  arrivals: Map<number, number>;
};

/** Read the setup screen's form. */
export function readSetup(): VersusSetup {
  const who = $<HTMLSelectElement>('vsWho').value as Who;
  const player = (i: 0 | 1): PlayerSetup => {
    const fs = $(`vsP${i}`);
    const level = Math.max(1, Math.min(100, Math.round(Number(fs.querySelector<HTMLInputElement>('.vs-level')!.value) || 1)));
    const speed = Number(fs.querySelector<HTMLSelectElement>('.vs-speed')!.value) as Speed;
    const isBot = who === 'bot-bot' || (who === 'human-bot' && i === 1);
    return { level, speed, bot: isBot ? (fs.querySelector<HTMLSelectElement>('.vs-skill')!.value as BotLevel) : null };
  };
  return { who, rule: $<HTMLSelectElement>('vsRule').value as WinRule, colors: Number($<HTMLSelectElement>('vsColors').value), players: [player(0), player(1)] };
}

/** Names for the two players, always saying which one is the computer. */
function names(setup: VersusSetup): [string, string] {
  const bot = (p: PlayerSetup, n = '') => `Computer${n} (${SKILL_NAME[p.bot!]})`;
  if (setup.who === 'human-bot') return ['You', bot(setup.players[1])];
  if (setup.who === 'bot-bot') return [bot(setup.players[0], ' 1'), bot(setup.players[1], ' 2')];
  return ['Player 1', 'Player 2'];
}

/** The setup screen: show the Computer skill picker only for computer players, and the controls hint. */
export function refreshSetupForm() {
  const who = $<HTMLSelectElement>('vsWho').value as Who;
  const legends: Record<Who, [string, string]> = { 'human-bot': ['You', 'Computer'], 'human-human': ['Player 1', 'Player 2'], 'bot-bot': ['Computer 1', 'Computer 2'] };
  for (const i of [0, 1] as const) {
    const fs = $(`vsP${i}`);
    fs.querySelector('legend')!.textContent = legends[who][i];
    fs.querySelector<HTMLElement>('.vs-skill-row')!.hidden = !(who === 'bot-bot' || (who === 'human-bot' && i === 1));
  }
  const pads = connectedPads().length;
  $('vsControls').textContent =
    who === 'human-bot' ? 'Play with any keyboard keys, mouse, touch or gamepad, as in single player.'
    : who === 'bot-bot' ? 'Sit back and watch. Every game is different: the computer has its own dice.'
    : pads >= 2 ? 'Player 1: keyboard, mouse or the first gamepad. Player 2: the second gamepad.'
    : pads === 1 ? 'Player 1: keyboard or mouse. Player 2: the gamepad.'
    : 'Player 1: W A S D to move and drop, Q or W to turn, on the left of the keyboard. Player 2: the arrow keys, with Up and / to turn. A gamepad also works for Player 2.';
}

/** Change an element's text only when it differs (this runs every frame). */
const setText = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text; };

const connectedPads = () => [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.connected).map(p => p.index);

export class Versus {
  private sides: [Side, Side];
  private setup: VersusSetup | null = null;
  private round = 1;
  /** 'playing', the pause after a round is decided, or the result card showing. */
  private phase: 'off' | 'playing' | 'ending' | 'card' = 'off';
  private leaveUp = false;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private stage = $('vsStage');
  private card = $('vsCard');

  constructor(private deps: VersusDeps) {
    const make = (i: 0 | 1): Side => {
      const el = $(`vsSide${i}`);
      const canvas = el.querySelector('canvas')!;
      const side: Side = {
        el, canvas, ctx: canvas.getContext('2d')!, layout: computeLayout(1, 1, 0), input: new InputManager(), bot: null,
        name: '', state: null, wins: 0, leavers: [], floats: [], matched: [], arrivals: new Map(),
      };
      new ResizeObserver(() => this.resize(side)).observe(canvas);
      // Each board takes swipes on itself, so two people on a tablet can each play their own half.
      side.input.attachSwipe(canvas, () => side.layout.cell);
      side.input.attachMouse(canvas, clientX => {
        const rect = canvas.getBoundingClientRect();
        const col = Math.floor((clientX - rect.left - side.layout.boardX) / side.layout.cell);
        return col >= -2 && col <= BOARD_WIDTH + 1 ? Math.max(0, Math.min(BOARD_WIDTH - 1, col)) : null;
      });
      side.input.accept = () => false;
      return side;
    };
    this.sides = [make(0), make(1)];
    $('vsLeave').addEventListener('click', () => { this.deps.audio.play('select'); this.openLeave(); });
    $('vsStay').addEventListener('click', () => { this.deps.audio.play('select'); this.closeLeave(); });
    $('vsNext').addEventListener('click', () => { this.deps.audio.play('select'); this.startRound(); });
    $('vsAgain').addEventListener('click', () => { this.deps.audio.play('select'); this.startMatch(this.setup!); });
    $('vsSetupBtn').addEventListener('click', () => { this.deps.audio.play('select'); this.stop(); this.deps.exit('setup'); });
    $('vsMenu').addEventListener('click', () => { this.deps.audio.play('select'); this.stop(); this.deps.exit('menu'); });
  }

  get active() { return this.phase !== 'off'; }

  private resize(side: Side) {
    const rect = side.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    side.canvas.width = Math.round(rect.width * devicePixelRatio);
    side.canvas.height = Math.round(rect.height * devicePixelRatio);
    side.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    side.layout = computeLayout(rect.width, rect.height, 0, frameCells(this.deps.skin));
  }

  /**
   * Who listens to what. One person: everything. Two people: split the keyboard in half, or give
   * the gamepads out (the first one to Player 1 when there are two of them).
   */
  private assignInputs(setup: VersusSetup) {
    const [a, b] = this.sides;
    const humans = setup.players.map(p => !p.bot);
    for (const s of this.sides) { s.input.accept = () => false; s.input.reset(); }
    for (const s of this.sides) s.input.attachTouchButtons(this.deps.touchBar);
    if (humans[0] && humans[1]) {
      const pads = connectedPads();
      if (pads.length >= 2) {
        a.input.accept = src => !src.startsWith('pad-') || src === `pad-${pads[0]}`;
        b.input.accept = src => src === `pad-${pads[1]}` || src === 'swipe';
      } else if (pads.length === 1) {
        a.input.accept = src => !src.startsWith('pad-');
        b.input.accept = src => src.startsWith('pad-') || src === 'swipe';
      } else {
        a.input.accept = src => src === 'kb-l' || src === 'mouse' || src === 'swipe' || src === 'touch';
        b.input.accept = src => src === 'kb-r' || src === 'swipe' || src.startsWith('pad-');
      }
    } else if (humans[0]) {
      a.input.accept = () => true;
    } else {
      // Bot against bot: nobody steers, but Esc, P or Start still opens the leave card.
      a.input.accept = () => true;
    }
  }

  /** Begin a new match with these players (round 1, no wins). */
  startMatch(setup: VersusSetup) {
    this.setup = setup;
    const [n0, n1] = names(setup);
    this.sides[0].name = n0;
    this.sides[1].name = n1;
    for (const s of this.sides) s.wins = 0;
    this.round = 1;
    this.stage.querySelector('.vs-boards')!.classList.toggle('one-human', setup.who === 'human-bot');
    this.assignInputs(setup);
    this.startRound();
  }

  private startRound() {
    const setup = this.setup!;
    // Both boards get the same pieces in the same order (a fair race); the bugs differ by level.
    const seed = randomSeed();
    this.sides.forEach((s, i) => {
      const p = setup.players[i]!;
      s.state = createGame({ seed, level: p.level, speed: p.speed, colors: setup.colors, versus: true, endless: setup.rule === 'last' || undefined });
      s.bot = p.bot ? new Bot(BOT_SKILLS[p.bot], randomSeed()) : null;
      s.leavers = []; s.floats = []; s.matched = []; s.arrivals = new Map();
      s.input.reset();
    });
    this.card.hidden = true;
    this.leaveUp = false;
    this.stage.hidden = false;
    this.phase = 'playing';
    this.setCapture(true);
    $('vsRuleText').textContent = setup.rule === 'best3' ? `${RULE_TEXT.best3}: round ${this.round}` : RULE_TEXT[setup.rule];
    this.sides.forEach(s => this.resize(s));
    this.deps.audio.startMusic(true);
    this.last = performance.now();
    this.acc = 0;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Leave versus for good (the app shell shows another screen). */
  stop() {
    this.phase = 'off';
    cancelAnimationFrame(this.raf);
    this.setCapture(false);
    for (const s of this.sides) { s.input.accept = () => false; s.input.reset(); s.state = null; }
    this.stage.hidden = true;
    this.card.hidden = true;
    this.deps.audio.stopMusic();
  }

  private setCapture(on: boolean) {
    this.sides.forEach((s, i) => { s.input.capture = on && !!this.setup && !this.setup.players[i]!.bot; });
  }

  // ---- The cards ----
  private showCard(title: string, text: string, buttons: ('vsNext' | 'vsAgain' | 'vsStay' | 'vsSetupBtn' | 'vsMenu')[]) {
    $('vsCardTitle').textContent = title;
    $('vsCardText').textContent = text;
    for (const id of ['vsNext', 'vsAgain', 'vsStay', 'vsSetupBtn', 'vsMenu'] as const) $(id).hidden = !buttons.includes(id);
    this.card.hidden = false;
    const first = buttons[0];
    if (first) $(first).focus({ preventScroll: true });
  }

  private openLeave() {
    if (this.phase !== 'playing' || this.leaveUp) return;
    this.leaveUp = true;
    this.setCapture(false); // the menu keys work on the card; the games keep running
    for (const s of this.sides) s.input.reset();
    this.showCard('Leave the match?', 'The match keeps going while this is up.', ['vsStay', 'vsSetupBtn', 'vsMenu']);
  }

  private closeLeave() {
    if (!this.leaveUp) return;
    this.leaveUp = false;
    this.card.hidden = true;
    if (this.phase === 'playing') this.setCapture(true);
  }

  // ---- Playing ----
  private frame = (now: number) => {
    if (this.phase === 'off') return;
    const dt = Math.min(now - this.last, 250);
    this.last = now;
    if (this.phase === 'playing') {
      this.acc += dt;
      while (this.acc >= TICK_MS && this.phase === 'playing') {
        this.tick();
        this.acc -= TICK_MS;
      }
    } else {
      // A card is up: still read the devices, so nothing piles up for the next round.
      for (const s of this.sides) s.input.poll(null);
    }
    this.draw(now);
    this.raf = requestAnimationFrame(this.frame);
  };

  private tick() {
    const [a, b] = this.sides;
    const events: [GameEvent[], GameEvent[]] = [[], []];
    this.sides.forEach((s, i) => {
      const st = s.state!;
      let actions = s.bot ? s.bot.act(st) : [];
      if (!s.bot || (i === 0 && this.setup!.who === 'bot-bot')) {
        const f = s.input.poll(this.leaveUp || s.bot ? null : st);
        if (f.pause) { if (this.leaveUp) this.closeLeave(); else this.openLeave(); }
        if (!s.bot) actions = this.leaveUp ? [] : f.actions;
      }
      events[i] = step(st, actions);
    });
    // Attacks cross over after both boards have stepped, so neither board gets a head start.
    events.forEach((evs, i) => {
      const other = this.sides[1 - i]!;
      for (const e of evs) if (e.type === 'attack') events[1 - i]!.push(...receiveAttack(other.state!, e.attack));
    });
    events.forEach((evs, i) => this.effects(this.sides[i]!, evs));
    // Who won the round? Clearing every bug wins; topping out loses. Both at once is a draw.
    const lost = [a.state!.phase === 'lost', b.state!.phase === 'lost'];
    const won = [a.state!.phase === 'won', b.state!.phase === 'won'];
    if (won[0] || won[1] || lost[0] || lost[1]) {
      const winner = won[0] && !won[1] ? 0 : won[1] && !won[0] ? 1 : lost[0] && !lost[1] ? 1 : lost[1] && !lost[0] ? 0 : null;
      this.endRound(winner);
    }
  }

  private endRound(winner: 0 | 1 | null) {
    const setup = this.setup!;
    this.phase = 'ending';
    this.setCapture(false);
    if (this.leaveUp) { this.leaveUp = false; this.card.hidden = true; }
    for (const s of this.sides) s.input.reset();
    if (winner !== null) this.sides[winner].wins++;
    this.deps.audio.stopMusic();
    // A person losing to the computer hears the losing tune; anything else is a win to celebrate.
    this.deps.audio.play(setup.who === 'human-bot' && winner === 1 ? 'lose' : 'win');
    const decided = setup.rule !== 'best3' || this.sides.some(s => s.wins >= 2);
    window.setTimeout(() => {
      if (this.phase !== 'ending') return;
      this.phase = 'card';
      const who = winner === null ? null : this.sides[winner].name;
      const title = who === null ? 'A draw' : who === 'You' ? 'You win' : `${who} wins`;
      const score = `${this.sides[0].name} ${this.sides[0].wins}, ${this.sides[1].name} ${this.sides[1].wins}.`;
      if (decided) this.showCard(setup.rule === 'best3' ? `${title} the match` : title, setup.rule === 'best3' ? score : winner === null ? 'Both boards filled at the same moment.' : 'Good game.', ['vsAgain', 'vsSetupBtn', 'vsMenu']);
      else {
        this.round++;
        this.showCard(winner === null ? `Round ${this.round - 1}: a draw` : `${title} round ${this.round - 1}`, score, ['vsNext', 'vsSetupBtn', 'vsMenu']);
      }
    }, this.deps.finishPauseMs);
  }

  /** Sounds and animations for one board. The computer's boards only make the bigger sounds. */
  private effects(side: Side, events: GameEvent[]) {
    const audio = this.deps.audio;
    const quiet = !!side.bot;
    const st = side.state!;
    const leaving = (cells: number[]) => {
      const now = performance.now();
      return cells.flatMap(i => {
        const cell = st.board[i];
        if (!cell) return [];
        return [{ kind: cell.t === 'bug' ? 'bug' as const : 'piece' as const, x: i % BOARD_WIDTH, y: Math.floor(i / BOARD_WIDTH), c: cell.c, t0: now, dir: (i % 2 ? 1 : -1) as 1 | -1 }];
      });
    };
    for (const e of events) {
      switch (e.type) {
        case 'move': if (!quiet) audio.play('move'); break;
        case 'rotate': if (!quiet) audio.play('rotate'); break;
        case 'lock': audio.play('lock'); break;
        case 'match': audio.play(e.chain > 1 ? 'chain' : 'pop', 1 + Math.min(e.chain - 1, 4) * 0.12); side.matched = leaving(e.cells); break;
        case 'cleared': {
          const now = performance.now();
          const popped = side.matched.filter(l => l.kind === 'bug');
          if (e.chainBonus >= 2 && popped.length) {
            const x = popped.reduce((s, l) => s + l.x, 0) / popped.length, y = popped.reduce((s, l) => s + l.y, 0) / popped.length;
            side.floats.push({ text: `×${e.chainBonus}`, x, y, t0: now, size: 0.7 + Math.log2(e.chainBonus) * 0.12 });
          }
          side.leavers.push(...side.matched.map(l => ({ ...l, t0: now })));
          side.matched = [];
          break;
        }
        case 'arrive': {
          const now = performance.now(), gap = Math.min(14, 500 / Math.max(1, e.cells.length));
          side.arrivals = new Map(e.cells.map((cell, k) => [cell, now + k * gap]));
          break;
        }
        // Halves sent to the opponent, and halves landing on top of this board.
        case 'attack': audio.play('chain', 1.4); side.floats.push({ text: `Sent ${e.attack.n}!`, x: 3, y: 6, t0: performance.now(), size: 0.6 }); break;
        case 'garbage': audio.play('fall', 0.7); break;
      }
    }
  }

  private draw(now: number) {
    const { skin, images, settings, motion } = this.deps;
    const set = settings();
    for (const s of this.sides) {
      if (s.leavers.length) s.leavers = s.leavers.filter(l => now - l.t0 < LEAVE_MS);
      if (s.floats.length) s.floats = s.floats.filter(f => now - f.t0 < FLOAT_MS);
      if (s.arrivals.size && [...s.arrivals.values()].every(t0 => now - t0 >= ARRIVE_MS)) s.arrivals = new Map();
      if (!s.state) continue;
      render(s.ctx, s.state, skin, s.layout, { shapesOnPieces: set.shapesOnPieces, motion: motion(), time: now, images, leavers: s.leavers, arrivals: s.arrivals, floats: s.floats, bugExit: set.exit || undefined });
      // The label over the board: name, progress, and halves on their way.
      const info = this.setup!.rule === 'last' ? `score ${s.state.score}` : s.state.bugsLeft === 1 ? '1 bug left' : `${s.state.bugsLeft} bugs left`;
      const wins = this.setup!.rule === 'best3' ? ` · ${'★'.repeat(s.wins)}${'☆'.repeat(2 - Math.min(2, s.wins))}` : '';
      setText(s.el.querySelector('.vs-name')!, s.name);
      setText(s.el.querySelector('.vs-info')!, info + wins);
      const coming = s.state.versus ? waitingHalves(s.state.versus) : 0;
      const inc = s.el.querySelector<HTMLElement>('.vs-incoming')!;
      inc.hidden = !coming;
      setText(inc, coming === 1 ? '1 half coming' : `${coming} halves coming`);
    }
  }
}
