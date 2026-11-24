// Chess rules engine.  Plain ES module, no DOM, no dependencies: runs in node,
// in the browser main thread and inside a module Worker.
//
// Two layers:
//   * `Position` — a fast 0x88 board with integer-encoded moves and
//     make/unmake.  The AI (ai.js) searches directly on it.
//   * `createGame(fen?)` — the friendly API from CONTRACTS.md, built on top of
//     a Position, producing Move objects with SAN, check/mate flags etc.
//
// 0x88 squares: sq = rank * 16 + file, rank 0 = rank '1', file 0 = 'a'.
// Pieces: type | (color << 3); types P=1 N=2 B=3 R=4 Q=5 K=6; colors W=0 B=1.
// Moves (int): from | to << 7 | promoType << 14 | flags << 17.

export const WHITE = 0, BLACK = 1;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const F_CAPTURE = 1, F_DOUBLE = 2, F_EP = 4, F_CASTLE = 8;

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const TYPE_CHARS = ' pnbrqk';
const PIECE_OF_CHAR = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

export const mFrom = (m) => m & 127;
export const mTo = (m) => (m >> 7) & 127;
export const mPromo = (m) => (m >> 14) & 7;
export const mFlags = (m) => m >>> 17;
const encode = (from, to, promo, flags) => from | (to << 7) | (promo << 14) | (flags << 17);

export const sqToName = (sq) => 'abcdefgh'[sq & 7] + ((sq >> 4) + 1);
export function nameToSq(name) {
  if (typeof name !== 'string' || name.length !== 2) return -1;
  const f = name.charCodeAt(0) - 97, r = name.charCodeAt(1) - 49;
  if (f < 0 || f > 7 || r < 0 || r > 7) return -1;
  return r * 16 + f;
}

const KNIGHT_OFF = [33, 31, 18, 14, -33, -31, -18, -14];
const KING_OFF = [1, -1, 16, -16, 17, 15, -17, -15];
const BISHOP_OFF = [17, 15, -17, -15];
const ROOK_OFF = [1, -1, 16, -16];

// Castling rights: 1 = white O-O, 2 = white O-O-O, 4 = black O-O, 8 = black O-O-O.
const CASTLE_MASK = new Uint8Array(128).fill(15);
CASTLE_MASK[0] = 15 & ~2; CASTLE_MASK[7] = 15 & ~1; CASTLE_MASK[4] = 15 & ~3;
CASTLE_MASK[112] = 15 & ~8; CASTLE_MASK[119] = 15 & ~4; CASTLE_MASK[116] = 15 & ~12;

// Zobrist keys: two independent 32-bit halves (deterministic, so the main
// thread and the worker agree).
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) | 0;
  };
}
const R = mulberry(0x5eed1234);
export const Z_PIECE_LO = new Int32Array(16 * 128), Z_PIECE_HI = new Int32Array(16 * 128);
for (let i = 0; i < 16 * 128; i++) { Z_PIECE_LO[i] = R(); Z_PIECE_HI[i] = R(); }
const Z_CASTLE_LO = new Int32Array(16), Z_CASTLE_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) { Z_CASTLE_LO[i] = R(); Z_CASTLE_HI[i] = R(); }
const Z_EP_LO = new Int32Array(8), Z_EP_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) { Z_EP_LO[i] = R(); Z_EP_HI[i] = R(); }
const Z_SIDE_LO = R(), Z_SIDE_HI = R();

export class Position {
  constructor(fen = START_FEN) {
    this.board = new Int8Array(128);
    this.side = WHITE;
    this.castle = 0;
    this.ep = -1;          // stored only when an enemy pawn stands ready to capture
    this.half = 0;
    this.full = 1;
    this.kings = [-1, -1];
    this.lo = 0; this.hi = 0;
    // undo stacks, indexed by ply (number of moves made on this Position)
    this.ply = 0;
    this.sCastle = []; this.sEp = []; this.sHalf = []; this.sCap = [];
    this.sLo = []; this.sHi = [];
    this.load(fen);
  }

