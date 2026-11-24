// The field: one coarse grid of glyphs covering the whole screen.
//
// Every cell picks its glyph and brightness from slowly drifting flow noise on
// its own staggered clock, so the surface shimmers and currents travel across
// it without ever flickering.  The chess board is simply the region where the
// glyph family and tint alternate per square; beyond a thin moat of void the
// field thins out into a sparse dark plain.  Architecture cells (stamped in by
// scenery.js) live in the same grid.
//
// Rendering: the base look of every cell is cached on a handful of offscreen
// tiles.  Only cells whose look changed are repainted, and only a couple of
// tiles are touched per frame, round-robin — a canvas that was drawn from and
// then modified has to be re-snapshotted by the browser, so touching the whole
// cache every frame would cost a full-screen copy.  Glyphs change a few times
// a second at most, so a tile lagging ~100 ms is invisible.  Highlights,
// flashes and ripples are per-frame "fx": cells an effect touches are "hot"
// and are painted straight onto the main canvas over the tiles, so the cache
// never has to follow an animation.
//
// The vignette and the danger glow are baked into this cache (each cell's
// patch of void gets its own slightly darker / redder shade and its glyph is
// dimmed to match) instead of being composited over the screen: same look,
// no full-screen blend per frame, and it can never dim a piece.

import { PAL, GLYPHS } from '../core/palette.js';
import { getAtlas } from '../core/glyphs.js';
import { clamp, smoothstep, hash2, noise3, hexToRgb, mix, sqFile, sqRank, TAU } from '../core/util.js';

const Z_VOID = 0, Z_OUT = 1, Z_LIGHT = 2, Z_DARK = 3;

const codes = (s) => Array.from(s, (ch) => ch.charCodeAt(0));
const K = (ch) => ch.charCodeAt(0);
const frac = (v) => v - Math.floor(v);

const LIGHT = codes(GLYPHS.lightSq);
// Light squares have to out-shine the dark ones even though their family is the lighter-inked
// one, so the heavier members of the family ('+', '~') come up more often than ':' and ';'.
const LIGHT_W = (() => {
  const heavy = LIGHT.filter((g) => g === 43 || g === 126), thin = LIGHT.filter((g) => g !== 43 && g !== 126);
  if (!heavy.length || !thin.length) return LIGHT;
  const out = [];
  for (let k = 0, h = 0, t = 0; k < 14; k++) out.push(k % 4 === 3 ? thin[t++ % thin.length] : heavy[h++ % heavy.length]);
  return out;       // thin glyphs are spaced out so they never pool into a dim patch
})();
const DARK = codes(GLYPHS.darkSq);
const OUTSIDE = codes(GLYPHS.outside);
const DECAY = codes(GLYPHS.decay);
const RING = codes('>\\v/<\\^/');        // glyph shoved outwards by a ripple, by octant (E, SE, S, ...)

// The whole field draws from this small colour set (one glyph atlas each).
export const C = {
  LIGHT: 0, DARK: 1, BRIGHT: 2, EDGE: 3,
  W0: 4, W1: 5, W2: 6, W3: 7,
  SELECT: 8, TARGET: 9, CAPTURE: 10, LAST: 11, DANGER: 12,
  GREY: 13, COOL: 14,
};
const BASE_COLORS = [
  PAL.lightSq, PAL.darkSq, PAL.field[0], PAL.boardEdge,
  PAL.warm[0], PAL.warm[1], PAL.warm[2], PAL.warm[3],
  PAL.select, PAL.target, PAL.capture, PAL.last, PAL.danger,
  '#9a9aa6',      // mate: drained
  '#7f9fc4',      // draw: cold
];
const TILE_COLS = 27, TILE_ROWS = 11;   // target tile size in cells
const TILES_PER_FRAME = 2;              // tiles repainted per frame (the rest wait their turn)
const MAX_CUSTOM = 6;                   // extra colours callers may pass to ripple() / flash()
const VOID_DEEP = '#050508';            // what the void falls to in the corners
const V_LEVELS = 24, R_LEVELS = 24;     // void shades: vignette depth × danger glow (≈ 1 RGB step each)

