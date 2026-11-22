// Multiplayer on one device: 2 boards side by side (3 and 4 later; the board code handles them), each played by a person or by the computer.
//
// Each board is an ordinary engine game with `versus: true`. Once per tick every board steps; when
// one sends an attack (two or more matches from one piece) it goes to an opponent with
// receiveAttack(), exactly as the online relay does. With 3 or 4 players a setting picks who gets
// it: the leader (fewest bugs left), someone at random, or everyone (Mike, 2026-11-22). The
// engine never knows who is playing: a person's moves come from an InputManager, the computer's
// from a Bot, and both are the same actions.
//
// Each player picks what controls their board (Mike, 2026-11-22): the computer, or one input
// device (keyboard and mouse, the left or right half of the keyboard, the mouse, touch, or a
// gamepad). Two people can't share one device.
//
// No pause in competitive play: Leave (or Esc, P, Start) opens a "Leave the match?" card while
// the games keep running behind it.

import {
  BOT_SKILLS, BOARD_WIDTH, Bot, TICKS_PER_SECOND, createGame, receiveAttack, step, waitingHalves,
  type BotLevel, type GameEvent, type GameState, type Speed,
} from '@bug-pop/engine';
import { OnlineMatch, PROTOCOL_VERSION, parseServer, type ClientMsg, type ServerMsg } from '@bug-pop/protocol';
import qrcode from 'qrcode-generator';
import type { AudioManager } from './audio';
import { InputManager } from './input';
import { computeLayout, FLOAT_MS, LEAVE_MS, ARRIVE_MS, render, type Float, type Layout, type Leaver } from './render';
import { frameCells, type Skin, type SpriteImages } from './skin';
import type { Motion, Settings } from './storage';

/** race: first to clear their bugs. best3: first to win 2 rounds. last: Endless, last one standing. */
export type WinRule = 'race' | 'best3' | 'last';
/** With 3 or 4 players, who an attack goes to. */
export type Target = 'leader' | 'random' | 'everyone';
/**
 * What plays a board: the computer ('cpu'), or one device. 'kb' is the whole keyboard and the
 * mouse; 'kb-l' / 'kb-r' are its halves; 'pad-N' is gamepad N (0-based). Online uses 'any' for
 * me and 'remote' for the other player.
 */
export type Control = 'cpu' | 'kb' | 'kb-l' | 'kb-r' | 'mouse' | 'touch' | `pad-${number}` | 'any' | 'remote';
export type PlayerSetup = { level: number; speed: Speed; control: Control; bot: BotLevel | null };
export type VersusSetup = { rule: WinRule; colors: number; target: Target; players: PlayerSetup[] };

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
  /** Online play's WebSocket address (config.json "play"); without it there is no online play. */
  playUrl?: string;
};

/** How to join an online match: quick match, open a room ('new'), or a friend's 4-letter code. */
export type OnlineJoin = { level: number; speed: Speed; room?: string };

const TICK_MS = 1000 / TICKS_PER_SECOND;
const MAX_PLAYERS = 2; // 3 and 4 players: later (Mike, 2026-11-22). The board code already handles them.
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
  /** Only the bigger sounds (the computer's board, or the opponent's online). */
  quiet: boolean;
};

/** A phone or tablet: at most 2 players, and touch is a choice. */
const isTouch = () => matchMedia('(pointer: coarse)').matches;
const connectedPads = () => [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.connected).map(p => p.index);

/** The choices in each player's "Played by" list. */
function controlChoices(): [Control, string][] {
  const pads = new Set(connectedPads());
  const list: [Control, string][] = [['cpu', 'Computer']];
  if (isTouch()) list.push(['touch', 'Touch']);
  list.push(['kb', 'Keyboard and mouse'], ['kb-l', 'Keyboard, left side (W A S D)'], ['kb-r', 'Keyboard, right side (arrows)'], ['mouse', 'Mouse']);
  for (let i = 0; i < 4; i++) list.push([`pad-${i}`, `Gamepad ${i + 1}${pads.has(i) ? '' : ' (not connected)'}`]);
  return list;
}

