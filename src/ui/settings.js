// Settings panel: figure resolution and effect switches.
// Values live in `view.settings` (main owns and saves them); this panel only
// emits `ui:setting { key, value }`.  SOUND maps onto `view.muted`.

import { PAL } from '../core/palette.js';
import { clamp, ease } from '../core/util.js';
import { K, adv, text, frame, widget, btn, bodySize } from './kit.js';

const ON_OFF = [[true, 'ON'], [false, 'OFF']];
const ROWS = [
  { key: 'figures', label: 'FIGURES', opts: [['standard', 'STANDARD'], ['high', 'HIGH'], ['ultra', 'ULTRA']], note: 'MORE, SMALLER GLYPHS PER PIECE' },
  { key: 'boardFlow', label: 'BOARD FLOW', opts: ON_OFF, note: 'GLYPHS UNDER THE BOARD KEEP CHANGING' },
  { key: 'ripples', label: 'RIPPLES', opts: ON_OFF, note: 'RINGS AND FLASHES FROM MOVES AND KILLS' },
  { key: 'scenery', label: 'RAIN + EMBERS', opts: ON_OFF, note: 'FALLING STRANDS AND DRIFTING SPARKS' },
  { key: 'shake', label: 'SCREEN SHAKE', opts: ON_OFF, note: 'THE JOLT ON IMPACT' },
  { key: 'idleSpin', label: 'IDLE SPIN', opts: ON_OFF, note: 'PIECES TURN WHILE THEY WAIT' },
  { key: 'sound', label: 'SOUND', opts: ON_OFF, note: 'M TOGGLES IT ANYWHERE' },
];
const LABEL_W = Math.max(...ROWS.map((r) => r.label.length)) + 2;
const optChars = (row) => row.opts.reduce((n, o) => n + o[1].length + 2.5, 0);
const OPT_W = Math.max(...ROWS.map(optChars));
const NOTE_W = Math.max(...ROWS.map((r) => r.note.length));

const st = { open: false, focus: 0, t0: 0, lastHover: null };

export const settingsOpen = () => st.open;
export function openSettings() {
  if (st.open) return;
  st.open = true; st.focus = 0; st.t0 = K.t; st.lastHover = null;
  K.audio && K.audio.play('ui');
}
export function closeSettings() {
  if (!st.open) return;
  st.open = false;
  K.audio && K.audio.play('ui');
}

function valueOf(view, key) {
  if (key === 'sound') return !view.muted;
  return view.settings ? view.settings[key] : undefined;
}
function setValue(key, value) {
  K.bus.emit('ui:setting', { key, value });
  K.audio && K.audio.play('tick');
}
function cycle(row, dir) {
  const cur = valueOf(K.view, row.key);
  const i = Math.max(0, row.opts.findIndex((o) => o[0] === cur));
  setValue(row.key, row.opts[(i + dir + row.opts.length) % row.opts.length][0]);
}

export function settingsKey(k) {
  const n = ROWS.length + 1;                      // rows + CLOSE
  const row = ROWS[st.focus];
  const lk = k.length === 1 ? k.toLowerCase() : k;
  switch (lk) {
    case 'Escape': case 's': closeSettings(); return true;
    case 'ArrowUp': st.focus = (st.focus + n - 1) % n; K.audio && K.audio.play('tick'); return true;
    case 'ArrowDown': st.focus = (st.focus + 1) % n; K.audio && K.audio.play('tick'); return true;
    case 'ArrowLeft': if (row) cycle(row, -1); return true;
    case 'ArrowRight': if (row) cycle(row, 1); return true;
    case 'Enter': case ' ': case 'Spacebar':
      if (row) cycle(row, 1); else closeSettings();
      return true;
    default: return true;                         // swallow everything else while open
  }
}