  load(fen) {
    if (typeof fen !== 'string') throw new Error('Invalid FEN: not a string');
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error('Invalid FEN: ' + fen);
    const b = this.board; b.fill(0);
    const rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('Invalid FEN placement: ' + fen);
    const kc = [0, 0];
    this.kings = [-1, -1];
    for (let i = 0; i < 8; i++) {
      const r = 7 - i; let f = 0;
      for (const ch of rows[i]) {
        if (ch >= '1' && ch <= '8') { f += ch.charCodeAt(0) - 48; continue; }
        const t = PIECE_OF_CHAR[ch.toLowerCase()];
        if (!t || f > 7) throw new Error('Invalid FEN placement: ' + fen);
        const c = ch === ch.toLowerCase() ? BLACK : WHITE;
        b[r * 16 + f] = t | (c << 3);
        if (t === KING) { this.kings[c] = r * 16 + f; kc[c]++; }
        f++;
      }
      if (f !== 8) throw new Error('Invalid FEN placement: ' + fen);
    }
    if (kc[0] !== 1 || kc[1] !== 1) throw new Error('Invalid FEN: each side needs exactly one king');
    if (parts[1] !== 'w' && parts[1] !== 'b') throw new Error('Invalid FEN side: ' + fen);
    this.side = parts[1] === 'w' ? WHITE : BLACK;
    let c = 0;
    if (parts[2] !== '-') {
      for (const ch of parts[2]) {
        const bit = { K: 1, Q: 2, k: 4, q: 8 }[ch];
        if (!bit) throw new Error('Invalid FEN castling: ' + fen);
        c |= bit;
      }
    }
    // drop rights that the placement contradicts
    if (b[4] !== KING) c &= ~3;
    if (b[7] !== ROOK) c &= ~1;
    if (b[0] !== ROOK) c &= ~2;
    if (b[116] !== (KING | 8)) c &= ~12;
    if (b[119] !== (ROOK | 8)) c &= ~4;
    if (b[112] !== (ROOK | 8)) c &= ~8;
    this.castle = c;
    this.ep = -1;
    if (parts[3] !== '-') {
      const sq = nameToSq(parts[3]);
      if (sq < 0) throw new Error('Invalid FEN en passant: ' + fen);
      const r = sq >> 4;
      if ((this.side === WHITE && r === 5) || (this.side === BLACK && r === 2)) {
        const pawnSq = sq + (this.side === WHITE ? -16 : 16);
        if (b[pawnSq] === (PAWN | ((this.side ^ 1) << 3)) && this.epCapturerNear(pawnSq, this.side)) this.ep = sq;
      }
    }
    this.half = parts[4] !== undefined ? Math.max(0, parseInt(parts[4], 10) || 0) : 0;
    this.full = parts[5] !== undefined ? Math.max(1, parseInt(parts[5], 10) || 1) : 1;
    this.ply = 0;
    this.sCastle.length = this.sEp.length = this.sHalf.length = this.sCap.length = 0;
    this.sLo.length = this.sHi.length = 0;
    this.computeHash();
  }

  // Is there a pawn of colour `by` beside `pawnSq` (the square of a pawn that just double-pushed)?
  epCapturerNear(pawnSq, by) {
    const p = PAWN | (by << 3), b = this.board;
    return (!((pawnSq - 1) & 0x88) && b[pawnSq - 1] === p) || (!((pawnSq + 1) & 0x88) && b[pawnSq + 1] === p);
  }

