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

// 8 colour-blind-friendly cell colours, derived from the Okabe-Ito palette
// (the standard palette for colour-vision deficiency): the hues avoid the
// classic red/green confusion axes AND every colour sits on its own lightness
// level, so cells stay distinguishable even when hue alone doesn't. Opposite
// cells (X+/X-, ...) get maximally different colours since both are usually
// visible at the same time.
const COLORS = {
  'X+': '#ff9e2c', // vivid orange
  'X-': '#5fc8ff', // bright sky blue
  'Y+': '#00c596', // bright teal-green
  'Y-': '#c77bff', // bright violet
  'Z+': '#ffe03d', // bright yellow
  'Z-': '#4f7dff', // royal blue
  'W+': '#ff5340', // vermillion red
  'W-': '#ffffff', // white — the nested centre cube, the most prominent cell
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
let panX = 0, panY = 0;       // free 2D pan of the projection (right-drag / two-finger drag)

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
    x: cx + panX + cam[0] * s3 * scale * zoom,
    y: cy + panY - cam[1] * s3 * scale * zoom,
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

  // soft central halo for depth — a quiet blue blend matching the new palette
  const halo = ctx.createRadialGradient(cx + panX, cy + panY - 10, 30, cx + panX, cy + panY - 10, Math.min(cssW, cssH) * 0.62);
  halo.addColorStop(0, 'rgba(95, 140, 255, 0.14)');
  halo.addColorStop(0.5, 'rgba(80, 110, 210, 0.05)');
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
        // capped at 1.0: the palette is bright, so anything above would clip
        // channels at 255 and wash the hues out; the selected cell gets a
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
  courseEvent('center', { key: AXN[d] + (sd > 0 ? '+' : '-'), d, sd });
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
        let mv;
        if (anim.mode === 'axis') {
          commitTwistAxis(anim.d, anim.sd, anim.inAx, anim.u3, anim.theta);
          mv = { mode:'axis', d:anim.d, sd:anim.sd, inAx:anim.inAx, u3:anim.u3, theta:anim.theta };
        } else {
          commitTwist(anim.d, anim.sd, anim.i, anim.j, anim.dir);
          mv = { mode:'plane', d:anim.d, sd:anim.sd, i:anim.i, j:anim.j, dir:anim.dir };
        }
        if (anim.record) history.push(mv);
        const rec = anim.record, cd = anim.countDelta;
        const done = anim.onDone;
        anim = null;
        afterMove(cd, rec, mv);
        if (done) done();
      }
    } else if (anim.type === 'view') {
      view4 = matMul4(rotBetween(anim.from, anim.to, e), anim.base);
      if (k >= 1) { anim = null; courseEvent('viewChange'); }
    }
  }

  if (timing) updateClock();
  render();
  requestAnimationFrame(tick);
}

function afterMove(countDelta, record, mv) {
  if (record && countDelta > 0) {
    courseEvent('twist', { mv });
    if (mv.mode === 'axis') courseEvent('twistAxis', { mv }); // edge/corner grip
  }
  courseEvent('moved', { mv, record }); // any committed move (incl. undos) — level goals re-check here
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
  courseEvent('undo');
}

function win() {
  solvedState = true;
  timing = false;
  finalMs = performance.now() - startT;
  if (course.active) { courseEvent('solved'); return; } // the Academy handles its own praise
  el.winTime.textContent = fmt(finalMs);
  el.winMoves.textContent = moves;
  // guard: if the player scrambles again within the delay, don't pop the overlay
  setTimeout(() => { if (solvedState) show(el.win); }, 520);
}

