// App shell: menus, the fixed-rate game loop, saving, and wiring input,
// rendering and sound together.

import { createGame, step, MAX_LEVEL, FINAL_LEVEL, isEndless, endlessGame, endlessRound, SLO_MO, SLO_MO_COLORS, currentLevel, TICKS_PER_SECOND, BOARD_WIDTH, type GameEvent, type GameState, type Action } from '@bug-pop/engine';
import './style.css';
import { AudioManager } from './audio';
import { InputManager, type InputFrame, type Nav } from './input';
import { computeLayout, powerIconRect, LEAVE_MS, ARRIVE_MS, SWEEP_MS, FLOAT_MS, diagram, loadBubbleFont, render, thumbnail, type Layout, type Leaver, type Sweep, type Float } from './render';
import { activeMatch, fetchAccount, loginUrl, logout, personalizedAds, shownName, supporterBadge, wantsAds, type AccountStatus } from './account';
import { setAdSlot, type AdsConfig } from './ads';
import { httpCloud, makeRecord, newest, noCloud, recordState, timeAgo, type CloudSave, type SaveRecord } from './cloud';
import { frameCells, inSeason, inWindow, lookChoices, loadSprites, powerName, seasonKey, testSkin, type SiteLook, type Skin } from './skin';
import { isLayout, LAYOUTS, renderButtons, renderPreview } from './layouts';
import { cleanUpdateMarker, decline, shouldOffer, updateNow } from './update';
import { adoptSave, clearGame, loadGame, loadRecord, loadSettings, saveOwner, saveRecord, setPlayer, requestPersistence, saveGame, saveSettings, type Settings, type Motion, loadProgress, recordBeaten, sliderMax, mergeProgress, settingsChangedAt, lookNoticeSeen, markLookNotice } from './storage';
import { Coach, createTutorialGame, markTutorialSeen, tutorialSeen, type Device } from './tutorial';
import { Versus, initSetupForm, lastOnline, readSetup, refreshSetupForm, rememberOnline } from './versus';
import { applySynced, httpSync, noSync, pickSynced, syncedDiffer, type Sync } from './sync';

// 'ending': the game is decided and the board stays on screen for a dramatic pause.
// 'versusSetup' / 'versus': multiplayer on one device (src/versus.ts runs the match itself).
type Mode = 'title' | 'menu' | 'setup' | 'versusSetup' | 'versus' | 'settings' | 'help' | 'tutorialOffer' | 'tutorialDone' | 'offer' | 'choose' | 'update' | 'playing' | 'paused' | 'ending' | 'result';
/**
 * config.json, written by each deployment (the open-source build ships one with just a skin):
 *   skin     skin.json to load
 *   api      game server base (turns on cloud save)
 *   privacy  link for the title page's Privacy link
 *   terms    link for the title page's Terms link
 *   ads      { preview: true } shows an outlined, empty ad space on the title page;
 *            { script: "..." } loads the deployment's own ad code (see src/ads.ts)
 *   logo     { wide, stacked? } logo pictures for the title page (stacked one on phones)
 *   home     { url, name, icon? } the publisher's site, linked from the title page
 *   looks    [{ id, name, skin, season? }] extra looks offered in Settings, e.g. seasonal ones
 *            (season { from: 'MM-DD', to: 'MM-DD' }; they are only listed while in season)
 *   allLooks true lists every look in Settings whatever the date (for testing on staging)
 *   play     online versus server (WebSocket address, may be relative like "/api/play"); without it
 *            the Multiplayer screen has no online play
 */
type SiteConfig = {
  skin?: string; api?: string; privacy?: string; terms?: string; ads?: AdsConfig;
  /** Logo pictures for the title page (paths relative to the page). Without them the title is plain text. */
  logo?: { wide: string; stacked?: string };
  /** The publisher's site, linked from the title page, with an optional small icon. */
  home?: { url: string; name: string; icon?: string };
  /** Extra looks for the Settings picker (see SiteLook in skin.ts). */
  looks?: SiteLook[];
  /** List every look whatever the season (a staging site, so all of them can be checked). */
  allLooks?: boolean;
  /** Online versus: the relay's WebSocket address (see packages/relay, or the hosted server). */
  play?: string;
};

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
  const look = loadSettings().look;
  if (look === 'test' || new URLSearchParams(location.search).get('skin') === 'test') return testSkin;
  // A picked look that is in season; if its files fail to load, fall back to the site's own skin.
  const picked = lookChoices(cfg.looks, new Date(), cfg.allLooks).find(l => l.id === look);
  if (picked) {
    const skin = await fetchSkin(picked.skin);
    if (skin !== testSkin) return skin;
  }
  return fetchSkin(cfg.skin);
}

