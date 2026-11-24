// In-game HUD: side cards (turn marker, captured pieces, material), status
// line, SAN move list, control buttons.  Landscape uses the left/right
// columns, portrait a strip above and below the board.

import { PAL, SIDE_NAME } from '../core/palette.js';
import { clamp } from '../core/util.js';
import { K, adv, text, scr, wrap, bodySize, btnFlow, drawFlow, resultInfo } from './kit.js';

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const ORDER = 'qrbnp';
const LEVEL = ['', 'NOVICE', 'ADEPT', 'MASTER'];
const SPIN = '|/-\\';
const SIDE_COL = { w: PAL.bone[0], b: PAL.ember[1] };
const CAP_COL = { w: PAL.bone[1], b: PAL.ember[1] };      // colour of the pieces themselves

const state = { scroll: 0 };

function material(view) {
  const sum = (a) => (a || []).reduce((s, p) => s + (VAL[p] || 0), 0);
  const c = view.captured || {};
  return sum(c.w) - sum(c.b);
}

function statusInfo(view) {
  const cfg = view.config || {};
  if (view.phase === 'gameover') {
    const r = resultInfo(view);
    return { s: r.line, c: r.sub && view.winner ? PAL.warm[1] : PAL.textDim };
  }
  if (view.thinking) return { s: 'THINKING', c: PAL.warm[2], spin: true };
  if (view.checkSquare) return { s: 'CHECK', c: PAL.danger };
  if (cfg.mode === 'ai') return { s: view.turn === cfg.humanColor ? 'YOUR MOVE' : 'OPPONENT MOVES', c: PAL.textDim };
  return { s: SIDE_NAME[view.turn] + ' TO MOVE', c: PAL.textDim };
}

function drawStatus(info, x, cy, maxW, size) {
  const a = adv(size);
  const maxC = Math.max(6, Math.floor((maxW - (info.spin ? a * 2 : 0)) / a));
  const lines = wrap(info.s, maxC), lh = Math.round(size * 1.5);
  const y0 = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((ln, i) => {
    const ex = text(scr('st' + i, ln), x, y0 + i * lh, size, info.c);
    if (info.spin && i === lines.length - 1) text(SPIN[((K.t * 10) | 0) & 3], ex + a, y0 + i * lh, size, info.c);
  });
}

const cardHeight = (fs, ns) => Math.round(ns * 1.55) + Math.round(fs * 1.6);

function card(side, x, y, w, view, fs, ns, compact) {
  const cfg = view.config || {};
  const over = view.phase === 'gameover';
  const active = view.phase === 'playing' && view.turn === side;
  const al = active ? 1 : over ? (!view.winner || view.winner === side ? 0.95 : 0.45) : 0.5;
  const h1 = Math.round(ns * 1.55), h2 = Math.round(fs * 1.6);
  const cy1 = y + h1 / 2, a = adv(fs), na = adv(ns);
  if (active) {
    const br = 0.5 + 0.5 * Math.sin(K.t * 3.4);
    text('>', x + (K.reduced ? 0 : br * 2.5), cy1, ns, PAL.warm[2], { alpha: K.reduced ? 1 : 0.5 + 0.5 * br });
  }
  const nx = x + na * 2;
  const name = SIDE_NAME[side];
  text(scr('nm' + side, name), nx, cy1, ns, SIDE_COL[side], { alpha: al });

  // tag: YOU / CPU ADEPT / spinner
  let tag = '';
  if (cfg.mode === 'ai') tag = cfg.humanColor === side ? 'YOU' : 'CPU ' + (LEVEL[cfg.level] || '');
  const thinkingHere = view.thinking && active && cfg.mode === 'ai' && cfg.humanColor !== side;
  if (thinkingHere) tag = SPIN[(K.t * 10) & 3] + ' ' + tag;
  if (tag && nx + na * (name.length + 2) + adv(fs) * tag.length <= x + w) {
    text(tag, x + w, cy1 + 1, fs, thinkingHere ? PAL.warm[2] : PAL.textDim, { align: 'r', alpha: Math.max(al, 0.6) });
  }
  if (compact) return h1;

  // captured pieces + balance
  const cy2 = y + h1 + h2 / 2;
  const cap = (view.captured && view.captured[side]) || [];
  let px = nx;
  for (const t of ORDER) {
    const n = cap.reduce((c, p) => c + (p === t ? 1 : 0), 0);
    if (!n) continue;
    px = text(t.toUpperCase().repeat(n), px, cy2, fs, CAP_COL[side === 'w' ? 'b' : 'w'], { alpha: 0.9 }) + a * 0.6;
  }
  if (!cap.length) text('-', nx, cy2, fs, PAL.textFaint);
  const bal = side === 'w' ? material(view) : -material(view);
  if (bal > 0) text('+' + bal, Math.max(px + a, nx + a * 6), cy2, fs, PAL.warm[2]);
  return h1 + h2;
}

