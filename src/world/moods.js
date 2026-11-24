// Moods: a handful of scalar dials the field and the scenery read every frame.
// setMood() only moves the target; the weights cross-fade over ~1 s and the
// dials are the weighted blend, so nothing ever snaps.

export const MOOD_NAMES = ['title', 'calm', 'check', 'mate', 'draw'];

//   flow     speed of the currents (multiplies the field's time)
//   cadence  multiplies the interval between glyph changes (higher = calmer)
//   band     depth of the travelling brightness bands
//   board    brightness of the board squares
//   out      brightness / density of the plain beyond the board
//   arch     brightness of the warm architecture
//   unpanel  how much of the "dim under HUD panels" rule is lifted (title only)
//   rain     how many rain strands are falling
//   embers   how many embers are alive
//   rise     how hard embers are pulled upwards
//   red      danger tinge creeping in from the edges
//   grey     colour drained out of everything
//   cool     everything pulled towards a cold blue
//   vig      vignette strength
const TABLE = {
  title: { flow: 0.55, cadence: 1.35, band: 1.6, board: 0.86, out: 1.15, arch: 1.3, unpanel: 0.75, rain: 1.0, embers: 1.0, rise: 0.12, red: 0, grey: 0, cool: 0, vig: 1.0 },
  calm:  { flow: 1.0,  cadence: 1.0,  band: 1.0, board: 1.0,  out: 1.0,  arch: 1.0, unpanel: 0,    rain: 0.4, embers: 0.6, rise: 0.08, red: 0, grey: 0, cool: 0, vig: 1.0 },
  check: { flow: 2.3,  cadence: 0.5,  band: 1.5, board: 1.0,  out: 1.15, arch: 0.85, unpanel: 0,   rain: 0.6, embers: 0.8, rise: 0.2,  red: 1, grey: 0, cool: 0, vig: 1.15 },
  mate:  { flow: 0.28, cadence: 2.1,  band: 0.7, board: 0.78, out: 0.75, arch: 0.5, unpanel: 0,    rain: 0.1, embers: 3.2, rise: 1.0,  red: 0, grey: 1, cool: 0, vig: 1.35 },
  draw:  { flow: 0.1,  cadence: 2.8,  band: 0.5, board: 0.9,  out: 0.85, arch: 0.6, unpanel: 0,    rain: 0.05, embers: 0.15, rise: 0,  red: 0, grey: 0, cool: 1, vig: 1.1 },
};

const KEYS = Object.keys(TABLE.calm);
const FADE = 1.0;   // seconds for a full cross-fade

export function createMood(initial = 'calm') {
  const w = {};
  for (const m of MOOD_NAMES) w[m] = m === initial ? 1 : 0;
  const p = { ...TABLE[initial] };
  const state = {
    target: initial,
    w,                // current weights (sum to 1)
    p,                // blended dials
    moving: false,    // a cross-fade is in progress
    set(mood) {
      if (!TABLE[mood] || mood === state.target) return false;
      state.target = mood;
      state.moving = true;
      return true;
    },
    update(dt) {
      if (!state.moving) return;
      const step = dt / FADE;
      let still = false, sum = 0;
      for (const m of MOOD_NAMES) {
        const goal = m === state.target ? 1 : 0;
        const d = goal - w[m];
        if (Math.abs(d) <= step) w[m] = goal;
        else { w[m] += Math.sign(d) * step; still = true; }
        sum += w[m];
      }
      for (const k of KEYS) {
        let v = 0;
        for (const m of MOOD_NAMES) v += TABLE[m][k] * w[m];
        p[k] = v / (sum || 1);
      }
      state.moving = still;
    },
  };
  return state;
}