// ----------------------------------------------------------------- academy art
// Inline SVG illustrations for the Academy level card, drawn in the same
// isometric 3D style as the puzzle itself. Lightly animated via the ta-* CSS
// classes in styles.css (spin / dash-flow / pulse / slide).
function taShade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
// solid isometric cube; (x, y) = apex (back corner) of the top face,
// w = half-width of the top diamond, o.d = side depth (defaults to w)
function taCube(x, y, w, hex, o = {}) {
  const h = w * 0.5, d = o.d == null ? w : o.d;
  const top = o.top || taShade(hex, 1.0);
  const left = o.left || taShade(hex, 0.7);
  const right = o.right || taShade(hex, 0.88);
  return `<g${o.cls ? ` class="${o.cls}"` : ''}>` +
    `<path d="M${x} ${y}l${w} ${h}l-${w} ${h}l-${w} -${h}z" fill="${top}"/>` +
    `<path d="M${x - w} ${y + h}l${w} ${h}v${d}l-${w} -${h}z" fill="${left}"/>` +
    `<path d="M${x + w} ${y + h}l-${w} ${h}v${d}l${w} -${h}z" fill="${right}"/></g>`;
}
// isometric wireframe cube (the cell "frame"): silhouette hexagon + the three
// visible inner edges. Optional dash for "hidden" cells.
function taFrame(x, y, w, d, stroke, dash) {
  const h = w * 0.5;
  return `<g fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}>` +
    `<path d="M${x} ${y}l${w} ${h}v${d}l-${w} ${h}l-${w} -${h}v-${d}z"/>` +
    `<path d="M${x - w} ${y + h}L${x} ${y + 2 * h}L${x + w} ${y + h}M${x} ${y + 2 * h}v${d}"/></g>`;
}
// one diamond tile on an isometric top face
function taTile(x, y, cw, attrs) {
  const g = cw - 1.1, h = g * 0.5;
  return `<path d="M${x} ${y}l${g} ${h}l-${g} ${h}l-${g} -${h}z" ${attrs}/>`;
}
// 3x3 grid of tiles on a cube's top face, apex at (x, y), cell half-width cw.
// fills: a single colour or an array of 9; hot cells pulse white.
function taIsoTop(x, y, cw, fills, hot = []) {
  let out = '';
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const tx = x + (c - r) * cw, ty = y + (c + r) * cw * 0.5;
    const isHot = hot.some(([hr, hc]) => hr === r && hc === c);
    const fill = isHot ? '#ffffff' : (Array.isArray(fills) ? fills[r * 3 + c] : fills);
    out += taTile(tx, ty, cw, `fill="${fill}"${isHot ? ' class="ta-pulse"' : ''}`);
  }
  return out;
}
// isometric die: yellow cube with n pips on the top face
function taDice(n) {
  const pips = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]] }[n]
    .map(([a, b]) => `<ellipse cx="${140 + a * 10}" cy="${28 + b * 5}" rx="4.5" ry="2.6" fill="#3a3208"/>`).join('');
  return `<svg viewBox="0 0 280 96">${taCube(140, 16, 24, '#ffe03d', { d: 20, cls: 'ta-pulse' })}${pips}</svg>`;
}
const ART = {
  tesseract: `<svg viewBox="0 0 280 96">
    ${taFrame(140, 8, 38, 32, '#4f7dff')}
    ${taCube(140, 33, 13, '#ffffff', { d: 11, cls: 'ta-pulse' })}
    <path d="M140 8v25M178 27l-25 12.5M102 27l25 12.5M140 78V57" fill="none" stroke="#65728c" stroke-width="1.2"/>
  </svg>`,
  cells: `<svg viewBox="0 0 280 96">
    <path d="M140 8l38 19-38 19-38-19z" fill="#00c596" opacity=".25"/>
    <path d="M102 27l38 19v32l-38-19z" fill="#ffe03d" opacity=".2"/>
    <path d="M178 27l-38 19v32l38-19z" fill="#ff9e2c" opacity=".22"/>
    ${taFrame(140, 8, 38, 32, '#4f7dff', '5 5')}
    ${taCube(140, 33, 13, '#ffffff', { d: 11 })}
    <text x="10" y="22" fill="#9fb0cc" font-size="10">hidden 8th cell</text>
    <path d="M76 25l25 4" fill="none" stroke="#65728c" stroke-width="1"/>
    <text x="206" y="62" fill="#9fb0cc" font-size="10">centre cell</text>
    <path d="M203 58l-49-12" fill="none" stroke="#65728c" stroke-width="1"/>
    <text x="206" y="18" fill="#9fb0cc" font-size="10">tunnel cells</text>
    <path d="M203 16l-40 8" fill="none" stroke="#65728c" stroke-width="1"/>
  </svg>`,
  orbit: `<svg viewBox="0 0 280 96">
    ${taCube(140, 24, 20, '#5fc8ff')}
    <ellipse cx="140" cy="50" rx="58" ry="22" fill="none" stroke="#9fb0cc" stroke-width="1.6" class="ta-dash"/>
    <path d="M196 60l9-2-5 8z" fill="#9fb0cc"/>
  </svg>`,
  rot4d: `<svg viewBox="0 0 280 96">
    ${taFrame(140, 10, 34, 28, '#4f7dff')}
    ${taCube(140, 32, 12, '#ffffff', { d: 10 })}
    <path d="M90 44c-16-26 18-42 50-33" fill="none" stroke="#ff5340" stroke-width="2" class="ta-dash"/>
    <path d="M136 6l9 2-6 7z" fill="#ff5340"/>
    <path d="M190 44c16 26-18 42-50 33" fill="none" stroke="#ffe03d" stroke-width="2" class="ta-dash"/>
    <path d="M144 82l-9-2 6-7z" fill="#ffe03d"/>
  </svg>`,
  center: `<svg viewBox="0 0 280 96">
    <circle cx="106" cy="51" r="18" fill="none" stroke="#65728c" stroke-width="1.4" stroke-dasharray="4 5"/>
    <path d="M106 27v-8M106 75v8M82 51h-8M130 51h8" fill="none" stroke="#65728c" stroke-width="1.4"/>
    ${taCube(172, 36, 15, '#00c596', { d: 13, cls: 'ta-slide' })}
  </svg>`,
  pieces: `<svg viewBox="0 0 280 96">
    ${taCube(40, 22, 15, '#ffffff', { d: 13 })}<text x="40" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">1c ×8</text>
    ${taCube(106, 22, 15, '#00c596', { d: 13, left: taShade('#5fc8ff', 0.7), right: taShade('#5fc8ff', 0.88) })}<text x="106" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">2c ×24</text>
    ${taCube(172, 22, 15, '#ffe03d', { d: 13, left: taShade('#c77bff', 0.7), right: taShade('#ff5340', 0.88) })}<text x="172" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">3c ×32</text>
    ${taCube(238, 22, 15, '#ff9e2c', { d: 13, left: taShade('#00c596', 0.7), right: taShade('#ffffff', 0.88) })}<path d="M238 22l15 7.5-15 7.5z" fill="#4f7dff"/><text x="238" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">4c ×16</text>
  </svg>`,
  twist: `<svg viewBox="0 0 280 96">
    ${taCube(140, 14, 27, '#26314e', { d: 22 })}
    ${taIsoTop(140, 14, 9, ['#5fc8ff', '#ffe03d', '#00c596', '#ffffff', '#c77bff', '#ff9e2c', '#ff5340', '#4f7dff', '#5fc8ff'])}
    <ellipse cx="140" cy="34" rx="62" ry="20" fill="none" stroke="#9fb0cc" stroke-width="1.8" class="ta-dash"/>
    <path d="M200 44l9-3-5 8z" fill="#9fb0cc"/>
  </svg>`,
  grips: `<svg viewBox="0 0 280 96">
    ${taCube(56, 14, 21, '#26314e', { d: 16 })}${taIsoTop(56, 14, 7, '#2f3a58', [[1, 1]])}<text x="56" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">face 90°</text>
    ${taCube(140, 14, 21, '#26314e', { d: 16 })}${taIsoTop(140, 14, 7, '#2f3a58', [[0, 1]])}<text x="140" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">edge 180°</text>
    ${taCube(224, 14, 21, '#26314e', { d: 16 })}${taIsoTop(224, 14, 7, '#2f3a58', [[2, 2]])}<text x="224" y="78" fill="#9fb0cc" font-size="10" text-anchor="middle">corner 120°</text>
  </svg>`,
  undo: `<svg viewBox="0 0 280 96">
    <path d="M180 70a36 36 0 1 0-70-10" fill="none" stroke="#ff5340" stroke-width="3" stroke-linecap="round" class="ta-dash"/>
    <path d="M101 50l9 17 13-13z" fill="#ff5340"/>
  </svg>`,
  comm: `<svg viewBox="0 0 280 96">
    <g class="ta-pop1"><rect x="37" y="36" width="40" height="34" rx="9" fill="${taShade('#ffffff', 0.55)}"/><rect x="34" y="30" width="40" height="34" rx="9" fill="#ffffff"/><text x="54" y="52" fill="#3a2030" font-size="15" font-weight="700" text-anchor="middle">A</text></g>
    <g class="ta-pop2"><rect x="97" y="36" width="40" height="34" rx="9" fill="${taShade('#5fc8ff', 0.55)}"/><rect x="94" y="30" width="40" height="34" rx="9" fill="#5fc8ff"/><text x="114" y="52" fill="#1d3242" font-size="15" font-weight="700" text-anchor="middle">B</text></g>
    <g class="ta-pop3"><rect x="157" y="36" width="40" height="34" rx="9" fill="${taShade('#ffffff', 0.55)}"/><rect x="154" y="30" width="40" height="34" rx="9" fill="#ffffff"/><text x="174" y="52" fill="#3a2030" font-size="15" font-weight="700" text-anchor="middle">A′</text></g>
    <g class="ta-pop4"><rect x="217" y="36" width="40" height="34" rx="9" fill="${taShade('#5fc8ff', 0.55)}"/><rect x="214" y="30" width="40" height="34" rx="9" fill="#5fc8ff"/><text x="234" y="52" fill="#1d3242" font-size="15" font-weight="700" text-anchor="middle">B′</text></g>
  </svg>`,
  waves: `<svg viewBox="0 0 280 96">
    <g class="ta-pop1">${taCube(60, 20, 14, '#00c596', { d: 12, left: taShade('#5fc8ff', 0.7), right: taShade('#5fc8ff', 0.88) })}<text x="60" y="74" fill="#9fb0cc" font-size="10" text-anchor="middle">2c · 24</text></g>
    <g class="ta-pop2">${taCube(140, 20, 14, '#ffe03d', { d: 12, left: taShade('#c77bff', 0.7), right: taShade('#ff5340', 0.88) })}<text x="140" y="74" fill="#9fb0cc" font-size="10" text-anchor="middle">3c · 32</text></g>
    <g class="ta-pop3">${taCube(220, 20, 14, '#ff9e2c', { d: 12, left: taShade('#00c596', 0.7), right: taShade('#ffffff', 0.88) })}<path d="M220 20l14 7-14 7z" fill="#4f7dff"/><text x="220" y="74" fill="#9fb0cc" font-size="10" text-anchor="middle">4c · 16</text></g>
    <path d="M82 40h32M164 40h32" fill="none" stroke="#9fb0cc" stroke-width="1.6"/>
    <path d="M112 35l9 5-9 5zM194 35l9 5-9 5z" fill="#9fb0cc"/>
  </svg>`,
  wave1: `<svg viewBox="0 0 280 96">
    ${taTile(133, 30.5, 13, 'fill="none" stroke="#65728c" stroke-dasharray="3 3"')}
    ${taTile(107, 30.5, 13, 'fill="#00c596"')}
    ${taTile(120, 37, 13, 'fill="#00c596"')}
    ${taTile(133, 43.5, 13, 'fill="#00c596"')}
    ${taTile(107, 43.5, 13, 'fill="#00c596"')}
    ${taCube(222, 25, 11, '#00c596', { d: 9, left: taShade('#5fc8ff', 0.7), right: taShade('#5fc8ff', 0.88), cls: 'ta-slide2' })}
  </svg>`,
  wave2: `<svg viewBox="0 0 280 96">
    ${taCube(140, 4, 13, '#ffe03d', { d: 11 })}
    ${taCube(103, 50, 13, '#c77bff', { d: 11 })}
    ${taCube(177, 50, 13, '#ff5340', { d: 11 })}
    <path d="M118 56l14-24M162 32l13 24M164 78h-44" fill="none" stroke="#9fb0cc" stroke-width="1.8" class="ta-dash"/>
    <path d="M130 26l4-8 4 8zM178 50l4 9-9-1zM126 73l-8 5 8 5z" fill="#9fb0cc"/>
  </svg>`,
  rkt: `<svg viewBox="0 0 280 96">
    ${taFrame(140, 8, 38, 30, '#4f7dff')}
    ${taCube(140, 32, 14, '#ffffff', { d: 12, top: taShade('#ffffff', 0.68) })}
    ${taIsoTop(140, 32, 4.7, '#ffffff')}
    <path d="M82 46h24M198 46h-24M140 94V78" fill="none" stroke="#ff5340" stroke-width="2" class="ta-dash"/>
    <path d="M104 41l9 5-9 5zM176 41l-9 5 9 5zM135 81l5-9 5 9z" fill="#ff5340"/>
    <text x="196" y="20" fill="#9fb0cc" font-size="10">= a 3D cube!</text>
    <path d="M194 18l-26 14" fill="none" stroke="#65728c" stroke-width="1"/>
  </svg>`,
  dice1: taDice(1), dice2: taDice(2), dice3: taDice(3),
  done: `<svg viewBox="0 0 280 96">
    <path d="M140 12l10 21 23 3-17 16 4 23-20-11-20 11 4-23-17-16 23-3z" fill="#ffe03d" class="ta-pulse"/>
  </svg>`,
};