export function createField() {
  let L = null;
  let cols = 0, rows = 0, n = 0;
  let cw = 1, ch = 1, ox = 0, oy = 0, dpr = 1;

  // Offscreen cache tiles (device pixels, no transform).
  let tiles = [], tileOf = null, nextTile = 0;
  let dx = null, dy = null, dw = 0, dh = 0;
  let atlases = [];
  const colors = BASE_COLORS.slice();

  // Static per-cell data.
  let zone, ccol, crow, rnd, panel, edge, nearB, vig, glow, bgi;
  const bgStyles = [];
  // Base look (what the flow noise decided at the cell's last refresh).
  let gl, col, al, tk, tc, nextT, jit;
  // Architecture stamps (owned by scenery.js through arch*()).
  let aGl, aCol, aAl, aLamp, bGl, bCol, bAl, bLamp;
  // Per-frame fx.
  let fxK, fxC, fxAbs, fxAdd, fxG, hotStamp, hotA, hotB, hotCount = 0;
  let dirty;
  let frame = 1;
  let U = 1;               // cache-pixel → current context unit (1 when drawing in device pixels)

  // Shared clock + mood dials, owned by index.js and read here by reference.
  let env = { now: 0, flowT: 0, dt: 0, p: null, moving: false, reduced: false };
  const seen = new Uint8Array(64);
  const ripples = [];
  const flashes = [];
  const last = { key: '', t: -1e9 };
  const hover = { sq: null, t: 0 };

  // ---------------------------------------------------------------- setup --

  function resize(layout, initialEnv) {
    L = layout;
    if (initialEnv) env = initialEnv;
    cols = L.cols; rows = L.rows; n = cols * rows;
    cw = L.cw; ch = L.ch; ox = L.ox; oy = L.oy; dpr = L.dpr || 1;

    zone = new Uint8Array(n); ccol = new Uint16Array(n); crow = new Uint16Array(n);
    rnd = new Float32Array(n); panel = new Float32Array(n); edge = new Float32Array(n); nearB = new Float32Array(n);
    vig = new Float32Array(n); glow = new Float32Array(n); bgi = new Uint16Array(n);
    gl = new Uint8Array(n); col = new Uint8Array(n); al = new Float32Array(n);
    tk = new Float32Array(n); tc = new Uint8Array(n); nextT = new Float32Array(n); jit = new Float32Array(n);
    aGl = new Uint8Array(n); aCol = new Uint8Array(n); aAl = new Float32Array(n); aLamp = new Uint8Array(n);
    bGl = new Uint8Array(n); bCol = new Uint8Array(n); bAl = new Float32Array(n); bLamp = new Uint8Array(n);
    fxK = new Float32Array(n); fxC = new Uint8Array(n); fxAbs = new Float32Array(n).fill(-1);
    fxAdd = new Float32Array(n); fxG = new Uint8Array(n); hotStamp = new Uint32Array(n);
    hotA = new Int32Array(n); hotB = new Int32Array(n); hotCount = 0;
    dirty = new Uint8Array(n); tileOf = new Uint8Array(n);

    const b = L.board, bc1 = b.c0 + b.cols, br1 = b.r0 + b.rows;
    const mx = Math.max(1, L.W / 2 - b.size / 2), bcx = b.x + b.size / 2;
    const myTop = Math.max(1, b.y), myBot = Math.max(1, L.H - b.y - b.size);
    const panels = Object.values(L.panels || {}).filter((p) => p && p.w > 0 && p.h > 0);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        ccol[i] = c; crow[i] = r;
        rnd[i] = hash2(c, r, 7);
        const inBoard = c >= b.c0 && c < bc1 && r >= b.r0 && r < br1;
        if (inBoard) {
          const sc = Math.floor((c - b.c0) / L.sqCols), sr = Math.floor((r - b.r0) / L.sqRows);
          // a1 is dark and sits bottom-left unflipped: (sc + sr) even ⇒ light.  Flipping keeps parity.
          zone[i] = (sc + sr) % 2 === 0 ? Z_LIGHT : Z_DARK;
        } else if (c >= b.c0 - 2 && c < bc1 + 2 && r >= b.r0 - 1 && r < br1 + 1) {
          zone[i] = Z_VOID;                // the moat that gives the board its edge
        } else {
          zone[i] = Z_OUT;
        }
        const x = L.cellX(c), y = L.cellY(r);
        let cov = 0;
        for (const p of panels) {
          const d = Math.min(x - p.x, p.x + p.w - x, y - p.y, p.y + p.h - y);
          cov = Math.max(cov, clamp(d / (cw * 1.5) + 0.5));
        }
        panel[i] = cov;
        const ex = Math.max(0, Math.abs(x - bcx) - b.size / 2) / mx;
        const ey = y < b.y ? (b.y - y) / myTop : y > b.y + b.size ? (y - b.y - b.size) / myBot : 0;
        edge[i] = smoothstep(0.1, 1, Math.max(ex, ey));
        const ddx = Math.max(0, b.x - x, x - b.x - b.size), ddy = Math.max(0, b.y - y, y - b.y - b.size);
        nearB[i] = 1 - clamp(Math.hypot(ddx, ddy) / (L.sq * 2.6));
        vig[i] = vignetteAt(x, y);
        // Where the danger glow gathers in check: the rim of the screen, never the board.
        const rim = Math.max(Math.abs(x - L.W / 2) / (L.W / 2), Math.abs(y - L.H / 2) / (L.H / 2));
        glow[i] = smoothstep(0.62, 1.08, rim) ** 1.2 * clamp(Math.hypot(ddx, ddy) / (L.sq * 2.2));
      }
    }

    // Device-pixel cell edges: every cell owns a whole-pixel rectangle.
    dx = new Int32Array(cols + 1); dy = new Int32Array(rows + 1);
    for (let c = 0; c <= cols; c++) dx[c] = Math.round((ox + c * cw) * dpr);
    for (let r = 0; r <= rows; r++) dy[r] = Math.round((oy + r * ch) * dpr);
    dw = Math.round(cw * dpr); dh = Math.round(ch * dpr);

    // Cache tiles: an even grid of cell blocks, each with its own canvas and dirty list.
    const tx = Math.max(1, Math.round(cols / TILE_COLS)), ty = Math.max(1, Math.round(rows / TILE_ROWS));
    const tcw = Math.ceil(cols / tx), trh = Math.ceil(rows / ty);
    tiles = [];
    for (let j = 0; j < ty; j++) {
      for (let i = 0; i < tx; i++) {
        const c0 = i * tcw, r0 = j * trh, c1 = Math.min(cols, c0 + tcw), r1 = Math.min(rows, r0 + trh);
        if (c0 >= c1 || r0 >= r1) continue;
        const w = dx[c1] - dx[c0], h = dy[r1] - dy[r0];
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
        // Opaque tiles: the void colour is baked in, so blitting one is a plain copy.
        const g = canvas.getContext('2d', { alpha: false });
        g.fillStyle = PAL.bg;
        g.fillRect(0, 0, w, h);
        const id = tiles.length;
        tiles.push({ canvas, g, x: dx[c0], y: dy[r0], w, h, list: new Int32Array((c1 - c0) * (r1 - r0)), count: 0 });
        for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) tileOf[r * cols + c] = id;
      }
    }
    nextTile = 0;
    atlases = [];

    ripples.length = 0; flashes.length = 0;
    if (env.p) { refreshAll(); flushSome(tiles.length); }
  }

  // Vignette strength at a point: 0 on and around the board, deepening towards the corners.
  function vignetteAt(x, y) {
    const b = L.board;
    const d = Math.hypot((x - L.W / 2) / (L.W / 2), (y - L.H / 2) / (L.H / 2)) * Math.SQRT1_2;
    const away = clamp(Math.hypot(Math.max(0, b.x - x, x - b.x - b.size), Math.max(0, b.y - y, y - b.y - b.size)) / (L.sq * 2.2));
    return 0.66 * smoothstep(0.3, 1, d) ** 1.3 * away;
  }

  function bgStyle(k) {
    return bgStyles[k] || (bgStyles[k] = mix(mix(PAL.bg, VOID_DEEP, (k % V_LEVELS) / (V_LEVELS - 1)), PAL.danger, 0.17 * Math.floor(k / V_LEVELS) / (R_LEVELS - 1)));
  }

  function refreshAll() {
    for (let i = 0; i < n; i++) {
      gl[i] = 0; al[i] = 0; bgi[i] = 65535;
      refresh(i);
      // first intervals are spread out so the cadence starts staggered
      nextT[i] = env.now + (nextT[i] - env.now) * rnd[(i * 7 + 3) % n];
    }
  }

  function atlas(ci) {
    let a = atlases[ci];
    if (a) return a;
    const src = getAtlas({ fontPx: L.fontPx, color: colors[ci], dpr });
    const sw = Math.min(dw, src.cellW), sh = Math.min(dh, src.cellH);
    a = atlases[ci] = {
      src, canvas: src.canvas, cellW: src.cellW, sw, sh,
      sx0: Math.floor((src.cellW - sw) / 2), sy0: Math.floor((src.cellH - sh) / 2),
      ox: Math.floor((dw - sw) / 2), oy: Math.floor((dh - sh) / 2),
    };
    return a;
  }

  // Map an arbitrary hex colour to a colour index without minting unbounded atlases.
  function colorIndex(hex, fallback) {
    if (typeof hex !== 'string' || hex[0] !== '#' || hex.length !== 7) return fallback;
    const lower = hex.toLowerCase();
    let i = colors.indexOf(lower);
    if (i >= 0) return i;
    if (colors.length < BASE_COLORS.length + MAX_CUSTOM) { colors.push(lower); return colors.length - 1; }
    const [r, g, b] = hexToRgb(lower);
    let best = fallback, bd = Infinity;
    for (let j = 0; j < colors.length; j++) {
      const [r2, g2, b2] = hexToRgb(colors[j]);
      const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }

  // ------------------------------------------------------------ base look --

  function markDirty(i) {
    if (!dirty[i]) { dirty[i] = 1; const t = tiles[tileOf[i]]; t.list[t.count++] = i; }
  }

  function refresh(i) {
    const z = zone[i];
    const P = env.p, now = env.now, ft = env.flowT;
    const c = ccol[i], r = crow[i], rn = rnd[i];

    // This cell's patch of void: vignette depth and, in check, a red glow from the edges.
    const vv = Math.min(0.95, vig[i] * P.vig);
    const bk = Math.round(vv * (V_LEVELS - 1)) + V_LEVELS * Math.round(clamp(P.red * glow[i]) * (R_LEVELS - 1));
    if (bk !== bgi[i]) { bgi[i] = bk; markDirty(i); }
    if (z === Z_VOID) { nextT[i] = now + (env.moving ? 0.1 + 0.3 * rn : 2 + 3 * rn); return; }

    // Soft travelling bands of brightness shared by the whole field.
    const b0 = 0.62 * noise3(c * 0.055 - ft * 0.11, r * 0.13 + ft * 0.02, ft * 0.045, 11)
             + 0.38 * noise3(c * 0.19 - ft * 0.23, r * 0.42, ft * 0.09, 23);
    const lift = (smoothstep(0.3, 0.7, b0) - 0.5) * P.band;

    let g = 0, ci = 0, a = 0, iv = 1;
    if (aGl[i]) {
      // Architecture: glows in patches, lantern cells flicker on their own.
      const pd = 1 - panel[i] * (1 - P.unpanel) * 0.5;
      const glow = noise3(c * 0.21 + 9, r * 0.55, now * 0.3, 97);
      g = aGl[i]; ci = aCol[i];
      a = aAl[i] * (0.6 + 0.55 * glow) * P.arch * pd;
      if (aLamp[i]) {
        const f = hash2(i, Math.floor(now * 1.4 + rn * 8), 5);
        a *= 0.72 + 0.5 * f;
        if (f > 0.8) ci = C.W0;
        iv = 0.3 + 0.7 * rn;
      } else {
        iv = 0.7 + 1.3 * rn;
      }
    } else if (z === Z_LIGHT) {
      const nz = noise3(c * 0.17 - ft * 0.33, r * 0.83 + 5.3, ft * 0.07, 37);
      g = LIGHT_W[Math.floor(frac(nz * 3.1 + rn * 0.14) * LIGHT_W.length)];
      ci = C.LIGHT;
      a = (0.94 + 0.2 * lift) * P.board;
      iv = 0.45 + 1.0 * rn;
    } else if (z === Z_DARK) {
      const nz = noise3(c * 0.15 - ft * 0.4, r * 0.77 + 17.1, ft * 0.06, 41);
      g = DARK[Math.floor(frac(nz * 3.3 + rn * 0.1) * DARK.length)];
      ci = C.DARK;
      a = (0.46 + 0.16 * lift) * P.board;
      iv = 0.45 + 1.0 * rn;
    } else {
      // The plain beyond the board: sparse, dark, with big empty patches.
      const pn = panel[i] * (1 - P.unpanel);
      iv = 0.8 + 1.6 * rn;
      if (rn >= 0.2 + 0.2 * pn) {
        const dens = noise3(c * 0.075 + ft * 0.012, r * 0.2 - ft * 0.008, ft * 0.02, 53);
        const thr = 0.57 - 0.21 * nearB[i] + 0.05 * pn - 0.07 * (P.out - 1);
        if (dens > thr) {
          const nz = noise3(c * 0.12 - ft * 0.1, r * 1.31, ft * 0.04, 71);
          g = OUTSIDE[Math.floor(frac(nz * 2.7 + rn * 0.1) * OUTSIDE.length)];
          ci = C.DARK;
          a = clamp(0.3 + 1.7 * (dens - thr) + 0.25 * lift) * P.out * (1 - 0.42 * pn) * (0.72 + 0.28 * nearB[i]);
        }
      }
    }

    // Mood tint: grey drains, cool chills, red creeps in from the screen edges.
    let mk = 0, mc = 0;
    if (g) {
      if (P.grey > 0.01) { mk = P.grey * 0.8; mc = C.GREY; a *= 1 - 0.08 * P.grey; }
      if (P.cool > 0.01 && P.cool * 0.6 > mk) { mk = P.cool * 0.6; mc = C.COOL; }
      if (P.red > 0.01) {
        const e = z === Z_OUT ? edge[i] : edge[i] * 0.2;
        const fingers = noise3(c * 0.1, r * 0.22, now * 0.35, 61) - 0.5;
        const creep = clamp((e + fingers * 0.5 - (1 - P.red * 0.8)) / 0.45) * 0.72;
        if (creep > mk) { mk = creep; mc = C.DANGER; }
      }
    }

    // Agitation left behind by a ripple: scrambled glyphs that settle quickly.
    let cad = P.cadence * (env.reduced ? 1.7 : 1);
    if (jit[i] > 0.06) {
      const j = jit[i];
      if (g && !aGl[i]) {
        const fam = z === Z_LIGHT ? LIGHT : z === Z_DARK ? DARK : OUTSIDE;
        g = fam[Math.floor(hash2(i, Math.floor(now * 23), 3) * fam.length)];
        a = Math.min(1, a + j * 0.25);
      }
      jit[i] = j * 0.5;
      iv = 0.1 + 0.16 * rn; cad = 1;
    } else if (jit[i] !== 0) {
      jit[i] = 0;
    }

    a *= 1 - vv;
    if (a < 0.03) { g = 0; a = 0; }
    if (g !== gl[i] || ci !== col[i] || mc !== tc[i] || Math.abs(a - al[i]) > 0.015 || Math.abs(mk - tk[i]) > 0.02) {
      gl[i] = g; col[i] = ci; al[i] = a; tk[i] = mk; tc[i] = mc;
      markDirty(i);
    }
    // While a mood cross-fades every cell re-reads its look quickly.
    if (env.moving) iv = Math.min(iv * cad, 0.1 + 0.3 * rn); else iv *= cad;
    nextT[i] = now + iv;
  }

  // ------------------------------------------------------------- drawing --

  // Base look → cache tile (device pixels).
  function blit(g2, ci, g, x0, y0, a) {
    const at = atlases[ci] || atlas(ci);
    g2.globalAlpha = a > 1 ? 1 : a;
    g2.drawImage(at.canvas, (g - 33) * at.cellW + at.sx0, at.sy0, at.sw, at.sh, x0 + at.ox, y0 + at.oy, at.sw, at.sh);
  }

  function flushTile(t) {
    const g2 = t.g, list = t.list, count = t.count;
    g2.globalAlpha = 1;
    let shade = -1;
    for (let j = 0; j < count; j++) {
      const i = list[j], c = ccol[i], r = crow[i];
      if (bgi[i] !== shade) { shade = bgi[i]; g2.fillStyle = bgStyle(shade); }
      g2.fillRect(dx[c] - t.x, dy[r] - t.y, dx[c + 1] - dx[c], dy[r + 1] - dy[r]);
    }
    for (let j = 0; j < count; j++) {
      const i = list[j];
      dirty[i] = 0;
      const g = gl[i];
      if (!g) continue;
      const a = al[i] > 1 ? 1 : al[i];
      if (a < 0.025) continue;
      const x0 = dx[ccol[i]] - t.x, y0 = dy[crow[i]] - t.y;
      // Base colour then mood tint, source-over; the base alpha is corrected for the tint covering it.
      const a1 = a * tk[i];
      if (a1 < 0.97 && tk[i] < 0.965) blit(g2, col[i], g, x0, y0, (a - a1) / (1 - a1));
      if (a1 > 0.02) blit(g2, tc[i], g, x0, y0, a1);
    }
    t.count = 0;
  }

  // Repaint up to `max` tiles that have pending changes, continuing where the last frame stopped.
  function flushSome(max) {
    const nt = tiles.length;
    for (let k = 0; k < nt && max > 0; k++) {
      const t = tiles[(nextTile + k) % nt];
      if (!t.count) continue;
      flushTile(t);
      max--;
      if (max === 0) { nextTile = (nextTile + k + 1) % nt; return; }
    }
  }

  // Hot cells → main canvas, on top of the layer: hide the cached glyph, paint the fx look.
  function stamp(ctx, ci, g, i, a) {
    const at = atlases[ci] || atlas(ci);
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.drawImage(at.canvas, (g - 33) * at.cellW + at.sx0, at.sy0, at.sw, at.sh,
      (dx[ccol[i]] + at.ox) * U, (dy[crow[i]] + at.oy) * U, at.sw * U, at.sh * U);
  }

  function paintHot(ctx) {
    const list = hotA;
    ctx.globalAlpha = 1;
    // Hide the cached glyphs: runs of neighbouring cells in one shade become a single rectangle.
    let shade = -1, run = -1, runEnd = -1;
    for (let j = 0; j <= hotCount; j++) {
      const i = j < hotCount ? list[j] : -2;
      if (i === runEnd + 1 && run >= 0 && bgi[i] === shade && ccol[i] !== 0) { runEnd = i; continue; }
      if (run >= 0) {
        const c0 = ccol[run], c1 = ccol[runEnd] + 1, r = crow[run];
        ctx.fillRect(dx[c0] * U, dy[r] * U, (dx[c1] - dx[c0]) * U, (dy[r + 1] - dy[r]) * U);
      }
      if (i < 0) break;
      if (bgi[i] !== shade) { shade = bgi[i]; ctx.fillStyle = bgStyle(shade); }
      run = runEnd = i;
    }
    for (let j = 0; j < hotCount; j++) {
      const i = list[j];
      const g = fxG[i] || gl[i];
      if (!g) continue;
      let a = (fxAbs[i] >= 0 ? fxAbs[i] : al[i]) + fxAdd[i];
      if (a < 0.025) continue;
      if (a > 1) a = 1;
      // Three colours (base, mood tint, fx tint) mixed with weights k0 / k1 / k2.  Painted
      // back to front with plain source-over, so each alpha is corrected for what covers it.
      const k2 = fxK[i] > 1 ? 1 : fxK[i];
      const k1 = tk[i] * (1 - k2);
      const k0 = 1 - k1 - k2;
      const a2 = a * k2;
      const a1 = a2 < 0.98 ? (a * k1) / (1 - a2) : 0;
      if (k0 > 0.06 && a2 < 0.98 && a1 < 0.98) stamp(ctx, col[i], g, i, (a * k0) / ((1 - a1) * (1 - a2)));
      if (a1 > 0.04) stamp(ctx, tc[i], g, i, a1);
      if (a2 > 0.04) stamp(ctx, fxC[i], g, i, a2);
    }
  }

  // ------------------------------------------------------------------ fx --

  function beginFx() {
    frame++;
    // Cells that were hot last frame drop back to their cached base look.
    const prev = hotA;
    for (let j = 0; j < hotCount; j++) {
      const i = prev[j];
      fxK[i] = 0; fxAbs[i] = -1; fxAdd[i] = 0; fxG[i] = 0;
    }
    hotA = hotB; hotB = prev; hotCount = 0;
  }

  function touch(i) {
    if (hotStamp[i] !== frame) {
      hotStamp[i] = frame;
      hotA[hotCount++] = i;
    }
  }

  // Later effects override earlier ones.  k < 0 / abs < 0 / g = 0 leave that channel alone.
  function set(i, ci, k, abs, g) {
    touch(i);
    if (k >= 0) { fxK[i] = k; fxC[i] = ci; }
    if (abs >= 0) fxAbs[i] = abs;
    if (g) fxG[i] = g;
  }

  // Index of the top-left cell of a square's 6 × 3 block, or -1.
  function block(sq) {
    if (typeof sq !== 'string' || sq.length !== 2) return -1;
    const f = sqFile(sq), rk = sqRank(sq);
    if (f < 0 || f > 7 || rk < 0 || rk > 7) return -1;
    const cell = L.squareCell(sq);
    if (cell.c < 0 || cell.r < 0 || cell.c + 6 > cols || cell.r + 3 > rows) return -1;
    return cell.r * cols + cell.c;
  }

  const isPerim = (i, j) => j !== 1 || i === 0 || i === 5;
  // Position 0..13 walking clockwise round the block's rim.
  const rimPos = (i, j) => (j === 0 ? i : j === 1 ? (i === 5 ? 6 : 13) : 12 - i);

  function hlLast(sq, heat, isTo, t) {
    const b = block(sq); if (b < 0) return;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) {
      const idx = b + j * cols + i;
      const rim = isPerim(i, j);
      const breathe = 0.9 + 0.1 * Math.sin(t * 1.3 + rnd[idx] * TAU);
      const k = heat * (rim ? (isTo ? 0.95 : 0.85) : (isTo ? 0.7 : 0.55)) * breathe;
      // dark squares are lifted so the trace reads equally on both tints
      set(idx, C.LAST, k, Math.min(1, Math.max(al[idx], 0.62) + 0.3 * heat), 0);
    }
  }

  function hlHover(sq, amt) {
    const b = block(sq); if (b < 0) return;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) {
      const idx = b + j * cols + i;
      set(idx, C.BRIGHT, 0.55 * amt, Math.min(1, al[idx] + 0.3 * amt), 0);
    }
  }

  function hlQuiet(sq, phase, hovered) {
    const b = block(sq); if (b < 0) return;
    const pulse = 0.5 + 0.5 * Math.sin(phase);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) {
      const idx = b + j * cols + i;
      if (j === 1 && (i === 2 || i === 3)) {
        const open = hovered || pulse > 0.82;
        set(idx, C.TARGET, 1, 0.62 + 0.38 * pulse, open ? (i === 2 ? K('<') : K('>')) : (i === 2 ? K('(') : K(')')));
      } else if (j === 1 && (i === 1 || i === 4)) {
        set(idx, 0, -1, 0, 0);                         // clear a little air round the marker
      } else {
        set(idx, C.TARGET, hovered ? 0.5 : 0.1 + 0.1 * pulse, -1, 0);
      }
    }
  }

  function hlCapture(sq, phase, hovered) {
    const b = block(sq); if (b < 0) return;
    const pulse = 0.5 + 0.5 * Math.sin(phase);
    const bite = pulse > 0.55;                          // jaws close
    for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) {
      const idx = b + j * cols + i;
      let g = 0, a = -1, k = hovered ? 0.8 : 0.5 + 0.2 * pulse;
      if (i === 0 || i === 5) {
        g = j === 0 ? (i === 0 ? K('\\') : K('/')) : j === 2 ? (i === 0 ? K('/') : K('\\')) : (i === 0 ? K('>') : K('<'));
        k = 1; a = 0.7 + 0.3 * pulse;
      } else if ((i === 1 || i === 4) && j === 1 && bite) {
        g = i === 1 ? K('>') : K('<'); k = 1; a = 0.95;
      } else if (j === 2) {
        g = (i + (bite ? 1 : 0)) % 2 ? K('x') : K('!'); k = 1; a = 0.55 + 0.4 * pulse;
      }
      set(idx, C.CAPTURE, k, a, g);
    }
  }

  function hlSelected(sq, t, reduced) {
    const b = block(sq); if (b < 0) return;
    const pulse = 0.5 + 0.5 * Math.sin(t * (reduced ? 2 : 4.2));
    const chase = reduced ? -99 : (t * 10) % 14;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) {
      const idx = b + j * cols + i;
      if (isPerim(i, j)) {
        let d = Math.abs(rimPos(i, j) - chase); if (d > 7) d = 14 - d;
        const spark = Math.max(0, 1 - d / 3);
        const g = i === 0 ? K('[') : i === 5 ? K(']') : K('=');
        set(idx, C.SELECT, 1, Math.min(1, 0.5 + 0.25 * pulse + 0.5 * spark), spark > 0.7 ? K('#') : g);
      } else {
        set(idx, C.SELECT, 0.22 + 0.16 * pulse, -1, 0);
      }
    }
  }

  function hlCheck(sq, t, reduced) {
    const b = block(sq); if (b < 0) return;
    const ctr = L.squareCenter(sq);
    const R = L.sq * 2.5, lambda = L.sq * 1.25, hz = reduced ? 0.35 : 1.1;
    const c0 = Math.max(0, Math.floor((ctr.x - R - ox) / cw)), c1 = Math.min(cols - 1, Math.floor((ctr.x + R - ox) / cw));
    const r0 = Math.max(0, Math.floor((ctr.y - R - oy) / ch)), r1 = Math.min(rows - 1, Math.floor((ctr.y + R - oy) / ch));
    for (let r = r0; r <= r1; r++) {
      const yy = oy + (r + 0.5) * ch - ctr.y;
      for (let c = c0; c <= c1; c++) {
        const idx = r * cols + c;
        if (!gl[idx]) continue;
        const xx = ox + (c + 0.5) * cw - ctr.x;
        const d = Math.hypot(xx, yy);
        if (d > R) continue;
        let w = 0.5 + 0.5 * Math.cos(TAU * (d / lambda - t * hz));
        w = w * w;
        const fall = (1 - d / R) ** 1.1;
        const k = (reduced ? 0.5 : 0.95) * w * fall;
        if (k < 0.09) continue;
        touch(idx);
        if (k > fxK[idx]) { fxK[idx] = k; fxC[idx] = C.DANGER; }
        fxAdd[idx] += 0.4 * w * fall;
      }
    }
    const beat = 0.5 + 0.5 * Math.sin(t * (reduced ? 2.2 : 6.5));
    const step = Math.floor(t * 7);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) {
      const idx = b + j * cols + i;
      const alarm = !reduced && isPerim(i, j) && (rimPos(i, j) + step) % 3 === 0;
      set(idx, C.DANGER, 0.74 + 0.26 * beat, Math.max(al[idx], 0.8 + 0.2 * beat), alarm ? K('!') : 0);
      fxAdd[idx] = 0;
    }
  }

  function applyFlashes(reduced) {
    for (const f of flashes) {
      const b = block(f.sq); if (b < 0) continue;
      const p = f.age / f.dur, e = (1 - p) * (1 - p);
      const gain = (reduced ? 0.35 : 1) * Math.min(1, 0.55 + 0.45 * f.s);
      const tick = Math.floor(f.age * 30);
      const reach = f.s > 1.2 ? 1 : 0;               // strong flashes spill one cell over the rim
      for (let j = -reach; j < 3 + reach; j++) for (let i = -reach; i < 6 + reach; i++) {
        const idx = b + j * cols + i;
        if (idx < 0 || idx >= n) continue;
        const cc = ccol[b] + i; if (cc < 0 || cc >= cols) continue;
        const inside = i >= 0 && i < 6 && j >= 0 && j < 3;
        if (!inside && !gl[idx]) continue;
        const k = e * gain * (inside ? 1 : 0.5);
        if (k < 0.03) continue;
        touch(idx);
        if (k >= fxK[idx]) { fxK[idx] = Math.min(1, k * 1.15); fxC[idx] = f.c; }
        const base = fxAbs[idx] >= 0 ? fxAbs[idx] : al[idx];
        fxAbs[idx] = Math.max(base, Math.min(1, k * 1.2));
        if (!reduced && inside && hash2(idx, tick, 9) < e * 0.85) {
          fxG[idx] = DECAY[Math.min(DECAY.length - 1, Math.floor(p * DECAY.length * 0.8 + hash2(idx, tick, 4) * 3))];
        }
      }
    }
  }

  function applyRipples(reduced) {
    const now = env.now;
    for (const rp of ripples) {
      const p = rp.age / rp.dur;
      const rad = rp.R * (1 - (1 - p) * (1 - p));
      const amp = Math.min(1.1, 0.5 + 0.5 * rp.s) * (1 - p) ** 1.25 * (reduced ? 0.4 : 1);
      const w = rp.w, reach = rad + w * 2.3;
      const c0 = Math.max(0, Math.floor((rp.x - reach - ox) / cw)), c1 = Math.min(cols - 1, Math.floor((rp.x + reach - ox) / cw));
      const r0 = Math.max(0, Math.floor((rp.y - reach - oy) / ch)), r1 = Math.min(rows - 1, Math.floor((rp.y + reach - oy) / ch));
      const wake = rad - w * 2.6;
      for (let r = r0; r <= r1; r++) {
        const yy = oy + (r + 0.5) * ch - rp.y;
        for (let c = c0; c <= c1; c++) {
          const xx = ox + (c + 0.5) * cw - rp.x;
          const d = Math.hypot(xx, yy);
          const q = (d - rad) / w;
          let A = 0;
          if (q > -2.3 && q < 2.3) A = amp * Math.exp(-q * q);
          if (wake > 0) {
            const q2 = (d - wake) / w;
            if (q2 > -2 && q2 < 2) A += 0.32 * amp * Math.exp(-q2 * q2);
          }
          if (A < 0.05) continue;
          const idx = r * cols + c;
          const z = zone[idx];
          if (z === Z_VOID) continue;
          const empty = !gl[idx];
          if (empty && A < 0.22) continue;
          touch(idx);
          fxAdd[idx] = Math.min(1, fxAdd[idx] + A * (empty ? 0.6 : 0.8));
          const k = Math.min(1, A * 1.15);
          if (k > fxK[idx]) { fxK[idx] = k; fxC[idx] = rp.c; }
          if (!reduced && (A > 0.36 || empty)) {
            fxG[idx] = empty && A < 0.36 ? K(':') : RING[Math.round(Math.atan2(yy, xx) / (Math.PI / 4)) & 7];
          } else if (empty) {
            fxG[idx] = K('.');
          }
          if (A > 0.3 && !reduced && A > jit[idx]) {
            jit[idx] = A;
            const soon = now + 0.05 + 0.2 * rnd[idx];
            if (nextT[idx] > soon) nextT[idx] = soon;
          }
        }
      }
    }
  }

  // ------------------------------------------------------------- per frame --

  function update(e) {
    if (e) env = e;
    if (!L || !env.p) return;
    const now = env.now;
    for (let i = 0; i < n; i++) if (nextT[i] <= now) refresh(i);
    for (let j = ripples.length - 1; j >= 0; j--) { ripples[j].age += env.dt; if (ripples[j].age >= ripples[j].dur) ripples.splice(j, 1); }
    for (let j = flashes.length - 1; j >= 0; j--) { flashes[j].age += env.dt; if (flashes[j].age >= flashes[j].dur) flashes.splice(j, 1); }
  }

  // Make every cell pick up a new mood within a fraction of a second, each at its own moment.
  function hurry(within = 0.4) {
    if (!L) return;
    const now = env.now;
    for (let i = 0; i < n; i++) {
      const t = now + rnd[i] * within;
      if (nextT[i] > t) nextT[i] = t;
    }
  }

  function draw(ctx, view) {
    if (!L || !env.p) return;
    const t = env.now, reduced = env.reduced;
    beginFx();

    // Last move: a warm trace that is bright at first and cools to an ember glow.
    const lm = view.lastMove;
    if (lm && lm.from && lm.to) {
      const key = lm.from + lm.to;
      if (key !== last.key) { last.key = key; last.t = t; }
      const heat = 0.58 + 0.42 * Math.exp(-(t - last.t) / 3.5);
      hlLast(lm.from, heat * 0.9, false, t);
      hlLast(lm.to, heat, true, t);
    } else {
      last.key = '';
    }

    // Hover: the square lifts gently.
    if (view.hover !== hover.sq) { hover.sq = view.hover || null; hover.t = t; }
    if (hover.sq) hlHover(hover.sq, reduced ? 1 : clamp((t - hover.t) / 0.14) * (0.88 + 0.12 * Math.sin(t * 3)));

    if (view.checkSquare) hlCheck(view.checkSquare, t, reduced);

    // Targets ripple outwards from the selected square.
    const targets = view.targets;
    if (targets && targets.length) {
      const sel = view.selected;
      const sf = sel ? sqFile(sel) : 0, sr = sel ? sqRank(sel) : 0;
      seen.fill(0);
      for (const mv of targets) {
        const to = mv && mv.to; if (!to) continue;
        const f = sqFile(to), rk = sqRank(to);
        const bit = (rk & 7) * 8 + (f & 7);
        if (seen[bit]) continue;                          // promotions list the same square four times
        seen[bit] = 1;
        const dist = sel ? Math.hypot(f - sf, rk - sr) : 0;
        if (mv.captured) hlCapture(to, t * (reduced ? 2.5 : 6.2) - dist * 0.5, to === view.hover);
        else hlQuiet(to, t * (reduced ? 1.4 : 2.8) - dist * 0.6, to === view.hover);
      }
    }

    if (view.selected) hlSelected(view.selected, t, reduced);

    if (flashes.length) applyFlashes(reduced);
    if (ripples.length) applyRipples(reduced);

    flushSome(TILES_PER_FRAME);
    const prevAlpha = ctx.globalAlpha;
    // The cache is in device pixels.  When the context carries the usual "scale by dpr, maybe
    // translate by a shake" transform, drop to a pure integer translation so every blit is an
    // unfiltered 1:1 copy (crisper, and much cheaper where canvas is software-rasterised).
    const tf = ctx.getTransform ? ctx.getTransform() : null;
    const plain = !!tf && tf.b === 0 && tf.c === 0 && Math.abs(tf.a - dpr) < 1e-4 && Math.abs(tf.d - dpr) < 1e-4;
    if (plain) ctx.setTransform(1, 0, 0, 1, Math.round(tf.e), Math.round(tf.f));
    U = plain ? 1 : 1 / dpr;
    // The tiles are opaque and cover the screen; the void only needs painting in the margin a
    // screen shake can expose (off-canvas, so free, when nothing shakes).
    const m = 64 * dpr * U, gx0 = dx[0] * U, gy0 = dy[0] * U, gx1 = dx[cols] * U, gy1 = dy[rows] * U;
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(gx0 - m, gy0 - m, gx1 - gx0 + m * 2, m);
    ctx.fillRect(gx0 - m, gy1, gx1 - gx0 + m * 2, m);
    ctx.fillRect(gx0 - m, gy0, m, gy1 - gy0);
    ctx.fillRect(gx1, gy0, m, gy1 - gy0);
    if (plain) for (const tl of tiles) ctx.drawImage(tl.canvas, tl.x, tl.y);
    else for (const tl of tiles) ctx.drawImage(tl.canvas, tl.x * U, tl.y * U, tl.w * U, tl.h * U);
    if (hotCount) paintHot(ctx);
    if (plain) ctx.setTransform(tf);
    ctx.globalAlpha = prevAlpha;
    drawLabels(ctx, view, t);
  }

  // File / rank labels sit in the moat, left and below, and follow the flip.
  function drawLabels(ctx, view, t) {
    const at = getAtlas({ fontPx: L.fontPx, color: colors[C.EDGE], dpr });
    const b = L.board, P = env.p;
    const base = 0.5 * (1 - 0.35 * P.grey);
    const marks = [view.selected, view.hover];
    const prev = ctx.globalAlpha;
    for (let k = 0; k < 8; k++) {
      const file = L.flipped ? 7 - k : k, rank = L.flipped ? k : 7 - k;
      let af = base + 0.07 * Math.sin(t * 0.7 + k * 0.9), ar = base + 0.07 * Math.sin(t * 0.7 + k * 0.9 + 2);
      for (const m of marks) {
        if (typeof m !== 'string') continue;
        if (sqFile(m) === file) af = 0.95;
        if (sqRank(m) === rank) ar = 0.95;
      }
      ctx.globalAlpha = af;
      at.drawCode(ctx, 97 + file, b.x + (k + 0.5) * L.sq, b.y + b.size + ch * 0.5);
      if (b.c0 >= 2) {
        ctx.globalAlpha = ar;
        at.drawCode(ctx, 49 + rank, b.x - cw * 1.5, b.y + (k + 0.5) * L.sq);
      }
    }
    ctx.globalAlpha = prev;
  }

  // ------------------------------------------------------------------ api --

  return {
    C,
    resize, update, draw, hurry,
    flush() { if (L && env.p) flushSome(tiles.length); },
    // 0..~0.8: how much the baked vignette darkens the point (x, y); scenery dims itself to match.
    vignetteAt(x, y) { return L ? vignetteAt(x, y) : 0; },
    ripple(x, y, strength = 1, color) {
      if (!L || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const s = clamp(+strength || 1, 0.1, 3);
      if (ripples.length >= 10) ripples.shift();
      ripples.push({ x, y, s, c: colorIndex(color, C.BRIGHT), age: 0, dur: 0.7 + 0.32 * s, R: (1.3 + 1.7 * s) * L.sq, w: (0.2 + 0.06 * s) * L.sq });
    },
    flash(sq, color, strength = 1) {
      if (!L || block(sq) < 0) return;
      const s = clamp(+strength || 1, 0.1, 3);
      if (flashes.length >= 16) flashes.shift();
      flashes.push({ sq, s, c: colorIndex(color, C.BRIGHT), age: 0, dur: 0.3 + 0.14 * s });
    },
    // Architecture stamping (scenery.js): begin → stamp… → end.  Only the plain can hold it.
    archBegin() { bGl.fill(0); },
    archStamp(c, r, code, ci, alpha, lamp) {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return;
      const i = r * cols + c;
      if (zone[i] !== Z_OUT) return;
      bGl[i] = code; bCol[i] = ci; bAl[i] = alpha; bLamp[i] = lamp ? 1 : 0;
    },
    archEnd() {
      for (let i = 0; i < n; i++) {
        if (bGl[i] !== aGl[i] || (bGl[i] && (bCol[i] !== aCol[i] || bAl[i] !== aAl[i] || bLamp[i] !== aLamp[i]))) {
          aGl[i] = bGl[i]; aCol[i] = bCol[i]; aAl[i] = bAl[i]; aLamp[i] = bLamp[i];
          refresh(i);                                  // structures move as a whole, never torn
        }
      }
    },
    stats: () => ({ cells: n, tiles: tiles.length, hot: hotCount, ripples: ripples.length, flashes: flashes.length, colors: colors.length }),
  };
}
