// ============================================================================
// Smoke + behaviour tests for the Hypercube Academy tutor (Professor Tess).
//
// Run:  npm i jsdom && node test/levels.test.js
//
// Checks, against the live engine + lesson code loaded from app.js:
//   1. Curriculum shape: unique ids, valid chapters, required fields, and
//      every step is exactly one of say / demo / guide / goals / until.
//   2. Step flow on lesson 1: say steps advance with Continue, goal events
//      complete in order, out-of-order events are ignored, finishing the
//      last step marks the lesson done and persists progress.
//   3. The practice copy: starting a lesson snapshots the player's game and
//      leaving the Academy restores it exactly (pieces, history, view).
//   4. Every lesson is playable start to finish: a generic player walks all
//      steps — Continue for talk, Skip for demos, the professor's own move
//      list for guided algorithms, and a brute-force event battery for the
//      free-practice goals.
//   5. Guided algorithms: correct moves advance the pointer, wrong moves do
//      not, and a plane twist reported with swapped axes still matches.
//   6. Goal predicates: waveSolved() grades exactly the right families,
//      cellAtCenter() identifies the centred cell, the lab commutator
//      displaces the minimal 13 pieces and INV_COMM heals it.
//   7. Locking: lesson i+1 unlocks exactly when lesson i is done.
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
const { LESSONS, CHAPTERS, tut } = A;

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg); if (!cond) failures++; };

// ---------- 1: curriculum shape --------------------------------------------------
ok(LESSONS.length >= 20, `a substantial course (${LESSONS.length} lessons)`);
ok(new Set(LESSONS.map(l => l.id)).size === LESSONS.length, 'lesson ids are unique');
ok(LESSONS.every(l => l.ch >= 0 && l.ch < CHAPTERS.length), 'every lesson belongs to a valid chapter');
ok(CHAPTERS.every((_, c) => LESSONS.some(l => l.ch === c)), 'every chapter has at least one lesson');
ok(LESSONS.every(l => l.title && Array.isArray(l.steps) && l.steps.length > 0),
  'every lesson has a title and at least one step');
ok(LESSONS.every(l => l.steps.every(s => s.say)), 'every step has the professor saying something');
ok(LESSONS.every(l => l.steps.every(s =>
  [s.demo, s.guide, s.goals, s.until].filter(Boolean).length <= 1)),
  'every step is exactly one kind (say / demo / guide / goals / until)');
ok(LESSONS.some(l => l.steps.some(s => s.demo)), 'the professor demonstrates moves herself');
ok(LESSONS.some(l => l.steps.some(s => s.guide)), 'the professor guides algorithms move by move');
ok(LESSONS.some(l => l.steps.some(s => s.glow)), 'lessons point at pieces with the glow');

// ---------- 2: step flow on lesson 1 ----------------------------------------------
tut.done.clear();
T.reset();
A.startLesson(0); // hello: say, say, goals (orbit -> zoom), say
ok(tut.active && tut.stepIdx === 0, 'lesson 1 starts at step 0');
A.courseEvent('orbit');
ok(tut.stepIdx === 0, 'events do not advance a talking step');
A.tutNext();
A.tutNext();
ok(tut.stepIdx === 2, 'Continue advances the talking steps');
A.courseEvent('zoom');
ok(tut.obj === 0, 'out-of-order event does not complete the current objective');
A.courseEvent('orbit');
ok(tut.obj === 1, 'matching event completes the objective');
A.courseEvent('zoom');
ok(tut.stepIdx === 3, 'finishing the goals advances to the next step');
A.tutNext();
ok(tut.lessonDone && tut.done.has(LESSONS[0].id), 'last step completes + persists the lesson');
A.exitCourse();

// ---------- 3: the practice copy ---------------------------------------------------
T.reset();
T.commitTwist(0, 1, 1, 2, 1);
T.commitTwist(2, -1, 0, 3, -1);
const before = T.pieces.map(p => ({ cur: p.cur.slice(), rot: p.rot.map(r => r.slice()) }));
A.startLesson(0);
ok(A.hasSnapshot(), 'starting a lesson parks the player\'s game');
ok(T.pieces.some((p, i) => p.cur.join() !== before[i].cur.join()) || T.isSolved(),
  'the lesson runs on a re-staged practice cube');
A.exitCourse();
ok(!A.hasSnapshot(), 'leaving the Academy releases the snapshot');
ok(T.pieces.every((p, i) =>
  p.cur.join() === before[i].cur.join() &&
  p.rot.flat().join() === before[i].rot.flat().join()),
  'the player\'s exact cube state is restored on exit');
T.reset();

