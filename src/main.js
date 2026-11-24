// ASCII Chess — game loop and state machine.
// Wires engine, world, pieces and UI together; see CONTRACTS.md.

import { createBus } from './core/bus.js';
import { computeLayout } from './core/layout.js';
import { PAL } from './core/palette.js';
import { getAtlas } from './core/glyphs.js';
import { createGame } from './engine/chess.js';
import { createAI } from './engine/ai.js';
import { createWorld } from './world/index.js';
import { createPieces } from './render/index.js';
import { createUI } from './ui/index.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d', { alpha: false });
const params = new URLSearchParams(location.search);
const MAX_DPR = 2;
const DRAG_THRESHOLD = 6;          // px before a press becomes a drag
const DEMO_MOVE_GAP = 0.9;         // seconds between demo moves
const DEMO_MAX_PLIES = 140;
const AI_MIN_THINK = 0.45;         // seconds — an instant reply feels wrong

const bus = createBus();
const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');

const view = {
  t: 0, dt: 0,
  layout: null,
  phase: 'title',
  config: { mode: 'demo', level: 1, humanColor: 'w' },
  game: createGame(),
  turn: 'w',
  status: 'playing',
  winner: null,
  selected: null,
  targets: [],
  hover: null,
  drag: null,
  lastMove: null,
  checkSquare: null,
  promotion: null,
  captured: { w: [], b: [] },
  busy: false,
  thinking: false,
  muted: false,
  reducedMotion: !!motionQuery?.matches,
};
motionQuery?.addEventListener?.('change', (e) => { view.reducedMotion = e.matches; });

const world = createWorld({ bus });
const pieces = createPieces({ bus, world });
const ui = createUI({ bus, canvas });
const ai = createAI();

let flipped = false;
let gen = 0;                 // bumped whenever the current game is abandoned
let press = null;            // { sq, x, y, wasSelected } while the pointer is down on a square
let pendingSync = false;     // a resize/flip arrived mid-animation

const wait = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));
const sfx = (name, intensity = 1) => bus.emit('sfx', { name, intensity });

// ---------------------------------------------------------------- layout --

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const W = Math.max(240, window.innerWidth);
  const H = Math.max(240, window.innerHeight);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  view.layout = computeLayout(W, H, dpr, flipped);
  world.resize(view.layout);
  pieces.resize(view.layout);
  ui.resize(view.layout);
  resyncPieces();
}

function resyncPieces() {
  if (view.busy) { pendingSync = true; return; }
  pendingSync = false;
  pieces.sync(view.game, view.layout, { instant: true });
}

function setFlipped(value) {
  if (flipped === value) return;
  flipped = value;
  view.drag = null; press = null;
  resize();
}

// ------------------------------------------------------------ game state --

function refreshState() {
  const { game } = view;
  view.turn = game.turn;
  view.status = game.status();
  view.checkSquare = view.status !== 'checkmate' && game.inCheck() ? game.kingSquare(game.turn) : null;
  if (view.status === 'checkmate') view.checkSquare = game.kingSquare(game.turn);
  view.winner = view.status === 'checkmate' ? (game.turn === 'w' ? 'b' : 'w') : null;
  const history = game.history();
  view.lastMove = history.length ? history[history.length - 1] : null;
  const captured = { w: [], b: [] };
  for (const m of history) if (m.captured) captured[m.color].push(m.captured);
  view.captured = captured;
}

function moodFor() {
  if (view.phase === 'title') return 'title';
  if (view.status === 'checkmate') return 'mate';
  if (view.status !== 'playing') return 'draw';
  return view.checkSquare ? 'check' : 'calm';
}

function clearSelection() {
  view.selected = null;
  view.targets = [];
  view.drag = null;
  view.promotion = null;
  press = null;
}

function isHumanTurn() {
  if (view.phase !== 'playing' || view.busy || view.thinking || view.promotion) return false;
  if (view.config.mode === 'hotseat') return true;
  return view.config.mode === 'ai' && view.turn === view.config.humanColor;
}

function isAITurn() {
  if (view.status !== 'playing') return false;
  if (view.config.mode === 'demo') return view.phase === 'title';
  return view.phase === 'playing' && view.config.mode === 'ai' && view.turn !== view.config.humanColor;
}

