// Choreography: every move, kill, promotion, intro and finale as a small
// time-based sequence.
//
// A Seq is a list of timed events (`at`) and spans (`run`).  It only ever
// advances by the dt it is given, and `finish(true)` jumps straight to the end
// state: spans get their final u = 1 call, events still fire (with
// `seq.forced` set so they skip the fireworks and only do bookkeeping).
// The *logical* state of the actors (square, type, alive) is already final
// before a sequence starts — a sequence only animates visual overrides, so it
// can be dropped at any instant without leaving the board inconsistent.

import { PAL, GLYPHS } from '../core/palette.js';
import { TAU, clamp, lerp, ease } from '../core/util.js';

export class Seq {
  constructor() {
    this.t = 0; this.dur = 0; this.items = []; this.ends = [];
    this.done = false; this.forced = false; this.onDone = null; this.sorted = false;
  }
  at(t, fn) { this.items.push({ t0: t, t1: t, fn, ev: true, done: false }); this.dur = Math.max(this.dur, t); this.sorted = false; return this; }
  run(t0, t1, fn) { this.items.push({ t0, t1: Math.max(t1, t0 + 1e-4), fn, ev: false, done: false }); this.dur = Math.max(this.dur, t1); this.sorted = false; return this; }
  end(fn) { this.ends.push(fn); return this; }
  pad(t) { this.dur = Math.max(this.dur, t); return this; }
  _step() {
    if (!this.sorted) { this.items.sort((a, b) => a.t0 - b.t0); this.sorted = true; }
    const t = this.t;
    for (const it of this.items) {
      if (it.done) continue;
      if (it.t0 > t) break;
      if (it.ev) { it.done = true; it.fn(this); }
      else {
        const u = clamp((t - it.t0) / (it.t1 - it.t0));
        it.fn(u, this);
        if (u >= 1) it.done = true;
      }
    }
  }
  advance(dt) {
    if (this.done) return;
    this.t += dt;
    if (this.t >= this.dur) { this.finish(false); return; }
    this._step();
  }
  finish(forced) {
    if (this.done) return;
    this.forced = !!forced;
    this.t = this.dur + 1;
    try { this._step(); for (const fn of this.ends) fn(this); }
    catch (err) { console.error('[pieces] choreography error', err); }
    this.done = true;
    if (this.onDone) this.onDone();
  }
}

// Reset every visual override of an actor (logical state is untouched).
export function rest(a) {
  a.pos = null; a.lift = 0; a.sx = 1; a.sy = 1; a.lean = 0; a.yawAdd = 0;
  a.glow = 0; a.jit = 0; a.showType = null; a.busy = false; a.hidden = !!a.fallen;
}

const dirOf = (p, q) => {
  const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d, d };
};
const put = (a, p, q, e) => {
  if (!a.pos) a.pos = { x: 0, y: 0 };
  a.pos.x = lerp(p.x, q.x, e); a.pos.y = lerp(p.y, q.y, e);
};
const along = (p, d, k) => ({ x: p.x + d.x * k, y: p.y + d.y * k });
const hop = (u) => Math.sin(Math.PI * clamp(u));

// Squash on landing, springing back.
function squash(s, a, t0, t1, amt) {
  s.run(t0, t1, (u) => {
    const k = 1 - ease.outElastic(u);
    a.sy = 1 - amt * k; a.sx = 1 + amt * 0.7 * k;
  });
}

// Leave a glyph afterimage every `every` squares travelled.
function trailer(st, a, every = 0.2, frac = 0.5) {
  let lx = null, ly = 0;
  return () => {
    if (!a.pos) return;
    if (lx === null || Math.hypot(a.pos.x - lx, a.pos.y - ly) > every * st.sq) {
      if (lx !== null) st.trail(a, frac);
      lx = a.pos.x; ly = a.pos.y;
    }
  };
}

// ---------------------------------------------------------------------------
// Quiet moves
// ---------------------------------------------------------------------------

