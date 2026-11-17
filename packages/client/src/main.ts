// App shell: menus, the fixed-rate game loop, saving, and wiring input,
// rendering and sound together.

import { createGame, step, MAX_LEVEL, FINAL_LEVEL, isEndless, SLO_MO, SLO_MO_COLORS, currentLevel, TICKS_PER_SECOND, BOARD_WIDTH, type GameEvent, type GameState, type Action } from '@bug-pop/engine';
import './style.css';
import { AudioManager } from './audio';
import { InputManager, type InputFrame, type Nav } from './input';
import { computeLayout, LEAVE_MS, ARRIVE_MS, SWEEP_MS, render, thumbnail, type Layout, type Leaver, type Sweep } from './render';
import { fetchAccount, loginUrl, logout, personalizedAds, shownName, supporterBadge, wantsAds, type AccountStatus } from './account';
import { setAdSlot, type AdsConfig } from './ads';
import { httpCloud, makeRecord, newest, noCloud, recordState, timeAgo, type CloudSave, type SaveRecord } from './cloud';
import { frameCells, inSeason, loadSprites, testSkin, type Skin } from './skin';
import { isLayout, LAYOUTS, renderButtons, renderPreview } from './layouts';
import { cleanUpdateMarker, decline, shouldOffer, updateNow } from './update';
import { adoptSave, clearGame, loadGame, loadRecord, loadSettings, saveOwner, saveRecord, setPlayer, requestPersistence, saveGame, saveSettings, type Settings, loadProgress, recordBeaten, sliderMax, mergeProgress, settingsChangedAt } from './storage';
import { applySynced, httpSync, noSync, pickSynced, syncedDiffer, type Sync } from './sync';

// 'ending': the game is decided and the board stays on screen for a dramatic pause.
type Mode = 'title' | 'menu' | 'setup' | 'settings' | 'offer' | 'choose' | 'update' | 'playing' | 'paused' | 'ending' | 'result';
/**
 * config.json, written by each deployment (the open-source build ships one with just a skin):
 *   skin     skin.json to load
 *   api      game server base (turns on cloud save)
 *   privacy  link for the title page's Privacy link
 *   terms    link for the title page's Terms link
 *   ads      { preview: true } shows an outlined, empty ad space on the title page;
 *            { script: "..." } loads the deployment's own ad code (see src/ads.ts)
 */
