// UI kit: shared per-frame state, glyph-atlas text, widget registry, buttons.
// Everything the HUD / menu / modals draw goes through here so text stays
// crisp (snapped to device pixels) and ASCII-only.

import { getAtlas } from '../core/glyphs.js';
import { PAL, SIDE_NAME } from '../core/palette.js';
import { hash2 } from '../core/util.js';

export const K = {
  ctx: null, layout: null, view: null, bus: null, audio: null,
  dpr: 1, t: 0, dt: 1 / 60, phaseT: 0, alpha: 1,
  widgets: [],        // rebuilt every draw; topmost last
  hover: null,        // widget id under the pointer
  press: null,        // widget id being pressed
  modal: false,       // board input is blocked
  reduced: false,
};

export function begin(ctx, view, layout) {
  K.ctx = ctx; K.view = view; K.layout = layout;
  K.dpr = layout.dpr || 1;
  K.t = view.t || 0;
  K.reduced = !!view.reducedMotion;
  K.widgets.length = 0;
}

// ---- metrics -------------------------------------------------------------
export function adv(size) {
  const d = K.dpr;
  return Math.max(1 / d, Math.round(size * 0.6 * d) / d);
}
export const tw = (str, size) => str.length * adv(size);

/** Body font size derived from the board square. */
export function bodySize(L = K.layout) {
  return Math.max(11, Math.min(26, Math.round(L.sq * 0.16 + 4)));
}

const memo = new Map();
function atl(size, color) {
  const key = size + '|' + color + '|' + K.dpr;
  let a = memo.get(key);
  if (!a) {
    a = getAtlas({ fontPx: size, color, dpr: K.dpr });
    memo.set(key, a);
    if (memo.size > 200) memo.delete(memo.keys().next().value);
  }
  return a;
}

// ---- drawing -------------------------------------------------------------
function blit(ctx, a, code, cx, cy, d) {
  const left = Math.round((cx - a.w / 2) * d) / d;
  const top = Math.round((cy - a.h / 2) * d) / d;
  ctx.drawImage(a.canvas, (code - 33) * a.cellW, 0, a.cellW, a.cellH, left, top, a.w, a.h);
}

export function glyph(code, cx, cy, size, color, alpha = 1) {
  if (code < 33 || code > 126) return;
  const ctx = K.ctx, a = atl(Math.round(size), color);
  if (alpha === 1) { blit(ctx, a, code, cx, cy, K.dpr); return; }
  const p = ctx.globalAlpha;
  ctx.globalAlpha = p * alpha;
  blit(ctx, a, code, cx, cy, K.dpr);
  ctx.globalAlpha = p;
}

/** Draws `str` with its vertical centre at cy. Returns the x after the last char. */
export function text(str, x, cy, size, color, o) {
  size = Math.round(size);
  const a = (o && o.adv) || adv(size), n = str.length, w = n * a;
  const align = (o && o.align) || 'l';
  const x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x;
  const at = atl(size, color), ctx = K.ctx, d = K.dpr;
  const alpha = o && o.alpha !== undefined ? o.alpha : 1;
  const p = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = p * alpha;
  const top = Math.round((cy - at.h / 2) * d) / d;
  for (let i = 0; i < n; i++) {
    const code = str.charCodeAt(i);
    if (code < 33 || code > 126) continue;
    const left = Math.round((x0 + a * (i + 0.5) - at.w / 2) * d) / d;
    ctx.drawImage(at.canvas, (code - 33) * at.cellW, 0, at.cellW, at.cellH, left, top, at.w, at.h);
  }
  if (alpha !== 1) ctx.globalAlpha = p;
  return x0 + w;
}

// ---- scramble-in text ----------------------------------------------------
const SCR = new Map();
const NOISE = 'Z#N%S+=~:;.*';
export function scr(key, str, dur = 0.42) {
  if (K.reduced) return str;
  let s = SCR.get(key);
  if (!s) { s = { cur: str, prev: '', t0: K.t }; SCR.set(key, s); }
  else if (s.cur !== str) { s.prev = s.cur; s.cur = str; s.t0 = K.t; }
  const age = K.t - s.t0, per = 0.028;
  if (age > dur + str.length * per || age < 0) return str;
  let out = '';
  const fr = Math.floor(K.t * 30);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === ' ') { out += ' '; continue; }
    const a = age - i * per;
    if (a >= dur) out += ch;
    else if (a < 0) out += s.prev[i] || ' ';
    else out += NOISE[(hash2(i, fr, key.length) * NOISE.length) | 0];
  }
  return out;
}

