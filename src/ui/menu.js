// Title overlay: block-letter logo that settles in and shimmers, then the
// option form.  A soft elliptical scrim keeps text legible but leaves the
// demo board visible around it.

import { PAL } from '../core/palette.js';
import { clamp, hash2 } from '../core/util.js';
import { K, adv, text, glyph, widget, btn, scr } from './kit.js';
import { openSettings } from './settings.js';

const FONT = {
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  S: [' ####', '#    ', ' ### ', '    #', '#### '],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  I: ['#####', '  #  ', '  #  ', '  #  ', '#####'],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
  E: ['#####', '#    ', '#### ', '#    ', '#####'],
};
function cellsOf(word) {
  const cells = [];
  [...word].forEach((ch, li) => {
    FONT[ch].forEach((row, r) => {
      for (let c = 0; c < 5; c++) if (row[c] === '#') cells.push({ c: li * 6 + c, r });
    });
  });
  return cells;
}
const WORD1 = cellsOf('ASCII'), WORD2 = cellsOf('CHESS');
const PAL1 = [PAL.field[0], PAL.field[0], PAL.field[1], PAL.field[1], PAL.field[2]];
const PAL2 = [PAL.warm[0], PAL.warm[1], PAL.warm[1], PAL.warm[2], PAL.warm[3]];
const LOGO_CH = 'HN#M#W#N';
const RAMP = '.,:;~+=zsSZN#';

export const OPTS = {
  mode: [['ai', 'COMPUTER'], ['hotseat', 'TWO PLAYERS']],
  level: [[1, 'NOVICE'], [2, 'ADEPT'], [3, 'MASTER']],
  side: [['w', 'BONE'], ['b', 'EMBER'], ['r', 'RANDOM']],
};
const LABEL = { mode: 'OPPONENT', level: 'LEVEL', side: 'SIDE' };

export const MS = { mode: 'ai', level: 2, side: 'w', focus: 0 };
let lastHover = null;

export const rowKeys = () => (MS.mode === 'ai' ? ['mode', 'level', 'side', 'start'] : ['mode', 'start']);

function tintFor(key, value, selected) {
  if (key === 'side' && selected) return value === 'w' ? PAL.bone[0] : value === 'b' ? PAL.ember[1] : PAL.warm[0];
  return selected ? PAL.text : PAL.textDim;
}

function setValue(key, i) {
  MS[key] = OPTS[key][i][0];
  K.audio && K.audio.play('tick');
}
function cycle(key, dir) {
  const opts = OPTS[key];
  const i = opts.findIndex((o) => o[0] === MS[key]);
  setValue(key, (i + dir + opts.length) % opts.length);
}

export function startGame() {
  const ai = MS.mode === 'ai';
  const humanColor = !ai ? 'w' : MS.side === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : MS.side;
  K.audio && K.audio.play('start');
  K.bus.emit('ui:newGame', { mode: ai ? 'ai' : 'hotseat', level: MS.level, humanColor });
}

export function menuKey(k) {
  const keys = rowKeys();
  const cur = keys[Math.min(MS.focus, keys.length - 1)];
  const tick = () => K.audio && K.audio.play('tick');
  switch (k) {
    case 'ArrowUp': MS.focus = (MS.focus + keys.length - 1) % keys.length; tick(); return true;
    case 'ArrowDown': MS.focus = (MS.focus + 1) % keys.length; tick(); return true;
    case 'ArrowLeft': if (cur !== 'start') cycle(cur, -1); return true;
    case 'ArrowRight': if (cur !== 'start') cycle(cur, 1); return true;
    case 'Enter': startGame(); return true;
    case ' ': case 'Spacebar':
      if (cur === 'start') startGame(); else cycle(cur, 1);
      return true;
    default: return false;
  }
}

export function resetTitle() { MS.focus = rowKeys().length - 1; lastHover = null; }