type SiteConfig = { skin?: string; api?: string; privacy?: string; terms?: string; ads?: AdsConfig };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TICK_MS = 1000 / TICKS_PER_SECOND;
const AUTO_NEXT_MS = 2500;
// Dramatic pause between the last bug popping (or the board filling) and the result card.
// Long enough for the last bugs' exit animation (LEAVE_MS, 1.1 s) to finish and a beat of
// silence after it, short enough not to feel stuck. Competitive modes use the same pause
// before their win/lose card.
const FINISH_PAUSE_MS = 1800;
/** After a clean sweep the pause before the card runs this much longer, so the fireworks finish. */
const SWEEP_EXTRA_MS = 1000;

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
    if (skin.titleMusic) skin.titleMusic = rel(skin.titleMusic);
    if (skin.board?.inside) skin.board.inside = rel(skin.board.inside);
    if (skin.board?.frame) skin.board.frame = rel(skin.board.frame);
    if (skin.title?.background) skin.title.background = rel(skin.title.background);
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
  const sync: Sync = cfg.api ? httpSync(cfg.api) : noSync;
  const signIn = cloud.check(); // runs while the skin loads
  let account: AccountStatus = { kind: cfg.api ? 'unavailable' : 'off' };
  const accountCheck = fetchAccount(cfg.api).then((a) => { account = a; }); // also runs while the skin loads
  const loaded = await loadSkin(cfg);
  const skin = inSeason(loaded) ? loaded : testSkin;
  const images = await loadSprites(skin);
  let leavers: Leaver[] = [];
  /** Endless: cells whose new bug is crawling in, and when it set off. */
  let arrivals = new Map<number, number>();
  let matchedBugs: Leaver[] = [];
  let sweep: Sweep | null = null; // a clean sweep being celebrated
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
  cleanUpdateMarker();
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
    layout = computeLayout(rect.width, rect.height, 0, frameCells(skin));
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---- Touch controls appear once the device shows it is touch-first ----
  const topBar = $('topBar');
  let touchOn = false;
  // The pause button only shows during play; menus have their own buttons.
  const pauseOnTop = () => LAYOUTS[settings.touchLayout].pauseOnTop;
  // With touch, the layout decides whether Pause sits on top or in the button row. With a keyboard,
  // mouse or gamepad there is no button row, so Pause always sits on top (Esc / P still work).
  const pauseShownOnTop = () => mode === 'playing' && (!touchOn || pauseOnTop());
  // While a game is on screen the bar keeps its space even when Pause can't be used (the pause
  // before the result card, the card itself), so the board doesn't jump when it disappears.
  const gameOnScreen = () => mode === 'playing' || mode === 'ending' || mode === 'result' || mode === 'paused';
  const updateTopBar = () => {
    topBar.hidden = !(gameOnScreen() && (!touchOn || pauseOnTop()));
    topBar.classList.toggle('idle', !pauseShownOnTop());
  };
  const showTouch = (on: boolean) => { touchOn = on; touchBar.hidden = !on; updateTopBar(); };
  // Build the button row from the chosen layout. New buttons need their input handlers again.
  if (!isLayout(settings.touchLayout)) settings.touchLayout = 'edges';
  const applyLayout = () => {
    renderButtons(touchBar, settings.touchLayout);
    input.attachTouchButtons(touchBar);
    renderPreview($('layoutPreview'), settings.touchLayout);
  };
  showTouch(matchMedia('(pointer: coarse)').matches);
  input.onDevice = kind => { if (kind === 'touch') showTouch(true); else if (kind === 'keyboard' || kind === 'gamepad') showTouch(false); };
  window.addEventListener('touchstart', () => showTouch(true), { passive: true });
  applyLayout();
  input.attachTouchButtons(topBar);
  input.attachSwipe(canvas, () => layout.cell);

  // Touch players get a reminder of the gestures over the board for their first few
  // games. The game waits while it is up; the first touch anywhere dismisses it
  // (and is swallowed, so it doesn't also turn or move the piece).
  const hint = $('touchHint');
  let hintUp = false;
  const HINT_KEY = 'bugpop.touchHints.v1';
  const showHint = () => {
    let shown = 0;
    try { shown = Number(localStorage.getItem(HINT_KEY)) || 0; } catch { /* private mode */ }
    if (touchBar.hidden || shown >= 3) return;
    try { localStorage.setItem(HINT_KEY, String(shown + 1)); } catch { /* ignore */ }
    hint.classList.remove('fade');
    hint.hidden = false;
    hintUp = true;
    const hide = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      window.removeEventListener('pointerdown', hide, true);
      hintUp = false;
      pendingActions.push(...input.reset());
      hint.classList.add('fade');
      setTimeout(() => { hint.hidden = true; }, 400);
    };
    window.addEventListener('pointerdown', hide, true);
  };
  input.attachMouse(canvas, clientX => {
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left - layout.boardX) / layout.cell);
    return col >= -2 && col <= BOARD_WIDTH + 1 ? Math.max(0, Math.min(BOARD_WIDTH - 1, col)) : null;
  });

  // Audio may only start from a user gesture.
  // The menus have their own title music. Browsers only allow sound after the first tap or
  // key press, so it starts then if a menu is showing.
  const titleScreens: Mode[] = ['title', 'menu', 'setup', 'settings', 'offer'];
  const unlock = () => { audio.unlock(); if (titleScreens.includes(mode)) audio.title(true); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // ---- Screens ----
  const overlays = { title: $('title'), menu: $('menu'), setup: $('setup'), settings: $('settingsScreen'), offer: $('offer'), choose: $('choose'), update: $('update'), paused: $('paused'), result: $('result') };
  // A skin may paint its own picture behind the title page and the menu screens (CSS: html.has-art).
  if (skin.title?.background) {
    document.documentElement.style.setProperty('--title-bg', `url(${JSON.stringify(skin.title.background)})`);
    document.documentElement.classList.add('has-art');
  }
  // Ads show on the title page and on Choose a game only, never elsewhere, and only if this player may see them.
  const refreshAds = () => {
    const want = wantsAds(!!cfg.ads, account), personalized = personalizedAds(account);
    void setAdSlot($('adSlot'), cfg.ads, want && mode === 'title', personalized);
    void setAdSlot($('menuAdSlot'), cfg.ads, want && mode === 'menu', personalized);
  };
  const show = (m: Mode) => {
    mode = m;
    audio.title(titleScreens.includes(m));
    overlays.title.hidden = m !== 'title';
    overlays.menu.hidden = m !== 'menu';
    overlays.setup.hidden = m !== 'setup';
    overlays.settings.hidden = m !== 'settings';
    overlays.offer.hidden = m !== 'offer';
    overlays.choose.hidden = m !== 'choose';
    overlays.update.hidden = m !== 'update';
    updateTopBar();
    overlays.paused.hidden = m !== 'paused';
    overlays.result.hidden = m !== 'result';
    input.capture = m === 'playing';
    const visible = Object.values(overlays).find(o => !o.hidden);
    visible?.querySelector<HTMLElement>('button[data-primary]:not([hidden])')?.focus({ preventScroll: true });
    refreshAds();
    if (m === 'menu' || m === 'setup') void refreshResume();
  };

  const save = () => { if (state && (mode === 'playing' || mode === 'paused')) saveGame(state); };
  /** Single player only: copy the game to the player's account so another device can pick it up. */
  // Only a game this account owns goes up: a game played before signing in (or by another account)
  // must never silently replace the account's game. reconcileSaves() settles that first.
  // The record is the local one, timestamp included, so both copies compare as the same game.
  const mySub = () => (account.kind === 'signedIn' ? account.me.sub : null);
  const upload = () => {
    const sub = mySub(), rec = loadRecord();
    if (state && rec && cloud.signedIn && sub && saveOwner() === sub) cloud.put(rec);
  };

  // ---- Settings form ----
  const level = $<HTMLInputElement>('level'), levelOut = $<HTMLOutputElement>('levelOut');
  const speed = $<HTMLSelectElement>('speed'), colors = $<HTMLSelectElement>('colors');
  const exitSel = $<HTMLSelectElement>('exit');
  const autoNext = $<HTMLInputElement>('autoNext');
  const touchLayoutSel = $<HTMLSelectElement>('touchLayout');
  const shapes = $<HTMLInputElement>('shapes'), sound = $<HTMLInputElement>('sound'), music = $<HTMLInputElement>('music');
  /** "Level 7", or "Endless round 3" past the final level. */
  const levelName = (l: number) => (isEndless(l) ? `Endless round ${l - FINAL_LEVEL}` : `Level ${l}`);
  /**
   * The slider reaches the first level not yet beaten at the chosen speed (0 to 20 are always open).
   * Once level 100 is beaten at that speed, one more notch past it starts Endless.
   */
  /** Slo-mo is offered only with 4 or 5 colors; with fewer it is hidden and a Slo-mo choice drops to Low. */
  const fitSpeeds = () => {
    const ok = Number(colors.value) >= SLO_MO_COLORS;
    const opt = $<HTMLOptionElement>('sloMo');
    opt.hidden = opt.disabled = !ok;
    if (!ok && Number(speed.value) === SLO_MO) speed.value = '0';
  };
  const fitSlider = () => {
    const sp = Number(speed.value) as Settings['speed'];
    const beaten = loadProgress().beaten[sp];
    const max = beaten >= FINAL_LEVEL ? FINAL_LEVEL + 1 : sliderMax(loadProgress(), sp, FINAL_LEVEL);
    level.max = String(max);
    if (Number(level.value) > max) level.value = String(max);
    levelOut.value = isEndless(Number(level.value)) ? 'Endless' : level.value;
  };
  const fillForm = () => {
    speed.value = String(settings.speed);
    fitSlider();
    level.value = String(settings.level);
    fitSlider();
    speed.value = String(settings.speed);
    colors.value = String(settings.colors);
    fitSpeeds();
    fitSlider();
    shapes.checked = settings.shapesOnPieces;
    autoNext.checked = settings.autoNext;
    touchLayoutSel.value = settings.touchLayout;
    sound.checked = settings.sound;
    music.checked = settings.music;
    exitSel.value = settings.exit;
  };
  /** A signed-in player's game settings go to their account a moment after the last change. */
  let pushTimer = 0;
  const pushSettings = () => {
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => sync.pushSettings(pickSynced(settings)), 800);
  };
  const readForm = () => {
    const before = settings;
    fitSpeeds(); // the color count decides whether Slo-mo is on offer
    fitSlider(); // the speed may have changed, and with it how far the slider goes
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
      touchLayout: isLayout(touchLayoutSel.value) ? touchLayoutSel.value : 'edges',
    };
    if (touchBar.dataset.layout !== settings.touchLayout) applyLayout();
    audio.soundOn = settings.sound;
    audio.musicOn = settings.music;
    if (!settings.music) audio.stopMusic();
    audio.title(settings.music && titleScreens.includes(mode));
    saveSettings(settings);
    if (cloud.signedIn && syncedDiffer(before, settings)) pushSettings();
  };
  $('settings').addEventListener('input', readForm);
  $('setupForm').addEventListener('input', readForm);
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
    arrivals = new Map();
    sweep = null;
    saveGame(state);
    upload(); // the new game replaces the old save everywhere
    showHint();
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

  // ---- New version check: before a game starts or resumes. Single player may skip it. ----
  let keepPlaying: (() => void) | null = null;
  const updateGate = async () => {
    if (!(await shouldOffer())) return;
    const back = mode;
    show('update');
    await new Promise<void>(res => { keepPlaying = () => { decline(); show(back); res(); }; });
  };
  // The menus check too: a phone app left open for days would otherwise only learn of an update
  // when a game starts. Declining ("Keep playing this version") stops the nagging for that version.
  const menuModes: Mode[] = ['title', 'menu', 'setup'];
  const checkUpdateInMenus = async () => {
    if (!menuModes.includes(mode) || !(await shouldOffer()) || !menuModes.includes(mode)) return;
    await updateGate();
  };
  $('updateLater').addEventListener('click', () => keepPlaying?.());
  $('updateNow').addEventListener('click', () => {
    if (unfinished(state)) { saveGame(state); upload(); } // reopens paused, right where it was
    void updateNow();
  });

  const resume = async () => {
    if (!state) return;
    audio.unlock();
    await updateGate();
    if (!state) return;
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
    const where = loadRecord()?.state === rec.state ? 'on this device' : `on your ${rec.device}`;
    $('offerText').textContent = `${levelName(currentLevel(s))}, ${s.bugsLeft} bugs left, score ${s.score}. Saved ${where}, ${timeAgo(rec.savedAt)}.`;
    show('offer');
  };
  let offerBackTo: Mode = 'setup';
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
    if (await reconcileSaves()) return; // a clash the server was too slow to show at start-up
    readForm();
    await updateGate();
    const rec = await findSave();
    const s = rec && recordState(rec);
    offerBackTo = 'setup';
    if (rec && s) showOffer(rec, s);
    else newGame();
  };
  // The "Resume level N" tag on the Single player card, and the Start button's wording.
  const resumeTag = $('resumeTag'), startBtn = $('start');
  const refreshResume = async () => {
    const rec = await findSave();
    const s = rec && recordState(rec);
    resumeTag.hidden = !s;
    if (s) resumeTag.textContent = `Resume ${levelName(currentLevel(s))}`;
    startBtn.textContent = s ? 'Resume or start new' : 'Start';
  };
  $('newGame').addEventListener('click', () => { audio.play('select'); show('setup'); });
  $('start').addEventListener('click', () => void singlePlayer());
  $('offerResume').addEventListener('click', () => {
    const s = offered && recordState(offered);
    if (!s) { newGame(); return; }
    state = s;
    if (offered!.state !== loadRecord()?.state) saveRecord(offered!, mySub() ?? ''); // keep a local copy of a cloud save
    input.reset();
    pendingActions = [];
    resume();
  });
  $('offerNew').addEventListener('click', () => newGame());

  // ---- Title page: the first screen on a fresh start ----
  $('play').addEventListener('click', () => { audio.unlock(); audio.play('select'); show('menu'); void checkUpdateInMenus(); });
  if (cfg.privacy) { const a = $<HTMLAnchorElement>('privacyLink'); a.href = cfg.privacy; a.hidden = false; }
  if (cfg.terms) { const a = $<HTMLAnchorElement>('termsLink'); a.href = cfg.terms; a.hidden = false; }
  // Account box: Sign in when the server says we're signed out; name and Sign out when signed in.
  // Hidden on the open-source build (no server) and whenever the server doesn't answer.
  const showAccount = () => {
    $('accountSlot').hidden = account.kind !== 'signedOut' && account.kind !== 'signedIn';
    $('signedOut').hidden = account.kind !== 'signedOut';
    $('signedIn').hidden = account.kind !== 'signedIn';
    if (account.kind === 'signedIn') {
      const name = shownName(account.me);
      const who = $('whoName');
      who.textContent = '';
      if (name) { const b = document.createElement('b'); b.textContent = name; who.append(' as ', b); }
      const badge = supporterBadge(account.me);
      $('whoBadge').hidden = !badge;
    }
    refreshAds();
  };
  showAccount();
  $('signIn').addEventListener('click', () => {
    audio.play('select');
    // Off to the account site; the server brings the browser back to this page.
    location.assign(loginUrl(cfg.api!, location.pathname + location.search));
  });
  $('signOut').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('signOut');
    btn.disabled = true;
    if (await logout(cfg.api!)) {
      account = { kind: 'signedOut' };
      setPlayer(null);
      await cloud.check(); // stops cloud uploads; the local save stays on this device
    }
    btn.disabled = false;
    showAccount();
  });
  // Back (top left) and the Settings gear (top right) on every menu screen after the title.
  let settingsFrom: Mode = 'menu';
  const backTo = (): Mode => (mode === 'menu' ? 'title' : mode === 'setup' ? 'menu' : mode === 'settings' ? settingsFrom : offerBackTo);
  document.querySelectorAll<HTMLElement>('[data-back]').forEach(b => b.addEventListener('click', () => { audio.play('select'); show(backTo()); }));
  document.querySelectorAll<HTMLElement>('[data-gear]').forEach(b => b.addEventListener('click', () => { audio.play('select'); settingsFrom = mode; show('settings'); }));
  $('resume').addEventListener('click', resume);
  $('quit').addEventListener('click', toMenu);
  $('toMenu').addEventListener('click', () => { state = null; clearGame(); toMenu(); });
  // Play again repeats the level with the score it started with; Next level keeps the score.
  $('retry').addEventListener('click', async () => { const s = state; await updateGate(); newGame(s?.config.level, s?.config.startScore); });
  $('nextLevel').addEventListener('click', async () => { const s = state; await updateGate(); newGame(Math.min(MAX_LEVEL, (s?.config.level ?? 0) + 1), s?.score); });

  const finish = (won: boolean) => {
    if (!state) return;
    // Progress first: it is what unlocks the next level on the slider.
    if (won && !isEndless(state.config.level)) {
      const p = recordBeaten(state.config.speed, state.config.level);
      fitSlider();
      if (cloud.signedIn) void sync.mergeProgress(p.beaten).then(m => { if (m) { mergeProgress(m); fitSlider(); } });
    }
    clearGame();
    if (cloud.signedIn) cloud.remove(); // a finished game is nothing to resume
    audio.stopMusic(); // the music cuts out at the moment it is decided...
    show('ending'); // ...the board stays visible, inputs stop, the last bugs fly off
    const decided = state;
    // A clean sweep gets its fireworks played out before the card comes up.
    const pauseMs = sweep && performance.now() - sweep.t0 < SWEEP_MS ? FINISH_PAUSE_MS + SWEEP_EXTRA_MS : FINISH_PAUSE_MS;
    setTimeout(() => {
      if (state !== decided || mode !== 'ending') return;
      showResult(won);
    }, pauseMs);
  };

  const showResult = (won: boolean) => {
    if (!state) return;
    audio.play(won ? 'win' : 'lose'); // ...and the jingle arrives with the card
    const lvl = currentLevel(state), endless = isEndless(lvl), beatGame = won && lvl === FINAL_LEVEL;
    $('resultTitle').textContent = beatGame ? 'You beat Bug Pop!' : won ? 'Cleared!' : endless ? 'Endless run over' : 'Game over';
    $('resultText').textContent = beatGame
      ? `Level ${FINAL_LEVEL} cleared. Score ${state.score}. Endless mode is now open at this speed.`
      : won
        ? `${levelName(lvl)} cleared. Score ${state.score}.`
        : `${state.bugsLeft} bugs left on ${levelName(lvl).toLowerCase()}. Score ${state.score}.`;
    $('nextLevel').hidden = !won || lvl >= MAX_LEVEL;
    $('nextLevel').textContent = beatGame ? 'Play Endless' : endless ? 'Next round' : 'Next level';
    show('result');
    // Auto-advance: a short beat to see "Cleared!", then the next level starts by itself.
    // Endless always rolls on; beating the game always waits, so the moment isn't skipped.
    // Any button on the result screen still works and cancels it.
    if (won && !beatGame && (settings.autoNext || endless) && lvl < MAX_LEVEL) {
      const next = lvl + 1;
      const startedFor = state;
      $('resultText').textContent += ` ${levelName(next)} starts in a moment...`;
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
        case 'fall': audio.play('fall'); break;
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
        case 'arrive': {
          // The next Endless round: bugs crawl in one after another, about a second in all.
          const now = performance.now(), gap = Math.min(14, 500 / Math.max(1, e.cells.length));
          arrivals = new Map(e.cells.map((cell, k) => [cell, now + k * gap]));
          audio.play('select');
          save();
          break;
        }
        case 'cleanSweep': {
          sweep = { t0: performance.now(), bonus: e.bonus };
          audio.play('sweep');
          // A pop with each firework burst (they go off every 260 ms; see drawSweep).
          if (!reducedMotion) for (let k = 1; k < 7; k++) setTimeout(() => audio.play('pop', 0.7 + (k % 3) * 0.2), k * 260);
          break;
        }
        case 'won': finish(true); break;
        case 'lost': finish(false); break;
      }
    }
  };

  // ---- Leaving the app: pause and save at once (iOS may kill us next) ----
  // Sound is frozen whenever the page is hidden, on menus and the title screen too.
  document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); save(); audio.suspend(); } else { audio.wake(); void checkUpdateInMenus(); } });
  window.addEventListener('pagehide', () => { pause(); save(); audio.suspend(); });
  window.addEventListener('pageshow', () => { if (!document.hidden) audio.wake(); });
  document.addEventListener('freeze', () => { pause(); save(); audio.suspend(); });
  document.addEventListener('resume', () => { if (!document.hidden) audio.wake(); });
  // Switching to another app on a computer only blurs the window (it can still be visible), so sound stops then too.
  window.addEventListener('blur', () => { pause(); audio.suspend(); });
  window.addEventListener('focus', () => { if (!document.hidden) audio.wake(); });

  // ---- Gamepad navigation for menus ----
  const focusables = () => {
    const o = Object.values(overlays).find(x => !x.hidden);
    return o ? [...o.querySelectorAll<HTMLElement>('button:not([hidden]):not(:disabled), input, select, summary')].filter(el => el.offsetParent !== null) : [];
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
    const gap = now - last;
    const dt = Math.min(gap, 250); // after a stall, don't fast-forward the game
    last = now;
    // Some phone browsers freeze the page without telling it. Frames stopping for over a second
    // while a game runs means we were in the background: pause so the player comes back to a pause.
    if (gap > 1000 && mode === 'playing' && !hintUp) pause();
    if (mode === 'playing' && state && !hintUp) {
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
    if (sweep && now - sweep.t0 >= SWEEP_MS) sweep = null;
    if (arrivals.size && [...arrivals.values()].every(t0 => now - t0 >= ARRIVE_MS)) arrivals = new Map();
    if (state) render(ctx, state, skin, layout, { shapesOnPieces: settings.shapesOnPieces, reducedMotion, time: now, images, leavers, arrivals, hidden: mode === 'paused', bugExit: settings.exit || undefined, sweep });
    else {
      ctx.fillStyle = skin.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  /**
   * Signed in: take the account's game settings if they changed more recently than this device's
   * (otherwise send ours up), and merge unlocked levels both ways.
   */
  const syncFromAccount = async () => {
    const remote = await sync.pullSettings();
    if (remote && remote.updatedAt > settingsChangedAt()) {
      const next = applySynced(settings, remote.settings);
      if (syncedDiffer(settings, next)) {
        saveSettings(next, remote.updatedAt);
        settings = next;
        fillForm();
        readForm(); // applies sound and music; nothing changed, so nothing is sent back
      }
    } else if (settingsChangedAt() > 0) {
      sync.pushSettings(pickSynced(settings));
    }
    const merged = await sync.mergeProgress(loadProgress().beaten);
    if (merged) { mergeProgress(merged); fitSlider(); }
  };

  // ---- Signed in with a game that isn't the account's: keep one, never overwrite silently ----
  const describe = (rec: SaveRecord, s: GameState, where: string) =>
    `${levelName(currentLevel(s))}, ${s.bugsLeft} bugs left, score ${s.score}. ${where}, saved ${timeAgo(rec.savedAt)}.`;
  let choice: { local: SaveRecord; remote: SaveRecord } | null = null;
  /**
   * This device's game was played signed out (or by another account). If the account has no game
   * of its own, this one simply becomes the account's. If the account has a different unfinished
   * game, the player picks which to keep. If the server can't be reached, wait: nothing uploads
   * until this is settled. Returns true when the choice screen is showing.
   */
  const reconcileSaves = async (): Promise<boolean> => {
    const sub = mySub();
    const local = loadRecord(), localState = local && recordState(local);
    if (!sub || !local || saveOwner() === sub) return false;
    if (!unfinished(localState)) { adoptSave(sub); return false; }
    const remote = await cloud.lookup();
    if (remote === 'unknown') return false;
    const remoteState = remote && recordState(remote);
    if (!remote || !unfinished(remoteState) || remote.state === local.state) { adoptSave(sub); return false; }
    if (mode !== 'menu' && mode !== 'setup' && mode !== 'paused') return false;
    choice = { local, remote };
    state = null;
    audio.stopMusic();
    $('chooseLocalShot').replaceChildren(thumbnail(localState, skin, images, settings.shapesOnPieces, 120));
    $('chooseCloudShot').replaceChildren(thumbnail(remoteState, skin, images, settings.shapesOnPieces, 120));
    $('chooseLocalText').textContent = describe(local, localState, 'On this device');
    $('chooseCloudText').textContent = describe(remote, remoteState, `On your account (${remote.device})`);
    show('choose');
    return true;
  };
  const keep = (rec: SaveRecord) => {
    const sub = mySub(), s = recordState(rec);
    if (!choice || !sub || !s) return;
    audio.play('select');
    saveRecord(rec, sub);
    choice = null;
    state = s;
    input.reset();
    pendingActions = [];
    mode = 'playing';
    pause('Your game is right where you left it.'); // also uploads: the kept game is the account's now
  };
  $('chooseLocal').addEventListener('click', () => choice && keep(choice.local));
  $('chooseCloud').addEventListener('click', () => choice && keep(choice.remote));

  /** If the account holds a newer game than this device (played elsewhere), offer it. */
  const offerNewerCloud = async (): Promise<boolean> => {
    if (await reconcileSaves()) return true;
    if (mode === 'choose') return true;
    const sub = mySub();
    if (sub && saveOwner() !== sub && loadRecord()) return false; // not settled yet (server unreachable)
    const local = loadRecord();
    const remote = await cloud.get();
    const remoteState = remote && recordState(remote);
    if (!remote || !unfinished(remoteState) || newest(local, remote) !== remote || remote.state === local?.state) return false;
    if (mode !== 'menu' && mode !== 'setup' && mode !== 'paused') return false; // the player started something meanwhile
    state = null;
    audio.stopMusic();
    offerBackTo = 'menu';
    showOffer(remote, remoteState);
    return true;
  };
  // Coming back to an app left open: the game may have moved on on another device.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && cloud.signedIn) void offerNewerCloud(); });

  // ---- Start: an unfinished game opens paused, right where it was left ----
  // If the player's account holds a newer game from another device, offer that instead.
  await signIn;
  await accountCheck;
  setPlayer(mySub()); // new local saves belong to whoever is signed in ('' when signed out)
  showAccount();
  if (cloud.signedIn) void syncFromAccount(); // in the background: play never waits on it
  mode = 'menu';
  if (await offerNewerCloud()) {
    // showing the offer
  } else if (unfinished(state)) {
    mode = 'playing';
    pause('Welcome back. Your game is right where you left it.');
  } else {
    state = null;
    show('title');
    void checkUpdateInMenus();
  }

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('sw.js').catch(() => undefined);
  }
}

void main();
