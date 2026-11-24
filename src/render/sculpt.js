// Sculpt: chess pieces as real 3D point-cloud sculptures, rasterised to fine
// ASCII with the donut.c technique.
//
//   model  = getModel('n')                     // points + normals, built once
//   cells  = renderCells(model, yaw, res)      // one shaded glyph frame
//
// Model space: y is up (0 = the table, the king is 1.0 tall), x is right,
// z points at the viewer.  A frame is a list of glyph cells with fractional
// positions (in fine-cell units relative to the piece's foot), a glyph code,
// a shade index (0 lit .. 5 shadow) and a sub-cell coverage mask used for the
// occluding silhouette.

import { GLYPHS } from '../core/palette.js';
import { TAU, clamp, hash2 } from '../core/util.js';

export const TILT = 0.44;          // camera pitch (rad): we look slightly down
export const ASPECT = 1.42;        // fine cell height / width
export const SX = 3, SY = 4;       // sub-samples per cell (≈ square sub-pixels)
export const STEP = TAU / 60;      // yaw between pre-rendered frames (6°)

const DS = 0.0075;                 // surface sampling pitch, model units
const STRIDE = 8;                  // x y z nx ny nz tex emit
const COS_T = Math.cos(TILT), SIN_T = Math.sin(TILT);

// Light rig in view space (x right, y up, z toward the viewer).
const norm3 = (x, y, z) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
const KEY = norm3(-0.52, 0.62, 0.58);
const RIM = norm3(0.80, 0.22, -0.36);
const HALF = norm3(KEY[0], KEY[1], KEY[2] + 1);

// ---------------------------------------------------------------------------
// Point cloud helpers
// ---------------------------------------------------------------------------

function makeRand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise that wraps in u with integer period `pu`.
function pnoise(u, v, pu, seed) {
  const ui = Math.floor(u), vi = Math.floor(v);
  const uf = u - ui, vf = v - vi;
  const a = uf * uf * (3 - 2 * uf), b = vf * vf * (3 - 2 * vf);
  const m = (i) => ((i % pu) + pu) % pu;
  const h00 = hash2(m(ui), vi, seed), h10 = hash2(m(ui + 1), vi, seed);
  const h01 = hash2(m(ui), vi + 1, seed), h11 = hash2(m(ui + 1), vi + 1, seed);
  return h00 + (h10 - h00) * a + (h01 - h00) * b + (h00 - h10 - h01 + h11) * a * b;
}

class Cloud {
  constructor(seed) { this.a = []; this.rand = makeRand(seed); }
  add(x, y, z, nx, ny, nz, tex = 1, emit = -1) { this.a.push(x, y, z, nx, ny, nz, tex, emit); }
}

// Surface of revolution.  `prof` is a polyline of [radius, y] running from the
// bottom centre outward and up to the top centre (so the left-hand normal of
// each segment points out of the solid).  Corners sharper than ~50° stay
// creased, gentler ones are smooth-shaded.
//   keep(theta, y, r)  -> false to cut the point away (crenellations, slits)
//   tex(theta, y)      -> luminance multiplier (stone grain, engraving)
function lathe(c, prof, { keep, tex, ds = DS } = {}) {
  const n = prof.length;
  const sn = [];
  for (let i = 0; i < n - 1; i++) {
    const dr = prof[i + 1][0] - prof[i][0], dy = prof[i + 1][1] - prof[i][1];
    const len = Math.hypot(dr, dy) || 1e-9;
    sn.push([dy / len, -dr / len, len]);
  }
  const vn = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) { vn.push(null); continue; }
    const a = sn[i - 1], b = sn[i];
    if (a[0] * b[0] + a[1] * b[1] > 0.64) {
      const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y);
      vn.push([x / l, y / l]);
    } else vn.push(null);
  }
  for (let i = 0; i < n - 1; i++) {
    const [r0, y0] = prof[i], [r1, y1] = prof[i + 1];
    const s = sn[i], na = vn[i] || s, nb = vn[i + 1] || s;
    const steps = Math.max(1, Math.ceil(s[2] / ds));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const r = r0 + (r1 - r0) * t, y = y0 + (y1 - y0) * t;
      let nr = na[0] + (nb[0] - na[0]) * t, ny = na[1] + (nb[1] - na[1]) * t;
      const nl = Math.hypot(nr, ny) || 1; nr /= nl; ny /= nl;
      const m = Math.max(1, Math.ceil((TAU * r) / ds));
      const th0 = c.rand() * TAU;
      for (let j = 0; j < m; j++) {
        const th = th0 + (j * TAU) / m;
        if (keep && !keep(th, y, r)) continue;
        const cs = Math.cos(th), sn_ = Math.sin(th);
        c.add(r * cs, y, r * sn_, nr * cs, ny, nr * sn_, tex ? tex(th, y) : 1);
      }
    }
  }
}