function startGame(config, { demo = false, fen } = {}) {
  gen++;
  ai.cancel();
  view.config = { ...config };
  view.phase = demo ? 'title' : 'playing';
  view.game = createGame(fen);
  view.busy = false;
  view.thinking = false;
  clearSelection();
  view.hover = null;
  refreshState();
  world.setMood(moodFor());

  const wantFlip = !demo && config.mode === 'ai' && config.humanColor === 'b';
  if (wantFlip !== flipped) { flipped = wantFlip; resize(); }
  pieces.sync(view.game, view.layout, { instant: false });
  pendingSync = false;

  if (!demo) sfx('start');
  bus.emit('game:start', { config: view.config });
  if (isAITurn()) aiTurn(demo ? 1.6 : 0.9);
}

const startDemo = () => startGame({ mode: 'demo', level: 1, humanColor: 'w' }, { demo: true });

async function playMove(spec) {
  const my = gen;
  const move = view.game.move(spec);
  if (!move) { sfx('illegal'); return false; }

  clearSelection();
  view.busy = true;
  view.lastMove = move;
  view.checkSquare = null;
  if (move.captured) view.captured[move.color].push(move.captured);
  bus.emit('game:move', { move });

  try {
    await pieces.play(move, view);
  } catch (err) {
    console.error('[play]', err);
  }
  if (my !== gen) return true;

  view.busy = false;
  if (pendingSync) resyncPieces();
  refreshState();
  world.setMood(moodFor());

  if (view.status !== 'playing') {
    await endGame(my);
    return true;
  }
  if (view.checkSquare) sfx('check');
  if (isAITurn()) aiTurn();
  return true;
}

async function endGame(my) {
  const demo = view.config.mode === 'demo';
  sfx(view.status === 'checkmate' ? 'mate' : 'draw');
  view.busy = true;
  try {
    await pieces.finale(view.status, view.winner, view);
  } catch (err) {
    console.error('[finale]', err);
  }
  if (my !== gen) return;
  view.busy = false;
  if (demo) {
    await wait(2.2);
    if (my === gen) startDemo();
    return;
  }
  view.phase = 'gameover';
  bus.emit('game:over', { status: view.status, winner: view.winner });
}

async function aiTurn(extraDelay = 0) {
  const my = gen;
  const demo = view.config.mode === 'demo';
  if (demo && view.game.history().length >= DEMO_MAX_PLIES) {
    await wait(1.5);
    if (my === gen) startDemo();
    return;
  }
  view.thinking = !demo;
  const started = performance.now();
  let move = null;
  try {
    if (extraDelay) await wait(extraDelay);
    if (my !== gen) return;
    // Hand over the move history too, so the search can see repetitions.
    move = await ai.requestMove(view.game.fen(), demo ? 1 : view.config.level, {
      startFen: view.game._startFen,
      moves: view.game.history(),
    });
  } catch (err) {
    if (my === gen) console.warn('[ai]', err);
  }
  if (my !== gen) return;
  const elapsed = (performance.now() - started) / 1000 - extraDelay;
  const floor = demo ? DEMO_MOVE_GAP : AI_MIN_THINK;
  if (elapsed < floor) await wait(floor - elapsed);
  if (my !== gen) return;
  view.thinking = false;
  if (!move) {
    // Search failed: fall back to any legal move so the game never stalls.
    const legal = view.game.legalMoves();
    move = legal[Math.floor(Math.random() * legal.length)];
    if (!move) return;
  }
  playMove({ from: move.from, to: move.to, promotion: move.promotion });
}

function undo() {
  if (view.busy || view.phase === 'title') return;
  const { game, config } = view;
  if (!game.history().length) { sfx('illegal'); return; }
  gen++;
  ai.cancel();
  view.thinking = false;
  game.undo();
  // Against the computer, step back to the human's own move.
  if (config.mode === 'ai' && game.turn !== config.humanColor && game.history().length) game.undo();
  view.phase = 'playing';
  clearSelection();
  refreshState();
  world.setMood(moodFor());
  pieces.sync(game, view.layout, { instant: true });
  sfx('deselect');
  if (isAITurn()) aiTurn(0.3);
}

// ----------------------------------------------------------------- input --

function select(sq) {
  view.selected = sq;
  view.targets = view.game.legalMoves(sq);
  sfx('select');
}

function tryMove(from, to) {
  const options = view.targets.filter((m) => m.from === from && m.to === to);
  if (!options.length) return false;
  if (options.some((m) => m.promotion)) {
    view.drag = null;
    view.promotion = { color: view.turn, from, to };
    sfx('ui');
    return true;
  }
  playMove({ from, to });
  return true;
}

