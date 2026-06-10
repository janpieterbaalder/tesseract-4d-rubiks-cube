/* ============================================================================
   TESSERACT — a real 4-dimensional (3^4) Rubik's cube
   ----------------------------------------------------------------------------
   The puzzle has 8 cubic CELLS (the 4D analogue of a cube's 6 faces) and
   3^4 - 1 = 80 movable pieces. Each piece carries one coloured sticker per
   axis on which it sits. A "twist" rotates one cell (all 27 pieces in a slab)
   by 90 deg in one of the three planes perpendicular to that cell's axis —
   exactly the 4D analogue of turning a face on a 3D cube.

   Rendering: every sticker is a little 3-cube living on a cell boundary in 4D.
   We rotate it in 4D (view + animation), perspective-project 4D -> 3D (this
   creates the iconic "small cube nested inside a big cube"), then orbit and
   perspective-project 3D -> 2D and paint it with depth-sorted, shaded quads.
   Pure canvas, no dependencies.
   ========================================================================== */

(() => {
'use strict';

// ----------------------------------------------------------------- constants
const X = 0, Y = 1, Z = 2, W = 3;
const AXN = ['X', 'Y', 'Z', 'W'];

// 8 pastel cell colours, hue-spaced ~45° apart so every cell reads distinctly;
// opposite cells (X+/X-, ...) get maximally different hues since both are
// usually visible at the same time.
const COLORS = {
  'X+': '#f8c89a', // pastel apricot
  'X-': '#a4d8f0', // pastel sky blue
  'Y+': '#b7e6a8', // pastel green
  'Y-': '#dcb4ee', // pastel lilac
  'Z+': '#f3e69a', // pastel lemon
  'Z-': '#b3b9f2', // pastel periwinkle
  'W+': '#a3e8cf', // pastel mint
  'W-': '#f5b3c8', // pastel pink — the nested centre cube, the most prominent cell
};
const CELL_LABEL = {
  'W+': 'Outer',   'W-': 'Inner',
  'X+': 'Right',   'X-': 'Left',
  'Y+': 'Top',     'Y-': 'Bottom',
  'Z+': 'Front',   'Z-': 'Back',
};

// geometry constants. The in-cell geometry is UNIFORM: every cell spreads its
// 27 blocks identically along all three of its in-cell axes, and all stickers
// share one size. All visible differences between cells (the nested centre
// cube, the tapering tunnels) come purely from the genuine 4D perspective
// projection — so rotating any cell into the centre reproduces exactly the
// same shape, with no per-cell distortion.
const G = 1.0;          // lattice spacing
const B = 1.65;         // cell-boundary distance along the normal axis
const CELL_SPREAD = 0.45; // in-cell lattice spread: block centres sit at 0, ±CELL_SPREAD
const STICKER_HALF = 0.13; // sticker half-size (CELL_SPREAD - 2*STICKER_HALF = see-through gap)
const V4D = 3.1;        // 4D camera distance — sets inner-vs-outer cell ratio and tunnel taper
const V3D = 7.6;        // 3D camera distance
const PROJ_MIN = 0.34;  // clamp on (V4D - w) so strong 4D perspective can't blow up during 4D rotation

// ----------------------------------------------------------------- math (4x4)
const I4 = () => [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];

function matMul4(A, B) {
  const R = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += A[i][k] * B[k][j];
      R[i][j] = s;
    }
  return R;
}
function matVec4(M, v) {
  return [
    M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2] + M[0][3]*v[3],
    M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2] + M[1][3]*v[3],
    M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2] + M[2][3]*v[3],
    M[3][0]*v[0] + M[3][1]*v[1] + M[3][2]*v[2] + M[3][3]*v[3],
  ];
}
function matVec4i(M, v) {
  const r = matVec4(M, v);
  return [Math.round(r[0]), Math.round(r[1]), Math.round(r[2]), Math.round(r[3])];
}
// integer 90-degree rotation in plane (i,j); dir=+1 sends e_i -> e_j
function rotInt(i, j, dir) {
  const M = I4();
  M[i][i] = 0; M[j][j] = 0;
  M[i][j] = -dir; M[j][i] = dir;
  return M;
}
// continuous rotation in plane (i,j) by angle a
function rotFloat(i, j, a) {
  const M = I4();
  const c = Math.cos(a), s = Math.sin(a);
  M[i][i] = c; M[j][j] = c;
  M[i][j] = -s; M[j][i] = s;
  return M;
}
// rotation by angle a about a unit axis u3 living in the 3 in-cell axes `inAx`
// (Rodrigues in that 3-space, identity on the 4th/cell axis). Used for edge (180)
// and corner (120) grips, which turn about an edge- or body-diagonal of the cell.
function rotAxis(inAx, u3, a) {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const [x, y, z] = u3;
  const R3 = [
    [c + x*x*t,   x*y*t - z*s, x*z*t + y*s],
    [y*x*t + z*s, c + y*y*t,   y*z*t - x*s],
    [z*x*t - y*s, z*y*t + x*s, c + z*z*t],
  ];
  const M = I4();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[inAx[i]][inAx[j]] = R3[i][j];
  return M;
}
// integer version: the grip angles (±90/±120/180) about lattice axes land on a
// signed-permutation matrix, so rounding gives the exact discrete move.
function rotAxisInt(inAx, u3, a) {
  const M = rotAxis(inAx, u3, a);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) M[i][j] = Math.round(M[i][j]);
  return M;
}

// 4D vector helpers + a rotation that carries unit vector f onto unit vector t.
function dot4(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]; }
function norm4(a) { const l = Math.hypot(a[0],a[1],a[2],a[3]) || 1; return [a[0]/l,a[1]/l,a[2]/l,a[3]/l]; }
// Rotation matrix carrying unit vector f toward unit vector t by `frac` of the angle
// between them, in the plane they span (identity on the orthogonal complement).
// frac=1 sends f exactly onto t. Used for view reorientation (clicked cell -> centre),
// exactly like MagicCube4D's ctrl-click "rotate a cell to the -W centre".
function rotBetween(f, t, frac) {
  const c = Math.max(-1, Math.min(1, dot4(f, t)));
  const theta = Math.acos(c) * frac;
  let g = [t[0]-c*f[0], t[1]-c*f[1], t[2]-c*f[2], t[3]-c*f[3]]; // t made perpendicular to f
  const gl = Math.hypot(g[0],g[1],g[2],g[3]);
  if (gl < 1e-9) return I4();           // parallel/anti-parallel: no unique plane
  g = [g[0]/gl,g[1]/gl,g[2]/gl,g[3]/gl];
  const ca = Math.cos(theta), sa = Math.sin(theta), M = I4();
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
    M[i][j] += (ca-1)*(f[i]*f[j] + g[i]*g[j]) + sa*(g[i]*f[j] - f[i]*g[j]);
  return M;
}

// ----------------------------------------------------------------- math (3x3)
function mat3FromYawPitch(yaw, pitch) {
  const cy = Math.cos(yaw),  sy = Math.sin(yaw);
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  // Rx(pitch) * Ry(yaw)
  return [
    [ cy,      0,    sy     ],
    [ sx*sy,   cx,  -sx*cy  ],
    [-cx*sy,   sx,   cx*cy  ],
  ];
}
function matVec3(M, v) {
  return [
    M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
    M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
    M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
  ];
}
const sub3 = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot3 = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
function norm3(a) { const l = Math.hypot(a[0],a[1],a[2]) || 1; return [a[0]/l,a[1]/l,a[2]/l]; }

// ----------------------------------------------------------------- colour util
function hexToRgb(h) {
  return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
}
const RGB = {};
for (const k in COLORS) RGB[k] = hexToRgb(COLORS[k]);
const BG_RGB = [11, 16, 30];

// ----------------------------------------------------------------- the puzzle
const pieces = [];        // each: { solved:[..], cur:[..], rot:4x4, stickers:[{axis,key,rgb}] }
const FACE_KEYS = [];     // unit cube face index quads (built once)

function buildPieces() {
  pieces.length = 0;
  for (let x = -1; x <= 1; x++)
  for (let y = -1; y <= 1; y++)
  for (let z = -1; z <= 1; z++)
  for (let w = -1; w <= 1; w++) {
    if (x === 0 && y === 0 && z === 0 && w === 0) continue; // hidden core
    const solved = [x, y, z, w];
    const stickers = [];
    for (let a = 0; a < 4; a++) {
      if (solved[a] !== 0) {
        const key = AXN[a] + (solved[a] > 0 ? '+' : '-');
        stickers.push({ axis: a, key, rgb: RGB[key] });
      }
    }
    pieces.push({ solved, cur: solved.slice(), rot: I4(), stickers });
  }
}

