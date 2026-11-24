// Dev harness for src/world: mounts the world full-window with a mocked `view`.
//
//   node tools/serve.mjs 8102   →   http://localhost:8102/dev/world.html
//
// Keys (also buttons, bottom right):
//   s  cycle selection (+ its targets)      t  toggle targets only
//   l  cycle last move                      c  toggle check square
//   1-5  mood: title calm check mate draw   f  flip board
//   r  ripple at pointer   R  strong warm ripple   x  flash square under pointer
//   p  mock pieces   g  panel outlines   m  reduced motion   space  pause   h  help
//   k  screen-shake burst (the translate main applies from pieces.shake)
//   click = ripple, shift-click = flash
//
// URL params: ?hud=0 hides the help, ?pieces=0 hides the mock pieces, ?mood=title, ?dpr=2
// Automation: window.__dev = { world, view, set(patch), mood(name), flip(), perf(), bench(n), step(seconds) }

import { computeLayout } from '../src/core/layout.js';
import { PAL, GLYPHS } from '../src/core/palette.js';
import { getAtlas } from '../src/core/glyphs.js';
import { createBus } from '../src/core/bus.js';
import { createWorld } from '../src/world/index.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const help = document.getElementById('help');
const bar = document.getElementById('bar');

const bus = createBus();
const world = createWorld({ bus });
const MOODS = ['title', 'calm', 'check', 'mate', 'draw'];

// A plausible middlegame so targets / captures / check make sense.
const POSITION = {
  a1: 'wr', e1: 'wk', h1: 'wr', d1: 'wq', c1: 'wb', b1: 'wn',
  a2: 'wp', b2: 'wp', c2: 'wp', d2: 'wp', f2: 'wp', g2: 'wp', h2: 'wp',
  e4: 'wp', f3: 'wn', c4: 'wb',
  a8: 'br', e8: 'bk', h8: 'br', d8: 'bq', c8: 'bb', f8: 'bb', g8: 'bn',
  a7: 'bp', b7: 'bp', c7: 'bp', d7: 'bp', f7: 'bp', g7: 'bp', h7: 'bp',
  e5: 'bp', c6: 'bn',
};
const mv = (from, to, captured) => ({ from, to, piece: POSITION[from]?.[1] || 'p', color: 'w', captured, check: false, mate: false, san: to });
const SELECTIONS = [
  null,
  { sq: 'f3', targets: [mv('f3', 'g5'), mv('f3', 'h4'), mv('f3', 'd4'), mv('f3', 'g1'), mv('f3', 'e5', 'p')] },
  { sq: 'c4', targets: [mv('c4', 'b5'), mv('c4', 'a6'), mv('c4', 'd5'), mv('c4', 'e6'), mv('c4', 'f7', 'p'), mv('c4', 'b3'), mv('c4', 'd3'), mv('c4', 'e2'), mv('c4', 'f1')] },
  { sq: 'd2', targets: [mv('d2', 'd3'), mv('d2', 'd4')] },
];
const LAST_MOVES = [null, mv('e7', 'e5'), mv('g1', 'f3'), mv('f1', 'c4')];

const view = {
  t: 0, dt: 0, layout: null,
  phase: 'playing', config: { mode: 'ai', level: 2, humanColor: 'w' }, game: null,
  turn: 'w', status: 'playing', winner: null,
  selected: null, targets: [], hover: null, drag: null, lastMove: null, checkSquare: null,
  promotion: null, captured: { w: [], b: [] }, busy: false, thinking: false, muted: false,
  reducedMotion: false,
};

const dev = {
  sel: 0, last: 0, flipped: false, paused: false,
  pieces: params.get('pieces') !== '0', outlines: false, hud: params.get('hud') !== '0',
  pointer: { x: innerWidth / 2, y: innerHeight / 2 },
  mood: params.get('mood') || 'calm',
  shake: 0, shakeX: 0, shakeY: 0,
};

// ------------------------------------------------------------------ layout --

function resize() {
  const dpr = +params.get('dpr') || Math.min(window.devicePixelRatio || 1, 3);
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  view.layout = computeLayout(W, H, dpr, dev.flipped);
  world.resize(view.layout);
}
window.addEventListener('resize', resize);

// -------------------------------------------------------------- mock pieces --
// Dense blobs of fine glyphs standing where real sculptures will: they cover the
// centre and upper part of a square, which is what highlights have to read around.

