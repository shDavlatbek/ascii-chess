# ASCII Chess — module contracts

Everything on screen is an ASCII glyph (codes 33–126) drawn on one `<canvas>`.
No dependencies, no build step, plain ES modules. Each directory under `src/`
has one owner; talk to other modules only through what is written here.

```
src/core/     shared: palette.js, layout.js, glyphs.js (atlas), util.js, bus.js
src/engine/   chess rules + AI                (no DOM, runs in node and in a Worker)
src/world/    background field, board, scenery
src/render/   piece sculptures, move/kill choreography, particles
src/ui/       HUD, menus, input, audio
src/main.js   game loop + state machine (wires the above)
```

Read `src/core/*.js` before writing code — reuse the palette, the glyph atlas,
the layout helpers and the util functions instead of re-rolling them.

## Coordinates and drawing

- All coordinates are CSS pixels; the context is pre-scaled by `layout.dpr`.
- `layout` (see `src/core/layout.js`) is rebuilt on resize / board flip and
  passed to every module's `resize(layout)`. Never hard-code sizes: derive
  from `layout.sq` (square size), `layout.cw/ch` (coarse cell), `layout.board`.
- Squares are algebraic strings `'a1'..'h8'`. Colours are `'w'` / `'b'`.
  Piece types are `'p' 'n' 'b' 'r' 'q' 'k'`.
- Two glyph scales: the **world** uses the coarse grid (`layout.fontPx`, cells
  `cw × ch`, a chess square is 6 × 3 cells); **pieces** are dense sculptures of
  fine glyphs (cell ≈ `layout.fineW`), not aligned to the coarse grid.
- Draw glyphs through `getAtlas()` from `src/core/glyphs.js`; modulate
  brightness with `ctx.globalAlpha` rather than minting new colours.
- Frame order (main.js):
  `world.draw` → `pieces.draw` → `world.drawOverlay` → `ui.draw`.
  Main translates the context by `pieces.shake` for the first three.
- Budget: 60 fps at 1920×1080, dpr 2, with all 32 pieces on the board.
  Respect `view.reducedMotion` (no shake, shorter effects).

## The `view` object

Main owns it and passes it to every `update(dt, view)` / `draw(ctx, view)`.
Visual modules treat it as read-only.

```js
view = {
  t, dt,                      // seconds
  layout,
  phase: 'title' | 'playing' | 'gameover',
  config: { mode: 'ai' | 'hotseat' | 'demo', level: 1 | 2 | 3, humanColor: 'w' | 'b' },
  game,                       // engine instance (read-only for visual modules)
  turn: 'w' | 'b',
  status: 'playing' | 'checkmate' | 'stalemate' | 'draw-50' | 'draw-repetition' | 'draw-material',
  winner: 'w' | 'b' | null,
  selected: 'e2' | null,      // selected square
  targets: Move[],            // legal moves of the selected piece
  hover: 'e4' | null,
  drag: null | { from, x, y },// piece being dragged, pointer position in px
  lastMove: Move | null,
  checkSquare: 'e8' | null,   // king currently in check
  promotion: null | { color, from, to },   // promotion picker is open
  captured: { w: ['p', 'n'], b: [] },      // pieces captured BY that colour, in order
  busy: false,                // a choreography is playing; input is locked
  thinking: false,            // AI is searching
  muted: false,
  reducedMotion: false,
}
```

## Engine — `src/engine/`

```js
// chess.js
export function createGame(fen?) -> Game
Game = {
  turn,                         // getter: 'w' | 'b'
  board(),                      // 8×8, board()[0] is rank 8, [0][0] is a8; cells are { type, color } | null
  get(sq),                      // { type, color } | null
  legalMoves(sq?) -> Move[],    // all legal moves, or only those from `sq`
  move({ from, to, promotion? }) -> Move | null,   // applies it; null if illegal
  undo() -> Move | null,
  inCheck() -> boolean,
  kingSquare(color) -> sq,
  status() -> 'playing' | 'checkmate' | 'stalemate' | 'draw-50' | 'draw-repetition' | 'draw-material',
  history() -> Move[],          // moves played so far
  fen() -> string,
}
Move = {
  from, to, piece, color,
  captured?: type,              // type of the captured piece
  capturedSquare?: sq,          // where it stood (differs from `to` for en passant)
  promotion?: type,
  castle?: 'k' | 'q', rookFrom?: sq, rookTo?: sq,
  enPassant?: true, double?: true,
  check: boolean, mate: boolean,
  san: string,                  // e.g. 'Nxe5+', 'O-O', 'e8=Q#'
}

// ai.js
export function searchBestMove(fen, { level, timeMs? }) -> Move      // synchronous
export function createAI() -> { requestMove(fen, level) -> Promise<Move>, cancel(), dispose() }
// createAI runs searchBestMove in ./ai.worker.js (module worker); if a Worker
// cannot be created it falls back to running it on the main thread after a
// setTimeout so the UI can paint first.
```