// 8 cube corners indexed by 3 bits over the in-cell axes; 6 faces as index quads.
// Each face records its LOCAL axis k (0..2) so a click on it knows which in-cell
// axis to twist about (the twist plane is then the other two in-cell axes).
function buildFaceTopology() {
  FACE_KEYS.length = 0;
  // for each of the 3 local axes k, two faces (bit=0 / bit=1)
  for (let k = 0; k < 3; k++) {
    const o0 = (k + 1) % 3, o1 = (k + 2) % 3;
    for (let val = 0; val < 2; val++) {
      const order = [[0,0],[1,0],[1,1],[0,1]];
      const quad = order.map(([u, v]) => {
        let idx = 0;
        idx |= val << k;
        idx |= u   << o0;
        idx |= v   << o1;
        return idx;
      });
      FACE_KEYS.push({ q: quad, axis: k });
    }
  }
}

// current facing axis/sign of a sticker given the piece orientation
function facingOf(piece, sticker) {
  const a = sticker.axis;
  const sign = piece.solved[a]; // +1 / -1
  // home direction vector = sign * e_a, rotated by piece.rot
  const v = [0,0,0,0];
  v[a] = sign;
  const r = matVec4i(piece.rot, v);
  for (let i = 0; i < 4; i++) if (r[i] !== 0) return { fa: i, fs: r[i] > 0 ? 1 : -1 };
  return { fa: a, fs: sign };
}

// the 8 corners (in 4D) of a sticker cube on cell (fa,fs) at lattice position cur.
// In-cell coordinates are pulled toward the cell centre by CELL_SPREAD so the 8
// cells separate and the nested 4D structure becomes visible (MagicCube4D-style).
// The same spread and sticker size apply to every cell and every axis, so the
// model is symmetric under all 4D view rotations: any cell moved to the centre
// looks identical to the cell that was there before.
function stickerCorners(cur, fa, fs) {
  const inAx = [0,1,2,3].filter(a => a !== fa);
  const out = [];
  for (let b = 0; b < 8; b++) {
    const c = [0,0,0,0];
    c[fa] = fs * B;
    for (let t = 0; t < 3; t++) {
      const ax = inAx[t];
      const bit = (b >> t) & 1;
      c[ax] = cur[ax] * G * CELL_SPREAD + (bit ? STICKER_HALF : -STICKER_HALF);
    }
    out.push(c);
  }
  return out;
}

// ----------------------------------------------------------------- twists
const history = [];

function commitTwist(d, sd, i, j, dir) {
  const R = rotInt(i, j, dir);
  applyToSlab(d, sd, R);
}
// general grip: rotate the cell's 27-piece slab by the integer rotation about u3
function commitTwistAxis(d, sd, inAx, u3, theta) {
  applyToSlab(d, sd, rotAxisInt(inAx, u3, theta));
}
function applyToSlab(d, sd, R) {
  for (const p of pieces) {
    if (p.cur[d] === sd) {
      p.cur = matVec4i(R, p.cur);
      p.rot = matMul4(R, p.rot);
    }
  }
}

// Visual solve, like MagicCube4D: every cell is a single colour, i.e. every
// sticker sits on its home-coloured cell. Invisible orientations of the 1- and
// 2-sticker pieces are NOT required (those carry no visible information).
function isSolved() {
  for (const p of pieces) {
    for (const st of p.stickers) {
      const { fa, fs } = facingOf(p, st);
      if (fa !== st.axis || fs !== (p.solved[st.axis] > 0 ? 1 : -1)) return false;
    }
  }
  return true;
}

// the three twist planes available for a cell on axis d
function planesFor(d) {
  const p = [0,1,2,3].filter(a => a !== d);
  return [[p[0],p[1]], [p[1],p[2]], [p[0],p[2]]];
}

// ----------------------------------------------------------------- state / UI
let view4 = I4();             // identity: the +W cell faces the 4D camera and is culled, revealing the nested cells
let yaw = -0.785, pitch = 0.615;                                 // 3D orbit — looks down the body diagonal (symmetric 6-arm pinwheel)
let view3 = mat3FromYawPitch(yaw, pitch);
let zoom = 1.0;

let selected = null;        // { d, sd, key }
let anim = null;            // active animation
let moves = 0;
let timing = false, startT = 0, finalMs = 0;
let scrambledOnce = false;
let solvedState = true;

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
let cssW = 0, cssH = 0, cx = 0, cy = 0, scale = 1, dpr = 1;

let isMobile = false;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  cssW = window.innerWidth; cssH = window.innerHeight;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  isMobile = cssW < 760;
  cx = cssW / 2;
  if (isMobile) {
    // narrow screens: width is the limiting dimension and the cube spreads wide,
    // so scale to width and lift the centre above the bottom control stack.
    cy = cssH * 0.43;
    scale = cssW * 0.142;
  } else {
    cy = cssH / 2 + 6;
    scale = Math.min(cssW, cssH) * 0.160;
  }
}
window.addEventListener('resize', resize);

// ----------------------------------------------------------------- projection
// returns { x, y, cz, cam:[x,y,z] }  (cam = 3D coords after orbit, pre-2D persp)
function project(c4, animMat) {
  let w = animMat ? matVec4(animMat, c4) : c4;
  w = matVec4(view4, w);
  const s4 = V4D / Math.max(V4D - w[3], PROJ_MIN);
  const p = [w[0]*s4, w[1]*s4, w[2]*s4];
  const cam = matVec3(view3, p);
  const s3 = V3D / (V3D - cam[2]);
  return {
    x: cx + cam[0] * s3 * scale * zoom,
    y: cy - cam[1] * s3 * scale * zoom,
    cz: cam[2],
    cam,
  };
}

const LIGHT = norm3([-0.35, 0.62, 0.78]);

// ----------------------------------------------------------------- render
let pickFaces = [];   // {poly, sticker, piece, cz} for hit-testing (front first)
let frontCell = null; // the currently culled (hidden) cell {fa, fs}