export function drawSettings(view) {
  const L = K.layout, ctx = K.ctx, W = L.W, H = L.H;
  const fade = K.reduced ? 1 : ease.outCubic(clamp((K.t - st.t0) / 0.2));

  // Pick the largest text size at which the panel fits; narrow screens stack
  // each row (label above its choices) and drop the explanatory notes.
  let fs = clamp(bodySize(L), 11, 20);
  let a, wide, notes, innerW, rowH, pad, titleS, panelW, panelH, btnH;
  for (;;) {
    a = adv(fs);
    pad = Math.round(fs * 1.5);
    wide = (LABEL_W + OPT_W) * a + pad * 2 <= W - 16;
    notes = wide && (LABEL_W + OPT_W + 2 + NOTE_W) * a + pad * 2 <= W - 16 && H >= 520;
    innerW = wide ? (LABEL_W + OPT_W + (notes ? 2 + NOTE_W : 0)) * a : Math.max(OPT_W, LABEL_W) * a;
    rowH = wide ? Math.max(30, Math.round(fs * 2.3)) : Math.max(52, Math.round(fs * 4));
    titleS = Math.round(fs * 1.25);
    btnH = Math.max(34, Math.round(fs * 2.6));
    panelW = innerW + pad * 2;
    panelH = pad + titleS * 2 + ROWS.length * rowH + btnH + pad * 0.6;
    if ((panelW <= W - 16 && panelH <= H - 16) || fs <= 9) break;
    fs -= 1;
  }
  const x = Math.round((W - panelW) / 2);
  const y = Math.round(clamp((H - panelH) / 2, 8, Math.max(8, H - 8 - panelH)) + (1 - fade) * 10);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.fillStyle = 'rgba(13,13,19,0.5)';
  ctx.fillRect(0, 0, W, H);
  widget('set-out', 0, 0, W, H, closeSettings, true, true);
  ctx.fillStyle = 'rgba(13,13,19,0.94)';
  ctx.fillRect(x, y, panelW, panelH);
  frame(x, y, panelW, panelH, 11, PAL.boardEdge, 0.85);
  widget('set-box', x, y, panelW, panelH, null, true, true);

  const ix = x + pad;
  text('SETTINGS', ix, y + pad + titleS * 0.5, titleS, PAL.warm[1], { adv: adv(titleS) * 1.3 });

  // Hovering a row moves the keyboard focus to it.
  const hov = K.hover;
  if (hov !== st.lastHover) {
    st.lastHover = hov;
    const m = hov && /^set:(\d+):/.exec(hov);
    if (m) st.focus = +m[1]; else if (hov === 'set-close') st.focus = ROWS.length;
  }

  const y0 = y + pad + titleS * 2;
  ROWS.forEach((row, ri) => {
    const top = y0 + ri * rowH;
    const focused = st.focus === ri;
    const cur = valueOf(view, row.key);
    const ly = wide ? top + rowH / 2 : top + rowH * 0.3;
    const oy = wide ? ly : top + rowH * 0.7;
    if (focused) {
      const br = K.reduced ? 1 : 0.5 + 0.5 * Math.sin(K.t * 3.4);
      text('>', ix - a * 1.6 + (K.reduced ? 0 : br * 2), ly, fs, PAL.warm[2], { alpha: 0.5 + 0.5 * br });
    }
    text(row.label, ix, ly, fs, focused ? PAL.text : PAL.textDim);
    let px = wide ? ix + LABEL_W * a : ix;
    row.opts.forEach((o, oi) => {
      const id = `set:${ri}:${oi}`, w = (o[1].length + 2) * a, sel = o[0] === cur, h = K.hover === id;
      const hh = wide ? rowH - 4 : rowH * 0.5;
      widget(id, px, oy - hh / 2, w, hh, () => { st.focus = ri; if (!sel) setValue(row.key, o[0]); });
      if (sel) { text('[', px, oy, fs, PAL.warm[2]); text(']', px + w - a, oy, fs, PAL.warm[2]); }
      else if (h) { text('[', px, oy, fs, PAL.textFaint); text(']', px + w - a, oy, fs, PAL.textFaint); }
      text(o[1], px + a, oy, fs, sel ? PAL.text : h ? PAL.text : PAL.textDim);
      px += w + a * 0.5;
    });
    if (notes) {
      const ns = Math.max(10, Math.round(fs * 0.72));
      text(row.note, ix + (LABEL_W + OPT_W + 2) * a, ly, ns, focused ? PAL.textDim : PAL.textFaint, { adv: adv(ns) * 1.08 });
    }
  });

  const label = 'CLOSE', bw = (label.length + 4) * a;
  btn('set-close', label, x + panelW - pad - bw, y0 + ROWS.length * rowH + btnH / 2, fs, {
    tone: 1, focus: st.focus === ROWS.length, action: closeSettings,
  });
  ctx.restore();
}