const TALL = { p: 0.82, n: 1.08, b: 1.18, r: 1.0, q: 1.36, k: 1.5 };
const WIDE = { p: 0.3, n: 0.38, b: 0.34, r: 0.4, q: 0.4, k: 0.4 };
function drawMockPieces() {
  const L = view.layout, fw = L.fineW, fh = fw * 1.7;
  const ramp = GLYPHS.ramp;
  const bone = getAtlas({ fontPx: fw * 1.6, color: PAL.bone[1], dpr: L.dpr });
  const ember = getAtlas({ fontPx: fw * 1.6, color: PAL.ember[2], dpr: L.dpr });
  const order = Object.keys(POSITION).sort((a, b) => L.squareRow(a) - L.squareRow(b));
  for (const sq of order) {
    const [color, type] = POSITION[sq];
    const foot = L.pieceFoot(sq), h = L.sq * TALL[type], halfW = L.sq * WIDE[type];
    const at = color === 'w' ? bone : ember;
    const lifted = sq === view.selected ? L.sq * 0.12 : 0;
    const nr = Math.floor(h / fh);
    for (let j = 0; j < nr; j++) {
      const v = j / nr;                                   // 0 at the feet, 1 at the head
      const prof = v < 0.12 ? 1 : v < 0.7 ? 0.5 + 0.2 * Math.cos(v * 5) : 0.62 * Math.sqrt(Math.max(0, 1 - ((v - 0.82) / 0.18) ** 2));
      const hw = halfW * prof, nc = Math.floor(hw / fw);
      for (let i = -nc; i <= nc; i++) {
        const shade = 0.55 + 0.45 * (1 - Math.abs(i + nc * 0.3) / (nc + 1));
        ctx.globalAlpha = 0.5 + 0.5 * shade;
        at.draw(ctx, ramp[Math.min(ramp.length - 1, Math.floor(shade * ramp.length))], foot.x + i * fw, foot.y - lifted - (j + 0.5) * fh);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function drawOutlines() {
  const L = view.layout;
  ctx.save();
  ctx.strokeStyle = 'rgba(159,240,208,0.5)';
  ctx.setLineDash([4, 4]);
  for (const p of Object.values(L.panels)) ctx.strokeRect(p.x, p.y, p.w, p.h);
  ctx.strokeStyle = 'rgba(255,154,162,0.4)';
  ctx.strokeRect(L.board.x, L.board.y, L.board.size, L.board.size);
  ctx.restore();
}

// -------------------------------------------------------------------- loop --

const N = 240;
const samples = { update: new Float32Array(N), draw: new Float32Array(N), overlay: new Float32Array(N), frame: new Float32Array(N) };
let si = 0, filled = 0, lastNow = performance.now();

function tick(dt) {
  view.dt = dt; view.t += dt;
  const dpr = view.layout.dpr;
  const t0 = performance.now();
  world.update(dt, view);
  const t1 = performance.now();
  // main.js translates by pieces.shake for world.draw / pieces.draw / world.drawOverlay
  if (dev.shake > 0) {
    dev.shake = Math.max(0, dev.shake - dt);
    dev.shakeX = (Math.random() - 0.5) * 22 * dev.shake; dev.shakeY = (Math.random() - 0.5) * 22 * dev.shake;
  } else { dev.shakeX = dev.shakeY = 0; }
  ctx.setTransform(dpr, 0, 0, dpr, dev.shakeX * dpr, dev.shakeY * dpr);
  world.draw(ctx, view);
  const t2 = performance.now();
  if (dev.pieces) drawMockPieces();
  const t3 = performance.now();
  world.drawOverlay(ctx, view);
  const t4 = performance.now();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (dev.outlines) drawOutlines();
  return [t1 - t0, t2 - t1, t4 - t3];
}

function frame(now) {
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  samples.frame[si] = now - lastNow;
  lastNow = now;
  if (!dev.paused) {
    const [u, d, o] = tick(dt);
    samples.update[si] = u; samples.draw[si] = d; samples.overlay[si] = o;
    si = (si + 1) % N; filled = Math.min(N, filled + 1);
  }
  if (dev.hud && (si % 20 === 0)) renderHelp();
  requestAnimationFrame(frame);
}

function stat(arr) {
  const a = Array.from(arr.subarray(0, filled)).sort((x, y) => x - y);
  if (!a.length) return { mean: 0, p95: 0, max: 0 };
  return { mean: a.reduce((s, v) => s + v, 0) / a.length, p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1] };
}
function perf() {
  const u = stat(samples.update), d = stat(samples.draw), o = stat(samples.overlay), f = stat(samples.frame);
  return { update: u, draw: d, overlay: o, frame: f, drawPlusOverlay: d.mean + o.mean, total: u.mean + d.mean + o.mean, stats: world.stats() };
}

// Synchronous benchmark: n frames back to back, then one readback to flush the raster queue.
function bench(n = 300, dt = 1 / 60) {
  const acc = [0, 0, 0];
  const pieces = dev.pieces; dev.pieces = false;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) { const r = tick(dt); acc[0] += r[0]; acc[1] += r[1]; acc[2] += r[2]; }
  const js = performance.now() - t0;
  ctx.getImageData(0, 0, 1, 1);
  const all = performance.now() - t0;
  dev.pieces = pieces;
  return { frames: n, update: acc[0] / n, draw: acc[1] / n, overlay: acc[2] / n, drawPlusOverlay: (acc[1] + acc[2]) / n, jsPerFrame: js / n, withFlushPerFrame: all / n };
}

// ---------------------------------------------------------------- controls --

function applySelection() {
  const s = SELECTIONS[dev.sel];
  view.selected = s ? s.sq : null;
  view.targets = s ? s.targets : [];
}
const actions = {
  s() { dev.sel = (dev.sel + 1) % SELECTIONS.length; applySelection(); },
  t() { if (view.targets.length) view.targets = []; else view.targets = (SELECTIONS[dev.sel] || SELECTIONS[2]).targets; },
  l() { dev.last = (dev.last + 1) % LAST_MOVES.length; view.lastMove = LAST_MOVES[dev.last] ? { ...LAST_MOVES[dev.last] } : null; },
  c() { view.checkSquare = view.checkSquare ? null : 'e8'; },
  f() { dev.flipped = !dev.flipped; resize(); },
  r() { world.ripple(dev.pointer.x, dev.pointer.y, 1); },
  R() { world.ripple(dev.pointer.x, dev.pointer.y, 2, PAL.spark[2]); },
  x() { world.flash(view.layout.squareAt(dev.pointer.x, dev.pointer.y) || 'e4', undefined, 1); },
  p() { dev.pieces = !dev.pieces; },
  g() { dev.outlines = !dev.outlines; },
  m() { view.reducedMotion = !view.reducedMotion; },
  k() { dev.shake = 0.6; world.ripple(dev.pointer.x, dev.pointer.y, 2); },
  h() { dev.hud = !dev.hud; help.classList.toggle('hidden', !dev.hud); bar.classList.toggle('hidden', !dev.hud); },
  ' '() { dev.paused = !dev.paused; },
};
MOODS.forEach((m, i) => { actions[String(i + 1)] = () => { dev.mood = m; world.setMood(m); }; });

window.addEventListener('keydown', (e) => {
  const a = actions[e.key];
  if (a) { a(); e.preventDefault(); }
});
canvas.addEventListener('pointermove', (e) => {
  dev.pointer.x = e.clientX; dev.pointer.y = e.clientY;
  view.hover = view.layout.squareAt(e.clientX, e.clientY);
});
canvas.addEventListener('pointerleave', () => { view.hover = null; });
canvas.addEventListener('pointerdown', (e) => {
  dev.pointer.x = e.clientX; dev.pointer.y = e.clientY;
  const sq = view.layout.squareAt(e.clientX, e.clientY);
  if (e.shiftKey && sq) world.flash(sq, PAL.select, 1.5);
  else world.ripple(e.clientX, e.clientY, 1);
});

const BUTTONS = [['s', 'select'], ['t', 'targets'], ['l', 'last'], ['c', 'check'], ['1', 'title'], ['2', 'calm'], ['3', 'check mood'], ['4', 'mate'], ['5', 'draw'],
  ['r', 'ripple'], ['R', 'RIPPLE'], ['x', 'flash'], ['f', 'flip'], ['k', 'shake'], ['p', 'pieces'], ['g', 'panels'], ['m', 'reduced'], ['h', 'hide']];
for (const [k, label] of BUTTONS) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => actions[k]());
  bar.appendChild(b);
}

