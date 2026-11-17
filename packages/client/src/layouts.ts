// On-screen button layouts for touch screens. The player picks one in the menu; the
// menu shows a live preview of the chosen row so they can see it before playing.

export type TouchInput = 'left' | 'right' | 'down' | 'rotCW' | 'rotCCW' | 'pause';
export type LayoutId = 'edges' | 'four' | 'original';

const GLYPH: Record<TouchInput, [string, string]> = {
  left: ['◀', 'Move left'],
  right: ['▶', 'Move right'],
  down: ['▼', 'Drop faster'],
  rotCW: ['⟳', 'Turn right'],
  rotCCW: ['⟲', 'Turn left'],
  pause: ['❚❚', 'Pause'],
};

export const LAYOUTS: Record<LayoutId, { name: string; buttons: TouchInput[]; pauseOnTop: boolean }> = {
  // Moves on the outside edges, turns next to them, drop in the middle.
  edges: { name: 'Moves on the edges', buttons: ['left', 'rotCCW', 'down', 'rotCW', 'right'], pauseOnTop: true },
  // Four big buttons, one turn direction.
  four: { name: 'Four buttons', buttons: ['left', 'right', 'down', 'rotCW'], pauseOnTop: true },
  // The first layout, with pause in the row.
  original: { name: 'Original', buttons: ['left', 'down', 'right', 'rotCCW', 'rotCW', 'pause'], pauseOnTop: false },
};

export const isLayout = (v: unknown): v is LayoutId => typeof v === 'string' && v in LAYOUTS;

/** Fill a row element with the layout's buttons (data-input attributes, ready for InputManager). */
export function renderButtons(row: HTMLElement, id: LayoutId) {
  const layout = LAYOUTS[id];
  row.dataset.layout = id;
  row.style.gridTemplateColumns = layout.buttons.map(b => (b === 'pause' ? 'minmax(0, 0.7fr)' : 'minmax(0, 1fr)')).join(' ');
  row.replaceChildren(...layout.buttons.map(b => {
    const btn = document.createElement('button');
    btn.dataset.input = b;
    btn.textContent = GLYPH[b][0];
    btn.setAttribute('aria-label', GLYPH[b][1]);
    if (b === 'pause') btn.className = 'small';
    return btn;
  }));
}

/** A small, non-interactive copy of the row for the menu preview. */
export function renderPreview(row: HTMLElement, id: LayoutId) {
  renderButtons(row, id);
  for (const b of row.querySelectorAll('button')) { b.tabIndex = -1; b.removeAttribute('data-input'); }
}
