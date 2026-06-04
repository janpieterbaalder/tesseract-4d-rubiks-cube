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

// 8 cool-toned cell colours (white / grey / blue family, kept distinguishable)
const COLORS = {
  'X+': '#eef3fb', // soft white
  'X-': '#2fd0e6', // cyan
  'Y+': '#5aa0f2', // sky blue
  'Y-': '#2a55cf', // royal blue
  'Z+': '#1f74d0', // azure
  'Z-': '#8493ad', // slate grey
  'W+': '#25c4ad', // teal
  'W-': '#9a8bff', // periwinkle
};
const CELL_LABEL = {
  'W+': 'Outer',   'W-': 'Inner',
  'X+': 'Right',   'X-': 'Left',
  'Y+': 'Top',     'Y-': 'Bottom',
  'Z+': 'Front',   'Z-': 'Back',
};

// geometry
const G = 1.0;          // lattice spacing
const B = 1.52;         // cell-boundary distance along the normal axis (more = cells pushed further apart)
const FACE_SHRINK = 0.42; // pulls each cell's stickers toward the cell centre (lower = more gap between cells)
const STICKER_HALF = 0.19; // half-size of a sticker cube in its in-cell axes
const V4D = 4.35;       // 4D camera distance (controls inner/outer size ratio)
const V3D = 6.6;        // 3D camera distance

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

// 8 cube corners indexed by 3 bits over the in-cell axes; 6 faces as index quads
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
      FACE_KEYS.push(quad);
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
// In-cell coordinates are pulled toward the cell centre by FACE_SHRINK so the 8
// cells separate and the nested 4D structure becomes visible (MagicCube4D-style).
function stickerCorners(cur, fa, fs) {
  const inAx = [0,1,2,3].filter(a => a !== fa);
  const out = [];
  for (let b = 0; b < 8; b++) {
    const c = [0,0,0,0];
    c[fa] = fs * B;
    for (let t = 0; t < 3; t++) {
      const ax = inAx[t];
      const bit = (b >> t) & 1;
      c[ax] = cur[ax] * G * FACE_SHRINK + (bit ? STICKER_HALF : -STICKER_HALF);
    }
    out.push(c);
  }
  return out;
}

// ----------------------------------------------------------------- twists
const history = [];

function commitTwist(d, sd, i, j, dir) {
  const R = rotInt(i, j, dir);
  for (const p of pieces) {
    if (p.cur[d] === sd) {
      p.cur = matVec4i(R, p.cur);
      p.rot = matMul4(R, p.rot);
    }
  }
}

function isSolved() {
  for (const p of pieces) {
    if (p.cur[0]!==p.solved[0] || p.cur[1]!==p.solved[1] ||
        p.cur[2]!==p.solved[2] || p.cur[3]!==p.solved[3]) return false;
    const r = p.rot;
    if (r[0][0]!==1 || r[1][1]!==1 || r[2][2]!==1 || r[3][3]!==1) return false;
  }
  return true;
}

// the three twist planes available for a cell on axis d
function planesFor(d) {
  const p = [0,1,2,3].filter(a => a !== d);
  return [[p[0],p[1]], [p[1],p[2]], [p[0],p[2]]];
}

// ----------------------------------------------------------------- state / UI
let view4 = matMul4(rotFloat(Y, W, 0.34), rotFloat(X, W, 0.46)); // initial 4D tilt
let yaw = 0.62, pitch = 0.46;                                    // 3D orbit
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
    scale = cssW * 0.150;
  } else {
    cy = cssH / 2 + 6;
    scale = Math.min(cssW, cssH) * 0.205;
  }
}
window.addEventListener('resize', resize);