export function wrap(str, maxChars) {
  const words = str.split(' '), lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Glyph frame (corners '+', edges '-' and '|'). */
export function frame(x, y, w, h, size, color, alpha = 1) {
  const a = adv(size);
  const nx = Math.max(2, Math.round(w / a)), sx = w / nx;
  const rp = size * 1.15, ny = Math.max(1, Math.round(h / rp)), sy = h / ny;
  for (let i = 1; i < nx; i++) {
    glyph(45, x + i * sx, y, size, color, alpha);
    glyph(45, x + i * sx, y + h, size, color, alpha);
  }
  for (let j = 1; j < ny; j++) {
    glyph(124, x, y + j * sy, size, color, alpha);
    glyph(124, x + w, y + j * sy, size, color, alpha);
  }
  glyph(43, x, y, size, color, alpha); glyph(43, x + w, y, size, color, alpha);
  glyph(43, x, y + h, size, color, alpha); glyph(43, x + w, y + h, size, color, alpha);
}

// ---- widgets -------------------------------------------------------------
export function widget(id, x, y, w, h, action = null, enabled = true, block = false) {
  K.widgets.push({ id, x, y, w, h, action, enabled, block });
}
export function hitTest(px, py) {
  const P = 3;
  for (let i = K.widgets.length - 1; i >= 0; i--) {
    const w = K.widgets[i];
    if (px >= w.x - P && px <= w.x + w.w + P && py >= w.y - P && py <= w.y + w.h + P) return w;
  }
  return null;
}

const BTN_H = (size) => Math.max(30, Math.round(size * 2.2));

/** A glyph button `[ LABEL ]` with hover / press states. Returns its width. */
export function btn(id, label, x, cy, size, o = {}) {
  const { action = null, enabled = true, tone = 0, focus = false } = o;
  const a = adv(size), w = (label.length + 4) * a, h = BTN_H(size);
  widget(id, x, cy - h / 2, w, h, action, enabled);
  const hov = enabled && (K.hover === id || focus), prs = enabled && K.press === id && K.hover === id;
  const ctx = K.ctx;
  if (prs) { ctx.fillStyle = 'rgba(246,207,154,0.16)'; ctx.fillRect(x, cy - h / 2 + 3, w, h - 6); }
  else if (hov) { ctx.fillStyle = 'rgba(138,136,204,0.10)'; ctx.fillRect(x, cy - h / 2 + 3, w, h - 6); }
  const warm = tone === 1;
  const tc = !enabled ? PAL.textFaint : prs ? PAL.warm[0] : hov ? PAL.text : warm ? PAL.warm[1] : PAL.textDim;
  const bc = !enabled ? PAL.textFaint : prs ? PAL.warm[1] : hov ? PAL.warm[2] : warm ? PAL.warm[3] : PAL.textFaint;
  const slide = hov ? Math.min(2, a * 0.3) : 0, oy = prs ? 1 : 0;
  text(prs ? '>' : '[', x + slide, cy + oy, size, bc);
  text(label, x + a * 2, cy + oy, size, tc);
  text(prs ? '<' : ']', x + w - a - slide, cy + oy, size, bc);
  return w;
}

/** Lay items [{id,label,enabled,action}] out in one row, else a uniform grid. */
export function btnFlow(items, size, maxW) {
  const a = adv(size), gap = a, rh = BTN_H(size);
  const ws = items.map((it) => (it.label.length + 4) * a);
  const total = ws.reduce((s, w) => s + w, 0) + gap * (items.length - 1);
  const rows = [];
  if (total <= maxW) {
    rows.push({ items, w: total, colW: 0 });
  } else {
    const cw = Math.max(...ws);
    let cols = Math.max(1, Math.min(items.length, Math.floor((maxW + gap) / (cw + gap))));
    if (cols > 2) cols = 2;
    for (let i = 0; i < items.length; i += cols) {
      const its = items.slice(i, i + cols);
      rows.push({ items: its, w: its.length * cw + gap * (its.length - 1), colW: cw });
    }
  }
  return { rows, h: rows.length * rh, rh, gap, size };
}
export function drawFlow(flow, x, y, w, align = 'l') {
  flow.rows.forEach((row, r) => {
    let px = align === 'c' ? x + (w - row.w) / 2 : x;
    const cy = y + flow.rh * (r + 0.5);
    for (const it of row.items) {
      const bw = btn(it.id, it.label, px, cy, flow.size, it);
      px += (row.colW || bw) + flow.gap;
    }
  });
}

// ---- game result text ------------------------------------------------------
export function resultInfo(view) {
  const s = view.status, w = view.winner;
  let title = 'GAME OVER', sub = '', color = PAL.textDim;
  if (s === 'checkmate') {
    title = 'CHECKMATE'; sub = w ? SIDE_NAME[w] + ' WINS' : '';
    color = w === 'b' ? PAL.ember[1] : PAL.bone[0];
  } else if (s === 'stalemate') { title = 'STALEMATE'; sub = 'NO LEGAL MOVES - DRAW'; }
  else if (s === 'draw-50') { title = 'DRAW'; sub = 'FIFTY-MOVE RULE'; }
  else if (s === 'draw-repetition') { title = 'DRAW'; sub = 'THREEFOLD REPETITION'; }
  else if (s === 'draw-material') { title = 'DRAW'; sub = 'INSUFFICIENT MATERIAL'; }
  return { title, sub, color, line: sub ? title + ' - ' + sub : title };
}
