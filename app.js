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

  // the tutor's "pointing finger": glowing pieces pulse golden while everything
  // else dims to a quiet spotlight, so the student's eye lands exactly where
  // the lesson wants it. Resolved fresh every frame, so dynamic selections
  // (e.g. "every 2-colour piece that is not home yet") fade out piece by piece
  // as the student fixes them.
  const gset = glowSet();
  const gspot = gset && glow.spot;
  const pulse = gset ? 0.5 + 0.5 * Math.sin(performance.now() * 0.0055) : 0;

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
    const lit = gset ? gset.has(piece) : false;
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
        let shade = (0.58 + 0.42 * diff) * (inSlab ? 1.12 : 1);
        if (gset) shade *= lit ? 1.10 + 0.22 * pulse : (gspot ? 0.58 : 1);

        faces.push({
          poly: [[a.x,a.y],[b.x,b.y],[c.x,c.y],[d.x,d.y]],
          depth, cubeCz: ccz, shade, rgb: st.rgb, inSlab, picked, lit, piece, sticker: st,
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
    } else if (f.lit) {
      ctx.lineWidth = 2.3;
      ctx.strokeStyle = `rgba(255, 224, 110, ${0.45 + 0.5 * pulse})`;
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
  if (tut.active) { courseEvent('solved'); return; } // the Academy handles its own praise
  el.winTime.textContent = fmt(finalMs);
  el.winMoves.textContent = moves;
  // guard: if the player scrambles again within the delay, don't pop the overlay
  setTimeout(() => { if (solvedState) show(el.win); }, 520);
}

// ----------------------------------------------------------------- the tutor
// "Hypercube Academy": a personal teacher — Professor Tess — who takes the
// student from zero to a complete solving method INSIDE the live 3D scene.
// Lessons run on a PRACTICE COPY of the puzzle: the player's own game (state,
// history, camera, clock) is snapshotted on entry and restored on exit.
// Every lesson is a sequence of STEPS, and each step is one of:
//   say    — the professor talks (speech bubble; Continue advances);
//   demo   — she performs real moves on the cube while the student watches;
//   goals  — free practice: objectives detected through engine events;
//   guide  — a specific algorithm, move by move: the expected move is spelled
//            out, its slab/block glows, the right dock button pulses, and a
//            wrong move is gently taken back;
//   until  — she performs a view move and waits for it to land.
// Steps may glow pieces in the scene (her "pointing finger"), spotlight them,
// re-stage the puzzle, or centre a cell. Progress persists in localStorage.
// The method is the classic route — Roice Nelson's "Ultimate Solution to a
// 3x3x3x3" (superliminal.com) and hypercubing.xyz: 2-colour pieces first
// (each cell's "plus"), then 3-colour via commutators, then RKT.

// --- the professor: inline SVG avatar with moods -------------------------------
function avatarSVG(mood) {
  const ink = '#1c2440';
  let eyes, mouth, extra = '';
  if (mood === 'happy' || mood === 'party') {
    eyes = `<path d="M24 43q4 -6 8 0M38 43q4 -6 8 0" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
    mouth = `<path d="M29 48q6 8 12 0" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
  } else if (mood === 'think') {
    eyes = `<path d="M24 42h8M38 42h8" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
    mouth = `<path d="M31 51h8" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>`;
  } else { // talk / point
    eyes = `<circle cx="28" cy="42" r="2.9" fill="${ink}"/><circle cx="42" cy="42" r="2.9" fill="${ink}"/>`;
    mouth = `<path d="M30 50q5 4.5 10 0" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>`;
  }
  if (mood === 'point') extra =
    `<path d="M57 51l9 -6" stroke="#4f7dff" stroke-width="3.4" stroke-linecap="round"/>` +
    `<path d="M64 41l10 3 -7 6z" fill="#ffe03d"/>`;
  if (mood === 'party') extra =
    `<path class="ta-pulse" d="M8 30l1.8 4 4 1.8 -4 1.8 -1.8 4 -1.8 -4 -4 -1.8 4 -1.8z" fill="#ffe03d"/>` +
    `<path class="ta-pulse" d="M67 57l1.5 3.4 3.4 1.5 -3.4 1.5 -1.5 3.4 -1.5 -3.4 -3.4 -1.5 3.4 -1.5z" fill="#5fc8ff"/>`;
  return `<svg viewBox="0 0 76 76">
    <rect x="24" y="10" width="40" height="40" rx="10" fill="none" stroke="rgba(199,123,255,0.45)" stroke-dasharray="3 4" stroke-width="1.6"/>
    <path d="M24 50l-7 9M64 50l-3 9" stroke="rgba(199,123,255,0.35)" stroke-width="1.3"/>
    <rect x="12" y="20" width="46" height="46" rx="12" fill="rgba(79,125,255,0.18)" stroke="#4f7dff" stroke-width="2"/>
    <rect x="17" y="25" width="36" height="36" rx="9" fill="#ffffff"/>
    <path d="M35 4l25 9 -25 9 -25 -9z" fill="#161e36" stroke="rgba(160,190,240,0.45)" stroke-width="1.2"/>
    <path d="M35 13L52 21" stroke="#ffe03d" stroke-width="1.6"/>
    <circle cx="52" cy="23.5" r="3" fill="#ffe03d"/>
    ${eyes}${mouth}${extra}
  </svg>`;
}
let avatarMood = null;
function setAvatar(mood) {
  if (mood === avatarMood) return;
  avatarMood = mood;
  el.tutAvatar.innerHTML = avatarSVG(mood);
}
const MOODS = { say: 'talk', demo: 'point', guide: 'point', goals: 'talk', until: 'point' };

// --- glowing pieces: the professor's pointing finger ----------------------------
// sel is a piece array/Set or a function returning one (re-resolved every frame,
// so "every 2-colour piece not home yet" fades out block by block as the
// student repairs them). spot dims everything else to a quiet spotlight.
let glow = null;
function setGlow(sel, spot = true) { glow = sel ? { sel, spot } : null; }
function glowSet() {
  if (!glow) return null;
  const v = typeof glow.sel === 'function' ? glow.sel() : glow.sel;
  if (!v) return null;
  return v instanceof Set ? v : new Set(v);
}

// --- state inspection used by lesson goals --------------------------------------
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

// --- move helpers ----------------------------------------------------------------
const keyOf = (d, sd) => AXN[d] + (sd > 0 ? '+' : '-');
const mvOf = (d, sd, i, j, dir) => ({ mode: 'plane', d, sd, i, j, dir });
const gripOf = (d, sd, u, theta) => {
  const inAx = [0, 1, 2, 3].filter(a => a !== d);
  const n = Math.hypot(u[0], u[1], u[2]);
  return { mode: 'axis', d, sd, inAx, u3: u.map(x => x / n), theta };
};
const invMove = (m) => m.mode === 'axis'
  ? (Math.abs(Math.abs(m.theta) - Math.PI) < 1e-6 ? { ...m } : { ...m, theta: -m.theta })
  : { ...m, dir: -m.dir };

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
// is move a the SAME committed move as expectation b? (a plane twist may be
// reported with its axes swapped + direction flipped — that is the same turn)
function sameMove(a, b) {
  if (!a || !b || a.mode !== b.mode || !sameCellMove(a, b)) return false;
  if (a.mode === 'plane')
    return (a.i === b.i && a.j === b.j && a.dir === b.dir) ||
           (a.i === b.j && a.j === b.i && a.dir === -b.dir);
  const dp = a.u3[0] * b.u3[0] + a.u3[1] * b.u3[1] + a.u3[2] * b.u3[2];
  if (Math.abs(Math.abs(b.theta) - Math.PI) < 1e-6)
    return Math.abs(dp) > 0.99 && Math.abs(Math.abs(a.theta) - Math.PI) < 1e-6;
  return (dp > 0.99 && Math.abs(a.theta - b.theta) < 1e-6) ||
         (dp < -0.99 && Math.abs(a.theta + b.theta) < 1e-6);
}
// rewrite a plane move so its (i, j) matches the dock's row orientation
function normPlane(m) {
  for (const [i, j] of planesFor(m.d)) {
    if (i === m.i && j === m.j) return m;
    if (i === m.j && j === m.i) return { ...m, i, j, dir: -m.dir };
  }
  return m;
}
const cellChip = (key) =>
  `<i class="cellchip" style="background:${COLORS[key]}"></i><b>${CELL_LABEL[key]}</b>`;
// spell a move out the way the student performs it with the dock
function describeMove(m) {
  const key = keyOf(m.d, m.sd);
  if (m.mode === 'plane') {
    const e = normPlane(m);
    const row = planesFor(e.d).findIndex(([i, j]) => i === e.i && j === e.j);
    const keys = isMobile ? '' : ` <span class="key-hint">(key ${row + 1}${e.dir > 0 ? ' + Shift' : ''})</span>`;
    return `select the ${cellChip(key)} cell, then press <b>${e.dir > 0 ? '↻' : '↺'}</b> on the ` +
           `<b>Plane ${AXN[e.i]}${AXN[e.j]}</b> row${keys}`;
  }
  return Math.abs(Math.abs(m.theta) - Math.PI) < 1e-6
    ? `tap the glowing <b>edge block</b> on the ${cellChip(key)} cell, then press its <b>180°</b> flip`
    : `tap the glowing <b>corner block</b> on the ${cellChip(key)} cell, then press its <b>120° ${m.theta > 0 ? '↻' : '↺'}</b> spin`;
}

// --- demo playback: the professor performs animated move sequences ---------------
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
// finish a running demo instantly: commit the in-flight move and the rest of
// the queue without animation, then report completion
function skipDemo() {
  if (!demo) return;
  const cur = demo;
  demo = null;
  if (anim && anim.type === 'twist') {
    if (anim.mode === 'axis') commitTwistAxis(anim.d, anim.sd, anim.inAx, anim.u3, anim.theta);
    else commitTwist(anim.d, anim.sd, anim.i, anim.j, anim.dir);
    anim = null;
  }
  for (const m of cur.queue) commitMove(m);
  courseEvent('demoDone');
}

// --- the practice copy: park & restore the player's own game ---------------------
let savedGame = null;
function snapshotGame() {
  savedGame = {
    cur: pieces.map(p => p.cur.slice()),
    rot: pieces.map(p => p.rot.map(r => r.slice())),
    history: history.slice(),
    moves, scrambledOnce, solvedState,
    timing, elapsed: timing ? performance.now() - startT : 0,
    timeText: el.time.textContent,
    view4: view4.map(r => r.slice()), yaw, pitch, zoom, panX, panY,
  };
}
function restoreGame() {
  const s = savedGame;
  savedGame = null;
  anim = null;
  stopDemo();
  setGlow(null);
  if (!s) { doReset(); return; }
  pieces.forEach((p, i) => { p.cur = s.cur[i].slice(); p.rot = s.rot[i].map(r => r.slice()); });
  history.length = 0;
  history.push(...s.history);
  moves = s.moves; el.moves.textContent = moves;
  scrambledOnce = s.scrambledOnce; solvedState = s.solvedState;
  timing = s.timing; startT = performance.now() - s.elapsed;
  el.time.textContent = s.timeText;
  view4 = s.view4.map(r => r.slice());
  yaw = s.yaw; pitch = s.pitch; zoom = s.zoom; panX = s.panX; panY = s.panY;
  view3 = mat3FromYawPitch(yaw, pitch);
  deselect();
  el.undo.disabled = history.length === 0;
  hide(el.win);
}

// --- lesson state builders --------------------------------------------------------
// reset silently to solved, apply an optional instant state builder, then
// initialise the counters so the lesson starts clean
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
const commitMove = (m) => m.mode === 'axis'
  ? commitTwistAxis(m.d, m.sd, m.inAx, m.u3, m.theta)
  : commitTwist(m.d, m.sd, m.i, m.j, m.dir);

// the fixed commutator used in the commutator lessons:
// A = Top cell, XZ-plane CW; B = Right cell, ZW-plane CW; then A′, B′.
// This pair has the minimal commutator footprint on the 3^4 — it displaces
// just 13 of the 80 pieces (verified by exhaustive search in the tests).
const LAB_A = mvOf(Y, 1, X, Z, 1);
const LAB_B = mvOf(X, 1, Z, W, 1);
const LAB_COMM = [LAB_A, LAB_B, invMove(LAB_A), invMove(LAB_B)];
// the inverse sequence (B A B′ A′): heals exactly what LAB_COMM disturbs
const INV_COMM = [LAB_B, LAB_A, invMove(LAB_B), invMove(LAB_A)];

// fixed moves for the "plus" lessons: PLUS_BREAK carries the green Top cell's
// front plus-arm (the 2-colour piece at [0,1,1,0]) into the sky-blue Left
// cell; BURY then moves it on so only a 2-move sequence can bring it home.
const PLUS_BREAK = mvOf(Z, 1, X, Y, 1);
const BURY = mvOf(X, -1, Y, Z, 1);

// --- glow selectors used by the curriculum ----------------------------------------
const famGlow = (n) => () => pieces.filter(p => p.stickers.length === n);
const notHomeMax = (maxC) => () => pieces.filter(p => p.stickers.length <= maxC && !pieceHome(p));
const greenArmGlow = () => pieces.filter(p => p.stickers.length === 2 && p.solved[Y] === 1 && !pieceHome(p));

// lesson texts adapt to the input device: phones never see Ctrl/Shift talk.
// (isMobile tracks the viewport, which is what the touch layout keys off too.)
const byInput = (mouse, touch) => (isMobile ? touch : mouse);

// --- the curriculum ----------------------------------------------------------------
const CHAPTERS = [
  'Welcome to the 4th Dimension',
  'How the Cube Moves',
  'Detective School',
  'Wave 1 · Build the Plus',
  'The Magic Sequence',
  'Waves 2 & 3 · The Endgame',
  'Graduation',
];

// Lesson fields: id (progress key) · ch (chapter) · title · steps · done (praise).
// Step fields: say (HTML or fn — the professor's bubble) · mood · setup() ·
// view:'reset' · center:[d,sd] · glow (pieces or fn) · spot (default true) ·
// demo() (move list) · guide() (move list) · goals() (objective list) ·
// until:{on, check} · hint · hintGlow.
// Objective fields: text · on (event or list) · count · when(info) · key(info) ·
// check() — identical to the engine's event hooks.
const LESSONS = [
  // ===== Chapter 1 · Welcome to the 4th Dimension ==============================
  {
    id: 'hello', ch: 0, title: 'Meet your teacher',
    steps: [
      { say: 'Hello! I\'m <b>Professor Tess</b> — your personal teacher here at the Hypercube Academy. Together we\'ll go from <i>“what am I even looking at?”</i> to genuinely solving a 4-dimensional Rubik\'s cube, one small step at a time. We\'ll work on a <b>practice cube</b>: your own game is parked safely and comes back the moment you leave.', mood: 'happy' },
      { say: 'A normal Rubik\'s cube has 6 flat faces — this one has <b>8 cube-shaped cells</b>. What you see is a <i>projection</i>, like a drawing of a 3D cube on flat paper, one dimension up. The glowing blocks in the middle are one whole cell; the six <b>tunnels</b> around it are six more; the 8th wraps invisibly around the outside. <b>Goal of the game:</b> make every cell a single colour.',
        glow: () => pieces.filter(p => p.cur[W] === -1) },
      { say: 'First, make friends with the camera. Try both of these — I\'ll watch.',
        goals: () => [
          { text: 'Drag anywhere to orbit the projection in 3D', on: 'orbit' },
          { text: 'Zoom with scroll or pinch', on: 'zoom' },
        ] },
      { say: 'Lovely. And remember: looking around <b>never</b> changes the puzzle — explore freely, always.' },
    ],
    done: 'You and the camera are friends now.',
  },
  {
    id: 'cells', ch: 0, title: 'Eight identical cells',
    steps: [
      { say: 'All 8 cells are <b>identical cubes</b> — only the 4D perspective makes them look different. The glowing tunnel is the orange <b>Right</b> cell. Watch what happens when I bring it to the middle…', mood: 'point',
        glow: () => pieces.filter(p => p.cur[X] === 1) },
      { say: 'Here it goes — watch it fly!', center: [X, 1], until: { on: 'viewChange' },
        glow: () => pieces.filter(p => p.cur[X] === 1) },
      { say: 'See? It now sits in the centre, shaped <b>exactly</b> like the cell it replaced. In 4D, every cell is the centre of its own world.' },
      { say: () => byInput(
          'Your turn: <b>tap any sticker</b> to select its cell, then press the <b>cell → centre</b> button in the twist panel — and it spins to the middle. (Ctrl+click does the same.) A pure view change, never a move.',
          'Your turn: <b>tap any sticker</b> to select its cell, then press the <b>cell → centre</b> button in the panel below — and it spins to the middle. A pure view change, never a move.'),
        goals: () => [
          { text: 'Bring a cell to the centre (select it, then press cell → centre)', on: 'center' },
        ] },
      { say: 'Perfect. You\'ll do this constantly while solving: centre a cell to work on it comfortably.' },
    ],
    done: 'Any cell, front and centre, on demand.',
  },
  {
    id: 'rot4', ch: 0, title: 'Rotating through 4D',
    steps: [
      { say: () => byInput(
          'Now the real magic. Hold <b>Shift and drag</b>: the whole structure rotates through the <b>4th dimension</b> and the cells trade places — the centre cube flies out into a tunnel and another takes its spot. Every <b>cell → centre</b> press is such a rotation too. Either way it\'s still only your viewpoint.',
          'Now the real magic. Every time you send a cell to the middle with <b>cell → centre</b>, the whole structure rotates through the <b>4th dimension</b> and the cells trade places — the centre cube flies out into a tunnel and your cell takes its spot. Still only your viewpoint, never a move.') },
      { say: 'Take it for a spin.',
        goals: () => [
          { text: byInput('Rotate through 4D: Shift+drag, or centre a cell', 'Rotate through 4D: centre any cell with cell → centre'), on: ['rot4d', 'center'] },
          { text: 'Centre 3 different cells', on: 'center', count: 3, key: (i) => i.key },
        ] },
      { say: 'You can now reach every corner of 4D space. One cell still always hides from view, though — let\'s go hunt it.' },
    ],
    done: 'The 4th dimension answers to you.',
  },
  {
    id: 'hidden', ch: 0, title: 'Find the hidden cell',
    steps: [
      { say: () => byInput(
          'One cell is always <b>culled</b> from the picture — the one facing the 4D camera — so we can see inside the structure. Right now that\'s the red <b>Outer</b> cell. A hidden cell can\'t be clicked: first rotate through 4D until red stickers appear, then centre them.',
          'One cell is always <b>culled</b> from the picture — the one facing the 4D camera — so we can see inside the structure. Right now that\'s the red <b>Outer</b> cell. A hidden cell can\'t be tapped: keep sending tunnel cells to the middle with <b>cell → centre</b> until red stickers swing into view, then centre one of them.'),
        goals: () => [
          { text: 'Bring the hidden red Outer cell to the centre', on: ['rot4d', 'orbit', 'viewChange', 'center'], check: () => cellAtCenter(W, 1) },
        ],
        hint: () => byInput(
          'Shift+drag slowly in one direction and watch for red stickers; the moment they appear, Ctrl+click one — or select one and press cell → centre.',
          'Each cell → centre press rotates the structure through 4D, so new colours swing into view. Keep centring tunnel cells; the moment red stickers appear, select one and press cell → centre again.') },
      { say: 'There it is — the cell that normally wraps invisibly around everything, sitting politely in the middle. Nothing in 4D can hide from you anymore.', mood: 'happy' },
    ],
    done: 'Hide-and-seek champion of the 4th dimension.',
  },

  // ===== Chapter 2 · How the Cube Moves ========================================
  {
    id: 'twist1', ch: 1, title: 'Your first twist',
    steps: [
      { say: 'Time to actually <b>move</b> something. A twist turns one cell — a slab of <b>27 blocks</b>. I\'ve lit up the green <b>Top</b> cell\'s slab; keep your eye on the glowing blocks.', mood: 'point',
        setup: () => { tut.data.slab = pieces.filter(p => p.cur[Y] === 1); },
        glow: () => tut.data.slab },
      { say: 'I\'ll twist it 90° and bring it back. Watch the boundary blocks <b>hop into the neighbouring cells</b> — and home again. That hop is how pieces travel.',
        glow: () => tut.data.slab,
        demo: () => [mvOf(Y, 1, X, Z, 1), mvOf(Y, 1, X, Z, -1)] },
      { say: 'Your turn. <b>Tap any sticker</b> — its cell lights up and the twist panel opens. Then press one of the <b>↺ / ↻</b> buttons.',
        goals: () => [
          { text: 'Twist any cell 90° with the panel buttons', on: 'twist', when: (i) => i.mv.mode === 'plane' },
          { text: 'Press Undo (or U) to take it back', on: 'undo' },
        ] },
      { say: 'Twist and undo — action and eraser. While learning, undo freely: exploring and rewinding is exactly how intuition is built.' },
    ],
    done: 'First twist down, infinity to go.',
  },
  {
    id: 'planes', ch: 1, title: 'Three planes per cell',
    steps: [
      { say: 'Here\'s the 4D part — literally. A face of a 3D cube turns in <b>one</b> plane. A cell here turns in <b>three</b>: same slab, three different ways to move. The two extra planes are the 4th dimension talking. Let\'s feel all three on the yellow <b>Front</b> cell — there and back, each time.' },
      { say: 'Follow my prompts below. I\'ll light up the slab, and once you select the cell, the right button pulses.',
        guide: () => [
          mvOf(Z, 1, X, Y, 1), mvOf(Z, 1, X, Y, -1),
          mvOf(Z, 1, Y, W, 1), mvOf(Z, 1, Y, W, -1),
          mvOf(Z, 1, X, W, 1), mvOf(Z, 1, X, W, -1),
        ] },
      { say: 'Did you notice how each plane sent the blocks to <b>different neighbour cells</b>? Three twist planes per cell is exactly what makes this puzzle four-dimensional.' },
    ],
    done: 'All three planes, both directions — fluent.',
  },
  {
    id: 'grips', ch: 1, title: 'The edge and corner grips',
    steps: [
      { say: '<b>Which block</b> you tap matters. The glowing block is an <b>edge block</b> of the Front cell — select it and the panel offers an extra grip: a <b>180° flip</b> about its diagonal.', mood: 'point',
        setup: () => {
          tut.data.edge = pieces.find(p => p.cur[X] === 1 && p.cur[Y] === 1 && p.cur[Z] === 1 && p.cur[W] === 0);
          tut.data.corner = pieces.find(p => p.cur[X] === 1 && p.cur[Y] === 1 && p.cur[Z] === 1 && p.cur[W] === 1);
        },
        glow: () => [tut.data.edge] },
      { say: 'Flip it — then flip it again to bring everything home. A 180° flip is its own undo.',
        guide: () => {
          const f = gripOf(Z, 1, [1, 1, 0], Math.PI);
          return [f, f];
        } },
      { say: 'Now the glowing <b>corner block</b>: it adds a <b>120° spin</b> about its long diagonal. These grips are shortcuts — each equals a few 90° turns — but they make many solving sequences far shorter.', mood: 'point',
        glow: () => [tut.data.corner] },
      { say: 'Spin it one way, then back.',
        guide: () => [gripOf(Z, 1, [1, 1, 1], 2 * Math.PI / 3), gripOf(Z, 1, [1, 1, 1], -2 * Math.PI / 3)] },
      { say: 'That\'s the full arsenal: three plane turns per cell, plus the edge and corner grips — and you command them all.' },
    ],
    done: 'Edge flips and corner spins, unlocked.',
  },
  {
    id: 'order4', ch: 1, title: 'Four quarters make a whole',
    steps: [
      { say: 'A comforting law before we scramble anything: every 90° twist has <b>order four</b> — repeat it four times and <i>every</i> piece returns exactly home. No twist is ever destructive, and three forward always equals one back.' },
      { say: 'Prove it yourself: the same twist, four times in a row. Watch the cube come back to solved.',
        guide: () => [mvOf(Y, 1, X, Z, 1), mvOf(Y, 1, X, Z, 1), mvOf(Y, 1, X, Z, 1), mvOf(Y, 1, X, Z, 1)] },
      { say: 'Back to solved, exactly as the algebra promises. You now command every move this puzzle has — time to learn to read it.' },
    ],
    done: 'The algebra keeps its promises.',
  },

  // ===== Chapter 3 · Detective School ==========================================
  {
    id: 'read1', ch: 2, title: 'One twist from home',
    steps: [
      { say: 'Now we learn to <b>read</b> the cube. I\'ve scrambled it with <b>one secret twist</b> — and every block that\'s off its home <b>glows</b>. Look closely: they all live in one slab. That\'s the twist\'s footprint. Find the slab, twist it back.',
        setup: () => levelScramble(1),
        glow: displacedPieces, spot: false,
        goals: () => [
          { text: 'Restore every cell to a single colour', on: 'moved', check: isSolved },
        ],
        hint: 'Select a glowing block in the moved layer and try the opposite twist: same plane, other arrow. Wrong guess? Undo is free.' },
      { say: 'Your first real solve! That visual hunt — which cells are wounded, which slab moved — is the core skill of all 4D solving.', mood: 'happy' },
    ],
    done: 'Detective badge: bronze.',
  },
  {
    id: 'read2', ch: 2, title: 'Two twists deep',
    steps: [
      { say: 'Two secret twists this time. Undo the <b>most recent</b> damage first, then the older one — like backing out of a corridor. The glow fades as pieces come home: let it guide you.',
        setup: () => levelScramble(2),
        glow: displacedPieces, spot: false,
        goals: () => [
          { text: 'Restore the cube', on: 'moved', check: isSolved },
        ],
        hint: 'The two twists may overlap. If your first reversal makes things look worse, Undo it and try the other order.' },
      { say: 'Last in, first out — you just inverted a two-move story you never even saw.', mood: 'happy' },
    ],
    done: 'Detective badge: silver.',
  },
  {
    id: 'read3', ch: 2, title: 'Three twists deep',
    steps: [
      { say: '<b>Three</b> secret twists — a genuine micro-solve. Use everything: orbit, 4D rotation, centring, the glow, and fearless Undo. No clock pressure in my class; careful beats fast, every time.',
        setup: () => levelScramble(3),
        glow: displacedPieces, spot: false,
        goals: () => [
          { text: 'Restore the cube', on: 'moved', check: isSolved },
        ],
        hint: 'Peel it like an onion: find the most superficial damage (often the cell with the most foreign stickers), undo it, then reassess the whole cube.' },
      { say: 'Three-deep reading is exactly the skill that scales — a full scramble is just “many twists deep”.', mood: 'happy' },
    ],
    done: 'Detective badge: gold.',
  },

  // ===== Chapter 4 · Wave 1 · Build the Plus ===================================
  {
    id: 'families', ch: 3, title: 'The four piece families',
    steps: [
      { say: 'Before we solve for real, meet the <b>four piece families</b>. The glowing blocks are the 8 <b>centres</b> — one per cell, one colour each. They <b>never move</b>: they define which colour each cell wants to be.', mood: 'point',
        glow: famGlow(1) },
      { say: 'These 24 glowing blocks are the <b>2-colour face pieces</b> — each lives on the border between two cells. They are <b>Wave 1</b> of our method.',
        glow: famGlow(2) },
      { say: 'The 32 <b>3-colour edge pieces</b> — <b>Wave 2</b>.',
        glow: famGlow(3) },
      { say: 'And the 16 <b>4-colour corner pieces</b> — <b>Wave 3</b>, the endgame. Families never mix: a face piece stays a face piece forever.',
        glow: famGlow(4) },
      { say: 'Point them out for me — tap one block of each family.',
        goals: () => [
          { text: 'Select a 1-colour centre piece', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 1 },
          { text: 'Select a 2-colour face piece', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 2 },
          { text: 'Select a 3-colour edge piece', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 3 },
          { text: 'Select a 4-colour corner piece', on: 'select', when: (i) => i.piece && i.piece.stickers.length === 4 },
        ] },
      { say: 'And that\'s the whole plan: <b>Wave 1</b>, then <b>Wave 2</b>, then <b>Wave 3</b> — easiest family first, each wave protected while the next is built.' },
    ],
    done: 'Eight centres, 24 faces, 32 edges, 16 corners — all yours.',
  },
  {
    id: 'plus', ch: 3, title: 'Where to start: the plus',
    steps: [
      { say: 'So <b>where do you start</b> a real solve? Right here. I\'ve centred the green <b>Top</b> cell: its six glowing face pieces form a <b>plus</b> through the cell\'s middle. Building one cell\'s plus is the first job of every solve.', mood: 'point',
        center: [Y, 1],
        glow: () => pieces.filter(p => p.stickers.length === 2 && p.solved[Y] === 1) },
      { say: 'Now watch — I\'ll twist the yellow Front cell once… and one arm of the plus (still glowing) has been <b>carried off</b> into the sky-blue Left cell. The plus is broken.',
        setup: () => commitMove(PLUS_BREAK),
        glow: greenArmGlow },
      { say: 'One exact twist carries it home again. Watch closely.',
        glow: greenArmGlow,
        demo: () => [invMove(PLUS_BREAK)] },
      { say: 'I broke it again — your turn. Bring the glowing arm home.',
        setup: () => commitMove(PLUS_BREAK),
        glow: greenArmGlow,
        guide: () => [invMove(PLUS_BREAK)] },
      { say: 'Plus restored! On a fresh scramble you\'ll do exactly this, six times per cell: find a face piece, read which twist carries it home, make it.', mood: 'happy' },
    ],
    done: 'You built your first plus.',
  },
  {
    id: 'rescue', ch: 3, title: 'A two-move rescue',
    steps: [
      { say: 'Harder now: the glowing arm is <b>two twists from home</b> — I carried it to the Left cell, then twisted the Left cell to bury it deeper. No single move can save it; a <b>sequence</b> can. Undo my twists in <b>reverse order</b>: last in, first out.',
        setup: () => { commitMove(PLUS_BREAK); commitMove(BURY); },
        glow: greenArmGlow },
      { say: 'Two moves, in exactly this order. Watch the glow as you go.',
        glow: greenArmGlow,
        guide: () => [invMove(BURY), invMove(PLUS_BREAK)] },
      { say: 'That was an <b>algorithm</b>: a planned sequence that delivers one specific block to one specific place. Everything we do from here on is built from exactly such sequences.', mood: 'happy' },
    ],
    done: 'Your first multi-move algorithm.',
  },
  {
    id: 'wave1', ch: 3, title: 'Wave 1, solo flight',
    steps: [
      { say: 'Solo flight! A scrambled cube — bring <b>all 24 glowing face pieces</b> home. Only Wave 1 is graded: whatever happens to the bigger pieces is tomorrow\'s problem. Early in a solve you may still twist quite freely — use that freedom.',
        setup: () => levelScramble(2),
        glow: notHomeMax(2), spot: false,
        goals: () => [
          { text: 'Bring all 24 two-colour pieces home (others may stay wild)', on: 'moved', check: () => waveSolved(2) },
        ],
        hint: 'Pick one colour, centre that cell, repair its six face blocks — its plus — then take the next cell. Don\'t chase single pieces across the whole hypercube.' },
      { say: 'Wave 1 standing! The leftover chaos among the glow-less pieces? That\'s exactly what the next chapter is for.', mood: 'happy' },
    ],
    done: 'All 24 face pieces home — Wave 1 complete.',
  },

  // ===== Chapter 5 · The Magic Sequence ========================================
  {
    id: 'comm', ch: 4, title: 'The magic four: A B A′ B′',
    steps: [
      { say: 'From now on, every move must <b>protect finished work</b>. The universal tool is the <b>commutator</b>: twist <b>A</b>, twist <b>B</b> on a different cell, then undo A <i>by hand</i>, then undo B. Where A and B barely overlap, nearly everything comes home by itself.' },
      { say: 'Watch me: <b>A</b> = Top cell ↻ in plane XZ · <b>B</b> = Right cell ↻ in plane ZW · then A back · then B back.',
        demo: () => LAB_COMM },
      { say: 'Count the glow: only <b>13 of 80</b> pieces moved — every other piece returned on its own. That small, predictable footprint is surgery, not chaos.', mood: 'point',
        glow: displacedPieces },
      { say: 'Now heal it. The inverse of A B A′ B′ is <b>B A B′ A′</b> — the same machine, read backwards. Follow my prompts.',
        glow: displacedPieces,
        guide: () => INV_COMM },
      { say: 'Commutators are not spells — they\'re sentences you can read in both directions. This is the one big tool the whole method needs.' },
    ],
    done: 'The magic four, performed and inverted.',
  },
  {
    id: 'comm2', ch: 4, title: 'Build your own',
    steps: [
      { say: 'Now build one with <b>your own</b> moves: any twist A, a twist B on a <b>different</b> cell, then A′ and B′ by hand — with the panel, not the Undo button!',
        goals: () => [
          { text: 'A — twist any cell', on: 'twist',
            when: (i) => { tut.data.A = i.mv; return true; } },
          { text: 'B — twist a different cell', on: 'twist',
            when: (i) => { if (sameCellMove(i.mv, tut.data.A)) return false; tut.data.B = i.mv; return true; } },
          { text: 'A′ — reverse your first twist by hand', on: 'twist',
            when: (i) => isInverseMove(i.mv, tut.data.A) },
          { text: 'B′ — reverse your second twist', on: 'twist',
            when: (i) => isInverseMove(i.mv, tut.data.B) },
        ] },
      { say: () => {
          const n = displacedPieces().length;
          return n === 0
            ? 'Everything came back — your A and B cells didn\'t overlap at all, so the commutator was pure air. Pick two <b>neighbouring</b> cells and the net effect touches just a few pieces. Restart the lesson and see!'
            : `Count the wounds: your commutator touched just <b>${n} of 80</b> pieces — every other piece came home on its own. That precision scales to every twisty puzzle ever made.`;
        }, mood: 'happy' },
    ],
    done: 'A commutator of your very own.',
  },
  {
    id: 'conj', ch: 4, title: 'The setup move: A B A′',
    steps: [
      { say: 'The commutator\'s little sibling: the <b>conjugate</b> A B A′. Here A is a <b>setup move</b> — it carries an awkward piece into a position the useful move B can reach, and A′ carries the stage back. Read it as <i>“shift the world · act · shift it back”</i>. Try one.',
        goals: () => [
          { text: 'A — twist any cell (the setup)', on: 'twist',
            when: (i) => { tut.data.A = i.mv; return true; } },
          { text: 'B — twist a different cell (the action)', on: 'twist',
            when: (i) => !sameCellMove(i.mv, tut.data.A) },
          { text: 'A′ — undo the setup by hand', on: 'twist',
            when: (i) => isInverseMove(i.mv, tut.data.A) },
        ] },
      { say: 'The net effect is “B, performed somewhere B could never reach”. Conjugates and commutators together generate every solving sequence you will ever need.' },
    ],
    done: 'Shift the world, act, shift it back.',
  },

  // ===== Chapter 6 · Waves 2 & 3 · The Endgame =================================
  {
    id: 'cycle', ch: 5, title: 'Ferry one piece home',
    steps: [
      { say: '<b>Wave 2</b>: the 3-colour edge pieces. With Wave 1 standing, free twisting is over — pieces now travel by commutator. I\'ve disturbed the cube; the glowing piece is our patient. One exact four-move machine ferries it home — and heals every bystander too.', mood: 'point',
        setup: () => {
          INV_COMM.forEach(commitMove);
          tut.data.target = displacedPieces().find(p => p.stickers.length === 3) || displacedPieces()[0];
        },
        glow: () => [tut.data.target] },
      { say: 'The machine: <b>A B A′ B′</b> on the Top and Right cells. Drive it.',
        glow: () => [tut.data.target],
        guide: () => LAB_COMM },
      { say: 'Patient delivered — and the room is spotless: all 13 displaced pieces healed in one pass. Chaining machines like this, piece by piece, is the whole of Wave 2.', mood: 'happy' },
    ],
    done: 'One four-move machine, one rescued piece, zero damage.',
  },
  {
    id: 'wave2', ch: 5, title: 'Wave 2, solo flight',
    steps: [
      { say: 'A real Wave-2 job: bring <b>all glowing pieces</b> home — that\'s every 2- and 3-colour piece. The corners may stay wild. After every sequence, check that your Wave-1 work still stands.',
        setup: () => levelScramble(2),
        glow: notHomeMax(3), spot: false,
        goals: () => [
          { text: 'All 2- and 3-colour pieces home (4-colour may stay wild)', on: 'moved', check: () => waveSolved(3) },
        ],
        hint: 'Work cell by cell. If a sequence broke your faces, Undo back — a good sequence leaves them untouched by construction. The 180°/120° grips often save moves.' },
      { say: 'Two waves standing. Feel the discipline change? From here on, every move must justify what it breaks.', mood: 'happy' },
    ],
    done: 'Waves 1 and 2, both standing.',
  },
  {
    id: 'rkt', ch: 5, title: 'RKT: a 3D cube in disguise',
    steps: [
      { say: 'The endgame secret of every hypercubist — <b>RKT</b>. Look at the white cell in the centre: it <i>is</i> a 3D Rubik\'s cube. A real one. And twisting the cells <b>around</b> it turns its faces exactly like F, U and R turns on a normal cube.' },
      { say: 'Watch its faces spin while I twist the neighbours — and notice I never touch the white cell itself.',
        demo: () => [mvOf(Y, 1, X, Z, 1), mvOf(X, 1, Z, W, 1), mvOf(X, 1, Z, W, -1), mvOf(Y, 1, X, Z, -1)] },
      { say: 'Your turn — keep white in the middle and play.',
        goals: () => [
          { text: 'With white centred, twist 3 different surrounding cells — watch its faces turn', on: 'twist',
            count: 3, key: (i) => keyOf(i.mv.d, i.mv.sd),
            when: (i) => !(i.mv.d === W && i.mv.sd === -1) && cellAtCenter(W, -1) },
        ],
        hint: 'The white Inner cell is centred when the small middle cube is white — select it and press cell → centre if it drifts away. Then select any tunnel cell and twist, watching the white cube.' },
      { say: 'So in Wave 3 you solve the last corners by running your favourite <b>3D algorithms</b>, one dimension up. Every algorithm you ever learned still works here.' },
    ],
    done: 'The famous RKT trick is yours.',
  },

  // ===== Chapter 7 · Graduation ================================================
  {
    id: 'full', ch: 6, title: 'Dress rehearsal',
    steps: [
      { say: 'Dress rehearsal: a full solve, <b>every piece graded</b> — corners included. Read it like Detective School, or run the waves; the glow fades as you heal the cube.',
        setup: () => levelScramble(2),
        glow: displacedPieces, spot: false,
        goals: () => [
          { text: 'Solve the cube completely', on: 'moved', check: isSolved },
        ],
        hint: 'The wave plan: 2-colour pieces → 3-colour pieces → RKT for the corners. Or pure detective work — two twists can still be read backwards.' },
      { say: 'A complete solve, corners and all. One exam stands between you and your gown.', mood: 'happy' },
    ],
    done: 'Every family home. Ready for the exam.',
  },
  {
    id: 'exam', ch: 6, title: 'Final exam',
    steps: [
      { say: 'Your <b>final exam</b>: four secret twists, fully graded, and this time — no glowing help. If you\'re truly stuck, the hint button calls me back. Take your time: careful beats fast, and Undo costs nothing.',
        setup: () => levelScramble(4),
        goals: () => [
          { text: 'Solve the cube completely', on: 'moved', check: isSolved },
        ],
        hint: 'All right, here I am — the glow now marks every piece still off home. Peel the damage like an onion, most superficial wound first; switch to the wave plan if it gets wide.',
        hintGlow: displacedPieces },
      { say: '🎓 <b>Graduated!</b> You read 4D projections, command every grip, wield commutators and know the wave plan by heart. For deeper study: <i>superliminal.com/cube</i> and <i>hypercubing.xyz</i>. Press Scramble whenever you\'re ready for the real thing — and may all eight cells come home.', mood: 'party' },
    ],
    done: 'You are a certified hypercubist now.',
  },
];

// --- lesson engine ------------------------------------------------------------------
const PROG_KEY = 'tess_tutor_v1';
function loadProgress() {
  try { return new Set(JSON.parse(localStorage.getItem(PROG_KEY) || '[]')); } catch (_) { return new Set(); }
}
const tut = {
  active: false, idx: 0, stepIdx: 0, lessonDone: false,
  objs: [], obj: 0,                    // goals-step objectives (engine-event detection)
  gmoves: null, gi: 0, fixing: false,  // guided-algorithm state
  data: {},                            // per-lesson scratch space for steps
  done: loadProgress(),
};
function saveProgress() { try { localStorage.setItem(PROG_KEY, JSON.stringify([...tut.done])); } catch (_) {} }
// every lesson is open from the start: browse and dip in anywhere — finished
// lessons are still ticked off, and Continue points at the first unfinished one
function lessonUnlocked() { return true; }
function firstOpenLesson() {
  const i = LESSONS.findIndex(lv => !tut.done.has(lv.id));
  return i === -1 ? LESSONS.length - 1 : i;
}
function curStep() {
  const lv = LESSONS[tut.idx];
  return lv ? lv.steps[tut.stepIdx] : null;
}

function startLesson(i) {
  hide(el.map); hide(el.help); hide(el.win);
  if (!savedGame) snapshotGame();   // entering the Academy: park the player's own game
  tut.active = true;
  tut.idx = i;
  tut.stepIdx = 0;
  tut.lessonDone = false;
  tut.data = {};
  levelSetup();
  resetView();
  show(el.course);
  runStep();
}
function exitCourse() {
  if (!tut.active && el.course.hidden && !savedGame) return;
  tut.active = false;
  tut.lessonDone = false;
  stopDemo();
  hide(el.course);
  restoreGame();   // hand the player's own game back (also clears glow + selection)
}

function runStep() {
  stopDemo();
  const st = curStep();
  st._kind = st.demo ? 'demo' : st.guide ? 'guide' : st.goals ? 'goals' : st.until ? 'until' : 'say';
  tut.objs = []; tut.obj = 0;
  tut.gmoves = null; tut.gi = 0; tut.fixing = false;
  if (st.view === 'reset') { anim = null; resetView(); }
  if (st.setup) st.setup();
  if (st.goals) tut.objs = st.goals().map(o => ({ ...o, hits: 0, keys: new Set() }));
  if (st.guide) tut.gmoves = st.guide();
  setGlow(st.glow || (st._kind === 'guide' ? guideGlowDefault : null), st.spot !== false);
  renderStep();
  let centered = null;
  if (st.center) centered = startCenterCell(st.center[0], st.center[1], false);
  if (st._kind === 'demo') playDemo(st.demo());
  else if (st._kind === 'until' && st.center && centered === false) advanceStep(); // already there
}
function advanceStep() {
  tut.stepIdx++;
  if (tut.stepIdx >= LESSONS[tut.idx].steps.length) lessonComplete();
  else runStep();
}
// the default glow while guiding: the slab about to turn — or, for a grip,
// the exact block whose panel offers the move
function guideGlowDefault() {
  const exp = tut.gmoves && tut.gmoves[tut.gi];
  if (!exp) return null;
  if (exp.mode === 'plane') return pieces.filter(p => p.cur[exp.d] === exp.sd);
  const sgn = (v) => (Math.abs(v) < 1e-6 ? 0 : v > 0 ? 1 : -1);
  return pieces.filter(p => p.cur[exp.d] === exp.sd &&
    exp.inAx.every((ax, t) => p.cur[ax] === sgn(exp.u3[t])));
}

// every engine hook funnels through here; the current step decides whether the
// event (or the puzzle state it produced) advances the lesson
function courseEvent(type, info = {}) {
  if (!tut.active || tut.lessonDone) return;
  if (demo && type !== 'demoDone') return;     // the professor's own moves never score
  const st = curStep();
  if (!st) return;
  if (st._kind === 'demo') { if (type === 'demoDone') advanceStep(); return; }
  if (st._kind === 'until') {
    if (![].concat(st.until.on).includes(type)) return;
    if (st.until.check && !st.until.check()) return;
    advanceStep();
    return;
  }
  if (st._kind === 'guide') handleGuide(type, info);
  else if (st._kind === 'goals') handleGoals(type, info);
}

function handleGoals(type, info) {
  const o = tut.objs[tut.obj];
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
  tut.obj++;
  renderObjectives();
  if (tut.obj >= tut.objs.length) { toast('✓ Nice!'); advanceStep(); }
  else flashCheck('✓ Nice!');
}

function handleGuide(type, info) {
  if (type === 'undo') {
    // the student manually rewound a correct move — wind the pointer back too
    if (!tut.fixing && tut.gi > 0) { tut.gi--; refreshBubble(); renderGuide(); if (selected) buildTwistRows(); }
    return;
  }
  if (type !== 'moved' || !info.record) return;
  const exp = tut.gmoves[tut.gi];
  if (sameMove(info.mv, exp)) {
    tut.gi++;
    if (tut.gi >= tut.gmoves.length) { toast('✓ Perfect!'); advanceStep(); }
    else {
      flashCheck(`✓ ${tut.gi} / ${tut.gmoves.length}`);
      refreshBubble();
      renderGuide();
      if (selected) buildTwistRows();
    }
  } else {
    setAvatar('think');
    el.tutText.innerHTML = 'Hmm — not that one. No harm done: I\'ll put it back. Then follow the prompt below exactly.';
    flashCheck('✗ let me fix that');
    autoFix();
  }
}
// gently take a wrong guided move back (retrying while an animation is in flight)
function autoFix() {
  if (!tut.active) return;
  const st = curStep();
  if (!st || st._kind !== 'guide') return;
  if (anim) { setTimeout(autoFix, 160); return; }
  if (history.length === 0) return;
  tut.fixing = true;
  doUndo();
  tut.fixing = false;
}
// the move the guide currently expects — the dock uses this to pulse the right button
function guideExpected() {
  if (!tut.active || tut.lessonDone || demo) return null;
  const st = curStep();
  if (!st || st._kind !== 'guide') return null;
  return tut.gmoves[tut.gi] || null;
}

function lessonComplete() {
  const lv = LESSONS[tut.idx];
  tut.lessonDone = true;
  setGlow(null);
  if (!tut.done.has(lv.id)) { tut.done.add(lv.id); saveProgress(); }
  clearTimeout(crsCheckT);
  el.crsCheck.hidden = true;
  el.course.classList.add('complete');
  setCourseMin(false); // pop back open so the praise + Next button are visible
  setAvatar('party');
  el.tutText.innerHTML = `<b class="crs-done-tag">✓ Lesson complete</b><br>${lv.done || 'On to the next one!'}`;
  renderObjectives();
  renderGuide();
  renderDots();
  el.crsHintBtn.hidden = true;
  el.crsHint.hidden = true;
  el.tutSkip.hidden = true;
  el.crsRestart.hidden = true;
  el.crsNext.hidden = false;
  el.crsNext.textContent = tut.idx === LESSONS.length - 1 ? 'Finish course' : 'Next lesson';
  toast('Lesson complete!');
}
// the Continue / Next-lesson button
function tutNext() {
  if (!tut.active) return;
  if (tut.lessonDone) {
    if (tut.idx >= LESSONS.length - 1) { exitCourse(); openMap(); }
    else startLesson(tut.idx + 1);
  } else {
    const st = curStep();
    if (st && st._kind === 'say') advanceStep();
  }
}

// --- lesson UI -------------------------------------------------------------------
function refreshBubble() {
  const st = curStep();
  if (!st) return;
  setAvatar(st.mood || MOODS[st._kind]);
  el.tutText.innerHTML = typeof st.say === 'function' ? st.say() : st.say;
}
function renderStep() {
  const lv = LESSONS[tut.idx], st = curStep();
  el.crsTag.textContent = `Lesson ${tut.idx + 1} / ${LESSONS.length} · ${CHAPTERS[lv.ch]}`;
  el.crsTitle.textContent = lv.title;
  el.course.classList.remove('complete');
  refreshBubble();
  renderObjectives();
  renderGuide();
  renderDots();
  el.crsHintBtn.hidden = !st.hint;
  el.crsHintBtn.textContent = 'Show hint';
  el.crsHint.hidden = true;
  el.crsHint.innerHTML = (typeof st.hint === 'function' ? st.hint() : st.hint) || '';
  el.crsCheck.hidden = true;
  el.tutSkip.hidden = st._kind !== 'demo';
  el.crsNext.hidden = st._kind !== 'say';
  el.crsNext.textContent = 'Continue';
  el.crsRestart.hidden = false;
  setCourseMin(false); // every step brings fresh words from the professor
}
function renderObjectives() {
  el.crsObjs.innerHTML = tut.lessonDone ? '' : tut.objs.map((o, i) => {
    const state = i < tut.obj ? 'done' : i === tut.obj ? 'now' : 'todo';
    const got = Math.max(o.hits, o.keys.size);
    const prog = state === 'now' && (o.count || 1) > 1 && got > 0 ? ` <em>${got} / ${o.count}</em>` : '';
    return `<li class="${state}"><i></i><span>${o.text}${prog}</span></li>`;
  }).join('');
  el.crsObjs.hidden = el.crsObjs.innerHTML === '';
}
function renderGuide() {
  const on = !!tut.gmoves && !tut.lessonDone;
  el.tutGuide.hidden = !on;
  if (!on) return;
  el.tutChips.innerHTML = tut.gmoves.map((m, i) =>
    `<span class="chip${i < tut.gi ? ' done' : i === tut.gi ? ' now' : ''}">${i + 1}</span>`).join('');
  const exp = tut.gmoves[tut.gi];
  el.tutMove.innerHTML = exp
    ? `<b>Move ${tut.gi + 1} / ${tut.gmoves.length}:</b> ${describeMove(exp)}`
    : '';
}
function renderDots() {
  const lv = LESSONS[tut.idx];
  el.tutDots.innerHTML = lv.steps.map((_, i) =>
    `<i class="${tut.lessonDone || i < tut.stepIdx ? 'done' : i === tut.stepIdx ? 'now' : ''}"></i>`).join('');
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

// minimise the lesson panel to a slim bar: the lesson keeps running and scoring,
// but the scene is free to work in (vital on phones)
const ICON_MIN = '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_EXPAND = '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function setCourseMin(min) {
  el.course.classList.toggle('min', min);
  el.crsMin.innerHTML = min ? ICON_EXPAND : ICON_MIN;
  el.crsMin.title = min ? 'Expand the lesson panel (M)' : 'Minimise — the lesson stays active (M)';
}

function openMap() {
  if (tut.active) {
    // leave the running lesson but stay on the practice copy — the player's
    // own game is restored only when the Academy is left for real
    tut.active = false;
    tut.lessonDone = false;
    stopDemo();
    setGlow(null);
    hide(el.course);
  }
  hide(el.help); hide(el.win);
  renderMap();
  show(el.map);
}
function closeMap() {
  hide(el.map);
  if (!tut.active && savedGame) restoreGame();   // left the Academy without starting a lesson
}
const MAP_ICON = {
  done: '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M8 5l10 7-10 7z" fill="currentColor"/></svg>',
  locked: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
};
function renderMap() {
  const total = LESSONS.length;
  const done = LESSONS.filter(lv => tut.done.has(lv.id)).length;
  el.mapProgress.textContent = `${done} / ${total} lessons`;
  el.mapBarFill.style.width = `${(done / total) * 100}%`;
  el.mapGrad.hidden = done < total;
  let html = '';
  CHAPTERS.forEach((name, c) => {
    html += `<div class="map-chapter"><h3><span>${c + 1}</span>${name}</h3><div class="map-levels">`;
    LESSONS.forEach((lv, i) => {
      if (lv.ch !== c) return;
      const isDone = tut.done.has(lv.id);
      const unlocked = lessonUnlocked(i);
      const cls = isDone ? 'done' : unlocked ? 'open' : 'locked';
      html += `<button class="map-level ${cls}" data-i="${i}"${unlocked ? '' : ' disabled'}>` +
        `<span class="ml-num">${i + 1}</span><span class="ml-title">${lv.title}</span>` +
        `<span class="ml-icon">${MAP_ICON[cls]}</span></button>`;
    });
    html += '</div></div>';
  });
  el.mapList.innerHTML = html;
  el.mapList.querySelectorAll('.map-level:not(.locked)').forEach(btn => {
    btn.addEventListener('click', () => startLesson(+btn.dataset.i));
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
const ICON_CENTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';

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
  // view shortcut: fly the selected cell to the projection centre — the
  // button-first route to centring (press-and-hold stays as a shortcut)
  const crow = document.createElement('div');
  crow.className = 'twist-row twist-row-center';
  crow.innerHTML =
    `<span class="axis-tag">Cell → <b>centre</b></span>` +
    `<button class="tw tw-center" title="Bring this cell to the centre of the projection — a pure view change, never a move">${ICON_CENTER}</button>`;
  el.twistRows.appendChild(crow);
  crow.querySelector('.tw-center').addEventListener('click', () => {
    if (anim) return;
    if (!startCenterCell(selected.d, selected.sd, false)) toast('Already at the centre');
  });
  el.twistRows.querySelectorAll('.tw:not(.tw-center)').forEach(btn => {
    btn.addEventListener('click', () => {
      if (anim || demo) return;
      if (btn.classList.contains('twa')) {
        startTwistAxis(selected.d, selected.sd, selected.grip.inAx, selected.grip.u3, +btn.dataset.theta);
      } else {
        startTwist(selected.d, selected.sd, +btn.dataset.i, +btn.dataset.j, +btn.dataset.dir);
      }
    });
  });
  markGuideHint();
}

// while the professor guides an algorithm: once the right cell (and, for a
// grip, the right block) is selected, pulse exactly the button to press
function markGuideHint() {
  const exp = guideExpected();
  if (!exp || !selected || selected.d !== exp.d || selected.sd !== exp.sd) return;
  if (exp.mode === 'plane') {
    const e = normPlane(exp);
    el.twistRows.querySelectorAll('.tw:not(.twa)').forEach(b => {
      if (+b.dataset.i === e.i && +b.dataset.j === e.j && +b.dataset.dir === e.dir)
        b.classList.add('guide-hint');
    });
  } else if (selected.grip) {
    const g = selected.grip;
    const dp = g.u3[0] * exp.u3[0] + g.u3[1] * exp.u3[1] + g.u3[2] * exp.u3[2];
    if (Math.abs(dp) < 0.99) return; // a different diagonal — not this block's grip
    const edge = Math.abs(Math.abs(exp.theta) - Math.PI) < 1e-6;
    el.twistRows.querySelectorAll('.twa').forEach(b => {
      const th = +b.dataset.theta;
      const match = edge
        ? Math.abs(Math.abs(th) - Math.PI) < 1e-6
        : (dp > 0 ? Math.abs(th - exp.theta) < 1e-6 : Math.abs(th + exp.theta) < 1e-6);
      if (match) b.classList.add('guide-hint');
    });
  }
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
    if (tut.active) toast('Leave the lesson to scramble freely');
    else doScramble();
  }
  else if (k === 'u') { doUndo(); }
  else if (k === 'r') {
    if (tut.active) { startLesson(tut.idx); toast('Lesson restarted'); }
    else doReset();
  }
  else if (k === 'v') { resetView(); }
  else if (k === 'm') { if (tut.active) setCourseMin(!el.course.classList.contains('min')); }
  else if (k === 't' || k === 'l') { el.map.hidden ? openMap() : closeMap(); }
  else if (k === 'h' || k === '?') { toggle(el.help); }
  else if (k === 'enter') {
    if (tut.active && !el.crsNext.hidden) tutNext();
  }
  else if (k === 'escape') {
    if (!el.map.hidden) closeMap();
    else if (tut.active) exitCourse();
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
  tutAvatar: document.getElementById('tut-avatar'),
  tutText: document.getElementById('tut-text'),
  tutGuide: document.getElementById('tut-guide'),
  tutChips: document.getElementById('tut-chips'),
  tutMove: document.getElementById('tut-move'),
  tutDots: document.getElementById('tut-dots'),
  tutSkip: document.getElementById('tut-skip'),
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
  if (tut.active) { toast('Leave the lesson to scramble freely'); return; }
  doScramble();
});
document.querySelectorAll('.btn-mini').forEach(b => {
  b.addEventListener('click', () => {
    if (anim) return;
    if (tut.active) { toast('Leave the lesson to scramble freely'); return; }
    doScramble(+b.dataset.scramble);
  });
});
el.undo.addEventListener('click', doUndo);
el.reset.addEventListener('click', () => {
  if (tut.active) { startLesson(tut.idx); toast('Lesson restarted'); }
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
document.getElementById('map-close').addEventListener('click', closeMap);
document.getElementById('map-continue').addEventListener('click', () => startLesson(firstOpenLesson()));
document.getElementById('map-reset-progress').addEventListener('click', () => {
  tut.done.clear(); saveProgress(); renderMap(); toast('Course progress reset');
});
el.crsExit.addEventListener('click', exitCourse);
el.crsMap.addEventListener('click', openMap);
el.crsMin.addEventListener('click', () => setCourseMin(!el.course.classList.contains('min')));
// tapping anywhere on the minimised bar (except its buttons) expands it again
el.course.addEventListener('click', (e) => {
  if (el.course.classList.contains('min') && !e.target.closest('button')) setCourseMin(false);
});
el.crsRestart.addEventListener('click', () => startLesson(tut.idx));
el.crsNext.addEventListener('click', tutNext);
el.tutSkip.addEventListener('click', skipDemo);
el.crsHintBtn.addEventListener('click', () => {
  const open = el.crsHint.hidden;
  el.crsHint.hidden = !open;
  el.crsHintBtn.textContent = open ? 'Hide hint' : 'Show hint';
  // some lessons let the hint call the professor's glow back in
  const st = tut.active && !tut.lessonDone ? curStep() : null;
  if (st && st.hintGlow) {
    setGlow(open ? st.hintGlow : (st.glow || null), st.spot !== false);
    if (open) setAvatar('think');
  }
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
    LESSONS, CHAPTERS, tut, startLesson, exitCourse, courseEvent, openMap, closeMap,
    tutNext, skipDemo, waveSolved, pieceHome, displacedPieces, cellAtCenter,
    isInverseMove, sameMove, describeMove, invMove, LAB_COMM, INV_COMM, commitMove,
    lessonUnlocked, firstOpenLesson, guideExpected, avatarSVG,
    hasSnapshot: () => !!savedGame,
    setView4: (m) => { view4 = m; },   // test hook: stage a view for check() goals
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
