// Harness for src/render: mounts the pieces module on a mocked view + world.
//
//   node tools/serve.mjs 8101   →   http://localhost:8101/dev/render.html
//
// URL params:  ?scene=start|lineup|empty   &field=0..1 (mock field strength)
//              &ui=0 (hide the panel)      &manual=1 (no rAF loop; drive with H.step)
// Keys: 1-6 kills (p n b r q k), q w e r t y quiet moves, c castle, x en passant,
//       p promotion, m mate, s stalemate, n new game, f flip, space select, d demo.
// Everything is also on window.H for Playwright.

import { computeLayout } from '../src/core/layout.js';
import { createBus } from '../src/core/bus.js';
import { getAtlas } from '../src/core/glyphs.js';
import { PAL, GLYPHS } from '../src/core/palette.js';
import { FILES, sqFile, sqRank, sqName, isLightSquare, hash2, TAU } from '../src/core/util.js';
import { createPieces } from '../src/render/index.js';
import { TUNE, createSprites } from '../src/render/sprites.js';

const params = new URLSearchParams(location.search);
if (params.has('fineK')) TUNE.fineK = +params.get('fineK');
if (params.has('fontK')) TUNE.fontK = +params.get('fontK');
if (params.has('weight')) TUNE.weight = +params.get('weight');
if (params.has('breath')) TUNE.breath = +params.get('breath');
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const statsEl = document.getElementById('stats');
const panel = document.getElementById('panel');
if (params.get('ui') === '0') { panel.classList.add('hidden'); statsEl.style.display = 'none'; }

// --- a tiny rule-less chess board (enough to drive animations) -----------------
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
function mockGame(fen = START) {
  let grid = [];
  let turn = 'w';
  const load = (f) => {
    grid = f.split(' ')[0].split('/').map((row) => {
      const out = [];
      for (const ch of row) {
        if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) out.push(null);
        else out.push({ type: ch.toLowerCase(), color: ch === ch.toLowerCase() ? 'b' : 'w' });
      }
      return out;
    });
  };
  load(fen);
  const at = (sq) => grid[7 - sqRank(sq)][sqFile(sq)];
  const set = (sq, v) => { grid[7 - sqRank(sq)][sqFile(sq)] = v; };
  return {
    get turn() { return turn; },
    set turn(v) { turn = v; },
    load,
    board: () => grid.map((r) => r.map((c) => (c ? { ...c } : null))),
    get: (sq) => { const c = at(sq); return c ? { ...c } : null; },
    kingSquare(color) {
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = grid[r][c];
        if (p && p.type === 'k' && p.color === color) return sqName(c, 7 - r);
      }
      return null;
    },
    // No legality: just applies and describes the move like the engine would.
    move({ from, to, promotion }) {
      const p = at(from);
      if (!p) return null;
      const m = { from, to, piece: p.type, color: p.color, check: false, mate: false, san: `${from}${to}` };
      const target = at(to);
      if (target) { m.captured = target.type; m.capturedSquare = to; }
      if (p.type === 'p' && sqFile(from) !== sqFile(to) && !target) {
        const csq = sqName(sqFile(to), sqRank(from));
        if (at(csq)) { m.captured = at(csq).type; m.capturedSquare = csq; m.enPassant = true; set(csq, null); }
      }
      if (p.type === 'p' && Math.abs(sqRank(to) - sqRank(from)) === 2) m.double = true;
      if (p.type === 'k' && Math.abs(sqFile(to) - sqFile(from)) === 2) {
        const ks = sqFile(to) > sqFile(from), rank = sqRank(from);
        m.castle = ks ? 'k' : 'q';
        m.rookFrom = sqName(ks ? 7 : 0, rank); m.rookTo = sqName(ks ? 5 : 3, rank);
        set(m.rookTo, at(m.rookFrom)); set(m.rookFrom, null);
      }
      if (p.type === 'p' && (sqRank(to) === 7 || sqRank(to) === 0)) m.promotion = promotion || 'q';
      set(to, m.promotion ? { type: m.promotion, color: p.color } : p);
      set(from, null);
      turn = turn === 'w' ? 'b' : 'w';
      return m;
    },
  };
}

