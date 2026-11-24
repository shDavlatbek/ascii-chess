// Effects: glyph particles (debris, sparks, ghosts, homing motes), blade
// streaks, shockwave rings, screen shake and hit-stop.  All glyphs come from
// the shared atlas; brightness is globalAlpha only.

import { PAL, GLYPHS } from '../core/palette.js';
import { getAtlas } from '../core/glyphs.js';
import { TAU, clamp, lerp, ease } from '../core/util.js';

const DECAY = GLYPHS.decay;
const DECAY_N = DECAY.length;
const MAX_PARTICLES = 9000;

const PHYS = 0, HOME = 1, STILL = 2;

export function createFx() {
  const P = [];
  const slashes = [];
  const rings = [];
  const shake = { x: 0, y: 0 };
  let shakeAmp = 0, shakeDx = 0, shakeDy = 0, shakeT = 0;
  let stop = 0;
  let atl = null;
  let M = { fw: 5, fh: 7, fontPx: 9, dpr: 1, sq: 96 };
  let seed = 1234567;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function configure(metrics) {
    M = metrics;
    const { fontPx, dpr } = M;
    const mk = (pal, k) => pal.map((color) => getAtlas({ fontPx: Math.round(fontPx * k * 4) / 4, color, dpr }));
    atl = {
      w: [mk(PAL.bone, 1), mk(PAL.bone, 1.5)],
      b: [mk(PAL.ember, 1), mk(PAL.ember, 1.5)],
      blade: [mk(PAL.blade, 1.15), mk(PAL.blade, 1.9)],
      spark: [mk(PAL.spark, 1.35), mk(PAL.spark, 2.2)],
      dark: [mk(['#0b0b11'], 1.6), mk(['#0b0b11'], 2.4)],
    };
  }

  function push(p) {
    if (P.length >= MAX_PARTICLES) P.shift();
    P.push(p);
    return p;
  }

  const base = (o) => ({
    mode: PHYS, x: 0, y: 0, vx: 0, vy: 0, g: 0, drag: 0, rot: 0, vr: 0,
    age: 0, life: 1, delay: 0, code: 35, set: 'w', ci: 0, ci0: 0, big: 0,
    hold: 0, hvx: 0, hvy: 0, ground: Infinity, landed: false,
    decay: 0, di: -1, a0: 1, fade: 0.55, fadeIn: 0, persist: false,
    sx: 0, sy: 0, tx: 0, ty: 0, swirl: 0, easeFn: null, morph: 0, code1: 0,
    scale: 1, cool: 0,
    ...o,
  });

  // --- spawners ---------------------------------------------------------------

  // Break a piece's glyphs into physics debris.
  //   cells: { n, x[], y[], code[], shade[] } in world px
  //   o: { set, cx, cy, groundY, dir:{x,y}, power, burst, up, jitter, frac,
  //        split:{ nx, ny, slide, hold }, holdFn(x, y) -> seconds, gravity, life, persist }
  function debris(cells, o) {
    const sq = M.sq;
    const dir = o.dir || { x: 0, y: 0 };
    const power = (o.power ?? 3) * sq, burst = (o.burst ?? 1.5) * sq, up = (o.up ?? 1.5) * sq;
    const jitter = (o.jitter ?? 0.8) * sq, frac = o.frac ?? 1;
    const g = (o.gravity ?? 11) * sq;
    for (let i = 0; i < cells.n; i++) {
      if (frac < 1 && rnd() > frac) continue;
      const x = cells.x[i], y = cells.y[i];
      let rx = x - o.cx, ry = y - o.cy;
      const rl = Math.hypot(rx, ry) || 1; rx /= rl; ry /= rl;
      const sp = power * (0.25 + rnd() * 0.95);
      const bs = burst * (0.3 + rnd() * 0.9);
      let vx = dir.x * sp + rx * bs + (rnd() - 0.5) * jitter;
      let vy = dir.y * sp + ry * bs + (rnd() - 0.5) * jitter - up * rnd();
      let hold = 0, hvx = 0, hvy = 0;
      if (o.split) {
        const side = (x - o.cx) * o.split.nx + (y - o.cy) * o.split.ny >= 0 ? 1 : -1;
        hold = o.split.hold * (0.85 + rnd() * 0.3);
        // halves slide along the cut, in opposite directions, and part slightly
        hvx = (-o.split.ny * side * o.split.slide + o.split.nx * side * o.split.slide * 0.5) * sq;
        hvy = (o.split.nx * side * o.split.slide + o.split.ny * side * o.split.slide * 0.5) * sq;
        vx += o.split.nx * side * burst * 0.5;
        vy += o.split.ny * side * burst * 0.5;
      }
      if (o.holdFn) { hold = o.holdFn(x, y, rnd); hvx = 0; hvy = 0; }
      const life = (o.life ?? 1.05) * (0.7 + rnd() * 0.6);
      push(base({
        x, y, vx, vy, g, drag: o.drag ?? 0.9,
        rot: 0, vr: rnd() < 0.6 ? (rnd() - 0.5) * (o.spin ?? 16) : 0,
        life: life + hold, hold, hvx, hvy,
        code: cells.code[i], set: o.set, ci: cells.shade[i], ci0: cells.shade[i],
        ground: o.groundY + (rnd() * 0.5 - 0.12) * sq + dir.y * sp * 0.14 + Math.max(0, y - o.groundY),
        decay: (o.decayRate ?? 8) * (0.6 + rnd() * 0.8), di: -(o.decayDelay ?? 1.6) - rnd() * 1.5,
        persist: !!o.persist, cool: 1,
      }));
    }
  }

  // Orange sparks.
  function sparks(x, y, n, o = {}) {
    const sq = M.sq, dir = o.dir || null, speed = (o.speed ?? 5) * sq, spread = o.spread ?? TAU;
    const baseA = dir ? Math.atan2(dir.y, dir.x) : -Math.PI / 2;
    const set = o.set || 'spark';
    for (let i = 0; i < n; i++) {
      const a = baseA + (rnd() - 0.5) * spread, sp = speed * (0.25 + rnd() * rnd() * 1.1);
      const r = rnd();
      push(base({
        x: x + (rnd() - 0.5) * sq * (o.scatter ?? 0.12), y: y + (rnd() - 0.5) * sq * (o.scatter ?? 0.12),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (o.up ?? 0.6) * sq,
        g: (o.gravity ?? 7) * sq, drag: 2.6,
        life: (o.life ?? 0.42) * (0.5 + rnd() * 0.9), delay: (o.delaySpread ?? 0) * rnd(),
        code: r < 0.62 ? 42 : r < 0.8 ? 43 : r < 0.92 ? 120 : 46,       // * + x .
        set, ci: 0, ci0: 0, big: rnd() < (o.bigChance ?? 0.45) ? 1 : 0,
        fade: 0.35, cool: 4,
      }));
    }
  }

  // A motionless glyph that fades — trails and afterimages.
  function ghost(x, y, code, set, ci, life = 0.24, alpha = 0.7) {
    push(base({ mode: STILL, x, y, code, set, ci, ci0: ci, life, a0: alpha, fade: 0, decay: 14, di: -1.2 }));
  }

  // A glyph that flies from (sx, sy) to (tx, ty).
  function home(o) {
    return push(base({ mode: HOME, x: o.sx, y: o.sy, fade: 1.1, ...o }));
  }

  // Generic physics glyph.
  function mote(o) { return push(base(o)); }

  // Pink blade streak: a tapered ribbon of glyphs swept from (x0,y0) to (x1,y1).
  function slash(x0, y0, x1, y1, o = {}) {
    const { fw, fh, sq } = M;
    const width = (o.width ?? 0.15) * sq, bend = o.bend ?? 0.12;
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    const cxp = (x0 + x1) / 2 + px * bend * len, cyp = (y0 + y1) / 2 + py * bend * len;
    const pts = [];
    const stepU = (fw * 0.95) / len;
    for (let u = 0; u <= 1; u += stepU) {
      const v = 1 - u;
      const bx = v * v * x0 + 2 * v * u * cxp + u * u * x1, by = v * v * y0 + 2 * v * u * cyp + u * u * y1;
      let tx = 2 * v * (cxp - x0) + 2 * u * (x1 - cxp), ty = 2 * v * (cyp - y0) + 2 * u * (y1 - cyp);
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      // blade profile: swells quickly, tapers to a long point
      const hw = width * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 0.8);
      const ang = Math.abs(Math.atan2(ty, tx));
      const horiz = ang < 0.42 || ang > Math.PI - 0.42, vert = Math.abs(ang - Math.PI / 2) < 0.42;
      const edge = horiz ? 61 : vert ? 124 : (tx * ty > 0 ? 92 : 47);        // = | \ /
      const edge2 = horiz ? 45 : vert ? 33 : edge;                              // - !
      const rows = Math.max(0, Math.floor(hw / (fh * 0.62)));
      for (let k = -rows; k <= rows; k++) {
        const w = rows ? k / rows : 0, aw = Math.abs(w);
        const r = rnd();
        const core = aw < 0.45;
        const code = core ? (r < 0.3 ? 35 : r < 0.55 ? 78 : r < 0.8 ? 90 : edge) : (r < 0.7 ? edge : edge2);
        pts.push({
          x: bx - ty * w * hw + (rnd() - 0.5) * fw * 0.3, y: by + tx * w * hw + (rnd() - 0.5) * fw * 0.3,
          u, code, ci: core ? (r < 0.5 ? 0 : 1) : aw < 0.8 ? 1 : 2, big: core && rows >= 1 && r < 0.25 ? 1 : 0,
          j: rnd(),
        });
      }
    }
    slashes.push({ pts, t: 0, life: o.life ?? 0.3, sweep: o.sweep ?? 0.06, delay: o.delay ?? 0 });
  }

  // Shockwave: an ellipse of glyphs lying on the ground plane.
  function ring(x, y, o = {}) {
    rings.push({
      x, y, t: 0, life: o.life ?? 0.45, r0: (o.r0 ?? 0.2) * M.sq, r1: (o.r1 ?? 1.5) * M.sq,
      squash: o.squash ?? 0.42, set: o.set || 'blade', delay: o.delay ?? 0,
    });
  }

  function addShake(amp, dx = 0, dy = 0) {
    if (amp <= 0) return;
    if (amp >= shakeAmp) { shakeDx = dx; shakeDy = dy; }
    shakeAmp = Math.max(shakeAmp, amp);
  }
  function hitstop(sec) { stop = Math.max(stop, sec); }

  // Real dt in → scaled dt out (hit-stop freezes the world for a few frames).
  function timeScale(dtReal) {
    if (stop > 0) { stop -= dtReal; return 0.03; }
    return 1;
  }

  // --- simulation -------------------------------------------------------------

  function update(dt, dtReal) {
    // shake runs in real time so the freeze frame still rattles
    shakeT += dtReal;
    if (shakeAmp > 0.05) {
      const s1 = Math.sin(shakeT * 91), s2 = Math.sin(shakeT * 67 + 1.3), s3 = Math.sin(shakeT * 113 + 0.7);
      // whole device pixels: the world stays crisp (and cheap to blit) while it rattles
      const d = M.dpr || 1;
      shake.x = Math.round(shakeAmp * (shakeDx * s1 + 0.45 * s2) * d) / d;
      shake.y = Math.round(shakeAmp * (shakeDy * s1 + 0.45 * s3) * d) / d;
      shakeAmp *= Math.exp(-dtReal * 11);
    } else { shake.x = 0; shake.y = 0; shakeAmp = 0; }

    const h = Math.min(dt, 0.05);
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      if (p.delay > 0) { p.delay -= h; continue; }
      p.age += h;
      if (p.age >= p.life && !(p.persist && p.landed)) {
        if (p.onDone) p.onDone(p);
        P[i] = P[P.length - 1]; P.pop();
        continue;
      }
      if (p.mode === HOME) {
        const u = clamp(p.age / p.life), e = (p.easeFn || ease.inOutCubic)(u);
        const sw = Math.sin(u * Math.PI) * p.swirl;
        p.x = lerp(p.sx, p.tx, e) + Math.sin(u * 9 + p.sy) * sw;
        p.y = lerp(p.sy, p.ty, e) + Math.cos(u * 7 + p.sx) * sw * 0.5;
        if (p.morph && u > p.morph && p.code1) p.code = p.code1;
        continue;
      }
      if (p.mode === STILL) {
        if (p.decay) { p.di += p.decay * h; if (p.di >= 0) p.code = DECAY.charCodeAt(Math.min(DECAY_N - 1, p.di | 0)); }
        continue;
      }
      if (p.hold > 0) {
        p.hold -= h;
        p.x += p.hvx * h; p.y += p.hvy * h;
        continue;
      }
      if (p.landed) {
        // sink into the field
        p.y += M.sq * 0.05 * h;
      } else {
        p.vy += p.g * h;
        const dk = Math.exp(-p.drag * h);
        p.vx *= dk; p.vy *= dk;
        p.x += p.vx * h; p.y += p.vy * h;
        p.rot += p.vr * h;
        if (p.y >= p.ground && p.vy > 0) {
          if (p.vy > M.sq * 2.2) { p.vy *= -0.28; p.vx *= 0.5; p.vr *= 0.4; p.y = p.ground; }
          else { p.landed = true; p.vx = 0; p.vy = 0; p.vr = 0; p.rot = 0; }
        }
      }
      if (p.decay) {
        p.di += p.decay * h;
        if (p.di >= 0) p.code = DECAY.charCodeAt(Math.min(DECAY_N - 1, p.di | 0));
      }
      if (p.cool) {
        const u = p.age / p.life;
        p.ci = Math.min(p.set === 'spark' ? 3 : 5, p.ci0 + ((u * p.cool * 3) | 0));
      }
    }
    for (let i = slashes.length - 1; i >= 0; i--) {
      const s = slashes[i];
      if (s.delay > 0) { s.delay -= h; continue; }
      s.t += h;
      if (s.t > s.life + s.sweep) slashes.splice(i, 1);
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      if (r.delay > 0) { r.delay -= h; continue; }
      r.t += h;
      if (r.t > r.life) rings.splice(i, 1);
    }
  }

  // --- drawing ----------------------------------------------------------------

  function draw(ctx) {
    if (!atl) return;
    const prev = ctx.globalAlpha;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (p.delay > 0) continue;
      const u = p.age / p.life;
      let a = p.a0;
      if (p.persist && p.landed) a *= 0.5;
      else if (p.fade < 1) a *= 1 - clamp((u - p.fade) / (1 - p.fade));
      if (p.fadeIn) a *= clamp(u / p.fadeIn);
      if (p.mode === STILL) a *= 1 - u;
      if (a <= 0.02) continue;
      const set = atl[p.set][p.big];
      const atlas = set[Math.min(p.ci, set.length - 1)];
      ctx.globalAlpha = a > 1 ? 1 : a;
      if (p.rot) {
        const c = Math.cos(p.rot), s = Math.sin(p.rot);
        ctx.save();
        ctx.transform(c, s, -s, c, p.x, p.y);
        atlas.drawCode(ctx, p.code, 0, 0);
        ctx.restore();
      } else if (p.scale !== 1) atlas.drawScaled(ctx, p.code, p.x, p.y, p.scale);
      else atlas.drawCode(ctx, p.code, p.x, p.y);
    }

    for (const r of rings) {
      if (r.delay > 0) continue;
      const u = r.t / r.life, e = ease.outCubic(u);
      const rad = lerp(r.r0, r.r1, e);
      const set = atl[r.set][0];
      const n = Math.max(10, Math.floor((TAU * rad * 0.8) / (M.fw * 1.5)));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU + r.x * 0.01;
        const cs = Math.cos(a), sn = Math.sin(a);
        const flick = (Math.sin(k * 12.9898 + r.t * 40) * 43758.5453) % 1;
        if (Math.abs(flick) < u * 0.8) continue;
        ctx.globalAlpha = (1 - u) * (1 - u) * (0.55 + 0.45 * Math.abs(sn));
        const code = Math.abs(cs) > 0.86 ? (cs > 0 ? 41 : 40) : Math.abs(sn) > 0.8 ? 61 : (cs * sn > 0 ? 92 : 47);
        set[u < 0.3 ? 0 : u < 0.6 ? 1 : 2].drawCode(ctx, code, r.x + cs * rad, r.y + sn * rad * r.squash);
        if (u < 0.5) set[1].drawCode(ctx, 45, r.x + cs * rad * 0.86, r.y + sn * rad * 0.86 * r.squash);
      }
    }

    for (const s of slashes) {
      if (s.delay > 0) continue;
      const head = s.t / s.sweep;
      for (let k = 0; k < s.pts.length; k++) {
        const q = s.pts[k];
        if (q.u > head) break;
        const age = (s.t - q.u * s.sweep) / s.life;        // 0 fresh .. 1 gone
        if (age >= 1) continue;
        const a = 1 - age * age;
        // late in life the ribbon breaks up
        if (age > 0.35 && q.j < (age - 0.35) * 1.5) continue;
        ctx.globalAlpha = a;
        const ci = Math.min(3, q.ci + (age * 3.2 | 0));
        const code = age > 0.6 ? (q.j < 0.5 ? 58 : 46) : q.code;
        atl.blade[q.big][ci].drawCode(ctx, code, q.x, q.y);
      }
    }
    ctx.globalAlpha = prev;
  }

  // A dark blob of glyphs: the shadow under a piece that has left the ground.
  function shadow(ctx, x, y, w, alpha) {
    if (!atl || alpha <= 0.02) return;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = Math.min(1, alpha);
    const a = atl.dark[0][0], n = Math.max(2, Math.round(w / (M.fw * 1.5)));
    for (let k = 0; k < n; k++) {
      const u = n > 1 ? k / (n - 1) - 0.5 : 0;
      a.drawCode(ctx, 61, x + u * w, y);
      if (Math.abs(u) < 0.3) a.drawCode(ctx, 35, x + u * w, y + M.fh * 0.5);
    }
    ctx.globalAlpha = prev;
  }

  function clear() {
    P.length = 0; slashes.length = 0; rings.length = 0;
    stop = 0; shakeAmp = 0; shake.x = 0; shake.y = 0;
  }

  return {
    configure, update, draw, clear, timeScale, shadow,
    debris, sparks, ghost, home, mote, slash, ring, addShake, hitstop,
    shake, rnd,
    get count() { return P.length; },
    get busy() { return P.length > 0 || slashes.length > 0 || rings.length > 0; },
  };
}