function renderHelp() {
  const p = perf(), L = view.layout;
  const f = (v) => v.toFixed(2);
  help.innerHTML =
    `<b>world harness</b>  ${L.W}×${L.H} dpr ${L.dpr}  grid ${L.cols}×${L.rows}  cell ${L.cw}×${L.ch}  font ${L.fontPx}\n` +
    `mood <b>${dev.mood}</b>  sel ${view.selected || '–'}  last ${view.lastMove ? view.lastMove.from + view.lastMove.to : '–'}  check ${view.checkSquare || '–'}  hover ${view.hover || '–'}${view.reducedMotion ? '  reduced' : ''}${dev.flipped ? '  flipped' : ''}\n` +
    `ms/frame  update ${f(p.update.mean)}  draw ${f(p.draw.mean)}  overlay ${f(p.overlay.mean)}  <b>draw+overlay ${f(p.drawPlusOverlay)}</b> (p95 ${f(p.draw.p95 + p.overlay.p95)})  frame ${f(p.frame.mean)}\n` +
    `hot cells ${p.stats.hot}  ripples ${p.stats.ripples}  colours ${p.stats.colors}\n` +
    `s select  t targets  l last move  c check  1-5 moods  f flip  r/R ripple  x flash\n` +
    `k shake  p pieces  g panels  m reduced motion  space pause  h hide   click ripple  shift-click flash`;
}

// --------------------------------------------------------------------- go --

if (!dev.hud) { help.classList.add('hidden'); bar.classList.add('hidden'); }
resize();
if (dev.mood !== 'calm') world.setMood(dev.mood);

window.__dev = {
  world, view, dev, perf, bench, actions,
  set(patch) { Object.assign(view, patch); },
  mood(m) { dev.mood = m; world.setMood(m); },
  flip(v = !dev.flipped) { dev.flipped = v; resize(); },
  // Advance simulated time without waiting for wall-clock (for screenshots).
  step(seconds, dt = 1 / 60) { for (let t = 0; t < seconds; t += dt) tick(dt); },
};

if (document.fonts && document.fonts.ready) await document.fonts.ready;
requestAnimationFrame((now) => { lastNow = now; requestAnimationFrame(frame); });