// --- mocked world: dark void, a faint glyph board, visible ripples/flashes -------
const fieldK = params.has('field') ? +params.get('field') : 0.3;
let layout, fieldCanvas = null;
const ripples = [], flashes = [];
function buildField() {
  const { W, H, dpr } = layout;
  fieldCanvas = new OffscreenCanvas(Math.ceil(W * dpr), Math.ceil(H * dpr));
  const g = fieldCanvas.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = PAL.bg;
  g.fillRect(0, 0, W, H);
  const light = getAtlas({ fontPx: layout.fontPx, color: PAL.lightSq, dpr });
  const dark = getAtlas({ fontPx: layout.fontPx, color: PAL.darkSq, dpr });
  const out = getAtlas({ fontPx: layout.fontPx, color: PAL.field[5], dpr });
  for (let r = 0; r < layout.rows; r++) for (let c = 0; c < layout.cols; c++) {
    const sq = layout.squareAtCell(c, r);
    const h = hash2(c, r, 3);
    if (!sq) {
      if (h < 0.55) { g.globalAlpha = 0.5 * Math.min(1, fieldK * 2); out.draw(g, GLYPHS.outside[(h * 97 | 0) % GLYPHS.outside.length], layout.cellX(c), layout.cellY(r)); }
      continue;
    }
    const isL = isLightSquare(sq), fam = isL ? GLYPHS.lightSq : GLYPHS.darkSq;
    g.globalAlpha = fieldK * (isL ? 1 : 0.9);
    (isL ? light : dark).draw(g, fam[(h * 131 | 0) % fam.length], layout.cellX(c), layout.cellY(r));
  }
}
const world = {
  ripple(x, y, strength = 1, color) { if (params.get('fxworld') === '0') return; ripples.push({ x, y, s: strength, t: 0, color: color || PAL.field[1] }); },
  flash(sq, color, strength = 1) { if (params.get('fxworld') === '0') return; flashes.push({ sq, color: color || PAL.select, s: strength, t: 0 }); },
  draw(c, dt) {
    c.drawImage(fieldCanvas, 0, 0, layout.W, layout.H);
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]; f.t += dt;
      const u = f.t / 0.3;
      if (u >= 1) { flashes.splice(i, 1); continue; }
      const cell = layout.squareCell(f.sq), a = getAtlas({ fontPx: layout.fontPx, color: f.color, dpr: layout.dpr });
      c.globalAlpha = Math.min(1, (1 - u) * 0.8 * f.s);
      for (let r = 0; r < 3; r++) for (let k = 0; k < 6; k++) a.draw(c, '#', layout.cellX(cell.c + k), layout.cellY(cell.r + r));
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i]; r.t += dt;
      const u = r.t / 0.6;
      if (u >= 1) { ripples.splice(i, 1); continue; }
      const rad = layout.sq * (0.3 + 1.6 * u * r.s), a = getAtlas({ fontPx: layout.fontPx, color: r.color, dpr: layout.dpr });
      const n = Math.max(8, Math.floor((TAU * rad) / (layout.cw * 1.6)));
      c.globalAlpha = (1 - u) * 0.6;
      for (let k = 0; k < n; k++) {
        const an = (k / n) * TAU;
        a.draw(c, 'o', r.x + Math.cos(an) * rad, r.y + Math.sin(an) * rad * 0.5);
      }
    }
    c.globalAlpha = 1;
  },
};

// --- mount -------------------------------------------------------------------------
const bus = createBus();
const sfxLog = [];
bus.on('sfx', (e) => { sfxLog.push({ ...e, t: performance.now() }); if (sfxLog.length > 200) sfxLog.shift(); });
const manual = params.get('manual') === '1';
const pieces = createPieces({ bus, world, watchdog: !manual || params.get('watchdog') === '1' });
let game = mockGame();
let flipped = false;
const view = {
  t: 0, dt: 0, layout: null, phase: 'playing',
  config: { mode: 'hotseat', level: 1, humanColor: 'w' },
  game, turn: 'w', status: 'playing', winner: null,
  selected: null, targets: [], hover: null, drag: null, lastMove: null, checkSquare: null,
  promotion: null, captured: { w: [], b: [] }, busy: false, thinking: false, muted: false,
  reducedMotion: params.get('rm') === '1',
};

function resize() {
  const dpr = window.devicePixelRatio || 1, W = window.innerWidth, H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  layout = computeLayout(W, H, dpr, flipped);
  if (params.has('pieceH')) layout.pieceH = layout.sq * +params.get('pieceH');   // experiment: shorter pieces
  view.layout = layout;
  buildField();
  pieces.resize(layout);
}
window.addEventListener('resize', resize);
resize();