// ----------------------------------------------------------------- academy
// "Hypercube Academy": a course of standalone, hands-on LEVELS that runs
// inside the live 3D scene. Each level sets up the real puzzle (resets,
// engineered states, scrambles or animated demos), states a few objectives,
// and detects completion through courseEvent() hooks wired into the engine:
// twists, grips, undo, piece selection, view moves and solved-state checks.
// Finishing a level unlocks the next; progress persists in localStorage.
// The curriculum runs from zero (reading the projection) to a complete
// solving method for the 3^4, following Roice Nelson's "Ultimate Solution
// to a 3x3x3x3" (superliminal.com) and the modern methods documented on
// hypercubing.xyz: two-colour pieces first, then three-colour, then
// four-colour via the RKT technique.

// --- state inspection used by level goals ------------------------------------
function pieceHome(p) {
  for (const st of p.stickers) {
    const { fa, fs } = facingOf(p, st);
    if (fa !== st.axis || fs !== (p.solved[st.axis] > 0 ? 1 : -1)) return false;
  }
  return true;
}
// "wave" goal: every piece with up to maxC colours is home; bigger pieces are
// not graded (they may stay scrambled) — exactly how the method is practised
function waveSolved(maxC) {
  return pieces.every(p => p.stickers.length > maxC || pieceHome(p));
}
function displacedPieces() { return pieces.filter(p => !pieceHome(p)); }
// is cell (d, sd) currently sitting at the projection centre? The centre is
// the -W direction in view space, so test the W-row of the view matrix.
function cellAtCenter(d, sd) { return view4[3][d] * sd < -0.92; }

// --- move-pattern helpers (commutator / conjugate detection) ----------------
function sameCellMove(a, b) { return a.d === b.d && a.sd === b.sd; }
function isInverseMove(m, a) {
  if (!m || !a || m.mode !== a.mode || !sameCellMove(m, a)) return false;
  if (m.mode === 'plane')
    return (m.i === a.i && m.j === a.j && m.dir === -a.dir) ||
           (m.i === a.j && m.j === a.i && m.dir === a.dir);
  const dp = m.u3[0] * a.u3[0] + m.u3[1] * a.u3[1] + m.u3[2] * a.u3[2];
  if (Math.abs(Math.abs(a.theta) - Math.PI) < 1e-6)            // a 180° flip undoes itself
    return Math.abs(dp) > 0.99 && Math.abs(Math.abs(m.theta) - Math.PI) < 1e-6;
  if (dp > 0.99)  return Math.abs(m.theta + a.theta) < 1e-6;
  if (dp < -0.99) return Math.abs(m.theta - a.theta) < 1e-6;
  return false;
}
// the last n recorded player moves are all the identical plane twist
function lastMovesIdentical(n) {
  const s = course.seq;
  if (s.length < n) return false;
  const a = s[s.length - n];
  if (a.mode !== 'plane') return false;
  return s.slice(-n).every(m =>
    m.mode === 'plane' && sameCellMove(m, a) && m.i === a.i && m.j === a.j && m.dir === a.dir);
}

// --- demo playback: levels can perform animated move sequences ---------------
let demo = null;
function playDemo(moves, gap = 320) {
  demo = { queue: moves.slice(), gap };
  stepDemo();
}
function stepDemo() {
  const cur = demo;
  if (!cur) return;
  const m = cur.queue.shift();
  if (!m) { demo = null; courseEvent('demoDone'); return; }
  const opts = {
    record: false, countDelta: 0,
    onDone: () => setTimeout(() => { if (demo === cur) stepDemo(); }, cur.gap),
  };
  const started = m.mode === 'axis'
    ? startTwistAxis(m.d, m.sd, m.inAx, m.u3, m.theta, opts)
    : startTwist(m.d, m.sd, m.i, m.j, m.dir, opts);
  // another animation (e.g. a view move) may be in flight — retry shortly
  if (!started) {
    cur.queue.unshift(m);
    setTimeout(() => { if (demo === cur) stepDemo(); }, 180);
  }
}
function stopDemo() { demo = null; }

// --- level state builders -----------------------------------------------------
// reset silently to solved, apply an optional instant state builder, then
// initialise the counters so the level starts clean
function levelSetup(build) {
  anim = null;
  stopDemo();
  for (const p of pieces) { p.cur = p.solved.slice(); p.rot = I4(); }
  history.length = 0;
  if (build) build();
  moves = 0; el.moves.textContent = '0';
  timing = false; startT = performance.now(); el.time.textContent = '0:00';
  scrambledOnce = true; solvedState = isSolved();
  deselect();
  el.undo.disabled = true;
  hide(el.win);
}
function levelScramble(n) {
  levelSetup(() => {
    let last = -1;
    for (let s = 0; s < n; s++) {
      let d, sd;
      do { d = (Math.random() * 4) | 0; sd = Math.random() < 0.5 ? 1 : -1; }
      while (d * 2 + (sd > 0 ? 0 : 1) === last);
      last = d * 2 + (sd > 0 ? 0 : 1);
      const [i, j] = planesFor(d)[(Math.random() * 3) | 0];
      commitTwist(d, sd, i, j, Math.random() < 0.5 ? 1 : -1);
    }
  });
}

// the fixed commutator used by the Lab levels:
// A = Top cell, XZ-plane CW; B = Right cell, ZW-plane CW; then A′, B′.
// This pair has the minimal commutator footprint on the 3^4 — it displaces
// just 13 of the 80 pieces (verified by exhaustive search in the tests).
const LAB_A = { mode: 'plane', d: Y, sd: 1, i: X, j: Z, dir: 1 };
const LAB_B = { mode: 'plane', d: X, sd: 1, i: Z, j: W, dir: 1 };
const invMove = (m) => ({ ...m, dir: -m.dir });
const LAB_COMM = [LAB_A, LAB_B, invMove(LAB_A), invMove(LAB_B)];
const commitMove = (m) => m.mode === 'axis'
  ? commitTwistAxis(m.d, m.sd, m.inAx, m.u3, m.theta)
  : commitTwist(m.d, m.sd, m.i, m.j, m.dir);

// --- the curriculum -----------------------------------------------------------
const CHAPTERS = [
  'The Shape',
  'The Pieces',
  'Detective School',
  'The Commutator Lab',
  'The Method · Wave 1',
  'The Method · Wave 2',
  'The Method · Wave 3 + RKT',
  'Graduation',
];