const QUIET = {
  // Pawn: a brisk little hop (two for the double step).
  p(s, st, m, a, A, B) {
    const hops = m.double ? 2 : 1, T = m.double ? 0.34 : 0.26;
    s.run(0, T, (u) => {
      put(a, A(), B(), ease.inOutQuad(u));
      const h = (u * hops) % 1;
      a.lift = (u >= 1 ? 0 : hop(h)) * st.sq * 0.2;
      a.lean = dirOf(A(), B()).x * 0.08 * hop(u);
    });
    for (let k = 1; k <= hops; k++) s.at((T * k) / hops - 0.01, () => { if (!s.forced) st.sfx('move', k === hops ? 0.6 : 0.35); });
    squash(s, a, T, T + 0.08, 0.12);
    return T + 0.08;
  },
  // Knight: crouch, leap in an arc with a full turn in the air, land with a squash.
  n(s, st, m, a, A, B) {
    s.run(0, 0.07, (u) => { a.sy = 1 - 0.16 * u; a.sx = 1 + 0.1 * u; });
    s.at(0.07, () => { if (!s.forced) st.sfx('leap', 0.8); });
    s.run(0.07, 0.34, (u) => {
      put(a, A(), B(), ease.inOutQuad(u));
      a.lift = hop(u) * st.sq * 0.95;
      a.sy = 1 + 0.12 * hop(u); a.sx = 1 - 0.06 * hop(u);
      a.yawAdd = ease.inOutQuad(u) * TAU;
      a.lean = dirOf(A(), B()).x * 0.22 * Math.cos(u * Math.PI);
    });
    s.at(0.34, () => {
      a.lift = 0; a.lean = 0; a.yawAdd = 0;
      if (s.forced) return;
      const b = B();
      st.sfx('land', 0.8);
      st.ripple(b.x, b.y, 0.55);
      st.fx.sparks(b.x, b.y, st.rm ? 2 : 5, { speed: 2.2, spread: Math.PI, up: 0.3, life: 0.25, bigChance: 0 });
      st.shakeBy(1.6, 0, 1);
    });
    squash(s, a, 0.34, 0.43, 0.26);
    return 0.43;
  },
  // King: lifts, carries its weight across, sets down with a thud.
  k(s, st, m, a, A, B) {
    s.run(0, 0.12, (u) => { a.lift = ease.outQuad(u) * st.sq * 0.1; a.sy = 1 + 0.04 * u; });
    s.run(0.1, 0.34, (u) => {
      put(a, A(), B(), ease.inOutCubic(u));
      a.lean = dirOf(A(), B()).x * 0.07 * hop(u);
    });
    s.run(0.33, 0.38, (u) => { a.lift = (1 - ease.inQuad(u)) * st.sq * 0.1; });
    s.at(0.38, () => {
      a.lift = 0;
      if (s.forced) return;
      const b = B();
      st.sfx('move', 1);
      st.ripple(b.x, b.y, 0.6);
      st.shakeBy(1.8, 0, 1);
    });
    squash(s, a, 0.38, 0.44, 0.1);
    return 0.44;
  },
};
// Bishop / rook / queen: a fast glide that leaves fading glyphs behind.
function glide(s, st, m, a, A, B) {
  const d = dirOf(A(), B()).d / st.sq;
  const T = clamp(0.19 + d * 0.03, 0.22, 0.37);
  const tr = trailer(st, a, a.type === 'q' ? 0.16 : 0.22, a.type === 'q' ? 0.6 : 0.45);
  s.at(0, () => { if (!s.forced) st.sfx('slide', clamp(0.4 + d * 0.1)); });
  s.run(0, T, (u, q) => {
    put(a, A(), B(), ease.inOutCubic(u));
    const dd = dirOf(A(), B());
    a.lean = dd.x * 0.2 * hop(u);
    a.sy = 1 - 0.05 * hop(u) * Math.abs(dd.x); a.sx = 1 + 0.07 * hop(u) * Math.abs(dd.x);
    if (a.type === 'q') a.yawAdd = ease.inOutQuad(u) * st.period(a.type) * 2;
    if (!q.forced && u < 0.97) tr();
  });
  s.at(T, () => { a.lean = 0; a.yawAdd = 0; if (!s.forced) st.sfx('move', 0.5); });
  squash(s, a, T, T + 0.05, 0.06);
  return T + 0.05;
}
QUIET.b = glide; QUIET.r = glide; QUIET.q = glide;

// A piece dropped from the hand: it is already (almost) there.
function drop(s, st, m, a, A, B) {
  s.run(0, 0.11, (u) => { put(a, A(), B(), ease.outCubic(u)); });
  s.at(0.1, () => { if (!s.forced) st.sfx('move', 0.6); });
  squash(s, a, 0.1, 0.18, 0.12);
  return 0.18;
}

// Castling: the king steps across with weight while the rook vaults over it.
function castle(s, st, m, a, rook, A, B) {
  s.at(0, () => { if (!s.forced) st.sfx('castle', 1); });
  QUIET.k(s, st, m, a, A, B);
  if (rook) {
    rook.busy = true;
    const RA = () => st.foot(m.rookFrom), RB = () => st.foot(m.rookTo);
    const tr = trailer(st, rook, 0.22, 0.4);
    s.run(0.06, 0.4, (u, q) => {
      put(rook, RA(), RB(), ease.inOutCubic(u));
      rook.lift = hop(u) * st.sq * 0.7;
      rook.yawAdd = ease.inOutQuad(u) * st.period('r') * 2;
      if (!q.forced && u < 0.95) tr();
    });
    s.at(0.4, () => {
      rook.lift = 0; rook.yawAdd = 0;
      if (s.forced) return;
      const b = RB();
      st.sfx('land', 0.7); st.ripple(b.x, b.y, 0.5);
    });
    squash(s, rook, 0.4, 0.5, 0.16);
  }
  return 0.5;
}

// ---------------------------------------------------------------------------
// Kills
// ---------------------------------------------------------------------------