// --- frame loop + perf probes ------------------------------------------------------
const perf = { cpu: [], frame: [], on: false };
let last = performance.now();
function frame(dt) {
  view.t += dt; view.dt = dt;
  view.turn = game.turn; view.game = game;
  const t0 = performance.now();
  pieces.update(dt, view);
  const ta = performance.now();
  ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
  ctx.save();
  ctx.translate(pieces.shake.x, pieces.shake.y);
  world.draw(ctx, dt);
  const t1 = performance.now();
  pieces.draw(ctx, view);
  ctx.restore();
  const t2 = performance.now();
  if (perf.on) perf.cpu.push(t2 - t1, ta - t0, t1 - ta);
  return t2 - t1 + ta - t0;
}
let statAcc = 0, statN = 0, statCpu = 0;
function loop(now) {
  const dtMs = now - last; last = now;
  const cpu = frame(Math.min(0.1, dtMs / 1000));
  if (perf.on) perf.frame.push(dtMs);
  statAcc += dtMs; statN++; statCpu += cpu;
  if (statAcc > 500) {
    const d = pieces.debug;
    statsEl.textContent = `${(1000 / (statAcc / statN)).toFixed(0)} fps   cpu ${(statCpu / statN).toFixed(2)} ms\nsq ${layout.sq}  dpr ${layout.dpr}\nactors ${d.actors}  particles ${d.particles}\nbitmaps ${d.bitmaps}  frames ${d.cells}`;
    statAcc = 0; statN = 0; statCpu = 0;
  }
  requestAnimationFrame(loop);
}
if (!manual) requestAnimationFrame(loop);