  computeHash() {
    let lo = 0, hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.board[sq];
      if (p) { lo ^= Z_PIECE_LO[p * 128 + sq]; hi ^= Z_PIECE_HI[p * 128 + sq]; }
    }
    lo ^= Z_CASTLE_LO[this.castle]; hi ^= Z_CASTLE_HI[this.castle];
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
    if (this.side) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI; }
    this.lo = lo; this.hi = hi;
  }

  // Is `sq` attacked by colour `by`?
  attacked(sq, by) {
    const b = this.board;
    const col = by << 3;
    // pawns
    if (by === WHITE) {
      if (!((sq - 15) & 0x88) && b[sq - 15] === PAWN) return true;
      if (!((sq - 17) & 0x88) && b[sq - 17] === PAWN) return true;
    } else {
      if (!((sq + 15) & 0x88) && b[sq + 15] === (PAWN | 8)) return true;
      if (!((sq + 17) & 0x88) && b[sq + 17] === (PAWN | 8)) return true;
    }
    const kn = KNIGHT | col, kg = KING | col;
    for (let i = 0; i < 8; i++) {
      let t = sq + KNIGHT_OFF[i];
      if (!(t & 0x88) && b[t] === kn) return true;
      t = sq + KING_OFF[i];
      if (!(t & 0x88) && b[t] === kg) return true;
    }
    const bi = BISHOP | col, ro = ROOK | col, qu = QUEEN | col;
    for (let i = 0; i < 4; i++) {
      let d = BISHOP_OFF[i], t = sq + d;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) { if (p === bi || p === qu) return true; break; }
        t += d;
      }
      d = ROOK_OFF[i]; t = sq + d;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) { if (p === ro || p === qu) return true; break; }
        t += d;
      }
    }
    return false;
  }

  inCheck() { return this.attacked(this.kings[this.side], this.side ^ 1); }

  // Pseudo-legal move generation into `list` starting at index `n`; returns new count.
  // Castling is fully checked (not out of / through check) here.
  gen(list, n = 0, capsOnly = false) {
    const b = this.board, us = this.side, them = us ^ 1;
    const up = us === WHITE ? 16 : -16;
    const startRank = us === WHITE ? 1 : 6, promoRank = us === WHITE ? 7 : 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (!p || (p >> 3) !== us) continue;
      const t = p & 7;
      if (t === PAWN) {
        const to = sq + up;
        const promo = (to >> 4) === promoRank;
        if (!b[to]) {
          if (promo) {
            list[n++] = encode(sq, to, QUEEN, 0);
            if (!capsOnly) {
              list[n++] = encode(sq, to, KNIGHT, 0);
              list[n++] = encode(sq, to, ROOK, 0);
              list[n++] = encode(sq, to, BISHOP, 0);
            }
          } else if (!capsOnly) {
            list[n++] = encode(sq, to, 0, 0);
            if ((sq >> 4) === startRank && !b[to + up]) list[n++] = encode(sq, to + up, 0, F_DOUBLE);
          }
        }
        for (let k = -1; k <= 1; k += 2) {
          const c = to + k;
          if (c & 0x88) continue;
          const q = b[c];
          if (q && (q >> 3) === them) {
            if (promo) {
              list[n++] = encode(sq, c, QUEEN, F_CAPTURE);
              if (!capsOnly) {
                list[n++] = encode(sq, c, KNIGHT, F_CAPTURE);
                list[n++] = encode(sq, c, ROOK, F_CAPTURE);
                list[n++] = encode(sq, c, BISHOP, F_CAPTURE);
              }
            } else list[n++] = encode(sq, c, 0, F_CAPTURE);
          } else if (c === this.ep) {
            list[n++] = encode(sq, c, 0, F_CAPTURE | F_EP);
          }
        }
      } else if (t === KNIGHT || t === KING) {
        const offs = t === KNIGHT ? KNIGHT_OFF : KING_OFF;
        for (let i = 0; i < 8; i++) {
          const to = sq + offs[i];
          if (to & 0x88) continue;
          const q = b[to];
          if (!q) { if (!capsOnly) list[n++] = encode(sq, to, 0, 0); }
          else if ((q >> 3) === them) list[n++] = encode(sq, to, 0, F_CAPTURE);
        }
      } else {
        const offs = t === BISHOP ? BISHOP_OFF : t === ROOK ? ROOK_OFF : KING_OFF;
        for (let i = 0; i < offs.length; i++) {
          const d = offs[i];
          let to = sq + d;
          while (!(to & 0x88)) {
            const q = b[to];
            if (!q) { if (!capsOnly) list[n++] = encode(sq, to, 0, 0); }
            else { if ((q >> 3) === them) list[n++] = encode(sq, to, 0, F_CAPTURE); break; }
            to += d;
          }
        }
      }
    }
    if (!capsOnly && this.castle) {
      const c = this.castle;
      if (us === WHITE) {
        if ((c & 1) && !b[5] && !b[6] && b[7] === ROOK && !this.attacked(4, them) && !this.attacked(5, them) && !this.attacked(6, them))
          list[n++] = encode(4, 6, 0, F_CASTLE);
        if ((c & 2) && !b[1] && !b[2] && !b[3] && b[0] === ROOK && !this.attacked(4, them) && !this.attacked(3, them) && !this.attacked(2, them))
          list[n++] = encode(4, 2, 0, F_CASTLE);
      } else {
        if ((c & 4) && !b[117] && !b[118] && b[119] === (ROOK | 8) && !this.attacked(116, them) && !this.attacked(117, them) && !this.attacked(118, them))
          list[n++] = encode(116, 118, 0, F_CASTLE);
        if ((c & 8) && !b[113] && !b[114] && !b[115] && b[112] === (ROOK | 8) && !this.attacked(116, them) && !this.attacked(115, them) && !this.attacked(114, them))
          list[n++] = encode(116, 114, 0, F_CASTLE);
      }
    }
    return n;
  }

  // Apply a pseudo-legal move.  Returns true if legal; if it leaves the mover's
  // king in check the move is taken back and false is returned.
  make(m) {
    const b = this.board, us = this.side;
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, fl = m >>> 17;
    const p = b[from];
    const ply = this.ply;
    this.sCastle[ply] = this.castle; this.sEp[ply] = this.ep; this.sHalf[ply] = this.half;
    this.sLo[ply] = this.lo; this.sHi[ply] = this.hi;
    let lo = this.lo, hi = this.hi;
    let cap = 0;
    if (fl & F_EP) {
      const cs = to + (us === WHITE ? -16 : 16);
      cap = b[cs]; b[cs] = 0;
      lo ^= Z_PIECE_LO[cap * 128 + cs]; hi ^= Z_PIECE_HI[cap * 128 + cs];
    } else {
      cap = b[to];
      if (cap) { lo ^= Z_PIECE_LO[cap * 128 + to]; hi ^= Z_PIECE_HI[cap * 128 + to]; }
    }
    this.sCap[ply] = cap;
    const np = promo ? promo | (us << 3) : p;
    b[from] = 0; b[to] = np;
    lo ^= Z_PIECE_LO[p * 128 + from] ^ Z_PIECE_LO[np * 128 + to];
    hi ^= Z_PIECE_HI[p * 128 + from] ^ Z_PIECE_HI[np * 128 + to];
    if ((p & 7) === KING) {
      this.kings[us] = to;
      if (fl & F_CASTLE) {
        let rf, rt;
        if (to === 6) { rf = 7; rt = 5; } else if (to === 2) { rf = 0; rt = 3; }
        else if (to === 118) { rf = 119; rt = 117; } else { rf = 112; rt = 115; }
        const rk = b[rf]; b[rf] = 0; b[rt] = rk;
        lo ^= Z_PIECE_LO[rk * 128 + rf] ^ Z_PIECE_LO[rk * 128 + rt];
        hi ^= Z_PIECE_HI[rk * 128 + rf] ^ Z_PIECE_HI[rk * 128 + rt];
      }
    }
    const nc = this.castle & CASTLE_MASK[from] & CASTLE_MASK[to];
    if (nc !== this.castle) {
      lo ^= Z_CASTLE_LO[this.castle] ^ Z_CASTLE_LO[nc]; hi ^= Z_CASTLE_HI[this.castle] ^ Z_CASTLE_HI[nc];
      this.castle = nc;
    }
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; this.ep = -1; }
    if ((fl & F_DOUBLE) && this.epCapturerNear(to, us ^ 1)) {
      this.ep = (from + to) >> 1;
      lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7];
    }
    this.half = (cap || (p & 7) === PAWN) ? 0 : this.half + 1;
    if (us === BLACK) this.full++;
    this.side = us ^ 1;
    this.lo = lo ^ Z_SIDE_LO; this.hi = hi ^ Z_SIDE_HI;
    this.ply = ply + 1;
    if (this.attacked(this.kings[us], us ^ 1)) { this.unmake(m); return false; }
    return true;
  }

  unmake(m) {
    const b = this.board;
    const ply = --this.ply;
    const us = this.side ^ 1;
    this.side = us;
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, fl = m >>> 17;
    const p = promo ? PAWN | (us << 3) : b[to];
    b[from] = p;
    const cap = this.sCap[ply];
    if (fl & F_EP) { b[to] = 0; b[to + (us === WHITE ? -16 : 16)] = cap; }
    else b[to] = cap;
    if ((p & 7) === KING) {
      this.kings[us] = from;
      if (fl & F_CASTLE) {
        let rf, rt;
        if (to === 6) { rf = 7; rt = 5; } else if (to === 2) { rf = 0; rt = 3; }
        else if (to === 118) { rf = 119; rt = 117; } else { rf = 112; rt = 115; }
        b[rf] = b[rt]; b[rt] = 0;
      }
    }
    if (us === BLACK) this.full--;
    this.castle = this.sCastle[ply]; this.ep = this.sEp[ply]; this.half = this.sHalf[ply];
    this.lo = this.sLo[ply]; this.hi = this.sHi[ply];
  }

  // Null move (pass) for the search.
  makeNull() {
    const ply = this.ply;
    this.sCastle[ply] = this.castle; this.sEp[ply] = this.ep; this.sHalf[ply] = this.half;
    this.sLo[ply] = this.lo; this.sHi[ply] = this.hi; this.sCap[ply] = 0;
    if (this.ep >= 0) { this.lo ^= Z_EP_LO[this.ep & 7]; this.hi ^= Z_EP_HI[this.ep & 7]; this.ep = -1; }
    this.lo ^= Z_SIDE_LO; this.hi ^= Z_SIDE_HI;
    this.side ^= 1;
    this.half = 0; // stops repetition scans from crossing the null move
    this.ply = ply + 1;
  }
  unmakeNull() {
    const ply = --this.ply;
    this.side ^= 1;
    this.castle = this.sCastle[ply]; this.ep = this.sEp[ply]; this.half = this.sHalf[ply];
    this.lo = this.sLo[ply]; this.hi = this.sHi[ply];
  }

  // Has the current position occurred before (since the last irreversible move)?
  isRepetition() {
    const lo = this.lo, hi = this.hi;
    const stop = Math.max(0, this.ply - this.half);
    for (let i = this.ply - 2; i >= stop; i -= 2) {
      if (this.sLo[i] === lo && this.sHi[i] === hi) return true;
    }
    return false;
  }

  legalMoves() {
    const pseudo = [];
    const n = this.gen(pseudo, 0, false);
    const out = [];
    for (let i = 0; i < n; i++) {
      const m = pseudo[i];
      if (this.make(m)) { this.unmake(m); out.push(m); }
    }
    return out;
  }

  hasLegalMove() {
    const pseudo = [];
    const n = this.gen(pseudo, 0, false);
    for (let i = 0; i < n; i++) {
      const m = pseudo[i];
      if (this.make(m)) { this.unmake(m); return true; }
    }
    return false;
  }

  hasNonPawn(side) {
    const b = this.board, c = side << 3;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (p && (p & 8) === c) { const t = p & 7; if (t !== PAWN && t !== KING) return true; }
    }
    return false;
  }

  // Is there a strictly legal en-passant capture available right now?
  legalEpSquare() {
    if (this.ep < 0) return -1;
    const us = this.side, b = this.board, pawn = PAWN | (us << 3);
    const behind = this.ep + (us === WHITE ? -16 : 16);
    for (const d of [-1, 1]) {
      const from = behind + d;
      if (from & 0x88 || b[from] !== pawn) continue;
      const m = encode(from, this.ep, 0, F_CAPTURE | F_EP);
      if (this.make(m)) { this.unmake(m); return this.ep; }
    }
    return -1;
  }

  // Hash used for threefold repetition: en-passant only counts when a legal capture exists.
  repetitionKey() {
    let lo = this.lo, hi = this.hi;
    if (this.ep >= 0 && this.legalEpSquare() < 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
    return (hi & 0x1fffff) * 4294967296 + (lo >>> 0);
  }

  insufficientMaterial() {
    const b = this.board;
    let minors = 0, bishopColors = 0, knights = 0, bishops = 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const t = b[sq] & 7;
      if (!t || t === KING) continue;
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      minors++;
      if (t === KNIGHT) knights++;
      else { bishops++; bishopColors |= 1 << (((sq >> 4) + (sq & 7)) & 1); }
    }
    if (minors <= 1) return true;                       // K v K, K+minor v K
    if (knights === 0 && bishopColors !== 3) return true; // only bishops, all on one colour
    return false;
  }

  fen() {
    const b = this.board;
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let s = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = b[r * 16 + f];
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        const ch = TYPE_CHARS[p & 7];
        s += p & 8 ? ch : ch.toUpperCase();
      }
      if (empty) s += empty;
      rows.push(s);
    }
    let c = '';
    if (this.castle & 1) c += 'K';
    if (this.castle & 2) c += 'Q';
    if (this.castle & 4) c += 'k';
    if (this.castle & 8) c += 'q';
    const ep = this.legalEpSquare();
    return `${rows.join('/')} ${this.side ? 'b' : 'w'} ${c || '-'} ${ep >= 0 ? sqToName(ep) : '-'} ${this.half} ${this.full}`;
  }
}