// ----------------------------------------------------------------- projection
// returns { x, y, cz, cam:[x,y,z] }  (cam = 3D coords after orbit, pre-2D persp)
function project(c4, animMat) {
  let w = animMat ? matVec4(animMat, c4) : c4;
  w = matVec4(view4, w);
  const s4 = V4D / (V4D - w[3]);
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

function render() {
  ctx.clearRect(0, 0, cssW, cssH);

  // soft central halo for depth
  const halo = ctx.createRadialGradient(cx, cy - 10, 30, cx, cy - 10, Math.min(cssW, cssH) * 0.62);
  halo.addColorStop(0, 'rgba(58, 104, 190, 0.16)');
  halo.addColorStop(0.5, 'rgba(40, 72, 150, 0.05)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, cssW, cssH);

  const faces = [];
  const animSet = anim && anim.type === 'twist' ? anim.set : null;
  const animMat = animSet ? rotFloat(anim.i, anim.j, anim.theta) : null;

  for (const piece of pieces) {
    const inSlab = selected && piece.cur[selected.d] === selected.sd;
    const useAnim = animSet && animSet.has(piece) ? animMat : null;

    for (const st of piece.stickers) {
      const { fa, fs } = facingOf(piece, st);
      const corners = stickerCorners(piece.cur, fa, fs);
      const P = corners.map(c => project(c, useAnim));

      // sticker-cube centre in cam space (for outward-normal test + depth)
      let ccx = 0, ccy = 0, ccz = 0;
      for (const p of P) { ccx += p.cam[0]; ccy += p.cam[1]; ccz += p.cam[2]; }
      ccx /= 8; ccy /= 8; ccz /= 8;
      const center = [ccx, ccy, ccz];

      for (const q of FACE_KEYS) {
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
        const shade = 0.60 + 0.55 * diff;

        faces.push({
          poly: [[a.x,a.y],[b.x,b.y],[c.x,c.y],[d.x,d.y]],
          depth, cubeCz: ccz, shade, rgb: st.rgb, inSlab, piece, sticker: st,
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

    if (f.inSlab) {
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = 'rgba(190, 220, 255, 0.85)';
      ctx.stroke();
    } else {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(6, 10, 18, 0.5)';
      ctx.stroke();
    }
  }

  // build pick list (front first)
  pickFaces = faces.slice().reverse().map(f => ({ poly: f.poly, sticker: f.sticker, piece: f.piece }));
}

// ----------------------------------------------------------------- animation
function ease(t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2; }

function startTwist(d, sd, i, j, dir, opts = {}) {
  if (anim) return false;
  const set = new Set(pieces.filter(p => p.cur[d] === sd));
  anim = {
    type: 'twist', d, sd, i, j, dir, set,
    t: 0, dur: opts.dur || 250, theta: 0,
    record: opts.record !== false,
    countDelta: opts.countDelta == null ? 1 : opts.countDelta,
    onDone: opts.onDone,
  };
  return true;
}

function startViewRot(i, j, dir) {
  if (anim) return false;
  anim = { type: 'view', i, j, dir, t: 0, dur: 420, base: view4 };
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
      anim.theta = e * anim.dir * Math.PI / 2;
      if (k >= 1) {
        commitTwist(anim.d, anim.sd, anim.i, anim.j, anim.dir);
        const rec = anim.record, cd = anim.countDelta;
        if (anim.record) history.push({ d:anim.d, sd:anim.sd, i:anim.i, j:anim.j, dir:anim.dir });
        const done = anim.onDone;
        anim = null;
        afterMove(cd, rec);
        if (done) done();
      }
    } else if (anim.type === 'view') {
      view4 = matMul4(rotFloat(anim.i, anim.j, e * anim.dir * Math.PI/2), anim.base);
      if (k >= 1) { anim = null; }
    }
  }

  // gentle idle drift on the landing screen (before the first scramble)
  if (!scrambledOnce && !drag && !anim) {
    yaw += dt * 0.00011;
    view3 = mat3FromYawPitch(yaw, pitch);
  }

  if (timing) updateClock();
  render();
  requestAnimationFrame(tick);
}

function afterMove(countDelta, record) {
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
  startTwist(m.d, m.sd, m.i, m.j, -m.dir, { record: false, countDelta: -1 });
}

function win() {
  solvedState = true;
  timing = false;
  finalMs = performance.now() - startT;
  el.winTime.textContent = fmt(finalMs);
  el.winMoves.textContent = moves;
  setTimeout(() => show(el.win), 520);
}

// ----------------------------------------------------------------- selection
function selectCell(d, sd) {
  const key = AXN[d] + (sd > 0 ? '+' : '-');
  selected = { d, sd, key };
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
  el.twistRows.querySelectorAll('.tw').forEach(btn => {
    btn.addEventListener('click', () => {
      if (anim) return;
      const i = +btn.dataset.i, j = +btn.dataset.j, dir = +btn.dataset.dir;
      startTwist(selected.d, selected.sd, i, j, dir);
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
      return { d: fa, sd: fs };
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
             yaw0: yaw, pitch0: pitch, moved: false, button: e.button };
    pinch = null;
  } else if (pointers.size === 2) {
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
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESH) drag.moved = true;
    if (drag.moved) {
      yaw = drag.yaw0 + dx * 0.008;
      pitch = Math.max(-1.35, Math.min(1.35, drag.pitch0 + dy * 0.008));
      view3 = mat3FromYawPitch(yaw, pitch);
    }
  } else if (pointers.size === 0) {
    const hit = pickAt(e.clientX, e.clientY);      // hover feedback (mouse only)
    canvas.classList.toggle('pointable', !!hit);
  }
});

function onPointerUp(e) {
  const wasDrag = (drag && e.pointerId === drag.id) ? drag : null;
  pointers.delete(e.pointerId);
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

  if (pinch) {
    if (pointers.size < 2) {
      pinch = null;
      if (pointers.size === 1) {                   // one finger left -> resume orbit (no tap)
        const [id, p] = [...pointers.entries()][0];
        drag = { id, x0: p.x, y0: p.y, yaw0: yaw, pitch0: pitch, moved: true, button: 0 };
      }
    }
  } else if (wasDrag) {
    if (!wasDrag.moved && wasDrag.button === 0) {   // a clean tap -> select / deselect
      const hit = pickAt(e.clientX, e.clientY);
      if (hit) selectCell(hit.d, hit.sd); else deselect();
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

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 's') { doScramble(); }
  else if (k === 'u') { doUndo(); }
  else if (k === 'r') { doReset(); }
  else if (k === 'h' || k === '?') { toggle(el.help); }
  else if (k === 'escape') { hide(el.help); hide(el.win); deselect(); }
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
};

el.scramble.addEventListener('click', () => doScramble());
el.undo.addEventListener('click', doUndo);
el.reset.addEventListener('click', doReset);
el.dockClose.addEventListener('click', deselect);
el.viewReset.addEventListener('click', () => {
  if (anim) return;
  yaw = 0.62; pitch = 0.46; zoom = 1.0;
  view3 = mat3FromYawPitch(yaw, pitch);
  view4 = matMul4(rotFloat(Y, W, 0.34), rotFloat(X, W, 0.46));
});
document.getElementById('btn-help').addEventListener('click', () => show(el.help));
document.getElementById('help-close').addEventListener('click', () => hide(el.help));
document.getElementById('help-ok').addEventListener('click', () => hide(el.help));
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

// ----------------------------------------------------------------- boot
buildPieces();
buildFaceTopology();
buildLegend();
resize();
requestAnimationFrame(tick);

})();
