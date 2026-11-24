// Computer opponent.  Searches directly on chess.js's Position (0x88 board,
// integer moves, make/unmake) — no Move objects are allocated per node.
//
//   searchBestMove(fen, { level, timeMs?, startFen?, moves?, info? }) -> Move | null   (synchronous)
//   createAI() -> { requestMove(fen, level, extra?) -> Promise<Move>, cancel(), dispose() }
//
// Levels:
//   1 novice — depth-2 alpha-beta + quiescence, material/PST eval, heavy root
//              noise (occasional blunders), but always plays a mate-in-1.
//   2 adept  — iterative deepening, PVS alpha-beta, quiescence, MVV-LVA +
//              killer ordering, eval with pawn structure; ~400 ms.
//   3 master — level 2 plus transposition table, history heuristic, null-move
//              pruning, late-move reductions, mobility + king-safety eval; ~1200 ms.

import {
  createGame, Position,
  WHITE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  F_CAPTURE, F_EP,
  mFrom, mTo, mPromo, mFlags, sqToName,
} from './chess.js';

const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();

const INF = 32000, MATE = 31000, MATE_BOUND = 30000;
const MAX_PLY = 96;

export const LEVELS = {
  1: { name: 'novice', timeMs: 120, maxDepth: 2, noise: 70, blunderChance: 0.15, blunderNoise: 220, tt: false, nullMove: false, lmr: false, history: false, evalFull: false, pawnEval: false, jitter: 0 },
  2: { name: 'adept', timeMs: 400, maxDepth: 64, noise: 0, tt: false, nullMove: false, lmr: false, history: false, evalFull: false, pawnEval: true, jitter: 12 },
  3: { name: 'master', timeMs: 1200, maxDepth: 64, noise: 0, tt: true, nullMove: true, lmr: true, history: true, evalFull: true, pawnEval: true, jitter: 8 },
};

// ---------------------------------------------------------------------------
// Evaluation

const VAL = [0, 100, 320, 330, 500, 900, 0];
const PHASE_W = [0, 0, 1, 1, 2, 4, 0];

// Piece-square tables, written from White's view with a8 first (index = (7-rank)*8+file).
const PST_SRC = {
  [PAWN]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0],
  [KNIGHT]: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50],
  [BISHOP]: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20],
  [ROOK]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0],
  [QUEEN]: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20],
  [KING]: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20],
};
const KING_EG_SRC = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50];

// Tables indexed [piece code (type | color<<3)][0x88 square], values from that piece's own view.
const PST_MG = [], PST_EG = [];
for (let pc = 0; pc < 16; pc++) { PST_MG.push(new Int16Array(128)); PST_EG.push(new Int16Array(128)); }
for (let t = PAWN; t <= KING; t++) {
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const wi = (7 - r) * 8 + f, bi = r * 8 + f, sq = r * 16 + f;
    const mgW = PST_SRC[t][wi], mgB = PST_SRC[t][bi];
    let egW = mgW, egB = mgB;
    if (t === KING) { egW = KING_EG_SRC[wi]; egB = KING_EG_SRC[bi]; }
    if (t === PAWN) { egW = (r) * 8; egB = (7 - r) * 8; }  // advance in the endgame
    PST_MG[t][sq] = VAL[t] + mgW; PST_EG[t][sq] = VAL[t] + egW;
    PST_MG[t | 8][sq] = VAL[t] + mgB; PST_EG[t | 8][sq] = VAL[t] + egB;
  }
}
const PASSED = [0, 5, 10, 20, 35, 60, 100, 0];
const KNIGHT_OFF = [33, 31, 18, 14, -33, -31, -18, -14];
const BISHOP_OFF = [17, 15, -17, -15];
const ROOK_OFF = [1, -1, 16, -16];
const KING_OFF = [1, -1, 16, -16, 17, 15, -17, -15];

// scratch arrays for pawn structure: per colour, per file (index 1..8; 0 and 9 are sentinels)
const pawnCnt = [new Int8Array(10), new Int8Array(10)];
const pawnMinR = [new Int8Array(10), new Int8Array(10)];
const pawnMaxR = [new Int8Array(10), new Int8Array(10)];