// --- scenes ---------------------------------------------------------------------------
const SCENES = {
  start: START,
  lineup: '8/8/kqrbnp2/8/8/2KQRBNP/8/8',
  lineup2: '8/8/8/kqrbnp2/KQRBNP2/8/8/8',
  empty: '8/8/8/8/8/8/8/8',
};
function setFen(fen, { instant = true, turn = 'w' } = {}) {
  game = mockGame(fen); game.turn = turn;
  view.game = game; view.turn = turn; view.status = 'playing'; view.winner = null; view.phase = 'playing';
  view.selected = null; view.drag = null; view.checkSquare = null;
  return pieces.sync(game, layout, { instant });
}
async function mv(from, to, promotion) {
  const m = game.move({ from, to, promotion });
  if (!m) return;
  view.lastMove = m; view.busy = true;
  const t0 = performance.now();
  await pieces.play(m, view);
  view.busy = false;
  H.lastDuration = performance.now() - t0;
  return m;
}
// attacker type → [fen, from, to]
const KILLS = {
  p: ['8/8/8/4n3/3P4/8/8/8', 'd4', 'e5'],
  n: ['8/8/8/3b4/8/2N5/8/8', 'c3', 'd5'],
  b: ['8/8/8/5r2/8/8/2B5/8', 'c2', 'f5'],
  r: ['8/8/8/8/1R3q2/8/8/8', 'b4', 'f4'],
  q: ['8/8/3r4/8/8/8/3Q4/8', 'd2', 'd6'],
  k: ['8/8/8/4p3/3K4/8/8/8', 'd4', 'e5'],
};
const KILLS_B = {
  p: ['8/8/8/4p3/3N4/8/8/8', 'e5', 'd4'],
  n: ['8/8/5n2/8/4B3/8/8/8', 'f6', 'e4'],
  b: ['8/8/6b1/8/8/3R4/8/8', 'g6', 'd3'],
  r: ['8/8/8/2Q3r1/8/8/8/8', 'g5', 'c5'],
  q: ['8/3q4/8/8/8/3P4/8/8', 'd7', 'd3'],
  k: ['8/8/8/4k3/3N4/8/8/8', 'e5', 'd4'],
};
const QUIETS = {
  p: ['8/8/8/8/8/8/4P3/8', 'e2', 'e4'],
  n: ['8/8/8/8/8/8/8/1N6', 'b1', 'c3'],
  b: ['8/8/8/8/8/8/8/2B5', 'c1', 'g5'],
  r: ['8/8/8/8/8/8/8/R7', 'a1', 'a6'],
  q: ['8/8/8/8/8/8/8/3Q4', 'd1', 'h5'],
  k: ['8/8/8/8/8/8/8/4K3', 'e1', 'e2'],
};
const H = {
  pieces, view, perf, sfxLog, lastDuration: 0,
  get layout() { return layout; },
  get game() { return game; },
  scene: (name, opts) => setFen(SCENES[name] || name, opts),
  newGame: () => setFen(START, { instant: false }),
  async kill(type, black = false) {
    const [fen, from, to] = (black ? KILLS_B : KILLS)[type];
    await setFen(fen, { turn: black ? 'b' : 'w' });
    return mv(from, to);
  },
  // capture inside the full starting position (for perf with 32 pieces)
  async killInStart(type = 'q') {
    const fens = {
      q: 'rnbqkbnr/ppp1pppp/8/3p4/8/8/PPPQPPPP/RNB1KBNR', n: 'rnbqkbnr/pppp1ppp/8/4p3/8/5N2/PPPPPPPP/RNBQKB1R',
      r: 'rnbqkbnr/1ppppppp/8/p7/8/8/RPPPPPPP/1NBQKBNR', b: 'rnbqkbnr/pppppp1p/8/6p1/8/8/PPPBPPPP/RN1QKBNR',
    };
    const mvs = { q: ['d2', 'd5'], n: ['f3', 'e5'], r: ['a2', 'a5'], b: ['d2', 'g5'] };
    await setFen(fens[type]);
    return mv(...mvs[type]);
  },
  async quiet(type) { const [fen, from, to] = QUIETS[type]; await setFen(fen); return mv(from, to); },
  async castle(side = 'k') { await setFen('8/8/8/8/8/8/8/R3K2R'); return mv('e1', side === 'k' ? 'g1' : 'c1'); },
  async enPassant() { await setFen('8/8/8/3pP3/8/8/8/8'); return mv('e5', 'd6'); },
  async promote(piece = 'q', capture = false) {
    await setFen(capture ? '3r4/4P3/8/8/8/8/8/8' : '8/4P3/8/8/8/8/8/8');
    return mv('e7', capture ? 'd8' : 'e8', piece);
  },
  async mate(winner = 'w') {
    await setFen(winner === 'w' ? '6k1/5ppp/8/8/8/8/5PPP/3RR1K1' : '3rr1k1/5ppp/8/8/8/8/5PPP/6K1');
    const m = winner === 'w' ? await mv('e1', 'e8') : await mv('e8', 'e1');
    view.status = 'checkmate'; view.winner = winner; view.phase = 'gameover';
    view.checkSquare = game.kingSquare(winner === 'w' ? 'b' : 'w');
    const t0 = performance.now();
    await pieces.finale('checkmate', winner, view);
    H.lastDuration = performance.now() - t0;
    return m;
  },
  async mateStart(winner = 'w') {
    await setFen(START);
    view.status = 'checkmate'; view.winner = winner; view.phase = 'gameover';
    const t0 = performance.now();
    await pieces.finale('checkmate', winner, view);
    H.lastDuration = performance.now() - t0;
  },
  async stalemate() {
    await setFen('7k/5Q2/6K1/8/8/3b4/8/8');
    view.status = 'stalemate'; view.phase = 'gameover';
    const t0 = performance.now();
    await pieces.finale('stalemate', null, view);
    H.lastDuration = performance.now() - t0;
  },
  flip() { flipped = !flipped; resize(); pieces.sync(game, layout, { instant: true }); },
  select(sq) { view.selected = view.selected === sq ? null : sq; },
  drag(from, x, y) { view.drag = from ? { from, x, y } : null; },
  reduced(on) { view.reducedMotion = on; },
  move: mv,
  // manual stepping (with ?manual=1): advance n frames of dt, drawing the last
  step(dt = 1 / 60, n = 1) { let c = 0; for (let i = 0; i < n; i++) c = frame(dt); return c; },
  perfStart() { perf.cpu.length = 0; perf.frame.length = 0; perf.on = true; },
  perfStop() {
    perf.on = false;
    const draw = [], upd = [], wld = [];
    for (let i = 0; i < perf.cpu.length; i += 3) { draw.push(perf.cpu[i]); upd.push(perf.cpu[i + 1]); wld.push(perf.cpu[i + 2]); }
    const stat = (a) => {
      if (!a.length) return null;
      const s = [...a].sort((x, y) => x - y);
      return { n: a.length, avg: +(a.reduce((p, q) => p + q, 0) / a.length).toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3), max: +s[s.length - 1].toFixed(3) };
    };
    return { piecesDraw: stat(draw), piecesUpdate: stat(upd), mockWorld: stat(wld), frameInterval: stat(perf.frame.slice(1)) };
  },
  // debug: draw `n` evenly spaced yaw frames of each given type straight from the sprite cache
  turntable(types = 'pnbrqk', color = 'w', n = 10) {
    const sp = createSprites();
    sp.configure(layout);
    ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
    ctx.fillStyle = PAL.bg; ctx.fillRect(0, 0, layout.W, layout.H);
    let y = 20;
    for (const t of types) {
      const b = sp.box(t);
      y += b.h;
      for (let k = 0; k < n; k++) {
        const i = Math.round((k / n) * b.frames) % b.frames;
        ctx.drawImage(sp.bitmap(t, color, i), 20 + k * (b.w + 6), y - b.h, b.w, b.h);
      }
      y += 6;
    }
  },
  async demo() {
    for (const t of 'pnbrqk') { await H.kill(t); await wait(500); await H.kill(t, true); await wait(500); }
    await H.castle('k'); await wait(400); await H.castle('q'); await wait(400);
    await H.enPassant(); await wait(400); await H.promote('q'); await wait(500); await H.promote('n', true); await wait(500);
    await H.mate('w'); await wait(800); await H.stalemate(); await wait(800); await H.newGame();
  },
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.H = H;

