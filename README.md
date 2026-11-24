# ASCII Chess

A chess game where every pixel is a glyph. The board is a region of a flowing
character field, the pieces are 3D sculptures rasterised into tiny shaded
characters, and captures break the victim apart into falling symbols.

- Play against the computer (Novice / Adept / Master) or a friend on the same screen.
- Full rules: castling, en passant, promotion, check, mate, stalemate, fifty-move,
  threefold repetition, insufficient material.
- A different move and kill animation for each piece type.
- Synthesised sound, no audio files. No dependencies, no build step.

## Run

```bash
npm start
```

Then open http://localhost:8080. Any static file server works; the game is
plain ES modules loaded from `index.html`.

## Controls

Click a piece then a square, or drag and drop. `U` undo, `F` flip the board,
`M` mute, `S` settings, `Esc` menu. Add `?fps` to the URL for a frame-time readout.

## Settings

Open with `S` or the SETTINGS button. Choices are saved in the browser.

- **Figures** — Standard / High / Ultra: sculpt each piece from more, smaller glyphs.
- **Board flow** — off freezes the glyphs under and around the board.
- **Ripples** — off removes the rings and flashes from moves and kills.
- **Rain + embers** — off removes falling strands and drifting sparks.
- **Screen shake**, **Idle spin**, **Sound** — on or off.

## Tests

```bash
npm test
```

Runs the engine suite: perft counts on five standard positions, SAN, draw
rules, undo round-trips and the AI levels.

## Layout

```
src/core/     palette, layout, glyph atlas, helpers, event bus
src/engine/   rules, move generation, search (runs in a Worker)
src/world/    the glyph field, board highlights, scenery, moods
src/render/   piece sculptures, sprite cache, choreography, particles
src/ui/       HUD, menus, input, audio
src/main.js   game loop and state machine
dev/          per-module harness pages
```

`CONTRACTS.md` documents the interfaces between the modules.