// ---------- 4: every lesson is playable start to finish ----------------------------
// a generic player: Continue for talk, Skip for demos, the professor's own
// moves for guides, and a brute-force battery of engine events for goals
function centerWplusView() { const M = T.I4(); M[3][3] = -1; M[0][0] = -1; return M; }
const preps = [
  () => {},
  () => T.reset(),
  () => A.setView4(T.I4()),
  () => { T.reset(); A.setView4(T.I4()); },
  () => A.setView4(centerWplusView()),
  () => { T.reset(); A.setView4(centerWplusView()); },
];
function candidateEvents() {
  const evs = [];
  for (const t of ['orbit', 'zoom', 'rot4d', 'viewChange', 'undo']) evs.push({ t, info: {} });
  for (const key of ['X+', 'X-', 'Y+', 'Y-', 'Z+', 'Z-', 'W+', 'W-']) evs.push({ t: 'center', info: { key } });
  for (const n of [1, 2, 3, 4]) {
    const piece = T.pieces.find(p => p.stickers.length === n);
    evs.push({ t: 'select', info: { piece } });
  }
  for (let d = 0; d < 4; d++) for (const sd of [1, -1])
    for (const [i, j] of T.planesFor(d)) for (const dir of [1, -1])
      evs.push({ mv: { mode: 'plane', d, sd, i, j, dir } });
  return evs;
}
function trySatisfyGoal() {
  const step0 = tut.stepIdx, obj0 = tut.obj;
  for (const prep of preps) {
    for (const ev of candidateEvents()) {
      prep();
      if (ev.mv) {
        A.courseEvent('twist', { mv: ev.mv });
        A.courseEvent('moved', { mv: ev.mv, record: true });
      } else {
        A.courseEvent(ev.t, ev.info);
      }
      if (tut.obj !== obj0 || tut.stepIdx !== step0 || tut.lessonDone) return true;
    }
  }
  return false;
}

let allPlayable = true;
for (let i = 0; i < LESSONS.length; i++) {
  A.startLesson(i);
  let guard = 0, stuck = false;
  while (tut.active && !tut.lessonDone && guard++ < 300) {
    const st = LESSONS[i].steps[tut.stepIdx];
    const stepBefore = tut.stepIdx;
    if (st._kind === 'say') A.tutNext();
    else if (st._kind === 'demo') A.skipDemo();
    else if (st._kind === 'until') [].concat(st.until.on).forEach(t => A.courseEvent(t));
    else if (st._kind === 'guide') {
      let g = 0;
      while (tut.gmoves && tut.stepIdx === stepBefore && !tut.lessonDone && g++ < 30) {
        const mv = tut.gmoves[tut.gi];
        A.commitMove(mv);
        A.courseEvent('moved', { record: true, mv });
      }
    } else if (st._kind === 'goals') {
      let g = 0;
      while (tut.stepIdx === stepBefore && !tut.lessonDone && g++ < 30) {
        if (!trySatisfyGoal()) break;
      }
    }
    if (tut.stepIdx === stepBefore && !tut.lessonDone) { stuck = true; break; }
  }
  if (!tut.lessonDone || stuck) {
    allPlayable = false;
    console.log(`   stuck in lesson ${LESSONS[i].id} at step ${tut.stepIdx}`);
  }
}
ok(allPlayable, 'every lesson is playable from first step to completion');
ok(LESSONS.every(l => tut.done.has(l.id)), 'the full walk marked every lesson done');
A.exitCourse();
T.reset();

// ---------- 5: guided algorithms ----------------------------------------------------
const iPlanes = LESSONS.findIndex(l => l.id === 'planes');
A.startLesson(iPlanes);
A.tutNext(); // say -> guide
ok(tut.gmoves && tut.gmoves.length === 6, 'the planes lesson guides six moves');
const exp0 = tut.gmoves[0];
const wrong = { mode: 'plane', d: (exp0.d + 1) % 4, sd: 1, i: 0, j: 1, dir: 1 };
A.courseEvent('moved', { record: true, mv: wrong });
ok(tut.gi === 0, 'a wrong move does not advance the guide');
A.commitMove(exp0);
A.courseEvent('moved', { record: true, mv: exp0 });
ok(tut.gi === 1, 'the expected move advances the guide');
const exp1 = tut.gmoves[1]; // same turn, reported with swapped axes + flipped dir
A.commitMove(exp1);
A.courseEvent('moved', { record: true, mv: { ...exp1, i: exp1.j, j: exp1.i, dir: -exp1.dir } });
ok(tut.gi === 2, 'a plane twist with swapped axes still matches the guide');
ok(A.guideExpected() === tut.gmoves[2], 'guideExpected() reports the next move for the dock');
A.exitCourse();