// The instant of impact: freeze, shake, break the victim apart, light sparks,
// disturb the world.  `o.dir` is the direction of the blow.
function strike(s, st, v, vsq, o) {
  if (s.forced) { st.kill(v); return; }
  const Vp = st.foot(vsq), sq = st.sq;
  const vc = { x: Vp.x, y: Vp.y - st.height(v.type) * 0.45 };
  st.stop(o.stop ?? 0.06);
  st.shakeBy(o.shake ?? 6, o.sdx ?? o.dir.x, o.sdy ?? o.dir.y);
  st.shatter(v, {
    cx: o.cx ?? vc.x, cy: o.cy ?? vc.y, groundY: Vp.y, dir: o.dir,
    power: o.power ?? 3, burst: o.burst ?? 1.6, up: o.up ?? 1.6, jitter: o.jitter ?? 0.9,
    split: o.split, frac: st.rm ? 0.6 : 1,
  });
  st.fx.sparks(vc.x, vc.y, Math.round((o.sparks ?? 10) * (st.rm ? 0.5 : 1)), {
    dir: o.sparkDir ?? o.dir, spread: o.sparkSpread ?? 1.6, speed: o.sparkSpeed ?? 6,
  });
  st.ripple(Vp.x, Vp.y, o.ripple ?? 1);
  st.flash(vsq, PAL.blade[1], o.flash ?? 1);
  st.sfx('impact', o.intensity ?? 0.8);
  st.sfx('shatter', o.intensity ?? 0.8);
}

const settle = (s, st, a, t, B, sfxAt = true) => {
  s.at(t, () => {
    a.lift = 0; a.lean = 0; a.yawAdd = 0;
    if (!s.forced && sfxAt) st.sfx('capture', 0.7);
  });
  squash(s, a, t, t + 0.12, 0.1);
};

