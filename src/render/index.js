// Pieces: living ASCII sculptures, their idle life, and every move / kill /
// promotion / finale animation.  See CONTRACTS.md → "Pieces".
//
//   sculpt.js   3D models → shaded glyph frames (the donut.c technique)
//   sprites.js  lazy bitmap cache of those frames per army colour
//   fx.js       glyph particles, blade streaks, rings, shake, hit-stop
//   choreo.js   time-based sequences for moves, kills, intro and finale
//
// Idle pieces are a single drawImage each.  Only glyphs that are part of an
// effect (debris, trails, assembling pieces) are simulated individually.

import { PAL } from '../core/palette.js';
import { TAU, clamp, FILES } from '../core/util.js';
import { createSprites, TUNE } from './sprites.js';
import { createFx } from './fx.js';
import { Seq, rest, buildMove, buildIntro, buildMate, buildDraw } from './choreo.js';

const IDLE_TURN = 0.42;            // rad/s for the freely turning lathe pieces

export function createPieces({ bus, world, watchdog = true } = {}) {
  const sprites = createSprites();
  const fx = createFx();

  let layout = null;
  let M = null;                    // sprite metrics { sq, fw, fh, fontPx, dpr, ... }
  let layoutKey = '';
  let actors = [];
  const bySq = new Map();
  const ghosts = [];               // captured pieces still on screen until they shatter
  let seq = null, seqTimer = 0;
  let reduced = false;
  let clock = 0;
  let uid = 1;

  // --- layout -----------------------------------------------------------------

  function resize(l) {
    if (!l) return;
    const k = `${l.sq}|${l.dpr}|${l.board.x}|${l.board.y}|${l.flipped}|${l.pieceH}|${l.fineW}`;
    layout = l;
    if (k === layoutKey) return;
    const first = !layoutKey;
    layoutKey = k;
    M = sprites.configure(l);
    fx.configure(M);
    if (!first) fx.clear();        // particles live in px of the old layout
    for (const a of actors) pose(a, 0);
  }

  // --- actors -----------------------------------------------------------------

  function makeActor(type, color, sq) {
    const f = sq.charCodeAt(0) - 97, r = sq.charCodeAt(1) - 49;
    const h = Math.abs(Math.sin((f * 12.9898 + r * 78.233 + type.charCodeAt(0)) * 43758.5453)) % 1;
    return {
      id: uid++, type, color, sq,
      phase: h * TAU, clock: h * 40, spin: 0, spinVel: 0, sel: 0, drag: 0,
      yaw: 0, breath: 0, alive: 1,
      // visual overrides (owned by the running sequence, reset by rest())
      pos: null, lift: 0, sx: 1, sy: 1, lean: 0, yawAdd: 0, glow: 0, jit: 0,
      showType: null, hidden: false, busy: false,
      // persistent visual state
      dim: 1, fallen: false, free: null, leanV: 0,
      vx: 0, vy: 0, vlift: 0,
    };
  }

  function idleYaw(a, type) {
    const c = a.clock;
    switch (type) {
      case 'n': return (a.color === 'w' ? 0.22 : Math.PI - 0.22) + 0.3 * Math.sin(c * 0.62 + a.phase);
      case 'b': return -0.3 + 0.5 * Math.sin(c * 0.5 + a.phase);
      case 'k': return 0.42 * Math.sin(c * 0.45 + a.phase);
      default: return a.phase + c * IDLE_TURN;
    }
  }

  // Resolve where and how an actor is drawn this frame.
  function pose(a, dt, view) {
    if (!layout) return;
    const type = a.showType || a.type;
    const r = layout.pieceFoot(a.sq);
    let x = r.x, y = r.y;
    if (a.pos) { x = a.pos.x; y = a.pos.y; }
    else if (a.free) { x = a.free.x; y = a.free.y; }
    if (a.jit) {
      x += Math.sin(clock * 97 + a.id) * a.jit;
      y += Math.sin(clock * 71 + a.id * 3) * a.jit * 0.5;
    } else if (view && view.checkSquare === a.sq && view.status !== 'checkmate' && !a.busy) {
      x += Math.sin(clock * 60 + a.id) * 0.7;
    }
    a.vx = x; a.vy = y;
    a.vlift = a.lift + (a.sel * 0.15 + a.drag * 0.1) * layout.sq;
    a.yaw = idleYaw(a, type) + a.spin + a.yawAdd;
  }

  function tick(a, dt, view) {
    const playing = !view || view.phase !== 'gameover';
    const mine = !view || view.phase === 'title' || view.turn === a.color;
    a.alive = playing ? (mine ? 1 : 0.5) : 0.35;
    a.clock += dt * a.alive;
    a.breath = Math.sin(a.clock * 1.9 + a.phase * 3);

    const dragging = !!(view && view.drag && view.drag.from === a.sq && !a.busy);
    const selected = !!(view && view.selected === a.sq && !a.busy) || dragging;
    const k = 1 - Math.exp(-dt * 12);
    a.sel += ((selected ? 1 : 0) - a.sel) * k;
    a.drag += ((dragging ? 1 : 0) - a.drag) * k;
    if (a.sel < 0.001) a.sel = 0;
    if (a.drag < 0.001) a.drag = 0;

    // selected pieces spin up; released ones unwind to their idle facing
    const per = sprites.period(a.showType || a.type);
    if (selected && !dragging && !reduced) {
      a.spinVel += (3.6 - a.spinVel) * (1 - Math.exp(-dt * 5));
      a.spin += a.spinVel * dt;
    } else if (a.spin || a.spinVel) {
      a.spinVel = 0;
      a.spin -= Math.round(a.spin / per) * per;
      a.spin *= Math.exp(-dt * 7);
      if (Math.abs(a.spin) < 0.01) a.spin = 0;
    }

    if (dragging) {
      const h = sprites.box(a.type).height;
      const tx = view.drag.x, ty = view.drag.y + h * 0.42;
      if (!a.free) a.free = { x: tx, y: ty };
      const vx = dt > 0 ? (tx - a.free.x) / dt : 0;
      a.free.x = tx; a.free.y = ty;
      a.leanV += (clamp(vx * 0.00045, -0.35, 0.35) - a.leanV) * (1 - Math.exp(-dt * 10));
    } else {
      if (a.free) {
        const r = layout.pieceFoot(a.sq), e = 1 - Math.exp(-dt * 20);
        a.free.x += (r.x - a.free.x) * e; a.free.y += (r.y - a.free.y) * e;
        if (Math.hypot(r.x - a.free.x, r.y - a.free.y) < 0.6) a.free = null;
      }
      a.leanV *= Math.exp(-dt * 12);
      if (Math.abs(a.leanV) < 0.002) a.leanV = 0;
    }
    pose(a, dt, view);
  }

  function drawActor(ctx, a) {
    if (a.hidden) return;
    const type = a.showType || a.type;
    const b = sprites.box(type);
    const bm = sprites.bitmap(type, a.color, sprites.index(type, a.yaw));
    const lift = a.vlift;
    const up = 1 + a.sel * 0.05 + a.drag * 0.06;
    // only the side to move breathes; the waiting side holds still (and blits 1:1)
    const sx = a.sx * up, sy = a.sy * up * (a.alive > 0.75 ? 1 + a.breath * TUNE.breath : 1);
    const lean = a.lean + a.leanV;
    if (lift > 1.5) {
      const k = clamp(lift / (layout.sq * 1.6));
      fx.shadow(ctx, a.vx, a.vy + M.fh * 0.2, b.w * (0.5 - 0.2 * k), 0.75 - 0.35 * k);
    }
    const alpha = a.dim;
    const prev = ctx.globalAlpha;
    if (alpha < 1) ctx.globalAlpha = prev * alpha;
    const w = b.w * sx, h = b.h * sy;
    if (lean) {
      ctx.save();
      ctx.translate(a.vx, a.vy - lift);
      ctx.rotate(lean);
      ctx.drawImage(bm, -b.ax * sx, -b.ay * sy, w, h);
      if (a.glow > 0.01) {
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, a.glow);
        ctx.drawImage(bm, -b.ax * sx, -b.ay * sy, w, h);
      }
      ctx.restore();
    } else {
      const dpr = M.dpr;
      const dx = Math.round((a.vx - b.ax * sx) * dpr) / dpr, dy = Math.round((a.vy - lift - b.ay * sy) * dpr) / dpr;
      ctx.drawImage(bm, dx, dy, w, h);
      if (a.glow > 0.01) {
        const op = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, a.glow);
        ctx.drawImage(bm, dx, dy, w, h);
        ctx.globalCompositeOperation = op;
      }
    }
    ctx.globalAlpha = prev;
  }

  // The actor's glyphs in world px, as it stands right now.
  function cellsOf(a) {
    pose(a, 0);
    const type = a.showType || a.type;
    const xs = [], ys = [], codes = [], shades = [];
    const x0 = a.vx, y0 = a.vy - a.vlift, sx = a.sx, sy = a.sy;
    sprites.forEachCell(type, sprites.index(type, a.yaw), (cx, cy, code, shade) => {
      xs.push(x0 + cx * sx); ys.push(y0 + cy * sy); codes.push(code); shades.push(shade);
    });
    return { n: xs.length, x: xs, y: ys, code: codes, shade: shades };
  }

  // --- the stage handed to choreography ------------------------------------------

  const sfx = (name, intensity = 1) => { if (bus && bus.emit) bus.emit('sfx', { name, intensity }); };
  const stage = {
    fx,
    get sq() { return layout.sq; },
    get rm() { return reduced; },
    foot: (sq) => layout.pieceFoot(sq),
    col: (sq) => layout.squareCol(sq),
    row: (sq) => layout.squareRow(sq),
    center: () => ({ x: layout.board.x + layout.board.size / 2, y: layout.board.y + layout.board.size / 2 }),
    height: (type) => sprites.box(type).height,
    period: (type) => sprites.period(type),
    tint: (color) => (color === 'w' ? PAL.bone[1] : PAL.ember[2]),
    cells: cellsOf,
    sfx,
    ripple(x, y, s, color) { try { world && world.ripple && world.ripple(x, y, s, color); } catch (e) { console.error(e); } },
    flash(sq, color, s) { try { world && world.flash && world.flash(sq, color, s); } catch (e) { console.error(e); } },
    shakeBy(amp, dx = 0, dy = 0) { if (!reduced) fx.addShake((amp * layout.sq) / 96, dx, dy); },
    stop(sec) { if (!reduced) fx.hitstop(sec); },
    trail(a, frac) {
      const type = a.showType || a.type;
      const x0 = a.vx, y0 = a.vy - a.vlift;
      const f = reduced ? frac * 0.4 : frac;
      sprites.forEachCell(type, sprites.index(type, a.yaw), (cx, cy, code, shade) => {
        if (fx.rnd() < f) fx.ghost(x0 + cx, y0 + cy, code, a.color, Math.min(5, shade + 1), 0.2 + fx.rnd() * 0.12, 0.6);
      });
    },
    shatter(v, o) {
      fx.debris(cellsOf(v), { set: v.color, ...o });
      stage.kill(v);
    },
    chip(v, frac, dir) {
      const p = layout.pieceFoot(v.sq);
      fx.debris(cellsOf(v), {
        set: v.color, cx: p.x, cy: p.y - sprites.box(v.type).height * 0.5, groundY: p.y, dir,
        power: 3.2, burst: 0.8, up: 1.2, frac: reduced ? frac * 0.5 : frac, life: 0.7,
      });
    },
    kill(v) {
      const i = ghosts.indexOf(v);
      if (i >= 0) ghosts.splice(i, 1);
    },
  };

  // --- sequences ---------------------------------------------------------------

  function finishSeq() {
    if (seq) seq.finish(true);
  }

  function runSeq(s) {
    seq = s;
    return new Promise((resolve) => {
      s.onDone = () => {
        if (seqTimer) { clearTimeout(seqTimer); seqTimer = 0; }
        if (seq === s) seq = null;
        resolve();
      };
      if (s.done) { s.onDone(); return; }
      // Frames may never come (hidden tab): a wall-clock watchdog jumps the
      // sequence to its end state so the promise always resolves.
      if (watchdog) {
        const speed = reduced ? 1.7 : 1;
        seqTimer = setTimeout(() => { seqTimer = 0; s.finish(true); }, (s.dur / speed + 0.7) * 1000);
      }
    });
  }

  function note(view) {
    if (!view) return;
    reduced = !!view.reducedMotion;
    if (view.layout && view.layout !== layout) resize(view.layout);
  }

  // --- public API ---------------------------------------------------------------

  function sync(game, l, opts) {
    const instant = !!(opts && opts.instant);
    if (l) resize(l);
    finishSeq();
    ghosts.length = 0;
    fx.clear();
    const old = new Map(bySq);
    actors = [];
    bySq.clear();
    const board = game.board();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const cell = board[r] && board[r][c];
      if (!cell) continue;
      const sq = FILES[c] + (8 - r);
      let a = instant ? old.get(sq) : null;
      if (a && a.type === cell.type && a.color === cell.color) { rest(a); a.fallen = false; a.hidden = false; a.dim = 1; a.free = null; }
      else a = makeActor(cell.type, cell.color, sq);
      actors.push(a);
      bySq.set(sq, a);
    }
    if (!layout) return Promise.resolve();
    for (const a of actors) pose(a, 0);
    if (instant || !actors.length) return Promise.resolve();
    return runSeq(buildIntro(stage, actors));
  }

  function play(move, view) {
    note(view);
    finishSeq();
    const a = move && bySq.get(move.from);
    if (!a || !layout) {
      // we have lost track of the board: fall back to the truth
      if (view && view.game && layout) sync(view.game, layout, { instant: true });
      return Promise.resolve();
    }
    const sq = layout.sq;
    pose(a, 0);
    const home = layout.pieceFoot(move.from);
    let off = { x: (a.vx - home.x) / sq, y: (a.vy - home.y) / sq };
    const dropped = !!a.free && Math.hypot(off.x, off.y) > 0.3;
    if (!dropped) off = { x: 0, y: 0 };

    // logical state first — the animation is only an overlay on top of it
    let v = null;
    const vsq = move.captured ? (move.capturedSquare || move.to) : null;
    if (vsq) v = bySq.get(vsq) || null;
    if (!v && bySq.get(move.to) && bySq.get(move.to) !== a) v = bySq.get(move.to);
    if (v) {
      bySq.delete(v.sq);
      actors.splice(actors.indexOf(v), 1);
      rest(v); v.spin = 0; v.free = null;
      ghosts.push(v);
    }
    bySq.delete(move.from);
    a.sq = move.to;
    bySq.set(move.to, a);
    let rook = null;
    if (move.castle && move.rookFrom && move.rookTo) {
      rook = bySq.get(move.rookFrom) || null;
      if (rook) { bySq.delete(move.rookFrom); rook.sq = move.rookTo; bySq.set(move.rookTo, rook); rook.pos = { ...layout.pieceFoot(move.rookFrom) }; }
    }
    if (move.promotion && move.promotion !== a.type) { a.showType = a.type; a.type = move.promotion; }
    a.free = null; a.leanV = 0;
    a.pos = { x: home.x + off.x * sq, y: home.y + off.y * sq };
    return runSeq(buildMove(stage, move, a, v, rook, off, dropped));
  }

  function finale(status, winner, view) {
    note(view);
    finishSeq();
    if (!layout || !actors.length) return Promise.resolve();
    const s = status === 'checkmate' && winner ? buildMate(stage, actors, winner) : buildDraw(stage, actors);
    return runSeq(s);
  }

  function update(dt, view) {
    note(view);
    if (!layout) return;
    if (!(dt >= 0)) dt = 0;
    clock += dt;
    const sdt = dt * fx.timeScale(dt);
    if (seq) seq.advance(sdt * (reduced ? 1.7 : 1));
    fx.update(sdt, dt);
    for (const a of actors) tick(a, dt, view);
    for (const g of ghosts) pose(g, dt, view);
  }

  const order = [];
  function draw(ctx, view) {
    if (!layout) return;
    order.length = 0;
    for (const a of actors) order.push(a);
    for (const g of ghosts) order.push(g);
    // back to front; anything in the air or in the hand goes on top of its row
    for (const a of order) a.z = a.vy + (a.drag > 0.01 ? 1e5 : a.vlift > layout.sq * 0.3 ? layout.sq * 1.5 : 0);
    order.sort((p, q) => p.z - q.z);
    for (const a of order) drawActor(ctx, a);
    fx.draw(ctx);
  }

  return {
    resize, sync, update, draw, play, finale,
    shake: fx.shake,
    // --- extensions beyond CONTRACTS.md (optional, read-only) ---
    get busy() { return !!seq; },
    get debug() { return { actors: actors.length, ghosts: ghosts.length, particles: fx.count, ...sprites.stats }; },
  };
}

export { Seq };
