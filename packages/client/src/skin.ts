// A skin is pure data: colors, shapes, names and sound files.
// The engine only knows "color 2"; the skin decides that color 2 is a yellow
// triangle. Skins carry no code, so art can be licensed apart from the GPL code.

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
  /** Milliseconds per animation frame for bugAlt (default 400). */
  frameMs?: number;
  /** Who may pick this skin. Absent = everyone. */
  tier?: 'free' | 'supporter';
  /** Season window for holiday skins, as MM-DD (inclusive), e.g. {from:'12-01', to:'12-31'}. */
  season?: { from: string; to: string };
  /** Sound files relative to the page, or omitted to use generated sounds. */
  sounds?: Partial<Record<SoundName, string>>;
  music?: string[];
};

/** Images decoded from Skin.sprites, attached at load time (not part of skin.json). */
export type SpriteImages = { bug: HTMLImageElement[]; bugAlt: HTMLImageElement[]; half: HTMLImageElement[] };

export type SoundName = 'move' | 'rotate' | 'lock' | 'pop' | 'chain' | 'win' | 'lose' | 'select' | 'pause';

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
    pop: 'audio/sfx/pop.mp3',
    chain: 'audio/sfx/chain.mp3',
    win: 'audio/sfx/win.mp3',
    lose: 'audio/sfx/lose.mp3',
    select: 'audio/sfx/select.mp3',
    pause: 'audio/sfx/pause.mp3',
  },
  music: ['audio/music/music-upbeat.mp3', 'audio/music/music-calm.mp3'],
};

/** Load sprite images (if any). Resolves even if some images fail. */
export async function loadSprites(skin: Skin): Promise<SpriteImages | null> {
  if (!skin.sprites) return null;
  const load = (src: string) => new Promise<HTMLImageElement>(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = src;
  });
  const all = (list: string[] = []) => Promise.all(list.map(load));
  const [bug, bugAlt, half] = await Promise.all([all(skin.sprites.bug), all(skin.sprites.bugAlt), all(skin.sprites.half)]);
  return { bug, bugAlt, half };
}

/** Is a seasonal skin in season on this date? */
export function inSeason(skin: Skin, now = new Date()): boolean {
  if (!skin.season) return true;
  const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const { from, to } = skin.season;
  return from <= to ? md >= from && md <= to : md >= from || md <= to; // windows may wrap the new year
}