const KILL = {
  // Pawn: a short draw back and a straight stab.
  p(s, st, m, a, v, vsq, A, B) {
    const V = () => st.foot(vsq);
    const D = () => dirOf(A(), V());
    const hit = () => (m.enPassant ? along(A(), dirOf(A(), B()), dirOf(A(), B()).d * 0.45) : along(V(), D(), -0.56 * st.sq));
    s.run(0, 0.13, (u) => {
      const d = D(), e = ease.outQuad(u);
      put(a, A(), along(A(), d, -0.2 * st.sq), e);
      a.lean = -d.x * 0.16 * e; a.sy = 1 - 0.08 * e;
    });
    s.run(0.13, 0.22, (u) => {
      const d = D(), e = ease.inCubic(u);
      put(a, along(A(), d, -0.2 * st.sq), hit(), e);
      a.lean = d.x * 0.22 * e; a.sy = 1 + 0.06 * e;
      a.lift = hop(u) * st.sq * 0.08;
    });
    s.at(0.2, () => {
      if (s.forced) return;
      const d = D(), h = st.height('p') * 0.5, p0 = along(hit(), d, 0.1 * st.sq), p1 = along(V(), d, 0.62 * st.sq);
      st.fx.slash(p0.x, p0.y - h, p1.x, p1.y - h, { width: 0.075, bend: 0.03, life: 0.24, sweep: 0.04 });
      st.sfx('slash', 0.6);
    });
    s.at(0.23, () => strike(s, st, v, vsq, {
      dir: D(), power: 3.4, burst: 1.0, up: 1.2, shake: 4.5, stop: 0.05, sparks: 8, sparkSpread: 1.0, ripple: 0.75, flash: 0.8, intensity: 0.6,
    }));
    s.run(0.3, 0.56, (u) => {
      put(a, hit(), B(), ease.outCubic(u));
      a.lift = hop(u) * st.sq * 0.12; a.lean = D().x * 0.22 * (1 - u);
    });
    settle(s, st, a, 0.56, B);
    return 0.7;
  },

  // Knight: a high vault that comes down on the victim like a hammer.
  n(s, st, m, a, v, vsq, A, B) {
    const V = () => st.foot(vsq);
    s.run(0, 0.1, (u) => { a.sy = 1 - 0.2 * u; a.sx = 1 + 0.12 * u; });
    s.at(0.1, () => { if (!s.forced) st.sfx('leap', 1); });
    s.run(0.1, 0.5, (u) => {
      // linger at the apex, then drop fast
      const e = u < 0.6 ? ease.outQuad(u / 0.6) * 0.62 : 0.62 + ease.inCubic((u - 0.6) / 0.4) * 0.38;
      put(a, A(), B(), e);
      const h = u < 0.6 ? ease.outQuad(u / 0.6) : 1 - ease.inCubic((u - 0.6) / 0.4);
      a.lift = h * st.sq * 1.55;
      a.yawAdd = ease.inOutQuad(u) * TAU;
      a.sy = 1 + 0.16 * (u > 0.6 ? (u - 0.6) / 0.4 : 0); a.sx = 1 - 0.08 * (u > 0.6 ? (u - 0.6) / 0.4 : 0);
      a.lean = dirOf(A(), B()).x * 0.3 * Math.cos(u * Math.PI);
    });
    s.at(0.44, () => {
      if (s.forced) return;
      const p = V();
      st.fx.slash(p.x - st.sq * 0.05, p.y - st.sq * 2.3, p.x + st.sq * 0.03, p.y - st.sq * 0.1, { width: 0.12, bend: 0.02, life: 0.26, sweep: 0.05 });
      st.sfx('slash', 0.8);
    });
    s.at(0.5, () => {
      a.lift = 0; a.lean = 0; a.yawAdd = 0;
      strike(s, st, v, vsq, {
        dir: { x: 0, y: -0.25 }, power: 2.2, burst: 3.6, up: 2.6, cy: V().y, shake: 10, sdx: 0.15, sdy: 1, stop: 0.075,
        sparks: 16, sparkDir: { x: 0, y: -1 }, sparkSpread: 3.0, sparkSpeed: 7, ripple: 1.5, flash: 1.3, intensity: 1,
      });
      if (s.forced) return;
      const p = V();
      st.fx.ring(p.x, p.y, { r0: 0.25, r1: 1.75, life: 0.42 });
      st.fx.ring(p.x, p.y, { r0: 0.1, r1: 1.1, life: 0.5, delay: 0.06, set: 'spark' });
      st.sfx('land', 1);
    });
    s.run(0.5, 0.86, (u) => {
      const k = 1 - ease.outElastic(u);
      a.sy = 1 - 0.4 * k; a.sx = 1 + 0.3 * k;
    });
    s.at(0.86, () => { if (!s.forced) st.sfx('capture', 0.7); });
    return 0.95;
  },

  // Bishop: a streak down the diagonal and one clean slanting cut.
  b(s, st, m, a, v, vsq, A, B) {
    const V = () => st.foot(vsq), D = () => dirOf(A(), V());
    const hit = () => along(V(), D(), -0.62 * st.sq);
    const tr = trailer(st, a, 0.2, 0.5);
    s.run(0, 0.14, (u) => {
      const d = D(), e = ease.outQuad(u);
      put(a, A(), along(A(), d, -0.26 * st.sq), e);
      a.lean = -d.x * 0.2 * e; a.yawAdd = -0.8 * e;
    });
    s.at(0.14, () => { if (!s.forced) st.sfx('slide', 0.8); });
    s.run(0.14, 0.31, (u, q) => {
      const d = D();
      put(a, along(A(), d, -0.26 * st.sq), hit(), ease.inQuad(u));
      a.lean = d.x * 0.3 * u; a.yawAdd = -0.8 + 2.4 * u;
      if (!q.forced) tr();
    });
    const cut = () => {
      const d = D(), sg = d.x >= 0 ? 1 : -1, p = V(), h = st.height(v.type) * 0.5, q = st.sq;
      return { x0: p.x - sg * 0.82 * q, y0: p.y - h - 0.86 * q, x1: p.x + sg * 0.72 * q, y1: p.y - h + 0.74 * q, sg };
    };
    s.at(0.28, () => {
      if (s.forced) return;
      const c = cut();
      st.fx.slash(c.x0, c.y0, c.x1, c.y1, { width: 0.15, bend: -0.16 * c.sg, life: 0.32, sweep: 0.055 });
      st.sfx('slash', 0.9);
    });
    s.at(0.32, () => {
      const c = cut(), l = Math.hypot(c.x1 - c.x0, c.y1 - c.y0) || 1;
      const tx = (c.x1 - c.x0) / l, ty = (c.y1 - c.y0) / l;
      strike(s, st, v, vsq, {
        dir: { x: D().x * 0.5, y: D().y * 0.5 }, power: 1.6, burst: 1.3, up: 1.0, shake: 6.5, sdx: tx, sdy: ty, stop: 0.07,
        split: { nx: -ty, ny: tx, slide: 0.55, hold: 0.15 }, sparks: 12, sparkDir: { x: tx, y: ty }, sparkSpread: 0.7, sparkSpeed: 8,
        ripple: 1.0, flash: 1, intensity: 0.8,
      });
    });
    const tr2 = trailer(st, a, 0.2, 0.4);
    s.run(0.42, 0.74, (u, q) => {
      put(a, hit(), B(), ease.inOutCubic(u));
      a.lean = D().x * 0.3 * (1 - u); a.yawAdd = 1.6 * (1 - ease.outCubic(u));
      if (!q.forced && u < 0.9) tr2();
    });
    settle(s, st, a, 0.74, B);
    return 0.88;
  },

  // Rook: rears back and rams straight through.
  r(s, st, m, a, v, vsq, A, B) {
    const V = () => st.foot(vsq), D = () => dirOf(A(), V());
    const back = () => along(A(), D(), -0.36 * st.sq);
    const tr = trailer(st, a, 0.2, 0.42);
    s.run(0, 0.2, (u) => {
      const d = D(), e = ease.outCubic(u);
      put(a, A(), back(), e);
      a.lean = -d.x * 0.24 * e;
      a.sx = 1 + 0.08 * e; a.sy = 1 - 0.1 * e;
      a.jit = u * 1.4;
    });
    s.at(0.2, () => { a.jit = 0; if (!s.forced) st.sfx('slide', 1); });
    s.run(0.2, 0.34, (u, q) => {
      const d = D();
      put(a, back(), along(V(), d, -0.3 * st.sq), ease.inQuad(u));
      a.lean = d.x * 0.34 * u;
      a.sx = 1 + 0.1 * u * Math.abs(d.x) - 0.06 * u * Math.abs(d.y); a.sy = 1 + 0.1 * u * Math.abs(d.y) - 0.06 * u * Math.abs(d.x);
      if (!q.forced) tr();
    });
    s.at(0.3, () => {
      if (s.forced) return;
      const d = D(), h = st.height(v.type) * 0.42, p0 = along(V(), d, -0.9 * st.sq), p1 = along(V(), d, 1.25 * st.sq);
      st.fx.slash(p0.x, p0.y - h, p1.x, p1.y - h, { width: 0.2, bend: 0.0, life: 0.3, sweep: 0.05 });
      st.fx.slash(p0.x, p0.y - h * 1.9, p1.x, p1.y - h * 1.9, { width: 0.05, bend: 0.0, life: 0.2, sweep: 0.05, delay: 0.01 });
      st.fx.slash(p0.x, p0.y - h * 0.2, p1.x, p1.y - h * 0.2, { width: 0.05, bend: 0.0, life: 0.2, sweep: 0.05, delay: 0.02 });
      st.sfx('slash', 0.8);
    });
    s.at(0.34, () => strike(s, st, v, vsq, {
      dir: D(), power: 6.2, burst: 1.2, up: 1.5, jitter: 1.3, shake: 11, stop: 0.085, sparks: 18, sparkSpread: 1.1, sparkSpeed: 9,
      ripple: 1.4, flash: 1.2, intensity: 1,
    }));
    s.run(0.34, 0.5, (u) => {
      const d = D();
      put(a, along(V(), d, -0.3 * st.sq), along(B(), d, 0.16 * st.sq), ease.outCubic(u));
      a.lean = d.x * 0.34 * (1 - u);
    });
    s.run(0.5, 0.72, (u) => {
      put(a, along(B(), D(), 0.16 * st.sq), B(), ease.inOutQuad(u));
      a.sx = 1; a.sy = 1;
    });
    settle(s, st, a, 0.72, B);
    return 0.86;
  },

  // Queen: she is everywhere at once — three cuts from three sides.
  q(s, st, m, a, v, vsq, A, B) {
    const V = () => st.foot(vsq), D = () => dirOf(A(), V());
    const perp = () => { const d = D(); return { x: -d.y, y: d.x }; };
    const spots = [
      () => along(V(), D(), -0.66 * st.sq),
      () => { const p = perp(), d = D(); return { x: V().x + (p.x * 0.6 + d.x * 0.35) * st.sq, y: V().y + (p.y * 0.6 + d.y * 0.35) * st.sq }; },
      () => { const p = perp(), d = D(); return { x: V().x + (-p.x * 0.62 + d.x * 0.1) * st.sq, y: V().y + (-p.y * 0.62 + d.y * 0.1) * st.sq }; },
    ];
    const per = st.period('q');
    const tr = trailer(st, a, 0.15, 0.6);
    s.run(0, 0.1, (u) => { a.lift = ease.outQuad(u) * st.sq * 0.16; a.yawAdd = u * per; });
    s.at(0.1, () => { if (!s.forced) st.sfx('slide', 1); });
    s.run(0.1, 0.24, (u, q) => {
      put(a, A(), spots[0](), ease.inOutCubic(u));
      a.lean = D().x * 0.26 * hop(u); a.yawAdd = per + u * per;
      if (!q.forced) tr();
    });
    const cuts = [
      { t: 0.24, a0: -2.2, len: 1.9, w: 0.11 },
      { t: 0.345, a0: -0.9, len: 1.9, w: 0.11 },
      { t: 0.45, a0: 3.02, len: 2.5, w: 0.2 },
    ];
    const vcen = () => { const p = V(); return { x: p.x, y: p.y - st.height(v.type) * 0.48 }; };
    cuts.forEach((c, i) => {
      s.at(c.t, () => {
        if (s.forced) return;
        const p = vcen(), L = c.len * st.sq * 0.5, cx = Math.cos(c.a0), cy = Math.sin(c.a0);
        st.fx.slash(p.x - cx * L, p.y - cy * L, p.x + cx * L, p.y + cy * L, { width: c.w, bend: i === 2 ? 0.05 : 0.2, life: i === 2 ? 0.36 : 0.26, sweep: 0.045 });
        st.sfx('slash', 0.6 + i * 0.2);
        if (i < 2) {
          // chip the victim, don't break it yet
          st.stop(0.03); st.shakeBy(3.5, cx, cy);
          st.chip(v, 0.16, { x: cx, y: cy });
          st.fx.sparks(p.x, p.y, st.rm ? 3 : 6, { dir: { x: cx, y: cy }, spread: 0.9, speed: 7 });
          st.sfx('impact', 0.4);
          v.jit = 2.2;
        }
      });
      if (i < 2) {
        // dart to the next side between cuts
        s.run(c.t + 0.03, c.t + 0.095, (u, q) => {
          put(a, spots[i](), spots[i + 1](), ease.inOutQuad(u));
          a.yawAdd = (2 + i) * per + u * per; a.lift = st.sq * (0.16 + 0.2 * hop(u));
          if (!q.forced) tr();
        });
      }
    });
    s.at(0.475, () => strike(s, st, v, vsq, {
      dir: { x: Math.cos(3.02) * 0.4, y: -0.2 }, power: 2.0, burst: 3.4, up: 1.8, shake: 9, stop: 0.09, sparks: 18, sparkSpread: 6.2, sparkSpeed: 8,
      ripple: 1.4, flash: 1.3, intensity: 1,
    }));
    const tr2 = trailer(st, a, 0.16, 0.5);
    s.run(0.55, 0.84, (u, q) => {
      put(a, spots[2](), B(), ease.inOutCubic(u));
      a.lift = st.sq * 0.16 * (1 - ease.inQuad(u));
      a.yawAdd = (1 - ease.outCubic(u)) * per * 2;
      if (!q.forced && u < 0.9) tr2();
    });
    settle(s, st, a, 0.84, B);
    return 0.97;
  },

  // King: slow, certain, and final — one overhead cleave.
  k(s, st, m, a, v, vsq, A, B) {
    const V = () => st.foot(vsq), D = () => dirOf(A(), V());
    const hit = () => along(V(), D(), -0.66 * st.sq);
    s.run(0, 0.3, (u) => {
      const d = D(), e = ease.inOutQuad(u);
      put(a, A(), hit(), e);
      a.lift = e * st.sq * 0.34; a.lean = -d.x * 0.26 * e - 0.05 * e;
      a.sx = 1 + 0.07 * e; a.sy = 1 + 0.07 * e;
    });
    s.run(0.3, 0.37, (u) => { a.jit = 1.2 * u; });
    s.run(0.37, 0.43, (u) => {
      const d = D(), e = ease.inCubic(u);
      a.jit = 0;
      a.lift = (1 - e) * st.sq * 0.34; a.lean = lerp(-d.x * 0.26, d.x * 0.3, e);
      a.sy = 1.07 - 0.2 * e; a.sx = 1.07 + 0.1 * e;
    });
    s.at(0.385, () => {
      if (s.forced) return;
      const p = V(), q = st.sq, h = st.height(v.type);
      st.fx.slash(p.x - q * 0.1, p.y - h - q * 1.25, p.x + q * 0.04, p.y + q * 0.2, { width: 0.21, bend: 0.05, life: 0.42, sweep: 0.05 });
      st.sfx('slash', 1);
    });
    s.at(0.43, () => {
      strike(s, st, v, vsq, {
        dir: { x: 0, y: 0.1 }, power: 1, burst: 1.7, up: 1.0, shake: 13, sdx: 0.1, sdy: 1, stop: 0.11,
        split: { nx: 1, ny: 0.06, slide: 0.42, hold: 0.2 }, sparks: 20, sparkDir: { x: 0, y: -1 }, sparkSpread: 2.6, sparkSpeed: 8,
        ripple: 1.7, flash: 1.5, intensity: 1,
      });
      if (s.forced) return;
      const p = V();
      st.fx.ring(p.x, p.y, { r0: 0.2, r1: 1.3, life: 0.4 });
    });
    s.run(0.43, 0.56, (u) => { const k = 1 - ease.outCubic(u); a.sy = 1 - 0.13 * k; a.sx = 1 + 0.17 * k; a.lean = D().x * 0.3 * k; });
    s.run(0.6, 0.9, (u) => {
      put(a, hit(), B(), ease.inOutQuad(u));
      a.lift = hop(u) * st.sq * 0.08;
    });
    s.at(0.9, () => {
      a.lift = 0;
      if (s.forced) return;
      const b = B();
      st.sfx('land', 0.7); st.ripple(b.x, b.y, 0.5); st.shakeBy(2, 0, 1);
    });
    settle(s, st, a, 0.9, B);
    return 1.06;
  },
};