function measure(W, H, ladv, mf, keys, stacked) {
  const a = adv(mf), lab = 8 * a, gap = a * 2;
  let optW = 0;
  for (const k of keys) {
    if (k === 'start') continue;
    let w = 0;
    for (const o of OPTS[k]) w += (o[1].length + 2) * a + a * 0.5;
    optW = Math.max(optW, w);
  }
  const pitchY = ladv * 1.95;
  const logoH = stacked ? pitchY * 11.2 : pitchY * 5, logoW = ladv * (stacked ? 29 : 62);
  const rp = Math.max(Math.round(mf * 2.2), 30);
  const startS = Math.round(mf * 1.25), startH = Math.max(40, Math.round(startS * 2.2));
  const hint = W >= 700 ? Math.round(mf * 2) : 0;
  const h = logoH + mf * 0.8 + mf * 1.6 + mf * 1.4 + (keys.length - 1) * rp + mf * 0.8 + startH + hint;
  return { a, lab, gap, pitchY, logoH, logoW, rp, startS, startH, hint, h, w: Math.max(logoW, lab + gap + optW), formW: lab + gap + optW };
}

function drawWord(cells, ox, oy, ladv, pitchY, ls, pal, colOff) {
  const t = K.phaseT, tt = K.t, reduced = K.reduced;
  for (let i = 0; i < cells.length; i++) {
    const { c, r } = cells[i], gc = c + colOff;
    const ts = 0.12 + gc * 0.014 + r * 0.05 + hash2(gc, r, 3) * 0.4;
    const age = t - ts;
    if (!reduced && age < 0) continue;
    let ch = LOGO_CH[(hash2(gc, r, 11) * LOGO_CH.length) | 0];
    let alpha = 0.88;
    if (!reduced && age < 0.5) {
      ch = RAMP[(hash2(gc, r, Math.floor(tt * 22)) * RAMP.length) | 0];
      alpha = 0.25 + age * 1.3;
    } else if (!reduced) {
      const d = (((gc * 0.9 + r * 1.7 - tt * 7) % 90) + 90) % 90;
      if (d < 5) { ch = '@'; alpha = 1; }
      else if (hash2(gc, r, Math.floor(tt * 3)) > 0.988) ch = '*';
    }
    glyph(ch.charCodeAt(0), ox + (c + 0.5) * ladv, oy + (r + 0.5) * pitchY, ls, pal[r], alpha);
  }
}