// Axis-aligned box (the king's cross).
function box(c, cx, cy, cz, hx, hy, hz, tex = 1, ds = DS) {
  const face = (ax, sign) => {
    const h = [hx, hy, hz], u = (ax + 1) % 3, v = (ax + 2) % 3;
    const nu = Math.max(1, Math.ceil((2 * h[u]) / ds)), nv = Math.max(1, Math.ceil((2 * h[v]) / ds));
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const p = [0, 0, 0], nrm = [0, 0, 0];
      p[ax] = sign * h[ax];
      p[u] = -h[u] + ((i + 0.5) / nu) * 2 * h[u];
      p[v] = -h[v] + ((j + 0.5) / nv) * 2 * h[v];
      nrm[ax] = sign;
      c.add(cx + p[0], cy + p[1], cz + p[2], nrm[0], nrm[1], nrm[2], tex);
    }
  };
  for (let ax = 0; ax < 3; ax++) { face(ax, 1); face(ax, -1); }
}

function sphere(c, cx, cy, cz, R, tex = 1, ds = DS) {
  const rings = Math.max(3, Math.ceil((Math.PI * R) / ds));
  for (let i = 0; i < rings; i++) {
    const phi = -Math.PI / 2 + ((i + 0.5) / rings) * Math.PI;
    const rr = Math.cos(phi) * R, yy = Math.sin(phi) * R;
    const m = Math.max(1, Math.ceil((TAU * rr) / ds));
    const t0 = c.rand() * TAU;
    for (let j = 0; j < m; j++) {
      const th = t0 + (j * TAU) / m, x = Math.cos(th) * rr, z = Math.sin(th) * rr;
      c.add(cx + x, cy + yy, cz + z, x / R, yy / R, z / R, tex);
    }
  }
}

// Profile helpers ------------------------------------------------------------

// Arc of a circle in the (r, y) half-plane, from angle a0 to a1 (degrees,
// 0 = +r, 90 = +y), appended to `p`.
function arc(p, cr, cy, R, a0, a1, n = 8) {
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    p.push([Math.max(0, cr + Math.cos(a) * R), cy + Math.sin(a) * R]);
  }
  return p;
}
// Quadratic bezier appended to `p` (start point is the current last point).
function bez(p, c, e, n = 8) {
  const s = p[p.length - 1];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    p.push([u * u * s[0] + 2 * u * t * c[0] + t * t * e[0], u * u * s[1] + 2 * u * t * c[1] + t * t * e[1]]);
  }
  return p;
}
// The turned foot every piece stands on: a thick disc with a rounded edge and
// a step.  Ends at radius ~0.74 R, height `h`.
function foot(R, h = 0.105) {
  const p = [[0, 0], [R * 0.96, 0]];
  arc(p, R * 0.96, h * 0.34, h * 0.34, -90, 90, 6);
  p.push([R * 0.86, h * 0.72], [R * 0.80, h * 0.86], [R * 0.74, h]);
  return p;
}
// Stone grain that travels with the surface so a turning lathe shape visibly
// turns.  `order` = rotational symmetry (the grain repeats `order` times).
function grain(order, seed, amp = 0.34) {
  const pu = Math.max(2, Math.round(9 / order));
  return (th, y) => {
    const u = ((th / TAU) * order % 1 + 1) % 1;
    return 1 - amp * 0.5 + amp * pnoise(u * pu, y * 11, pu, seed);
  };
}

// ---------------------------------------------------------------------------
// The six sculptures
// ---------------------------------------------------------------------------

