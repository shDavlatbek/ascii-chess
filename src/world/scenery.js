// Scenery around the board: warm architecture drifting through the top band
// and creeping down the sides (stamped into the field's own cell grid), thin
// hanging vines, rain, embers, and the vignette.
//
// Everything here stays clear of the board itself and runs dim and sparse
// under the HUD panels (`layout.panels`), which will carry text.

import { PAL, GLYPHS } from '../core/palette.js';
import { getAtlas } from '../core/glyphs.js';
import { clamp, hash2, rng, rgba, TAU } from '../core/util.js';
import { C } from './field.js';

const K = (ch) => ch.charCodeAt(0);
const VINE = Array.from(GLYPHS.vine, K);       // t ! * | ; :
const SPARK = Array.from(GLYPHS.spark, K);     // * + x .

// Hand-made fragments, in the spirit of the reference: signs, lintels, brackets.
const FRAGMENTS = ['[==]', '[=]=[', ']==-', '=[]=', '[I]', 'I#', 'H#', '|=|', '==[', 'NNN', 'HHII', '[=]', 'H=H', '#I#', 'MWM', 'N#=', '=]', '[#]'];

export function createScenery(field) {
  let L = null, sizeKey = '';
  let structs = [], strands = [], fgStrands = [], drops = [], embers = [];
  let vignette = null, redGlow = null;
  let period = 1, stampedKey = '';
  let smallPx = 8, smallStep = 9, midPx = 10;
  let R = rng(1);

  // ------------------------------------------------------- architecture --

  function shape(maxW, maxH) {
    const cells = [];
    if (R() < 0.34) {
      const s = FRAGMENTS[Math.floor(R() * FRAGMENTS.length)].slice(0, maxW);
      for (let x = 0; x < s.length; x++) cells.push({ x, y: 0, g: K(s[x]), lamp: s[x] === '#' });
      return { w: s.length, h: 1, cells };
    }
    const w = Math.min(maxW, 2 + Math.floor(R() * R() * 8));
    const h = Math.min(maxH, 1 + Math.floor(R() * R() * 3.4));
    const main = 'HHHNNMW'[Math.floor(R() * 7)], other = main === 'H' ? 'N' : 'H';
    for (let y = 0; y < h; y++) {
      const roof = y === 0 && h > 1 && w > 2 && R() < 0.5;
      const legs = y === h - 1 && h > 2 && R() < 0.6;
      for (let x = 0; x < w; x++) {
        let chr;
        if (roof) chr = x === 0 ? '[' : x === w - 1 ? ']' : '=';
        else if (legs) chr = x === 0 || x === w - 1 || (w > 5 && x === (w >> 1)) ? (R() < 0.5 ? 'I' : '|') : ' ';
        else {
          const u = R();
          chr = u < 0.46 ? main : u < 0.6 ? other : u < 0.7 ? '#' : u < 0.77 ? 'I' : u < 0.83 ? '=' : u < 0.87 ? '|' : u < 0.94 ? '[' : ' ';
          if (chr === '[') {
            if (x >= w - 1) chr = main;
            else { cells.push({ x, y, g: K('['), lamp: true }); x++; chr = ']'; cells.push({ x, y, g: K(']'), lamp: true }); continue; }
          }
        }
        if (chr !== ' ') cells.push({ x, y, g: K(chr), lamp: chr === '#' });
      }
    }
    return { w, h, cells };
  }

  function tone() {
    const u = R();
    return u < 0.5 ? C.W2 : u < 0.78 ? C.W1 : u < 0.92 ? C.W3 : C.EDGE;
  }

  function generateArchitecture() {
    structs = [];
    const { cols, rows } = L, b = L.board;
    period = cols + 18;

    // Sky lane: rows above the reach of the back-rank pieces' heads; these drift.
    const headRow = b.r0 - 2;                              // tallest pieces poke up to here
    const skyMax = L.portrait ? clamp(Math.round(rows * 0.17), 1, Math.max(1, headRow - 1)) : Math.max(0, headRow);
    const laneRows = skyMax + 1;
    const count = Math.round((cols * laneRows) / (L.portrait ? 16 : 11));
    for (let k = 0; k < count; k++) {
      const depth = R() ** 1.5;                            // top-heavy
      const row = Math.min(skyMax, Math.floor(depth * laneRows));
      const sh = shape(L.portrait ? 6 : 9, Math.max(1, Math.min(3, skyMax - row + 1)));
      structs.push({
        ...sh, row, x: R() * period, speed: (0.05 + 0.11 * R()) * (R() < 0.12 ? -0.5 : 1),
        col: tone(), alpha: 0.98 - 0.42 * (row / Math.max(1, laneRows)) * (L.portrait ? 1 : 0.3), u: R(), fixed: false,
      });
    }

    // Side structures: creep down the left and right margins, thinning with depth; these stay put.
    const leftMax = b.c0 - 5, rightMin = b.c0 + b.cols + 4;
    const zones = [];
    if (leftMax >= 0) zones.push([0, leftMax, 0]);
    if (rightMin < cols) zones.push([rightMin, cols - 1, 1]);
    const bottom = Math.round(rows * (L.portrait ? 0.86 : 0.74));
    for (const [z0, z1, side] of zones) {
      const zw = z1 - z0 + 1;
      const tries = Math.round((zw * (bottom - skyMax)) / (L.portrait ? 5 : 9));
      for (let k = 0; k < tries; k++) {
        const depth = R();                                 // 0 at the top of the side, 1 at its foot
        const outer = R() ** 1.7;                          // 0 hugging the screen edge
        if (R() > (1 - depth) ** 1.5 * (1 - 0.72 * outer) + 0.04) continue;
        const sh = shape(Math.min(8, zw), 3);
        const span = Math.max(0, zw - sh.w);
        const c = side === 0 ? z0 + Math.round(outer * span) : z1 - sh.w + 1 - Math.round(outer * span);
        const row = skyMax + 1 + Math.round(depth * (bottom - skyMax - 1));
        structs.push({ ...sh, row, x: c, speed: 0, col: tone(), alpha: 0.9 - 0.5 * depth, u: R(), fixed: true });
      }
    }
    stampedKey = '';
  }

  function stampArchitecture() {
    let key = '';
    for (const s of structs) if (!s.fixed) key += Math.floor(s.x) + ',';
    if (key === stampedKey) return;
    stampedKey = key;
    const b = L.board, headRow = b.r0 - 2;
    const bl = b.c0 - 3, br = b.c0 + b.cols + 2;
    field.archBegin();
    for (const s of structs) {
      const c0 = s.fixed ? s.x : Math.floor(s.x) - 9;
      if (c0 >= L.cols || c0 + s.w < 0) continue;
      for (const cell of s.cells) {
        const c = c0 + cell.x, r = s.row + cell.y;
        let a = s.alpha;
        if (r >= headRow && c >= bl && c <= br) a *= 0.42;   // right behind the back rank: stay quiet
        field.archStamp(c, r, cell.g, cell.lamp && s.col !== C.EDGE ? C.W1 : s.col, a, cell.lamp);
      }
    }
    field.archEnd();
  }

  // --------------------------------------------------------------- vines --

  function panelAt(x, y) {
    let cov = 0;
    const ps = L.panels || {};
    for (const k in ps) {
      const p = ps[k];
      if (!p || p.w <= 0 || p.h <= 0) continue;
      const d = Math.min(x - p.x, p.x + p.w - x, y - p.y, p.y + p.h - y);
      cov = Math.max(cov, clamp(d / (L.cw * 1.5) + 0.5));
    }
    return cov;
  }

  function makeStrand(x, lenPx, step, fg) {
    const len = Math.floor(lenPx / step);
    if (len < 2) return null;
    const glyph = new Uint8Array(len), tint = new Uint8Array(len), dim = new Float32Array(len);
    const thin = R() < 0.3;                               // some strands are just a thread of | and :
    for (let k = 0; k < len; k++) {
      const u = R();
      if (thin) glyph[k] = u < 0.6 ? K('|') : u < 0.85 ? K(':') : K('!');
      else glyph[k] = u < 0.46 ? K('t') : u < 0.6 ? K('!') : u < 0.72 ? K('|') : u < 0.82 ? K(';') : u < 0.9 ? K(':') : K('*');
      tint[k] = glyph[k] === 42 ? 1 : 0;                  // blossoms are brighter
      dim[k] = 1 - 0.3 * panelAt(x, k * step);
    }
    if (!thin && len > 4) { glyph[len - 1] = K('*'); tint[len - 1] = fg ? 1 : 2; }   // a bud at the tip
    return { x, len, glyph, tint, dim, ph: R() * 40, amp: (0.5 + R()) * step * (fg ? 0.9 : 0.55), rate: 0.35 + 0.4 * R(), thin };
  }

  function generateStrands() {
    strands = []; fgStrands = [];
    const { W, H, sq, cw } = L, b = L.board;
    smallPx = Math.max(8, Math.round(L.fontPx * 0.62));
    smallStep = smallPx * 1.08;
    midPx = Math.max(9, Math.round(L.fontPx * 0.74));
    const count = clamp(Math.round(W / (sq * 1.45)), 5, 15);
    for (let k = 0; k < count; k++) {
      const x = ((k + 0.12 + 0.76 * R()) / count) * W;
      const overBoard = x > b.x - cw * 3 && x < b.x + b.size + cw * 3;
      const lenPx = overBoard ? Math.min(H * 0.26, b.y - sq * 0.82) * (0.55 + 0.45 * R()) : H * (0.12 + 0.36 * R() * R());
      const s = makeStrand(x, lenPx, smallStep, false);
      if (s) strands.push(s);
      if (s && !s.thin && R() < 0.45) {                    // a companion thread right beside it
        const t = makeStrand(x + (R() < 0.5 ? -1 : 1) * smallPx * (0.7 + 0.5 * R()), lenPx * (0.4 + 0.5 * R()), smallStep, false);
        if (t) strands.push(t);
      }
    }
    // Foreground strands: a couple of darker, larger ones framing the far edges.
    const step = midPx * 1.08;
    const margin = Math.max(4, b.x - cw * 2.5);
    const spots = [0.012 * W + R() * Math.min(margin * 0.5, W * 0.035), W - 0.012 * W - R() * Math.min(margin * 0.5, W * 0.035)];
    if (!L.portrait && margin > sq * 2) spots.push(W * (0.07 + 0.03 * R()));
    for (const x of spots) {
      const s = makeStrand(clamp(x, 3, W - 3), H * (0.24 + 0.3 * R()), step, true);
      if (s) fgStrands.push(s);
    }
  }

  function drawStrand(ctx, s, step, atl, t, gain) {
    const pulseAt = ((t * s.rate * 6 + s.ph) % (s.len + 14)) - 2;
    for (let k = 0; k < s.len; k++) {
      const f = k / s.len;
      const sway = Math.sin(t * 0.55 + s.ph + k * 0.24) * s.amp * f * Math.sqrt(f);
      const d = Math.abs(k - pulseAt);
      let a = (0.95 - 0.4 * f) * s.dim[k] * gain;
      if (d < 2.5) a += (1 - d / 2.5) * 0.4 * s.dim[k];
      if (a < 0.03) continue;
      ctx.globalAlpha = a > 1 ? 1 : a;
      atl[s.tint[k]].drawCode(ctx, s.glyph[k], s.x + sway, -smallPx * 0.2 + (k + 0.5) * step);
    }
  }

  // ---------------------------------------------------------------- rain --

  function generateRain() {
    drops = [];
    const total = clamp(Math.round(L.W / (L.sq * 0.75)), 8, 30);
    for (let k = 0; k < total; k++) drops.push({ on: false, fg: k % 4 === 0, wait: R() * 3, x: 0, y: 0, v: 0, floor: 0, a: 0, len: 2 });
  }

  function spawnDrop(d) {
    const { W, H, sq, cw } = L, b = L.board;
    d.x = R() * W;
    const overBoard = d.x > b.x - cw * 3 && d.x < b.x + b.size + cw * 3;
    d.floor = d.fg ? H * (0.55 + 0.5 * R()) : overBoard ? b.y - sq * 0.75 : H * (0.4 + 0.6 * R());
    d.y = -smallStep * (1 + 3 * R());
    d.v = sq * (1.1 + 1.5 * R()) * (d.fg ? 1.5 : 1);
    d.len = 2 + Math.floor(R() * 3);
    d.a = (d.fg ? 0.2 : 0.5) * (0.6 + 0.4 * R());
    d.on = true;
  }

  function drawDrops(ctx, atl, fg) {
    for (const d of drops) {
      if (!d.on || d.fg !== fg) continue;
      const fade = clamp((d.floor - d.y) / (smallStep * 4)) * clamp((d.y + smallStep * 2) / (smallStep * 3));
      const dim = fg ? 1 : 1 - 0.5 * panelAt(d.x, d.y);
      for (let k = 0; k < d.len; k++) {
        const a = d.a * fade * dim * (1 - k / d.len);
        if (a < 0.03) continue;
        ctx.globalAlpha = a;
        atl[0].drawCode(ctx, k === 0 ? 33 /* ! */ : k === 1 ? 124 /* | */ : 58 /* : */, d.x, d.y - k * smallStep);
      }
    }
  }

  // -------------------------------------------------------------- embers --

  function generateEmbers() {
    embers = [];
    const base = clamp(Math.round((L.W * L.H) / (L.sq * L.sq * 13)), 6, 16);
    for (let k = 0; k < Math.ceil(base * 3.4); k++) embers.push({ on: false, fg: k % 4 === 3, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, seed: R() * 100, hot: false });
    embers.base = base;
  }

  function spawnEmber(e, P) {
    const { W, H, sq } = L;
    const rising = R() < P.rise;
    e.x = R() * W;
    e.y = rising ? H * (0.5 + 0.55 * R()) : H * (0.12 + 0.8 * R());
    e.vx = (R() - 0.62) * sq * 0.22;
    e.vy = -(0.04 + 0.1 * R()) * sq - (rising ? (0.35 + 0.5 * R()) * sq : 0);
    e.life = 0;
    e.max = rising ? 3.5 + 3 * R() : 3 + 5 * R();
    e.hot = R() < 0.3;
    e.on = true;
  }

  function drawEmbers(ctx, atl, t, fg) {
    for (const e of embers) {
      if (!e.on || e.fg !== fg) continue;
      const f = e.life / e.max;
      const env = Math.sin(Math.PI * f) ** 0.7;
      const flick = 0.66 + 0.34 * Math.sin(t * 8 + e.seed * 7);
      const a = env * flick * (fg ? 0.9 : 0.95) * (1 - 0.35 * panelAt(e.x, e.y));
      if (a < 0.04) continue;
      const g = f > 0.86 ? SPARK[3] : f > 0.68 ? SPARK[1] : hash2(Math.floor(t * 3 + e.seed), 1, 2) < 0.14 ? SPARK[2] : SPARK[0];
      ctx.globalAlpha = a;
      atl[e.hot ? 1 : 0].drawCode(ctx, g, e.x, e.y);
    }
  }

  // ------------------------------------------------------------ vignette --

  function radial(inner, stops) {
    const S = 256;
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S) : Object.assign(document.createElement('canvas'), { width: S, height: S });
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, inner * S / 2, S / 2, S / 2, S * Math.SQRT1_2);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    return cv;
  }

  // ----------------------------------------------------------------- api --

  function resize(layout) {
    L = layout;
    const key = `${L.W}x${L.H}|${L.cols}x${L.rows}|${L.cw}|${L.board.c0},${L.board.r0}`;
    if (key !== sizeKey) {
      // A flip keeps the scenery exactly as it was; a real resize rebuilds it.
      sizeKey = key;
      R = rng(0x5eed + L.cols * 131 + L.rows * 17);
      generateArchitecture();
      generateStrands();
      generateRain();
      generateEmbers();
    }
    stampedKey = '';
    stampArchitecture();
    if (!vignette) {
      vignette = radial(0.3, [[0, 'rgba(6,6,10,0)'], [0.45, 'rgba(6,6,10,0.16)'], [0.8, 'rgba(6,6,10,0.5)'], [1, 'rgba(6,6,10,0.8)']]);
      redGlow = radial(0.5, [[0, rgba(PAL.danger, 0)], [0.55, rgba(PAL.danger, 0.1)], [1, rgba(PAL.danger, 0.42)]]);
    }
  }

  function update(env) {
    if (!L) return;
    const P = env.p, dt = env.dt, slow = env.reduced ? 0.4 : 1;

    // Architecture drifts a cell at a time, each structure on its own beat.
    const drift = dt * slow * (0.6 + 0.6 * P.arch) * (0.5 + 0.5 * Math.min(2, P.flow));
    for (const s of structs) {
      if (s.fixed) continue;
      s.x += s.speed * drift;
      if (s.x >= period) s.x -= period; else if (s.x < 0) s.x += period;
    }
    stampArchitecture();

    // Rain.
    const wantDrops = Math.round(drops.length * clamp(P.rain) * (env.reduced ? 0.5 : 1));
    let live = 0;
    for (const d of drops) {
      if (d.on) {
        d.y += d.v * dt * slow;
        if (d.y > d.floor) { d.on = false; d.wait = 0.3 + R() * 2.5; }
        else live++;
      }
    }
    for (const d of drops) {
      if (d.on || live >= wantDrops) continue;
      d.wait -= dt;
      if (d.wait <= 0) { spawnDrop(d); live++; }
    }

    // Embers.
    const want = Math.round(embers.base * P.embers);
    let alive = 0;
    for (const e of embers) {
      if (!e.on) continue;
      e.life += dt * slow;
      if (e.life >= e.max || e.y < -20) { e.on = false; continue; }
      alive++;
      e.x += (e.vx + Math.sin(env.now * 0.9 + e.seed) * L.sq * 0.12) * dt * slow;
      e.y += e.vy * dt * slow;
    }
    if (alive < want) {
      for (const e of embers) {
        if (e.on) continue;
        if (R() < dt * (0.8 + 2.5 * P.embers)) { spawnEmber(e, P); alive++; }
        if (alive >= want) break;
      }
    }
  }

  function drawBack(ctx, env) {
    if (!L) return;
    const dpr = L.dpr || 1, t = env.now * (env.reduced ? 0.4 : 1), P = env.p;
    const prev = ctx.globalAlpha;
    const fade = 1 - 0.45 * P.grey;
    const small = [
      getAtlas({ fontPx: smallPx, color: PAL.field[2], dpr }),
      getAtlas({ fontPx: smallPx, color: PAL.field[0], dpr }),
      getAtlas({ fontPx: smallPx, color: PAL.warm[2], dpr }),
    ];
    for (const s of strands) drawStrand(ctx, s, smallStep, small, t, fade);
    drawDrops(ctx, small, false);
    const sparks = [getAtlas({ fontPx: midPx, color: PAL.spark[2], dpr }), getAtlas({ fontPx: midPx, color: PAL.spark[1], dpr })];
    drawEmbers(ctx, sparks, env.now, false);
    ctx.globalAlpha = prev;
  }

  function drawFront(ctx, env) {
    if (!L) return;
    const dpr = L.dpr || 1, t = env.now * (env.reduced ? 0.4 : 1), P = env.p;
    const prev = ctx.globalAlpha;
    const dark = [
      getAtlas({ fontPx: midPx, color: PAL.field[4], dpr }),
      getAtlas({ fontPx: midPx, color: PAL.field[2], dpr }),
    ];
    for (const s of fgStrands) drawStrand(ctx, s, midPx * 1.08, dark, t * 0.8 + 3, 1.15);
    drawDrops(ctx, [getAtlas({ fontPx: smallPx, color: PAL.field[2], dpr })], true);
    const sparks = [getAtlas({ fontPx: midPx, color: PAL.spark[2], dpr }), getAtlas({ fontPx: midPx, color: PAL.spark[1], dpr })];
    drawEmbers(ctx, sparks, env.now, true);

    // Vignette (oversized so a screen shake never shows its edge), then the danger glow.
    const m = 48;
    ctx.globalAlpha = clamp(0.8 * P.vig);
    ctx.drawImage(vignette, -m, -m, L.W + m * 2, L.H + m * 2);
    if (P.red > 0.01) {
      const beat = env.reduced ? 0.8 : 0.72 + 0.28 * Math.sin(env.now * 2.6);
      ctx.globalAlpha = clamp(P.red * 0.5 * beat);
      ctx.drawImage(redGlow, -m, -m, L.W + m * 2, L.H + m * 2);
    }
    ctx.globalAlpha = prev;
  }

  return { resize, update, drawBack, drawFront };
}