// Count leaf nodes (move-generator verification).
export function perft(pos, depth) {
  const lists = [];
  for (let i = 0; i <= depth; i++) lists.push(new Int32Array(256));
  const rec = (d) => {
    const list = lists[d];
    const n = pos.gen(list, 0, false);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const m = list[i];
      if (!pos.make(m)) continue;
      total += d === 1 ? 1 : rec(d - 1);
      pos.unmake(m);
    }
    return total;
  };
  return depth <= 0 ? 1 : rec(depth);
}

// ---------------------------------------------------------------------------
// Friendly API

// Build contract-shaped Move objects (with SAN) for all legal moves of `pos`.
// Returns { ints, objs } in the same order.
function buildMoves(pos) {
  const ints = pos.legalMoves();
  const b = pos.board, us = pos.side;
  const color = us ? 'b' : 'w';
  const objs = new Array(ints.length);
  for (let i = 0; i < ints.length; i++) {
    const m = ints[i];
    const from = mFrom(m), to = mTo(m), promo = mPromo(m), fl = mFlags(m);
    const type = b[from] & 7;
    const mv = { from: sqToName(from), to: sqToName(to), piece: TYPE_CHARS[type], color };
    if (fl & F_CAPTURE) {
      const cs = fl & F_EP ? to + (us === WHITE ? -16 : 16) : to;
      mv.captured = TYPE_CHARS[b[cs] & 7];
      mv.capturedSquare = sqToName(cs);
    }
    if (promo) mv.promotion = TYPE_CHARS[promo];
    if (fl & F_CASTLE) {
      const king = (to & 7) === 6;
      mv.castle = king ? 'k' : 'q';
      const rank = from & 0x70;
      mv.rookFrom = sqToName(rank + (king ? 7 : 0));
      mv.rookTo = sqToName(rank + (king ? 5 : 3));
    }
    if (fl & F_EP) mv.enPassant = true;
    if (fl & F_DOUBLE) mv.double = true;

    // SAN
    let san;
    if (fl & F_CASTLE) san = mv.castle === 'k' ? 'O-O' : 'O-O-O';
    else if (type === PAWN) {
      san = (fl & F_CAPTURE ? mv.from[0] + 'x' : '') + mv.to;
      if (promo) san += '=' + TYPE_CHARS[promo].toUpperCase();
    } else {
      let ambiguous = false, sameFile = false, sameRank = false;
      for (let j = 0; j < ints.length; j++) {
        if (j === i) continue;
        const o = ints[j], of = mFrom(o);
        if (mTo(o) !== to || of === from || (b[of] & 7) !== type) continue;
        ambiguous = true;
        if ((of & 7) === (from & 7)) sameFile = true;
        if ((of >> 4) === (from >> 4)) sameRank = true;
      }
      let dis = '';
      if (ambiguous) {
        if (!sameFile) dis = mv.from[0];
        else if (!sameRank) dis = mv.from[1];
        else dis = mv.from;
      }
      san = TYPE_CHARS[type].toUpperCase() + dis + (fl & F_CAPTURE ? 'x' : '') + mv.to;
    }
    pos.make(m);
    mv.check = pos.inCheck();
    mv.mate = mv.check && !pos.hasLegalMove();
    pos.unmake(m);
    if (mv.mate) san += '#'; else if (mv.check) san += '+';
    mv.san = san;
    objs[i] = mv;
  }
  return { ints, objs };
}