function buildPawn() {
  const c = new Cloud(11);
  const p = foot(0.18, 0.11);
  bez(p, [0.085, 0.14], [0.066, 0.27], 8);
  p.push([0.064, 0.30]);
  // collar
  p.push([0.118, 0.315]); arc(p, 0.118, 0.336, 0.02, -90, 90, 4); p.push([0.066, 0.362]);
  // head
  arc(p, 0, 0.455, 0.108, -52, 90, 14);
  lathe(c, p, { tex: grain(3, 5) });
  return finish(c, { h: 0.565, order: 3 });
}

function buildRook() {
  const c = new Cloud(12);
  const N = 6, DUTY = 0.56;                       // merlons
  const yNotch = 0.545, yTop = 0.645, rOut = 0.168, rIn = 0.098;
  const merlon = (th) => (((th / TAU) * N % 1) + 1) % 1 < DUTY;
  const g = grain(N, 7, 0.26);
  const p = foot(0.205, 0.11);
  bez(p, [0.125, 0.13], [0.122, 0.20], 5);
  p.push([0.112, 0.42]);
  bez(p, [0.112, 0.465], [0.168, 0.475], 5);
  p.push([rOut, yNotch]);
  lathe(c, p, { tex: g });
  // battlements: outer wall, top, inner wall — only where a merlon stands
  lathe(c, [[rOut, yNotch], [rOut, yTop], [rIn, yTop], [rIn, yNotch - 0.03]], { keep: merlon, tex: g });
  // the walk between merlons, and the floor of the tower
  lathe(c, [[rOut, yNotch], [rIn, yNotch]], { keep: (th) => !merlon(th), tex: () => 0.8 });
  lathe(c, [[rIn, yNotch - 0.03], [0, yNotch - 0.03]], { tex: () => 0.55 });
  lathe(c, [[rIn, yNotch], [rIn, yNotch - 0.03]], { keep: (th) => !merlon(th), tex: () => 0.6 });
  // merlon cheeks (radial faces)
  for (let k = 0; k < N; k++) {
    for (const [frac, sign] of [[0, -1], [DUTY, 1]]) {
      const th = ((k + frac) / N) * TAU, cs = Math.cos(th), sn = Math.sin(th);
      const nr = Math.ceil((rOut - rIn) / DS), ny = Math.ceil((yTop - yNotch) / DS);
      for (let i = 0; i < nr; i++) for (let j = 0; j < ny; j++) {
        const r = rIn + ((i + 0.5) / nr) * (rOut - rIn), y = yNotch + ((j + 0.5) / ny) * (yTop - yNotch);
        c.add(r * cs, y, r * sn, -sn * sign, 0, cs * sign, 0.9);
      }
    }
  }
  return finish(c, { h: yTop, order: N });
}

function buildBishop() {
  const c = new Cloud(13);
  const g = grain(1, 9, 0.3);
  const p = foot(0.19, 0.105);
  bez(p, [0.078, 0.15], [0.056, 0.30], 8);
  p.push([0.052, 0.415]);
  p.push([0.112, 0.43]); arc(p, 0.112, 0.452, 0.022, -90, 90, 4); p.push([0.06, 0.478]);
  // mitre: a fat teardrop with a ball finial
  p.push([0.074, 0.50]);
  bez(p, [0.124, 0.555], [0.108, 0.635], 8);
  bez(p, [0.088, 0.70], [0.03, 0.752], 8);
  arc(p, 0, 0.782, 0.036, -60, 90, 8);
  // the slit: a slanted slab cut out of one side of the mitre
  const snx = 0.64, sny = 0.77, sx0 = 0.012, sy0 = 0.628, sw = 0.017;
  const inSlab = (x, y) => Math.abs((x - sx0) * snx + (y - sy0) * sny) < sw && x > -0.02 && y > 0.5 && y < 0.74;
  lathe(c, p, {
    tex: g,
    keep: (th, y, r) => !inSlab(r * Math.cos(th), y),
  });
  // dark floor of the cut, so we look into shadow instead of through the piece
  const mitreR = (y) => {
    for (let i = 0; i < p.length - 1; i++) {
      if (p[i][1] <= y && p[i + 1][1] >= y && p[i][1] > 0.49) {
        const t = (y - p[i][1]) / ((p[i + 1][1] - p[i][1]) || 1);
        return p[i][0] + (p[i + 1][0] - p[i][0]) * t;
      }
    }
    return 0;
  };
  const tx = sny, ty = -snx;                                  // direction along the cut, in (x, y)
  for (let u = -0.16; u <= 0.16; u += DS * 0.8) {
    const x = sx0 + tx * u, y = sy0 + ty * u;
    if (x < -0.02 || y < 0.5 || y > 0.74) continue;
    const R = mitreR(y);
    if (Math.abs(x) >= R) continue;
    const zmax = Math.sqrt(R * R - x * x);
    for (let z = -zmax; z <= zmax; z += DS * 0.8) c.add(x, y, z, 0, 0, 0, 1, 0.05);
  }
  return finish(c, { h: 0.82, order: 1 });
}