// Level fields: id (progress key) · ch (chapter) · title · art (ART key) ·
// text (lesson, HTML) · hint (optional) · enter() (sets up the puzzle state) ·
// objs() (fresh objective list; built AFTER enter, so it may read course.data) ·
// doneText (string or function, shown on completion).
// Objective fields: text · on (event type or list) · count (default 1) ·
// when(info) (event predicate) · key(info) (count distinct keys instead) ·
// check() (state predicate; completes the objective when true on a listed event).
const LEVELS = [
  // ===== Chapter 1 · The Shape ===============================================
  {
    id: 'shape-1', ch: 0, title: 'Welcome to the 4th dimension', art: 'tesseract',
    text: 'This course takes you from zero to a complete method for solving the 4D cube — in small, hands-on levels played on the real puzzle. First, the shape: a 3D Rubik\'s cube has 6 flat faces; this 4D cube has <b>8 cube-shaped cells</b>. What you see is a <i>projection</i> — the same trick as drawing a 3D cube on flat paper, one dimension up. <b>Goal of the game:</b> make every cell a single colour.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'Drag anywhere to orbit the projection in 3D', on: 'orbit' },
      { text: 'Zoom with scroll or pinch', on: 'zoom' },
    ],
    doneText: 'Orbiting and zooming never change the puzzle — explore freely, always.',
  },
  {
    id: 'shape-2', ch: 0, title: 'Reading the projection', art: 'cells',
    text: 'The <b>small cube in the middle</b> is one cell — the one furthest away in 4D. The six <b>tapering tunnels</b> around it are six more cells. The <b>8th cell</b> is nearest to you and would wrap around the outside, so it is <b>hidden</b> — exactly like the unseen back face of a drawn 3D cube. All 8 cells are identical cubes; only perspective makes them look different. <b>Ctrl+click</b> a cell — or <b>press-and-hold</b> it on touch — to spin it into the centre.',
    hint: 'Click and hold any coloured sticker for half a second — its whole cell flies to the middle.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'Bring a cell to the centre (Ctrl+click / hold)', on: 'center' },
    ],
    doneText: 'The cell you picked now sits in the middle — identical in shape to the one it replaced. That is the 4D symmetry at work: every cell is the centre of its own world.',
  },
  {
    id: 'shape-3', ch: 0, title: 'Rotating through 4D', art: 'rot4d',
    text: 'Hold <b>Shift and drag</b>: the whole structure rotates through the <b>4th dimension</b> and the cells <b>trade places</b> — the centre cube flies out into a tunnel and another cell takes its spot. On touch there is no Shift: <b>press-and-hold a cell</b> to swing it to the centre — that is a 4D rotation too. Either way it is still only your viewpoint; the puzzle itself never changes.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'Rotate through 4D: Shift+drag, or press-and-hold a cell (touch)', on: ['rot4d', 'center'] },
      { text: 'Centre 3 different cells', on: 'center', count: 3, key: (i) => i.key },
    ],
    doneText: 'You can now reach every corner of 4D space. One cell is still always hidden, though…',
  },
  {
    id: 'shape-4', ch: 0, title: 'Find the hidden cell', art: 'center',
    text: 'One cell is always culled from the picture — the one facing the 4D camera — so you can see inside the structure. Right now that is the <b>red Outer cell</b>. A hidden cell can\'t be clicked, so first rotate through 4D until red stickers appear, then centre them. While solving you will do this constantly: <i>no cell is ever really gone</i>.',
    hint: 'Shift+drag slowly in one direction and watch for red stickers; the moment they appear, Ctrl+click one. On touch: keep press-and-holding tunnel cells until the red ones swing into view, then hold one of them.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'Bring the hidden red Outer cell to the centre', on: ['rot4d', 'orbit', 'viewChange'], check: () => cellAtCenter(W, 1) },
    ],
    doneText: 'The red Outer cell — normally wrapped invisibly around everything — now sits politely in the middle. Nothing in 4D can hide from you anymore.',
  },

  // ===== Chapter 2 · The Pieces ==============================================
  {
    id: 'pieces-1', ch: 1, title: 'Piece safari', art: 'pieces',
    text: 'Each cell is a 3×3×3 of blocks, and every block is a <b>piece</b> shared between cells. Four kinds exist:<br>· <b>8 centre pieces</b> (1 colour) — they never move and define each cell\'s colour;<br>· <b>24 face pieces</b> (2 colours);<br>· <b>32 edge pieces</b> (3 colours);<br>· <b>16 corner pieces</b> (4 colours).<br>80 moving pieces, about <b>1.8×10<sup>120</sup></b> positions. Click stickers to select pieces — bag all four kinds, in order.',
    hint: 'A cell\'s centre piece is the middle block of its 3×3×3. The 4-colour pieces are the eight outer corners of each cell.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'Select a 1-colour centre piece', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 1 },
      { text: 'Select a 2-colour face piece', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 2 },
      { text: 'Select a 3-colour edge piece', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 3 },
      { text: 'Select a 4-colour corner piece', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 4 },
    ],
    doneText: 'These four families never mix — a 2-colour piece stays a 2-colour piece forever. The solving method will tame them family by family.',
  },
  {
    id: 'pieces-2', ch: 1, title: 'Your first twist', art: 'twist',
    text: '<b>Click a sticker</b> to select its cell — it lights up and the twist panel opens. Press one of the <b>↺ / ↻</b> buttons: the whole cell, all 27 blocks, rotates 90° in one of <b>three planes</b>. (A 3D face has only one twist plane; the two extra planes are the 4th dimension talking.) Watch the boundary blocks <b>hop into the neighbouring cells</b> — that hop is how pieces travel.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'Twist any cell 90° with the panel buttons', on: 'twist', when: (i) => i.mv.mode === 'plane' },
      { text: 'Press Undo (or U) to take it back', on: 'undo' },
    ],
    doneText: 'Twist and undo — action and eraser. While learning, undo freely: exploring and rewinding is exactly how intuition is built.',
  },
  {
    id: 'pieces-3', ch: 1, title: 'The three grips', art: 'grips',
    text: '<b>Which block</b> you click matters. A face block offers the three 90° plane turns. An <b>edge block</b> adds a <b>180° flip</b> about its diagonal; a <b>corner block</b> adds a <b>120° spin</b>. These grips are shortcuts — each equals some combination of 90° turns — but they make many solving sequences far shorter.',
    hint: 'Edge blocks sit between two face centres of a cell; corner blocks are its eight outermost blocks. Select one and the extra grip row appears in the panel.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'Select an edge block and flip it 180°', on: 'twistAxis', when: (i) => Math.abs(i.mv.theta) > 2.2 },
      { text: 'Select a corner block and spin it 120°', on: 'twistAxis', when: (i) => Math.abs(i.mv.theta) < 2.2 },
      { text: 'Undo both grips', on: 'undo', count: 2 },
    ],
    doneText: 'The full arsenal: three plane turns per cell plus edge and corner grips — and you command them all.',
  },
  {
    id: 'pieces-4', ch: 1, title: 'Four quarters make a whole', art: 'twist',
    text: 'Every 90° twist has <b>order four</b>: repeat it four times and every piece returns exactly home. So no twist is ever destructive — and three forward always equals one back. The cube starts solved; prove the rule yourself.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'Twist the same cell, same plane, same direction 4× in a row', on: 'moved',
        when: (i) => i.record && lastMovesIdentical(4) && isSolved() },
    ],
    doneText: 'Back to solved, exactly as the algebra promises. Undo is still faster — but knowing why both work is the real prize.',
  },

  // ===== Chapter 3 · Detective School ========================================
  {
    id: 'detect-1', ch: 2, title: 'One twist from home', art: 'dice1',
    text: 'The cube has been scrambled with <b>one hidden twist</b>. Find it and reverse it. Detective work: rotate through 4D and centre cells to inspect them — a twist leaves <b>foreign stickers</b> on several neighbouring cells at once. Wrong guess? <b>Undo</b> is free.',
    hint: 'Look for a cell where a whole layer of strangers arrived, select a block in that layer, and try the opposite twist: same plane, other arrow.',
    enter: () => levelScramble(1),
    objs: () => [
      { text: 'Restore every cell to a single colour', on: 'moved', check: isSolved },
    ],
    doneText: 'Your first real solve! That visual hunt — which cells are wounded, which slab moved — is the core skill of all 4D solving.',
  },
  {
    id: 'detect-2', ch: 2, title: 'Two twists deep', art: 'dice2',
    text: 'Now <b>two hidden twists</b>. Reverse them in opposite order: undo the <i>most recent</i> damage first, then the older one — like backing out of a corridor. If the picture overwhelms you, centre one damaged cell and deal with it alone.',
    hint: 'The two twists may overlap. If your first reversal makes things look worse, Undo it and try the other order.',
    enter: () => levelScramble(2),
    objs: () => [
      { text: 'Restore the cube', on: 'moved', check: isSolved },
    ],
    doneText: 'Last in, first out — you just ran a two-move inverse replay entirely in your head.',
  },
  {
    id: 'detect-3', ch: 2, title: 'Three twists deep', art: 'dice3',
    text: '<b>Three hidden twists</b> — a genuine micro-solve. Use the full toolkit: orbit, 4D rotation, centring, careful observation and fearless Undo. There is no clock pressure in this course; careful beats fast, every time.',
    hint: 'Peel it like an onion: find the most superficial damage (often the cell with the most foreign stickers), undo it, then reassess the whole cube.',
    enter: () => levelScramble(3),
    objs: () => [
      { text: 'Restore the cube', on: 'moved', check: isSolved },
    ],
    doneText: 'Three-deep reading is exactly the skill that scales — a full scramble is just "many twists deep".',
  },
  {
    id: 'detect-4', ch: 2, title: 'The twisted grip', art: 'grips',
    text: 'This scramble used a <b>90° twist plus a 180° edge flip</b>. Grip damage looks different: an edge flip trades stickers in pairs, so look for <b>two colours swapped between two cells</b>. Useful fact: a 180° flip is its own inverse — find the right edge block and flip it once.',
    hint: 'First undo whichever damage looks like a plain layer move; then hunt the swapped pairs and press the 180° button on the edge block between the two trading cells.',
    enter: () => levelSetup(() => {
      const d = (Math.random() * 4) | 0, sd = Math.random() < 0.5 ? 1 : -1;
      const [i, j] = planesFor(d)[(Math.random() * 3) | 0];
      commitTwist(d, sd, i, j, Math.random() < 0.5 ? 1 : -1);
      let d2, sd2;
      do { d2 = (Math.random() * 4) | 0; sd2 = Math.random() < 0.5 ? 1 : -1; } while (d2 === d && sd2 === sd);
      const inAx = [0, 1, 2, 3].filter(a => a !== d2);
      const dirs = [[1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1], [0, 1, 1], [0, 1, -1]];
      const u = dirs[(Math.random() * 6) | 0], n = Math.hypot(...u);
      commitTwistAxis(d2, sd2, inAx, u.map(x => x / n), Math.PI);
    }),
    objs: () => [
      { text: 'Restore the cube', on: 'moved', check: isSolved },
    ],
    doneText: 'Detective School: passed. You can read any small wound on the hypercube. Time to learn surgery.',
  },

  // ===== Chapter 4 · The Commutator Lab ======================================
  {
    id: 'comm-1', ch: 3, title: 'The magic four: A B A′ B′', art: 'comm',
    text: 'From here on you must move pieces <b>without wrecking solved work</b>. The universal tool is the <b>commutator</b>: do a twist <b>A</b>, a twist <b>B</b> on a different cell, then <b>undo A by hand</b> (same cell &amp; plane, opposite arrow — not the Undo button!) and <b>undo B</b>. Where A and B barely overlap, almost everything returns — the net effect touches only a few pieces.',
    hint: 'A′ means: select the first cell again, find the same plane row in the panel, press the other arrow.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'A — twist any cell', on: 'twist',
        when: (i) => { course.data.A = i.mv; return true; } },
      { text: 'B — twist a different cell', on: 'twist',
        when: (i) => { if (sameCellMove(i.mv, course.data.A)) return false; course.data.B = i.mv; return true; } },
      { text: 'A′ — reverse your first twist by hand', on: 'twist',
        when: (i) => isInverseMove(i.mv, course.data.A) },
      { text: 'B′ — reverse your second twist', on: 'twist',
        when: (i) => isInverseMove(i.mv, course.data.B) },
    ],
    doneText: () => {
      const n = displacedPieces().length;
      return n === 0
        ? 'Everything came back — your A and B cells didn\'t overlap at all, so the commutator was pure air. Pick two neighbouring cells and the net effect touches just a few pieces. Replay the level and see!'
        : `Count the wounds: only ${n} of the 80 pieces moved — every other piece came home on its own. That is surgical precision, and it scales to every twisty puzzle ever made.`;
    },
  },
  {
    id: 'comm-2', ch: 3, title: 'Spot the damage', art: 'comm',
    text: 'A commutator has just been applied to a solved cube (A on the <b>Top</b> cell, B on the <b>Right</b> cell). Your job: <b>find every displaced piece</b> and click it. Inspect from all sides — centre the Top and Right cells and study where their slabs overlap. Locating damage precisely is how you will plan three-cycles later.',
    hint: 'All damage lives where the Top and Right slabs intersect. Centre the Top cell and look for strangers; then centre the Right cell and finish the list.',
    enter: () => {
      levelSetup(() => LAB_COMM.forEach(commitMove));
      resetView();
      course.data.targets = displacedPieces();
      course.data.found = new Set();
    },
    objs: () => [
      { text: `Click every displaced piece (${course.data.targets.length} to find)`,
        on: 'select', count: course.data.targets.length,
        when: (i) => {
          if (!i.piece || course.data.found.has(i.piece) || !course.data.targets.includes(i.piece)) return false;
          course.data.found.add(i.piece);
          return true;
        } },
    ],
    doneText: 'Every casualty located. Notice the pattern: a commutator\'s footprint is small, local — and therefore predictable.',
  },
  {
    id: 'comm-3', ch: 3, title: 'Rewind the machine', art: 'undo',
    text: 'Watch the demo: a commutator performed before your eyes — <b>A</b> = Top cell, plane XZ ↻ · <b>B</b> = Right cell, plane ZW ↻ · then A′, B′. Now <b>undo it by hand</b>. The inverse of A B A′ B′ is <b>B A B′ A′</b>: replay it backwards, inverting each move. The Undo button won\'t help — the demo left no history. (Restart replays the demo.)',
    hint: 'Do, in order: Right cell · plane ZW · ↻, then Top cell · plane XZ · ↻, then Right cell · plane ZW · ↺, then Top cell · plane XZ · ↺.',
    enter: () => {
      levelSetup();
      resetView();
      playDemo(LAB_COMM);
    },
    objs: () => [
      { text: 'Watch the demo', on: 'demoDone' },
      { text: 'Restore the cube by inverting the commutator', on: 'moved', check: isSolved },
    ],
    doneText: 'You just inverted a four-move machine from memory. Commutators are not spells — they are sentences you can read in both directions.',
  },
  {
    id: 'comm-4', ch: 3, title: 'The setup move: A B A′', art: 'comm',
    text: 'The commutator\'s little sibling is the <b>conjugate</b>: A B A′. Here A is a <b>setup move</b> — it carries an awkward piece into a position the useful move B can reach, and A′ carries the stage back. Read it as <i>"shift the world, act, shift it back"</i>. Conjugates and commutators together generate every solving sequence you will ever need.',
    hint: 'Three moves: any twist, a different cell\'s twist, then the exact inverse of your first twist.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'A — twist any cell (the setup)', on: 'twist',
        when: (i) => { course.data.A = i.mv; return true; } },
      { text: 'B — twist a different cell (the action)', on: 'twist',
        when: (i) => !sameCellMove(i.mv, course.data.A) },
      { text: 'A′ — undo the setup by hand', on: 'twist',
        when: (i) => isInverseMove(i.mv, course.data.A) },
    ],
    doneText: 'The net effect is "B, performed somewhere B could never reach". Lab complete — you now hold the only two tools the method needs.',
  },

  // ===== Chapter 5 · The Method · Wave 1 =====================================
  {
    id: 'method-0', ch: 4, title: 'The plan: three waves', art: 'waves',
    text: 'Time for the real method — the route proven by Roice Nelson\'s <i>Ultimate Solution to a 3×3×3×3</i> and the modern guides at <i>hypercubing.xyz</i>. Solve the piece families in waves, easiest first:<br><b>Wave 1</b> — all 24 two-colour pieces;<br><b>Wave 2</b> — all 32 three-colour pieces;<br><b>Wave 3</b> — all 16 four-colour pieces, via the RKT trick.<br>Finish each wave <i>completely</i> before starting the next. Point out the three families to lock in the plan.',
    enter: () => { levelSetup(); resetView(); },
    objs: () => [
      { text: 'Select a 2-colour piece — Wave 1\'s targets', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 2 },
      { text: 'Select a 3-colour piece — Wave 2\'s targets', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 3 },
      { text: 'Select a 4-colour piece — Wave 3\'s targets', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 4 },
    ],
    doneText: 'Briefing complete. From the next level on, the grader watches exactly one wave at a time.',
  },
  {
    id: 'wave1-1', ch: 4, title: 'Wave 1: faces first', art: 'wave1',
    text: 'The 24 <b>two-colour pieces</b> play the role of a 3D cube\'s edges. Each cell owns six of them (its face blocks). In this level only <b>Wave 1 is graded</b>: bring every 2-colour piece home; whatever happens to the 3- and 4-colour pieces is ignored. Early in a solve you can still twist quite freely — use that freedom.',
    hint: 'A 2-colour piece is home when both stickers sit on their own colour\'s cell. Pick one colour, centre that cell, repair its six face blocks, then take the next cell.',
    enter: () => levelScramble(2),
    objs: () => [
      { text: 'Bring all 24 two-colour pieces home (others may stay wild)', on: 'moved', check: () => waveSolved(2) },
    ],
    doneText: 'Wave 1 clear! The leftover chaos among the bigger pieces is tomorrow\'s problem — in a real solve you would now protect this work with commutators.',
  },
  {
    id: 'wave1-2', ch: 4, title: 'Wave 1: deeper water', art: 'wave1',
    text: 'Same wave, rougher sea: a <b>four-twist scramble</b>. Bring all 24 two-colour pieces home. Strategy over reflexes: pick a colour, centre its cell, ferry its six face blocks home with short sequences, take the next cell. Rotate the <b>view</b> to see better — never destroy solved work for a better look.',
    hint: 'Don\'t chase single pieces across the whole hypercube. Fix one cell, then never twist it carelessly again — or restore it afterwards with A B A′ B′.',
    enter: () => levelScramble(4),
    objs: () => [
      { text: 'Bring all 24 two-colour pieces home', on: 'moved', check: () => waveSolved(2) },
    ],
    doneText: 'That was real Wave-1 work: planning, centring, short sequences. On a full scramble this wave is longer — but never harder.',
  },

  // ===== Chapter 6 · The Method · Wave 2 =====================================
  {
    id: 'wave2-1', ch: 5, title: 'Wave 2: the three-cycle', art: 'wave2',
    text: 'The 32 <b>three-colour pieces</b> take the role of a 3D cube\'s corners. With Wave 1 standing, free twisting is over: place them with <b>commutator-built three-cycles</b> — sequences that cycle a few pieces and put everything else back, exactly as you practised in the Lab. This level grades Waves 1 <b>and</b> 2: all 2- and 3-colour pieces home; 4-colour pieces remain free.',
    hint: 'After every sequence, check your 2-colour pieces. If they broke, Undo back — a good sequence leaves them untouched by construction.',
    enter: () => levelScramble(2),
    objs: () => [
      { text: 'All 2- and 3-colour pieces home (4-colour may stay wild)', on: 'moved', check: () => waveSolved(3) },
    ],
    doneText: 'Two waves standing. Feel the discipline change? From here on, every move must justify what it breaks.',
  },
  {
    id: 'wave2-2', ch: 5, title: 'Wave 2: full repair', art: 'wave2',
    text: 'A <b>three-twist scramble</b>, graded through Wave 2. Work cell by cell. When a piece sits "almost right", remember the grips — a single 180° edge flip or 120° corner spin sometimes does what three plane twists would. And when a plan goes wrong: <b>Undo back and re-think</b>. Never push on blindly.',
    hint: 'A 3-colour piece is only home when all three stickers match their cells — check all three before you move on.',
    enter: () => levelScramble(3),
    objs: () => [
      { text: 'All 2- and 3-colour pieces home', on: 'moved', check: () => waveSolved(3) },
    ],
    doneText: 'Wave 2 mastered. Only the sixteen 4-colour corners remain — and for those, a famous trick awaits.',
  },

  // ===== Chapter 7 · The Method · Wave 3 + RKT ===============================
  {
    id: 'rkt-1', ch: 6, title: 'RKT: a 3D cube in disguise', art: 'rkt',
    text: 'The endgame trick of every hypercubist — <b>RKT</b>: centre the last unsolved cell and look at the small middle cube. It <i>is</i> a 3D Rubik\'s cube. Twisting the cells <b>around</b> it acts on it exactly like face turns act on a normal cube, so <b>every 3D algorithm you know can be executed here</b>. First, set the stage yourself.',
    hint: 'The white Inner cell may be hiding — Shift+drag until white appears, then Ctrl+click / hold it. Then select any tunnel cell and twist, watching the white cube.',
    enter: () => {
      levelSetup();
      // park the view with a tunnel cell centred, so centring white is a real task
      view4 = rotBetween([1, 0, 0, 0], [0, 0, 0, -1], 1);
      yaw = -0.785; pitch = 0.615; zoom = 1.0; panX = 0; panY = 0;
      view3 = mat3FromYawPitch(yaw, pitch);
    },
    objs: () => [
      { text: 'Centre the white Inner cell', on: ['center', 'rot4d', 'orbit', 'viewChange'], check: () => cellAtCenter(W, -1) },
      { text: 'With white centred, twist 3 surrounding cells — watch its faces turn', on: 'twist',
        count: 3, when: (i) => !(i.mv.d === W && i.mv.sd === -1) && cellAtCenter(W, -1) },
    ],
    doneText: 'Those twists turned the white cube\'s faces exactly like F, U and R turns on a 3D cube. In Wave 3 you solve the last cell precisely this way — with your favourite 3D algorithms, played one dimension up.',
  },
  {
    id: 'rkt-2', ch: 6, title: 'Full solve: two twists', art: 'dice2',
    text: 'Everything is graded now — <b>all 80 pieces</b>, including the 4-colour corners. A two-twist scramble: read it, plan it, reverse it. Use the waves if the damage is wide, or pure detective work if it is narrow.',
    enter: () => levelScramble(2),
    objs: () => [
      { text: 'Solve the cube completely', on: 'moved', check: isSolved },
    ],
    doneText: 'A complete solve, corners and all. The full method is now in your hands.',
  },
  {
    id: 'rkt-3', ch: 6, title: 'Full solve: three twists', art: 'dice3',
    text: 'Three twists, fully graded. This is where the course stops holding your hand — and notice that it no longer needs to: you read the projection, command every grip, wield commutators and know the wave plan by heart.',
    enter: () => levelScramble(3),
    objs: () => [
      { text: 'Solve the cube completely', on: 'moved', check: isSolved },
    ],
    doneText: 'Flawless. One final exam stands between you and the title.',
  },

  // ===== Chapter 8 · Graduation ==============================================
  {
    id: 'grad-1', ch: 7, title: 'Final exam', art: 'done',
    text: 'A <b>five-twist scramble</b>, completely graded, no guidance. Take your time — careful beats fast, and Undo costs nothing. For deeper study while (and after) you work: <i>superliminal.com/cube</i> hosts the Ultimate Solution sequence by sequence, and <i>hypercubing.xyz</i> the modern methods and the RKT playbook. A first <b>full</b>-scramble solve usually takes several hundred twists across multiple sittings — and is a genuine badge of honour.',
    hint: 'The wave plan: 2-colour pieces → 3-colour pieces → RKT for the corners. Or out-detective it — five twists can still be read backwards.',
    enter: () => levelScramble(5),
    objs: () => [
      { text: 'Solve the cube completely', on: 'moved', check: isSolved },
    ],
    doneText: 'Graduated — you are a hypercubist now. 🎓 Press Scramble (S) whenever you are ready for the real thing, and may all eight cells come home.',
  },
];

