// Canvas drawing. Reads the game state and the skin; never changes either.

import { BOARD_HEIGHT as H, BOARD_WIDTH as W, idx, pieceCells, type GameState, type Link } from '@bug-pop/engine';
import { DEFAULT_EXITS, type ExitStyle, type ObjectKind, type ShapeKind, type Skin, type SpriteImages } from './skin';

export type Layout = { boardX: number; boardY: number; cell: number; portrait: boolean };

/** A cleared bug on its way off the screen (bugs leave; they are never destroyed). */
export type Leaver = { kind: ObjectKind; x: number; y: number; c: number; t0: number; dir: 1 | -1 };
export const LEAVE_MS = 1100;

export type RenderOptions = {
  shapesOnPieces: boolean;
  reducedMotion: boolean;
  time: number;
  images: SpriteImages | null;
  leavers: Leaver[];
  /** Hide the board's contents (while paused, so pausing can't be used to plan). */
  hidden?: boolean;
  /** Player's choice of exit effect for bugs; overrides the skin's when set. */
  bugExit?: ExitStyle;
};

const ready = (img: HTMLImageElement | undefined): img is HTMLImageElement => !!img && img.complete && img.naturalWidth > 0;

/** Work out where the board goes for a canvas of this CSS size. */
export function computeLayout(w: number, h: number, reserveBottom: number): Layout {
  const usableH = h - reserveBottom;
  const portrait = w < usableH * 0.8;
  const cell = portrait
    ? Math.floor(Math.min((w * 0.94) / W, (usableH * 0.96) / (H + 2.6)))
    : Math.floor(Math.min((usableH * 0.94) / H, (w * 0.94) / (W + 6)));
  const boardW = cell * W, boardH = cell * H;
  const boardX = portrait ? Math.round((w - boardW) / 2) : Math.round((w - boardW - cell * 5.5) / 2);
  const boardY = portrait ? Math.round(usableH - boardH - cell * 0.3) : Math.round((usableH - boardH) / 2);
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
function drawHalf(ctx: CanvasRenderingContext2D, skin: Skin, color: number, link: Link, x: number, y: number, s: number, shapes: boolean, alpha = 1, images: SpriteImages | null = null) {
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

export function render(ctx: CanvasRenderingContext2D, s: GameState, skin: Skin, layout: Layout, opt: RenderOptions) {
  const { boardX: bx, boardY: by, cell: c } = layout;
  const cw = ctx.canvas.width / devicePixelRatio, ch = ctx.canvas.height / devicePixelRatio;
  ctx.fillStyle = skin.background;
  ctx.fillRect(0, 0, cw, ch);

  // Board
  ctx.fillStyle = skin.boardFill;
  ctx.strokeStyle = skin.boardEdge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(bx - 4, by - 4, c * W + 8, c * H + 8, 8);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = skin.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < W; x++) { ctx.moveTo(bx + x * c + 0.5, by); ctx.lineTo(bx + x * c + 0.5, by + H * c); }
  for (let y = 1; y < H; y++) { ctx.moveTo(bx, by + y * c + 0.5); ctx.lineTo(bx + W * c, by + y * c + 0.5); }
  ctx.stroke();

  if (opt.hidden) {
    ctx.fillStyle = skin.textDim;
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(c * 0.6)}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.fillText('Paused', bx + (c * W) / 2, by + (c * H) / 2);
    return;
  }
  const clearing = new Set(s.clearing);
  const flashOn = s.phase === 'clearing' && Math.floor(s.phaseTimer / 4) % 2 === 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const cell = s.board[i];
      if (!cell) continue;
      const px = bx + x * c, py = by + y * c;
      const fading = clearing.has(i);
      if (fading && cell.t === 'bug') {
        // Matched bugs get excited before they leave.
        const hop = opt.reducedMotion ? 0 : -Math.abs(Math.sin(opt.time / 70)) * c * 0.18;
        drawBug(ctx, skin, cell.c, px, py, c, hop, opt.images, opt.time / 2);
        continue;
      }
      if (fading && flashOn) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.roundRect(px + c * 0.1, py + c * 0.1, c * 0.8, c * 0.8, c * 0.3);
        ctx.fill();
        continue;
      }
      if (cell.t === 'bug') {
        const wiggle = opt.reducedMotion ? 0 : Math.sin(opt.time / 300 + x * 1.7 + y * 0.9) * c * 0.04;
        drawBug(ctx, skin, cell.c, px, py, c, wiggle, opt.images, opt.time + (x * 137 + y * 61));
      } else drawHalf(ctx, skin, cell.c, cell.l, px, py, c, opt.shapesOnPieces, 1, opt.images);
    }
  }

  // Falling piece and a faint guide showing where it would land.
  if (s.piece && s.phase === 'falling') {
    let ghost = s.piece;
    const fitsAt = (p: typeof ghost) => pieceCells(p).every(h => h.y >= 0 && h.y < H && h.x >= 0 && h.x < W && s.board[idx(h.x, h.y)] === null);
    while (fitsAt({ ...ghost, y: ghost.y + 1 })) ghost = { ...ghost, y: ghost.y + 1 };
    if (ghost.y !== s.piece.y) for (const h of pieceCells(ghost)) drawHalf(ctx, skin, h.c, h.l, bx + h.x * c, by + h.y * c, c, false, 0.18, opt.images);
    for (const h of pieceCells(s.piece)) drawHalf(ctx, skin, h.c, h.l, bx + h.x * c, by + h.y * c, c, opt.shapesOnPieces, 1, opt.images);
  }

  // Cleared objects leave the board, each kind in the skin's chosen style.
  const boardBottom = by + H * c;
  const styleFor = (kind: ObjectKind): ExitStyle =>
    opt.reducedMotion ? 'fade' : (kind === 'bug' ? opt.bugExit : undefined) ?? skin.exits?.[kind] ?? DEFAULT_EXITS[kind];
  for (const l of opt.leavers) {
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
  const speedName = ['Low', 'Med', 'High'][s.config.speed]!;
  if (layout.portrait) {
    const y = by - c * 2.3;
    stat('LEVEL', String(s.config.level), bx, y);
    stat('BUGS', String(s.bugsLeft), bx + c * 2, y);
    stat('SCORE', String(s.score), bx + c * W, y, 'right');
    drawHalf(ctx, skin, s.next.a, 'R', bx + c * 4, y - c * 0.2, c * 0.9, opt.shapesOnPieces, 1, opt.images);
    drawHalf(ctx, skin, s.next.b, 'L', bx + c * 4.9, y - c * 0.2, c * 0.9, opt.shapesOnPieces, 1, opt.images);
  } else {
    const x = bx + c * W + c * 1.2;
    ctx.textAlign = 'left';
    ctx.fillStyle = skin.textDim;
    ctx.font = font(c * 0.42, 500);
    ctx.fillText('NEXT', x, by + c * 0.4);
    drawHalf(ctx, skin, s.next.a, 'R', x, by + c * 0.7, c, opt.shapesOnPieces, 1, opt.images);
    drawHalf(ctx, skin, s.next.b, 'L', x + c, by + c * 0.7, c, opt.shapesOnPieces, 1, opt.images);
    stat('LEVEL', String(s.config.level), x, by + c * 3.2);
    stat('SPEED', speedName, x, by + c * 5.2);
    stat('BUGS', String(s.bugsLeft), x, by + c * 7.2);
    stat('SCORE', String(s.score), x, by + c * 9.2);
  }
}
