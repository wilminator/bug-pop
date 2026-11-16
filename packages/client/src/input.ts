// Input layer: turns keyboards, mice, gamepads and touch buttons into the
// engine's small set of actions. The engine never sees a device, only actions,
// which is why adding a new device (or a second player) never touches it.
//
// Every source writes into a "virtual pad": which directions are held and which
// buttons were just pressed. Once per tick, poll() reads the pads and applies
// auto-repeat (hold left = move, pause, then move steadily), like most
// falling-block games.

import { BOARD_WIDTH, type Action, type GameState } from '@bug-pop/engine';

export const REPEAT_DELAY = 10; // ticks before a held direction repeats
export const REPEAT_EVERY = 3; // ticks between repeats
const MOUSE_STEP_TICKS = 2; // mouse steering moves at most one column per 2 ticks
const STICK_DEADZONE = 0.5;

type Held = { left: boolean; right: boolean; down: boolean };
type Press = 'rotCW' | 'rotCCW' | 'pause' | 'confirm';

export type Nav = 'up' | 'down' | 'left' | 'right';
export type InputFrame = { actions: Action[]; pause: boolean; confirm: boolean; nav: Nav[] };

export type DeviceKind = 'keyboard' | 'mouse' | 'gamepad' | 'touch';

export class InputManager {
  private held = new Map<string, Held>(); // per source
  private presses: Press[] = [];
  private steps: ('left' | 'right')[] = []; // one-column moves from swipes
  private tapped = new Set<keyof Held>();
  private leftTicks = 0;
  private rightTicks = 0;
  private softOn = false;
  private padPrev = new Map<number, boolean[]>();
  private navPrev = new Map<number, Record<Nav, boolean>>();
  private nav: Nav[] = [];
  /** While false (menus), keys other than pause pass through to the page. */
  capture = false;
  private mouseColumn: number | null = null;
  private mouseCooldown = 0;
  /** Last device used; the UI uses it to show the right hints. */
  lastDevice: DeviceKind = 'keyboard';
  onDevice?: (kind: DeviceKind) => void;

  constructor(private readonly target: Window = window) {
    target.addEventListener('keydown', e => this.onKey(e, true));
    target.addEventListener('keyup', e => this.onKey(e, false));
    target.addEventListener('blur', () => this.releaseAll());
  }

  private use(kind: DeviceKind) {
    if (kind !== 'mouse') this.mouseColumn = null;
    if (this.lastDevice !== kind) { this.lastDevice = kind; this.onDevice?.(kind); }
  }

  private setHeld(source: string, key: keyof Held, down: boolean) {
    const h = this.held.get(source) ?? { left: false, right: false, down: false };
    // A tap shorter than one tick still counts: remember it until the next poll.
    if (down && !h[key]) this.tapped.add(key);
    h[key] = down;
    this.held.set(source, h);
  }

  press(p: Press) {
    this.presses.push(p);
  }

  releaseAll() {
    this.held.clear();
  }

