// A skin is pure data: colors, shapes, names and sound files.
// The engine only knows "color 2"; the skin decides that color 2 is a yellow
// triangle. Skins carry no code, so art can be licensed apart from the GPL code.

export type ExitStyle = 'fly' | 'fall' | 'explode' | 'fade';
export type ObjectKind = 'bug' | 'piece' | 'powerup';
export const DEFAULT_EXITS: Record<ObjectKind, ExitStyle> = { bug: 'fly', piece: 'explode', powerup: 'explode' };

export type AmbientKind = 'snow' | 'leaves' | 'petals' | 'fireflies';

export type ShapeKind = 'circle' | 'triangle' | 'square' | 'diamond' | 'star';

export type Skin = {
  id: string;
  name: string;
  /** One entry per engine color (up to 5). */
  pieces: { color: string; shape: ShapeKind; name: string }[];
  background: string;
  boardFill: string;
  boardEdge: string;
  grid: string;
  text: string;
  textDim: string;
  accent: string;
  /** Color of the joint drawn between the two halves of a piece (sprite skins). */
  connector?: string;
  /**
   * Optional picture-based art: one SVG/PNG per color, each filling one cell.
   * bugAlt is a second frame; bugs alternate between the frames (animation).
   */
  sprites?: { bug: string[]; bugAlt?: string[]; half: string[] };
  /**
   * How each kind of object leaves the board when it is cleared. Each kind
   * can differ (bugs fly off, piece halves burst...). Defaults: bug 'fly',
   * piece 'explode'; power-ups (coming later) default to 'explode'.
   * 'fade' is used for everything when the player asks for reduced motion.
   */
  exits?: Partial<Record<ObjectKind, ExitStyle>>;
  /**
   * Optional pictures for the playing field. `inside` fills the 8x16 cell area
   * (stretched to it, so draw it at a 1:2 ratio). `frame` is drawn around the field,
   * `frameWidth` cells thick on every side, with a transparent hole where the field
   * shows through; draw it at a (8 + 2w):(16 + 2w) ratio. Grid lines go on top of
   * `inside` in the skin's grid color, so a soft or translucent grid color suits art.
   */
  board?: { inside?: string; frame?: string; frameWidth?: number };
  /**
   * Optional picture behind the title page. It is stretched to fill the whole screen
   * (not cropped), so draw it as an SVG that lays itself out to any size (no viewBox).
   * Without it the title page keeps the plain dimmed backdrop.
   */
  title?: { background?: string };
  /**
   * Optional power-up names and pictures, per kind (bomb, drill, wild; freeze later).
   * Each sprite fills one cell. Missing ones use the built-in drawings and names.
   */
  powerUps?: Partial<Record<'bomb' | 'drill' | 'wild' | 'freeze', { name?: string; sprite?: string }>>;
  /**
   * Optional look for the power-up meter (Mike, 2026-11-21: skinnable). Colors for the notches
   * and the socket's ready glow, and/or pictures: `notch` / `notchFull` (one notch each, drawn
   * stretched to the notch's box, e.g. a bud and a flower), `socket` (behind the held icon).
   */
  meter?: { empty?: string; full?: string; ready?: string; notch?: string; notchFull?: string; socket?: string };
  /**
   * Optional weather drifting across the board behind the pieces (seasonal looks):
   * snow, falling leaves, spring petals or summer fireflies. `colors` picks the flakes'
   * colors (one at random per flake), `count` how many (default 18). It stands still
   * with Calm motion and is left out with motion Off.
   */
  ambient?: { kind: AmbientKind; colors?: string[]; count?: number };
  /** Milliseconds per animation frame for bugAlt (default 400). */
  frameMs?: number;
  /** Who may pick this skin. Absent = everyone. */
  tier?: 'free' | 'supporter';
  /** Season window for holiday skins, as MM-DD (inclusive), e.g. {from:'12-01', to:'12-31'}. */
  season?: { from: string; to: string };
  /** Sound files relative to the page, or omitted to use generated sounds. */
  sounds?: Partial<Record<SoundName, string>>;
  music?: string[];
  /** Looping track for the menus (optional). */
  titleMusic?: string;
};

/** Images decoded from Skin.sprites, attached at load time (not part of skin.json). */
export type SpriteImages = {
  bug: HTMLImageElement[]; bugAlt: HTMLImageElement[]; half: HTMLImageElement[]; boardInside?: HTMLImageElement; boardFrame?: HTMLImageElement;
  /** Power-up pictures from Skin.powerUps, by kind. */
  power?: Partial<Record<string, HTMLImageElement>>;
  /** Meter pictures from Skin.meter. */
  meter?: { notch?: HTMLImageElement; notchFull?: HTMLImageElement; socket?: HTMLImageElement };
};

/** The built-in power-up names, used when a skin doesn't name its own. */
export const POWER_NAMES: Record<'bomb' | 'drill' | 'wild' | 'freeze', string> = { bomb: 'Bomb', drill: 'Drill', wild: 'Wildcard', freeze: 'Freeze' };
/** A power-up's name in this skin. */
export const powerName = (skin: Skin, kind: keyof typeof POWER_NAMES) => skin.powerUps?.[kind]?.name ?? POWER_NAMES[kind];