function buildQueen() {
  const c = new Cloud(14);
  const N = 6;
  const g = grain(N, 3, 0.28);
  const p = foot(0.212, 0.11);
  bez(p, [0.09, 0.16], [0.064, 0.34], 8);
  p.push([0.06, 0.49]);
  p.push([0.122, 0.505]); arc(p, 0.122, 0.528, 0.023, -90, 90, 4); p.push([0.068, 0.556]);
  p.push([0.074, 0.585]);
  lathe(c, p, { tex: g });
  // coronet: a flaring cup whose rim rises into N points
  const yLo = 0.725, yHi = 0.845;
  const peak = (th) => {
    const u = (((th / TAU) * N % 1) + 1) % 1;
    return Math.pow(1 - Math.abs(u * 2 - 1), 1.25);          // 0 in the valleys, 1 on the tips
  };
  const rimY = (th) => yLo + (yHi - yLo) * peak(th);
  const outer = [[0.074, 0.585]];
  bez(outer, [0.082, 0.69], [0.158, 0.80], 10);
  outer.push([0.172, 0.85]);
  lathe(c, outer, { keep: (th, y) => y <= rimY(th), tex: g });
  const inner = [[0.156, 0.85], [0.142, 0.80]];
  bez(inner, [0.07, 0.70], [0.06, 0.66], 8);
  lathe(c, inner, { keep: (th, y) => y <= rimY(th), tex: () => 0.62 });
  // pearls on the tips
  for (let k = 0; k < N; k++) {
    const th = ((k + 0.5) / N) * TAU;
    sphere(c, Math.cos(th) * 0.166, yHi + 0.012, Math.sin(th) * 0.166, 0.026, 1.12);
  }
  // inner dome and the finial ball
  const dome = [[0.118, 0.70]];
  bez(dome, [0.11, 0.80], [0.04, 0.835], 8);
  arc(dome, 0, 0.868, 0.042, -65, 90, 8);
  lathe(c, dome, { tex: g });
  return finish(c, { h: 0.91, order: N });
}

function buildKing() {
  const c = new Cloud(15);
  const g = grain(2, 21, 0.28);
  const p = foot(0.218, 0.11);
  bez(p, [0.095, 0.16], [0.07, 0.36], 8);
  p.push([0.066, 0.515]);
  p.push([0.128, 0.53]); arc(p, 0.128, 0.554, 0.024, -90, 90, 4); p.push([0.072, 0.584]);
  p.push([0.078, 0.61]);
  // crown: flaring drum with a banded rim and a low dome
  bez(p, [0.086, 0.70], [0.142, 0.775], 8);
  p.push([0.15, 0.80], [0.142, 0.825], [0.112, 0.835]);
  bez(p, [0.085, 0.872], [0, 0.878], 8);
  lathe(c, p, { tex: g });
  // the cross
  box(c, 0, 0.94, 0, 0.026, 0.068, 0.024, 1.05);
  box(c, 0, 0.948, 0, 0.074, 0.025, 0.024, 1.05);
  return finish(c, { h: 1.008, order: 2 });
}