async function fetchSkin(path: string | undefined): Promise<Skin> {
  try {
    if (!path) return testSkin;
    const skinUrl = new URL(path, location.href);
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
    for (const p of Object.values(skin.powerUps ?? {})) if (p?.sprite) p.sprite = rel(p.sprite);
    if (skin.meter) for (const k of ['notch', 'notchFull', 'socket'] as const) { const v = skin.meter[k]; if (v) skin.meter[k] = rel(v); }
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
  // 'unavailable' until the server answers, which also means no ad yet (see wantsAds).
  let account: AccountStatus = { kind: cfg.api ? 'unavailable' : 'off' };
  const accountCheck = fetchAccount(cfg.api).then((a) => { account = a; }); // also runs while the skin loads
  const loaded = await loadSkin(cfg);
  // A skin's own season window is checked too, except on a testing site that lists every look (allLooks).
  const skin = cfg.allLooks || inSeason(loaded) ? loaded : testSkin;
  const images = await loadSprites(skin);
  let leavers: Leaver[] = [];
  /** Endless: cells whose new bug is crawling in, and when it set off. */
  let arrivals = new Map<number, number>();
  let matchedBugs: Leaver[] = [];
  let sweep: Sweep | null = null; // a clean sweep being celebrated
  loadBubbleFont(); // the pop-ups' font (28 KB), fetched in the background well before the first combo
  let floats: Float[] = []; // chain-bonus numbers rising off the board
  // The guided first level, while it runs. Its game lives in `state` like any other, but it is
  // never saved, uploaded or counted as progress, and the player's real save is reloaded after.
  let coach: Coach | null = null;
  let device: Device = 'keyboard';
  const canvas = $<HTMLCanvasElement>('board');
  const ctx = canvas.getContext('2d')!;
  const touchBar = $('touch');
  const input = new InputManager();
  const audio = new AudioManager(skin);
  let settings: Settings = loadSettings();
  // A seasonal look whose season has ended (or a look the site no longer offers) goes back to the default.
  const looks = lookChoices(cfg.looks, new Date(), cfg.allLooks);
  if (settings.look !== 'site' && settings.look !== 'test' && !looks.some(l => l.id === settings.look)) {
    settings.look = 'site';
    saveSettings(settings);
  }
  let state: GameState | null = loadGame();
  let mode: Mode = 'menu';
  let layout: Layout = computeLayout(1, 1, 0);
  let pendingActions: Action[] = [];
  // Animations: the player's choice, or on Automatic, Calm when the device asks for reduced motion.
  const deviceCalm = matchMedia('(prefers-reduced-motion: reduce)');
  const motion = (): Motion => (settings.motion !== 'auto' ? settings.motion : deviceCalm.matches ? 'calm' : 'full');

  requestPersistence();
  cleanUpdateMarker();
  // Read-only handle for debugging and automated browser tests.
  Object.defineProperty(window, 'bugpop', { value: { get state() { return state; }, get mode() { return mode; }, get cell() { return layout.cell; }, get tutorial() { return coach?.step ?? null; } } });
  audio.soundOn = settings.sound;
  audio.musicOn = settings.music;

  // ---- Power-ups: the icon is drawn on the canvas; an invisible button over it takes taps and clicks ----
  const powerBtn = $<HTMLButtonElement>('powerBtn');
  const placePowerBtn = () => {
    const r = powerIconRect(layout);
    Object.assign(powerBtn.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.size}px`, height: `${r.size}px` });
  };
  input.attachTouchButtons($('powerWrap'));

  // ---- Sizing ----
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * devicePixelRatio);
    canvas.height = Math.round(rect.height * devicePixelRatio);
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    layout = computeLayout(rect.width, rect.height, 0, frameCells(skin));
    if (coach) placeCoach(); // the tutorial banner follows the board
    placePowerBtn();
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
  input.onDevice = kind => {
    if (kind === 'touch') showTouch(true); else if (kind === 'keyboard' || kind === 'gamepad') showTouch(false);
    // The tutorial's words follow whatever the player is using right now.
    if (device !== kind) { device = kind; coach?.show(device); }
  };
  if (touchOn) device = 'touch';
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
  const titleScreens: Mode[] = ['title', 'menu', 'setup', 'versusSetup', 'settings', 'help', 'tutorialOffer', 'offer'];
  const unlock = () => { audio.unlock(); if (titleScreens.includes(mode)) audio.title(true); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // ---- Screens ----
  const overlays = { title: $('title'), menu: $('menu'), setup: $('setup'), versusSetup: $('versusSetup'), vsCard: $('vsCard'), settings: $('settingsScreen'), help: $('helpScreen'), tutorialOffer: $('tutorialOffer'), tutorialDone: $('tutorialDone'), offer: $('offer'), choose: $('choose'), update: $('update'), paused: $('paused'), result: $('result') };
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
  let versus: Versus | null = null; // made once the screens exist (below)
  const show = (m: Mode) => {
    mode = m;
    audio.title(titleScreens.includes(m));
    overlays.title.hidden = m !== 'title';
    overlays.menu.hidden = m !== 'menu';
    overlays.setup.hidden = m !== 'setup';
    overlays.versusSetup.hidden = m !== 'versusSetup';
    // Versus owns its own board area and card; any other screen ends a match that is still on.
    if (m !== 'versus' && versus?.active) versus.stop();
    $('stage').hidden = m === 'versus';
    overlays.settings.hidden = m !== 'settings';
    overlays.help.hidden = m !== 'help';
    overlays.tutorialOffer.hidden = m !== 'tutorialOffer';
    overlays.tutorialDone.hidden = m !== 'tutorialDone';
    $('coach').hidden = !coach || m !== 'playing';
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

  const save = () => { if (state && !coach && (mode === 'playing' || mode === 'paused')) saveGame(state); };
  /** Single player only: copy the game to the player's account so another device can pick it up. */
  // Only a game this account owns goes up: a game played before signing in (or by another account)
  // must never silently replace the account's game. reconcileSaves() settles that first.
  // The record is the local one, timestamp included, so both copies compare as the same game.
  const mySub = () => (account.kind === 'signedIn' ? account.me.sub : null);
  const upload = () => {
    const sub = mySub(), rec = loadRecord();
    if (state && !coach && rec && cloud.signedIn && sub && saveOwner() === sub) cloud.put(rec);
  };

  // ---- Settings form ----
  const level = $<HTMLInputElement>('level'), levelOut = $<HTMLOutputElement>('levelOut');
  const speed = $<HTMLSelectElement>('speed'), colors = $<HTMLSelectElement>('colors');
  const exitSel = $<HTMLSelectElement>('exit');
  const autoNext = $<HTMLInputElement>('autoNext');
  const touchLayoutSel = $<HTMLSelectElement>('touchLayout');
  const motionSel = $<HTMLSelectElement>('motion');
  const powerUpsBox = $<HTMLInputElement>('powerUps');
  const shapes = $<HTMLInputElement>('shapes'), sound = $<HTMLInputElement>('sound'), music = $<HTMLInputElement>('music');
  // The Paused card has its own Sound effects and Music boxes; they mirror the two on the Settings screen.
  const pauseSound = $<HTMLInputElement>('pauseSound'), pauseMusic = $<HTMLInputElement>('pauseMusic');
  /** "Level 7", or "Endless round 3" in an Endless run. */
  const levelName = (s: GameState) => (endlessGame(s) ? `Endless round ${endlessRound(s)}` : `Level ${currentLevel(s)}`);
  /**
   * The slider reaches the first level not yet beaten at the chosen speed (1 to 20 are always open).
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
    motionSel.value = settings.motion;
    sound.checked = pauseSound.checked = settings.sound;
    music.checked = pauseMusic.checked = settings.music;
    exitSel.value = settings.exit;
    powerUpsBox.checked = settings.powerUps;
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
      motion: (['auto', 'full', 'calm', 'off'] as const).find(m => m === motionSel.value) ?? 'auto',
      powerUps: powerUpsBox.checked,
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
  for (const [quick, main] of [[pauseSound, sound], [pauseMusic, music]] as const) {
    quick.addEventListener('input', () => { main.checked = quick.checked; readForm(); });
  }
  // Changing the look reloads the page; the game in progress is saved first.
  const look = $<HTMLSelectElement>('look');
  look.value = settings.look;
  const siteOption = look.querySelector('option[value="site"]')!;
  // The site's own skin is named by the skin it loaded, unless a picked look is showing instead.
  const siteName = settings.look === 'site' ? (skin === testSkin ? 'Default (test pattern)' : skin.name) : 'Default';
  siteOption.textContent = siteName;
  let prev: Element = siteOption;
  for (const l of looks) { const o = Object.assign(document.createElement('option'), { value: l.id, textContent: inWindow(l.season) ? l.name : `${l.name} (out of season)` }); prev.after(o); prev = o; }
  // Keep the order: Default, then the looks as config.json lists them, then Test pattern last.
  const testOption = look.querySelector('option[value="test"]')!;
  look.append(testOption);
  look.value = settings.look;
  look.addEventListener('change', () => { settings.look = look.value; saveSettings(settings); location.reload(); });

  // Once per season, the title page says that new looks are out for this time of year.
  const seasonal = looks.filter(l => l.season && inWindow(l.season)); // the note is about this season only
  const noticeKey = seasonal.length ? seasonKey(seasonal[0]!.season!) : '';
  const notice = $('lookNotice');
  if (noticeKey && !lookNoticeSeen(noticeKey) && !seasonal.some(l => l.id === settings.look)) {
    $('lookNoticeNames').textContent = seasonal.map(l => l.name).join(', ');
    notice.hidden = false;
    const done = () => { markLookNotice(noticeKey); notice.hidden = true; };
    $('lookNoticeTry').addEventListener('click', () => { done(); audio.play('select'); settingsFrom = mode; show('settings'); look.focus(); });
    $('lookNoticeLater').addEventListener('click', done);
  }
  fillForm();

  /** startScore carries the score over when moving on to the next level. */
  const newGame = (lvl = settings.level, startScore = 0) => {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    // The notch past level 100 is Endless: a run that starts as level 1 and climbs (Mike, 2026-11-19).
    const endless = isEndless(lvl);
    begin(createGame({ seed, level: endless ? 1 : Math.max(1, lvl), endless, speed: settings.speed, colors: settings.colors, startScore: endless ? 0 : startScore, powerUps: settings.powerUps }));
  };
  /**
   * The level after a cleared one, set up and saved the moment the level is won, so the run
   * (level and score) survives Main menu, closing the app or an update. Next level plays it.
   */
  let upNext: GameState | null = null;
  const prepareNext = (won: GameState) => {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const { speed: spd, colors: cols } = won.config;
    // Power-ups carry on into the next level: the meter, and the one held (or used but not yet dropped).
    const p = won.power;
    const power = p ? { powerUps: true, startPower: { meter: p.meter, held: p.held ?? p.queued } } : {};
    upNext = createGame({ seed, level: Math.min(MAX_LEVEL, currentLevel(won) + 1), speed: spd, colors: cols, startScore: won.score, ...power });
    saveGame(upNext);
    const sub = mySub(), rec = loadRecord();
    if (rec && cloud.signedIn && sub && saveOwner() === sub) cloud.put(rec); // the run, everywhere
  };
  const playNext = () => {
    if (upNext && loadRecord() && loadGame()?.config.seed === upNext.config.seed) begin(upNext);
    else if (state) newGame(currentLevel(state) + 1, state.score); // the save was replaced, or level 100 was beaten: Endless
  };
  const begin = (s: GameState) => {
    upNext = null;
    state = s;
    input.reset(); // a fresh game starts with soft drop off
    pendingActions = [];
    arrivals = new Map();
    sweep = null;
    floats = [];
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
    $('pausedNote').textContent = coach ? 'Tutorial paused.' : note;
    save();
    upload();
    audio.pauseMusic();
    audio.play('pause');
    // The switches were last filled when the page loaded; Settings may have changed them since.
    pauseSound.checked = settings.sound;
    pauseMusic.checked = settings.music;
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
    if (unfinished(state) && !coach) { saveGame(state); upload(); } // reopens paused, right where it was
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
    if (coach) endTutorial();
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
    $('offerText').textContent = `${levelName(s)}, ${s.bugsLeft} bugs left, score ${s.score}. Saved ${where}, ${timeAgo(rec.savedAt)}.`;
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
  /**
   * Single player (Mike, 2026-11-19): a saved game is offered FIRST; the game options come only
   * after "Start a new game", and the old save stays until the new game actually starts.
   */
  let setupFrom: Mode = 'menu';
  const singlePlayer = async () => {
    audio.unlock();
    if (await reconcileSaves()) return; // a clash the server was too slow to show at start-up
    const rec = await findSave();
    const s = rec && recordState(rec);
    offerBackTo = 'menu';
    if (rec && s) showOffer(rec, s);
    else { setupFrom = 'menu'; show('setup'); }
  };
  /** Start on the options screen: only now is a new game made, replacing any saved one. */
  const startNew = async () => {
    audio.unlock();
    readForm();
    await updateGate();
    if (!tutorialSeen()) { markTutorialSeen(); show('tutorialOffer'); }
    else newGame();
  };

  // ---- The guided first level (src/tutorial.ts) ----
  const coachEl = $('coach');
  // The banner sits over the empty middle of the board, as wide as the board.
  const placeCoach = () => {
    coachEl.style.left = `${layout.boardX + (layout.cell * BOARD_WIDTH) / 2}px`;
    coachEl.style.top = `${layout.boardY + layout.cell * 4}px`;
    coachEl.style.width = `${Math.max(240, layout.cell * BOARD_WIDTH)}px`;
  };
  const startTutorial = () => {
    markTutorialSeen();
    coach = new Coach(coachEl, skin, images, settings.shapesOnPieces);
    state = createTutorialGame();
    input.reset();
    pendingActions = [];
    arrivals = new Map();
    sweep = null;
    floats = [];
    leavers = [];
    placeCoach();
    coach.show(device);
    audio.unlock();
    audio.play('select');
    audio.startMusic(true);
    show('playing');
  };
  /** Back to the player's own game (or none): the tutorial game is simply dropped. */
  const endTutorial = () => {
    coach = null;
    coachEl.hidden = true;
    state = loadGame();
  };
  $('tutorialYes').addEventListener('click', startTutorial);
  $('tutorialNo').addEventListener('click', () => newGame());
  $('helpTutorial').addEventListener('click', startTutorial);
  $('coachSkip').addEventListener('click', () => { audio.play('select'); toMenu(); });
  $('tutorialPlay').addEventListener('click', () => { endTutorial(); setupFrom = 'menu'; show('setup'); });
  $('tutorialMenu').addEventListener('click', () => { endTutorial(); audio.play('select'); show('menu'); });
  // The "Resume level N" tag on the Single player card, and the Start button's wording.
  const resumeTag = $('resumeTag'), startBtn = $('start');
  const refreshResume = async () => {
    const rec = await findSave();
    const s = rec && recordState(rec);
    resumeTag.hidden = !s;
    if (s) resumeTag.textContent = `Resume ${levelName(s)}`;
    startBtn.textContent = 'Start';
  };
  $('newGame').addEventListener('click', () => { audio.play('select'); void singlePlayer(); });
  // ---- Multiplayer on this device: you against the computer, two people, or the computer against itself ----
  versus = new Versus({
    skin, images, audio, touchBar, motion, settings: () => settings, finishPauseMs: FINISH_PAUSE_MS, playUrl: cfg.play,
    exit: to => show(to === 'menu' ? 'menu' : 'versusSetup'),
  });
  $('multiGame').addEventListener('click', () => {
    audio.play('select');
    refreshSetupForm();
    show('versusSetup');
    // An unfinished online match comes first: going back into Multiplayer rejoins it (Mike, 2026-11-22).
    if (cfg.api && versus!.canPlayOnline) void activeMatch(cfg.api).then(on => { if (on && mode === 'versusSetup') goOnline(); });
  });
  initSetupForm(settings.speed);
  {
    const o = lastOnline(settings.speed), r = $<HTMLInputElement>('vsOnlineLevel');
    r.value = String(o.level); r.closest('label')!.querySelector('output')!.value = r.value;
    $<HTMLSelectElement>('vsOnlineSpeed').value = String(o.speed);
  }
  // Online / On this device: one card at a time, picked with the selector (Mike, 2026-11-22).
  // Phones start on Online (one screen is cramped for two players), computers on This device.
  const online = versus.canPlayOnline;
  $('vsTabs').hidden = !online;
  $('vsSoon').hidden = online;
  const pickTab = (tab: 'local' | 'online') => {
    $('vsTabLocal').setAttribute('aria-selected', String(tab === 'local'));
    $('vsTabOnline').setAttribute('aria-selected', String(tab === 'online'));
    $('vsLocal').hidden = tab !== 'local';
    $('vsOnline').hidden = tab !== 'online';
  };
  pickTab(online && matchMedia('(pointer: coarse)').matches ? 'online' : 'local');
  $('vsTabLocal').addEventListener('click', () => { audio.play('select'); pickTab('local'); });
  $('vsTabOnline').addEventListener('click', () => { audio.play('select'); pickTab('online'); });
  // Each level slider shows its number beside it.
  document.querySelectorAll<HTMLInputElement>('#versusSetup .vs-level').forEach(r => {
    const out = r.closest('label')!.querySelector('output')!;
    r.addEventListener('input', () => { out.value = r.value; });
  });
  function goOnline(room?: string) {
    const me = { level: Number($<HTMLInputElement>('vsOnlineLevel').value), speed: Number($<HTMLSelectElement>('vsOnlineSpeed').value) as 0 | 1 | 2 };
    rememberOnline(me.level, me.speed);
    audio.unlock();
    audio.play('select');
    show('versus');
    versus!.startOnline({ level: me.level, speed: me.speed, room });
  };
  $('vsQuick').addEventListener('click', () => goOnline());
  $('vsCreate').addEventListener('click', () => goOnline('new'));
  const code = $<HTMLInputElement>('vsCode');
  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  $('vsJoin').addEventListener('click', () => { if (/^[A-Z]{4}$/.test(code.value)) goOnline(code.value); else code.focus(); });
  $('vsStart').addEventListener('click', () => {
    audio.unlock();
    audio.play('select');
    show('versus');
    versus!.startMatch(readSetup());
  });
  $('start').addEventListener('click', () => void startNew());
  $('offerResume').addEventListener('click', () => {
    const s = offered && recordState(offered);
    if (!s) { newGame(); return; }
    state = s;
    if (offered!.state !== loadRecord()?.state) saveRecord(offered!, mySub() ?? ''); // keep a local copy of a cloud save
    input.reset();
    pendingActions = [];
    resume();
  });
  // The saved game is kept: it is only replaced once Start on the options screen begins a new one.
  $('offerNew').addEventListener('click', () => { audio.play('select'); setupFrom = 'offer'; show('setup'); });

  // ---- Title page: the first screen on a fresh start ----
  $('play').addEventListener('click', () => { audio.unlock(); audio.play('select'); show('menu'); void checkUpdateInMenus(); });
  if (cfg.logo?.wide) {
    $<HTMLImageElement>('logoWide').src = cfg.logo.wide;
    if (cfg.logo.stacked) $<HTMLSourceElement>('logoStacked').srcset = cfg.logo.stacked;
    else $('logoStacked').remove();
    $('logo').hidden = false;
    overlays.title.classList.add('has-logo'); // the logo replaces the text heading (kept for screen readers via alt)
  }
  if (cfg.home?.url) {
    const a = $<HTMLAnchorElement>('homeLink');
    a.href = cfg.home.url;
    $('homeName').textContent = cfg.home.name;
    if (cfg.home.icon) { $<HTMLImageElement>('homeIcon').src = cfg.home.icon; $('homeIcon').hidden = false; }
    a.hidden = false;
  }
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
  let helpFrom: Mode = 'menu';
  const backTo = (): Mode => (mode === 'menu' ? 'title' : mode === 'versusSetup' ? 'menu' : mode === 'setup' ? setupFrom : mode === 'settings' ? settingsFrom : mode === 'help' ? helpFrom : offerBackTo);
  document.querySelectorAll<HTMLElement>('[data-back]').forEach(b => b.addEventListener('click', () => { audio.play('select'); show(backTo()); }));
  document.querySelectorAll<HTMLElement>('[data-gear]').forEach(b => b.addEventListener('click', () => { audio.play('select'); settingsFrom = mode; show('settings'); }));
  // How to play: from the title, any menu screen, or the pause card (Back returns there).
  document.querySelectorAll<HTMLElement>('[data-help]').forEach(b => b.addEventListener('click', () => { audio.play('select'); helpFrom = mode; showHelp(); }));
  const showHelp = () => {
    fillHelp();
    show('help');
    overlays.help.scrollTop = 0;
  };
  // The pictures are drawn fresh each time, in this skin's art and with the player's shapes setting.
  const fillHelp = () => {
    const shapes = settings.shapesOnPieces;
    const figs: Record<string, string[]> = {
      // A vertical piece completing a blue line of four with two bugs.
      match: ['.. .. .. .. ..', '.. .. D1! .. ..', 'b0 .. U1! .. ..', 'R2 L0 b1! .. b3', '.. b2 b1! b0 ..'],
      // A piece whose right half finishes a line; its left half is left hanging...
      before: ['R2 L1! ..', '.. b1! ..', '.. b1! ..', 'b0 b1! ..'],
      // ...and drops onto the bug below.
      after: ['.. .. ..', '.. .. ..', 'h2 .. ..', 'b0 .. ..'],
    };
    // Power-ups: the bomb's square, the drill's column and a wildcard finishing a line.
    figs.bomb = ['.. pb ..', 'b1! b2! h0!', 'b0! b1! b2!', 'b2 h1 b0'];
    figs.drill = ['pd', 'h1!', 'b2!', 'b0!', 'b1'];
    figs.wild = ['b1! b1! b1! w-!'];
    for (const k of ['bomb', 'drill', 'wild'] as const) {
      const n = overlays.help.querySelector(`[data-power-name="${k}"]`);
      if (n) n.textContent = powerName(skin, k);
    }
    overlays.help.querySelectorAll<HTMLElement>('[data-fig]').forEach(el => {
      el.replaceChildren(diagram(figs[el.dataset.fig!]!, skin, images, shapes, 28));
    });
    // One row per color: its bug, its piece half, and the skin's name for it.
    $('legend').replaceChildren(...skin.pieces.map((p, c) => {
      const li = document.createElement('li');
      li.append(diagram([`b${c} h${c}`], skin, images, true, 26));
      const name = document.createElement('span');
      name.textContent = p.name;
      li.append(name);
      return li;
    }));
    // Open the controls for the device being used now (touch, else keyboard); the rest stay folded.
    const device = touchOn ? 'touch' : 'keyboard';
    overlays.help.querySelectorAll<HTMLDetailsElement>('details[data-device]').forEach(d => { d.open = d.dataset.device === device; });
  };
  $('resume').addEventListener('click', resume);
  $('quit').addEventListener('click', toMenu);
  // A cleared level's run stays saved (the next level is waiting); a lost game has nothing to keep.
  $('toMenu').addEventListener('click', () => { state = null; upNext = null; toMenu(); });
  // Play again repeats the level with the score it started with; Next level keeps the score.
  $('retry').addEventListener('click', async () => { const s = state; await updateGate(); newGame(s?.config.level, s?.config.startScore); });
  $('nextLevel').addEventListener('click', async () => { await updateGate(); playNext(); });

  const finish = (won: boolean) => {
    if (!state) return;
    if (coach) {
      // The guided level: no progress, no save to clear. A loss just starts it again.
      audio.stopMusic();
      show('ending');
      const decided = state;
      setTimeout(() => {
        if (state !== decided || mode !== 'ending') return;
        if (won) { audio.play('win'); show('tutorialDone'); } else startTutorial();
      }, FINISH_PAUSE_MS);
      return;
    }
    // Progress first: it is what unlocks the next level on the slider.
    if (won && !endlessGame(state)) {
      const p = recordBeaten(state.config.speed, state.config.level);
      fitSlider();
      if (cloud.signedIn) void sync.mergeProgress(p.beaten).then(m => { if (m) { mergeProgress(m); fitSlider(); } });
    }
    // The run goes on: save the next level now. Beating level 100 ends the run (Endless is a new one).
    if (won && currentLevel(state) < FINAL_LEVEL) prepareNext(state);
    else {
      clearGame();
      if (cloud.signedIn) cloud.remove(); // a lost game is nothing to resume
    }
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
    const lvl = currentLevel(state), endless = endlessGame(state), beatGame = won && lvl === FINAL_LEVEL;
    $('resultTitle').textContent = beatGame ? 'You beat Bug Pop!' : won ? 'Cleared!' : endless ? 'Endless run over' : 'Game over';
    $('resultText').textContent = beatGame
      ? `Level ${FINAL_LEVEL} cleared. Score ${state.score}. Endless mode is now open at this speed.`
      : won
        ? `${levelName(state)} cleared. Score ${state.score}.`
        : `${state.bugsLeft} bugs left on ${levelName(state).toLowerCase()}. Score ${state.score}.`;
    $('nextLevel').hidden = !won || lvl >= MAX_LEVEL;
    $('nextLevel').textContent = beatGame ? 'Play Endless' : endless ? 'Next round' : 'Next level';
    show('result');
    // Auto-advance: a short beat to see "Cleared!", then the next level starts by itself.
    // Endless always rolls on; beating the game always waits, so the moment isn't skipped.
    // Any button on the result screen still works and cancels it.
    if (won && !beatGame && (settings.autoNext || endless) && lvl < MAX_LEVEL) {
      const next = lvl + 1;
      const startedFor = state;
      $('resultText').textContent += ` Level ${next} starts in a moment...`;
      setTimeout(() => {
        // Skip if the player already chose something, or switched away (it would start unseen).
        if (mode === 'result' && state === startedFor && !document.hidden) playNext();
      }, AUTO_NEXT_MS);
    }
  };

  const onEvents = (events: GameEvent[]) => {
    if (coach && state) {
      const before = coach.step;
      coach.onEvents(events, state);
      if (coach.step !== before) { coach.show(device); audio.play('select'); }
    }
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
          // x2 and up: the chain bonus floats up from the middle of the popped bugs, bigger as it grows.
          const popped = matchedBugs.filter(l => l.kind === 'bug');
          if (e.chainBonus >= 2 && popped.length) {
            const x = popped.reduce((a, l) => a + l.x, 0) / popped.length;
            const y = popped.reduce((a, l) => a + l.y, 0) / popped.length;
            floats.push({ text: `×${e.chainBonus}`, x, y, t0: now, size: 0.7 + Math.log2(e.chainBonus) * 0.12 });
          }
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
          if (motion() === 'full') for (let k = 1; k < 7; k++) setTimeout(() => audio.play('pop', 0.7 + (k % 3) * 0.2), k * 260);
          break;
        }
        case 'won': finish(true); break;
        case 'lost': finish(false); break;
        // ---- Power-ups ----
        case 'powerGot': {
          audio.play('chain', 1.3);
          const r = powerIconRect(layout);
          floats.push({ text: `${powerName(skin, e.kind)}!`, x: (r.x - layout.boardX) / layout.cell + 1.5, y: (r.y - layout.boardY) / layout.cell + 1.4, t0: performance.now(), size: 0.55 });
          break;
        }
        case 'powerUse': audio.play('select'); break;
        case 'blast': {
          audio.play('sweep', e.kind === 'bomb' ? 0.8 : 1.2);
          // What it destroys leaves the board like popped cells do (see 'cleared').
          const now = performance.now();
          matchedBugs = e.cells.flatMap(i => {
            const cell = state!.board[i];
            if (!cell) return [];
            const kind = cell.t === 'bug' ? 'bug' as const : 'piece' as const;
            return [{ kind, x: i % BOARD_WIDTH, y: Math.floor(i / BOARD_WIDTH), c: cell.c, t0: now, dir: (i % 2 ? 1 : -1) as 1 | -1 }];
          });
          break;
        }
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
    } else if (mode === 'help' && (dir === 'up' || dir === 'down')) {
      // How to play is mostly reading: up and down scroll the page, left and right move between buttons.
      overlays.help.scrollBy({ top: (dir === 'up' ? -0.4 : 0.4) * overlays.help.clientHeight, behavior: 'smooth' });
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
        if (coach?.frozen && state.phase === 'falling') state.dropTimer = 0; // hold the piece still while practising
        acc -= TICK_MS;
      }
    } else {
      acc = 0;
      menuInput(input.poll(null));
    }
    if (leavers.length) leavers = leavers.filter(l => now - l.t0 < LEAVE_MS);
    if (sweep && now - sweep.t0 >= SWEEP_MS) sweep = null;
    if (floats.length) floats = floats.filter(f => now - f.t0 < FLOAT_MS);
    if (arrivals.size && [...arrivals.values()].every(t0 => now - t0 >= ARRIVE_MS)) arrivals = new Map();
    powerBtn.hidden = !(mode === 'playing' && state?.power);
    if (state) render(ctx, state, skin, layout, { shapesOnPieces: settings.shapesOnPieces, motion: motion(), time: now, images, leavers, arrivals, hidden: mode === 'paused' || (mode === 'help' && helpFrom === 'paused'), bugExit: settings.exit || undefined, sweep, floats, glowNext: coach?.step === 'next' });
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
    `${levelName(s)}, ${s.bugsLeft} bugs left, score ${s.score}. ${where}, saved ${timeAgo(rec.savedAt)}.`;
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