// --- course engine -------------------------------------------------------------
const PROG_KEY = 'tess_course_v1';
function loadProgress() {
  try { return new Set(JSON.parse(localStorage.getItem(PROG_KEY) || '[]')); } catch (_) { return new Set(); }
}
const course = { active: false, idx: 0, objs: [], obj: 0, seq: [], data: {}, done: loadProgress(), complete: false };
function saveProgress() { try { localStorage.setItem(PROG_KEY, JSON.stringify([...course.done])); } catch (_) {} }
function levelUnlocked(i) { return i === 0 || course.done.has(LEVELS[i - 1].id); }
function firstOpenLevel() {
  const i = LEVELS.findIndex(lv => !course.done.has(lv.id));
  return i === -1 ? LEVELS.length - 1 : i;
}

function startLevel(i) {
  hide(el.map); hide(el.help); hide(el.win);
  course.active = true;
  course.idx = i;
  course.obj = 0;
  course.seq = [];
  course.data = {};
  course.complete = false;
  const lv = LEVELS[i];
  lv.enter();
  course.objs = lv.objs().map(o => ({ ...o, hits: 0, keys: new Set() }));
  renderLevel();
  show(el.course);
}
function exitCourse() {
  if (!course.active && el.course.hidden) return;
  course.active = false;
  stopDemo();
  hide(el.course);
  doReset();
}