const inv = A.isInverseMove, same = A.sameMove;
const mvB = { mode: 'plane', d: 0, sd: 1, i: 1, j: 2, dir: 1 };
ok(inv({ mode: 'plane', d: 0, sd: 1, i: 1, j: 2, dir: -1 }, mvB), 'isInverseMove: opposite dir');
ok(inv({ mode: 'plane', d: 0, sd: 1, i: 2, j: 1, dir: 1 }, mvB), 'isInverseMove: swapped plane, same dir');
ok(!inv({ mode: 'plane', d: 0, sd: -1, i: 1, j: 2, dir: -1 }, mvB), 'isInverseMove: other cell rejected');
const u = [Math.SQRT1_2, Math.SQRT1_2, 0];
const flip = { mode: 'axis', d: 3, sd: 1, inAx: [0, 1, 2], u3: u, theta: Math.PI };
ok(inv(flip, flip), 'isInverseMove: a 180° edge flip undoes itself');
const spin = { mode: 'axis', d: 3, sd: 1, inAx: [0, 1, 2], u3: [1, 0, 0], theta: 2 * Math.PI / 3 };
ok(inv({ ...spin, theta: -spin.theta }, spin), 'isInverseMove: 120° spin inverted by -120°');
ok(same(mvB, mvB), 'sameMove: identical plane twists match');
ok(same({ ...mvB, i: 2, j: 1, dir: -1 }, mvB), 'sameMove: swapped axes + flipped dir is the same turn');
ok(!same({ ...mvB, dir: -1 }, mvB), 'sameMove: the inverse twist does not match');
ok(same(flip, flip) && same(spin, spin) && !same({ ...spin, theta: -spin.theta }, spin),
  'sameMove: grips match exactly, inverse spins do not');
ok(/Top/.test(A.describeMove(A.LAB_COMM[0])), 'describeMove names the cell of a plane twist');
ok(/180°/.test(A.describeMove(flip)), 'describeMove spells out an edge flip');

// ---------- 6: goal predicates -------------------------------------------------------
T.reset();
ok(A.waveSolved(2) && A.waveSolved(3) && T.isSolved(), 'solved cube passes every wave goal');
ok(A.displacedPieces().length === 0, 'solved cube has no displaced pieces');
T.commitTwist(0, 1, 1, 2, 1);
ok(!A.waveSolved(2), 'one twist breaks the wave-1 goal');
T.reset();

// the lab commutator is chosen for the minimal possible [A,B] footprint on the
// 3^4: exhaustive search over all plane and grip commutators bottoms out at 13
A.LAB_COMM.forEach(A.commitMove);
const dis = A.displacedPieces().length;
ok(dis === 13, `lab commutator displaces the minimal nonzero set (${dis} pieces)`);
A.INV_COMM.forEach(A.commitMove);
ok(T.isSolved(), 'INV_COMM heals exactly what LAB_COMM disturbs');
T.reset();

A.setView4(T.I4());
ok(A.cellAtCenter(3, -1), 'identity view: Inner (W-) cell is at the centre');
ok(!A.cellAtCenter(3, 1) && !A.cellAtCenter(0, 1), 'identity view: no other cell registers as centred');

// pieceHome must track facing, not just position: a twisted slab returns to
// position after 2 edge flips but pieceHome stays true only when truly home
const inAx = [1, 2, 3];
T.commitTwistAxis(0, 1, inAx, [Math.SQRT1_2, Math.SQRT1_2, 0], Math.PI);
ok(A.displacedPieces().length > 0, 'edge flip displaces pieces');
T.commitTwistAxis(0, 1, inAx, [Math.SQRT1_2, Math.SQRT1_2, 0], Math.PI);
ok(A.displacedPieces().length === 0 && T.isSolved(), 'second flip restores every piece home');

// ---------- 7: locking ----------------------------------------------------------------
tut.done.clear();
ok(A.lessonUnlocked(0) && !A.lessonUnlocked(1), 'only lesson 1 unlocked at a fresh start');
tut.done.add(LESSONS[0].id);
ok(A.lessonUnlocked(1) && !A.lessonUnlocked(2), 'finishing a lesson unlocks exactly the next');
ok(A.firstOpenLesson() === 1, 'continue points at the first unfinished lesson');

// the avatar renders every mood without throwing
ok(['talk', 'happy', 'think', 'point', 'party'].every(m => /<svg/.test(A.avatarSVG(m))),
  'Professor Tess has all five moods');

console.log(failures === 0 ? '\nALL ACADEMY CHECKS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