/** How thick the skin's frame is, in cells (0 when it has none). */
export const frameCells = (skin: Skin) => (skin.board?.frame ? Math.max(0, skin.board.frameWidth ?? 0.35) : 0);

export type SoundName = 'move' | 'rotate' | 'lock' | 'fall' | 'pop' | 'chain' | 'win' | 'lose' | 'select' | 'pause' | 'sweep';

/**
 * The test skin: plain shapes on a dark board. The palette is Okabe-Ito,
 * chosen to stay distinguishable with common color-vision deficiencies,
 * and every color also has its own shape, so color is never the only cue.
 */
export const testSkin: Skin = {
  id: 'test',
  name: 'Test pattern',
  pieces: [
    { color: '#D55E00', shape: 'circle', name: 'Vermilion circle' },
    { color: '#56B4E9', shape: 'triangle', name: 'Sky triangle' },
    { color: '#F0E442', shape: 'square', name: 'Yellow square' },
    { color: '#009E73', shape: 'diamond', name: 'Green diamond' },
    { color: '#CC79A7', shape: 'star', name: 'Pink star' },
  ],
  background: '#14161c',
  boardFill: '#1d2029',
  boardEdge: '#5a6275',
  grid: '#262a35',
  text: '#eef1f6',
  textDim: '#9aa3b5',
  accent: '#56B4E9',
  sounds: {
    move: 'audio/sfx/move.mp3',
    rotate: 'audio/sfx/rotate.mp3',
    lock: 'audio/sfx/lock.mp3',
    fall: 'audio/sfx/fall.mp3',
    pop: 'audio/sfx/pop.mp3',
    chain: 'audio/sfx/chain.mp3',
    win: 'audio/sfx/win.mp3',
    lose: 'audio/sfx/lose.mp3',
    select: 'audio/sfx/select.mp3',
    pause: 'audio/sfx/pause.mp3',
  },
  music: ['audio/music/music-upbeat.mp3', 'audio/music/music-calm.mp3'],
  titleMusic: 'audio/music/music-title.mp3',
};

/** Load sprite images (if any). Resolves even if some images fail. */
export async function loadSprites(skin: Skin): Promise<SpriteImages | null> {
  if (!skin.sprites && !skin.board && !skin.powerUps && !skin.meter) return null;
  const load = (src: string) => new Promise<HTMLImageElement>(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = src;
  });
  const all = (list: string[] = []) => Promise.all(list.map(load));
  const [bug, bugAlt, half, [boardInside], [boardFrame]] = await Promise.all([
    all(skin.sprites?.bug), all(skin.sprites?.bugAlt), all(skin.sprites?.half),
    all(skin.board?.inside ? [skin.board.inside] : []), all(skin.board?.frame ? [skin.board.frame] : []),
  ]);
  const kinds = Object.entries(skin.powerUps ?? {}).filter(([, v]) => v?.sprite);
  const pics = await all(kinds.map(([, v]) => v!.sprite!));
  const power = Object.fromEntries(kinds.map(([k], i) => [k, pics[i]!]));
  const m = skin.meter ?? {};
  const one = async (src?: string) => (src ? load(src) : undefined);
  const [notch, notchFull, socket] = await Promise.all([one(m.notch), one(m.notchFull), one(m.socket)]);
  return { bug, bugAlt, half, boardInside, boardFrame, power, meter: { notch, notchFull, socket } };
}

export type Season = { from: string; to: string };

const monthDay = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Is this date inside a season window (MM-DD to MM-DD, inclusive)? Windows may wrap the new year. */
export function inWindow(season: Season | undefined, now = new Date()): boolean {
  if (!season) return true;
  const md = monthDay(now), { from, to } = season;
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

/** Is a seasonal skin in season on this date? */
export const inSeason = (skin: Skin, now = new Date()) => inWindow(skin.season, now);

/**
 * Which time round of a season this is, e.g. "12-01@2026" for the winter that starts
 * on Dec 1, 2026 (it stays "@2026" through February 2027). Used to show the
 * "new looks" note once per season. Empty when the date is outside the window.
 */
export function seasonKey(season: Season, now = new Date()): string {
  if (!inWindow(season, now)) return '';
  const wraps = season.from > season.to, md = monthDay(now);
  const year = wraps && md <= season.to ? now.getFullYear() - 1 : now.getFullYear();
  return `${season.from}@${year}`;
}

/**
 * An extra look a deployment offers in Settings, listed in its config.json. Seasonal
 * looks only show (and only stay picked) while their window is open; out of season
 * the game goes back to the default look.
 */
export type SiteLook = { id: string; name: string; skin: string; season?: Season };

/**
 * The looks a player can pick today, in the order config.json lists them. `anySeason` lists
 * every look whatever the date (config.json `allLooks`, for testing on a staging site).
 */
export const lookChoices = (looks: SiteLook[] | undefined, now = new Date(), anySeason = false) =>
  (looks ?? []).filter(l => l.id && l.id !== 'site' && l.id !== 'test' && (anySeason || inWindow(l.season, now)));