// --- UI --------------------------------------------------------------------------------
function section(title, items) {
  const h = document.createElement('h4'); h.textContent = title; panel.appendChild(h);
  for (const [label, fn] of items) {
    const b = document.createElement('button'); b.textContent = label; b.onclick = () => fn(); panel.appendChild(b);
  }
}
const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
section('SCENE', [['start', () => H.scene('start')], ['new game', H.newGame], ['line-up', () => H.scene('lineup')], ['flip', H.flip], ['demo all', H.demo]]);
section('KILL (bone attacks)', [...'pnbrqk'].map((t) => [names[t], () => H.kill(t)]));
section('KILL (ember attacks)', [...'pnbrqk'].map((t) => [names[t], () => H.kill(t, true)]));
section('KILL in full board', [...'qnrb'].map((t) => [names[t], () => H.killInStart(t)]));
section('QUIET MOVE', [...'pnbrqk'].map((t) => [names[t], () => H.quiet(t)]));
section('SPECIAL', [['O-O', () => H.castle('k')], ['O-O-O', () => H.castle('q')], ['en passant', H.enPassant],
  ['promote Q', () => H.promote('q')], ['promote N', () => H.promote('n')], ['capture+promote', () => H.promote('q', true)]]);
section('FINALE', [['mate (bone)', () => H.mate('w')], ['mate (ember)', () => H.mate('b')], ['mate, full board', () => H.mateStart('w')], ['stalemate', H.stalemate]]);
section('VIEW', [['reduced motion', () => { H.reduced(!view.reducedMotion); }], ['toggle panel', () => panel.classList.toggle('hidden')]]);

const keymap = {
  1: () => H.kill('p'), 2: () => H.kill('n'), 3: () => H.kill('b'), 4: () => H.kill('r'), 5: () => H.kill('q'), 6: () => H.kill('k'),
  q: () => H.quiet('p'), w: () => H.quiet('n'), e: () => H.quiet('b'), r: () => H.quiet('r'), t: () => H.quiet('q'), y: () => H.quiet('k'),
  c: () => H.castle('k'), x: H.enPassant, p: () => H.promote('q'), m: () => H.mate('w'), s: H.stalemate, n: H.newGame, f: H.flip, d: H.demo,
  h: () => panel.classList.toggle('hidden'),
};
window.addEventListener('keydown', (e) => { const fn = keymap[e.key]; if (fn) fn(); });

// click a piece to select it, drag to carry it, drop to move it
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  const sq = layout.squareAt(e.clientX, e.clientY);
  if (sq && game.get(sq)) { down = { sq, x: e.clientX, y: e.clientY, moved: false }; view.selected = sq; }
  else if (sq && view.selected) { const from = view.selected; view.selected = null; mv(from, sq); }
});
canvas.addEventListener('pointermove', (e) => {
  if (!down) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
  if (down.moved) view.drag = { from: down.sq, x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const to = layout.squareAt(e.clientX, e.clientY), from = down.sq, moved = down.moved;
  down = null;
  if (moved) {
    view.selected = null;
    if (to && to !== from) { mv(from, to).then(() => { }); view.drag = null; }
    else view.drag = null;
  }
});

const scene = params.get('scene') || 'start';
setFen(SCENES[scene] || scene);