// Static evaluation from the side to move's point of view (centipawns).
export function evaluate(pos, cfg = LEVELS[3]) {
  const b = pos.board;
  let mg0 = 0, mg1 = 0, eg0 = 0, eg1 = 0, phase = 0;
  let bish0 = 0, bish1 = 0;
  const full = cfg.evalFull, pawns = cfg.pawnEval;
  if (pawns) {
    for (let c = 0; c < 2; c++) { pawnCnt[c].fill(0); pawnMinR[c].fill(8); pawnMaxR[c].fill(-1); }
  }
  let mob0 = 0, mob1 = 0;
  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (!p) continue;
    const t = p & 7, c = p >> 3;
    phase += PHASE_W[t];
    if (c === 0) { mg0 += PST_MG[p][sq]; eg0 += PST_EG[p][sq]; }
    else { mg1 += PST_MG[p][sq]; eg1 += PST_EG[p][sq]; }
    if (t === PAWN) {
      if (pawns) {
        const f = (sq & 7) + 1, r = sq >> 4;
        pawnCnt[c][f]++;
        if (r < pawnMinR[c][f]) pawnMinR[c][f] = r;
        if (r > pawnMaxR[c][f]) pawnMaxR[c][f] = r;
      }
    } else if (t === BISHOP) { if (c) bish1++; else bish0++; }
    if (full && t >= KNIGHT && t <= QUEEN) {
      // mobility: pseudo-legal destination squares not occupied by own pieces
      let cnt = 0;
      if (t === KNIGHT) {
        for (let i = 0; i < 8; i++) {
          const to = sq + KNIGHT_OFF[i];
          if (!(to & 0x88) && (!b[to] || (b[to] >> 3) !== c)) cnt++;
        }
        cnt = (cnt - 4) * 4;
      } else {
        const offs = t === BISHOP ? BISHOP_OFF : t === ROOK ? ROOK_OFF : KING_OFF;
        for (let i = 0; i < offs.length; i++) {
          const d = offs[i];
          let to = sq + d;
          while (!(to & 0x88)) {
            const q = b[to];
            if (q) { if ((q >> 3) !== c) cnt++; break; }
            cnt++; to += d;
          }
        }
        cnt = t === BISHOP ? (cnt - 6) * 4 : t === ROOK ? (cnt - 7) * 2 : (cnt - 13);
      }
      if (c) mob1 += cnt; else mob0 += cnt;
    }
  }
  if (bish0 >= 2) { mg0 += 30; eg0 += 50; }
  if (bish1 >= 2) { mg1 += 30; eg1 += 50; }
  if (full) { mg0 += mob0; eg0 += mob0; mg1 += mob1; eg1 += mob1; }

  if (pawns) {
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (!p) continue;
      const t = p & 7, c = p >> 3, f = (sq & 7) + 1, r = sq >> 4;
      if (t === PAWN) {
        const o = c ^ 1;
        let passed;
        if (c === 0) passed = pawnMaxR[1][f - 1] <= r && pawnMaxR[1][f] <= r && pawnMaxR[1][f + 1] <= r;
        else passed = pawnMinR[0][f - 1] >= r && pawnMinR[0][f] >= r && pawnMinR[0][f + 1] >= r;
        let smg = 0, seg = 0;
        if (passed) {
          const rr = c === 0 ? r : 7 - r;
          smg += PASSED[rr] >> 1; seg += PASSED[rr];
          // blocked passer is worth less
          const front = sq + (c === 0 ? 16 : -16);
          if (b[front]) seg -= PASSED[rr] >> 2;
        }
        if (!pawnCnt[c][f - 1] && !pawnCnt[c][f + 1]) { smg -= 12; seg -= 15; }
        if (pawnCnt[c][f] > 1) { smg -= 6; seg -= 10; } // per pawn on a doubled file
        void o;
        if (c) { mg1 += smg; eg1 += seg; } else { mg0 += smg; eg0 += seg; }
      } else if (t === ROOK) {
        const own = pawnCnt[c][f], opp = pawnCnt[c ^ 1][f];
        const bonus = own ? 0 : opp ? 10 : 20;
        if (c) { mg1 += bonus; eg1 += bonus >> 1; } else { mg0 += bonus; eg0 += bonus >> 1; }
      }
    }
  }

  if (full) {
    // king safety: pawn shield in front of a castled king (middlegame term)
    for (let c = 0; c < 2; c++) {
      const k = pos.kings[c];
      const kr = k >> 4, kf = k & 7;
      const home = c === 0 ? kr <= 1 : kr >= 6;
      let pen = 0;
      if (home && (kf <= 2 || kf >= 5)) {
        const dir = c === 0 ? 16 : -16;
        const pawn = PAWN | (c << 3);
        for (let df = -1; df <= 1; df++) {
          const ff = kf + df;
          if (ff < 0 || ff > 7) continue;
          const s1 = k + df + dir, s2 = s1 + dir;
          if (b[s1] === pawn) continue;
          if (!(s2 & 0x88) && b[s2] === pawn) pen += 8; else pen += 20;
        }
      } else if (!home) pen += 15;
      if (c) mg1 -= pen; else mg0 -= pen;
    }
  }

  if (phase > 24) phase = 24;
  const mg = mg0 - mg1, eg = eg0 - eg1;
  let score = ((mg * phase + eg * (24 - phase)) / 24) | 0;
  score = pos.side === WHITE ? score : -score;
  return score + 10; // tempo
}