export function drawTitle(view) {
  const L = K.layout, ctx = K.ctx, W = L.W, H = L.H, t = K.phaseT;
  const keys = rowKeys();
  if (MS.focus >= keys.length) MS.focus = keys.length - 1;
  const stacked = W < 754;
  let ladv = stacked ? Math.min((W * 0.8) / 29, 26) : Math.min((W * 0.74) / 62, 24);
  let mf = clamp(Math.round(Math.min(W * 0.032, H * 0.03) + 5), 12, 26);
  let g = measure(W, H, ladv, mf, keys, stacked);
  for (let k = 0; k < 12 && (g.h > H * 0.94 || g.w > W * 0.95); k++) {
    ladv *= 0.92; mf = Math.max(11, mf * 0.94);
    g = measure(W, H, ladv, mf, keys, stacked);
  }
  const cx = W / 2, y0 = (H - g.h) / 2 - H * 0.015;
  const fade = K.reduced ? 1 : clamp(t / 0.6);

  // scrim
  const bw = g.w + mf * 3, bh = g.h + mf * 3;
  ctx.save();
  ctx.translate(cx, y0 + g.h / 2);
  ctx.scale(bw * 0.78, bh * 0.74);
  const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gr.addColorStop(0, 'rgba(13,13,19,0.74)');
  gr.addColorStop(0.6, 'rgba(13,13,19,0.62)');
  gr.addColorStop(1, 'rgba(13,13,19,0)');
  ctx.globalAlpha = fade;
  ctx.fillStyle = gr;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();

  // logo
  const ls = Math.round(ladv / 0.6);
  let y = y0;
  if (stacked) {
    drawWord(WORD1, cx - (29 * ladv) / 2, y, ladv, g.pitchY, ls, PAL1, 0);
    drawWord(WORD2, cx - (29 * ladv) / 2, y + g.pitchY * 6.2, ladv, g.pitchY, ls, PAL2, 33);
  } else {
    const x0 = cx - g.logoW / 2;
    drawWord(WORD1, x0, y, ladv, g.pitchY, ls, PAL1, 0);
    drawWord(WORD2, x0 + 33 * ladv, y, ladv, g.pitchY, ls, PAL2, 33);
  }
  y += g.logoH + mf * 0.8;

  // tagline
  ctx.globalAlpha = clamp((t - 0.7) / 0.5);
  if (K.reduced) ctx.globalAlpha = 1;
  const tagS = Math.max(11, Math.round(mf * 0.8));
  text(scr('tag', 'CHESS, DRAWN IN GLYPHS'), cx, y + mf * 0.8, tagS, PAL.textDim, { align: 'c', adv: adv(tagS) * 1.5 });
  y += mf * 1.6 + mf * 1.4 - mf * 0.2;

  // form
  const x0 = cx - g.formW / 2, a = g.a, ox = x0 + g.lab + g.gap;
  const hov = K.hover;
  if (hov !== lastHover) {
    lastHover = hov;
    if (hov) {
      const m = /^opt:(\w+):/.exec(hov);
      const idx = m ? keys.indexOf(m[1]) : hov === 'start' ? keys.length - 1 : -1;
      if (idx >= 0) MS.focus = idx;
    }
  }
  keys.forEach((key, ri) => {
    const cy = y + g.rp * (ri + 0.5);
    ctx.globalAlpha = K.reduced ? 1 : clamp((t - 0.9 - ri * 0.1) / 0.4);
    if (key === 'start') return;
    const focused = MS.focus === ri;
    if (focused) {
      const br = 0.5 + 0.5 * Math.sin(K.t * 3.4);
      text('>', x0 - a * 2.2 + (K.reduced ? 0 : br * 2.5), cy, mf, PAL.warm[2], { alpha: K.reduced ? 1 : 0.5 + 0.5 * br });
    }
    text(LABEL[key], x0, cy, mf, focused ? PAL.text : PAL.textDim);
    let px = ox;
    OPTS[key].forEach((o, i) => {
      const sel = MS[key] === o[0], id = `opt:${key}:${i}`;
      const w = (o[1].length + 2) * a;
      widget(id, px, cy - g.rp / 2 + 2, w, g.rp - 4, () => { setValue(key, i); MS.focus = ri; });
      const h = K.hover === id;
      const col = sel ? tintFor(key, o[0], true) : h ? PAL.text : PAL.textDim;
      if (sel) { text('[', px, cy, mf, PAL.warm[2]); text(']', px + w - a, cy, mf, PAL.warm[2]); }
      else if (h) { text('[', px, cy, mf, PAL.textFaint); text(']', px + w - a, cy, mf, PAL.textFaint); }
      text(o[1], px + a, cy, mf, col);
      px += w + a * 0.5;
    });
  });

  // start
  const si = keys.length - 1, scy = y + g.rp * (keys.length - 1) + mf * 0.8 + g.startH / 2;
  ctx.globalAlpha = K.reduced ? 1 : clamp((t - 1.1) / 0.4);
  const sw = (5 + 4) * adv(g.startS);
  const pulse = K.reduced ? 1 : 0.8 + 0.2 * Math.sin(K.t * 2.6);
  ctx.globalAlpha *= pulse;
  btn('start', 'START', cx - sw / 2, scy, g.startS, { tone: 1, focus: MS.focus === si, action: startGame });
  ctx.globalAlpha = 1;

  if (g.hint) {
    ctx.globalAlpha = clamp((t - 1.4) / 0.5);
    text('ARROWS SELECT   ENTER START   S SETTINGS', cx, scy + g.startH / 2 + mf * 0.9, 11, PAL.textFaint, { align: 'c', adv: adv(11) * 1.2 });
    ctx.globalAlpha = 1;
  }

  // settings, bottom-right (sound lives in there; M still toggles it)
  const lbl = 'SETTINGS', bs = Math.max(11, Math.round(mf * 0.62)), bwid = (lbl.length + 4) * adv(bs);
  const pad = Math.max(8, Math.min(W, H) * 0.02);
  btn('settings', lbl, W - pad - bwid, H - pad - 15, bs, { action: openSettings });
}
