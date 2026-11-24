// Shared look: colours, glyph families, shading ramps.
// Every visual module pulls from here so the scene reads as one piece.

export const FONT_FAMILY =
  '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

export const PAL = {
  bg: '#14141c',          // the void
  bgDeep: '#0d0d13',      // vignette / panels

  // The flowing field (lavender → indigo)
  field: ['#c9c6f2', '#aaa7e2', '#8a88cc', '#6b6aa8', '#4d4d80', '#35355a', '#25253e'],
  lightSq: '#b4b1ea',     // light squares: brighter lavender
  darkSq: '#6562a6',      // dark squares: deeper indigo
  boardEdge: '#8f8cd0',

  // Warm architecture / scenery
  warm: ['#fbe3bd', '#f6cf9a', '#f2b56b', '#e0914a', '#b46a38', '#7a4a2e'],

  // Armies
  bone: ['#ffffff', '#f9f6ef', '#e9e5dd', '#cdc9c6', '#a5a3a8', '#7b7a86'],   // "white" side, lit → shadow
  ember: ['#fff0c8', '#ffd08a', '#ffab5c', '#f08040', '#b8552f', '#6e3524'],  // "black" side, lit → shadow

  // Effects
  blade: ['#fff1ee', '#f9c9c2', '#f4a6a8', '#d97a8c'],   // pink sword streak
  spark: ['#fff3c4', '#ffd166', '#ff9d3c', '#e8602c'],   // orange sparks
  danger: '#ff5a6a',      // check
  select: '#f6efd8',      // selection
  target: '#9ff0d0',      // legal-move markers
  capture: '#ff9aa2',     // capturable target
  last: '#f2b56b',        // last-move trace

  // HUD text
  text: '#e9e6f7',
  textDim: '#8a88b4',
  textFaint: '#55557a',
};

// Glyph families (ASCII only, 33..126).
export const GLYPHS = {
  lightSq: '+;~:;+~',          // calm water
  darkSq: '><=<>>=',           // current
  outside: '-:.,;=~',          // the plain beyond the board
  arch: 'HN#I[]=|MW',          // architecture
  vine: 't!*|;:',              // hanging vines / rain
  spark: '*+x.',
  // Luminance ramp for sculpted pieces, dark → bright.
  ramp: '.,:;~+=zsSZN#',
  // Shatter decay, solid → dust.
  decay: '#NZS%*+=~;:,.',
};

export const SIDE_NAME = { w: 'BONE', b: 'EMBER' };
export const PIECE_NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
