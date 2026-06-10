// ============================================================================
// Mathematical verification of the 4D (3^4) Rubik's cube engine.
//
// Run:  npm i jsdom && node test/math.test.js
//
// Checks, against the live engine loaded from app.js:
//   1. Piece census matches the true 3^4 structure (8x1c, 24x2c, 32x3c, 16x4c).
//   2. Every cell slab contains exactly 27 pieces.
//   3. Every twist matrix is a signed permutation with determinant +1
//      (a genuine orientation-preserving lattice isometry).
//   4. Generator orders: 90-degree plane twists have order 4, edge grips
//      (180 deg) order 2, corner grips (120 deg) order 3.
//   5. Every edge and corner grip equals some composition of the three
//      90-degree plane twists of the same cell (i.e. all grips lie in the
//      24-element rotation group of the cell — they are legal moves, not
//      reflections or impossible motions).
//   6. Twists permute the 80 pieces bijectively over the lattice, preserve
//      each piece's type (number of nonzero coordinates), keep the twisted
//      slab inside its cell and leave all other pieces untouched.
//   7. cur == rot * solved stays exact for every piece under long random
//      move sequences (position and orientation never desynchronise).
//   8. Sticker facings of every piece always point along the axes where its
//      current position is nonzero, with matching signs.
//   9. A random scramble replayed in reverse returns every piece exactly
//      home (cur == solved, rot == identity).
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/<link[^>]*(googleapis|gstatic)[^>]*>/g, '')
  .replace(/<script src="app.js"><\/script>/, '');

const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
const noop = () => {};
const ctxStub = new Proxy({}, {
  get: (t, p) => (p === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop),
  set: () => true,
});
const canvas = window.document.getElementById('scene');
canvas.getContext = () => ctxStub;
canvas.setPointerCapture = noop;
canvas.releasePointerCapture = noop;
window.requestAnimationFrame = () => 0; // no render loop needed for math checks
Object.defineProperty(window, 'innerWidth', { value: 1280 });
Object.defineProperty(window, 'innerHeight', { value: 800 });

window.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
const T = window.__tess;

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg); if (!cond) failures++; };
const eqv = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const eqm = (A, B) => A.every((row, i) => eqv(row, B[i]));

// ---------- helpers -----------------------------------------------------------
function det4(M) {
  // Laplace expansion is fine for 4x4 integer matrices
  const m3 = (a) => a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])
                  - a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])
                  + a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0]);
  let d = 0;
  for (let j = 0; j < 4; j++) {
    const sub = M.slice(1).map(r => r.filter((_, c) => c !== j));
    d += (j % 2 ? -1 : 1) * M[0][j] * m3(sub);
  }
  return d;
}
function isSignedPermutation(M) {
  for (const row of M) {
    const nz = row.filter(v => v !== 0);
    if (nz.length !== 1 || Math.abs(nz[0]) !== 1) return false;
  }
  for (let c = 0; c < 4; c++) {
    if (M.filter(r => r[c] !== 0).length !== 1) return false;
  }
  return true;
}
function snapshot() {
  return T.pieces.map(p => ({ cur: p.cur.slice(), rot: p.rot.map(r => r.slice()) }));
}
function equalsSnapshot(s) {
  return T.pieces.every((p, i) => eqv(p.cur, s[i].cur) && eqm(p.rot, s[i].rot));
}
const nonzeros = (v) => v.filter(x => x !== 0).length;

// in-cell grips of cell axis d: all 9 edge diagonals and 8 corner diagonals
function edgeGrips(inAx) {
  const out = [];
  const dirs = [[1,1,0],[1,-1,0],[1,0,1],[1,0,-1],[0,1,1],[0,1,-1]];
  for (const g of dirs) {
    const n = Math.hypot(...g);
    out.push({ inAx, u3: g.map(x => x / n), theta: Math.PI });
  }
  return out;
}
function cornerGrips(inAx) {
  const out = [];
  for (const sx of [1,-1]) for (const sy of [1,-1]) {
    const g = [sx, sy, 1];
    const n = Math.hypot(...g);
    for (const s of [1, -1]) out.push({ inAx, u3: g.map(x => x / n), theta: s * 2 * Math.PI / 3 });
  }
  return out;
}

