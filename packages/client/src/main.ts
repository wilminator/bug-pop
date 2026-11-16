// App shell: menus, the fixed-rate game loop, saving, and wiring input,
// rendering and sound together.

import { createGame, step, MAX_LEVEL, TICKS_PER_SECOND, BOARD_WIDTH, type GameEvent, type GameState, type Action } from '@bug-pop/engine';
import './style.css';
import { AudioManager } from './audio';
import { InputManager, type InputFrame, type Nav } from './input';
import { computeLayout, LEAVE_MS, render, thumbnail, type Layout, type Leaver } from './render';
import { httpCloud, makeRecord, newest, noCloud, recordState, timeAgo, type CloudSave, type SaveRecord } from './cloud';
import { inSeason, loadSprites, testSkin, type Skin } from './skin';
import { clearGame, loadGame, loadRecord, loadSettings, requestPersistence, saveGame, saveSettings, type Settings } from './storage';

type Mode = 'menu' | 'offer' | 'playing' | 'paused' | 'result';
type SiteConfig = { skin?: string; api?: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TICK_MS = 1000 / TICKS_PER_SECOND;
const AUTO_NEXT_MS = 2500;

/** A deployment can drop a config.json next to the page to pick a skin and a server. */
async function loadConfig(): Promise<SiteConfig> {
  try {
    const res = await fetch('config.json', { cache: 'no-cache' });
    return res.ok ? ((await res.json()) as SiteConfig) : {};
  } catch {
    return {};
  }
}

async function loadSkin(cfg: SiteConfig): Promise<Skin> {
  if (loadSettings().look === 'test' || new URLSearchParams(location.search).get('skin') === 'test') return testSkin;
  try {
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

const unfinished = (s: GameState | null): s is GameState => !!s && s.phase !== 'won' && s.phase !== 'lost';

async function main() {
  const cfg = await loadConfig();
  // No server configured (the open-source build): cloud save is simply off.
  const cloud: CloudSave = cfg.api ? httpCloud(cfg.api) : noCloud;
  const signIn = cloud.check(); // runs while the skin loads
  const loaded = await loadSkin(cfg);
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
  Object.defineProperty(window, 'bugpop', { value: { get state() { return state; }, get mode() { return mode; }, get cell() { return layout.cell; } } });
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
  input.attachSwipe(canvas, () => layout.cell);
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
  const overlays = { menu: $('menu'), offer: $('offer'), paused: $('paused'), result: $('result') };
  const show = (m: Mode) => {
    mode = m;
    overlays.menu.hidden = m !== 'menu';
    overlays.offer.hidden = m !== 'offer';
    overlays.paused.hidden = m !== 'paused';
    overlays.result.hidden = m !== 'result';
    input.capture = m === 'playing';
    const visible = Object.values(overlays).find(o => !o.hidden);
    visible?.querySelector<HTMLElement>('button.primary:not([hidden])')?.focus({ preventScroll: true });
  };

  const save = () => { if (state && (mode === 'playing' || mode === 'paused')) saveGame(state); };
  /** Single player only: copy the game to the player's account so another device can pick it up. */
  const upload = () => { if (state && cloud.signedIn) cloud.put(makeRecord(state)); };

  // ---- Settings form ----
  const level = $<HTMLInputElement>('level'), levelOut = $<HTMLOutputElement>('levelOut');
  const speed = $<HTMLSelectElement>('speed'), colors = $<HTMLSelectElement>('colors');
  const exitSel = $<HTMLSelectElement>('exit');
  const autoNext = $<HTMLInputElement>('autoNext');
  const shapes = $<HTMLInputElement>('shapes'), sound = $<HTMLInputElement>('sound'), music = $<HTMLInputElement>('music');
  const fillForm = () => {
    level.value = String(settings.level);
    levelOut.value = String(settings.level);
    speed.value = String(settings.speed);
    colors.value = String(settings.colors);
    shapes.checked = settings.shapesOnPieces;
    autoNext.checked = settings.autoNext;
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
      autoNext: autoNext.checked,
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

  /** startScore carries the score over when moving on to the next level. */
  const newGame = (lvl = settings.level, startScore = 0) => {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    state = createGame({ seed, level: lvl, speed: settings.speed, colors: settings.colors, startScore });
    input.reset(); // a fresh game starts with soft drop off
    pendingActions = [];
    saveGame(state);
    upload(); // the new game replaces the old save everywhere
    audio.play('select');
    audio.startMusic(true);
    show('playing');
  };

  const pause = (note = 'Your game is saved.') => {
    if (mode !== 'playing') return;
    pendingActions.push(...input.reset());
    $('pausedNote').textContent = note;
    save();
    upload();
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
    show('menu');
  };

  // ---- Single player: offer the newest saved game (this device's or the cloud's) ----
  let offered: SaveRecord | null = null;
  const showOffer = (rec: SaveRecord, s: GameState) => {
    offered = rec;
    const shot = $('offerShot');
    shot.replaceChildren(thumbnail(s, skin, images, settings.shapesOnPieces));
    const where = loadRecord()?.savedAt === rec.savedAt ? 'on this device' : `on your ${rec.device}`;
    $('offerText').textContent = `Level ${s.config.level}, ${s.bugsLeft} bugs left, score ${s.score}. Saved ${where}, ${timeAgo(rec.savedAt)}.`;
    show('offer');
  };
  const findSave = async (): Promise<SaveRecord | null> => {
    const local = loadRecord();
    const remote = await cloud.get();
    const best = newest(local, remote);
    if (best && unfinished(recordState(best))) return best;
    const other = best === local ? remote : local; // the newest was damaged or finished
    return other && unfinished(recordState(other)) ? other : null;
  };
  const singlePlayer = async () => {
    audio.unlock();
    readForm();
    const rec = await findSave();
    const s = rec && recordState(rec);
    if (rec && s) showOffer(rec, s);
    else newGame();
  };
  $('newGame').addEventListener('click', () => void singlePlayer());
  $('offerResume').addEventListener('click', () => {
    const s = offered && recordState(offered);
    if (!s) { newGame(); return; }
    state = s;
    if (offered!.savedAt !== loadRecord()?.savedAt) saveGame(state); // keep a local copy of a cloud save
    input.reset();
    pendingActions = [];
    resume();
  });
  $('offerNew').addEventListener('click', () => newGame());
  $('offerBack').addEventListener('click', () => show('menu'));
  $('resume').addEventListener('click', resume);
  $('quit').addEventListener('click', toMenu);
  $('toMenu').addEventListener('click', () => { state = null; clearGame(); toMenu(); });
  // Play again repeats the level with the score it started with; Next level keeps the score.
  $('retry').addEventListener('click', () => newGame(state?.config.level, state?.config.startScore));
  $('nextLevel').addEventListener('click', () => newGame(Math.min(MAX_LEVEL, (state?.config.level ?? 0) + 1), state?.score));

  const finish = (won: boolean) => {
    if (!state) return;
    clearGame();
    if (cloud.signedIn) cloud.remove(); // a finished game is nothing to resume
    audio.stopMusic();
    audio.play(won ? 'win' : 'lose');
    $('resultTitle').textContent = won ? 'Cleared!' : 'Game over';
    $('resultText').textContent = won
      ? `Level ${state.config.level} cleared. Score ${state.score}.`
      : `${state.bugsLeft} bugs left on level ${state.config.level}. Score ${state.score}.`;
    $('nextLevel').hidden = !won || state.config.level >= MAX_LEVEL;
    show('result');
    // Auto-advance: a short beat to see "Cleared!", then the next level starts by itself.
    // Any button on the result screen still works and cancels it.
    if (won && settings.autoNext && state.config.level < MAX_LEVEL) {
      const next = state.config.level + 1;
      const startedFor = state;
      $('resultText').textContent += ` Level ${next} starts in a moment...`;
      setTimeout(() => {
        // Skip if the player already chose something, or switched away (it would start unseen).
        if (mode === 'result' && state === startedFor && !document.hidden) newGame(next, startedFor.score);
      }, AUTO_NEXT_MS);
    }
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
    if (state) render(ctx, state, skin, layout, { shapesOnPieces: settings.shapesOnPieces, reducedMotion, time: now, images, leavers, hidden: mode === 'paused', bugExit: settings.exit || undefined });
    else {
      ctx.fillStyle = skin.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  /** If the account holds a newer game than this device (played elsewhere), offer it. */
  const offerNewerCloud = async (): Promise<boolean> => {
    const local = loadRecord();
    const remote = await cloud.get();
    const remoteState = remote && recordState(remote);
    if (!remote || !unfinished(remoteState) || newest(local, remote) !== remote || remote.savedAt === local?.savedAt) return false;
    if (mode !== 'menu' && mode !== 'paused') return false; // the player started something meanwhile
    state = null;
    audio.stopMusic();
    showOffer(remote, remoteState);
    return true;
  };
  // Coming back to an app left open: the game may have moved on on another device.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && cloud.signedIn) void offerNewerCloud(); });

  // ---- Start: an unfinished game opens paused, right where it was left ----
  // If the player's account holds a newer game from another device, offer that instead.
  await signIn;
  mode = 'menu';
  if (await offerNewerCloud()) {
    // showing the offer
  } else if (unfinished(state)) {
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
