import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, Position, perft, START_FEN } from '../src/engine/chess.js';

const sans = (g, sq) => g.legalMoves(sq).map((m) => m.san).sort();
const play = (g, list) => {
  for (const s of list) {
    const m = g.legalMoves().find((x) => x.san === s || x.san.replace(/[+#]$/, '') === s);
    assert.ok(m, `move ${s} should be legal in ${g.fen()}`);
    assert.ok(g.move(m), `move ${s} should apply`);
  }
};

// ---------------------------------------------------------------- perft
const PERFT = [
  ['start', START_FEN, [20, 400, 8902, 197281, 4865609]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
];
for (const [name, fen, counts] of PERFT) {
  test(`perft ${name}`, () => {
    const pos = new Position(fen);
    counts.forEach((n, i) => assert.equal(perft(pos, i + 1), n, `${name} depth ${i + 1}`));
    assert.equal(pos.fen(), new Position(fen).fen(), 'position restored after perft');
  });
}

// ---------------------------------------------------------------- basics
test('start position basics', () => {
  const g = createGame();
  assert.equal(g.turn, 'w');
  assert.equal(g.fen(), START_FEN);
  assert.equal(g.legalMoves().length, 20);
  assert.deepEqual(g.get('e1'), { type: 'k', color: 'w' });
  assert.equal(g.get('e4'), null);
  const b = g.board();
  assert.deepEqual(b[0][0], { type: 'r', color: 'b' }); // a8
  assert.deepEqual(b[7][4], { type: 'k', color: 'w' }); // e1
  assert.equal(g.kingSquare('w'), 'e1');
  assert.equal(g.kingSquare('b'), 'e8');
  assert.equal(g.status(), 'playing');
  assert.equal(g.inCheck(), false);
  assert.deepEqual(sans(g, 'g1'), ['Nf3', 'Nh3']);
});

test('illegal input returns null', () => {
  const g = createGame();
  assert.equal(g.move({ from: 'e2', to: 'e5' }), null);
  assert.equal(g.move({ from: 'e7', to: 'e5' }), null); // wrong side
  assert.equal(g.move({ from: 'z9', to: 'e4' }), null);
  assert.equal(g.move(null), null);
  assert.equal(g.undo(), null);
  assert.equal(g.fen(), START_FEN);
  // pinned piece cannot move
  const p = createGame('4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1');
  assert.equal(p.legalMoves('e2').length, 0);
  assert.equal(p.move({ from: 'e2', to: 'c3' }), null);
});

test('bad FEN throws', () => {
  assert.throws(() => createGame('nonsense'));
  assert.throws(() => createGame('8/8/8/8/8/8/8/8 w - - 0 1')); // no kings
  assert.throws(() => createGame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1'));
});

test('FEN round-trip', () => {
  const fens = [
    START_FEN,
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3',
    '4k3/8/8/8/8/8/8/4K2R b K - 37 80',
  ];
  for (const f of fens) assert.equal(createGame(f).fen(), f);
});

// ---------------------------------------------------------------- Move objects + SAN
test('move object fields: plain, capture, double', () => {
  const g = createGame();
  const m = g.move({ from: 'e2', to: 'e4' });
  assert.deepEqual(m, { from: 'e2', to: 'e4', piece: 'p', color: 'w', double: true, check: false, mate: false, san: 'e4' });
  play(g, ['d5']);
  const c = g.move({ from: 'e4', to: 'd5' });
  assert.equal(c.san, 'exd5');
  assert.equal(c.captured, 'p');
  assert.equal(c.capturedSquare, 'd5');
  assert.equal(g.history().length, 3);
});

test('en passant', () => {
  const g = createGame();
  play(g, ['e4', 'a6', 'e5', 'd5']);
  assert.match(g.fen(), / d6 /);
  const m = g.move({ from: 'e5', to: 'd6' });
  assert.equal(m.san, 'exd6');
  assert.equal(m.enPassant, true);
  assert.equal(m.captured, 'p');
  assert.equal(m.capturedSquare, 'd5');
  assert.equal(g.get('d5'), null);
  g.undo();
  assert.deepEqual(g.get('d5'), { type: 'p', color: 'b' });
  // the right is lost after one move
  play(g, ['Nf3', 'Nf6']);
  assert.equal(g.move({ from: 'e5', to: 'd6' }), null);
});

test('en passant: horizontal pin and FEN ep normalisation', () => {
  const g = createGame('8/8/8/8/k2Pp2Q/8/8/3K4 b - d3 0 1');
  assert.equal(g.legalMoves('e4').some((m) => m.to === 'd3'), false);
  assert.equal(g.fen(), '8/8/8/8/k2Pp2Q/8/8/3K4 b - - 0 1');
  // without the pin the capture is legal
  const h = createGame('8/8/8/8/3Pp3/8/k7/3K4 b - d3 0 1');
  assert.equal(h.legalMoves('e4').some((m) => m.to === 'd3' && m.enPassant), true);
  assert.equal(h.fen(), '8/8/8/8/3Pp3/8/k7/3K4 b - d3 0 1');
  // ep square with no capturer is dropped
  assert.equal(createGame('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1').fen(),
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
});

test('SAN disambiguation', () => {
  assert.deepEqual(sans(createGame('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1')).filter((s) => s.startsWith('N') && s.endsWith('d2')), ['Nbd2', 'Nfd2']);
  assert.deepEqual(sans(createGame('4k3/8/8/R7/8/8/8/R3K3 w - - 0 1')).filter((s) => s.endsWith('a3')), ['R1a3', 'R5a3']);
  const q = sans(createGame('4k3/8/8/8/8/Q7/8/Q1Q1K3 w - - 0 1')).filter((s) => s.endsWith('b2'));
  assert.deepEqual(q, ['Q3b2', 'Qa1b2', 'Qcb2']);
  // a pinned knight does not force disambiguation (Ne2 is pinned by the e7 rook)
  const p = sans(createGame('4k3/4r3/8/1N6/8/8/4N3/4K3 w - - 0 1'));
  assert.ok(p.includes('Nd4') && p.includes('Nc3'), p.join(' '));
  const u = sans(createGame('4k3/8/8/1N6/8/8/4N3/4K3 w - - 0 1'));
  assert.ok(u.includes('Nbd4') && u.includes('Ned4') && u.includes('Nbc3') && u.includes('Nec3'), u.join(' '));
  // captures with disambiguation
  const c = sans(createGame('4k3/8/8/3p4/8/2N1N3/8/4K3 w - - 0 1'));
  assert.ok(c.includes('Ncxd5') && c.includes('Nexd5'));
});

test('SAN castling, promotion, check and mate suffixes', () => {
  const g = createGame('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const oo = g.move({ from: 'e1', to: 'g1' });
  assert.equal(oo.san, 'O-O');
  assert.equal(oo.castle, 'k');
  assert.equal(oo.rookFrom, 'h1');
  assert.equal(oo.rookTo, 'f1');
  assert.deepEqual(g.get('f1'), { type: 'r', color: 'w' });
  const ooo = g.move({ from: 'e8', to: 'c8' });
  assert.equal(ooo.san, 'O-O-O');
  assert.equal(ooo.castle, 'q');
  assert.equal(ooo.rookFrom, 'a8');
  assert.equal(ooo.rookTo, 'd8');

  const pr = createGame('2k5/4P3/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(pr.move({ from: 'e7', to: 'e8' }), null, 'promotion requires a piece');
  const pm = pr.move({ from: 'e7', to: 'e8', promotion: 'q' });
  assert.equal(pm.san, 'e8=Q+');
  assert.equal(pm.promotion, 'q');
  assert.equal(pm.check, true);
  assert.equal(pm.mate, false);
  assert.deepEqual(pr.get('e8'), { type: 'q', color: 'w' });
  pr.undo();
  assert.equal(pr.move({ from: 'e7', to: 'e8', promotion: 'n' }).san, 'e8=N');
  pr.undo();
  assert.equal(pr.legalMoves('e7').length, 4);

  const mate = createGame('k7/4P3/1K6/8/8/8/8/8 w - - 0 1');
  const mm = mate.move({ from: 'e7', to: 'e8', promotion: 'r' });
  assert.equal(mm.san, 'e8=R#');
  assert.equal(mm.mate, true);
  assert.equal(mate.status(), 'checkmate');

  const cp = createGame('2r1k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(cp.move({ from: 'b7', to: 'c8', promotion: 'q' }).san, 'bxc8=Q+');

  const s = createGame();
  play(s, ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']);
  const qm = s.move({ from: 'h5', to: 'f7' });
  assert.equal(qm.san, 'Qxf7#');
  assert.equal(qm.check && qm.mate, true);
  assert.equal(s.status(), 'checkmate');
  assert.equal(s.inCheck(), true);
  assert.equal(s.legalMoves().length, 0);
});

// ---------------------------------------------------------------- castling rules
test('castling legality', () => {
  const can = (fen) => sans(createGame(fen)).filter((s) => s.startsWith('O-O'));
  assert.deepEqual(can('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'), ['O-O', 'O-O-O']);
  assert.deepEqual(can('r3kr2/8/8/8/8/8/8/R3K2R w KQq - 0 1'), ['O-O-O'], 'not through check');
  assert.deepEqual(can('4k1r1/8/8/8/8/8/8/R3K2R w KQ - 0 1'), ['O-O-O'], 'not into check');
  assert.deepEqual(can('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1'), [], 'not out of check');
  assert.deepEqual(can('1r2k3/8/8/8/8/8/8/R3K2R w KQ - 0 1'), ['O-O', 'O-O-O'], 'b1 attacked is fine');
  assert.deepEqual(can('4k3/8/8/8/8/8/8/RN2K1NR w KQ - 0 1'), [], 'blocked');

  const g = createGame('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  g.move({ from: 'a1', to: 'a8' });
  assert.equal(g.fen().split(' ')[2], 'Kk', 'rook capture removes both sides\' a-file rights');
  g.undo();
  g.move({ from: 'h1', to: 'h2' });
  assert.equal(g.fen().split(' ')[2], 'Qkq');
  g.undo();
  g.move({ from: 'e1', to: 'e2' });
  assert.equal(g.fen().split(' ')[2], 'kq');
  g.move({ from: 'e8', to: 'e7' });
  g.move({ from: 'e2', to: 'e1' });
  g.move({ from: 'e7', to: 'e8' });
  assert.equal(g.fen().split(' ')[2], '-');
  assert.deepEqual(sans(g).filter((s) => s.startsWith('O-O')), []);
});

// ---------------------------------------------------------------- end states
test('stalemate', () => {
  const g = createGame('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(g.inCheck(), false);
  assert.equal(g.status(), 'stalemate');
  const h = createGame('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1');
  const m = h.move({ from: 'f1', to: 'f7' });
  assert.equal(m.check, false);
  assert.equal(m.mate, false);
  assert.equal(h.status(), 'stalemate');
});

test('fifty-move rule', () => {
  const g = createGame('4k3/8/8/8/8/8/8/R3K3 w - - 99 80');
  assert.equal(g.status(), 'playing');
  g.move({ from: 'a1', to: 'a2' });
  assert.equal(g.status(), 'draw-50');
  g.undo();
  assert.equal(g.status(), 'playing');
  g.move({ from: 'a1', to: 'a8' }); // check, but not mate: still a draw by the 50-move rule
  assert.equal(g.status(), 'draw-50');
  // a mate on the 100th half-move is a mate
  const m = createGame('4k3/R7/8/4K3/8/8/8/8 w - - 99 80');
  assert.equal(m.status(), 'playing');
  const mm = createGame('6k1/8/6K1/8/8/8/8/R7 w - - 99 80');
  mm.move({ from: 'a1', to: 'a8' });
  assert.equal(mm.status(), 'checkmate');
  // a pawn move resets the clock
  const p = createGame('4k3/8/8/8/8/8/P7/4K3 w - - 99 80');
  p.move({ from: 'a2', to: 'a3' });
  assert.equal(p.status(), 'playing');
  assert.equal(p.fen(), '4k3/8/8/8/8/P7/8/4K3 b - - 0 80');
});

test('threefold repetition, and undo restores history', () => {
  const g = createGame();
  const shuffle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
  play(g, shuffle);
  assert.equal(g.status(), 'playing'); // twice
  play(g, shuffle.slice(0, 3));
  assert.equal(g.status(), 'playing');
  play(g, ['Ng8']);
  assert.equal(g.status(), 'draw-repetition'); // start position, third time
  g.undo();
  assert.equal(g.status(), 'playing');
  play(g, ['Ng8']);
  assert.equal(g.status(), 'draw-repetition');
});

test('repetition: castling rights and en passant are part of the position', () => {
  // Same placement but castling rights lost: does not count as the same position.
  const g = createGame('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  play(g, ['Kf1', 'Kf8', 'Ke1', 'Ke8', 'Kf1', 'Kf8', 'Ke1', 'Ke8']);
  assert.equal(g.status(), 'playing', 'initial position had castling rights, so only two repetitions');
  play(g, ['Kf1', 'Kf8', 'Ke1', 'Ke8']);
  assert.equal(g.status(), 'draw-repetition');

  // e.p. square only matters when the capture is legal.
  const pinned = new Position('8/8/8/8/k2Pp2Q/8/8/3K4 b - d3 0 1').repetitionKey();
  const pinnedNoEp = new Position('8/8/8/8/k2Pp2Q/8/8/3K4 b - - 0 1').repetitionKey();
  assert.equal(pinned, pinnedNoEp);
  const free = new Position('8/8/8/8/3Pp3/8/k7/3K4 b - d3 0 1').repetitionKey();
  const freeNoEp = new Position('8/8/8/8/3Pp3/8/k7/3K4 b - - 0 1').repetitionKey();
  assert.notEqual(free, freeNoEp);

  // A double push whose e.p. capture is illegal still repeats the later identical position.
  const h = createGame('8/8/8/8/k3p2Q/8/3P4/3K4 w - - 0 1');
  play(h, ['d4']);               // (A) black to move, ep illegal (pin)
  play(h, ['Kb4', 'Qh5', 'Ka4', 'Qh4']); // back to (A) without ep square
  play(h, ['Kb4', 'Qh5', 'Ka4', 'Qh4']);
  assert.equal(h.status(), 'draw-repetition');
});

test('insufficient material', () => {
  const st = (f) => createGame(f).status();
  assert.equal(st('4k3/8/8/8/8/8/8/4K3 w - - 0 1'), 'draw-material');
  assert.equal(st('4k3/8/8/8/8/8/8/4KN2 w - - 0 1'), 'draw-material');
  assert.equal(st('4k3/8/8/8/8/8/8/4KB2 w - - 0 1'), 'draw-material');
  assert.equal(st('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1'), 'draw-material'); // c1 & f8 both dark
  assert.equal(st('2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1'), 'playing');      // c1 dark, c8 light
  assert.equal(st('4k3/8/8/8/8/8/8/3NKN2 w - - 0 1'), 'playing');
  assert.equal(st('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'), 'playing');
  assert.equal(st('4kn2/8/8/8/8/8/8/4KB2 w - - 0 1'), 'playing');
  // capture into insufficient material
  const g = createGame('4k3/8/8/8/8/8/4r3/4KR2 w - - 0 1');
  g.move({ from: 'e1', to: 'e2' });
  assert.equal(g.status(), 'playing');
  const h = createGame('4k3/8/8/8/8/8/4r3/4K1N1 w - - 0 1');
  h.move({ from: 'e1', to: 'e2' });
  assert.equal(h.status(), 'draw-material');
});

// ---------------------------------------------------------------- undo round trips
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('undo round-trips across random playouts', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const r = rng(seed);
    const g = createGame();
    const fens = [g.fen()];
    const statuses = [g.status()];
    for (let ply = 0; ply < 250 && g.status() === 'playing'; ply++) {
      const moves = g.legalMoves();
      const pick = moves[Math.floor(r() * moves.length)];
      const before = g.fen();
      const m = g.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
      assert.deepEqual(m, pick);
      const after = g.fen();
      assert.deepEqual(g.undo(), pick);
      assert.equal(g.fen(), before);
      g.move(pick);
      assert.equal(g.fen(), after);
      fens.push(after);
      statuses.push(g.status());
    }
    const hist = g.history();
    assert.equal(hist.length, fens.length - 1);
    for (let i = fens.length - 1; i > 0; i--) {
      assert.equal(g.fen(), fens[i]);
      assert.equal(g.status(), statuses[i]);
      g.undo();
    }
    assert.equal(g.fen(), START_FEN);
    assert.equal(g.history().length, 0);
  }
});

test('legal moves agree with perft generator and SAN is unique', () => {
  const r = rng(99);
  const g = createGame('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  for (let i = 0; i < 60 && g.status() === 'playing'; i++) {
    const moves = g.legalMoves();
    assert.equal(moves.length, perft(g._pos, 1));
    assert.equal(new Set(moves.map((m) => m.san)).size, moves.length);
    for (const m of moves) {
      g.move(m);
      assert.equal(m.check, g.inCheck());
      assert.equal(m.mate, g.status() === 'checkmate');
      g.undo();
    }
    g.move(moves[Math.floor(r() * moves.length)]);
  }
});
