// Canvas drawing. Reads the game state and the skin; never changes either.

import { BOARD_HEIGHT as H, BOARD_WIDTH as W, DRILL_DEPTH, METER_FULL, idx, pieceCells, type PowerKind, endlessGame, endlessRound, currentLevel, scoreMultiplier, type GameState, type Link } from '@bug-pop/engine';
import type { Motion } from './storage';
import { DEFAULT_EXITS, frameCells, powerName, type ExitStyle, type ObjectKind, type ShapeKind, type Skin, type SpriteImages } from './skin';

export type Layout = { boardX: number; boardY: number; cell: number; portrait: boolean };

/** A cleared bug on its way off the screen (bugs leave; they are never destroyed). */
export type Leaver = { kind: ObjectKind; x: number; y: number; c: number; t0: number; dir: 1 | -1 };
export const LEAVE_MS = 1100;
/** Endless: how long one arriving bug takes to crawl in from the side of the board. */
export const ARRIVE_MS = 700;

/**
 * The "bubble" face of the Bug Pop logo (Lilita One, OFL, bundled in public/fonts) for the
 * celebration pop-ups. Until it has loaded (or if it can't), the bold system font stands in.
 */
let bubbleReady = false; // Lilita One has only one weight: ask for 800 only from the stand-in
const bubbleFont = (px: number) => bubbleReady
  ? `${Math.round(px)}px "Lilita One", system-ui, sans-serif`
  : `800 ${Math.round(px)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
let bubbleLoad: Promise<unknown> | null = null;
/** Start loading the bubble font. Safe to call more than once; never throws. */
export function loadBubbleFont(url = 'fonts/LilitaOne-Regular.ttf') {
  if (bubbleLoad || typeof FontFace === 'undefined') return;
  const face = new FontFace('Lilita One', `url(${JSON.stringify(url)})`);
  bubbleLoad = face.load().then(f => { document.fonts.add(f); bubbleReady = true; }).catch(() => { /* keep the stand-in */ });
}

/** A chain-bonus number ("x16") rising from where bugs popped. x, y are board cells. */
export type Float = { text: string; x: number; y: number; t0: number; size: number };
export const FLOAT_MS = 1000;

/** How long the clean-sweep banner and fireworks last. */
export const SWEEP_MS = 2600;
/** A clean sweep being celebrated: when it happened and the bonus it scored. */
export type Sweep = { t0: number; bonus: number };

export type RenderOptions = {
  shapesOnPieces: boolean;
  /** Full, Calm or Off (see Motion in storage.ts). */
  motion: Motion;
  time: number;
  images: SpriteImages | null;
  leavers: Leaver[];
  /** Hide the board's contents (while paused, so pausing can't be used to plan). */
  hidden?: boolean;
  /** Endless: board cells whose bug is still crawling in, with the time it set off. */
  arrivals?: Map<number, number>;
  /** Player's choice of exit effect for bugs; overrides the skin's when set. */
  bugExit?: ExitStyle;
  /** Chain-bonus numbers drifting up off the board. */
  floats?: Float[];
  /** A clean sweep to celebrate over the board (banner and fireworks). */
  sweep?: Sweep | null;
  /** The tutorial's "look ahead" step: make the Next piece glow. */
  glowNext?: boolean;
};

const ready = (img: HTMLImageElement | undefined): img is HTMLImageElement => !!img && img.complete && img.naturalWidth > 0;

/**
 * Work out where the board goes for a canvas of this CSS size. `frame` is how
 * many cells of skin frame surround the board; the cells shrink a little to fit it.
 */
export function computeLayout(w: number, h: number, reserveBottom: number, frame = 0): Layout {
  const usableH = h - reserveBottom;
  const portrait = w < usableH * 0.8;
  const f2 = frame * 2;
  const cell = portrait
    ? Math.floor(Math.min((w * 0.94) / (W + f2), (usableH * 0.96) / (H + 2.6 + frame)))
    : Math.floor(Math.min((usableH * 0.94) / (H + f2), (w * 0.94) / (W + 6 + frame)));
  const boardW = cell * W, boardH = cell * H;
  const boardX = portrait ? Math.round((w - boardW) / 2) : Math.round((w - boardW - cell * 5.5) / 2);
  const boardY = portrait ? Math.round(usableH - boardH - cell * Math.max(0.3, frame)) : Math.round((usableH - boardH) / 2);
  return { boardX, boardY, cell, portrait };
}

function shapePath(ctx: CanvasRenderingContext2D, kind: ShapeKind, cx: number, cy: number, r: number) {
  ctx.beginPath();
  switch (kind) {
    case 'circle': ctx.arc(cx, cy, r, 0, Math.PI * 2); break;
    case 'square': ctx.rect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7); break;
    case 'triangle':
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.95, cy + r * 0.75);
      ctx.lineTo(cx - r * 0.95, cy + r * 0.75);
      ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? r : r * 0.45;
        ctx.lineTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
      }
      ctx.closePath();
      break;
  }
}

const drawBug = (...a: Parameters<typeof drawBugArt>) => drawBugArt(...a);

/** A bug: its color's shape with eyes and feelers, wiggling gently. */
function drawBugArt(ctx: CanvasRenderingContext2D, skin: Skin, color: number, x: number, y: number, s: number, wiggle: number, images: SpriteImages | null, time: number) {
  if (images) {
    const alt = images.bugAlt[color];
    const frame = ready(alt) && Math.floor(time / (skin.frameMs ?? 400)) % 2 === 1 ? alt : images.bug[color];
    if (ready(frame)) { ctx.drawImage(frame, x, y + wiggle, s, s); return; }
  }
  const p = skin.pieces[color]!;
  const cx = x + s / 2, cy = y + s / 2 + wiggle;
  const r = s * 0.38;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = Math.max(1, s * 0.06);
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.35, cy - r * 0.6); ctx.lineTo(cx - r * 0.7, cy - r * 1.15);
  ctx.moveTo(cx + r * 0.35, cy - r * 0.6); ctx.lineTo(cx + r * 0.7, cy - r * 1.15);
  ctx.stroke();
  shapePath(ctx, p.shape, cx, cy, r);
  ctx.fillStyle = p.color;
  ctx.fill();
  for (const dx of [-0.32, 0.32]) {
    ctx.beginPath();
    ctx.arc(cx + dx * r, cy - r * 0.05, r * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + dx * r, cy, r * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
  }
}

/** One half of a piece: a rounded block, flat on the side that joins its partner. */
function drawHalf(ctx: CanvasRenderingContext2D, skin: Skin, color: number, link: Link, x: number, y: number, s: number, shapes: boolean, alpha = 1, images: SpriteImages | null = null, wild = false) {
  if (wild) { drawWildHalf(ctx, skin, link, x, y, s, alpha, images); return; }
  const img = images?.half[color];
  if (ready(img)) {
    ctx.globalAlpha = alpha;
    if (link) {
      // The joint: a short bar from this cell's centre toward the partner's.
      const [dx, dy] = link === 'L' ? [-1, 0] : link === 'R' ? [1, 0] : link === 'U' ? [0, -1] : [0, 1];
      ctx.strokeStyle = skin.connector ?? skin.boardEdge;
      ctx.lineWidth = s * 0.16;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + s / 2, y + s / 2);
      ctx.lineTo(x + s / 2 + dx * s * 0.5, y + s / 2 + dy * s * 0.5);
      ctx.stroke();
    }
    ctx.drawImage(img, x, y, s, s);
    ctx.globalAlpha = 1;
    return;
  }
  const p = skin.pieces[color]!;
  const pad = s * 0.08, r = s * 0.32;
  const L = x + pad, T = y + pad, R = x + s - pad, B = y + s - pad;
  // Corner radii: [top-left, top-right, bottom-right, bottom-left]; square where the partner joins.
  const radii = [r, r, r, r];
  if (link === 'R') { radii[1] = 0; radii[2] = 0; }
  if (link === 'L') { radii[0] = 0; radii[3] = 0; }
  if (link === 'D') { radii[2] = 0; radii[3] = 0; }
  if (link === 'U') { radii[0] = 0; radii[1] = 0; }
  const ext = pad; // reach into the gap so joined halves touch
  const l = link === 'L' ? L - ext : L, rr = link === 'R' ? R + ext : R;
  const t = link === 'U' ? T - ext : T, b = link === 'D' ? B + ext : B;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.roundRect(l, t, rr - l, b - t, radii);
  ctx.fillStyle = p.color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.04);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
  if (shapes) {
    shapePath(ctx, p.shape, x + s / 2, y + s / 2, s * 0.2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** The rounded block every half is drawn as: square on the side that joins its partner. */
function halfPath(ctx: CanvasRenderingContext2D, link: Link, x: number, y: number, s: number) {
  const pad = s * 0.08, r = s * 0.32;
  const L = x + pad, T = y + pad, R = x + s - pad, B = y + s - pad;
  const radii = [r, r, r, r];
  if (link === 'R') { radii[1] = 0; radii[2] = 0; }
  if (link === 'L') { radii[0] = 0; radii[3] = 0; }
  if (link === 'D') { radii[2] = 0; radii[3] = 0; }
  if (link === 'U') { radii[0] = 0; radii[1] = 0; }
  const l = link === 'L' ? L - pad : L, rr = link === 'R' ? R + pad : R;
  const t = link === 'U' ? T - pad : T, b = link === 'D' ? B + pad : B;
  ctx.beginPath();
  ctx.roundRect(l, t, rr - l, b - t, radii);
}

/**
 * A wildcard half (power-ups): striped in every piece color of the skin, with a white star,
 * so it reads as "any color" in any skin. A skin can supply its own picture (powerUps.wild).
 */
function drawWildHalf(ctx: CanvasRenderingContext2D, skin: Skin, link: Link, x: number, y: number, s: number, alpha: number, images: SpriteImages | null) {
  ctx.globalAlpha = alpha;
  const img = images?.power?.wild;
  if (ready(img)) {
    drawJoint(ctx, skin, link, x, y, s);
    ctx.drawImage(img, x, y, s, s);
    ctx.globalAlpha = 1;
    return;
  }
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  const colors = skin.pieces.map(p => p.color);
  colors.forEach((col, i) => { g.addColorStop(i / colors.length, col); g.addColorStop((i + 1) / colors.length - 0.001, col); });
  halfPath(ctx, link, x, y, s);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  star(ctx, x + s / 2, y + s / 2, s * 0.3, '#fff');
  ctx.globalAlpha = 1;
}

/** The joint bar between two sprite halves. */
function drawJoint(ctx: CanvasRenderingContext2D, skin: Skin, link: Link, x: number, y: number, s: number) {
  if (!link) return;
  const [dx, dy] = link === 'L' ? [-1, 0] : link === 'R' ? [1, 0] : link === 'U' ? [0, -1] : [0, 1];
  ctx.strokeStyle = skin.connector ?? skin.boardEdge;
  ctx.lineWidth = s * 0.16;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + s / 2, y + s / 2);
  ctx.lineTo(x + s / 2 + dx * s * 0.5, y + s / 2 + dy * s * 0.5);
  ctx.stroke();
}

export type PowerArt = PowerKind;

/**
 * A power-up's picture, filling one cell: the skin's sprite when it has one, else a built-in
 * drawing (a round bomb with a lit fuse, a drill bit pointing down, a rainbow star).
 */
export function drawPower(ctx: CanvasRenderingContext2D, skin: Skin, kind: PowerKind, x: number, y: number, s: number, images: SpriteImages | null, time = 0, alpha = 1) {
  ctx.globalAlpha = alpha;
  const img = images?.power?.[kind];
  if (ready(img)) { ctx.drawImage(img, x, y, s, s); ctx.globalAlpha = 1; return; }
  const cx = x + s / 2, cy = y + s / 2;
  if (kind === 'bomb') {
    ctx.fillStyle = '#2b2d36';
    ctx.beginPath(); ctx.arc(cx, cy + s * 0.08, s * 0.34, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.05); ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(cx - s * 0.12, cy - s * 0.04, s * 0.09, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6b6f80'; ctx.fillRect(cx - s * 0.08, cy - s * 0.32, s * 0.16, s * 0.1); // the cap
    ctx.strokeStyle = '#c9a26b'; ctx.lineWidth = Math.max(1, s * 0.05); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.32); ctx.quadraticCurveTo(cx + s * 0.05, cy - s * 0.45, cx + s * 0.18, cy - s * 0.4); ctx.stroke();
    const flick = 0.75 + 0.25 * Math.sin(time / 60);
    star(ctx, cx + s * 0.2, cy - s * 0.4, s * 0.16 * flick, '#ffb703');
    star(ctx, cx + s * 0.2, cy - s * 0.4, s * 0.07 * flick, '#fff6b0');
  } else if (kind === 'drill') {
    const top = y + s * 0.1, tip = y + s * 0.94, half = s * 0.28;
    ctx.fillStyle = '#c2c8d6'; // the bit, pointing down
    ctx.beginPath(); ctx.moveTo(cx - half, top + s * 0.22); ctx.lineTo(cx + half, top + s * 0.22); ctx.lineTo(cx, tip); ctx.closePath(); ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.04); ctx.strokeStyle = '#4d5466'; ctx.stroke();
    ctx.save(); ctx.clip(); // spiral grooves that turn with time
    ctx.strokeStyle = '#6d7488'; ctx.lineWidth = Math.max(1, s * 0.05);
    const turn = ((time / 90) % 1) * s * 0.2;
    for (let k = -2; k < 6; k++) { const yy = top + s * 0.22 + k * s * 0.2 + turn; ctx.beginPath(); ctx.moveTo(cx - half, yy); ctx.lineTo(cx + half, yy + s * 0.12); ctx.stroke(); }
    ctx.restore();
    ctx.fillStyle = '#ffb703'; // the handle
    ctx.beginPath(); ctx.roundRect(cx - half * 0.9, top, half * 1.8, s * 0.22, s * 0.05); ctx.fill();
    ctx.strokeStyle = '#7a4f00'; ctx.lineWidth = Math.max(1, s * 0.04); ctx.stroke();
  } else if (kind === 'wild') {
    const g = ctx.createConicGradient(time / 900, cx, cy);
    const colors = skin.pieces.map(p => p.color);
    colors.forEach((col, i) => g.addColorStop(i / colors.length, col));
    g.addColorStop(1, colors[0]!);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.05); ctx.strokeStyle = '#fff'; ctx.stroke();
    star(ctx, cx, cy, s * 0.3, '#fff');
  } else {
    // freeze (versus play, later): a snowflake
    ctx.strokeStyle = '#bfe8ff'; ctx.lineWidth = Math.max(1, s * 0.07); ctx.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI) / 3;
      ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * s * 0.38, cy - Math.sin(a) * s * 0.38); ctx.lineTo(cx + Math.cos(a) * s * 0.38, cy + Math.sin(a) * s * 0.38); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** Where the power-up icon sits on screen (CSS pixels), so main.ts can put a tap target over it. */
export function powerIconRect(layout: Layout): { x: number; y: number; size: number } {
  const { boardX: bx, boardY: by, cell: c } = layout;
  if (layout.portrait) return { x: bx, y: by - c * 1.35, size: c * 1.05 };
  return { x: bx + c * W + c * 1.2, y: by + c * 13.6, size: c * 1.4 };
}

/**
 * The power-up meter: METER_FULL notches that fill with popped bugs, and the held power-up's
 * icon (or an empty socket). Glows gently when one is ready to use.
 */
function drawPowerHud(ctx: CanvasRenderingContext2D, s: GameState, skin: Skin, layout: Layout, opt: RenderOptions) {
  const p = s.power;
  if (!p) return;
  const { cell: c } = layout;
  const r = powerIconRect(layout);
  const look = skin.meter ?? {}, pics = opt.images?.meter;
  const fullColor = look.full ?? '#ffb703', emptyColor = look.empty ?? 'rgba(255,255,255,0.12)';
  // The socket: the skin's picture, or a dark rounded box. Its edge glows when one is ready.
  if (ready(pics?.socket)) ctx.drawImage(pics.socket, r.x, r.y, r.size, r.size);
  else {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.roundRect(r.x, r.y, r.size, r.size, r.size * 0.25); ctx.fill();
  }
  ctx.strokeStyle = p.held ? look.ready ?? fullColor : skin.boardEdge;
  ctx.lineWidth = Math.max(1, c * (p.held ? 0.08 : 0.04));
  ctx.beginPath(); ctx.roundRect(r.x, r.y, r.size, r.size, r.size * 0.25); ctx.stroke();
  if (p.held) {
    const pulse = opt.motion === 'full' ? 1 + Math.sin(opt.time / 220) * 0.05 : 1;
    const sz = r.size * 0.86 * pulse;
    drawPower(ctx, skin, p.held, r.x + (r.size - sz) / 2, r.y + (r.size - sz) / 2, sz, opt.images, opt.motion === 'full' ? opt.time : 0);
  }
  // The notches, to the right of the socket (phone) or under it (wide screens).
  const n = METER_FULL, filled = p.held ? n : Math.min(n, p.meter);
  const gap = c * 0.06;
  const [mx, my, mw, mh] = layout.portrait
    ? [r.x + r.size + c * 0.25, r.y + r.size * 0.55, c * 3.2, c * 0.3]
    : [r.x, r.y + r.size + c * 0.25, r.size * 2.6, c * 0.3];
  const w = (mw - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const nx = mx + i * (w + gap), on = i < filled, pic = on ? pics?.notchFull : pics?.notch;
    if (ready(pic)) {
      // Picture notches keep their own shape: square, centered on the notch's box.
      const sz = Math.min(w, mh * 2.2);
      ctx.drawImage(pic, nx + (w - sz) / 2, my + mh / 2 - sz / 2, sz, sz);
      continue;
    }
    ctx.fillStyle = on ? fullColor : emptyColor;
    ctx.beginPath(); ctx.roundRect(nx, my, w, mh, mh * 0.4); ctx.fill();
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = skin.textDim;
  ctx.font = `500 ${Math.round(c * 0.42)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const label = p.held ? powerName(skin, p.held) : p.queued ? `${powerName(skin, p.queued)} is next` : 'POWER-UP';
  if (layout.portrait) ctx.fillText(p.held ? `${label} ready` : label, mx, my - c * 0.12);
  else ctx.fillText(label, r.x, r.y - c * 0.15);
}