function render() {
  ctx.clearRect(0, 0, cssW, cssH);

  // soft central halo for depth — a quiet pastel lilac/blue blend
  const halo = ctx.createRadialGradient(cx, cy - 10, 30, cx, cy - 10, Math.min(cssW, cssH) * 0.62);
  halo.addColorStop(0, 'rgba(150, 140, 205, 0.15)');
  halo.addColorStop(0.5, 'rgba(105, 110, 175, 0.05)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, cssW, cssH);

  const faces = [];
  const animSet = anim && anim.type === 'twist' ? anim.set : null;
  const animMat = animSet
    ? (anim.mode === 'axis' ? rotAxis(anim.inAx, anim.u3, anim.angle) : rotFloat(anim.i, anim.j, anim.angle))
    : null;

  // The cell facing the 4D camera (largest projected +w) is hidden so we can see
  // into the structure — exactly how MagicCube4D opens up the hypercube.
  let cullFa = 3, cullFs = 1, cullBest = -Infinity;
  for (let fa = 0; fa < 4; fa++) for (const fs of [1, -1]) {
    const wv = view4[3][fa] * fs;
    if (wv > cullBest) { cullBest = wv; cullFa = fa; cullFs = fs; }
  }
  frontCell = { fa: cullFa, fs: cullFs };

  for (const piece of pieces) {
    const inSlab = selected && piece.cur[selected.d] === selected.sd;
    const picked = selected && selected.piece === piece;
    const useAnim = animSet && animSet.has(piece) ? animMat : null;

    for (const st of piece.stickers) {
      const { fa, fs } = facingOf(piece, st);
      if (fa === cullFa && fs === cullFs) continue; // hidden front cell
      const inAx = [0,1,2,3].filter(a => a !== fa); // this cell's 3 in-cell axes
      const corners = stickerCorners(piece.cur, fa, fs);
      const P = corners.map(c => project(c, useAnim));

      // sticker-cube centre in cam space (for outward-normal test + depth)
      let ccx = 0, ccy = 0, ccz = 0;
      for (const p of P) { ccx += p.cam[0]; ccy += p.cam[1]; ccz += p.cam[2]; }
      ccx /= 8; ccy /= 8; ccz /= 8;
      const center = [ccx, ccy, ccz];

      for (const face of FACE_KEYS) {
        const q = face.q;
        const a = P[q[0]], b = P[q[1]], c = P[q[2]], d = P[q[3]];
        let n = cross3(sub3(b.cam, a.cam), sub3(c.cam, a.cam));
        // make normal point outward (away from sticker centre)
        const fcx = (a.cam[0]+b.cam[0]+c.cam[0]+d.cam[0]) / 4;
        const fcy = (a.cam[1]+b.cam[1]+c.cam[1]+d.cam[1]) / 4;
        const fcz = (a.cam[2]+b.cam[2]+c.cam[2]+d.cam[2]) / 4;
        if (dot3(n, [fcx-center[0], fcy-center[1], fcz-center[2]]) < 0) n = [-n[0],-n[1],-n[2]];
        n = norm3(n);
        if (n[2] <= 0.02) continue; // back-facing (camera looks down +z)

        const depth = (a.cz + b.cz + c.cz + d.cz) / 4;
        const diff = Math.max(0, dot3(n, LIGHT));
        // capped at 1.0: the pastel palette is bright, so anything above would
        // clip channels at 255 and wash the hues out; the selected cell gets a
        // visible lift so "what will turn" is unmistakable
        const shade = (0.58 + 0.42 * diff) * (inSlab ? 1.12 : 1);

        faces.push({
          poly: [[a.x,a.y],[b.x,b.y],[c.x,c.y],[d.x,d.y]],
          depth, cubeCz: ccz, shade, rgb: st.rgb, inSlab, picked, piece, sticker: st,
          twistAxis: inAx[face.axis], // global in-cell axis this face turns about
        });
      }
    }
  }

  // Sort by sticker-cube centroid first, face depth second. Because each cube is
  // convex and back-faces are culled, its visible faces never overlap each other,
  // so ordering whole cubes back-to-front removes the inter-cell bleed-through.
  faces.sort((p, q) => (p.cubeCz - q.cubeCz) || (p.depth - q.depth)); // far -> near

  const depthFront = faces.length ? faces[faces.length-1].depth : 2;
  const depthBack  = faces.length ? faces[0].depth : -2;
  const depthRange = (depthFront - depthBack) || 1;

  for (const f of faces) {
    const [r, g, b] = f.rgb;
    let R = r * f.shade, Gc = g * f.shade, Bc = b * f.shade;
    // atmospheric fade for far faces
    const t = 1 - (f.depth - depthBack) / depthRange; // 0 near, 1 far
    const fade = 0.42 * t * t;
    R += (BG_RGB[0] - R) * fade;
    Gc += (BG_RGB[1] - Gc) * fade;
    Bc += (BG_RGB[2] - Bc) * fade;

    const p = f.poly;
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    ctx.lineTo(p[1][0], p[1][1]);
    ctx.lineTo(p[2][0], p[2][1]);
    ctx.lineTo(p[3][0], p[3][1]);
    ctx.closePath();

    ctx.fillStyle = `rgb(${R|0},${Gc|0},${Bc|0})`;
    ctx.fill();

    if (f.picked) {
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.stroke();
    } else if (f.inSlab) {
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = 'rgba(200, 228, 255, 0.9)';
      ctx.stroke();
    } else {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(6, 10, 18, 0.5)';
      ctx.stroke();
    }
  }

  // build pick list (front first)
  pickFaces = faces.slice().reverse().map(f => ({ poly: f.poly, sticker: f.sticker, piece: f.piece, twistAxis: f.twistAxis }));
}

// ----------------------------------------------------------------- animation
function ease(t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2; }

// animation durations (ms) — deliberately unhurried so every twist is readable
const DUR_TWIST = 520;      // 90-degree plane twist
const DUR_GRIP = 620;       // 120-degree corner grip
const DUR_GRIP_180 = 720;   // 180-degree edge grip
const DUR_VIEW = 700;       // stepped 4D view rotation
const DUR_CENTER = 820;     // rotate-cell-to-centre view move

// 90-degree plane twist (dock / keyboard / scramble-undo)
function startTwist(d, sd, i, j, dir, opts = {}) {
  if (anim) return false;
  anim = {
    type: 'twist', mode: 'plane', d, sd, i, j, dir,
    set: new Set(pieces.filter(p => p.cur[d] === sd)),
    t: 0, dur: opts.dur || DUR_TWIST, angle: 0, target: dir * Math.PI / 2,
    record: opts.record !== false,
    countDelta: opts.countDelta == null ? 1 : opts.countDelta,
    onDone: opts.onDone,
  };
  return true;
}
// general grip twist about axis u3 (edge = 180, corner = +/-120) by signed `theta`
function startTwistAxis(d, sd, inAx, u3, theta, opts = {}) {
  if (anim) return false;
  anim = {
    type: 'twist', mode: 'axis', d, sd, inAx, u3, theta,
    set: new Set(pieces.filter(p => p.cur[d] === sd)),
    t: 0, dur: opts.dur || (Math.abs(theta) > 2.2 ? DUR_GRIP_180 : DUR_GRIP), angle: 0, target: theta,
    record: opts.record !== false,
    countDelta: opts.countDelta == null ? 1 : opts.countDelta,
    onDone: opts.onDone,
  };
  return true;
}

function startViewRot(i, j, dir) {
  if (anim) return false;
  anim = { type: 'view', mode: 'plane', i, j, dir, t: 0, dur: DUR_VIEW, base: view4 };
  tutorialEvent('rot4d');
  return true;
}
// Reorient the 4D view so the clicked cell rotates to the centre (the small nested
// cube = the -W axis, "really the one furthest from the 4D viewer") — exactly like
// MagicCube4D's ctrl-click. reverse=true sends the central cell out to the clicked
// spot instead (MagicCube4D's right-ctrl-click). Never changes the puzzle state.
function startCenterCell(d, sd, reverse) {
  if (anim) return false;
  const n = [0,0,0,0]; n[d] = sd;
  const cur = norm4(matVec4(view4, n));   // where this cell's normal points in view space
  const ctr = [0, 0, 0, -1];              // -W: the central (smallest, furthest) cube
  const from = reverse ? ctr : cur;
  const to   = reverse ? cur : ctr;
  const theta = Math.acos(Math.max(-1, Math.min(1, dot4(from, to))));
  if (theta < 1e-3) return false;         // already centred
  anim = { type: 'view', mode: 'geo', from, to, base: view4, t: 0, dur: DUR_CENTER };
  tutorialEvent('center');
  return true;
}

let lastT = performance.now();
function tick(now) {
  const dt = now - lastT; lastT = now;

  if (anim) {
    anim.t += dt;
    const k = Math.min(1, anim.t / anim.dur);
    const e = ease(k);
    if (anim.type === 'twist') {
      anim.angle = e * anim.target;
      if (k >= 1) {
        if (anim.mode === 'axis') {
          commitTwistAxis(anim.d, anim.sd, anim.inAx, anim.u3, anim.theta);
          if (anim.record) history.push({ mode:'axis', d:anim.d, sd:anim.sd, inAx:anim.inAx, u3:anim.u3, theta:anim.theta });
        } else {
          commitTwist(anim.d, anim.sd, anim.i, anim.j, anim.dir);
          if (anim.record) history.push({ mode:'plane', d:anim.d, sd:anim.sd, i:anim.i, j:anim.j, dir:anim.dir });
        }
        const rec = anim.record, cd = anim.countDelta;
        const done = anim.onDone;
        const mode = anim.mode;
        anim = null;
        afterMove(cd, rec, mode);
        if (done) done();
      }
    } else if (anim.type === 'view') {
      if (anim.mode === 'geo') view4 = matMul4(rotBetween(anim.from, anim.to, e), anim.base);
      else view4 = matMul4(rotFloat(anim.i, anim.j, e * anim.dir * Math.PI/2), anim.base);
      if (k >= 1) { anim = null; }
    }
  }

  if (timing) updateClock();
  render();
  requestAnimationFrame(tick);
}

function afterMove(countDelta, record, mode) {
  if (record && countDelta > 0) {
    tutorialEvent('twist');
    if (mode === 'axis') tutorialEvent('twistAxis'); // edge/corner grip
  }
  if (scrambledOnce) {
    moves = Math.max(0, moves + countDelta);
    if (!timing && !solvedState && countDelta > 0) { timing = true; startT = performance.now(); }
    el.moves.textContent = moves;
  }
  el.undo.disabled = history.length === 0 || !!anim;
  if (isSolved() && scrambledOnce && !solvedState) win();
}

// ----------------------------------------------------------------- clock
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}
function updateClock() { el.time.textContent = fmt(performance.now() - startT); }