// ---------------------------------------------------------------------------
// Promotion: the pawn unravels into a rising column and is spun back as the
// new piece.
// ---------------------------------------------------------------------------

function promote(s, st, m, a, B, t0) {
  const rise = 0.3, knit = 0.3;
  const colX = (b, r) => b.x + (r - 0.5) * st.sq * 0.2;
  const colY = (b, r) => b.y - (0.2 + r * 2.0) * st.sq;
  s.at(t0, () => {
    if (s.forced) return;
    const b = B(), c = st.cells(a), fx = st.fx, h = st.height('p');
    for (let i = 0; i < c.n; i++) {
      if (st.rm && i % 2) continue;
      const up = clamp((b.y - c.y[i]) / h);            // 0 at the foot, 1 at the head
      fx.home({
        sx: c.x[i], sy: c.y[i], tx: colX(b, fx.rnd()), ty: colY(b, fx.rnd()),
        life: rise * (0.8 + fx.rnd() * 0.5), delay: (1 - up) * 0.09, swirl: st.sq * 0.1,
        code: c.code[i], set: a.color, ci: c.shade[i], easeFn: ease.inOutQuad, fade: 0.8,
      });
    }
    for (let i = 0; i < (st.rm ? 6 : 18); i++) {
      const r = fx.rnd();
      fx.home({
        sx: colX(b, fx.rnd()), sy: b.y - fx.rnd() * st.sq * 0.4, tx: colX(b, fx.rnd()), ty: colY(b, 0.6 + 0.6 * fx.rnd()),
        life: 0.35 + r * 0.35, delay: fx.rnd() * 0.3, swirl: st.sq * 0.05,
        code: r < 0.5 ? 42 : r < 0.8 ? 124 : 43, set: r < 0.6 ? 'spark' : 'blade', ci: 0, cool: 3, easeFn: ease.outQuad, fade: 0.4, fadeIn: 0.15,
      });
    }
    a.hidden = true;
    st.sfx('promote', 1);
    st.flash(m.to, PAL.spark[0], 0.8);
  });
  s.at(t0 + rise - 0.03, () => {
    a.showType = null; a.lift = 0; a.lean = 0; a.sx = 1; a.sy = 1; a.pos = null;
    if (s.forced) return;
    a.hidden = true;
    const b = B(), fx = st.fx, c = st.cells(a), h = st.height(a.type), D = GLYPHS.decay;
    for (let i = 0; i < c.n; i++) {
      const up = clamp((b.y - c.y[i]) / h);
      fx.home({
        sx: colX(b, fx.rnd()), sy: colY(b, fx.rnd()), tx: c.x[i], ty: c.y[i],
        life: knit * (0.75 + fx.rnd() * 0.35), delay: up * 0.07, swirl: st.sq * 0.09,
        code: D.charCodeAt(4 + ((fx.rnd() * 6) | 0)), code1: c.code[i], morph: 0.55,
        set: a.color, ci: c.shade[i], easeFn: ease.inOutCubic, fadeIn: 0.2,
      });
    }
  });
  const tShow = t0 + rise + knit + 0.04;
  s.at(tShow, () => {
    a.hidden = false; a.showType = null;
    if (s.forced) return;
    const b = B();
    st.fx.ring(b.x, b.y, { r0: 0.15, r1: 1.2, life: 0.4, set: 'spark' });
    st.fx.sparks(b.x, b.y - st.height(a.type) * 0.6, st.rm ? 5 : 14, { speed: 5, spread: TAU, up: 1.2, life: 0.5 });
    st.ripple(b.x, b.y, 1.1); st.flash(m.to, PAL.spark[1], 1.2);
  });
  s.run(tShow, tShow + 0.22, (u) => {
    const k = 1 - ease.outElastic(u);
    a.glow = 1 - u; a.sy = 1 + 0.16 * k; a.sx = 1 - 0.08 * k;
  });
  return tShow + 0.22;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

// `a` mover, `v` victim (already moved to the ghost list) or null, `rook` for
// castling.  `off` = where the mover visually is, relative to its origin
// square's foot, in squares (non-zero after a drag-and-drop).
export function buildMove(st, m, a, v, rook, off, dropped) {
  const s = new Seq();
  a.busy = true;
  const A = () => { const f = st.foot(m.from); return { x: f.x + off.x * st.sq, y: f.y + off.y * st.sq }; };
  const B = () => st.foot(m.to);
  const kind = a.showType || a.type;
  let t;
  if (v) t = KILL[kind](s, st, m, a, v, v.sq, A, B);
  else if (m.castle) t = castle(s, st, m, a, rook, A, B);
  else if (dropped) t = drop(s, st, m, a, A, B);
  else t = QUIET[kind](s, st, m, a, A, B);
  if (m.promotion) t = promote(s, st, m, a, B, v ? t - 0.1 : t - 0.06);
  s.pad(t);
  s.end(() => { rest(a); if (rook) rest(rook); if (v) st.kill(v); });
  return s;
}

// New game: every piece condenses out of scattered glyphs, in a wave.
export function buildIntro(st, actors) {
  const s = new Seq();
  const D = '.,:;~+=';
  for (const a of actors) {
    a.hidden = true; a.busy = true;
    const col = st.col(a.sq), row = st.row(a.sq);
    const delay = 0.02 + col * 0.038 + (row < 4 ? row : 7 - row) * 0.07 + (row < 4 ? 0.05 : 0);
    const T = 0.5;
    s.at(delay, () => {
      if (s.forced) return;
      const c = st.cells(a), fx = st.fx, sq = st.sq;
      for (let i = 0; i < c.n; i++) {
        if (fx.rnd() > (st.rm ? 0.35 : 0.7)) continue;
        const r = fx.rnd(), ang = fx.rnd() * TAU, rad = (0.5 + fx.rnd() * 1.4) * sq;
        fx.home({
          sx: c.x[i] + Math.cos(ang) * rad, sy: c.y[i] + Math.sin(ang) * rad * 0.7 - sq * 0.5, tx: c.x[i], ty: c.y[i],
          life: T * (0.72 + r * 0.28), swirl: sq * 0.12, easeFn: ease.outCubic,
          code: D.charCodeAt((fx.rnd() * D.length) | 0), code1: c.code[i], morph: 0.5 + fx.rnd() * 0.35,
          set: a.color, ci: c.shade[i], fadeIn: 0.35,
        });
      }
    });
    s.at(delay + T, () => {
      a.hidden = false;
      if (!s.forced && (a.type === 'k' || a.type === 'q')) st.sfx('tick', 0.3);
    });
    s.run(delay + T, delay + T + 0.22, (u) => {
      const k = 1 - ease.outElastic(u);
      a.glow = 0.7 * (1 - u); a.sy = 1 + 0.08 * k;
    });
  }
  s.end(() => { for (const a of actors) rest(a); });
  return s;
}

// Checkmate: the king cracks, then crumbles from the crown down while the
// victors flare.
export function buildMate(st, actors, winner) {
  const s = new Seq();
  const king = actors.find((a) => a.type === 'k' && a.color !== winner);
  const winners = actors.filter((a) => a.color === winner);
  const K = () => (king ? st.foot(king.sq) : { x: 0, y: 0 });
  if (king) {
    king.busy = true;
    s.run(0, 0.5, (u) => { king.jit = u * u * 2.6; king.lean = Math.sin(u * 40) * 0.02 * u; });
    s.at(0.22, () => { if (!s.forced) { st.sfx('impact', 0.45); st.shakeBy(3, 1, 0); } });
    s.at(0.5, () => {
      king.fallen = true; king.hidden = true; king.jit = 0; king.lean = 0;
      if (s.forced) return;
      const k = K(), h = st.height('k'), top = k.y - h, c = st.cells(king), q = st.sq;
      st.stop(0.09); st.shakeBy(8, 0.3, 1);
      // the crack: a thin bright seam from crown to foot
      st.fx.slash(k.x + q * 0.07, top - q * 0.12, k.x - q * 0.05, k.y + q * 0.06, { width: 0.045, bend: 0.06, life: 0.6, sweep: 0.08 });
      st.fx.debris(c, {
        set: king.color, cx: k.x, cy: k.y - h * 0.5, groundY: k.y, dir: { x: 0, y: 0 }, power: 0, burst: 0.3, up: 0.25, jitter: 0.5,
        gravity: 5.5, spin: 7, life: 1.5, decayRate: 3.5, decayDelay: 3.5, persist: true, drag: 1.4,
        split: { nx: 1, ny: 0.1, slide: 0, hold: 0, gap: q * 0.03 },
        holdFn: (x, y, rnd) => 0.14 + clamp((y - top) / h) * 1.25 + rnd() * 0.2,
      });
      st.fx.sparks(k.x, k.y - h * 0.5, st.rm ? 6 : 16, { speed: 5, spread: TAU, up: 1 });
      st.ripple(k.x, k.y, 1.8, PAL.danger); st.flash(king.sq, PAL.danger, 1.5);
      st.sfx('impact', 1); st.sfx('shatter', 0.8);
    });
    s.at(1.2, () => { if (!s.forced) { st.sfx('shatter', 0.45); const k = K(); st.ripple(k.x, k.y, 0.9); } });
  }
  for (const w of winners) {
    const k = K(), f = st.foot(w.sq);
    const d = king ? Math.hypot(f.x - k.x, f.y - k.y) / st.sq : st.col(w.sq);
    const t0 = 0.75 + d * 0.1, per = st.period(w.type);
    w.busy = true;
    s.run(t0, t0 + 0.75, (u) => {
      w.glow = hop(u) * 0.9; w.lift = hop(u) * st.sq * 0.16;
      w.yawAdd = ease.inOutCubic(u) * per * Math.max(1, Math.round(TAU / per / 2));
    });
    s.at(t0 + 0.12, () => {
      if (s.forced || st.rm) return;
      const p = st.foot(w.sq);
      st.fx.sparks(p.x, p.y - st.height(w.type) * 0.7, 4, { speed: 3, spread: 1.4, up: 1.6, life: 0.6, gravity: 3 });
      st.flash(w.sq, st.tint(w.color), 0.5);
    });
  }
  s.pad(2.55);
  s.end(() => { for (const a of actors) rest(a); });
  return s;
}

// Stalemate / draws: one even pulse through both armies, then stillness.
export function buildDraw(st, actors) {
  const s = new Seq();
  const c = st.center();
  s.at(0, () => { if (!s.forced) { st.ripple(c.x, c.y, 1.3); } });
  for (const a of actors) {
    const f = st.foot(a.sq), d = Math.hypot(f.x - c.x, f.y - c.y) / st.sq;
    const t0 = 0.08 + d * 0.11;
    a.busy = true;
    s.run(t0, t0 + 0.7, (u) => {
      a.glow = hop(u) * 0.55; a.sy = 1 - 0.07 * hop(u); a.sx = 1 + 0.03 * hop(u);
      a.dim = lerp(1, 0.6, ease.inOutQuad(u));
    });
  }
  s.pad(1.5);
  s.end(() => { for (const a of actors) { rest(a); a.dim = 0.6; } });
  return s;
}