// every engine hook funnels through here; the current objective decides
// whether the event (or the puzzle state it produced) completes it
function courseEvent(type, info = {}) {
  if (!course.active || course.complete) return;
  if (demo && type !== 'demoDone') return;        // demo moves never score
  if (type === 'moved' && info.record) course.seq.push(info.mv);
  const o = course.objs[course.obj];
  if (!o) return;
  const onList = o.on ? [].concat(o.on) : null;
  if (onList && !onList.includes(type)) return;
  if (o.check) {
    if (!o.check()) return;
  } else {
    if (o.when && !o.when(info)) return;
    if (o.key) o.keys.add(o.key(info)); else o.hits++;
    const got = Math.max(o.hits, o.keys.size);
    if (got < (o.count || 1)) { renderObjectives(); flashCheck(`${got} / ${o.count}`); return; }
  }
  course.obj++;
  renderObjectives();
  if (course.obj >= course.objs.length) completeLevel();
  else flashCheck('✓ Nice!');
}

function completeLevel() {
  const lv = LEVELS[course.idx];
  course.complete = true;
  if (!course.done.has(lv.id)) { course.done.add(lv.id); saveProgress(); }
  clearTimeout(crsCheckT);
  el.crsCheck.hidden = true;
  el.course.classList.add('complete');
  setCourseMin(false); // pop back open so the praise + Next button are visible
  const dt = typeof lv.doneText === 'function' ? lv.doneText() : (lv.doneText || 'Level complete!');
  el.crsText.innerHTML = `<b class="crs-done-tag">✓ Level complete</b><br>${dt}`;
  el.crsHintBtn.hidden = true;
  el.crsHint.hidden = true;
  el.crsRestart.hidden = true;
  el.crsNext.hidden = false;
  el.crsNext.textContent = course.idx === LEVELS.length - 1 ? 'Finish course' : 'Next level';
  toast('Level complete!');
}

