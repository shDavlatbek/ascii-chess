// Layout: one source of truth for where things are.  All values are CSS px
// (the canvas context is pre-scaled by dpr).  Recomputed on resize and flip;
// never cache derived numbers across a `resize(layout)` call.
//
// The world is a coarse character grid.  Each chess square is SQ_COLS × SQ_ROWS
// cells, and a cell is twice as tall as it is wide, so squares are square.

import { sqFile, sqRank, sqName } from './util.js';

export const SQ_COLS = 6;
export const SQ_ROWS = 3;

export function computeLayout(W, H, dpr = 1, flipped = false) {
  const portrait = H > W * 1.12;

  // Square size: leave room for side panels (landscape) or top/bottom panels
  // (portrait), plus headroom because pieces stand taller than their square.
  let sq = portrait
    ? Math.min((W * 0.96) / 8, (H * 0.56) / 8)
    : Math.min((H * 0.8) / 8, (W * 0.5) / 8);
  sq = Math.max(SQ_COLS * 4, Math.floor(sq / SQ_COLS) * SQ_COLS);   // whole px per cell

  const cw = sq / SQ_COLS;
  const ch = sq / SQ_ROWS;
  const size = sq * 8;
  const bx = Math.round((W - size) / 2);
  const by = Math.round((H - size) / 2 + sq * (portrait ? 0.1 : 0.22));

  // World grid covers the whole screen and is aligned to the board.
  const c0 = Math.ceil(bx / cw);            // cell column of the board's left edge
  const r0 = Math.ceil(by / ch);            // cell row of the board's top edge
  const ox = bx - c0 * cw;                  // x of cell column 0 (≤ 0)
  const oy = by - r0 * ch;                  // y of cell row 0 (≤ 0)
  const cols = Math.ceil((W - ox) / cw);
  const rows = Math.ceil((H - oy) / ch);

  const gap = Math.max(10, sq * 0.35);
  const pad = Math.max(8, Math.min(W, H) * 0.02);
  const panels = portrait
    ? {
        a: { x: pad, y: pad, w: W - pad * 2, h: Math.max(0, by - sq * 0.55 - pad) },
        b: { x: pad, y: by + size + gap * 0.6, w: W - pad * 2, h: Math.max(0, H - (by + size + gap * 0.6) - pad) },
      }
    : {
        a: { x: pad, y: pad, w: Math.max(0, bx - gap - pad), h: H - pad * 2 },
        b: { x: bx + size + gap, y: pad, w: Math.max(0, W - (bx + size + gap) - pad), h: H - pad * 2 },
      };

  const layout = {
    W, H, dpr, flipped, portrait,

    // Coarse world grid
    cw, ch, cols, rows, ox, oy,
    fontPx: Math.round(cw * 1.6 * 4) / 4,   // font size for coarse glyphs
    cellX: (c) => ox + (c + 0.5) * cw,      // centre of a cell
    cellY: (r) => oy + (r + 0.5) * ch,
    cellAt: (x, y) => ({ c: Math.floor((x - ox) / cw), r: Math.floor((y - oy) / ch) }),

    // Board
    sq,
    board: { x: bx, y: by, size, c0, r0, cols: SQ_COLS * 8, rows: SQ_ROWS * 8 },
    sqCols: SQ_COLS, sqRows: SQ_ROWS,

    // Pieces: the tallest piece (king) stands this tall; feet sit at pieceFoot().
    pieceH: sq * 1.5,
    fineW: Math.max(3, sq / 17),            // suggested fine-glyph cell width for sculptures

    // HUD regions.  landscape: a = left, b = right.  portrait: a = top, b = bottom.
    panels,

    // --- square <-> screen -------------------------------------------------
    // Screen column/row (0..7, 0 = left/top) of a square, honouring flip.
    squareCol: (s) => (flipped ? 7 - sqFile(s) : sqFile(s)),
    squareRow: (s) => (flipped ? sqRank(s) : 7 - sqRank(s)),
    squareRect(s) {
      return { x: bx + this.squareCol(s) * sq, y: by + this.squareRow(s) * sq, w: sq, h: sq };
    },
    squareCenter(s) {
      return { x: bx + (this.squareCol(s) + 0.5) * sq, y: by + (this.squareRow(s) + 0.5) * sq };
    },
    // Where a piece's feet touch the ground.
    pieceFoot(s) {
      return { x: bx + (this.squareCol(s) + 0.5) * sq, y: by + (this.squareRow(s) + 0.86) * sq };
    },
    // Top-left world cell of a square.
    squareCell(s) {
      return { c: c0 + this.squareCol(s) * SQ_COLS, r: r0 + this.squareRow(s) * SQ_ROWS };
    },
    squareAt(x, y) {
      const col = Math.floor((x - bx) / sq), row = Math.floor((y - by) / sq);
      if (col < 0 || col > 7 || row < 0 || row > 7) return null;
      return flipped ? sqName(7 - col, row) : sqName(col, 7 - row);
    },
    // Square under a world cell, or null if the cell is off the board.
    squareAtCell(c, r) {
      const col = Math.floor((c - c0) / SQ_COLS), row = Math.floor((r - r0) / SQ_ROWS);
      if (col < 0 || col > 7 || row < 0 || row > 7) return null;
      return flipped ? sqName(7 - col, row) : sqName(col, 7 - row);
    },
  };
  return layout;
}
