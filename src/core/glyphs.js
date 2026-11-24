// Glyph atlas: pre-rasterised ASCII so a frame is thousands of cheap drawImage
// calls instead of thousands of fillText calls.
//
//   const atlas = getAtlas({ fontPx: 18, color: '#b4b1ea', dpr });
//   atlas.draw(ctx, 'H', cx, cy);          // glyph centred on (cx, cy), CSS px
//   atlas.drawCode(ctx, 72, cx, cy);       // same, by char code (hot loops)
//   ctx.globalAlpha = 0.4; atlas.draw(...) // brightness / fades via alpha
//
// Atlases are cached by (fontPx, color, weight, dpr).  Quantise colours to a
// small set (palette entries, or ~8 steps of a mix) — don't mint one per frame.

import { FONT_FAMILY } from './palette.js';

const FIRST = 33, LAST = 126, COUNT = LAST - FIRST + 1;
const MAX_ATLASES = 320;
const cache = new Map();

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function fontString(fontPx, weight = 700) {
  return `${weight} ${fontPx}px ${FONT_FAMILY}`;
}

export function getAtlas({ fontPx, color, weight = 700, dpr = 1 }) {
  const px = Math.round(fontPx * 4) / 4;
  const key = `${px}|${color}|${weight}|${dpr}`;
  let atlas = cache.get(key);
  if (atlas) {
    cache.delete(key); cache.set(key, atlas);   // refresh LRU position
    return atlas;
  }

  // Each glyph gets a padded cell so nothing clips, whatever the font metrics.
  const cellW = Math.ceil(px * 0.9 * dpr) + 4;
  const cellH = Math.ceil(px * 1.35 * dpr) + 4;
  const canvas = makeCanvas(cellW * COUNT, cellH);
  const g = canvas.getContext('2d');
  g.font = fontString(px * dpr, weight);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  for (let i = 0; i < COUNT; i++) {
    g.fillText(String.fromCharCode(FIRST + i), i * cellW + cellW / 2, cellH / 2 + px * dpr * 0.04);
  }

  const w = cellW / dpr, h = cellH / dpr, hw = w / 2, hh = h / 2;
  atlas = {
    canvas, fontPx: px, color, cellW, cellH, w, h,
    drawCode(ctx, code, cx, cy) {
      if (code < FIRST || code > LAST) return;
      ctx.drawImage(canvas, (code - FIRST) * cellW, 0, cellW, cellH, cx - hw, cy - hh, w, h);
    },
    draw(ctx, ch, cx, cy) {
      this.drawCode(ctx, ch.charCodeAt(0), cx, cy);
    },
    // Scaled draw (for zoom / squash effects).
    drawScaled(ctx, code, cx, cy, sx, sy = sx) {
      if (code < FIRST || code > LAST) return;
      ctx.drawImage(canvas, (code - FIRST) * cellW, 0, cellW, cellH, cx - hw * sx, cy - hh * sy, w * sx, h * sy);
    },
    // Left-aligned monospace text; `advance` defaults to the natural 0.6em.
    text(ctx, str, x, cy, advance = px * 0.6) {
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code !== 32) this.drawCode(ctx, code, x + advance * (i + 0.5), cy);
      }
      return x + advance * str.length;
    },
  };

  cache.set(key, atlas);
  if (cache.size > MAX_ATLASES) cache.delete(cache.keys().next().value);
  return atlas;
}

export function clearAtlases() { cache.clear(); }
