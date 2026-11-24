// Modals: promotion picker and game-over card.

import { PAL } from '../core/palette.js';
import { clamp, ease } from '../core/util.js';
import { K, adv, text, scr, wrap, frame, widget, btnFlow, drawFlow, bodySize, resultInfo } from './kit.js';

const PIECES = [['q', 'QUEEN'], ['r', 'ROOK'], ['b', 'BISHOP'], ['n', 'KNIGHT']];
const pm = { focus: 0, key: '', t0: 0 };

export function promoClosed() { pm.key = ''; }

export function promoKey(k) {
  const promote = (p) => { K.audio && K.audio.play('ui'); K.bus.emit('ui:promote', { piece: p }); };
  const lk = k.length === 1 ? k.toLowerCase() : k;
  const idx = PIECES.findIndex((p) => p[0] === lk);
  if (idx >= 0) { promote(lk); return true; }
  switch (k) {
    case 'Escape': K.bus.emit('ui:promoteCancel'); return true;
    case 'ArrowLeft': case 'ArrowUp': pm.focus = (pm.focus + 3) % 4; return true;
    case 'ArrowRight': case 'ArrowDown': pm.focus = (pm.focus + 1) % 4; return true;
    case 'Enter': case ' ': promote(PIECES[pm.focus][0]); return true;
    default: return true;   // swallow everything else while the picker is up
  }
}

export function drawPromotion(view) {
  const L = K.layout, ctx = K.ctx, p = view.promotion;
  const key = p.color + p.from + p.to;
  if (key !== pm.key) { pm.key = key; pm.t0 = K.t; pm.focus = 0; }
  const fade = K.reduced ? 1 : ease.outCubic(clamp((K.t - pm.t0) / 0.18));

  ctx.fillStyle = `rgba(13,13,19,${0.34 * fade})`;
  ctx.fillRect(0, 0, L.W, L.H);
  widget('promo-out', 0, 0, L.W, L.H, () => K.bus.emit('ui:promoteCancel'), true, true);

  const r = L.squareRect(p.to), bd = L.board;
  const cell = clamp(Math.round(L.sq * 0.85), 44, 92);
  const dir = r.y + r.h / 2 < bd.y + bd.size / 2 ? 1 : -1;
  let x = clamp(r.x + r.w / 2 - cell / 2, 8, Math.max(8, L.W - 8 - cell));
  let y = dir > 0 ? r.y : r.y + r.h - cell * 4;
  y = clamp(y, 8, Math.max(8, L.H - 8 - cell * 4));
  const off = (1 - fade) * 8 * dir;
  y += off;
  ctx.globalAlpha = fade;
  ctx.fillStyle = 'rgba(13,13,19,0.92)';
  ctx.fillRect(x, y, cell, cell * 4);
  frame(x, y, cell, cell * 4, 11, PAL.boardEdge, 0.8);
  widget('promo-box', x, y, cell, cell * 4, null, true, true);

  const tint = p.color === 'b' ? PAL.ember[1] : PAL.bone[0];
  const ls = Math.round(cell * 0.5), ns = 10;
  PIECES.forEach(([pc, name], i) => {
    const cy = y + cell * i, id = 'promo:' + pc;
    widget(id, x + 2, cy + 2, cell - 4, cell - 4, () => K.bus.emit('ui:promote', { piece: pc }));
    const hot = K.hover === id || pm.focus === i;
    if (K.hover === id) pm.focus = i;
    if (hot) { ctx.fillStyle = 'rgba(246,207,154,0.15)'; ctx.fillRect(x + 3, cy + 3, cell - 6, cell - 6); }
    const showName = cell >= 52;
    const ly = cy + (showName ? cell * 0.42 : cell * 0.5);
    text(pc.toUpperCase(), x + cell / 2, ly, ls, hot ? PAL.warm[0] : tint, { align: 'c' });
    if (hot) {
      text('[', x + 5, ly, ls * 0.6, PAL.warm[2]);
      text(']', x + cell - 5 - adv(ls * 0.6), ly, ls * 0.6, PAL.warm[2]);
    }
    if (showName) text(name, x + cell / 2, cy + cell * 0.82, ns, hot ? PAL.text : PAL.textDim, { align: 'c' });
  });
  ctx.globalAlpha = 1;
}

export function drawGameOver(view) {
  const L = K.layout, ctx = K.ctx, bd = L.board;
  const delay = K.reduced ? 0.2 : 0.9;
  const T = K.phaseT - delay;
  if (T <= 0) return;
  const p = K.reduced ? 1 : ease.outCubic(clamp(T / 0.6));
  const fs = bodySize(L);
  const info = resultInfo(view);
  const cw = Math.round(clamp(bd.size * 0.7, Math.min(232, L.W - 24), 460));
  const pad = Math.round(fs * 1.2);
  const ts = clamp(Math.floor((cw - pad * 2) / (info.title.length * 0.6)), 14, 38);
  const subS = Math.round(fs * 1.1);
  const subLines = info.sub ? wrap(info.sub, Math.max(8, Math.floor((cw - pad * 2) / adv(subS)))) : [];
  const flow = btnFlow([
    { id: 'go-rematch', label: 'REMATCH', action: rematch },
    { id: 'go-menu', label: 'MENU', action: () => K.bus.emit('ui:menu') },
  ], fs, cw - pad * 2);
  const subH = Math.round(subS * 1.7);
  const h = Math.round(pad + ts * 1.5 + subLines.length * subH + pad * 0.5 + flow.h + pad * 0.5);
  const x = clamp(bd.x + bd.size / 2 - cw / 2, 8, Math.max(8, L.W - 8 - cw));
  let y = clamp(bd.y + bd.size / 2 - h / 2, 8, Math.max(8, L.H - 8 - h));
  y += (1 - p) * 14;

  ctx.globalAlpha = p;
  ctx.fillStyle = 'rgba(13,13,19,0.12)';
  ctx.fillRect(0, 0, L.W, L.H);
  ctx.fillStyle = 'rgba(13,13,19,0.8)';
  ctx.fillRect(x, y, cw, h);
  frame(x, y, cw, h, 11, PAL.boardEdge, 0.85);
  if (p > 0.3) widget('go-card', x, y, cw, h, null, true, true);

  let cy = y + pad + ts * 0.75;
  text(scr('go-title', info.title, 0.6), x + cw / 2, cy, ts, info.sub && view.winner ? PAL.warm[0] : PAL.text, { align: 'c' });
  cy += ts * 0.75 + subH * 0.5;
  subLines.forEach((ln, i) => {
    text(scr('go-sub' + i, ln, 0.6), x + cw / 2, cy + i * subH, subS, info.color, { align: 'c' });
  });
  cy += (subLines.length - 0.5) * subH + pad * 0.5;
  if (p > 0.5) drawFlow(flow, x + pad, y + h - pad * 0.5 - flow.h, cw - pad * 2, 'c');
  ctx.globalAlpha = 1;
}

export function rematch() {
  const v = K.view, c = (v && v.config) || {};
  const ai = c.mode !== 'hotseat';
  K.bus.emit('ui:newGame', { mode: ai ? 'ai' : 'hotseat', level: c.level || 2, humanColor: c.humanColor || 'w' });
}