// --- course UI -----------------------------------------------------------------
function renderLevel() {
  const lv = LEVELS[course.idx];
  el.crsTag.textContent = `Level ${course.idx + 1} / ${LEVELS.length} · ${CHAPTERS[lv.ch]}`;
  el.crsTitle.textContent = lv.title;
  el.crsArt.innerHTML = lv.art ? ART[lv.art] : '';
  el.crsArt.hidden = !lv.art;
  el.crsText.innerHTML = lv.text;
  el.crsHintBtn.hidden = !lv.hint;
  el.crsHintBtn.textContent = 'Show hint';
  el.crsHint.hidden = true;
  el.crsHint.innerHTML = lv.hint || '';
  el.crsCheck.hidden = true;
  el.crsNext.hidden = true;
  el.crsRestart.hidden = false;
  el.course.classList.remove('complete');
  setCourseMin(false); // a fresh level starts expanded so the lesson is readable
  renderObjectives();
}
function renderObjectives() {
  el.crsObjs.innerHTML = course.objs.map((o, i) => {
    const state = i < course.obj ? 'done' : (i === course.obj && !course.complete) ? 'now' : 'todo';
    const got = Math.max(o.hits, o.keys.size);
    const prog = state === 'now' && (o.count || 1) > 1 && got > 0 ? ` <em>${got} / ${o.count}</em>` : '';
    return `<li class="${state}"><i></i><span>${o.text}${prog}</span></li>`;
  }).join('');
}
let crsCheckT = null;
function flashCheck(msg) {
  el.crsCheck.textContent = msg;
  el.crsCheck.hidden = false;
  clearTimeout(crsCheckT);
  crsCheckT = setTimeout(() => { el.crsCheck.hidden = true; }, 1600);
  // the footer is hidden while minimised — mirror the feedback as a toast
  if (el.course.classList.contains('min')) toast(msg);
}

// minimise the level panel to a slim "current objective" bar: the level keeps
// running and scoring, but the scene is free to work in (vital on phones)
const ICON_MIN = '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_EXPAND = '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function setCourseMin(min) {
  el.course.classList.toggle('min', min);
  el.crsMin.innerHTML = min ? ICON_EXPAND : ICON_MIN;
  el.crsMin.title = min ? 'Expand the level panel (M)' : 'Minimise — the level stays active (M)';
}

