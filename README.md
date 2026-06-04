# Tesseract — a 4D Rubik's Cube

A minimalist, dark-mode puzzle: solve a **genuinely 4-dimensional** Rubik's cube
(the 3⁴ hypercube) inside a 3D environment. Pure HTML/CSS/JavaScript on a single
`<canvas>` — **no build step, no dependencies**.

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
  **always solvable**. Solving is verified by checking that all 80 pieces are
  home *and* correctly oriented.

The geometry pipeline is: sticker cube (in 4D) → rotate in 4D (view + twist
animation) → perspective-project **4D → 3D** → orbit → perspective-project
**3D → 2D** → depth-sorted, light-shaded quads.

## How to play

| Action | Control |
| --- | --- |
| Orbit the view (3D) | Drag |
| Zoom | Scroll |
| Select a cell | Click any tile |
| Twist the selected cell | Twist panel, or keys `1` `2` `3` (hold `Shift` to reverse) |
| Rotate through the 4th dimension | **4D rotation** panel (brings hidden cells into view) |
| Scramble · Undo · Reset | `S` · `U` · `R` |

**Tip:** because cells hide behind one another, use the *4D rotation* buttons to
bring a buried cell to the outside before working on it.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup + HUD panels |
| `styles.css` | Dark, glassy theme (white / grey / blue, gradients, subtle 3D) |
| `app.js` | 4D model, twist engine, projection, renderer, input |

## Tweaking

All visual/geometry constants live at the top of `app.js`:

- `COLORS` — the 8 cell colours
- `FACE_SHRINK` — how far apart the cells sit (lower = more separation / easier to see inside)
- `STICKER_HALF` — sticker size
- `V4D` / `V3D` — 4D and 3D camera distances (inner-vs-outer size ratio, perspective strength)