// ----------------------------------------------------------------- actions
function doScramble(n = 26) {
  // drop any in-flight twist animation first — letting it commit on top of the
  // fresh scramble would silently add a move and corrupt the history/counter
  anim = null;
  // reset to solved, then apply random generators instantly
  for (const p of pieces) { p.cur = p.solved.slice(); p.rot = I4(); }
  let last = -1;
  for (let s = 0; s < n; s++) {
    let d, sd, i, j, dir, planeIdx;
    do {
      d = (Math.random()*4)|0;
      sd = Math.random() < 0.5 ? 1 : -1;
    } while (d * 2 + (sd>0?0:1) === last);
    last = d * 2 + (sd>0?0:1);
    const planes = planesFor(d);
    planeIdx = (Math.random()*3)|0;
    [i, j] = planes[planeIdx];
    dir = Math.random() < 0.5 ? 1 : -1;
    commitTwist(d, sd, i, j, dir);
  }
  history.length = 0;
  moves = 0; el.moves.textContent = '0';
  timing = false; startT = performance.now(); el.time.textContent = '0:00';
  scrambledOnce = true; solvedState = false;
  deselect();
  el.undo.disabled = true;
  hide(el.win);
  toast('Scrambled · solve it');
}

function doReset() {
  for (const p of pieces) { p.cur = p.solved.slice(); p.rot = I4(); }
  history.length = 0;
  moves = 0; el.moves.textContent = '0';
  timing = false; el.time.textContent = '0:00';
  scrambledOnce = false; solvedState = true;
  anim = null;
  deselect();
  el.undo.disabled = true;
  hide(el.win);
}

function doUndo() {
  if (anim || history.length === 0) return;
  const m = history.pop();
  if (m.mode === 'axis') startTwistAxis(m.d, m.sd, m.inAx, m.u3, -m.theta, { record: false, countDelta: -1 });
  else startTwist(m.d, m.sd, m.i, m.j, -m.dir, { record: false, countDelta: -1 });
  tutorialEvent('undo');
}

function win() {
  solvedState = true;
  timing = false;
  finalMs = performance.now() - startT;
  if (tutorial.active) { tutorialEvent('solved'); return; } // tutorial handles its own praise
  el.winTime.textContent = fmt(finalMs);
  el.winMoves.textContent = moves;
  // guard: if the player scrambles again within the delay, don't pop the overlay
  setTimeout(() => { if (solvedState) show(el.win); }, 520);
}