/** The next piece: a pair of halves, or the power-up the player just used, waiting to drop. */
function drawNext(ctx: CanvasRenderingContext2D, s: GameState, skin: Skin, x: number, y: number, size: number, opt: RenderOptions) {
  const q = s.power?.queued;
  if (opt.glowNext) {
    const k = opt.motion === 'full' ? 0.5 + 0.5 * Math.sin(opt.time / 200) : 1;
    ctx.save();
    ctx.shadowColor = '#ffb703'; ctx.shadowBlur = size * 0.6 * k;
    ctx.strokeStyle = '#ffb703'; ctx.lineWidth = Math.max(2, size * 0.08);
    ctx.beginPath(); ctx.roundRect(x - size * 0.2, y - size * 0.2, size * 2.4, size * 1.4, size * 0.3); ctx.stroke();
    ctx.restore();
  }
  if (q === 'bomb' || q === 'drill') drawPower(ctx, skin, q, x + size * 0.5, y, size, opt.images, opt.motion === 'full' ? opt.time : 0);
  else {
    drawHalf(ctx, skin, s.next.a, 'R', x, y, size, opt.shapesOnPieces, 1, opt.images, q === 'wild');
    drawHalf(ctx, skin, s.next.b, 'L', x + size, y, size, opt.shapesOnPieces, 1, opt.images, q === 'wild');
  }
}