// ---------------------------------------------------------------------------
// Transposition table (module-level so it survives between calls in a worker)

const TT_BITS = 20, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
let ttKey = null, ttMove, ttScore, ttDepth, ttFlag;
const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
function ensureTT() {
  if (ttKey) return;
  ttKey = new Int32Array(TT_SIZE); ttMove = new Int32Array(TT_SIZE);
  ttScore = new Int16Array(TT_SIZE); ttDepth = new Int8Array(TT_SIZE); ttFlag = new Int8Array(TT_SIZE);
}

// ---------------------------------------------------------------------------
// Search

class Searcher {
  constructor(pos, cfg, deadline, rand) {
    this.pos = pos; this.cfg = cfg; this.deadline = deadline; this.rand = rand;
    this.nodes = 0; this.stop = false;
    this.moves = []; this.scores = [];
    for (let i = 0; i < MAX_PLY + 1; i++) { this.moves.push(new Int32Array(256)); this.scores.push(new Int32Array(256)); }
    this.killers = new Int32Array(MAX_PLY * 2);
    this.hist = new Int32Array(16 * 128);
    this.useTT = cfg.tt;
    if (this.useTT) ensureTT();
    this.selDepth = 0;
  }

  tick() {
    if ((++this.nodes & 1023) === 0 && now() > this.deadline) this.stop = true;
  }

  // Score moves for ordering.
  orderScores(list, scores, n, ply, ttm) {
    const b = this.pos.board;
    const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
    const useHist = this.cfg.history;
    for (let i = 0; i < n; i++) {
      const m = list[i];
      if (m === ttm) { scores[i] = 1 << 30; continue; }
      const fl = m >>> 17, to = (m >> 7) & 127, from = m & 127;
      const promo = (m >> 14) & 7;
      let s = 0;
      if (fl & F_CAPTURE) {
        const victim = fl & F_EP ? PAWN : b[to] & 7;
        s = 1000000 + VAL[victim] * 10 - (b[from] & 7);
      } else if (m === k1) s = 900000;
      else if (m === k2) s = 800000;
      else if (useHist) s = this.hist[b[from] * 128 + to];
      if (promo) s += promo === QUEEN ? 1100000 : -500000;
      scores[i] = s;
    }
  }

  static pick(list, scores, i, n) {
    let bi = i, bs = scores[i];
    for (let j = i + 1; j < n; j++) if (scores[j] > bs) { bs = scores[j]; bi = j; }
    if (bi !== i) {
      const tm = list[i]; list[i] = list[bi]; list[bi] = tm;
      const ts = scores[i]; scores[i] = scores[bi]; scores[bi] = ts;
    }
    return list[i];
  }