// ----------------------------------------------------------------- tutorial
// A guided, interactive course in 5 chapters: each action step waits for the
// player to actually perform it (detected via tutorialEvent hooks in the
// engine), then auto-advances. The practice steps scramble the real puzzle and
// watch for isSolved(), so the player learns on the genuine mechanics.
// The solving method taught in chapter 4 follows the established route for the
// 3^4: Roice Nelson's "Ultimate Solution to a 3x3x3x3" (superliminal.com) and
// the modern methods documented on hypercubing.xyz — two-colour pieces first,
// then three-colour, then four-colour, finishing with the RKT technique.
// Inline SVG illustrations for the tutorial card. Lightly animated via the
// ta-* CSS classes in styles.css (spin / dash-flow / pulse / slide).
function taCellGrid(x0, y0, s, hotR, hotC) {
  let out = '';
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const hot = r === hotR && c === hotC;
    out += `<rect x="${x0 + c * s}" y="${y0 + r * s}" width="${s - 3}" height="${s - 3}" rx="2.5" fill="${hot ? '#f5b3c8' : '#2a3550'}"${hot ? ' class="ta-pulse"' : ''}/>`;
  }
  return out;
}
function taDice(n) {
  const pips = { 1: [[0,0]], 2: [[-1,-1],[1,1]], 3: [[-1,-1],[0,0],[1,1]] }[n]
    .map(([dx,dy]) => `<circle cx="${140 + dx * 13}" cy="${48 + dy * 13}" r="5.5" fill="#0b1020"/>`).join('');
  return `<svg viewBox="0 0 280 96" fill="none"><rect x="112" y="20" width="56" height="56" rx="12" fill="#f3e69a" class="ta-pulse"/>${pips}</svg>`;
}
const TUT_ART = {
  tesseract: `<svg viewBox="0 0 280 96">
    <rect x="102" y="8" width="76" height="80" rx="7" fill="none" stroke="#b3b9f2" stroke-width="2"/>
    <rect x="124" y="31" width="32" height="34" rx="4" fill="none" stroke="#f5b3c8" stroke-width="2" class="ta-pulse"/>
    <path d="M102 8L124 31M178 8L156 31M102 88L124 65M178 88L156 65" fill="none" stroke="#65728c" stroke-width="1.4"/>
  </svg>`,
  cells: `<svg viewBox="0 0 280 96">
    <rect x="102" y="8" width="76" height="80" rx="7" fill="none" stroke="#b3b9f2" stroke-width="2"/>
    <path d="M102 8h76l-22 23h-32z" fill="#b7e6a8" opacity=".4"/>
    <path d="M102 88h76l-22-23h-32z" fill="#dcb4ee" opacity=".4"/>
    <path d="M102 8v80l22-23V31z" fill="#f3e69a" opacity=".35"/>
    <path d="M178 8v80l-22-23V31z" fill="#f8c89a" opacity=".4"/>
    <rect x="124" y="31" width="32" height="34" rx="4" fill="#f5b3c8" opacity=".55" stroke="#f5b3c8"/>
    <text x="14" y="28" fill="#9fb0cc" font-size="10">frame = a cell</text>
    <path d="M74 32l27-10" fill="none" stroke="#65728c" stroke-width="1"/>
    <text x="198" y="56" fill="#9fb0cc" font-size="10">centre = a cell</text>
    <path d="M196 52l-38-2" fill="none" stroke="#65728c" stroke-width="1"/>
  </svg>`,
  orbit: `<svg viewBox="0 0 280 96">
    <path d="M118 35l22-9 22 9-22 9z" fill="#c4e4f5"/>
    <path d="M118 35v22l22 9V44z" fill="#7fb6d9"/>
    <path d="M162 35v22l-22 9V44z" fill="#a4d8f0"/>
    <ellipse cx="140" cy="50" rx="58" ry="24" fill="none" stroke="#9fb0cc" stroke-width="1.6" class="ta-dash"/>
    <path d="M196 60l9-2-5 8z" fill="#9fb0cc"/>
  </svg>`,
  rot4d: `<svg viewBox="0 0 280 96">
    <rect x="104" y="10" width="72" height="76" rx="7" fill="none" stroke="#b3b9f2" stroke-width="2"/>
    <rect x="126" y="32" width="28" height="32" rx="4" fill="none" stroke="#f5b3c8" stroke-width="2"/>
    <path d="M88 48c-18-26 18-44 52-34" fill="none" stroke="#a3e8cf" stroke-width="2" class="ta-dash"/>
    <path d="M136 9l9 2-6 7z" fill="#a3e8cf"/>
    <path d="M192 48c18 26-18 44-52 34" fill="none" stroke="#f3e69a" stroke-width="2" class="ta-dash"/>
    <path d="M144 87l-9-2 6-7z" fill="#f3e69a"/>
  </svg>`,
  center: `<svg viewBox="0 0 280 96">
    <circle cx="118" cy="48" r="17" fill="none" stroke="#65728c" stroke-width="1.4" stroke-dasharray="4 5"/>
    <path d="M118 26v-8M118 70v8M96 48h-8M140 48h8" fill="none" stroke="#65728c" stroke-width="1.4"/>
    <rect x="172" y="36" width="24" height="24" rx="5" fill="#b7e6a8" class="ta-slide"/>
  </svg>`,
  pieces: `<svg viewBox="0 0 280 96">
    <rect x="22" y="22" width="36" height="36" rx="6" fill="#f5b3c8"/><text x="40" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">1c ×8</text>
    <path d="M88 22h36v36z" fill="#b7e6a8"/><path d="M88 22v36h36z" fill="#a4d8f0"/><rect x="88" y="22" width="36" height="36" rx="6" fill="none" stroke="#0b1020"/><text x="106" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">2c ×24</text>
    <rect x="154" y="22" width="12" height="36" fill="#f3e69a"/><rect x="166" y="22" width="12" height="36" fill="#dcb4ee"/><rect x="178" y="22" width="12" height="36" fill="#a3e8cf"/><rect x="154" y="22" width="36" height="36" rx="6" fill="none" stroke="#0b1020"/><text x="172" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">3c ×32</text>
    <rect x="220" y="22" width="18" height="18" fill="#f8c89a"/><rect x="238" y="22" width="18" height="18" fill="#b3b9f2"/><rect x="220" y="40" width="18" height="18" fill="#b7e6a8"/><rect x="238" y="40" width="18" height="18" fill="#f5b3c8"/><rect x="220" y="22" width="36" height="36" rx="6" fill="none" stroke="#0b1020"/><text x="238" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">4c ×16</text>
  </svg>`,
  twist: `<svg viewBox="0 0 280 96">
    <g class="ta-spin">
      <rect x="112" y="20" width="17" height="17" rx="3" fill="#a4d8f0"/><rect x="132" y="20" width="17" height="17" rx="3" fill="#f3e69a"/><rect x="152" y="20" width="17" height="17" rx="3" fill="#b7e6a8"/>
      <rect x="112" y="40" width="17" height="17" rx="3" fill="#f5b3c8"/><rect x="132" y="40" width="17" height="17" rx="3" fill="#dcb4ee"/><rect x="152" y="40" width="17" height="17" rx="3" fill="#f8c89a"/>
      <rect x="112" y="60" width="17" height="17" rx="3" fill="#a3e8cf"/><rect x="132" y="60" width="17" height="17" rx="3" fill="#b3b9f2"/><rect x="152" y="60" width="17" height="17" rx="3" fill="#a4d8f0"/>
    </g>
    <path d="M208 56a68 40 0 0 0-26-36" fill="none" stroke="#9fb0cc" stroke-width="2" class="ta-dash"/>
    <path d="M186 14l-9 1 5 8z" fill="#9fb0cc"/>
  </svg>`,
  grips: `<svg viewBox="0 0 280 96">
    ${taCellGrid(34, 16, 15, 1, 1)}<text x="55" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">face 90°</text>
    ${taCellGrid(118, 16, 15, 1, 0)}<text x="139" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">edge 180°</text>
    ${taCellGrid(202, 16, 15, 0, 0)}<text x="223" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">corner 120°</text>
  </svg>`,
  undo: `<svg viewBox="0 0 280 96">
    <path d="M180 70a36 36 0 1 0-70-10" fill="none" stroke="#a3e8cf" stroke-width="3" stroke-linecap="round" class="ta-dash"/>
    <path d="M101 50l9 17 13-13z" fill="#a3e8cf"/>
  </svg>`,
  comm: `<svg viewBox="0 0 280 96">
    <g class="ta-pop1"><rect x="34" y="30" width="40" height="36" rx="9" fill="#f5b3c8"/><text x="54" y="53" fill="#3a2030" font-size="15" font-weight="700" text-anchor="middle">A</text></g>
    <g class="ta-pop2"><rect x="94" y="30" width="40" height="36" rx="9" fill="#a4d8f0"/><text x="114" y="53" fill="#1d3242" font-size="15" font-weight="700" text-anchor="middle">B</text></g>
    <g class="ta-pop3"><rect x="154" y="30" width="40" height="36" rx="9" fill="#f5b3c8"/><text x="174" y="53" fill="#3a2030" font-size="15" font-weight="700" text-anchor="middle">A′</text></g>
    <g class="ta-pop4"><rect x="214" y="30" width="40" height="36" rx="9" fill="#a4d8f0"/><text x="234" y="53" fill="#1d3242" font-size="15" font-weight="700" text-anchor="middle">B′</text></g>
  </svg>`,
  waves: `<svg viewBox="0 0 280 96">
    <g class="ta-pop1"><circle cx="60" cy="38" r="17" fill="#b7e6a8"/><text x="60" y="42" fill="#15301c" font-size="10" font-weight="700" text-anchor="middle">2c</text><text x="60" y="76" fill="#9fb0cc" font-size="10" text-anchor="middle">24 pieces</text></g>
    <g class="ta-pop2"><circle cx="140" cy="38" r="17" fill="#f3e69a"/><text x="140" y="42" fill="#3a3208" font-size="10" font-weight="700" text-anchor="middle">3c</text><text x="140" y="76" fill="#9fb0cc" font-size="10" text-anchor="middle">32 pieces</text></g>
    <g class="ta-pop3"><circle cx="220" cy="38" r="17" fill="#f5b3c8"/><text x="220" y="42" fill="#3a2030" font-size="10" font-weight="700" text-anchor="middle">4c</text><text x="220" y="76" fill="#9fb0cc" font-size="10" text-anchor="middle">16 pieces</text></g>
    <path d="M82 38h32M162 38h32" fill="none" stroke="#9fb0cc" stroke-width="1.6"/>
    <path d="M112 33l9 5-9 5zM192 33l9 5-9 5z" fill="#9fb0cc"/>
  </svg>`,
  wave1: `<svg viewBox="0 0 280 96">
    <rect x="121" y="14" width="18" height="18" rx="3" fill="none" stroke="#65728c" stroke-dasharray="3 3"/>
    <rect x="103" y="32" width="18" height="18" rx="3" fill="#b7e6a8"/>
    <rect x="121" y="32" width="18" height="18" rx="3" fill="#b7e6a8"/>
    <rect x="139" y="32" width="18" height="18" rx="3" fill="#b7e6a8"/>
    <rect x="121" y="50" width="18" height="18" rx="3" fill="#b7e6a8"/>
    <g class="ta-slide2"><rect x="210" y="14" width="18" height="18" rx="3" fill="#b7e6a8"/><path d="M210 14l9-8 9 8z" fill="#a4d8f0"/></g>
  </svg>`,
  wave2: `<svg viewBox="0 0 280 96">
    <rect x="129" y="8" width="22" height="22" rx="4" fill="#f3e69a"/>
    <rect x="92" y="60" width="22" height="22" rx="4" fill="#dcb4ee"/>
    <rect x="166" y="60" width="22" height="22" rx="4" fill="#a3e8cf"/>
    <path d="M122 58l13-24M160 34l13 24M160 74h-40" fill="none" stroke="#9fb0cc" stroke-width="1.8" class="ta-dash"/>
    <path d="M133 28l4-8 4 8zM176 52l4 9-9-1zM124 69l-8 5 8 5z" fill="#9fb0cc"/>
  </svg>`,
  rkt: `<svg viewBox="0 0 280 96">
    <rect x="103" y="9" width="74" height="78" rx="7" fill="none" stroke="#b3b9f2" stroke-width="2"/>
    ${taCellGrid(125, 33, 11, -1, -1).replace(/#2a3550/g, '#f5b3c8')}
    <path d="M84 48h26M196 48h-26M140 92V72" fill="none" stroke="#a3e8cf" stroke-width="2" class="ta-dash"/>
    <path d="M108 43l9 5-9 5zM172 43l-9 5 9 5zM135 76l5-9 5 9z" fill="#a3e8cf"/>
    <text x="140" y="24" fill="#9fb0cc" font-size="10" text-anchor="middle">= a 3D cube!</text>
  </svg>`,
  dice1: taDice(1), dice2: taDice(2), dice3: taDice(3),
  done: `<svg viewBox="0 0 280 96">
    <path d="M140 12l10 21 23 3-17 16 4 23-20-11-20 11 4-23-17-16 23-3z" fill="#f3e69a" class="ta-pulse"/>
  </svg>`,
};