/** Two controls that can't both be used at once (the same device, or the keyboard and its half). */
function clash(a: Control, b: Control): boolean {
  if (a === 'cpu' || b === 'cpu') return false;
  if (a === b) return true;
  const kb = (c: Control) => c === 'kb' || c === 'kb-l' || c === 'kb-r';
  if ((a === 'kb' && (kb(b) || b === 'mouse')) || (b === 'kb' && (kb(a) || a === 'mouse'))) return true;
  return false;
}

/** Which input sources a control listens to (see InputManager.accept). */
function accepts(c: Control): (src: string) => boolean {
  switch (c) {
    case 'kb': return src => src === 'kb-l' || src === 'kb-r' || src === 'mouse';
    case 'kb-l': case 'kb-r': case 'mouse': return src => src === c;
    case 'touch': return src => src === 'touch' || src === 'swipe';
    case 'any': return () => true;
    case 'cpu': case 'remote': return () => false;
    default: return src => src === c; // a gamepad
  }
}

const fieldset = (i: number) => $(`vsP${i}`);
const playerCount = () => MAX_PLAYERS;

/**
 * The setup screen remembers the last match on this device (Mike, 2026-11-22): rule, colors, and
 * each player's level, speed, who plays and computer skill, plus the online level and speed. It is
 * only a convenience, so it lives in this browser's storage and is never synced.
 */
const LAST_KEY = 'bugpop.versus.last.v1';
type Last = { rule: WinRule; colors: number; players: { level: number; speed: Speed; control: Control; bot: BotLevel }[]; online?: { level: number; speed: Speed } };
function readLast(): Last | null {
  try { const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as Last | null; return v && Array.isArray(v.players) ? v : null; } catch { return null; }
}
function writeLast(patch: Partial<Last>) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ ...readLast(), ...patch })); } catch { /* private mode: nothing to remember */ }
}
/** Remember the online card's level and speed (main.ts calls this when a match starts). */
export function rememberOnline(level: number, speed: Speed) { writeLast({ online: { level, speed } }); }
/** The online card's starting level and speed. */
export function lastOnline(fallbackSpeed: Speed): { level: number; speed: Speed } {
  return readLast()?.online ?? { level: 5, speed: versusSpeed(fallbackSpeed) };
}
/** The versus lists offer Low, Medium and High; single player's Slo-mo (3) starts them on Low. */
const versusSpeed = (s: Speed): Speed => (s === 3 ? 0 : s);

const setLevel = (fs: HTMLElement, level: number) => {
  const r = fs.querySelector<HTMLInputElement>('.vs-level')!;
  r.value = String(level);
  r.closest('label')!.querySelector('output')!.value = r.value;
};

/**
 * Fill the "Played by" lists and set every starting value. Call once at start-up, with single
 * player's speed: the first time, both players start at that speed.
 */
export function initSetupForm(singleSpeed: Speed) {
  const last = readLast();
  if (last) {
    $<HTMLSelectElement>('vsRule').value = last.rule;
    $<HTMLSelectElement>('vsColors').value = String(last.colors);
  }
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const fs = fieldset(i), saved = last?.players[i];
    setLevel(fs, saved?.level ?? 5);
    fs.querySelector<HTMLSelectElement>('.vs-speed')!.value = String(saved?.speed ?? versusSpeed(singleSpeed));
    if (saved?.bot) fs.querySelector<HTMLSelectElement>('.vs-skill')!.value = saved.bot;
    fs.querySelector<HTMLSelectElement>('.vs-control')!.addEventListener('input', refreshSetupForm);
  }
  fillControls(last?.players.map(p => p.control) ?? null);
  // A gamepad plugged in while setting up takes over player 2 from the computer; unplugging it
  // hands player 2 back to the computer.
  window.addEventListener('gamepadconnected', e => {
    fillControls(null, true);
    const p2 = fieldset(1).querySelector<HTMLSelectElement>('.vs-control')!;
    if (p2.value === 'cpu') { p2.value = `pad-${e.gamepad.index}`; refreshSetupForm(); }
  });
  window.addEventListener('gamepaddisconnected', e => {
    fillControls(null, true);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const sel = fieldset(i).querySelector<HTMLSelectElement>('.vs-control')!;
      if (sel.value === `pad-${e.gamepad.index}`) sel.value = i === 0 ? (isTouch() ? 'touch' : 'kb') : 'cpu';
    }
    refreshSetupForm();
  });
}