export function render(ctx: CanvasRenderingContext2D, s: GameState, skin: Skin, layout: Layout, opt: RenderOptions) {
  // Calm and Off both drop the wiggles, hops, flights and fireworks; Off also drops fades and floating text.
  const reducedMotion = opt.motion !== 'full', still = opt.motion === 'off';
  const { boardX: bx, boardY: by, cell: c } = layout;
  const cw = ctx.canvas.width / devicePixelRatio, ch = ctx.canvas.height / devicePixelRatio;
  ctx.fillStyle = skin.background;
  ctx.fillRect(0, 0, cw, ch);

  // Board: the skin's pictures when it has them, else a plain rounded box.
  const inside = opt.images?.boardInside, frame = opt.images?.boardFrame;
  const hasFrame = ready(frame);
  if (!hasFrame) {
    ctx.fillStyle = skin.boardFill;
    ctx.strokeStyle = skin.boardEdge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx - 4, by - 4, c * W + 8, c * H + 8, 8);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillStyle = skin.boardFill;
    ctx.fillRect(bx, by, c * W, c * H);
  }
  if (ready(inside)) ctx.drawImage(inside, bx, by, c * W, c * H);
  ctx.strokeStyle = skin.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < W; x++) { ctx.moveTo(bx + x * c + 0.5, by); ctx.lineTo(bx + x * c + 0.5, by + H * c); }
  for (let y = 1; y < H; y++) { ctx.moveTo(bx, by + y * c + 0.5); ctx.lineTo(bx + W * c, by + y * c + 0.5); }
  ctx.stroke();
  if (hasFrame) {
    const t = frameCells(skin) * c;
    ctx.drawImage(frame, bx - t, by - t, c * W + 2 * t, c * H + 2 * t);
  }

  if (opt.hidden) {
    ctx.fillStyle = skin.textDim;
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(c * 0.6)}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.fillText('Paused', bx + (c * W) / 2, by + (c * H) / 2);
    return;
  }
  const clearing = new Set(s.clearing);
  // Matched halves blink while they clear; with less motion they stay lit instead of blinking.
  const flashOn = s.phase === 'clearing' && (reducedMotion || Math.floor(s.phaseTimer / 4) % 2 === 0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const cell = s.board[i];
      if (!cell) continue;
      const px = bx + x * c, py = by + y * c;
      const fading = clearing.has(i);
      if (fading && cell.t === 'bug') {
        // Matched bugs get excited before they leave.
        const hop = reducedMotion ? 0 : -Math.abs(Math.sin(opt.time / 70)) * c * 0.18;
        drawBug(ctx, skin, cell.c, px, py, c, hop, opt.images, reducedMotion ? 0 : opt.time / 2);
        continue;
      }
      if (fading && flashOn) {
        if (reducedMotion) drawHalf(ctx, skin, cell.c, cell.t === 'half' ? cell.l : null, px, py, c, opt.shapesOnPieces, 1, opt.images, cell.t === 'half' && !!cell.w);
        ctx.fillStyle = reducedMotion ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.roundRect(px + c * 0.1, py + c * 0.1, c * 0.8, c * 0.8, c * 0.3);
        ctx.fill();
        continue;
      }
      const setOff = cell.t === 'bug' ? opt.arrivals?.get(i) : undefined;
      if (setOff !== undefined && opt.time - setOff < ARRIVE_MS) {
        // A new Endless bug crawling in along its row from the nearer side of the board.
        const p = (opt.time - setOff) / ARRIVE_MS;
        if (p < 0) continue; // not set off yet
        if (reducedMotion) {
          ctx.globalAlpha = still ? 1 : p;
          drawBug(ctx, skin, cell.c, px, py, c, 0, opt.images, opt.time);
          ctx.globalAlpha = 1;
          continue;
        }
        const fromX = x < W / 2 ? bx - c * 1.2 : bx + W * c + c * 0.2;
        const ease = 1 - (1 - p) * (1 - p);
        const hop = -Math.abs(Math.sin(p * Math.PI * 4)) * c * 0.08;
        drawBug(ctx, skin, cell.c, fromX + (px - fromX) * ease, py, c, hop, opt.images, opt.time / 2);
        continue;
      }
      if (cell.t === 'bug') {
        const wiggle = reducedMotion ? 0 : Math.sin(opt.time / 300 + x * 1.7 + y * 0.9) * c * 0.04;
        // Time 0 holds every bug on its first frame, so skins with walking bugs keep them still.
        drawBug(ctx, skin, cell.c, px, py, c, wiggle, opt.images, reducedMotion ? 0 : opt.time + (x * 137 + y * 61));
      } else drawHalf(ctx, skin, cell.c, cell.l, px, py, c, opt.shapesOnPieces, 1, opt.images, !!cell.w);
    }
  }

  // Falling piece and a faint guide showing where it would land.
  if (s.piece && s.phase === 'falling') {
    let ghost = s.piece;
    const fitsAt = (p: typeof ghost) => p.k ? p.y + 0 < H && s.board[idx(p.x, p.y)] === null : pieceCells(p).every(h => h.y < H && h.x >= 0 && h.x < W && (h.y < 0 || s.board[idx(h.x, h.y)] === null));
    while (fitsAt({ ...ghost, y: ghost.y + 1 })) ghost = { ...ghost, y: ghost.y + 1 };
    const k = s.piece.k, wild = !!s.piece.w;
    if (k) {
      // A bomb or drill: one cell. Its guide shows where it lands, and (faintly) what it will take with it.
      const t = reducedMotion ? 0 : opt.time;
      if (ghost.y !== s.piece.y) drawPower(ctx, skin, k, bx + ghost.x * c, by + ghost.y * c, c, opt.images, 0, 0.25);
      ctx.fillStyle = 'rgba(255,183,3,0.22)';
      ctx.strokeStyle = 'rgba(255,214,90,0.9)';
      ctx.lineWidth = Math.max(1, c * 0.05);
      for (const i of blastCells(s, ghost)) {
        ctx.beginPath();
        ctx.roundRect(bx + (i % W) * c + 2, by + Math.floor(i / W) * c + 2, c - 4, c - 4, c * 0.2);
        ctx.fill();
        ctx.stroke();
      }
      drawPower(ctx, skin, k, bx + s.piece.x * c, by + s.piece.y * c, c, opt.images, t);
    } else {
      if (ghost.y !== s.piece.y) for (const h of pieceCells(ghost)) drawHalf(ctx, skin, h.c, h.l, bx + h.x * c, by + h.y * c, c, false, 0.18, opt.images, wild);
      for (const h of pieceCells(s.piece)) drawHalf(ctx, skin, h.c, h.l, bx + h.x * c, by + h.y * c, c, opt.shapesOnPieces, 1, opt.images, wild);
    }
  }

  // Cleared objects leave the board, each kind in the skin's chosen style.
  const boardBottom = by + H * c;
  const styleFor = (kind: ObjectKind): ExitStyle =>
    reducedMotion ? 'fade' : (kind === 'bug' ? opt.bugExit : undefined) ?? skin.exits?.[kind] ?? DEFAULT_EXITS[kind];
  // Off: cleared pieces are simply gone.
  for (const l of still ? [] : opt.leavers) {
    const style = styleFor(l.kind);
    const t = Math.min(1, (opt.time - l.t0) / LEAVE_MS);
    const px = bx + l.x * c, py = by + l.y * c;
    const drawBug = (_ctx: CanvasRenderingContext2D, _skin: Skin, color: number, x: number, y: number, size: number, wiggle: number, images: SpriteImages | null, time: number) =>
      l.kind === 'bug' ? drawBugArt(ctx, skin, color, x, y, size, wiggle, images, time) : drawHalf(ctx, skin, color, null, x, y + wiggle, size, opt.shapesOnPieces, ctx.globalAlpha, images);
    if (style === 'fade') {
      ctx.globalAlpha = 1 - t;
      drawBug(ctx, skin, l.c, px, py, c, 0, opt.images, opt.time);
    } else if (style === 'fly') {
      const lift = (py + c * 1.5) * t * t; // accelerate upward until off screen
      const drift = Math.sin(t * Math.PI * 3) * c * 0.35 + l.dir * t * c * 1.2;
      drawBug(ctx, skin, l.c, px + drift, py - lift, c, 0, opt.images, opt.time * 3);
    } else if (style === 'fall') {
      // Hop up out of the grid, then tumble down past the bottom.
      const v0 = c * 6, g = (boardBottom - py + c * 8) * 2;
      const y = py - v0 * t + g * t * t;
      ctx.save();
      ctx.translate(px + c / 2 + l.dir * t * c * 2, y + c / 2);
      ctx.rotate(l.dir * t * Math.PI * 2);
      drawBug(ctx, skin, l.c, -c / 2, -c / 2, c, 0, opt.images, opt.time);
      ctx.restore();
    } else {
      // explode: the bug swells and vanishes in a burst of its color.
      const cx = px + c / 2, cy = py + c / 2;
      if (t < 0.25) {
        const k = 1 + t * 1.6;
        drawBug(ctx, skin, l.c, cx - (c * k) / 2, cy - (c * k) / 2, c * k, 0, opt.images, opt.time);
      }
      ctx.fillStyle = skin.pieces[l.c]!.color;
      ctx.globalAlpha = 1 - t;
      for (let k = 0; k < 10; k++) {
        const ang = (k / 10) * Math.PI * 2 + l.x;
        const dist = c * (0.3 + t * 1.8);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, c * 0.12 * (1 - t * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Chain-bonus numbers: rise about two cells and fade out, gold with a dark outline.
  for (const f of still ? [] : opt.floats ?? []) {
    const p = (opt.time - f.t0) / FLOAT_MS;
    if (p < 0 || p >= 1) continue;
    const rise = reducedMotion ? 0 : c * 2 * (1 - (1 - p) * (1 - p));
    const pop = reducedMotion ? 1 : p < 0.15 ? 0.6 + (p / 0.15) * 0.5 : p < 0.25 ? 1.1 - ((p - 0.15) / 0.1) * 0.1 : 1;
    const fx = Math.min(Math.max(bx + (f.x + 0.5) * c, bx + c), bx + c * (W - 1));
    ctx.save();
    ctx.globalAlpha = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
    ctx.translate(fx, by + (f.y + 0.5) * c - rise);
    ctx.scale(pop, pop);
    ctx.font = bubbleFont(c * f.size);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = c * 0.12;
    ctx.strokeStyle = '#3a1d00';
    ctx.strokeText(f.text, 0, 0);
    ctx.fillStyle = '#ffb703';
    ctx.fillText(f.text, 0, 0);
    ctx.restore();
  }

  if (opt.sweep && opt.time - opt.sweep.t0 < SWEEP_MS) drawSweep(ctx, skin, layout, opt.sweep, opt.time, opt.motion);

  // Side panel: next piece and stats.
  const font = (px: number, weight = 600) => `${weight} ${Math.round(px)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const stat = (label: string, value: string, x: number, y: number, align: CanvasTextAlign = 'left') => {
    ctx.textAlign = align;
    ctx.fillStyle = skin.textDim;
    ctx.font = font(c * 0.42, 500);
    ctx.fillText(label, x, y);
    ctx.fillStyle = skin.text;
    ctx.font = font(c * 0.75, 700);
    ctx.fillText(value, x, y + c * 0.85);
  };
  const speedName = ['Low', 'Med', 'High', 'Slo'][s.config.speed]!;
  if (layout.portrait) {
    const y = by - c * 2.3;
    stat(...levelStat(s), bx, y);
    stat('BUGS', String(s.bugsLeft), bx + c * 2, y);
    stat('SCORE', String(s.score), bx + c * W, y, 'right');
    // The multiplier sits small under the score, in the gap above the board.
    ctx.textAlign = 'right';
    ctx.fillStyle = multColor(s, skin);
    ctx.font = font(c * 0.5, 700);
    ctx.fillText(multText(s), bx + c * W, y + c * 1.55);
    // NEXT: labelled, between Bugs and Score (Mike, 2026-11-21: easy to miss without a label).
    ctx.textAlign = 'center';
    ctx.fillStyle = skin.textDim;
    ctx.font = font(c * 0.42, 500);
    ctx.fillText('NEXT', bx + c * 4.85, y);
    drawNext(ctx, s, skin, bx + c * 4, y + c * 0.12, c * 0.85, opt);
    drawPowerHud(ctx, s, skin, layout, opt);
  } else {
    const x = bx + c * W + c * 1.2;
    ctx.textAlign = 'left';
    ctx.fillStyle = skin.textDim;
    ctx.font = font(c * 0.42, 500);
    ctx.fillText('NEXT', x, by + c * 0.4);
    drawNext(ctx, s, skin, x, by + c * 0.7, c, opt);
    stat(...levelStat(s), x, by + c * 3.2);
    stat('SPEED', speedName, x, by + c * 5.2);
    stat('BUGS', String(s.bugsLeft), x, by + c * 7.2);
    stat('SCORE', String(s.score), x, by + c * 9.2);
    stat('MULTIPLIER', '', x, by + c * 11.2);
    ctx.fillStyle = multColor(s, skin);
    ctx.font = font(c * 0.75, 700);
    ctx.fillText(multText(s), x, by + c * 12.05);
    drawPowerHud(ctx, s, skin, layout, opt);
  }
}

/** The cells a bomb or drill resting at p would clear (the same rule as the engine's). */
function blastCells(s: GameState, p: { x: number; y: number; k?: 'bomb' | 'drill' }): number[] {
  const out: number[] = [];
  if (p.k === 'bomb') {
    const cy = p.y + 1 < H ? p.y + 1 : p.y;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = p.x + dx, y = cy + dy;
      if (x >= 0 && x < W && y >= 0 && y < H && s.board[idx(x, y)]) out.push(idx(x, y));
    }
  } else if (p.k === 'drill') {
    for (let d = 1; d <= DRILL_DEPTH && p.y + d < H; d++) if (s.board[idx(p.x, p.y + d)]) out.push(idx(p.x, p.y + d));
  }
  return out;
}

/** "x1.4": the multiplier the next popped bug scores at. */
const multText = (s: GameState) => `×${scoreMultiplier(s).toFixed(1)}`;
/** Dim at x1.0, gold once it is working for you. */
const multColor = (s: GameState, skin: Skin) => (scoreMultiplier(s) > 1 ? '#ffb703' : skin.textDim);

/**
 * A still picture of a saved game, for the "Resume or start new?" screen.
 * Drawn from the saved state with this device's skin, so no image has to be
 * uploaded with the save.
 */
export function thumbnail(s: GameState, skin: Skin, images: SpriteImages | null, shapesOnPieces: boolean, cssW = 150): HTMLCanvasElement {
  const cssH = Math.round(cssW * 1.95);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cssW * devicePixelRatio);
  canvas.height = Math.round(cssH * devicePixelRatio);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  // time 0 and reduced motion give a calm, repeatable picture.
  render(ctx, s, skin, computeLayout(cssW, cssH, 0, frameCells(skin)), { shapesOnPieces, motion: 'off', time: 0, images, leavers: [] });
  return canvas;
}

/**
 * The clean-sweep celebration: fireworks bursting over the empty board in the
 * skin's piece colors, and a "CLEAN SWEEP!" banner with the bonus that pops in,
 * holds, and fades. Everything is a function of time, so it needs no state.
 */
function drawSweep(ctx: CanvasRenderingContext2D, skin: Skin, layout: Layout, sweep: Sweep, time: number, motion: Motion) {
  const reducedMotion = motion !== 'full';
  const { boardX: bx, boardY: by, cell: c } = layout;
  const t = time - sweep.t0; // ms since the sweep
  const bw = c * W, bh = c * H;
  const colors = skin.pieces.map(p => p.color);

  // Fireworks: bursts at fixed spots, one after another. Each spark flies out, droops
  // under gravity and fades, with a short trail behind it.
  if (!reducedMotion) {
    const BURSTS = 7, GAP = 260, LIFE = 1100, SPARKS = 22;
    for (let b = 0; b < BURSTS; b++) {
      const age = t - b * GAP;
      if (age < 0 || age > LIFE) continue;
      const p = age / LIFE;
      // Spread bursts over the board above the banner, alternating sides, plus a few below it.
      const cx = bx + bw * (0.25 + ((b * 0.37 + (b % 2) * 0.3) % 0.5));
      const cy = by + bh * (b % 3 === 2 ? 0.8 : 0.1 + ((b * 0.29) % 0.3));
      const color = colors[b % colors.length]!;
      const radius = c * 2.6 * (1 - (1 - p) * (1 - p)); // fast out, slowing down
      const drop = c * 1.5 * p * p; // gravity
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      for (let k = 0; k < SPARKS; k++) {
        const ang = (k / SPARKS) * Math.PI * 2 + b;
        const r = radius * (0.75 + 0.25 * ((k * 7) % 3) / 2);
        const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r + drop;
        ctx.globalAlpha = (1 - p) * (k % 3 === 0 && Math.floor(age / 60) % 2 ? 0.4 : 1); // a little twinkle
        ctx.lineWidth = c * 0.08;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(ang) * c * 0.4 * (1 - p), y - Math.sin(ang) * c * 0.4 * (1 - p) - c * 0.1 * p);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, c * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }
      // The bright flash at the center as it bursts.
      if (p < 0.15) {
        ctx.globalAlpha = 1 - p / 0.15;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx, cy, c * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Banner: pops in with a little overshoot, holds, then fades out over the last 0.4 s.
  const popIn = Math.min(1, t / 350);
  const scale = reducedMotion ? 1 : popIn < 1 ? 1.25 * Math.sin(popIn * Math.PI * 0.62) / Math.sin(Math.PI * 0.62) : 1;
  // Off: the banner just appears and goes, with no fade.
  const alpha = motion === 'off' ? 1 : Math.min(popIn * 2, 1, (SWEEP_MS - t) / 400);
  if (alpha <= 0) return;
  const cx = bx + bw / 2, cy = by + bh * 0.55;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  // A dark ribbon behind the words so they read on any board picture.
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(-bw * 0.48, -c * 1.35, bw * 0.96, c * 2.55, c * 0.4);
  ctx.fill();
  const fontFor = bubbleFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = fontFor(c * 0.95);
  // Shrink the title if a narrow board can't fit it.
  const width = ctx.measureText('CLEAN SWEEP!').width;
  if (width > bw * 0.88) ctx.font = fontFor(c * 0.95 * (bw * 0.88) / width);
  const gold = ctx.createLinearGradient(0, -c * 0.9, 0, c * 0.1);
  gold.addColorStop(0, '#fff6b0');
  gold.addColorStop(1, '#ffb703');
  ctx.lineJoin = 'round';
  ctx.lineWidth = c * 0.14;
  ctx.strokeStyle = '#5a2d00';
  ctx.strokeText('CLEAN SWEEP!', 0, -c * 0.4);
  ctx.fillStyle = gold;
  ctx.fillText('CLEAN SWEEP!', 0, -c * 0.4);
  ctx.font = fontFor(c * 0.7);
  ctx.fillStyle = '#fff';
  ctx.fillText(`+${sweep.bonus.toLocaleString()}`, 0, c * 0.6);
  // Sparkles twinkling at the ribbon's corners.
  if (!reducedMotion) {
    for (const [sx, sy, ph] of [[-bw * 0.44, -c * 1.1, 0], [bw * 0.44, -c * 1.1, 1.3], [-bw * 0.4, c * 0.95, 2.1], [bw * 0.4, c * 0.95, 0.7]] as const) {
      const k = 0.5 + 0.5 * Math.sin(t / 120 + ph);
      star(ctx, sx, sy, c * 0.32 * (0.5 + k * 0.5), '#fff6b0');
    }
  }
  ctx.restore();
}

/** A four-pointed sparkle. */
function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 ? r * 0.28 : r;
    ctx.lineTo(x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);
  }
  ctx.closePath();
  ctx.fill();
}

/** The HUD shows the round number in an Endless run instead of a level. */
function levelStat(s: GameState): [string, string] {
  return endlessGame(s) ? ['ENDLESS', String(endlessRound(s))] : ['LEVEL', String(currentLevel(s))];
}

/**
 * A few board cells drawn in the skin's art, for the How to Play page.
 * Each row is a string of cells separated by spaces:
 *   ..        empty
 *   b0 - b4   a bug of that color
 *   h0 - h4   a lone piece half
 *   L0 R0 U0 D0   a half joined to its partner on the Left / Right / Up / Down
 *   w-  wL wR wU wD   a wildcard half (power-ups), lone or joined
 *   pb pd pw  a power-up's picture: bomb, drill, wildcard
 * A trailing ! marks a cell that is about to pop (drawn with a glow).
 */
export function diagram(rows: string[], skin: Skin, images: SpriteImages | null, shapesOnPieces: boolean, cell = 30): HTMLCanvasElement {
  const grid = rows.map(r => r.trim().split(/\s+/));
  const cols = Math.max(...grid.map(r => r.length));
  const pad = 6, cssW = cols * cell + pad * 2, cssH = grid.length * cell + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cssW * devicePixelRatio);
  canvas.height = Math.round(cssH * devicePixelRatio);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  // The same board look as the game: fill, edge and grid lines.
  ctx.fillStyle = skin.boardFill;
  ctx.strokeStyle = skin.boardEdge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(1, 1, cssW - 2, cssH - 2, 8);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = skin.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < cols; x++) { ctx.moveTo(pad + x * cell + 0.5, pad); ctx.lineTo(pad + x * cell + 0.5, cssH - pad); }
  for (let y = 1; y < grid.length; y++) { ctx.moveTo(pad, pad + y * cell + 0.5); ctx.lineTo(cssW - pad, pad + y * cell + 0.5); }
  ctx.stroke();
  grid.forEach((row, y) => row.forEach((tok, x) => {
    if (tok.startsWith('..')) return;
    const kind = tok[0]!, color = Number(tok[1]), px = pad + x * cell, py = pad + y * cell;
    if (tok.endsWith('!')) {
      // About to pop: a soft glow behind the cell.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.beginPath();
      ctx.roundRect(px + 1, py + 1, cell - 2, cell - 2, cell * 0.3);
      ctx.fill();
    }
    if (kind === 'b') drawBug(ctx, skin, color, px, py, cell, 0, images, 0);
    else if (kind === 'p') drawPower(ctx, skin, tok[1] === 'b' ? 'bomb' : tok[1] === 'd' ? 'drill' : 'wild', px, py, cell, images);
    else if (kind === 'w') drawHalf(ctx, skin, 0, tok[1] === '-' ? null : (tok[1] as Exclude<Link, null>), px, py, cell, false, 1, images, true);
    else drawHalf(ctx, skin, color, kind === 'h' ? null : (kind as Exclude<Link, null>), px, py, cell, shapesOnPieces, 1, images);
  }));
  return canvas;
}
