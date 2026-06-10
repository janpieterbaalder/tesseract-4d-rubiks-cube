# Tesseract — a 4D Rubik's Cube

A minimalist, dark-mode puzzle: solve a **genuinely 4-dimensional** Rubik's cube
(the 3⁴ hypercube) inside a 3D environment. Pure HTML/CSS/JavaScript on a single
`<canvas>` — **no build step, no dependencies**.

**▶ Play it live: https://janpieterbaalder.github.io/tesseract-4d-rubiks-cube/**

![Tesseract](preview.png)

## Run it

Just open `index.html` in any modern browser (Chrome, Edge, Firefox).

That's it — double-click the file. If your browser restricts `file://` for some
reason, serve the folder instead:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## What makes it actually 4D

A 3D Rubik's cube has **6 flat faces**. Its 4D analogue, the *tesseract*, has
**8 cubic cells**. The puzzle is drawn with the classic 4D perspective
projection: a small cube nested inside a large one, with the six cells between
them shown as tapering "tunnels". The colours you see are real — every one of
the 8 cells is a distinct shade.

- **80 movable pieces** (3⁴ − 1), each carrying one sticker per axis it touches.
- A **twist** turns one cell — all 27 pieces in that slab — by 90° in one of the
  **three** planes perpendicular to the cell's axis. (A 3D cube has only *one*
  such plane per face; the extra planes are what makes this 4-dimensional.)
- Every scramble is generated from the same moves you can make, so it is
  **always solvable**. Solving uses the *visual* criterion (as in MagicCube4D):
  every cell must be a single colour — hidden orientations of pieces whose
  stickers carry no visible information are not required.
- The 8 cells use a **pastel palette** with hues spaced ~45° apart, and opposite
  cells get maximally different hues, so every cell stays recognisable at a glance.

The geometry pipeline is: sticker cube (in 4D) → rotate in 4D (view + twist
animation) → perspective-project **4D → 3D** → orbit → perspective-project
**3D → 2D** → depth-sorted, light-shaded quads.

## How to play

New here? Hit the **Tutorial** button (or press `T`) for an interactive,
step-by-step walkthrough that teaches every control and ends with guided
1-move and 2-move practice solves on the real puzzle.

| Action | Control |
| --- | --- |
| Orbit the view (3D) | Drag |
| Zoom | Scroll / pinch |
| Twist a cell | Click any sticker (where you hit — face, edge or corner block — decides the turn) |
| Twist in reverse | Right-click or `Shift`+click |
| Exact-plane twist | Click a sticker to select its cell, then use the twist panel or keys `1` `2` `3` (`Shift` reverses) |
| Bring a cell to the centre | `Ctrl`+click, or press and hold (touch) — a pure view change |
| Rotate through the 4th dimension | `Shift`+drag, or the **XW/YW/ZW** buttons |
| Scramble · Undo · Reset · Tutorial | `S` · `U` · `R` · `T` |

**Tip:** because cells hide behind one another, rotate in 4D (or ctrl-click a
cell to centre it) to bring a buried cell into view before working on it.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup + HUD panels + tutorial card |
| `styles.css` | Dark, glassy theme around the pastel puzzle |
| `app.js` | 4D model, twist engine, projection, renderer, input, interactive tutorial |

## Tweaking

All visual/geometry constants live at the top of `app.js`:

- `COLORS` — the 8 pastel cell colours
- `FACE_SHRINK` — how far apart the cells sit (lower = more separation / easier to see inside)
- `CENTER_SHRINK` — size of the nested central cube (larger = bigger centre)
- `STICKER_HALF` — sticker size
- `V4D` / `V3D` — 4D and 3D camera distances (inner-vs-outer size ratio, perspective strength)