## World — `src/world/index.js`

```js
export function createWorld({ bus }) -> {
  resize(layout),
  update(dt, view),
  draw(ctx, view),          // behind the pieces: void, field, board squares, highlights, scenery
  drawOverlay(ctx, view),   // in front of the pieces: foreground vines/rain, embers, vignette
  ripple(x, y, strength = 1, color?),   // px coords; a ring that disturbs the field's glyphs
  flash(sq, color?, strength = 1),      // brief burst on one square
  setMood(mood),            // 'title' | 'calm' | 'check' | 'mate' | 'draw'
}
```

The board is part of the field: squares differ by glyph family and tint, no
solid fills. World renders all board highlights from `view`: `selected`,
`targets` (quiet move vs capture look different), `hover`, `lastMove`
(from + to), `checkSquare`.

## Pieces — `src/render/index.js`

```js
export function createPieces({ bus, world }) -> {
  resize(layout),
  sync(game, layout, { instant? }),   // rebuild all actors from game.board() (new game, undo, flip)
  update(dt, view),
  draw(ctx, view),                    // pieces back-to-front, then effects
  play(move, view) -> Promise<void>,  // animate a Move that the engine has ALREADY applied
  finale(status, winner, view) -> Promise<void>,   // checkmate / stalemate / draw sequence
  shake: { x, y },                    // current screen-shake offset in px (main applies it)
}
```

Pieces keep their own actor state, so `play()` works from the Move alone:
slide `from → to`, shatter the actor on `capturedSquare`, move the rook for
`castle`, morph on `promotion`. The selected piece (`view.selected`) lifts and
turns; a dragged piece (`view.drag`) follows the pointer. Emit `sfx` events at
the moment of impact, and disturb the field with `world.ripple()` /
`world.flash()`.

## UI — `src/ui/index.js`

```js
export function createUI({ bus, canvas }) -> {
  resize(layout),
  update(dt, view),
  draw(ctx, view),          // HUD panels, menus, promotion picker, game-over card
}
```

UI owns all DOM input listeners on the canvas/window and the WebAudio synth.
It hit-tests its own widgets first; anything else on the board becomes a
square event. Main owns the selection / move logic.

## Bus events

| event | payload | from → to |
|---|---|---|
| `sq:down` | `{ sq, x, y }` | ui → main (pointer pressed on a square) |
| `sq:move` | `{ sq \| null, x, y }` | ui → main (pointer moved; hover + drag) |
| `sq:up` | `{ sq \| null, x, y }` | ui → main (pointer released) |
| `ui:newGame` | `{ mode, level, humanColor }` | ui → main |
| `ui:undo` `ui:flip` `ui:mute` `ui:menu` | – | ui → main |
| `ui:promote` | `{ piece }` (`'q' 'r' 'b' 'n'`) | ui → main |
| `ui:promoteCancel` | – | ui → main |
| `sfx` | `{ name, intensity? }` | anyone → ui audio |
| `game:start` | `{ config }` | main → all |
| `game:move` | `{ move }` | main → all (after the engine applied it, before the animation) |
| `game:over` | `{ status, winner }` | main → all |

`sfx` names: `select` `deselect` `illegal` `move` `slide` `leap` `land`
`slash` `impact` `shatter` `capture` `castle` `promote` `check` `mate`
`draw` `start` `ui` `tick`.

## Dev harnesses

Each visual module ships `dev/<module>.html` that mounts just that module with
a mocked `view` so it can be developed and screenshotted in isolation:
`node tools/serve.mjs <port>` then open `http://localhost:<port>/dev/<module>.html`.
Playwright + Chromium are pre-installed (`require('playwright')`, no install).