const TUT_STEPS = [
  // ---- chapter 1: the shape -------------------------------------------------
  {
    ch: 'Chapter 1 · The shape',
    title: 'Welcome to the 4th dimension',
    art: TUT_ART.tesseract,
    text: 'This course teaches you how the 4D cube works and a complete method to solve it. A 3D Rubik\'s cube has 6 flat faces; its 4D big brother has <b>8 cube-shaped cells</b>. What you see is a <i>projection</i> — the same trick as drawing a 3D cube on flat paper, one dimension up. <b>Goal:</b> make every cell a single colour.',
  },
  {
    ch: 'Chapter 1 · The shape',
    title: 'Reading the projection',
    art: TUT_ART.cells,
    text: 'The <b>small cube in the middle</b> is one cell (the one furthest away in 4D). The six <b>tapering tunnels</b> around it are six more. The <b>outer frame</b> they all connect to is the 8th cell — and the cell nearest to you is <b>hidden</b>, exactly like the back face of a drawn 3D cube. All 8 cells are identical cubes; only the projection makes them look different.',
  },
  {
    ch: 'Chapter 1 · The shape',
    title: 'Look around (3D)',
    detect: 'orbit',
    art: TUT_ART.orbit,
    text: '<b>Drag</b> anywhere to orbit the whole projection in 3D. <b>Scroll</b> or <b>pinch</b> to zoom. This never changes the puzzle. Try dragging now!',
  },
  {
    ch: 'Chapter 1 · The shape',
    title: 'Rotate through the 4th dimension',
    detect: 'rot4d',
    art: TUT_ART.rot4d,
    text: 'Press any <b>XW / YW / ZW</b> button (top right) — or <b>Shift+drag</b> — and watch the cells trade places: the centre cube flies out into a tunnel and another cell takes its spot. Still just your viewpoint. This is how you find the hidden cell. Try it!',
  },
  {
    ch: 'Chapter 1 · The shape',
    title: 'Bring any cell to the centre',
    detect: 'center',
    art: TUT_ART.center,
    text: '<b>Ctrl+click</b> a cell — or <b>press and hold</b> it — and it spins straight into the middle. While solving you\'ll do this constantly: centre the cell you\'re working on. Try it on any cell!',
  },
  // ---- chapter 2: the pieces ------------------------------------------------
  {
    ch: 'Chapter 2 · The pieces',
    title: 'Four kinds of pieces',
    art: TUT_ART.pieces,
    text: 'Each cell is a 3×3×3 of blocks, and every block is a piece shared between cells:<br>· <b>8 centre pieces</b> (1 colour) — one per cell, they <i>never move</i> and define each cell\'s colour;<br>· <b>24 face pieces</b> (2 colours);<br>· <b>32 edge pieces</b> (3 colours);<br>· <b>16 corner pieces</b> (4 colours).<br>That\'s 80 moving pieces and about <b>1.8&times;10<sup>120</sup></b> positions — the 3D cube\'s 4.3&times;10<sup>19</sup> is a rounding error next to it.',
  },
  {
    ch: 'Chapter 2 · The pieces',
    title: 'Select, then twist',
    detect: 'twist',
    art: TUT_ART.twist,
    text: '<b>Click any sticker</b> — its cell lights up and the <b>twist panel</b> opens. Now press one of the <b>↺ / ↻ buttons</b>: the whole cell (all 27 blocks) rotates, and the pieces it shares with its six neighbours <b>hop between cells</b>. That hop is how pieces travel. Select a cell and twist it now!',
  },
  {
    ch: 'Chapter 2 · The pieces',
    title: 'The three grips',
    detect: 'twistAxis',
    art: TUT_ART.grips,
    text: '<b>Which block</b> you select matters. A <b>face block</b> offers the three 90° plane turns — but select an <b>edge block</b> and the panel adds a <b>180° flip</b>, or a <b>corner block</b> for a <b>120° spin</b> about its diagonal. Select an edge or corner block (anything that isn\'t a face centre) and press its grip button now!',
  },
  {
    ch: 'Chapter 2 · The pieces',
    title: 'Undo',
    detect: 'undo',
    art: TUT_ART.undo,
    text: 'Press <b>Undo</b> (or <b>U</b>) to take your twist back — it remembers grips too. While learning, undo freely: exploring and rewinding is exactly how you build intuition. Try it!',
  },
  // ---- chapter 3: the core skill --------------------------------------------
  {
    ch: 'Chapter 3 · The core skill',
    title: 'The commutator',
    art: TUT_ART.comm,
    text: 'Nearly every solving sequence on any twisty puzzle is a <b>commutator</b>: do <b>A</b>, do <b>B</b>, <b>undo A</b>, <b>undo B</b>. If A and B barely overlap, almost everything comes back — the net effect touches <i>just a few pieces</i>. That\'s how you move one piece <b>without wrecking what you\'ve already solved</b>.',
  },
  {
    ch: 'Chapter 3 · The core skill',
    title: 'Try a commutator',
    detect: 'twist',
    count: 4,
    art: TUT_ART.comm,
    text: 'Do it for real: select a cell and <b>twist it</b> (A), twist a <i>different</i> cell (B), then select the first cell again and press the <b>opposite arrow</b> (A′), and likewise undo B (B′). Four twists — then study how few stickers actually changed. This pattern, plus patience, solves the whole puzzle.',
  },
  // ---- chapter 4: the method ------------------------------------------------
  {
    ch: 'Chapter 4 · The method',
    title: 'The plan: three waves',
    art: TUT_ART.waves,
    text: 'The proven route (Roice Nelson\'s <i>Ultimate Solution to a 3&times;3&times;3&times;3</i>, and the modern methods at hypercubing.xyz) solves the piece types in waves, easiest to hardest:<br><b>Wave 1</b> — all 24 two-colour pieces;<br><b>Wave 2</b> — all 32 three-colour pieces;<br><b>Wave 3</b> — all 16 four-colour pieces.<br>Each wave reuses a skill from the 3D cube, one dimension up.',
  },
  {
    ch: 'Chapter 4 · The method',
    title: 'Wave 1 — two-colour pieces',
    art: TUT_ART.wave1,
    text: '2-colour pieces behave like the <b>edges of a 3D cube</b>. Each cell owns six of them (its face blocks). Pick a colour, <b>centre that cell</b>, and ferry its six pieces home with short twist sequences — like building the cross on a 3D cube, six times… for eight cells. It\'s long, not hard: at this stage you can still twist fairly freely, so this wave teaches you to <i>see</i> in 4D.',
  },
  {
    ch: 'Chapter 4 · The method',
    title: 'Wave 2 — three-colour pieces',
    art: TUT_ART.wave2,
    text: '3-colour pieces play the role of <b>3D-cube corners</b>. Place them with <b>three-cycles</b>: commutator-built series that swap exactly three pieces and leave <i>everything</i> else untouched. Work cell by cell, and always twist so that solved regions return home by the end of each series. When a sequence goes wrong: <b>Undo</b> back and re-think — never push on blindly.',
  },
  {
    ch: 'Chapter 4 · The method',
    title: 'Wave 3 — the RKT trick',
    art: TUT_ART.rkt,
    text: 'The famous finish for the last 16 corner pieces: <b>centre the last unsolved cell</b> and treat that centre cube as an <b>ordinary 3D Rubik\'s cube</b>. Twisting the cells <i>around</i> it acts exactly like face turns on it — so every 3D algorithm you know can be executed on the 4D cube. This technique is called <b>RKT</b>, and it turns the scariest phase into familiar territory.',
  },
  {
    ch: 'Chapter 4 · The method',
    title: 'Field notes',
    text: 'Honest expectations: a first full solve usually takes <b>several hundred twists</b> over multiple sittings — and completing one at all is a genuine badge of honour (MagicCube4D keeps a Hall of Fame for it). Three rules of thumb:<br>· finish each wave <i>completely</i> before the next;<br>· rotate the <b>view</b>, never destroy solved work to "see better";<br>· the move counter doesn\'t judge — <b>Undo</b> is free.',
  },
  // ---- chapter 5: practice ---------------------------------------------------
  {
    ch: 'Chapter 5 · Practice',
    title: 'Solve: one twist',
    detect: 'solved',
    onEnter: () => doScramble(1),
    art: TUT_ART.dice1,
    text: 'We scrambled the cube with <b>one twist</b>. Hunt down the disturbed cells (4D-rotate or ctrl-click to inspect!), then select the moved block and turn it back with the panel. Wrong guess? <b>Undo</b> and try the opposite arrow or a different grip.',
  },
  {
    ch: 'Chapter 5 · Practice',
    title: 'Solve: two twists',
    detect: 'solved',
    onEnter: () => doScramble(2),
    art: TUT_ART.dice2,
    text: 'Now <b>two twists</b>. Reverse them in opposite order: fix the <i>most recent</i> damage first, then the older one. If the picture confuses you, centre a damaged cell and study which stickers are strangers.',
  },
  {
    ch: 'Chapter 5 · Practice',
    title: 'Solve: three twists',
    detect: 'solved',
    onEnter: () => doScramble(3),
    art: TUT_ART.dice3,
    text: 'Final exam: <b>three twists</b> — a real micro-solve. Use everything: orbit, 4D rotation, centring, the grips, and Undo. There\'s no rush; careful beats fast.',
  },
  {
    ch: 'Chapter 5 · Practice',
    title: 'You\'re a hypercubist now',
    art: TUT_ART.done,
    text: 'You know the shape, the pieces, the commutator and the three-wave method. Press <b>Scramble</b> (S) and begin Wave 1. For deeper study: <i>superliminal.com/cube</i> (the Ultimate Solution, sequence by sequence) and <i>hypercubing.xyz</i> (modern methods, RKT, community). Good luck!',
  },
];
const tutorial = { active: false, step: 0, done: false, advT: null, hits: 0 };

