// World: the flowing glyph field the board is part of, plus the scenery and
// atmosphere around it.  API per CONTRACTS.md ("World").
//
//   const world = createWorld({ bus });
//   world.resize(layout);
//   world.update(dt, view);
//   world.draw(ctx, view);          // void, field + board + highlights, scenery
//   ...pieces...
//   world.drawOverlay(ctx, view);   // foreground strands, rain, embers, vignette
//
// field.js    cell grid: flow noise, board squares, highlights, ripples, flashes
// scenery.js  architecture, vines, rain, embers, vignette
// moods.js    the dials behind setMood() and their cross-fade

import { PAL } from '../core/palette.js';
import { clamp } from '../core/util.js';
import { createField } from './field.js';
import { createScenery } from './scenery.js';
import { createMood, MOOD_NAMES } from './moods.js';

const layoutKey = (l) => `${l.W}|${l.H}|${l.dpr}|${l.flipped ? 1 : 0}|${l.cw}|${l.board.x}|${l.board.y}`;

export function createWorld({ bus } = {}) {   // eslint-disable-line no-unused-vars
  const mood = createMood('calm');
  const field = createField();
  const scenery = createScenery(field);

  // One clock for everything.  `flowT` is field time: it runs faster or slower with the mood.
  const env = { now: 0, flowT: 0, dt: 0, p: mood.p, moving: false, reduced: false };
  let L = null, key = '', settle = 0;

  function resize(layout) {
    if (!layout) return;
    L = layout; key = layoutKey(layout);
    field.resize(layout, env);
    scenery.resize(layout);
  }

  // Tolerate a caller that swaps `view.layout` without calling resize().
  function sync(view) {
    const l = view && view.layout;
    if (l && l !== L && layoutKey(l) !== key) resize(l);
  }

  function update(dt, view) {
    sync(view);
    if (!L) return;
    dt = clamp(+dt || 0, 0, 0.1);
    env.reduced = !!(view && view.reducedMotion);
    mood.update(dt);
    // Stay in "moving" a moment after the fade ends so every cell lands on the final look.
    if (mood.moving) settle = 0.45; else if (settle > 0) settle -= dt;
    env.moving = mood.moving || settle > 0;
    env.dt = dt;
    env.now += dt;
    env.flowT += dt * mood.p.flow * (env.reduced ? 0.35 : 1);
    scenery.update(env);
    field.update(env);
  }

  function draw(ctx, view) {
    sync(view);
    if (!L) return;
    // The void.  Oversized so a screen shake never exposes an unpainted edge.
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(-64, -64, L.W + 128, L.H + 128);
    field.draw(ctx, view || {});
    scenery.drawBack(ctx, env);
  }

  function drawOverlay(ctx /* , view */) {
    if (!L) return;
    scenery.drawFront(ctx, env);
  }

  return {
    resize, update, draw, drawOverlay,
    ripple(x, y, strength = 1, color) { field.ripple(x, y, strength, color); },
    flash(sq, color, strength = 1) { field.flash(sq, color, strength); },
    setMood(name) {
      if (!MOOD_NAMES.includes(name)) return;
      if (mood.set(name)) field.hurry(0.35);
    },
    // Extras (not in the contract; harmless to ignore):
    get mood() { return mood.target; },
    stats: () => field.stats(),
  };
}
