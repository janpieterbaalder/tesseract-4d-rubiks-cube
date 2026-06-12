// ============================================================================
// Smoke + behaviour tests for the Hypercube Academy level system.
//
// Run:  npm i jsdom && node test/levels.test.js
//
// Checks, against the live engine + course code loaded from app.js:
//   1. Curriculum shape: unique ids, valid chapters, required fields, and
//      every level's enter() + objs() run without throwing.
//   2. Objective specs are well-formed (text plus an event trigger or check).
//   3. Event flow: simulated engine events complete objectives in order,
//      multi-count objectives track progress, and finishing the last
//      objective marks the level done and persists progress.
//   4. Locking: level i+1 unlocks exactly when level i is done.
//   5. Pattern detection: the commutator level recognises A, B, A', B'
//      (and rejects wrong candidates); isInverseMove handles plane + grips.
//   6. Goal predicates: waveSolved() grades exactly the right piece families;
//      cellAtCenter() identifies the centred cell; the lab commutator
//      actually displaces a small, nonzero set of pieces.
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
window.requestAnimationFrame = () => 0; // no render loop needed
Object.defineProperty(window, 'innerWidth', { value: 1280 });
Object.defineProperty(window, 'innerHeight', { value: 800 });

window.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
const T = window.__tess;
const A = T.academy;
const { LEVELS, CHAPTERS, course } = A;

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg); if (!cond) failures++; };

// ---------- 1+2: curriculum shape ----------------------------------------------
ok(LEVELS.length >= 20, `a substantial course (${LEVELS.length} levels)`);
ok(new Set(LEVELS.map(l => l.id)).size === LEVELS.length, 'level ids are unique');
ok(LEVELS.every(l => l.ch >= 0 && l.ch < CHAPTERS.length), 'every level belongs to a valid chapter');
ok(CHAPTERS.every((_, c) => LEVELS.some(l => l.ch === c)), 'every chapter has at least one level');
ok(LEVELS.every(l => l.title && l.text && typeof l.enter === 'function' && typeof l.objs === 'function'),
  'every level has title, lesson text, enter() and objs()');

let entersOK = true, objsOK = true;
for (let i = 0; i < LEVELS.length; i++) {
  try {
    A.startLevel(i); // runs enter() + objs() + UI render on the real engine
    if (!course.objs.length) objsOK = false;
    for (const o of course.objs) {
      if (!o.text) objsOK = false;
      if (!o.on && !o.check) objsOK = false;
      if (o.check && typeof o.check !== 'function') objsOK = false;
    }
  } catch (e) {
    console.log('   level threw:', LEVELS[i].id, e.message);
    entersOK = false;
  }
}
ok(entersOK, 'every level starts (enter + objective build + render) without throwing');
ok(objsOK, 'every objective has text and an event trigger or state check');
A.exitCourse();
course.done.clear();

// ---------- 3: event flow -------------------------------------------------------
T.reset();
A.startLevel(0); // shape-1: orbit, then zoom
ok(course.active && course.obj === 0, 'level 1 starts at objective 0');
A.courseEvent('zoom');
ok(course.obj === 0, 'out-of-order event does not complete the current objective');
A.courseEvent('orbit');
ok(course.obj === 1, 'matching event completes the objective');
A.courseEvent('zoom');
ok(course.complete && course.done.has(LEVELS[0].id), 'last objective completes + persists the level');

// multi-count distinct keys (shape-3: centre 3 different cells)
const i3 = LEVELS.findIndex(l => l.id === 'shape-3');
A.startLevel(i3);
A.courseEvent('rot4d');
A.courseEvent('center', { key: 'X+' });
A.courseEvent('center', { key: 'X+' }); // duplicate cell must not count twice
ok(course.obj === 1 && !course.complete, 'duplicate distinct-key events count once');
A.courseEvent('center', { key: 'Y+' });
A.courseEvent('center', { key: 'Z-' });
ok(course.complete, 'three distinct cells complete the centring objective');

// ---------- 4: locking ----------------------------------------------------------
course.done.clear();
ok(A.levelUnlocked(0) && !A.levelUnlocked(1), 'only level 1 unlocked at a fresh start');
course.done.add(LEVELS[0].id);
ok(A.levelUnlocked(1) && !A.levelUnlocked(2), 'finishing a level unlocks exactly the next');
ok(A.firstOpenLevel() === 1, 'continue points at the first unfinished level');