// ---------- 1+2: census --------------------------------------------------------
T.reset();
ok(T.pieces.length === 80, '80 movable pieces (3^4 - 1)');
const byStickers = [0, 0, 0, 0, 0];
for (const p of T.pieces) byStickers[p.stickers.length]++;
ok(byStickers[1] === 8,  '8 one-colour pieces (cell centres)');
ok(byStickers[2] === 24, '24 two-colour pieces');
ok(byStickers[3] === 32, '32 three-colour pieces');
ok(byStickers[4] === 16, '16 four-colour pieces');
ok(T.pieces.reduce((s, p) => s + p.stickers.length, 0) === 216, '216 stickers = 8 cells x 27');
let slabsOK = true;
for (let d = 0; d < 4; d++) for (const sd of [1, -1]) {
  if (T.pieces.filter(p => p.cur[d] === sd).length !== 27) slabsOK = false;
}
ok(slabsOK, 'every cell slab holds exactly 27 pieces');

// ---------- 3: twist matrices are rotations of the lattice ---------------------
let matOK = true, detOK = true;
const planeMats = [];
for (let d = 0; d < 4 && matOK; d++) {
  const inAx = [0,1,2,3].filter(a => a !== d);
  for (const [i, j] of T.planesFor(d)) for (const dir of [1, -1]) {
    const M = T.rotInt(i, j, dir);
    planeMats.push({ d, M });
    if (!isSignedPermutation(M)) matOK = false;
    if (det4(M) !== 1) detOK = false;
  }
  for (const g of [...edgeGrips(inAx), ...cornerGrips(inAx)]) {
    const M = T.rotAxisInt(g.inAx, g.u3, g.theta);
    if (!isSignedPermutation(M)) matOK = false;
    if (det4(M) !== 1) detOK = false;
    if (M[d][d] !== 1) matOK = false; // must fix the cell axis
  }
}
ok(matOK, 'all 48 plane + 56 edge/corner grip matrices are signed permutations fixing the cell axis');
ok(detOK, 'all twist matrices have determinant +1 (rotations, never reflections)');

// ---------- 4: generator orders -------------------------------------------------
function applyN(fn, n) { for (let k = 0; k < n; k++) fn(); }
let ordersOK = true;
for (let d = 0; d < 4 && ordersOK; d++) {
  const sd = 1;
  const inAx = [0,1,2,3].filter(a => a !== d);
  for (const [i, j] of T.planesFor(d)) {
    T.reset(); const s0 = snapshot();
    applyN(() => T.commitTwist(d, sd, i, j, 1), 4);
    if (!equalsSnapshot(s0)) ordersOK = false;
    T.reset();
    applyN(() => T.commitTwist(d, sd, i, j, 1), 2);
    if (equalsSnapshot(s0)) ordersOK = false; // half turn must NOT be identity
  }
  for (const g of edgeGrips(inAx)) {
    T.reset(); const s0 = snapshot();
    applyN(() => T.commitTwistAxis(d, sd, g.inAx, g.u3, g.theta), 2);
    if (!equalsSnapshot(s0)) ordersOK = false;
  }
  for (const g of cornerGrips(inAx)) {
    T.reset(); const s0 = snapshot();
    applyN(() => T.commitTwistAxis(d, sd, g.inAx, g.u3, g.theta), 3);
    if (!equalsSnapshot(s0)) ordersOK = false;
  }
}
ok(ordersOK, 'generator orders: plane twist^4 = grip180^2 = grip120^3 = identity (and twist^2 != identity)');

// ---------- 5: grips lie in the cell's 24-element rotation group ---------------
let gripsLegal = true;
for (let d = 0; d < 4 && gripsLegal; d++) {
  const inAx = [0,1,2,3].filter(a => a !== d);
  // generate the group from the three 90-degree plane rotations of this cell
  const gens = T.planesFor(d).flatMap(([i, j]) => [T.rotInt(i, j, 1), T.rotInt(i, j, -1)]);
  const seen = new Map();
  const key = (M) => M.flat().join(',');
  const queue = [T.I4()];
  seen.set(key(T.I4()), true);
  while (queue.length) {
    const M = queue.pop();
    for (const g of gens) {
      const N = T.matMul4(g, M);
      const k = key(N);
      if (!seen.has(k)) { seen.set(k, true); queue.push(N); }
    }
  }
  if (seen.size !== 24) gripsLegal = false; // rotation group of the cube
  for (const g of [...edgeGrips(inAx), ...cornerGrips(inAx)]) {
    if (!seen.has(key(T.rotAxisInt(g.inAx, g.u3, g.theta)))) gripsLegal = false;
  }
}
ok(gripsLegal, 'plane twists generate exactly 24 rotations per cell; every edge/corner grip is one of them');