const copyMove = (m) => (m ? { ...m } : null);

// createGame(fen?) — throws an Error for a malformed FEN.
export function createGame(fen) {
  const pos = new Position(fen ?? START_FEN);
  const startFen = pos.fen();
  const played = [];      // Move objects
  const playedInts = [];  // int moves, parallel to `played`
  const repKeys = [pos.repetitionKey()];
  let cache = null;

  const legal = () => (cache ??= buildMoves(pos));

  const game = {
    get turn() { return pos.side ? 'b' : 'w'; },
    board() {
      const out = [];
      for (let r = 7; r >= 0; r--) {
        const row = [];
        for (let f = 0; f < 8; f++) {
          const p = pos.board[r * 16 + f];
          row.push(p ? { type: TYPE_CHARS[p & 7], color: p & 8 ? 'b' : 'w' } : null);
        }
        out.push(row);
      }
      return out;
    },
    get(sq) {
      const s = nameToSq(sq);
      if (s < 0) return null;
      const p = pos.board[s];
      return p ? { type: TYPE_CHARS[p & 7], color: p & 8 ? 'b' : 'w' } : null;
    },
    legalMoves(sq) {
      const { objs } = legal();
      return (sq === undefined || sq === null ? objs : objs.filter((m) => m.from === sq)).map(copyMove);
    },
    move(req) {
      if (!req || typeof req !== 'object') return null;
      const { ints, objs } = legal();
      const promo = typeof req.promotion === 'string' ? req.promotion.toLowerCase() : null;
      for (let i = 0; i < objs.length; i++) {
        const o = objs[i];
        if (o.from !== req.from || o.to !== req.to) continue;
        if (o.promotion && o.promotion !== promo) continue;
        pos.make(ints[i]);
        played.push(o); playedInts.push(ints[i]);
        repKeys.push(pos.repetitionKey());
        cache = null;
        return copyMove(o);
      }
      return null;
    },
    undo() {
      if (!played.length) return null;
      pos.unmake(playedInts.pop());
      repKeys.pop();
      cache = null;
      return copyMove(played.pop());
    },
    inCheck() { return pos.inCheck(); },
    kingSquare(color) { return sqToName(pos.kings[color === 'b' ? 1 : 0]); },
    status() {
      if (!legal().ints.length) return pos.inCheck() ? 'checkmate' : 'stalemate';
      if (pos.half >= 100) return 'draw-50';
      const key = repKeys[repKeys.length - 1];
      let n = 0;
      for (let i = repKeys.length - 1; i >= 0; i--) if (repKeys[i] === key) n++;
      if (n >= 3) return 'draw-repetition';
      if (pos.insufficientMaterial()) return 'draw-material';
      return 'playing';
    },
    history() { return played.map(copyMove); },
    fen() { return pos.fen(); },
  };
  // Internals for ai.js and tests (non-enumerable, not part of the contract).
  Object.defineProperty(game, '_pos', { value: pos });
  Object.defineProperty(game, '_startFen', { value: startFen });
  return game;
}