  // ---- Keyboard ----
  private static keyMap: Record<string, keyof Held | Press> = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowDown: 'down', KeyS: 'down',
    ArrowUp: 'rotCW', KeyX: 'rotCW', KeyW: 'rotCW', KeyK: 'rotCW',
    KeyZ: 'rotCCW', KeyQ: 'rotCCW', KeyJ: 'rotCCW',
    Escape: 'pause', KeyP: 'pause',
    Enter: 'confirm', Space: 'confirm',
  };

  private onKey(e: KeyboardEvent, down: boolean) {
    const what = InputManager.keyMap[e.code];
    if (!what) return;
    if (!this.capture) {
      if (what === 'pause' && down && !e.repeat) { e.preventDefault(); this.press('pause'); }
      return; // menus: let the browser handle Tab, arrows, Enter
    }
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (inField && (what === 'confirm' || what === 'left' || what === 'right')) return; // let forms work
    e.preventDefault();
    this.use('keyboard');
    if (what === 'left' || what === 'right' || what === 'down') this.setHeld('kb', what, down);
    else if (down && !e.repeat) this.press(what);
  }

  // ---- Mouse: the piece follows the pointer; left click turns, right button drops ----
  attachMouse(el: HTMLElement, columnAt: (clientX: number) => number | null) {
    el.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      const col = columnAt(e.clientX);
      if (col === null) return;
      this.use('mouse');
      this.mouseColumn = col;
    });
    el.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse') return;
      this.use('mouse');
      if (e.button === 0) this.press('rotCW');
      if (e.button === 1) this.press('rotCCW');
      if (e.button === 2) this.setHeld('mouse', 'down', true);
    });
    const up = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && (e.button === 2 || e.type !== 'pointerup')) this.setHeld('mouse', 'down', false);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.use('mouse');
      this.press(e.deltaY > 0 ? 'rotCW' : 'rotCCW');
    }, { passive: false });
  }

  // ---- Swipes on the board: drag to steer, drag down to drop, tap to turn ----
  // Dragging sideways moves the piece one column for every column-width the finger
  // travels, so the piece stays under the finger. Dragging down holds soft drop until
  // the finger lifts. A quick tap turns right; a quick flick up turns left.
  attachSwipe(el: HTMLElement, cellSize: () => number) {
    let id: number | null = null;
    let x0 = 0, y0 = 0, lastX = 0, t0 = 0, moved = false, dropping = false;
    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || id !== null || !this.capture) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      id = e.pointerId;
      x0 = lastX = e.clientX; y0 = e.clientY; t0 = e.timeStamp;
      moved = dropping = false;
      this.use('touch');
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerId !== id) return;
      const c = Math.max(12, cellSize());
      const dx = e.clientX - x0, dy = e.clientY - y0;
      // Sideways: one step per column crossed since the last step.
      if (!dropping) {
        while (e.clientX - lastX >= c) { this.steps.push('right'); lastX += c; moved = true; }
        while (lastX - e.clientX >= c) { this.steps.push('left'); lastX -= c; moved = true; }
      }
      // Downward drag that's mostly vertical: soft drop while the finger stays down.
      if (!dropping && dy > c * 1.2 && dy > Math.abs(dx) * 1.5) {
        dropping = moved = true;
        this.setHeld('swipe', 'down', true);
      }
      if (Math.abs(dx) > c * 0.4 || Math.abs(dy) > c * 0.4) moved = true;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = null;
      if (dropping) this.setHeld('swipe', 'down', false);
      const c = Math.max(12, cellSize());
      const dy = e.clientY - y0, quick = e.timeStamp - t0 < 350;
      if (e.type === 'pointerup' && quick && dy < -c * 1.2 && Math.abs(dy) > Math.abs(e.clientX - x0)) this.press('rotCCW');
      else if (e.type === 'pointerup' && !moved && quick) this.press('rotCW');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ---- On-screen touch buttons (data-input="left|right|down|rotCW|rotCCW|pause") ----
  attachTouchButtons(root: HTMLElement) {
    for (const btn of root.querySelectorAll<HTMLElement>('[data-input]')) {
      const what = btn.dataset.input as keyof Held | Press;
      const source = `touch-${what}`;
      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        this.use('touch');
        if (what === 'left' || what === 'right' || what === 'down') this.setHeld(source, what, true);
        else this.press(what);
      });
      const release = () => { if (what === 'left' || what === 'right' || what === 'down') this.setHeld(source, what, false); };
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('lostpointercapture', release);
    }
  }

  // ---- Gamepads (standard mapping; works for most USB/Bluetooth pads and joysticks) ----
  private pollGamepads() {
    const pads = navigator.getGamepads?.() ?? [];
    const seen = new Set<string>();
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
      const left = b(14) || ax < -STICK_DEADZONE;
      const right = b(15) || ax > STICK_DEADZONE;
      const down = b(13) || ay > STICK_DEADZONE;
      const source = `pad-${pad.index}`;
      seen.add(source);
      // Menu navigation: edges of d-pad / stick directions.
      const dirs: Record<Nav, boolean> = { up: b(12) || ay < -STICK_DEADZONE, down, left, right };
      const prevDirs = this.navPrev.get(pad.index);
      for (const d of ['up', 'down', 'left', 'right'] as Nav[]) if (dirs[d] && !prevDirs?.[d]) this.nav.push(d);
      this.navPrev.set(pad.index, dirs);
      const prev = this.padPrev.get(pad.index) ?? [];
      const now = pad.buttons.map(x => x.pressed);
      const edge = (i: number) => !!now[i] && !prev[i];
      const presses: Press[] = [];
      if (edge(0) || edge(3) || edge(12)) presses.push('rotCW'); // A / Y / d-pad up
      if (edge(1) || edge(2)) presses.push('rotCCW'); // B / X
      if (edge(9) || edge(8)) presses.push('pause'); // Start / Select
      if (edge(0) || edge(9)) presses.push('confirm');
      this.padPrev.set(pad.index, now);
      const h = this.held.get(source);
      const changed = !h || h.left !== left || h.right !== right || h.down !== down;
      if (changed || presses.length) this.use('gamepad');
      this.held.set(source, { left, right, down });
      this.presses.push(...presses);
    }
    for (const key of [...this.held.keys()]) if (key.startsWith('pad-') && !seen.has(key)) this.held.delete(key);
  }

  /**
   * Read all devices once. Call once per game tick while playing (pass the
   * state so mouse steering knows where the piece is), or once per frame in
   * menus (pass null; only pause/confirm matter then).
   */
  poll(state: GameState | null): InputFrame {
    this.pollGamepads();
    const any = (k: keyof Held) => this.tapped.has(k) || [...this.held.values()].some(h => h[k]);
    const left = any('left'), right = any('right'), down = any('down');
    const presses = this.presses;
    this.presses = [];
    if (!state) this.steps = [];
    this.tapped.clear();
    const nav = this.nav;
    this.nav = [];
    const frame: InputFrame = { actions: [], pause: presses.includes('pause'), confirm: presses.includes('confirm'), nav };
    if (!state) return frame;

    const a = frame.actions;
    for (const p of presses) if (p === 'rotCW' || p === 'rotCCW') a.push(p);
    a.push(...this.steps);
    this.steps = [];

    // Auto-repeat for held directions. Holding both cancels out.
    const repeat = (ticks: number) => ticks === 0 || (ticks >= REPEAT_DELAY && (ticks - REPEAT_DELAY) % REPEAT_EVERY === 0);
    if (left && !right) { if (repeat(this.leftTicks)) a.push('left'); this.leftTicks++; } else this.leftTicks = 0;
    if (right && !left) { if (repeat(this.rightTicks)) a.push('right'); this.rightTicks++; } else this.rightTicks = 0;

    if (down !== this.softOn) { this.softOn = down; a.push(down ? 'softOn' : 'softOff'); }

    // Mouse steering: walk the piece one column at a time toward the pointer.
    if (this.mouseColumn !== null && state.piece && !left && !right) {
      const p = state.piece;
      const wide = p.rot % 2 === 0;
      const target = Math.min(this.mouseColumn, BOARD_WIDTH - (wide ? 2 : 1));
      if (this.mouseCooldown > 0) this.mouseCooldown--;
      else if (target !== p.x) {
        a.push(target < p.x ? 'left' : 'right');
        this.mouseCooldown = MOUSE_STEP_TICKS - 1;
      }
    }
    return frame;
  }

  /** Forget held keys and soft drop, e.g. when the game pauses. */
  reset(): Action[] {
    this.releaseAll();
    this.leftTicks = this.rightTicks = 0;
    this.presses = [];
    this.steps = [];
    if (this.softOn) { this.softOn = false; return ['softOff']; }
    return [];
  }
}