// Horse head: a silhouette in the x/y plane (nose toward -x), inflated into a
// pillow so it has real thickness, cheeks and shading from every angle.
const HORSE = [
  [0.128, 0.10], [0.150, 0.20], [0.156, 0.30], [0.146, 0.40], [0.124, 0.50], [0.094, 0.585],
  [0.066, 0.640], [0.060, 0.690], [0.052, 0.752],                 // back of the ear
  [0.022, 0.700], [0.000, 0.672],                                 // ear front, poll
  [-0.048, 0.652], [-0.098, 0.602], [-0.142, 0.540], [-0.176, 0.478],   // forehead → nose
  [-0.196, 0.432], [-0.200, 0.396], [-0.184, 0.368], [-0.150, 0.366],   // muzzle
  [-0.118, 0.392], [-0.088, 0.432], [-0.058, 0.440],              // jaw
  [-0.034, 0.410], [-0.030, 0.360], [-0.050, 0.300],              // throat
  [-0.086, 0.240], [-0.116, 0.180], [-0.126, 0.10],               // chest
];

function chaikin(poly, keepIdx = []) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    if (keepIdx.includes(i)) out.push(a);
    else out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    if (!keepIdx.includes((i + 1) % n)) out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  return out;
}

function buildKnight() {
  const c = new Cloud(16);
  const p = foot(0.205, 0.11);
  p.push([0.15, 0.125], [0.142, 0.15], [0, 0.15]);
  lathe(c, p, { tex: grain(1, 31, 0.26) });

  const poly = chaikin(chaikin(HORSE, [8]), []);
  const n = poly.length;
  const gs = 0.0055;
  const x0 = -0.22, y0 = 0.09, gw = Math.ceil(0.40 / gs), gh = Math.ceil(0.68 / gs);
  const W = 0.078;                                            // inflate distance
  const zf = new Float32Array(gw * gh);
  const inside = (x, y) => {
    let k = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) k = !k;
    }
    return k;
  };
  const dist = (x, y) => {
    let d = 1e9;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
      const ex = bx - ax, ey = by - ay;
      const t = clamp(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1e-9));
      const dd = Math.hypot(x - ax - ex * t, y - ay - ey * t);
      if (dd < d) d = dd;
    }
    return d;
  };
  // thickness: a strong neck and chest, a finer head and ear
  const thick = (x, y) => 0.094 - 0.03 * clamp((y - 0.36) / 0.3) - 0.02 * clamp((-x - 0.08) / 0.12) + 0.012 * clamp((0.2 - y) / 0.1);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const x = x0 + i * gs, y = y0 + j * gs;
    if (!inside(x, y)) continue;
    const d = Math.min(dist(x, y), W) / W;
    zf[j * gw + i] = thick(x, y) * Math.sqrt(1 - (1 - d) * (1 - d));
  }
  const tex = (x, y) => {
    let t = 1;
    // eye
    const ex = x + 0.058, ey = y - 0.585;
    if (ex * ex + ey * ey < 0.00034) t = 0.1;
    // nostril, mouth
    const nx = x + 0.176, ny = y - 0.412;
    if (nx * nx + ny * ny < 0.00011) t = 0.25;
    // mane: grooves raking down the back of the neck
    const back = 0.156 - (y - 0.3) * (y - 0.3) * 1.15 - (y > 0.5 ? (y - 0.5) * 0.42 : 0);
    const dm = back - x;
    if (dm < 0.062 && y > 0.17 && y < 0.67) {
      const s = Math.sin((y * 1.0 + dm * 1.5) * 78);
      t *= s > 0.25 ? 1.12 : 0.42;
    }
    // cheek line
    const jx = x + 0.03, jy = y - 0.5;
    const jr = Math.hypot(jx, jy);
    if (Math.abs(jr - 0.062) < 0.006 && jx < 0.03 && jy < 0.02) t *= 0.55;
    return t;
  };
  for (let j = 1; j < gh - 1; j++) for (let i = 1; i < gw - 1; i++) {
    const z = zf[j * gw + i];
    if (z <= 0) continue;
    const x = x0 + i * gs, y = y0 + j * gs;
    if (y < 0.135) continue;
    const dzx = (zf[j * gw + i + 1] - zf[j * gw + i - 1]) / (2 * gs);
    const dzy = (zf[(j + 1) * gw + i] - zf[(j - 1) * gw + i]) / (2 * gs);
    const l = Math.hypot(dzx, dzy, 1);
    const t = tex(x, y);
    const slope = Math.min(5, Math.floor(Math.hypot(dzx, dzy)));
    for (let k = 0; k <= slope; k++) {
      const zz = z - k * gs * 0.9;
      if (zz < 0) break;
      c.add(x, y, zz, -dzx / l, -dzy / l, 1 / l, t);
      c.add(x, y, -zz, -dzx / l, -dzy / l, -1 / l, t);
    }
  }
  // rim: close the seam where the two skins meet
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
    const steps = Math.max(1, Math.ceil(len / (gs * 0.8)));
    // outward normal: polygon winds counter-clockwise when y is up?  test.
    let nx = ey / len, ny = -ex / len;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    if (inside(mx + nx * 0.004, my + ny * 0.004)) { nx = -nx; ny = -ny; }
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps, x = ax + ex * t, y = ay + ey * t;
      if (y < 0.135) continue;
      const zr = thick(x, y) * 0.3;
      for (let z = -zr; z <= zr; z += gs * 0.8) c.add(x, y, z, nx, ny, 0, 1);
    }
  }
  return finish(c, { h: 0.76, order: 1 });
}