function openMap() {
  if (course.active) { course.active = false; stopDemo(); hide(el.course); doReset(); }
  hide(el.help); hide(el.win);
  renderMap();
  show(el.map);
}
const MAP_ICON = {
  done: '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M8 5l10 7-10 7z" fill="currentColor"/></svg>',
  locked: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
};
function renderMap() {
  const total = LEVELS.length;
  const done = LEVELS.filter(lv => course.done.has(lv.id)).length;
  el.mapProgress.textContent = `${done} / ${total} levels`;
  el.mapBarFill.style.width = `${(done / total) * 100}%`;
  el.mapGrad.hidden = done < total;
  let html = '';
  CHAPTERS.forEach((name, c) => {
    html += `<div class="map-chapter"><h3><span>${c + 1}</span>${name}</h3><div class="map-levels">`;
    LEVELS.forEach((lv, i) => {
      if (lv.ch !== c) return;
      const isDone = course.done.has(lv.id);
      const unlocked = levelUnlocked(i);
      const cls = isDone ? 'done' : unlocked ? 'open' : 'locked';
      html += `<button class="map-level ${cls}" data-i="${i}"${unlocked ? '' : ' disabled'}>` +
        `<span class="ml-num">${i + 1}</span><span class="ml-title">${lv.title}</span>` +
        `<span class="ml-icon">${MAP_ICON[cls]}</span></button>`;
    });
    html += '</div></div>';
  });
  el.mapList.innerHTML = html;
  el.mapList.querySelectorAll('.map-level:not(.locked)').forEach(btn => {
    btn.addEventListener('click', () => startLevel(+btn.dataset.i));
  });
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
  el.dock.dataset.empty = 'false';
  courseEvent('select', { piece, d, sd, key });
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
      if (anim || demo) return;
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
function twoPointerMid() {
  const p = [...pointers.values()];
  return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
}
function clampPan() {
  const mx = cssW * 0.75, my = cssH * 0.75;
  panX = Math.max(-mx, Math.min(mx, panX));
  panY = Math.max(-my, Math.min(my, panY));
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.classList.add('grabbing');

  if (pointers.size === 1) {
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY,
             yaw0: yaw, pitch0: pitch, base4: view4.map(r => r.slice()),
             panX0: panX, panY0: panY,
             pan: e.button === 2 || e.altKey,      // right-drag (or Alt+drag) pans the view
             shift: e.shiftKey, ctrl: e.ctrlKey, moved: false, consumed: false, button: e.button };
    pinch = null;
    // hold (long-press / mouse hold) on a cell -> rotate that cell to the centre:
    // a touch-friendly equivalent of MagicCube4D's ctrl-click. Primary button only,
    // so a right-button pan never triggers it.
    if (e.button === 0 && !e.altKey) {
      drag.lpTimer = setTimeout(() => {
        if (!drag || drag.moved || drag.consumed || anim) return;
        const hit = pickAt(drag.x0, drag.y0);
        if (hit && startCenterCell(hit.d, hit.sd, false)) { drag.consumed = true; toast('Cell → centre'); }
      }, LONG_PRESS_MS);
    }
  } else if (pointers.size === 2) {
    if (drag && drag.lpTimer) clearTimeout(drag.lpTimer);
    drag = null;                                   // 2nd finger -> pinch/pan, cancel tap/orbit
    const m = twoPointerMid();
    pinch = { d0: twoPointerDist(), zoom0: zoom, mx0: m.x, my0: m.y, panX0: panX, panY0: panY };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && pointers.size >= 2) {
    // two-finger gesture: pinch zooms about the (initial) midpoint, and moving
    // both fingers pans the view — so zooming never snaps back to the centre
    const d = twoPointerDist(), m = twoPointerMid();
    if (pinch.d0 > 0) {
      const z2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinch.zoom0 * d / pinch.d0));
      const f = z2 / pinch.zoom0;
      panX = pinch.mx0 - cx - (pinch.mx0 - cx - pinch.panX0) * f + (m.x - pinch.mx0);
      panY = pinch.my0 - cy - (pinch.my0 - cy - pinch.panY0) * f + (m.y - pinch.my0);
      zoom = z2;
      clampPan();
      courseEvent('zoom');
    }
    return;
  }

  if (drag && e.pointerId === drag.id) {
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESH) {
      drag.moved = true;
      if (drag.lpTimer) clearTimeout(drag.lpTimer);   // a drag is not a long-press
    }
    if (drag.moved && !drag.consumed) {
      if (drag.pan) {
        panX = drag.panX0 + dx;
        panY = drag.panY0 + dy;
        clampPan();
      } else if (drag.shift) {
        // free 4D rotation, à la MagicCube4D's shift-drag: dx -> X-W plane, dy -> Y-W plane
        const d4 = matMul4(rotFloat(X, W, dx * ROT4D_SENS), rotFloat(Y, W, -dy * ROT4D_SENS));
        view4 = matMul4(d4, drag.base4);
        courseEvent('rot4d');
      } else {
        yaw = drag.yaw0 + dx * 0.008;
        pitch = Math.max(-1.35, Math.min(1.35, drag.pitch0 + dy * 0.008));
        view3 = mat3FromYawPitch(yaw, pitch);
        courseEvent('orbit');
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
  const z2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * (e.deltaY < 0 ? 1.08 : 0.926)));
  // zoom toward the cursor: the point under the pointer stays put on screen,
  // so zooming in never yanks you back to the centre of the cube
  const f = z2 / zoom;
  panX = e.clientX - cx - (e.clientX - cx - panX) * f;
  panY = e.clientY - cy - (e.clientY - cy - panY) * f;
  zoom = z2;
  clampPan();
  courseEvent('zoom');
}, { passive: false });

// right-click is "twist reverse"; stop the browser context menu from popping up
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 's') {
    if (course.active) toast('Exit the Academy to scramble freely');
    else doScramble();
  }
  else if (k === 'u') { doUndo(); }
  else if (k === 'r') {
    if (course.active) { startLevel(course.idx); toast('Level restarted'); }
    else doReset();
  }
  else if (k === 'v') { resetView(); }
  else if (k === 'm') { if (course.active) setCourseMin(!el.course.classList.contains('min')); }
  else if (k === 't' || k === 'l') { el.map.hidden ? openMap() : hide(el.map); }
  else if (k === 'h' || k === '?') { toggle(el.help); }
  else if (k === 'escape') {
    if (!el.map.hidden) hide(el.map);
    else if (course.active) exitCourse();
    hide(el.help); hide(el.win); deselect();
  }
  else if (selected && !demo && ['1','2','3'].includes(k)) {
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
  twistRows: document.getElementById('twist-rows'),
  legendGrid: document.getElementById('legend-grid'),
  legendToggle: document.getElementById('legend-toggle'),
  winTime: document.getElementById('win-time'),
  winMoves: document.getElementById('win-moves'),
  winAgain: document.getElementById('win-again'),
  toast: document.getElementById('toast'),
  course: document.getElementById('course'),
  crsTag: document.getElementById('crs-tag'),
  crsTitle: document.getElementById('crs-title'),
  crsArt: document.getElementById('crs-art'),
  crsText: document.getElementById('crs-text'),
  crsObjs: document.getElementById('crs-objs'),
  crsHintBtn: document.getElementById('crs-hint-btn'),
  crsHint: document.getElementById('crs-hint'),
  crsCheck: document.getElementById('crs-check'),
  crsRestart: document.getElementById('crs-restart'),
  crsNext: document.getElementById('crs-next'),
  crsExit: document.getElementById('crs-exit'),
  crsMap: document.getElementById('crs-map'),
  crsMin: document.getElementById('crs-min'),
  map: document.getElementById('map'),
  mapList: document.getElementById('map-list'),
  mapProgress: document.getElementById('map-progress'),
  mapBarFill: document.getElementById('map-bar-fill'),
  mapGrad: document.getElementById('map-grad'),
};

el.scramble.addEventListener('click', () => {
  if (course.active) { toast('Exit the Academy to scramble freely'); return; }
  doScramble();
});
document.querySelectorAll('.btn-mini').forEach(b => {
  b.addEventListener('click', () => {
    if (anim) return;
    if (course.active) { toast('Exit the Academy to scramble freely'); return; }
    doScramble(+b.dataset.scramble);
  });
});
el.undo.addEventListener('click', doUndo);
el.reset.addEventListener('click', () => {
  if (course.active) { startLevel(course.idx); toast('Level restarted'); }
  else doReset();
});
function resetView() {
  if (anim) return;
  yaw = -0.785; pitch = 0.615; zoom = 1.0; panX = 0; panY = 0;
  view3 = mat3FromYawPitch(yaw, pitch);
  view4 = I4();
}
el.viewReset.addEventListener('click', resetView);
document.getElementById('btn-help-top').addEventListener('click', () => show(el.help));
document.getElementById('help-close').addEventListener('click', () => hide(el.help));
document.getElementById('help-ok').addEventListener('click', () => hide(el.help));
document.getElementById('btn-learn').addEventListener('click', openMap);
document.getElementById('help-learn').addEventListener('click', () => { hide(el.help); openMap(); });
document.getElementById('map-close').addEventListener('click', () => hide(el.map));
document.getElementById('map-continue').addEventListener('click', () => startLevel(firstOpenLevel()));
document.getElementById('map-reset-progress').addEventListener('click', () => {
  course.done.clear(); saveProgress(); renderMap(); toast('Course progress reset');
});
el.crsExit.addEventListener('click', exitCourse);
el.crsMap.addEventListener('click', openMap);
el.crsMin.addEventListener('click', () => setCourseMin(!el.course.classList.contains('min')));
// tapping anywhere on the minimised bar (except its buttons) expands it again
el.course.addEventListener('click', (e) => {
  if (el.course.classList.contains('min') && !e.target.closest('button')) setCourseMin(false);
});
el.crsRestart.addEventListener('click', () => startLevel(course.idx));
el.crsNext.addEventListener('click', () => {
  if (course.idx >= LEVELS.length - 1) { exitCourse(); openMap(); }
  else startLevel(course.idx + 1);
});
el.crsHintBtn.addEventListener('click', () => {
  const open = el.crsHint.hidden;
  el.crsHint.hidden = !open;
  el.crsHintBtn.textContent = open ? 'Hide hint' : 'Show hint';
});
el.winAgain.addEventListener('click', () => { hide(el.win); doScramble(); });

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
  // Academy internals, exposed for test/levels.test.js
  academy: {
    LEVELS, CHAPTERS, course, startLevel, exitCourse, courseEvent, openMap,
    waveSolved, pieceHome, displacedPieces, cellAtCenter, isInverseMove,
    LAB_COMM, commitMove, levelUnlocked, firstOpenLevel,
  },
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