// ---------- 6: twists are slab-preserving lattice bijections --------------------
let bijOK = true, typeOK = true, slabOK = true, restOK = true;
for (let trial = 0; trial < 200; trial++) {
  T.reset();
  // random pre-scramble so we test from arbitrary positions
  for (let k = 0; k < 10; k++) {
    const d = (Math.random()*4)|0, sd = Math.random() < 0.5 ? 1 : -1;
    const [i, j] = T.planesFor(d)[(Math.random()*3)|0];
    T.commitTwist(d, sd, i, j, Math.random() < 0.5 ? 1 : -1);
  }
  const d = (Math.random()*4)|0, sd = Math.random() < 0.5 ? 1 : -1;
  const before = snapshot();
  const inSlab = T.pieces.map(p => p.cur[d] === sd);
  const [i, j] = T.planesFor(d)[(Math.random()*3)|0];
  T.commitTwist(d, sd, i, j, Math.random() < 0.5 ? 1 : -1);
  const seen = new Set();
  T.pieces.forEach((p, idx) => {
    seen.add(p.cur.join(','));
    if (nonzeros(p.cur) !== nonzeros(before[idx].cur)) typeOK = false;
    if (inSlab[idx] && p.cur[d] !== sd) slabOK = false;
    if (!inSlab[idx] && !eqv(p.cur, before[idx].cur)) restOK = false;
  });
  if (seen.size !== 80 || seen.has('0,0,0,0')) bijOK = false;
}
ok(bijOK, 'after any twist the 80 pieces occupy 80 distinct lattice cells (never the core)');
ok(typeOK, 'twists preserve piece type (1c/2c/3c/4c never transmute)');
ok(slabOK, 'twisted slab stays inside its cell');
ok(restOK, 'pieces outside the twisted slab never move');

// ---------- 7+8: position/orientation consistency ------------------------------
let curRotOK = true, facingOK = true;
T.reset();
for (let k = 0; k < 500; k++) {
  const d = (Math.random()*4)|0, sd = Math.random() < 0.5 ? 1 : -1;
  if (Math.random() < 0.7) {
    const [i, j] = T.planesFor(d)[(Math.random()*3)|0];
    T.commitTwist(d, sd, i, j, Math.random() < 0.5 ? 1 : -1);
  } else {
    const inAx = [0,1,2,3].filter(a => a !== d);
    const grips = Math.random() < 0.5 ? edgeGrips(inAx) : cornerGrips(inAx);
    const g = grips[(Math.random()*grips.length)|0];
    T.commitTwistAxis(d, sd, g.inAx, g.u3, g.theta);
  }
  for (const p of T.pieces) {
    if (!eqv(T.matVec4i(p.rot, p.solved), p.cur)) curRotOK = false;
    const axes = new Set();
    for (const st of p.stickers) {
      const { fa, fs } = T.facingOf(p, st);
      axes.add(fa);
      if (p.cur[fa] === 0 || (p.cur[fa] > 0 ? 1 : -1) !== fs) facingOK = false;
    }
    if (axes.size !== p.stickers.length) facingOK = false;
  }
  if (!curRotOK || !facingOK) break;
}
ok(curRotOK, 'cur == rot * solved stays exact through 500 random mixed twists');
ok(facingOK, 'sticker facings always match the axes/signs of the current position');

// ---------- 9: scramble + inverse replay ----------------------------------------
T.reset();
const seq = [];
for (let k = 0; k < 300; k++) {
  const d = (Math.random()*4)|0, sd = Math.random() < 0.5 ? 1 : -1;
  const [i, j] = T.planesFor(d)[(Math.random()*3)|0];
  const dir = Math.random() < 0.5 ? 1 : -1;
  T.commitTwist(d, sd, i, j, dir);
  seq.push({ d, sd, i, j, dir });
}
ok(!T.isSolved(), '300-move scramble is not solved');
for (const m of seq.reverse()) T.commitTwist(m.d, m.sd, m.i, m.j, -m.dir);
const home = T.pieces.every(p => eqv(p.cur, p.solved) && eqm(p.rot, T.I4()));
ok(home && T.isSolved(), 'inverse replay returns every piece exactly home (position AND orientation)');

console.log(failures === 0 ? '\nALL MATH CHECKS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