/**
 * Rebuild the "Played by" lists (gamepads come and go). `start` gives each player's choice; with
 * none, the defaults (Mike, 2026-11-22): player 1 an input device (touch on a phone, else the
 * keyboard and mouse), player 2 the computer unless a gamepad is connected. `keep` keeps the
 * current choices instead.
 */
function fillControls(start: Control[] | null, keep = false) {
  const pads = connectedPads();
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const sel = fieldset(i).querySelector<HTMLSelectElement>('.vs-control')!;
    const now = sel.value as Control;
    sel.replaceChildren(...controlChoices().map(([v, label]) => new Option(label, v)));
    const pick: Control = keep && now ? now
      : start?.[i] ?? (i === 0 ? (isTouch() ? 'touch' : 'kb') : pads.length ? `pad-${pads[0]!}` : 'cpu');
    sel.value = pick;
    if (sel.value !== pick) sel.value = i === 0 ? (isTouch() ? 'touch' : 'kb') : 'cpu';
  }
  refreshSetupForm();
}

/** Read the setup screen's form. */
export function readSetup(): VersusSetup {
  const n = playerCount();
  const players: PlayerSetup[] = [];
  for (let i = 0; i < n; i++) {
    const fs = fieldset(i);
    const level = Math.max(1, Math.min(20, Math.round(Number(fs.querySelector<HTMLInputElement>('.vs-level')!.value) || 5)));
    const speed = Number(fs.querySelector<HTMLSelectElement>('.vs-speed')!.value) as Speed;
    const control = fs.querySelector<HTMLSelectElement>('.vs-control')!.value as Control;
    players.push({ level, speed, control, bot: control === 'cpu' ? (fs.querySelector<HTMLSelectElement>('.vs-skill')!.value as BotLevel) : null });
  }
  const setup: VersusSetup = { rule: $<HTMLSelectElement>('vsRule').value as WinRule, colors: Number($<HTMLSelectElement>('vsColors').value), target: 'leader', players };
  writeLast({ rule: setup.rule, colors: setup.colors, players: players.map((p, i) => ({ ...p, bot: p.bot ?? (fieldset(i).querySelector<HTMLSelectElement>('.vs-skill')!.value as BotLevel) })) });
  return setup;
}

/** Names on the boards, always saying which ones are the computer. One person alone is "You". */
function names(setup: VersusSetup): string[] {
  const humans = setup.players.filter(p => !p.bot).length, bots = setup.players.length - humans;
  let h = 0, b = 0;
  return setup.players.map(p => {
    if (p.bot) { b++; return `Computer${bots > 1 ? ` ${b}` : ''} (${SKILL_NAME[p.bot]})`; }
    h++;
    return humans === 1 ? 'You' : `Player ${h}`;
  });
}

/**
 * The setup screen: the Computer skill picker only for computer players, and a warning (Start
 * turned off) when both players picked the same device.
 */
export function refreshSetupForm() {
  const n = playerCount();
  const controls: Control[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const fs = fieldset(i);
    fs.hidden = i >= n;
    const c = fs.querySelector<HTMLSelectElement>('.vs-control')!.value as Control;
    fs.querySelector<HTMLElement>('.vs-skill-row')!.hidden = c !== 'cpu';
    if (i < n) controls.push(c);
  }
  let problem = '';
  for (let i = 0; i < controls.length && !problem; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      if (clash(controls[i]!, controls[j]!)) { problem = `Players ${i + 1} and ${j + 1} can't share a device. Pick another for one of them.`; break; }
    }
  }
  const pads = new Set(connectedPads());
  const missing = controls.findIndex(c => c.startsWith('pad-') && !pads.has(Number(c.slice(4))));
  const humans = controls.filter(c => c !== 'cpu').length;
  $<HTMLButtonElement>('vsStart').disabled = !!problem;
  $('vsControls').textContent = problem
    || (missing >= 0 ? `Player ${missing + 1}'s gamepad isn't connected yet: press any button on it.` : '')
    || (humans === 0 ? 'Sit back and watch. Every game is different: the computer has its own dice.'
      : controls.includes('kb-l') || controls.includes('kb-r') ? 'Left side: W A S D to move and drop, Q or W to turn. Right side: the arrow keys, with Up and / to turn.'
      : '');
}