  quiesce(alpha, beta, ply) {
    this.tick();
    if (this.stop) return 0;
    const pos = this.pos;
    const stand = evaluate(pos, this.cfg);
    if (ply >= MAX_PLY) return stand;
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const list = this.moves[ply], scores = this.scores[ply];
    const n = pos.gen(list, 0, true);
    this.orderScores(list, scores, n, ply, 0);
    const b = pos.board;
    for (let i = 0; i < n; i++) {
      const m = Searcher.pick(list, scores, i, n);
      const fl = m >>> 17;
      if (!((m >> 14) & 7)) {
        const victim = fl & F_EP ? PAWN : b[(m >> 7) & 127] & 7;
        if (stand + VAL[victim] + 200 < alpha) continue; // delta pruning
      }
      if (!pos.make(m)) continue;
      const s = -this.quiesce(-beta, -alpha, ply + 1);
      pos.unmake(m);
      if (this.stop) return 0;
      if (s > alpha) {
        alpha = s;
        if (s >= beta) return s;
      }
    }
    return alpha;
  }

  search(depth, alpha, beta, ply, nullOk) {
    this.tick();
    if (this.stop) return 0;
    const pos = this.pos, cfg = this.cfg;
    if (pos.half >= 100 || pos.isRepetition()) return 0;
    // mate distance pruning
    const ma = -MATE + ply, mb = MATE - ply - 1;
    if (ma > alpha) { alpha = ma; if (alpha >= beta) return alpha; }
    if (mb < beta) { beta = mb; if (alpha >= beta) return beta; }

    const us = pos.side;
    const inCheck = pos.attacked(pos.kings[us], us ^ 1);
    if (inCheck) depth++;
    if (depth <= 0) return this.quiesce(alpha, beta, ply);
    if (ply >= MAX_PLY) return evaluate(pos, cfg);

    const pvNode = beta - alpha > 1;
    let ttm = 0, idx = 0;
    if (this.useTT) {
      idx = pos.lo & TT_MASK;
      if (ttKey[idx] === pos.hi) {
        ttm = ttMove[idx];
        if (ttDepth[idx] >= depth && !pvNode) {
          let s = ttScore[idx];
          if (s > MATE_BOUND) s -= ply; else if (s < -MATE_BOUND) s += ply;
          const f = ttFlag[idx];
          if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
        }
      }
    }

    if (cfg.nullMove && nullOk && !inCheck && !pvNode && depth >= 3 && Math.abs(beta) < MATE_BOUND &&
        pos.hasNonPawn(us) && evaluate(pos, cfg) >= beta) {
      const r = depth > 6 ? 3 : 2;
      pos.makeNull();
      const s = -this.search(depth - 1 - r, -beta, -beta + 1, ply + 1, false);
      pos.unmakeNull();
      if (this.stop) return 0;
      if (s >= beta) return s >= MATE_BOUND ? beta : s;
    }

    const list = this.moves[ply], scores = this.scores[ply];
    const n = pos.gen(list, 0, false);
    this.orderScores(list, scores, n, ply, ttm);
    const origAlpha = alpha;
    let best = -INF, bestMove = 0, legal = 0;
    const b = pos.board;
    for (let i = 0; i < n; i++) {
      const m = Searcher.pick(list, scores, i, n);
      const fl = m >>> 17;
      const quiet = !(fl & F_CAPTURE) && !((m >> 14) & 7);
      const moverCode = b[m & 127];
      if (!pos.make(m)) continue;
      legal++;
      let s;
      if (legal === 1) {
        s = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        let red = 0;
        if (cfg.lmr && depth >= 3 && legal > 3 && quiet && !inCheck &&
            m !== this.killers[ply * 2] && m !== this.killers[ply * 2 + 1] &&
            !pos.attacked(pos.kings[pos.side], pos.side ^ 1)) {
          red = legal > 8 && depth > 5 ? 2 : 1;
        }
        s = -this.search(depth - 1 - red, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && red) s = -this.search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && s < beta) s = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
      }
      pos.unmake(m);
      if (this.stop) return 0;
      if (s > best) {
        best = s; bestMove = m;
        if (s > alpha) {
          alpha = s;
          if (s >= beta) {
            if (quiet) {
              if (this.killers[ply * 2] !== m) { this.killers[ply * 2 + 1] = this.killers[ply * 2]; this.killers[ply * 2] = m; }
              if (cfg.history) {
                const hi = moverCode * 128 + ((m >> 7) & 127);
                this.hist[hi] += depth * depth;
                if (this.hist[hi] > 800000) for (let k = 0; k < this.hist.length; k++) this.hist[k] >>= 1;
              }
            }
            break;
          }
        }
      }
    }
    if (!legal) return inCheck ? -MATE + ply : 0;