function finish(c, { h, order }) {
  const pts = new Float32Array(c.a);
  let rmax = 0;
  for (let i = 0; i < pts.length; i += STRIDE) {
    const r = Math.hypot(pts[i], pts[i + 2]);
    if (r > rmax) rmax = r;
  }
  const period = TAU / order;
  return { pts, n: pts.length / STRIDE, h, rmax, order, period, frames: Math.round(period / STEP) };
}

const BUILDERS = { p: buildPawn, r: buildRook, b: buildBishop, q: buildQueen, k: buildKing, n: buildKnight };
const models = {};
export function getModel(type) {
  return models[type] || (models[type] = BUILDERS[type]());
}

// Static facts that don't need the point cloud (so layout can be computed
// before any model is built).
export const SHAPE = {
  p: { h: 0.565, r: 0.19, order: 3 },
  r: { h: 0.645, r: 0.215, order: 6 },
  n: { h: 0.76, r: 0.215, order: 1 },
  b: { h: 0.82, r: 0.20, order: 1 },
  q: { h: 0.91, r: 0.222, order: 6 },
  k: { h: 1.008, r: 0.228, order: 2 },
};
export const frameCount = (type) => Math.round(TAU / SHAPE[type].order / STEP);

// Grid box (in fine cells) that holds every frame of a type at resolution
// `res` (columns per model unit).  The foot (model origin) sits at (ox, oy).
export function gridBox(type, res) {
  const s = SHAPE[type];
  const half = Math.ceil(s.r * res) + 2;
  const up = Math.ceil(((s.h * COS_T + s.r * SIN_T) * res) / ASPECT) + 2;
  const down = Math.ceil((s.r * SIN_T * res) / ASPECT) + 2;
  return { cols: half * 2, rows: up + down, ox: half, oy: up };
}

// ---------------------------------------------------------------------------
// Rasteriser
// ---------------------------------------------------------------------------

let zbuf = new Float32Array(0), lbuf = new Float32Array(0);
const RAMP = GLYPHS.ramp;
const RAMP_N = RAMP.length;