/** Change an element's text only when it differs (this runs every frame). */
const setText = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text; };

export class Versus {
  private sides: Side[];
  /** How many boards are in play (the rest are hidden). */
  private count = 2;
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
  /** Online: the connection, the match once it starts, and how we joined (for Play again). */
  private net: { ws: WebSocket; match: OnlineMatch | null; join: OnlineJoin; t0: number; over: boolean; tries: number } | null = null;
  /** The rule line above the boards online (also shows when the other player dropped out). */
  private netRule = '';

  constructor(private deps: VersusDeps) {
    const make = (i: number): Side => {
      const el = $(`vsSide${i}`);
      const canvas = el.querySelector('canvas')!;
      const side: Side = {
        el, canvas, ctx: canvas.getContext('2d')!, layout: computeLayout(1, 1, 0), input: new InputManager(), bot: null,
        name: '', state: null, wins: 0, leavers: [], floats: [], matched: [], arrivals: new Map(), quiet: false,
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
    this.sides = Array.from({ length: MAX_PLAYERS }, (_, i) => make(i));
    $('vsLeave').addEventListener('click', () => { this.deps.audio.play('select'); this.openLeave(); });
    $('vsStay').addEventListener('click', () => { this.deps.audio.play('select'); this.closeLeave(); });
    $('vsNext').addEventListener('click', () => { this.deps.audio.play('select'); this.startRound(); });
    $('vsAgain').addEventListener('click', () => {
      this.deps.audio.play('select');
      if (this.net) this.startOnline(this.net.join); else this.startMatch(this.setup!);
    });
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

  /** Show `n` boards. With one person against one other board, theirs is the big one on a phone. */
  private showSides(n: number, oneHuman: boolean) {
    this.count = n;
    this.sides.forEach((s, i) => { s.el.hidden = i >= n; if (i >= n) s.state = null; });
    const boards = this.stage.querySelector('.vs-boards')!;
    boards.classList.toggle('one-human', n === 2 && oneHuman);
  }

  /**
   * Who listens to what: each person's board takes only their chosen device. One person alone
   * takes everything, so any key, pad or touch works for them.
   */
  private assignInputs(setup: VersusSetup) {
    const humans = setup.players.filter(p => !p.bot).length;
    this.sides.forEach((s, i) => {
      s.input.reset();
      s.input.attachTouchButtons(this.deps.touchBar);
      const p = setup.players[i];
      s.input.accept = !p ? () => false : humans === 1 && !p.bot ? () => true : accepts(p.control);
    });
    // Computers only: nobody steers, but Esc, P or Start still opens the leave card.
    if (humans === 0) this.sides[0]!.input.accept = () => true;
  }

  /** Begin a new match with these players (round 1, no wins). */
  startMatch(setup: VersusSetup) {
    this.closeNet();
    this.setup = setup;
    const n = names(setup);
    this.sides.forEach((s, i) => { s.name = n[i] ?? ''; s.wins = 0; });
    this.round = 1;
    this.showSides(setup.players.length, setup.players.filter(p => !p.bot).length === 1);
    this.assignInputs(setup);
    this.startRound();
  }

  private startRound() {
    const setup = this.setup!;
    // Every board gets the same pieces in the same order (a fair race); the bugs differ by level.
    const seed = randomSeed();
    setup.players.forEach((p, i) => {
      const s = this.sides[i]!;
      s.state = createGame({ seed, level: p.level, speed: p.speed, colors: setup.colors, versus: true, endless: setup.rule === 'last' || undefined });
      s.bot = p.bot ? new Bot(BOT_SKILLS[p.bot], randomSeed()) : null;
      s.quiet = !!s.bot;
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
    this.closeNet();
    this.phase = 'off';
    cancelAnimationFrame(this.raf);
    this.setCapture(false);
    for (const s of this.sides) { s.input.accept = () => false; s.input.reset(); s.state = null; }
    this.stage.hidden = true;
    this.card.hidden = true;
    this.deps.audio.stopMusic();
  }

  private setCapture(on: boolean) {
    this.sides.forEach((s, i) => {
      const p = this.setup?.players[i];
      s.input.capture = on && !!p && !p.bot && p.control !== 'remote' && s.state?.phase !== 'lost';
    });
  }

  // ---- Online (a relay passes moves between two devices; see packages/protocol) ----
  get canPlayOnline() { return !!this.deps.playUrl; }

  /** Connect and wait for an opponent (quick match), or open or join a room. */
  startOnline(join: OnlineJoin, tries = 0) {
    this.closeNet();
    const url = new URL(this.deps.playUrl!, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
    const ws = new WebSocket(url);
    const net = { ws, match: null as OnlineMatch | null, join, t0: 0, over: false, tries };
    this.net = net;
    this.setup = { rule: 'race', colors: 3, target: 'leader', players: [{ level: join.level, speed: join.speed, control: 'any', bot: null }, { level: 1, speed: 1, control: 'remote', bot: null }] };
    for (const s of this.sides) { s.state = null; s.wins = 0; s.quiet = false; s.input.accept = () => false; s.input.reset(); }
    this.sides[1]!.quiet = true;
    this.showSides(2, true);
    this.stage.hidden = false;
    this.phase = 'card';
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.showCard(tries ? 'Reconnecting...' : 'Connecting...', tries ? 'The computer plays your board until you are back.' : 'Reaching the game server.', ['vsMenu']);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, level: join.level, speed: join.speed, ...(join.room ? { room: join.room } : {}) })));
    ws.addEventListener('message', e => { if (this.net === net) this.onNet(parseServer(String(e.data))); });
    ws.addEventListener('close', () => {
      if (this.net !== net || net.over) return;
      net.over = true;
      // Dropped out of a match: try to get back in (the server rejoins us to it, Mike 2026-11-22).
      if ((net.match || net.tries) && net.tries < 3) { window.setTimeout(() => { if (this.net === net) this.startOnline(net.join, net.tries + 1); }, 1500); return; }
      this.endOnline(null, net.match || net.tries ? 'Connection lost' : "Couldn't reach the game server", net.match || net.tries ? 'Go back into Multiplayer within a minute to rejoin the match: the computer plays your board until then.' : 'Check your connection and try again.');
    });
  }

  private closeNet() {
    const net = this.net;
    if (!net) return;
    // Leaving a match on purpose forfeits it at once (and counts as a disconnect).
    if (!net.over && net.match && !net.match.result && net.ws.readyState === net.ws.OPEN) net.ws.send(JSON.stringify({ t: 'quit' }));
    net.over = true;
    this.net = null;
    try { net.ws.close(); } catch { /* already closed */ }
  }

  private onNet(msg: ServerMsg | null) {
    const net = this.net!;
    if (!msg || net.over) return;
    switch (msg.t) {
      case 'wait': this.showCard('Looking for an opponent...', 'The match starts as soon as someone joins.', ['vsMenu']); break;
      case 'room':
        this.showCard(`Room ${msg.code}`, `Your friend can scan this code, open the link you share, or type ${msg.code} under Join a room on the Multiplayer screen.`, ['vsMenu']);
        this.showRoomShare(msg.code);
        break;
      case 'error': net.over = true; this.endOnline(null, "Can't play online right now", msg.why); break;
      case 'start': case 'resume': {
        const send = (out: ClientMsg) => { if (net.ws.readyState === net.ws.OPEN) net.ws.send(JSON.stringify(out)); };
        // A rejoin rebuilds both boards and checks every move the stand-in computer made for me,
        // in this round and any earlier one it played part of (Mike, 2026-11-22).
        const m = msg.t === 'start' ? new OnlineMatch(msg, send) : OnlineMatch.rebuild(msg.start, send, msg.mine, msg.theirs, msg.standIns);
        if (msg.t === 'resume') {
          const bad = msg.earlier.map(r => OnlineMatch.check(r.start, r.mine, r.theirs, r.standIns)).find(Boolean);
          if (bad && !m.flagged) send({ t: 'flag', why: bad });
        }
        m.onTheirEvents = ev => this.effects(this.sides[1]!, ev);
        net.match = m;
        net.tries = 0;
        net.t0 = performance.now() - m.clock * TICK_MS; // a rejoin carries on from its clock
        const me = this.sides[0]!, them = this.sides[1]!;
        me.state = m.me; them.state = m.them;
        me.name = 'You'; them.name = m.theirName;
        me.wins = m.start.wins[m.seat]; them.wins = m.start.wins[1 - m.seat]!;
        for (const s of this.sides) { s.leavers = []; s.floats = []; s.matched = []; s.arrivals = new Map(); }
        me.input.attachTouchButtons(this.deps.touchBar);
        me.input.accept = () => true;
        them.input.accept = () => false;
        this.card.hidden = true;
        this.leaveUp = false;
        this.phase = 'playing';
        this.setCapture(true);
        this.setup!.rule = m.start.rule;
        this.netRule = m.start.rule === 'best3' ? `Online: best of 3, round ${m.start.round}` : m.start.rule === 'last' ? 'Online: last one standing' : 'Online: first to clear their bugs';
        $('vsRuleText').textContent = this.netRule;
        this.sides.forEach(s => this.resize(s));
        this.deps.audio.startMusic(true);
        break;
      }
      case 'away':
        // The other player dropped out: the computer plays their board here until they're back.
        net.match?.takeOver();
        $('vsRuleText').textContent = `${this.sides[1]!.name} lost their connection. The computer plays for them for up to ${msg.seconds} seconds.`;
        break;
      case 'back': net.match?.handOver(); $('vsRuleText').textContent = this.netRule; break;
      case 'in': case 'took': {
        const m = net.match;
        if (!m) return;
        this.effects(this.sides[1]!, m.receive(msg));
        if (m.flagged) { net.over = true; this.endOnline(null, 'Match stopped', 'Something in the other player\'s moves did not add up, so the match was stopped.'); }
        break;
      }
      case 'end': {
        if (net.match?.result && msg.why === 'result') return; // already showing it
        net.over = true;
        const mine = net.match?.seat;
        const winner = msg.winner === null || mine === undefined ? null : msg.winner === mine ? 0 : 1;
        if (msg.why === 'left') this.endOnline(winner, 'You win', 'The other player left the match.');
        else if (msg.why === 'result') this.endOnline(winner, winner === 0 ? 'You win' : winner === 1 ? `${this.sides[1]!.name} wins` : 'A draw', 'Good game.');
        else this.endOnline(null, 'Match stopped', 'The two games did not agree, so the match was stopped.');
        break;
      }
    }
  }

  /** One tick of my board online (theirs moves on as their moves arrive). */
  private netTick() {
    const m = this.net!.match!;
    const me = this.sides[0]!;
    const f = me.input.poll(this.leaveUp ? null : m.me);
    if (f.pause) { if (this.leaveUp) this.closeLeave(); else this.openLeave(); }
    this.effects(me, m.tick(this.leaveUp ? [] : f.actions));
    if (m.result) {
      const w = m.result.winner;
      const winner = w === null ? null : w === m.seat ? 0 : 1;
      if (m.start.rule === 'best3') return this.roundOver(winner);
      this.endOnline(winner, winner === 0 ? 'You win' : winner === 1 ? `${this.sides[1]!.name} wins` : 'A draw', 'Good game.');
    }
  }

  /**
   * Online best of 3: a round is decided. The match is over at 2 wins; otherwise the card says
   * who took the round and the relay starts the next one with the same opponent.
   */
  private roundOver(winner: 0 | 1 | null) {
    const me = this.sides[0]!, them = this.sides[1]!;
    if (winner === 0) me.wins++; else if (winner === 1) them.wins++;
    const score = `${me.wins} to ${them.wins}`;
    if (me.wins >= 2) return this.endOnline(0, 'You win the match', `You won ${score}. Good game.`);
    if (them.wins >= 2) return this.endOnline(1, `${them.name} wins the match`, `${them.name} won ${score}. Good game.`);
    this.phase = 'ending';
    this.setCapture(false);
    if (this.leaveUp) { this.leaveUp = false; this.card.hidden = true; }
    for (const s of this.sides) s.input.reset();
    this.deps.audio.stopMusic();
    this.deps.audio.play(winner === 1 ? 'lose' : 'win');
    const title = winner === 0 ? 'You win the round' : winner === 1 ? `${them.name} wins the round` : 'A drawn round';
    window.setTimeout(() => {
      if (this.phase !== 'ending') return;
      this.phase = 'card';
      this.showCard(title, `${score}. The next round starts in a moment.`, ['vsMenu']);
    }, this.deps.finishPauseMs);
  }

  /** An online match is over: the usual pause, then the card. The connection closes. */
  private endOnline(winner: 0 | 1 | null, title: string, text: string) {
    const playing = this.phase === 'playing';
    this.phase = 'ending';
    this.setCapture(false);
    if (this.leaveUp) { this.leaveUp = false; this.card.hidden = true; }
    for (const s of this.sides) s.input.reset();
    const net = this.net;
    if (net) { net.over = true; window.setTimeout(() => { try { net.ws.close(); } catch { /* closed */ } }, 1000); }
    if (playing) { this.deps.audio.stopMusic(); this.deps.audio.play(winner === 1 ? 'lose' : 'win'); }
    window.setTimeout(() => {
      if (this.phase !== 'ending') return;
      this.phase = 'card';
      this.showCard(title, text, ['vsAgain', 'vsSetupBtn', 'vsMenu']);
    }, playing ? this.deps.finishPauseMs : 0);
  }

  // ---- The cards ----
  /**
   * A room's QR code and Share button (Mike, 2026-11-22). Both carry the join link: this page with
   * ?room=CODE, which drops a friend straight into the room (signing in first if needed). The code
   * is drawn here on the device; nothing is sent anywhere to make it.
   */
  private showRoomShare(code: string) {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('room', code);
    const link = url.toString();
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    $<HTMLImageElement>('vsRoomQr').src = qr.createDataURL(6, 2);
    const btn = $<HTMLButtonElement>('vsShare');
    btn.textContent = 'Share join link';
    btn.onclick = async () => {
      const text = `Join my Bug Pop room ${code}`;
      try {
        if (navigator.share) { await navigator.share({ title: 'Bug Pop', text, url: link }); return; }
        await navigator.clipboard.writeText(link);
        btn.textContent = 'Link copied';
      } catch { /* the player closed the share sheet */ }
    };
    $('vsRoomShare').hidden = false;
  }

  private showCard(title: string, text: string, buttons: ('vsNext' | 'vsAgain' | 'vsStay' | 'vsSetupBtn' | 'vsMenu')[]) {
    $('vsRoomShare').hidden = true;
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
    if (this.phase === 'playing' && this.net?.match) {
      // Online: keep in step with the real clock, even after the page was stalled, so both
      // players' tick counts stay close (the checks allow a few seconds, not minutes).
      const m = this.net.match, due = Math.floor((now - this.net.t0) / TICK_MS);
      for (let n = 0; n < 600 && m.clock < due && this.phase === 'playing'; n++) this.netTick();
    } else if (this.phase === 'playing') {
      this.acc += dt;
      while (this.acc >= TICK_MS && this.phase === 'playing') {
        this.tick();
        this.acc -= TICK_MS;
      }
    } else {
      // A card is up: still read the devices, so nothing piles up for the next round.
      for (const s of this.sides.slice(0, this.count)) s.input.poll(null);
    }
    this.draw(now);
    this.raf = requestAnimationFrame(this.frame);
  };

  private tick() {
    const setup = this.setup!;
    const live = this.sides.slice(0, this.count);
    const events: GameEvent[][] = live.map(() => []);
    const allBots = setup.players.every(p => p.bot);
    live.forEach((s, i) => {
      const st = s.state!;
      let actions = s.bot ? s.bot.act(st) : [];
      if (!s.bot || (i === 0 && allBots)) {
        const f = s.input.poll(this.leaveUp || s.bot ? null : st);
        if (f.pause) { if (this.leaveUp) this.closeLeave(); else this.openLeave(); }
        if (!s.bot) actions = this.leaveUp ? [] : f.actions;
      }
      events[i] = step(st, actions);
    });
    // Attacks land after every board has stepped, so nobody gets a head start.
    const playing = (j: number) => { const ph = live[j]!.state!.phase; return ph !== 'won' && ph !== 'lost'; };
    events.forEach((evs, i) => {
      for (const e of evs) {
        if (e.type !== 'attack') continue;
        for (const j of this.targets(i, playing)) events[j]!.push(...receiveAttack(live[j]!.state!, e.attack));
      }
    });
    events.forEach((evs, i) => this.effects(live[i]!, evs));
    // A board that tops out is out (its player stops steering it).
    if (events.some(evs => evs.some(e => e.type === 'lost'))) this.setCapture(!this.leaveUp);
    // Who won the round? Clearing every bug first wins; otherwise the last board still going.
    const won = live.map((s, i) => (s.state!.phase === 'won' ? i : -1)).filter(i => i >= 0);
    const going = live.map((_, i) => i).filter(playing);
    if (won.length) this.endRound(won.length === 1 ? won[0]! : null);
    else if (going.length <= 1) this.endRound(going.length === 1 ? going[0]! : null);
  }

  /**
   * Who an attack from board `from` lands on. Two players: the other one. Three or four: the
   * setting (Mike, 2026-11-22): the leader (fewest bugs left, ties at random), someone at random,
   * or everyone still playing.
   */
  private targets(from: number, playing: (j: number) => boolean): number[] {
    const others = this.sides.slice(0, this.count).map((_, j) => j).filter(j => j !== from && playing(j));
    if (others.length <= 1) return others;
    const target = this.setup!.target;
    if (target === 'everyone') return others;
    const pick = (list: number[]) => [list[Math.floor(Math.random() * list.length)]!];
    if (target === 'random') return pick(others);
    const fewest = Math.min(...others.map(j => this.sides[j]!.state!.bugsLeft));
    return pick(others.filter(j => this.sides[j]!.state!.bugsLeft === fewest));
  }

  private endRound(winner: number | null) {
    const setup = this.setup!;
    this.phase = 'ending';
    this.setCapture(false);
    if (this.leaveUp) { this.leaveUp = false; this.card.hidden = true; }
    for (const s of this.sides) s.input.reset();
    if (winner !== null) this.sides[winner]!.wins++;
    this.deps.audio.stopMusic();
    // One person who didn't win hears the losing tune; anything else is a win to celebrate.
    const humans = setup.players.map((p, i) => (p.bot ? -1 : i)).filter(i => i >= 0);
    this.deps.audio.play(humans.length === 1 && winner !== humans[0] ? 'lose' : 'win');
    const decided = setup.rule !== 'best3' || this.sides.some(s => s.wins >= 2);
    window.setTimeout(() => {
      if (this.phase !== 'ending') return;
      this.phase = 'card';
      const who = winner === null ? null : this.sides[winner]!.name;
      const title = who === null ? 'A draw' : who === 'You' ? 'You win' : `${who} wins`;
      const score = this.sides.slice(0, this.count).map(s => `${s.name} ${s.wins}`).join(', ') + '.';
      if (decided) this.showCard(setup.rule === 'best3' ? `${title} the match` : title, setup.rule === 'best3' ? score : winner === null ? 'No one was left standing.' : 'Good game.', ['vsAgain', 'vsSetupBtn', 'vsMenu']);
      else {
        this.round++;
        this.showCard(winner === null ? `Round ${this.round - 1}: a draw` : `${title} round ${this.round - 1}`, score, ['vsNext', 'vsSetupBtn', 'vsMenu']);
      }
    }, this.deps.finishPauseMs);
  }

  /** Sounds and animations for one board. The computer's boards only make the bigger sounds. */
  private effects(side: Side, events: GameEvent[]) {
    const audio = this.deps.audio;
    const quiet = side.quiet;
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
    for (const s of this.sides.slice(0, this.count)) {
      if (s.leavers.length) s.leavers = s.leavers.filter(l => now - l.t0 < LEAVE_MS);
      if (s.floats.length) s.floats = s.floats.filter(f => now - f.t0 < FLOAT_MS);
      if (s.arrivals.size && [...s.arrivals.values()].every(t0 => now - t0 >= ARRIVE_MS)) s.arrivals = new Map();
      if (!s.state) continue;
      render(s.ctx, s.state, skin, s.layout, { shapesOnPieces: set.shapesOnPieces, motion: motion(), time: now, images, leavers: s.leavers, arrivals: s.arrivals, floats: s.floats, bugExit: set.exit || undefined });
      // The label over the board: name, progress, and halves on their way.
      const info = s.state.phase === 'lost' && this.phase === 'playing' ? 'out' : this.setup!.rule === 'last' ? `score ${s.state.score}` : s.state.bugsLeft === 1 ? '1 bug left' : `${s.state.bugsLeft} bugs left`;
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