    if (this.useTT) {
      let s = best;
      if (s > MATE_BOUND) s += ply; else if (s < -MATE_BOUND) s -= ply;
      ttKey[idx] = pos.hi; ttMove[idx] = bestMove; ttScore[idx] = s;
      ttDepth[idx] = depth > 127 ? 127 : depth;
      ttFlag[idx] = best >= beta ? TT_LOWER : best > origAlpha ? TT_EXACT : TT_UPPER;
    }
    return best;
  }
}

// Mate-in-1 for the side to move, or 0.
function findMateInOne(pos, rootMoves) {
  for (const m of rootMoves) {
    pos.make(m);
    const mate = pos.inCheck() && !pos.hasLegalMove();
    pos.unmake(m);
    if (mate) return m;
  }
  return 0;
}

function seededRandom() {
  let a = (Math.random() * 4294967296) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sameSetup(a, b) {
  return a.split(' ').slice(0, 4).join(' ') === b.split(' ').slice(0, 4).join(' ');
}

// Set up the root game: from `fen`, or by replaying `moves` from `startFen`
// (which gives the search the game's repetition history).
function setupGame(fen, opts) {
  const target = createGame(fen);
  if (opts && opts.startFen && Array.isArray(opts.moves)) {
    try {
      const g = createGame(opts.startFen);
      let ok = true;
      for (const mv of opts.moves) if (!g.move(mv)) { ok = false; break; }
      if (ok && sameSetup(g.fen(), target.fen())) return g;
    } catch { /* fall through to plain fen */ }
  }
  return target;
}

export function searchBestMove(fen, opts = {}) {
  const t0 = now();
  const level = Math.min(3, Math.max(1, (opts.level | 0) || 2));
  const cfg = LEVELS[level];
  const budget = opts.timeMs > 0 ? opts.timeMs : cfg.timeMs;
  const deadline = t0 + Math.max(5, budget - 8);
  const rand = typeof opts.random === 'function' ? opts.random : seededRandom();

  const game = setupGame(fen, opts);
  const pos = game._pos;
  const info = { level, depth: 0, nodes: 0, score: 0, timeMs: 0, pv: null };
  const finish = (m) => {
    info.timeMs = now() - t0;
    if (opts.info && typeof opts.info === 'object') Object.assign(opts.info, info);
    if (!m) return null;
    const from = sqToName(mFrom(m)), to = sqToName(mTo(m));
    const promo = mPromo(m);
    const obj = game.legalMoves(from).find((o) => o.to === to && (!promo || o.promotion === ' pnbrqk'[promo]));
    return obj || null;
  };

  const root = pos.legalMoves();
  if (!root.length) return finish(0);
  if (root.length === 1) { info.depth = 1; return finish(root[0]); }
  const mate1 = findMateInOne(pos, root);
  if (mate1) { info.depth = 1; info.score = MATE - 1; return finish(mate1); }

  const S = new Searcher(pos, cfg, deadline, rand);

  // Root ordering: captures/promotions first.
  {
    const sc = new Int32Array(root.length), lst = Int32Array.from(root);
    S.orderScores(lst, sc, lst.length, 0, 0);
    const idx = root.map((_, i) => i).sort((a, b) => sc[b] - sc[a]);
    const copy = idx.map((i) => lst[i]);
    for (let i = 0; i < copy.length; i++) root[i] = copy[i];
  }

  if (level === 1) {
    // Shallow, noisy search.
    const amp = rand() < cfg.blunderChance ? cfg.blunderNoise : cfg.noise;
    let best = root[0], bestS = -INF;
    for (const m of root) {
      pos.make(m);
      let s = -S.search(cfg.maxDepth - 1, -INF, INF, 1, false);
      pos.unmake(m);
      if (S.stop) break;
      if (Math.abs(s) < MATE_BOUND) s += Math.round((rand() * 2 - 1) * amp);
      if (s > bestS) { bestS = s; best = m; }
    }
    info.depth = cfg.maxDepth; info.nodes = S.nodes; info.score = bestS;
    return finish(best);
  }

  // Root jitter: early in the game, near-equal moves get a small random bonus.
  const plyNo = (pos.full - 1) * 2 + pos.side;
  const jitter = new Map();
  if (cfg.jitter && plyNo < 12) for (const m of root) jitter.set(m, Math.round(rand() * cfg.jitter));

  let best = root[0], bestScore = 0;
  for (let depth = 1; depth <= cfg.maxDepth; depth++) {
    // depth 1 always completes, so there is always a searched move to return
    S.deadline = depth === 1 ? Infinity : deadline;
    let alpha = -INF;
    const beta = INF;
    let iterBest = 0, iterScore = -INF;
    for (let i = 0; i < root.length; i++) {
      const m = root[i];
      const j = jitter.get(m) || 0;
      pos.make(m);
      let s;
      const a = alpha - j;
      if (i === 0) s = -S.search(depth - 1, -beta, -a, 1, true);
      else {
        s = -S.search(depth - 1, -a - 1, -a, 1, true);
        if (!S.stop && s > a) s = -S.search(depth - 1, -beta, -a, 1, true);
      }
      pos.unmake(m);
      if (S.stop && depth > 1) break;
      if (Math.abs(s) < MATE_BOUND) s += j;
      if (s > iterScore) { iterScore = s; iterBest = m; if (s > alpha) alpha = s; }
    }
    if (iterBest) {
      best = iterBest; bestScore = iterScore;
      const k = root.indexOf(iterBest);
      if (k > 0) { root.splice(k, 1); root.unshift(iterBest); }
    }
    if (S.stop) break;
    info.depth = depth;
    if (Math.abs(bestScore) > MATE_BOUND) break;                   // forced mate found
    if (now() - t0 > (deadline - t0) * 0.55) break;                // next iteration would not finish
  }
  info.nodes = S.nodes; info.score = bestScore;
  return finish(best);
}

// ---------------------------------------------------------------------------
// Worker client

export class AICancelledError extends Error {
  constructor() { super('AI request cancelled'); this.name = 'AICancelledError'; }
}

// requestMove(fen, level, extra?) -> Promise<Move | null>
//   extra (optional): { timeMs?, startFen?, moves? } forwarded to searchBestMove.
//   Resolves null only when the position has no legal move.
// cancel(): pending requests never settle (they are dropped, not rejected).
// dispose(): terminates the worker; later requestMove calls reject with AICancelledError.
export function createAI() {
  let worker = null;
  let disposed = false;
  let seq = 0;
  const pending = new Map(); // id -> { resolve, reject, fen, level, extra, fallback }

  const runFallback = (id) => {
    const req = pending.get(id);
    if (!req || req.fallback) return;
    req.fallback = true;
    setTimeout(() => {
      if (pending.get(id) !== req) return; // cancelled
      pending.delete(id);
      try { req.resolve(searchBestMove(req.fen, { ...(req.extra || {}), level: req.level })); }
      catch (err) { req.reject(err); }
    }, 30);
  };

  const killWorker = () => {
    if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
    worker = null;
  };

  let workerBroken = false;
  const spawn = () => {
    if (worker || workerBroken || disposed) return worker;
    try {
      if (typeof Worker === 'undefined') throw new Error('no Worker');
      const w = new Worker(new URL('./ai.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const d = e.data || {};
        const req = pending.get(d.id);
        if (!req || req.fallback) return;
        pending.delete(d.id);
        if (d.error) req.reject(new Error(d.error));
        else req.resolve(d.move ?? null);
      };
      const fail = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        workerBroken = true;
        killWorker();
        for (const id of [...pending.keys()]) runFallback(id);
      };
      w.onerror = fail;
      w.onmessageerror = fail;
      worker = w;
    } catch {
      workerBroken = true;
      worker = null;
    }
    return worker;
  };

  return {
    requestMove(fen, level, extra) {
      if (disposed) return Promise.reject(new AICancelledError());
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject, fen, level, extra, fallback: false });
        const w = spawn();
        if (w) {
          try { w.postMessage({ id, fen, level, extra: extra || null }); }
          catch { workerBroken = true; killWorker(); runFallback(id); }
        } else runFallback(id);
      });
    },
    cancel() {
      const hadWorkerJobs = [...pending.values()].some((r) => !r.fallback);
      pending.clear();
      // A stale search would delay the next request; restart the worker instead.
      if (hadWorkerJobs && worker) killWorker();
    },
    dispose() {
      disposed = true;
      pending.clear();
      killWorker();
    },
  };
}
