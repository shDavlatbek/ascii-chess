// Sprite cache: turns sculpted glyph frames into bitmaps.
//
// Glyph frames (cells) depend only on (type, yaw step, res) and are shared by
// both armies; bitmaps additionally depend on colour, glyph size and dpr.
// Everything is built lazily, one frame at a time, the first time it is asked
// for — so a resize never hitches: the next draw renders the dozen frames that
// are on screen and the rest trickle in as the pieces turn.

import { PAL } from '../core/palette.js';
import { getAtlas } from '../core/glyphs.js';
import { TAU } from '../core/util.js';
import { ASPECT, SX, SY, STEP, TILT, SHAPE, frameCount, gridBox, renderCells } from './sculpt.js';

export const ARMY = { w: PAL.bone, b: PAL.ember };
const FONT_K = 1.86;               // font px per fine cell width → glyphs overlap a little
const BACKING = '#0b0b11';         // the occluding body behind the glyphs

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function createSprites() {
  const cellCache = new Map();     // `${type}|${i}` → cells (for the current res)
  const bitmaps = new Map();       // `${type}${color}|${i}` → canvas
  const boxes = {};
  let M = null;                    // metrics
  let key = '';

  function configure(layout) {
    const sq = layout.sq, dpr = layout.dpr || 1;
    // Fine cell: a touch finer than the layout's suggestion so a king is ~14
    // glyphs wide; never below ~2 px or the glyphs stop being glyphs.
    const fw = Math.max(2.1, (layout.fineW || sq / 17) * 0.8);
    const fh = fw * ASPECT;
    const S = layout.pieceH / (SHAPE.k.h * Math.cos(TILT));   // px per model unit
    const res = Math.round((S / fw) * 50) / 50;               // columns per model unit
    const fontPx = Math.round(fw * FONT_K * 4) / 4;
    const k = `${res}|${fw.toFixed(3)}|${fontPx}|${dpr}`;
    if (M && Math.abs(M.res - res) > 1e-6) cellCache.clear();
    if (k !== key) { bitmaps.clear(); key = k; for (const t in boxes) delete boxes[t]; }
    M = { sq, dpr, fw, fh, S, res, fontPx };
    return M;
  }

  function box(type) {
    let b = boxes[type];
    if (!b) {
      const g = gridBox(type, M.res);
      const pad = Math.ceil(M.fontPx * 0.6) + 1;
      b = boxes[type] = {
        ...g,
        w: g.cols * M.fw + pad * 2, h: g.rows * M.fh + pad * 2,
        ax: g.ox * M.fw + pad, ay: g.oy * M.fh + pad,         // foot inside the bitmap, px
        pad,
        height: SHAPE[type].h * Math.cos(TILT) * M.S,          // visible height above the foot, px
        frames: frameCount(type),
      };
      b.dw = Math.ceil(b.w * M.dpr); b.dh = Math.ceil(b.h * M.dpr);
    }
    return b;
  }

  // Frame index for a yaw (wraps within the model's symmetry period).
  function index(type, yaw) {
    const n = frameCount(type);
    return ((Math.round(yaw / STEP) % n) + n) % n;
  }

  function cells(type, i) {
    const k = `${type}|${i}`;
    let c = cellCache.get(k);
    if (!c) { c = renderCells(type, i * STEP, M.res); cellCache.set(k, c); }
    return c;
  }

  function bitmap(type, color, i) {
    const k = `${type}${color}|${i}`;
    let bm = bitmaps.get(k);
    if (bm) return bm;
    const b = box(type), c = cells(type, i), { dpr, fw, fh, fontPx } = M;
    bm = makeCanvas(b.dw, b.dh);
    const g = bm.getContext('2d');
    g.scale(dpr, dpr);
    // 1. occluder: the exact sub-cell silhouette, grown by a hair
    g.fillStyle = BACKING;
    const sw = fw / SX, sh = fh / SY, grow = Math.max(0.6, fw * 0.16);
    for (let n = 0; n < c.n; n++) {
      const m = c.mask[n], x0 = b.pad + c.col[n] * fw, y0 = b.pad + c.row[n] * fh;
      for (let j = 0; j < SY; j++) {
        const bits = (m >> (j * SX)) & 7;
        if (!bits) continue;
        let i0 = 0;
        while (i0 < SX) {
          if (!(bits & (1 << i0))) { i0++; continue; }
          let i1 = i0;
          while (i1 + 1 < SX && bits & (1 << (i1 + 1))) i1++;
          g.fillRect(x0 + i0 * sw - grow, y0 + j * sh - grow, (i1 - i0 + 1) * sw + grow * 2, sh + grow * 2);
          i0 = i1 + 1;
        }
      }
    }
    // 2. glyphs, shadow shades first so lit glyphs overlap on top
    const pal = ARMY[color];
    for (let s = 5; s >= 0; s--) {
      const atlas = getAtlas({ fontPx, color: pal[s], dpr });
      for (let n = 0; n < c.n; n++) {
        if (c.shade[n] !== s || !c.code[n]) continue;
        const x = b.ax + c.x[n] * fw, y = b.ay + c.y[n] * fh;
        atlas.drawCode(g, c.code[n], Math.round(x * dpr) / dpr, Math.round(y * dpr) / dpr);
      }
    }
    bitmaps.set(k, bm);
    return bm;
  }

  // Cells of a frame in px relative to the foot (x right, y down).
  function forEachCell(type, i, fn) {
    const c = cells(type, i), { fw, fh } = M;
    for (let n = 0; n < c.n; n++) {
      if (!c.code[n]) continue;
      fn(c.x[n] * fw, c.y[n] * fh, c.code[n], c.shade[n]);
    }
  }

  return {
    configure, box, index, cells, bitmap, forEachCell,
    get metrics() { return M; },
    get stats() { return { bitmaps: bitmaps.size, cells: cellCache.size }; },
    period: (type) => TAU / SHAPE[type].order,
  };
}