bus.on('sq:down', ({ sq, x, y }) => {
  if (!isHumanTurn() || !sq) return;
  const piece = view.game.get(sq);
  const own = piece && piece.color === view.turn;
  if (view.selected && view.selected !== sq && tryMove(view.selected, sq)) return;
  if (own) {
    const wasSelected = view.selected === sq;
    if (!wasSelected) select(sq);
    press = { sq, x, y, wasSelected };
  } else if (view.selected) {
    clearSelection();
    sfx('deselect');
  }
});

bus.on('sq:move', ({ sq, x, y }) => {
  view.hover = view.phase === 'playing' ? sq : null;
  if (!press || !isHumanTurn()) return;
  if (!view.drag && Math.hypot(x - press.x, y - press.y) > DRAG_THRESHOLD) {
    view.drag = { from: press.sq, x, y };
  } else if (view.drag) {
    view.drag = { from: press.sq, x, y };
  }
});

bus.on('sq:up', ({ sq }) => {
  if (!press) return;
  const { sq: from, wasSelected } = press;
  const dragged = !!view.drag;
  press = null;
  view.drag = null;
  if (!isHumanTurn()) return;
  if (dragged) {
    if (sq && sq !== from) tryMove(from, sq);
  } else if (wasSelected && sq === from) {
    clearSelection();
    sfx('deselect');
  }
});

bus.on('ui:promote', ({ piece }) => {
  const p = view.promotion;
  if (!p) return;
  view.promotion = null;
  playMove({ from: p.from, to: p.to, promotion: piece });
});
bus.on('ui:promoteCancel', () => { view.promotion = null; });

bus.on('ui:newGame', (config) => {
  startGame({
    mode: config?.mode === 'hotseat' ? 'hotseat' : 'ai',
    level: [1, 2, 3].includes(config?.level) ? config.level : 2,
    humanColor: config?.humanColor === 'b' ? 'b' : 'w',
  });
});
bus.on('ui:undo', undo);
bus.on('ui:flip', () => { if (view.phase !== 'title') setFlipped(!flipped); });
bus.on('ui:mute', () => { view.muted = !view.muted; });
bus.on('ui:menu', () => { if (view.phase !== 'title') startDemo(); });

// ------------------------------------------------------------------ loop --

const stats = { frameMs: 0, drawMs: 0, fps: 0 };
const showStats = params.has('fps');
const warned = new Set();
function guard(label, fn) {
  try { fn(); } catch (err) {
    if (!warned.has(label)) { warned.add(label); console.error(`[${label}]`, err); }
  }
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = (now - last) / 1000;
  last = now;
  const dt = Math.min(rawDt, 0.05);
  view.dt = dt;
  view.t += dt;

  const t0 = performance.now();
  guard('world.update', () => world.update(dt, view));
  guard('pieces.update', () => pieces.update(dt, view));
  guard('ui.update', () => ui.update(dt, view));

  const { layout } = view;
  ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = PAL.bg;
  ctx.fillRect(0, 0, layout.W, layout.H);

  const shake = view.reducedMotion ? null : pieces.shake;
  ctx.save();
  if (shake && (shake.x || shake.y)) ctx.translate(shake.x, shake.y);
  guard('world.draw', () => world.draw(ctx, view));
  guard('pieces.draw', () => pieces.draw(ctx, view));
  guard('world.drawOverlay', () => world.drawOverlay(ctx, view));
  ctx.restore();
  ctx.globalAlpha = 1;
  guard('ui.draw', () => ui.draw(ctx, view));

  const cost = performance.now() - t0;
  stats.drawMs += (cost - stats.drawMs) * 0.05;
  stats.frameMs += (rawDt * 1000 - stats.frameMs) * 0.05;
  stats.fps = 1000 / Math.max(1, stats.frameMs);
  if (showStats) {
    ctx.globalAlpha = 1;
    getAtlas({ fontPx: 11, color: PAL.textDim, weight: 500, dpr: layout.dpr })
      .text(ctx, `${stats.fps.toFixed(0)} fps  ${stats.drawMs.toFixed(1)} ms`, 8, layout.H - 10);
  }
}

window.addEventListener('resize', resize);
window.visualViewport?.addEventListener?.('resize', resize);

resize();
startDemo();
requestAnimationFrame((now) => { last = now; frame(now); });

// Handle for tests and tinkering in the console.
window.__chess = { view, bus, world, pieces, ui, ai, stats, playMove, startGame, startDemo, undo };