// ---------- 5: pattern detection ------------------------------------------------
const iComm = LEVELS.findIndex(l => l.id === 'comm-1');
A.startLevel(iComm);
const mvA = { mode: 'plane', d: 1, sd: 1, i: 0, j: 2, dir: 1 };
const mvB = { mode: 'plane', d: 0, sd: 1, i: 1, j: 2, dir: 1 };
A.courseEvent('twist', { mv: mvA });
ok(course.obj === 1, 'commutator: A accepted');
A.courseEvent('twist', { mv: { ...mvA, dir: -1 } });   // same cell -> not a valid B
ok(course.obj === 1, 'commutator: same-cell move rejected as B');
A.courseEvent('twist', { mv: mvB });
ok(course.obj === 2, 'commutator: B accepted');
A.courseEvent('twist', { mv: mvB });                    // not A'
ok(course.obj === 2, 'commutator: non-inverse rejected as A\'');
A.courseEvent('twist', { mv: { ...mvA, dir: -1 } });
ok(course.obj === 3, 'commutator: A\' detected');
A.courseEvent('twist', { mv: { ...mvB, dir: -1 } });
ok(course.complete, 'commutator: B\' completes the level');

const inv = A.isInverseMove;
ok(inv({ mode: 'plane', d: 0, sd: 1, i: 1, j: 2, dir: -1 }, mvB), 'isInverseMove: opposite dir');
ok(inv({ mode: 'plane', d: 0, sd: 1, i: 2, j: 1, dir: 1 }, mvB), 'isInverseMove: swapped plane, same dir');
ok(!inv({ mode: 'plane', d: 0, sd: -1, i: 1, j: 2, dir: -1 }, mvB), 'isInverseMove: other cell rejected');
const u = [Math.SQRT1_2, Math.SQRT1_2, 0];
const flip = { mode: 'axis', d: 3, sd: 1, inAx: [0, 1, 2], u3: u, theta: Math.PI };
ok(inv(flip, flip), 'isInverseMove: a 180° edge flip undoes itself');
const spin = { mode: 'axis', d: 3, sd: 1, inAx: [0, 1, 2], u3: [1, 0, 0], theta: 2 * Math.PI / 3 };
ok(inv({ ...spin, theta: -spin.theta }, spin), 'isInverseMove: 120° spin inverted by -120°');
ok(!inv(spin, spin), 'isInverseMove: repeating a 120° spin is not its inverse');

// ---------- 6: goal predicates ---------------------------------------------------
A.exitCourse();
T.reset();
ok(A.waveSolved(2) && A.waveSolved(3) && T.isSolved(), 'solved cube passes every wave goal');
ok(A.displacedPieces().length === 0, 'solved cube has no displaced pieces');

// a single twist must break wave 1 (2-colour pieces leave home)
T.commitTwist(0, 1, 1, 2, 1);
ok(!A.waveSolved(2), 'one twist breaks the wave-1 goal');
T.reset();

// the lab commutator is chosen for the minimal possible [A,B] footprint on the
// 3^4: exhaustive search over all plane and grip commutators bottoms out at 13
A.LAB_COMM.forEach(A.commitMove);
const dis = A.displacedPieces().length;
ok(dis === 13, `lab commutator displaces the minimal nonzero set (${dis} pieces)`);
T.reset();

// cellAtCenter: identity view centres the -W (Inner) cell and nothing else
ok(A.cellAtCenter(3, -1), 'identity view: Inner (W-) cell is at the centre');
ok(!A.cellAtCenter(3, 1) && !A.cellAtCenter(0, 1), 'identity view: no other cell registers as centred');

// pieceHome must track facing, not just position: a twisted slab returns to
// position after 2 edge flips but pieceHome stays true only when truly home
const inAx = [1, 2, 3];
T.commitTwistAxis(0, 1, inAx, [Math.SQRT1_2, Math.SQRT1_2, 0], Math.PI);
ok(A.displacedPieces().length > 0, 'edge flip displaces pieces');
T.commitTwistAxis(0, 1, inAx, [Math.SQRT1_2, Math.SQRT1_2, 0], Math.PI);
ok(A.displacedPieces().length === 0 && T.isSolved(), 'second flip restores every piece home');

console.log(failures === 0 ? '\nALL ACADEMY CHECKS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
