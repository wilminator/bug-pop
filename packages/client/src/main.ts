// App shell: menus, the fixed-rate game loop, saving, and wiring input,
// rendering and sound together.

import { createGame, step, TICKS_PER_SECOND, BOARD_WIDTH, type GameEvent, type GameState, type Action } from '@bug-pop/engine';
import './style.css';
import { AudioManager } from './audio';
import { InputManager, type InputFrame, type Nav } from './input';
import { computeLayout, LEAVE_MS, render, type Layout, type Leaver } from './render';
import { inSeason, loadSprites, testSkin, type Skin } from './skin';
import { clearGame, loadGame, loadSettings, requestPersistence, saveGame, saveSettings, type Settings } from './storage';

type Mode = 'menu' | 'playing' | 'paused' | 'result';
type SiteConfig = { skin?: string; api?: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TICK_MS = 1000 / TICKS_PER_SECOND;

/** A deployment can drop a config.json next to the page to pick a skin. */
async function loadSkin(): Promise<Skin> {
  if (loadSettings().look === 'test' || new URLSearchParams(location.search).get('skin') === 'test') return testSkin;
  try {
    const res = await fetch('config.json', { cache: 'no-cache' });
    if (!res.ok) return testSkin;
    const cfg = (await res.json()) as SiteConfig;
    if (!cfg.skin) return testSkin;
    const skinUrl = new URL(cfg.skin, location.href);
    const skin = (await (await fetch(skinUrl)).json()) as Skin;
    // Sound and music paths in skin.json are relative to the skin file.
    const rel = (p: string) => new URL(p, skinUrl).href;
    if (skin.sounds) for (const k of Object.keys(skin.sounds) as (keyof NonNullable<Skin['sounds']>)[]) skin.sounds[k] = rel(skin.sounds[k]!);
    if (skin.music) skin.music = skin.music.map(rel);
    if (skin.sprites) {
      skin.sprites.bug = skin.sprites.bug.map(rel);
      skin.sprites.half = skin.sprites.half.map(rel);
      if (skin.sprites.bugAlt) skin.sprites.bugAlt = skin.sprites.bugAlt.map(rel);
    }
    return skin.pieces?.length >= 5 ? skin : testSkin;
  } catch {
    return testSkin;
  }
}

async function main() {
  const loaded = await loadSkin();
  const skin = inSeason(loaded) ? loaded : testSkin;
  const images = await loadSprites(skin);
  let leavers: Leaver[] = [];
  let matchedBugs: Leaver[] = [];
  const canvas = $<HTMLCanvasElement>('board');
  const ctx = canvas.getContext('2d')!;
  const touchBar = $('touch');
  const input = new InputManager();
  const audio = new AudioManager(skin);
  let settings: Settings = loadSettings();
  let state: GameState | null = loadGame();
  let mode: Mode = 'menu';
  let layout: Layout = computeLayout(1, 1, 0);
  let pendingActions: Action[] = [];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  requestPersistence();
  // Read-only handle for debugging and automated browser tests.
  Object.defineProperty(window, 'bugpop', { value: { get state() { return state; }, get mode() { return mode; } } });
  audio.soundOn = settings.sound;
  audio.musicOn = settings.music;

  // ---- Sizing ----
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * devicePixelRatio);
    canvas.height = Math.round(rect.height * devicePixelRatio);
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    layout = computeLayout(rect.width, rect.height, 0);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---- Touch controls appear once the device shows it is touch-first ----
  const showTouch = (on: boolean) => { touchBar.hidden = !on; };
  showTouch(matchMedia('(pointer: coarse)').matches);
  input.onDevice = kind => { if (kind === 'touch') showTouch(true); else if (kind === 'keyboard' || kind === 'gamepad') showTouch(false); };
  window.addEventListener('touchstart', () => showTouch(true), { passive: true });
  input.attachTouchButtons(touchBar);
  input.attachMouse(canvas, clientX => {
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left - layout.boardX) / layout.cell);
    return col >= -2 && col <= BOARD_WIDTH + 1 ? Math.max(0, Math.min(BOARD_WIDTH - 1, col)) : null;
  });

  // Audio may only start from a user gesture.
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // ---- Screens ----
  const overlays = { menu: $('menu'), paused: $('paused'), result: $('result') };
  const show = (m: Mode) => {
    mode = m;
    overlays.menu.hidden = m !== 'menu';
    overlays.paused.hidden = m !== 'paused';
    overlays.result.hidden = m !== 'result';
    input.capture = m === 'playing';
    const visible = Object.values(overlays).find(o => !o.hidden);
    visible?.querySelector<HTMLElement>('button.primary:not([hidden])')?.focus({ preventScroll: true });
  };

  const save = () => { if (state && (mode === 'playing' || mode === 'paused')) saveGame(state); };

  // ---- Settings form ----
  const level = $<HTMLInputElement>('level'), levelOut = $<HTMLOutputElement>('levelOut');
  const speed = $<HTMLSelectElement>('speed'), colors = $<HTMLSelectElement>('colors');
  const exitSel = $<HTMLSelectElement>('exit');
  const shapes = $<HTMLInputElement>('shapes'), sound = $<HTMLInputElement>('sound'), music = $<HTMLInputElement>('music');
  const fillForm = () => {
    level.value = String(settings.level);
    levelOut.value = String(settings.level);
    speed.value = String(settings.speed);
    colors.value = String(settings.colors);
    shapes.checked = settings.shapesOnPieces;
    sound.checked = settings.sound;
    music.checked = settings.music;
    exitSel.value = settings.exit;
  };
  const readForm = () => {
    settings = {
      level: Number(level.value),
      speed: Number(speed.value) as Settings['speed'],
      colors: Number(colors.value),
      shapesOnPieces: shapes.checked,
      sound: sound.checked,
      music: music.checked,
      exit: exitSel.value as Settings['exit'],
      look: settings.look,
    };
    levelOut.value = level.value;
    audio.soundOn = settings.sound;
    audio.musicOn = settings.music;
    if (!settings.music) audio.stopMusic();
    saveSettings(settings);
  };
  $('settings').addEventListener('input', readForm);
  // Changing the look reloads the page; the game in progress is saved first.
  const look = $<HTMLSelectElement>('look');
  look.value = settings.look;
  if (skin === testSkin && settings.look !== 'test') look.querySelector('option[value="site"]')!.textContent = 'Default (test pattern)';
  else look.querySelector('option[value="site"]')!.textContent = skin.name;
  look.addEventListener('change', () => { settings.look = look.value as Settings['look']; saveSettings(settings); location.reload(); });
  fillForm();

  const newGame = (lvl = settings.level) => {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    state = createGame({ seed, level: lvl, speed: settings.speed, colors: settings.colors });
    input.reset(); // a fresh game starts with soft drop off
    pendingActions = [];
    saveGame(state);
    audio.play('select');
    audio.startMusic(true);
    show('playing');
  };

  const pause = (note = 'Your game is saved.') => {
    if (mode !== 'playing') return;
    pendingActions.push(...input.reset());
    $('pausedNote').textContent = note;
    save();
    audio.pauseMusic();
    audio.play('pause');
    show('paused');
  };

  const resume = () => {
    if (!state) return;
    audio.unlock();
    audio.startMusic();
    show('playing');
  };

  const toMenu = () => {
    save();
    audio.stopMusic();
    $('continue').hidden = !(state && (state.phase !== 'won' && state.phase !== 'lost'));
    show('menu');
  };

  $('newGame').addEventListener('click', () => { audio.unlock(); readForm(); newGame(); });
  $('continue').addEventListener('click', resume);
  $('resume').addEventListener('click', resume);
  $('quit').addEventListener('click', toMenu);
  $('toMenu').addEventListener('click', () => { state = null; clearGame(); toMenu(); });
  $('retry').addEventListener('click', () => newGame(state?.config.level));
  $('nextLevel').addEventListener('click', () => newGame(Math.min(20, (state?.config.level ?? 0) + 1)));

  const finish = (won: boolean) => {
    if (!state) return;
    clearGame();
    audio.stopMusic();
    audio.play(won ? 'win' : 'lose');
    $('resultTitle').textContent = won ? 'Cleared!' : 'Game over';
    $('resultText').textContent = won
      ? `Level ${state.config.level} cleared. Score ${state.score}.`
      : `${state.bugsLeft} bugs left on level ${state.config.level}. Score ${state.score}.`;
    $('nextLevel').hidden = !won;
    show('result');
  };

  const onEvents = (events: GameEvent[]) => {
    for (const e of events) {
      switch (e.type) {
        case 'move': audio.play('move'); break;
        case 'rotate': audio.play('rotate'); break;
        case 'lock': audio.play('lock'); save(); break;
        case 'match': {
          audio.play(e.chain > 1 ? 'chain' : 'pop', 1 + Math.min(e.chain - 1, 4) * 0.12);
          const now = performance.now();
          matchedBugs = e.cells.flatMap(i => {
            const cell = state!.board[i];
            if (!cell) return [];
            const kind = cell.t === 'bug' ? 'bug' as const : 'piece' as const;
            return [{ kind, x: i % BOARD_WIDTH, y: Math.floor(i / BOARD_WIDTH), c: cell.c, t0: now, dir: (i % 2 ? 1 : -1) as 1 | -1 }];
          });
          break;
        }
        case 'cleared': {
          const now = performance.now();
          leavers.push(...matchedBugs.map(l => ({ ...l, t0: now })));
          matchedBugs = [];
          save();
          break;
        }
        case 'won': finish(true); break;
        case 'lost': finish(false); break;
      }
    }
  };

  // ---- Leaving the app: pause and save at once (iOS may kill us next) ----
  document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); save(); } });
  window.addEventListener('pagehide', save);
  document.addEventListener('freeze', save);
  window.addEventListener('blur', () => pause());

  // ---- Gamepad navigation for menus ----
  const focusables = () => {
    const o = Object.values(overlays).find(x => !x.hidden);
    return o ? [...o.querySelectorAll<HTMLElement>('button:not([hidden]), input, select, summary')].filter(el => el.offsetParent !== null) : [];
  };
  const navigate = (dir: Nav) => {
    const list = focusables();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const el = list[i];
    if ((dir === 'left' || dir === 'right') && el instanceof HTMLInputElement && el.type === 'range') {
      if (dir === 'left') el.stepDown(); else el.stepUp();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if ((dir === 'left' || dir === 'right') && el instanceof HTMLSelectElement) {
      el.selectedIndex = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + (dir === 'left' ? -1 : 1)));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const next = list[(i + (dir === 'up' || dir === 'left' ? -1 : 1) + list.length) % list.length];
      next?.focus();
    }
    audio.play('select');
  };
  const menuInput = (f: InputFrame) => {
    for (const d of f.nav) navigate(d);
    if (f.pause && mode === 'paused') resume();
    if (f.confirm) {
      const el = document.activeElement as HTMLElement | null;
      if (el && focusables().includes(el)) el.click();
    }
  };

  // ---- The loop: fixed 60 ticks per second, drawing every animation frame ----
  let last = performance.now();
  let acc = 0;
  const frame = (now: number) => {
    const dt = Math.min(now - last, 250); // after a stall, don't fast-forward the game
    last = now;
    if (mode === 'playing' && state) {
      acc += dt;
      while (acc >= TICK_MS && mode === 'playing') {
        const f = input.poll(state);
        if (f.pause) { pause(); break; }
        const actions = pendingActions.length ? [...pendingActions, ...f.actions] : f.actions;
        pendingActions = [];
        onEvents(step(state, actions));
        acc -= TICK_MS;
      }
    } else {
      acc = 0;
      menuInput(input.poll(null));
    }
    if (leavers.length) leavers = leavers.filter(l => now - l.t0 < LEAVE_MS);
    if (state) render(ctx, state, skin, layout, { shapesOnPieces: settings.shapesOnPieces, reducedMotion, time: now, images, leavers, bugExit: settings.exit || undefined });
    else {
      ctx.fillStyle = skin.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // ---- Start: an unfinished game opens paused, right where it was left ----
  if (state && state.phase !== 'won' && state.phase !== 'lost') {
    mode = 'playing';
    pause('Welcome back. Your game is right where you left it.');
  } else {
    state = null;
    toMenu();
  }

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('sw.js').catch(() => undefined);
  }
}

void main();
