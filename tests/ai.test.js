import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/engine/chess.js';
import { searchBestMove, createAI, AICancelledError } from '../src/engine/ai.js';

const BUDGET = { 1: 150, 2: 400, 3: 1200 };
const SLACK = 40; // ms of scheduling noise allowed on a loaded test machine

function timed(fen, opts) {
  const t = performance.now();
  const m = searchBestMove(fen, opts);
  return [m, performance.now() - t];
}

function assertLegal(fen, m) {
  assert.ok(m, `a move for ${fen}`);
  const g = createGame(fen);
  const legal = g.legalMoves().find((x) => x.from === m.from && x.to === m.to && x.promotion === m.promotion);
  assert.ok(legal, `legal: ${m.from}${m.to}`);
  assert.deepEqual(m, legal, 'returns a full contract-shaped Move');
}

test('mate in 1 at every level', () => {
  const positions = [
    ['6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'Ra8#'],
    ['r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'Qxf7#'],
    ['rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2', 'Qh4#'],
  ];
  for (const [fen, san] of positions) {
    for (const level of [3, 2, 1]) {
      const reps = level === 1 ? 10 : 1;
      for (let i = 0; i < reps; i++) assert.equal(searchBestMove(fen, { level }).san, san, `level ${level} ${fen}`);
    }
  }
});

test('mate in 2 at level 3', () => {
  const cases = [
    '7k/8/8/8/8/8/R7/1R4K1 w - - 0 1',                 // rook ladder
    'r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 0', // Nf6+ gxf6 Bxf7#
  ];
  for (const fen of cases) {
    const info = {};
    const m = searchBestMove(fen, { level: 3, info });
    assertLegal(fen, m);
    // verify: after our move, every reply allows a mate in 1
    const g = createGame(fen);
    g.move(m);
    assert.notEqual(g.status(), 'stalemate');
    if (g.status() !== 'checkmate') {
      for (const r of g.legalMoves()) {
        g.move(r);
        assert.ok(g.legalMoves().some((x) => x.mate), `after ${m.san} ${r.san} there must be a mate`);
        g.undo();
      }
    }
    assert.ok(info.score > 29000, `reports a mate score (${info.score})`);
  }
});

test('captures a hanging queen and avoids losing its own', () => {
  const fen = 'rnb1kbnr/pppp1ppp/8/4p1q1/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 1';
  assert.equal(searchBestMove(fen, { level: 2 }).san, 'Bxg5');
  assert.equal(searchBestMove(fen, { level: 3 }).san, 'Bxg5');
});

test('promotion moves are returned with their piece', () => {
  const fen = '8/P6k/8/8/8/8/8/K7 w - - 0 1';
  const m = searchBestMove(fen, { level: 2 });
  assert.equal(m.san, 'a8=Q');
  assert.equal(m.promotion, 'q');
});

test('no legal move returns null; single legal move returns immediately', () => {
  assert.equal(searchBestMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', { level: 3 }), null);
  const fen = '7k/8/5K2/8/8/8/8/6R1 b - - 0 1';
  assert.equal(createGame(fen).legalMoves().length, 1);
  const [m, ms] = timed(fen, { level: 3 });
  assert.equal(m.san, 'Kh7');
  assert.ok(ms < 50);
});

test('each level stays inside its time budget', () => {
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N2N2/PP2BPPP/R2QKB1R w KQ - 0 8',
  ];
  const report = [];
  for (const level of [1, 2, 3]) {
    for (const fen of level === 3 ? fens.slice(1) : fens) {
      const info = {};
      const [m, ms] = timed(fen, { level, info });
      assertLegal(fen, m);
      assert.ok(ms <= BUDGET[level] + SLACK, `level ${level} took ${ms.toFixed(0)} ms`);
      report.push(`L${level} ${ms.toFixed(0)}ms depth ${info.depth} nodes ${info.nodes}`);
    }
  }
  console.log(report.join('\n'));
});

test('explicit timeMs is respected', () => {
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  const [m, ms] = timed(fen, { level: 3, timeMs: 100 });
  assertLegal(fen, m);
  assert.ok(ms < 100 + SLACK, `took ${ms}`);
});

test('openings vary between runs (root randomisation)', () => {
  const seen = new Set();
  for (let i = 0; i < 6; i++) seen.add(searchBestMove(createGame().fen(), { level: 2, timeMs: 80 }).san);
  for (let i = 0; i < 6; i++) seen.add(searchBestMove(createGame().fen(), { level: 1 }).san);
  assert.ok(seen.size >= 2, [...seen].join(' '));
});

test('game history lets the AI see repetitions', () => {
  // Same position reached via moves: the replayed game is used, and the result is legal.
  const g = createGame();
  for (const [from, to] of [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']]) g.move({ from, to });
  const m = searchBestMove(g.fen(), { level: 2, timeMs: 60, startFen: g._startFen, moves: g.history() });
  assertLegal(g.fen(), m);
  // Inconsistent history is ignored, not fatal.
  const m2 = searchBestMove(g.fen(), { level: 2, timeMs: 60, startFen: g._startFen, moves: [{ from: 'e2', to: 'e4' }] });
  assertLegal(g.fen(), m2);
});

test('self-play: 3 complete games, level 2 vs level 1', () => {
  const results = [];
  for (let n = 0; n < 3; n++) {
    const g = createGame();
    const twoIsWhite = n % 2 === 0;
    let plies = 0;
    while (g.status() === 'playing') {
      const level = (g.turn === 'w') === twoIsWhite ? 2 : 1;
      const fen = g.fen();
      // level 2 on a short clock keeps the test run quick; the search code path is identical
      const m = searchBestMove(fen, { level, timeMs: level === 2 ? 50 : undefined, startFen: g._startFen, moves: g.history() });
      assert.ok(m, `move at ply ${plies}`);
      const applied = g.move({ from: m.from, to: m.to, promotion: m.promotion });
      assert.ok(applied, `legal move ${m.from}${m.to} at ply ${plies} in ${fen}`);
      assert.equal(applied.san, m.san);
      plies++;
      assert.ok(plies < 600, 'game ends');
    }
    results.push(`${g.status()} after ${plies} plies, ${g.status() === 'checkmate' ? (g.turn === 'w' ? 'black' : 'white') + ' won' : ''} (L2 is ${twoIsWhite ? 'white' : 'black'})`);
  }
  console.log(results.join('\n'));
});

// ---------------------------------------------------------------- createAI (node has no Worker: fallback path)
test('createAI falls back to the main thread', async () => {
  const ai = createAI();
  const fen = createGame().fen();
  let painted = false;
  setTimeout(() => { painted = true; }, 0);
  const m = await ai.requestMove(fen, 1);
  assert.ok(painted, 'search was deferred so the UI can paint');
  assertLegal(fen, m);
  ai.dispose();
  await assert.rejects(ai.requestMove(fen, 1), AICancelledError);
});

test('createAI cancel(): pending request never settles', async () => {
  const ai = createAI();
  let settled = false;
  ai.requestMove(createGame().fen(), 1).then(() => { settled = true; }, () => { settled = true; });
  ai.cancel();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(settled, false);
  const m = await ai.requestMove(createGame().fen(), 1); // still usable after cancel
  assert.ok(m);
  ai.dispose();
});

test('createAI uses a Worker when available, and falls back when it errors', async () => {
  const saved = globalThis.Worker;
  try {
    // A fake worker that dies before answering.
    class DyingWorker {
      constructor(url, opts) {
        assert.equal(opts.type, 'module');
        assert.match(String(url), /ai\.worker\.js$/);
        setTimeout(() => this.onerror && this.onerror({ preventDefault() {} }), 5);
      }
      postMessage() {}
      terminate() {}
    }
    globalThis.Worker = DyingWorker;
    const ai = createAI();
    const fen = createGame().fen();
    assertLegal(fen, await ai.requestMove(fen, 1));
    ai.dispose();

    // A fake worker that answers via searchBestMove semantics.
    class GoodWorker {
      constructor() { GoodWorker.made++; }
      postMessage(d) {
        setTimeout(() => this.onmessage({ data: { id: d.id, move: searchBestMove(d.fen, { ...(d.extra || {}), level: d.level }) } }), 1);
      }
      terminate() {}
    }
    GoodWorker.made = 0;
    globalThis.Worker = GoodWorker;
    const ai2 = createAI();
    assertLegal(fen, await ai2.requestMove(fen, 1));
    assert.equal(GoodWorker.made, 1);
    ai2.dispose();

    // Constructor throws -> fallback.
    globalThis.Worker = class { constructor() { throw new Error('blocked'); } };
    const ai3 = createAI();
    assertLegal(fen, await ai3.requestMove(fen, 1));
    ai3.dispose();
  } finally {
    if (saved === undefined) delete globalThis.Worker; else globalThis.Worker = saved;
  }
});