function startTutorial() {
  hide(el.help); hide(el.win);
  doReset();
  tutorial.active = true;
  show(el.tutorial);
  tutorialGoto(0);
  toast('Tutorial started');
}
function exitTutorial() {
  if (!tutorial.active) return;
  tutorial.active = false;
  clearTimeout(tutorial.advT);
  hide(el.tutorial);
  doReset();
}
function tutorialGoto(n) {
  clearTimeout(tutorial.advT);
  tutorial.step = n;
  tutorial.done = false;
  tutorial.hits = 0;
  const st = TUT_STEPS[n];
  el.tutChapter.textContent = st.ch;
  el.tutTitle.textContent = st.title;
  el.tutArt.innerHTML = st.art || '';
  el.tutArt.hidden = !st.art;
  el.tutText.innerHTML = st.text;
  el.tutCheck.hidden = true;
  el.tutCheck.textContent = '✓ Nice!';
  el.tutPrev.disabled = n === 0;
  // steps that wait for an action label the forward button "Skip" until done
  el.tutNext.textContent = n === TUT_STEPS.length - 1 ? 'Finish' : (st.detect ? 'Skip' : 'Next');
  el.tutProgress.innerHTML = TUT_STEPS
    .map((_, i) => `<i class="${i < n ? 'past' : i === n ? 'now' : ''}"></i>`)
    .join('');
  if (st.onEnter) st.onEnter();
}
function tutorialNext() {
  clearTimeout(tutorial.advT);
  if (tutorial.step >= TUT_STEPS.length - 1) { exitTutorial(); toast('Tutorial complete — have fun!'); return; }
  tutorialGoto(tutorial.step + 1);
}
function tutorialEvent(type) {
  if (!tutorial.active || tutorial.done) return;
  const st = TUT_STEPS[tutorial.step];
  if (st.detect !== type) return;
  if (st.count && ++tutorial.hits < st.count) {   // multi-action step: show progress
    el.tutCheck.textContent = `${tutorial.hits} / ${st.count}`;
    el.tutCheck.hidden = false;
    return;
  }
  tutorial.done = true;
  el.tutCheck.textContent = '✓ Nice!';
  el.tutCheck.hidden = false;
  el.tutNext.textContent = tutorial.step === TUT_STEPS.length - 1 ? 'Finish' : 'Next';
  tutorial.advT = setTimeout(tutorialNext, 1400);
}

// ----------------------------------------------------------------- selection
// Clicking a sticker SELECTS its cell (highlighted in the scene) and opens the
// twist panel; twists are then performed with the panel's buttons. If the
// clicked block is an edge or corner block, the panel additionally offers its
// diagonal grip (180 deg flip / 120 deg spin).
function selectCell(d, sd, hit) {
  const key = AXN[d] + (sd > 0 ? '+' : '-');
  let grip = null, piece = null;
  if (hit) {
    piece = hit.piece;
    const inAx = [0,1,2,3].filter(a => a !== d);
    const g = inAx.map(ax => hit.piece.cur[ax]);   // in-cell position, each in {-1,0,1}
    const nz = g.filter(x => x !== 0).length;
    if (nz >= 2) {
      const n = Math.hypot(g[0], g[1], g[2]);
      grip = { inAx, u3: [g[0]/n, g[1]/n, g[2]/n], nz };
    }
  }
  selected = { d, sd, key, grip, piece };
  buildTwistRows();
  el.cellSwatch.style.background = COLORS[key];
  el.cellSwatch.style.color = COLORS[key];
  el.cellName.textContent = `${CELL_LABEL[key]} cell · ${key}`;
  el.dock.dataset.empty = 'false';
}
function deselect() {
  selected = null;
  el.dock.dataset.empty = 'true';
}

const ARROW_CCW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a9 9 0 1 1-1.5 5"/><path d="M3 3v5h5"/></svg>';
const ARROW_CW  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a9 9 0 1 0 1.5 5"/><path d="M21 3v5h-5"/></svg>';

function buildTwistRows() {
  const d = selected.d;
  const planes = planesFor(d);
  el.twistRows.innerHTML = '';
  planes.forEach(([i, j], idx) => {
    const row = document.createElement('div');
    row.className = 'twist-row';
    row.innerHTML =
      `<span class="axis-tag">Plane <b>${AXN[i]}${AXN[j]}</b></span>` +
      `<button class="tw" data-i="${i}" data-j="${j}" data-dir="-1" title="Twist ${AXN[i]}${AXN[j]} CCW (${idx+1})">${ARROW_CCW}</button>` +
      `<button class="tw" data-i="${i}" data-j="${j}" data-dir="1" title="Twist ${AXN[i]}${AXN[j]} CW (Shift+${idx+1})">${ARROW_CW}</button>`;
    el.twistRows.appendChild(row);
  });
  // diagonal grip of the clicked block: edge block = 180 flip, corner = 120 spin
  if (selected.grip) {
    const g = selected.grip;
    const row = document.createElement('div');
    row.className = 'twist-row twist-row-grip';
    row.innerHTML = g.nz === 2
      ? `<span class="axis-tag">Edge flip <b>180°</b></span>` +
        `<button class="tw twa" data-theta="${Math.PI}" title="Flip 180° about this edge's diagonal">${ARROW_CW}</button>`
      : `<span class="axis-tag">Corner spin <b>120°</b></span>` +
        `<button class="tw twa" data-theta="${-2 * Math.PI / 3}" title="Spin 120° CCW about this corner's diagonal">${ARROW_CCW}</button>` +
        `<button class="tw twa" data-theta="${2 * Math.PI / 3}" title="Spin 120° CW about this corner's diagonal">${ARROW_CW}</button>`;
    el.twistRows.appendChild(row);
  }
  el.twistRows.querySelectorAll('.tw').forEach(btn => {
    btn.addEventListener('click', () => {
      if (anim) return;
      if (btn.classList.contains('twa')) {
        startTwistAxis(selected.d, selected.sd, selected.grip.inAx, selected.grip.u3, +btn.dataset.theta);
      } else {
        startTwist(selected.d, selected.sd, +btn.dataset.i, +btn.dataset.j, +btn.dataset.dir);
      }
    });
  });
}

// ----------------------------------------------------------------- picking
function pointInQuad(px, py, q) {
  let inside = false;
  for (let a = 0, b = 3; a < 4; b = a++) {
    const xi = q[a][0], yi = q[a][1], xj = q[b][0], yj = q[b][1];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pickAt(px, py) {
  for (const f of pickFaces) {
    if (pointInQuad(px, py, f.poly)) {
      const { fa, fs } = facingOf(f.piece, f.sticker);
      return { d: fa, sd: fs, faceAxis: f.twistAxis, piece: f.piece };
    }
  }
  return null;
}

// ----------------------------------------------------------------- input
const pointers = new Map(); // active pointers: id -> {x, y}
let drag = null;            // single-pointer orbit / tap state
let pinch = null;           // two-pointer pinch state
const DRAG_THRESH = 7;
const ZOOM_MIN = 0.5, ZOOM_MAX = 2.8;
const LONG_PRESS_MS = 420;   // hold a cell this long -> rotate it to the centre (touch-friendly)
const ROT4D_SENS = 0.0085;   // shift-drag free 4D rotation: radians per pixel

function twoPointerDist() {
  const p = [...pointers.values()];
  return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.classList.add('grabbing');

  if (pointers.size === 1) {
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY,
             yaw0: yaw, pitch0: pitch, base4: view4.map(r => r.slice()),
             shift: e.shiftKey, ctrl: e.ctrlKey, moved: false, consumed: false, button: e.button };
    pinch = null;
    // hold (long-press / mouse hold) on a cell -> rotate that cell to the centre:
    // a touch-friendly equivalent of MagicCube4D's ctrl-click.
    drag.lpTimer = setTimeout(() => {
      if (!drag || drag.moved || drag.consumed || anim) return;
      const hit = pickAt(drag.x0, drag.y0);
      if (hit && startCenterCell(hit.d, hit.sd, false)) { drag.consumed = true; toast('Cell → centre'); }
    }, LONG_PRESS_MS);
  } else if (pointers.size === 2) {
    if (drag && drag.lpTimer) clearTimeout(drag.lpTimer);
    drag = null;                                   // 2nd finger -> pinch, cancel tap/orbit
    pinch = { d0: twoPointerDist(), zoom0: zoom };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && pointers.size >= 2) {
    const d = twoPointerDist();
    if (pinch.d0 > 0) zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinch.zoom0 * d / pinch.d0));
    return;
  }

  if (drag && e.pointerId === drag.id) {
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESH) {
      drag.moved = true;
      if (drag.lpTimer) clearTimeout(drag.lpTimer);   // a drag is not a long-press
    }
    if (drag.moved && !drag.consumed) {
      if (drag.shift) {
        // free 4D rotation, à la MagicCube4D's shift-drag: dx -> X-W plane, dy -> Y-W plane
        const d4 = matMul4(rotFloat(X, W, dx * ROT4D_SENS), rotFloat(Y, W, -dy * ROT4D_SENS));
        view4 = matMul4(d4, drag.base4);
        tutorialEvent('rot4d');
      } else {
        yaw = drag.yaw0 + dx * 0.008;
        pitch = Math.max(-1.35, Math.min(1.35, drag.pitch0 + dy * 0.008));
        view3 = mat3FromYawPitch(yaw, pitch);
        tutorialEvent('orbit');
      }
    }
  } else if (pointers.size === 0) {
    const hit = pickAt(e.clientX, e.clientY);      // hover feedback (mouse only)
    canvas.classList.toggle('pointable', !!hit);
  }
});