export function renderCells(type, yaw, res) {
  const model = getModel(type);
  const { cols, rows, ox, oy } = gridBox(type, res);
  const W = cols * SX, H = rows * SY, N = W * H;
  if (zbuf.length < N) { zbuf = new Float32Array(N); lbuf = new Float32Array(N); }
  zbuf.fill(-1e9, 0, N);

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const kx = res * SX, ky = (res / ASPECT) * SY;
  const pxo = ox * SX - 0.5, pyo = oy * SY - 0.5;
  const P = model.pts;
  const depthK = 0.22 / (2 * model.rmax);
  for (let i = 0, e = P.length; i < e; i += STRIDE) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    const nx = P[i + 3], ny = P[i + 4], nz = P[i + 5];
    // yaw about y, then pitch the camera down
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const nx1 = nx * cy + nz * sy, nz1 = -nx * sy + nz * cy;
    const vnz = nz1 * COS_T + ny * SIN_T;
    const emit = P[i + 7];
    if (emit < 0 && vnz < -0.12) continue;                    // back face
    const vy = y * COS_T - z1 * SIN_T;
    const d = z1 * COS_T + y * SIN_T;
    const fx = x1 * kx + pxo, fy = pyo - vy * ky;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix >= W - 1 || iy >= H - 1) continue;
    const k0 = iy * W + ix;
    // quick reject: hidden in all four texels
    if (d <= zbuf[k0] && d <= zbuf[k0 + 1] && d <= zbuf[k0 + W] && d <= zbuf[k0 + W + 1]) continue;
    let lum;
    if (emit >= 0) lum = emit;
    else {
      const vny = ny * COS_T - nz1 * SIN_T;
      const key = Math.max(0, nx1 * KEY[0] + vny * KEY[1] + vnz * KEY[2]);
      const rim = Math.max(0, nx1 * RIM[0] + vny * RIM[1] + vnz * RIM[2]);
      const sp = Math.max(0, nx1 * HALF[0] + vny * HALF[1] + vnz * HALF[2]);
      const sp2 = sp * sp, sp8 = sp2 * sp2 * sp2 * sp2;
      lum = 0.13 + 0.80 * key + 0.30 * rim * rim + 0.22 * sp8 * sp8;
      lum *= P[i + 6];
      lum *= 0.86 + (z1 + model.rmax) * depthK;
      // contact shadow where the piece meets the table
      if (y < 0.03) lum *= 0.75;
    }
    if (d > zbuf[k0]) { zbuf[k0] = d; lbuf[k0] = lum; }
    if (d > zbuf[k0 + 1]) { zbuf[k0 + 1] = d; lbuf[k0 + 1] = lum; }
    if (d > zbuf[k0 + W]) { zbuf[k0 + W] = d; lbuf[k0 + W] = lum; }
    if (d > zbuf[k0 + W + 1]) { zbuf[k0 + W + 1] = d; lbuf[k0 + W + 1] = lum; }
  }

  const SUBN = SX * SY;
  const xs = [], ys = [], codes = [], shades = [], masks = [], ccol = [], crow = [];
  const seed = type.charCodeAt(0);
  for (let r = 0; r < rows; r++) for (let cI = 0; cI < cols; cI++) {
    let cnt = 0, sum = 0, mx = 0, my = 0, mask = 0, peak = 0;
    for (let j = 0; j < SY; j++) {
      const row = (r * SY + j) * W + cI * SX;
      for (let i = 0; i < SX; i++) {
        if (zbuf[row + i] > -1e8) {
          const l = lbuf[row + i];
          cnt++; sum += l; mx += i + 0.5; my += j + 0.5; mask |= 1 << (j * SX + i);
          if (l > peak) peak = l;
        }
      }
    }
    if (!cnt) continue;
    const cov = cnt / SUBN;
    // favour the brightest sample a little so thin lit features don't drown
    const L = clamp((sum / cnt) * 0.7 + peak * 0.3);
    const jit = hash2(cI, r, seed) - 0.5;
    let gi = -1, sh = 0;
    if (cnt >= 2) {
      const dens = (3.2 + 9.4 * Math.pow(L, 0.8)) * (0.42 + 0.58 * cov);
      gi = clamp(Math.round(dens + jit * 2.4), 0, RAMP_N - 1);
      sh = clamp(Math.round((1 - Math.pow(L, 0.82)) * 5.2 + jit * 0.7), 0, 5);
    }
    // glyph sits on the centroid of what is actually covered
    const gx = 0.5 + (mx / cnt / SX - 0.5) * 0.85, gy = 0.5 + (my / cnt / SY - 0.5) * 0.85;
    xs.push(cI - ox + gx); ys.push(r - oy + gy);
    codes.push(gi < 0 ? 0 : RAMP.charCodeAt(gi)); shades.push(sh);
    masks.push(mask); ccol.push(cI); crow.push(r);
  }
  return {
    n: xs.length,
    x: Float32Array.from(xs), y: Float32Array.from(ys),
    code: Uint8Array.from(codes), shade: Uint8Array.from(shades),
    mask: Uint16Array.from(masks), col: Int16Array.from(ccol), row: Int16Array.from(crow),
    cols, rows, ox, oy,
  };
}
