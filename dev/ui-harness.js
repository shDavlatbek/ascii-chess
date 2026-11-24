// Mounts src/ui over a dark background with a faint board outline and a mocked view.
import { createBus } from '../src/core/bus.js';
import { computeLayout } from '../src/core/layout.js';
import { PAL } from '../src/core/palette.js';
import { createUI } from '../src/ui/index.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const logEl = document.getElementById('log');
if (params.has('nolog')) { logEl.style.display = 'none'; document.getElementById('help').style.display = 'none'; }

const SAN = ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7','Re1','b5','Bb3','d6','c3','O-O','h3','Nb8','d4','Nbd7',
  'c4','c6','cxb5','axb5','Nc3','Bb7','Bg5','b4','Nb1','h6','Bxf6','Nxf6','exd5+','Qxd5','Qe2#'];
const mkMove = (san, i) => ({ san, color: i % 2 ? 'b' : 'w', from: 'e2', to: 'e4', piece: 'p', check: /[+#]/.test(san), mate: /#/.test(san) });
let moves = SAN.slice(0, 30).map(mkMove);
const game = { history: () => moves, inCheck: () => false };

const bus = createBus();
const log = [];
window.__log = log;
const EVENTS = ['sq:down', 'sq:move', 'sq:up', 'ui:newGame', 'ui:undo', 'ui:flip', 'ui:mute', 'ui:menu', 'ui:promote', 'ui:promoteCancel'];
let lastSq = null;
let moveCount = 0;
for (const name of EVENTS) {
  bus.on(name, (p) => {
    log.push({ name, p });
    if (name === 'sq:move') { moveCount++; lastSq = p.sq; if (moveCount % 4) return; }
    if (name === 'sq:down' || name === 'sq:up') lastSq = p.sq;
    const s = name + ' ' + (p ? JSON.stringify(p, (k, v) => (typeof v === 'number' ? Math.round(v) : v)) : '');
    logEl.textContent = (s + '\n' + logEl.textContent).split('\n').slice(0, 14).join('\n');
  });
}
bus.on('sfx', () => {});

const view = {
  t: 0, dt: 0, layout: null, phase: 'title',
  config: { mode: 'ai', level: 2, humanColor: 'w' },
  game, turn: 'w', status: 'playing', winner: null,
  selected: null, targets: [], hover: null, drag: null, lastMove: null, checkSquare: null,
  promotion: null, captured: { w: ['p', 'n', 'p', 'r'], b: ['b', 'p'] },
  busy: false, thinking: false, muted: false, reducedMotion: false,
};

let layout = null;
const ui = createUI({ bus, canvas });
function rebuild() {
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  layout = computeLayout(W, H, dpr, !!view.flipped);
  view.layout = layout;
  ui.resize(layout);
}
window.addEventListener('resize', rebuild);
rebuild();

function setPhase(p) {
  view.phase = p;
  if (p === 'gameover') { view.status = view.status === 'playing' ? 'checkmate' : view.status; view.winner = view.status === 'checkmate' ? 'w' : null; }
  if (p === 'playing') { view.status = 'playing'; view.winner = null; }
}
const RESULTS = [['checkmate', 'w'], ['checkmate', 'b'], ['stalemate', null], ['draw-repetition', null], ['draw-50', null], ['draw-material', null]];
let ri = 0;

bus.on('ui:flip', () => { view.flipped = !view.flipped; rebuild(); });
bus.on('ui:mute', () => { view.muted = !view.muted; });
bus.on('ui:menu', () => { setPhase('title'); view.promotion = null; });
bus.on('ui:newGame', ({ mode, level, humanColor }) => {
  view.config = { mode, level, humanColor }; setPhase('playing'); moves = SAN.slice(0, 6).map(mkMove);
  game.history = () => moves;
});
bus.on('ui:undo', () => { moves = moves.slice(0, -1); game.history = () => moves; });
bus.on('ui:promote', () => { view.promotion = null; });
bus.on('ui:promoteCancel', () => { view.promotion = null; });

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) return;
  const k = e.key;
  if (k === '1') setPhase('title');
  else if (k === '2') setPhase('playing');
  else if (k === '3') setPhase('gameover');
  else if (k === 'p') view.promotion = view.promotion ? null : { color: 'w', from: 'e7', to: view.flipped ? 'e1' : 'e8' };
  else if (k === 't') view.thinking = !view.thinking;
  else if (k === 'b') view.busy = !view.busy;
  else if (k === 'c') view.checkSquare = view.checkSquare ? null : 'e8';
  else if (k === 'l') { ri = (ri + 1) % RESULTS.length; [view.status, view.winner] = RESULTS[ri]; }
  else if (k === 'n') { moves = SAN.slice(0, Math.min(SAN.length, moves.length + 1)).map(mkMove); game.history = () => moves; }
  else if (k === 'o') { view.turn = view.turn === 'w' ? 'b' : 'w'; }
});

// Test hooks.
window.H = {
  view, bus, log, get layout() { return layout; }, rebuild, setPhase,
  setMoves(n) { moves = SAN.slice(0, n).map(mkMove); game.history = () => moves; },
  lastSq: () => lastSq,
};

let prev = performance.now(), simT = 0, ema = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
  simT += dt; view.t = simT; view.dt = dt;
  ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = PAL.bg; ctx.fillRect(0, 0, layout.W, layout.H);
  // faint board
  const b = layout.board;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    ctx.fillStyle = (r + c) % 2 ? 'rgba(180,177,234,0.10)' : 'rgba(101,98,166,0.10)';
    ctx.fillRect(b.x + c * layout.sq, b.y + r * layout.sq, layout.sq, layout.sq);
  }
  ctx.strokeStyle = 'rgba(143,140,208,0.5)'; ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.size, b.size);
  if (lastSq) {
    const r = layout.squareRect(lastSq);
    ctx.fillStyle = 'rgba(246,207,154,0.28)'; ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  const t0 = performance.now();
  ui.update(dt, view);
  ui.draw(ctx, view);
  ema += (performance.now() - t0 - ema) * 0.05;
  window.__drawMs = ema;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const q = params.get('phase'); if (q) setPhase(q);
if (params.has('promo')) view.promotion = { color: 'w', from: 'e7', to: 'e8' };
if (params.has('status')) { view.status = params.get('status'); view.winner = view.status === 'checkmate' ? 'w' : null; }
window.addEventListener('error', (e) => { log.push({ name: 'error', p: String(e.message) }); });