function onPointerUp(e) {
  const wasDrag = (drag && e.pointerId === drag.id) ? drag : null;
  if (wasDrag && wasDrag.lpTimer) clearTimeout(wasDrag.lpTimer);
  pointers.delete(e.pointerId);
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

  if (pinch) {
    if (pointers.size < 2) {
      pinch = null;
      if (pointers.size === 1) {                   // one finger left -> resume orbit (no tap)
        const [id, p] = [...pointers.entries()][0];
        drag = { id, x0: p.x, y0: p.y, yaw0: yaw, pitch0: pitch, base4: view4.map(r => r.slice()),
                 shift: false, ctrl: false, moved: true, consumed: false, button: 0 };
      }
    }
  } else if (wasDrag) {
    if (wasDrag.consumed) {
      // long-press already rotated a cell to the centre; nothing more to do
    } else if (!wasDrag.moved) {
      // a clean tap. Ctrl-click / middle-click -> rotate the cell to the centre,
      // exactly like MagicCube4D. A plain tap SELECTS the cell (highlighted) and
      // opens the twist panel — twisting happens via the panel's buttons.
      // Empty space deselects.
      const hit = pickAt(e.clientX, e.clientY);
      if (hit) {
        if (wasDrag.ctrl || wasDrag.button === 1) {
          startCenterCell(hit.d, hit.sd, wasDrag.button === 2);  // right+ctrl reverses
        } else {
          selectCell(hit.d, hit.sd, hit);
        }
      } else {
        deselect();
      }
    }
    drag = null;
  }

  if (pointers.size === 0) canvas.classList.remove('grabbing');
}
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * (e.deltaY < 0 ? 1.08 : 0.926)));
}, { passive: false });

// right-click is "twist reverse"; stop the browser context menu from popping up
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 's') { doScramble(); }
  else if (k === 'u') { doUndo(); }
  else if (k === 'r') { doReset(); }
  else if (k === 't') { if (!tutorial.active) startTutorial(); }
  else if (k === 'h' || k === '?') { toggle(el.help); }
  else if (k === 'escape') { hide(el.help); hide(el.win); exitTutorial(); deselect(); }
  else if (selected && ['1','2','3'].includes(k)) {
    const planes = planesFor(selected.d);
    const [i, j] = planes[+k - 1];
    startTwist(selected.d, selected.sd, i, j, e.shiftKey ? 1 : -1);
  }
});

// ----------------------------------------------------------------- DOM wiring
const el = {
  time: document.getElementById('time'),
  moves: document.getElementById('moves'),
  scramble: document.getElementById('btn-scramble'),
  undo: document.getElementById('btn-undo'),
  reset: document.getElementById('btn-reset'),
  viewReset: document.getElementById('btn-view-reset'),
  help: document.getElementById('help'),
  win: document.getElementById('win'),
  dock: document.getElementById('dock'),
  dockClose: document.getElementById('dock-close'),
  twistRows: document.getElementById('twist-rows'),
  cellSwatch: document.getElementById('cell-swatch'),
  cellName: document.getElementById('cell-name'),
  legendGrid: document.getElementById('legend-grid'),
  legendToggle: document.getElementById('legend-toggle'),
  winTime: document.getElementById('win-time'),
  winMoves: document.getElementById('win-moves'),
  winAgain: document.getElementById('win-again'),
  toast: document.getElementById('toast'),
  tutorial: document.getElementById('tutorial'),
  tutChapter: document.getElementById('tut-chapter'),
  tutArt: document.getElementById('tut-art'),
  tutTitle: document.getElementById('tut-title'),
  tutText: document.getElementById('tut-text'),
  tutCheck: document.getElementById('tut-check'),
  tutPrev: document.getElementById('tut-prev'),
  tutNext: document.getElementById('tut-next'),
  tutExit: document.getElementById('tut-exit'),
  tutProgress: document.getElementById('tut-progress'),
};

el.scramble.addEventListener('click', () => doScramble());
document.querySelectorAll('.btn-mini').forEach(b => {
  b.addEventListener('click', () => { if (!anim) doScramble(+b.dataset.scramble); });
});
el.undo.addEventListener('click', doUndo);
el.reset.addEventListener('click', doReset);
el.dockClose.addEventListener('click', deselect);
el.viewReset.addEventListener('click', () => {
  if (anim) return;
  yaw = -0.785; pitch = 0.615; zoom = 1.0;
  view3 = mat3FromYawPitch(yaw, pitch);
  view4 = I4();
});
document.getElementById('btn-help').addEventListener('click', () => show(el.help));
document.getElementById('btn-help-top').addEventListener('click', () => show(el.help));
document.getElementById('help-close').addEventListener('click', () => hide(el.help));
document.getElementById('help-ok').addEventListener('click', () => hide(el.help));
document.getElementById('btn-tutorial').addEventListener('click', () => { if (!tutorial.active) startTutorial(); });
document.getElementById('help-tutorial').addEventListener('click', () => { if (!tutorial.active) startTutorial(); else hide(el.help); });
el.tutExit.addEventListener('click', exitTutorial);
el.tutNext.addEventListener('click', tutorialNext);
el.tutPrev.addEventListener('click', () => { if (tutorial.step > 0) tutorialGoto(tutorial.step - 1); });
el.winAgain.addEventListener('click', () => { hide(el.win); doScramble(); });

document.querySelectorAll('.rbtn').forEach(b => {
  b.addEventListener('click', () => {
    const map = { xw: [X, W], yw: [Y, W], zw: [Z, W] };
    const [i, j] = map[b.dataset.rot];
    startViewRot(i, j, +b.dataset.dir);
  });
});

el.legendToggle.addEventListener('click', () => {
  el.legendGrid.classList.toggle('collapsed');
  el.legendToggle.textContent = el.legendGrid.classList.contains('collapsed') ? '+' : '–';
});

function buildLegend() {
  el.legendGrid.innerHTML = '';
  for (const key of ['W+','W-','X+','X-','Y+','Y-','Z+','Z-']) {
    const d = document.createElement('div');
    d.className = 'legend-item';
    d.innerHTML = `<i style="background:${COLORS[key]}"></i><span>${CELL_LABEL[key]}</span>`;
    el.legendGrid.appendChild(d);
  }
}

// overlay / toast helpers
function show(node) { node.hidden = false; }
function hide(node) { node.hidden = true; }
function toggle(node) { node.hidden = !node.hidden; }
let toastT = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.toast.hidden = true; }, 1700);
}

// ----------------------------------------------------------------- test hook
// Minimal read/apply access to the puzzle engine for the automated math
// verification in test/math.test.js. Not used by the game itself.
window.__tess = {
  pieces, commitTwist, commitTwistAxis, planesFor, isSolved, facingOf,
  rotInt, rotAxisInt, matMul4, matVec4i, I4, AXN,
  reset: () => { for (const p of pieces) { p.cur = p.solved.slice(); p.rot = I4(); } },
};

// ----------------------------------------------------------------- boot
buildPieces();
buildFaceTopology();
buildLegend();
resize();
// show the how-to overlay once per browser, so new players see the controls
try { if (!localStorage.getItem('tess_help_seen')) { show(el.help); localStorage.setItem('tess_help_seen', '1'); } } catch (_) {}
requestAnimationFrame(tick);

})();