function drawList(hist, x, y, w, h, size) {
  const ctx = K.ctx, pitch = Math.round(size * 1.55), a = adv(size);
  const vis = Math.floor(h / pitch);
  if (vis < 2) return false;
  const n = hist.length, rows = Math.ceil(n / 2);
  const numW = String(Math.max(rows, 1)).length + 1;
  let sanW = 4;
  for (const m of hist) if (m.san && m.san.length > sanW) sanW = m.san.length;
  if ((numW + 1 + sanW + 1 + sanW) * a > w) return false;

  if (!n) { text('NO MOVES YET', x, y + pitch / 2, size, PAL.textFaint); return true; }

  const target = Math.max(0, rows - vis);
  state.scroll += (target - state.scroll) * Math.min(1, K.dt * 9);
  if (K.reduced || Math.abs(target - state.scroll) < 0.002) state.scroll = target;
  const sc = state.scroll;

  ctx.save();
  ctx.beginPath(); ctx.rect(x - 4, y, w + 8, vis * pitch); ctx.clip();
  const first = Math.max(0, Math.floor(sc)), last = Math.min(rows - 1, Math.ceil(sc) + vis);
  const xs = [x + (numW + 1) * a, x + (numW + 2 + sanW) * a];
  for (let r = first; r <= last; r++) {
    const cy = y + (r - sc + 0.5) * pitch;
    const rel = r - sc;
    const fade = rel < 0 ? clamp(1 + rel * 1.4, 0, 1) : 1;
    if (fade <= 0) continue;
    text((r + 1) + '.', x, cy, size, PAL.textFaint, { alpha: fade });
    for (let s = 0; s < 2; s++) {
      const i = r * 2 + s, m = hist[i];
      if (!m) continue;
      const latest = i === n - 1;
      const col = s === 0 ? (latest ? PAL.bone[0] : PAL.bone[2]) : (latest ? PAL.ember[0] : PAL.ember[1]);
      let str = m.san || '?';
      if (latest) {
        ctx.fillStyle = 'rgba(255,208,138,0.14)';
        ctx.fillRect(xs[s] - a * 0.5, cy - pitch / 2 + 2, (str.length + 1) * a, pitch - 4);
        str = scr('lastmove', str);
      }
      text(str, xs[s], cy, size, col, { alpha: fade * (latest ? 1 : 0.85) });
    }
  }
  ctx.restore();
  return true;
}

export function drawHud(view, hist) {
  const L = K.layout, bd = L.board;
  const fs = bodySize(L), ns = Math.round(fs * 1.3);
  const top = L.flipped ? 'w' : 'b', bot = L.flipped ? 'b' : 'w';
  const info = statusInfo(view);
  const ss = Math.round(fs * 1.15);
  const items = [
    { id: 'undo', label: 'UNDO', enabled: hist.length > 0, action: () => K.bus.emit('ui:undo') },
    { id: 'flip', label: 'FLIP', action: () => K.bus.emit('ui:flip') },
    { id: 'mute', label: view.muted ? 'SOUND OFF' : 'SOUND ON', action: () => K.bus.emit('ui:mute') },
    { id: 'menu', label: 'MENU', action: () => K.bus.emit('ui:menu') },
  ];
  const cardH = cardHeight(fs, ns), h1 = Math.round(ns * 1.55);
  const A = L.panels.a, B = L.panels.b;

  if (!L.portrait) {
    const minW = fs * 10;
    if (A.w >= minW) {
      const cw = Math.min(A.w, Math.round(fs * 22)), x = A.x + A.w - cw;
      card(top, x, bd.y, cw, view, fs, ns);
      card(bot, x, bd.y + bd.size - cardH, cw, view, fs, ns);
      drawStatus(info, x + adv(ns) * 2, bd.y + bd.size / 2, cw - adv(ns) * 2, ss);
      if (bd.y - A.y > ns * 3.2) text('ASCII CHESS', x + adv(ns) * 2, A.y + ns, fs, PAL.textFaint, { adv: adv(fs) * 1.35 });
    }
    if (B.w >= minW) {
      const cw = Math.min(B.w, Math.round(fs * 26)), x = B.x;
      const flow = btnFlow(items, fs, cw);
      const yb = bd.y + bd.size - flow.h;
      text('MOVES', x, bd.y + fs * 0.9, fs, PAL.textFaint, { adv: adv(fs) * 1.3 });
      if (hist.length) text(String(hist.length), x + cw, bd.y + fs * 0.9, fs, PAL.textFaint, { align: 'r' });
      const ly = bd.y + fs * 2.2;
      drawList(hist, x, ly, cw, yb - fs * 0.6 - ly, fs);
      drawFlow(flow, x, yb, cw, 'l');
    }
    return;
  }

  // portrait: board-aligned column
  const x = Math.max(A.x, bd.x), w = Math.min(bd.size, A.w);
  // top strip: list (top) / status / card (docked to the board)
  let free = A.h;
  const cardTop = A.y + A.h - cardH;
  if (A.h >= cardH) { card(top, x, cardTop, w, view, fs, ns); free = cardTop - A.y - 4; }
  else if (A.h >= h1) { card(top, x, A.y + A.h - h1, w, view, fs, ns, true); free = 0; }
  const statusH = Math.round(ss * 1.9);
  if (free >= statusH) {
    drawStatus(info, x, A.y + free - statusH / 2, w, ss);
    free -= statusH;
  } else if (A.h >= statusH && free < statusH && A.h < cardH) {
    drawStatus(info, x, A.y + statusH / 2, w, ss);
  }
  if (free >= Math.round(fs * 1.55) * 2 + 4) drawList(hist, x, A.y, w, free - 4, fs);

  // bottom strip: card (docked) + buttons at the bottom edge
  const flow = btnFlow(items, fs, w);
  const yb = B.y + B.h - flow.h;
  const avail = yb - B.y - 4;
  if (avail >= cardH) card(bot, x, B.y + 2, w, view, fs, ns);
  else if (avail >= h1) card(bot, x, B.y + 2, w, view, fs, ns, true);
  if (B.h >= flow.h) drawFlow(flow, x, yb, w, 'l');
}
