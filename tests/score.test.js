import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORES, EXTRA_LIFE_AT, STAGE_PAR, STAGE_BONUS_BASE, COURSE_BONUS,
  award, stageBonus, featuresJumped, loadScores, submitScore, _setStorage,
} from '../js/score.js';
import { createGame, updateGame, DT, STAGE_CLEAR_TIME } from '../js/state.js';
import { STAGE_BREAKS, CHECKPOINT_SPACING, checkpointX } from '../js/terrain.js';

const noInput = {
  state: { accel: false, brake: false, jump: false, fire: false, pause: false, mute: false, restart: false },
  pressed: () => false,
  endFrame() {},
};
const press = (...names) => ({
  state: { accel: false, brake: false, jump: false, fire: false, pause: false, mute: false, restart: false },
  pressed: (n) => names.includes(n),
  endFrame() {},
});

const step = (game, input = noInput, frames = 1) => {
  for (let i = 0; i < frames; i++) updateGame(game, input, DT);
};

const stepUntilPhaseChanges = (game, input = noInput, maxFrames = 20000) => {
  const from = game.phase;
  let n = 0;
  while (game.phase === from && n < maxFrames) { step(game, input); n++; }
  return n;
};

// A simple in-memory storage stub for submitScore/loadScores tests.
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
  };
}

// --- award() -----------------------------------------------------------------

test('award applies the combo multiplier', () => {
  const g = createGame('classic', 1);
  g.combo = { count: 0, mult: 3, timer: 0 };
  award(g, 100, 'x');
  assert.equal(g.score, 300);
  const ev = g.scoreEvents.at(-1);
  assert.equal(ev.base, 100);
  assert.equal(ev.pts, 300);
});

test('award skips the combo multiplier for the stageBonus tag', () => {
  const g = createGame('classic', 1);
  g.combo = { count: 0, mult: 3, timer: 0 };
  award(g, 100, 'stageBonus');
  assert.equal(g.score, 100, 'stageBonus tag must not be multiplied');
  assert.equal(g.scoreEvents.at(-1).pts, 100);
});

test('extra life granted exactly once per threshold', () => {
  const g = createGame('classic', 1);
  const baseLives = g.lives;
  g.score = 9990;

  award(g, 100, 'x'); // crosses 10000
  assert.equal(g.score, 10090);
  assert.equal(g.lives, baseLives + 1);
  assert.ok(g.events.includes('extraLife'));

  award(g, 50, 'x'); // still above 10000, no second grant
  assert.equal(g.lives, baseLives + 1, 'no repeat grant for an already-crossed threshold');

  g.score = 29990;
  award(g, 100, 'x'); // crosses 30000
  assert.equal(g.lives, baseLives + 2);
});

// --- stageBonus() --------------------------------------------------------------

test('stageBonus scales with time remaining under par, doubles for champion', () => {
  assert.equal(stageBonus(40, false), 2500);
  assert.equal(stageBonus(70, false), 1000);
  assert.equal(stageBonus(40, true), 5000);
});

// --- featuresJumped() -----------------------------------------------------------

test('featuresJumped returns only features fully cleared, excluding partial overlaps', () => {
  const jumpStartX = 100; // clearance threshold is jumpStartX + BUGGY_W(32) = 132
  const landX = 300;
  const features = [
    { id: 1, type: 'crater', x: 110, w: 40 },  // starts at 110 < 132: still under the buggy at takeoff, excluded
    { id: 2, type: 'crater', x: 280, w: 30 },  // ends at 310 > 300: not yet cleared by the landing, excluded
    { id: 3, type: 'crater', x: 150, w: 30 },  // fully inside: 150 >= 132 and 180 <= 300, included
  ];
  const cleared = featuresJumped(jumpStartX, landX, features);
  assert.deepEqual(cleared.map((f) => f.id), [3]);
});

// --- high scores ---------------------------------------------------------------

test('submitScore keeps top-10 sorted desc and trims', () => {
  _setStorage(memoryStorage());
  for (let i = 0; i < 12; i++) submitScore('classic', 'AAA', i * 100);
  const list = loadScores('classic');
  assert.equal(list.length, 10);
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].score >= list[i].score, 'scores must be sorted descending');
  }
  assert.equal(list[0].score, 1100, 'highest score kept');
});

test('loadScores survives a throwing storage stub', () => {
  _setStorage({
    getItem() { throw new Error('boom'); },
    setItem() { throw new Error('boom'); },
  });
  assert.deepEqual(loadScores('classic'), []);
});

test('submitScore no-ops persistence but still returns the in-memory list when storage throws', () => {
  _setStorage({
    getItem() { throw new Error('boom'); },
    setItem() { throw new Error('boom'); },
  });
  const list = submitScore('classic', 'ZZZ', 500);
  assert.deepEqual(list, [{ initials: 'ZZZ', score: 500 }]);
});

// --- checkpoint / stage progression (state.js integration) --------------------

test('crossing checkpoint 1 sets game.checkpoint and emits a checkpoint event', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };

  let n = 0;
  while (g.checkpoint < 1 && n < 2000) { step(g); n++; }

  assert.equal(g.checkpoint, 1);
  assert.ok(g.events.includes('checkpoint'));
});

test('crossing a STAGE_BREAKS checkpoint triggers stageClear, pays the tally, then resumes playing with stage incremented', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  // Park just before checkpoint index STAGE_BREAKS[0] (E) so the next frame's
  // advance crosses the stage-break line.
  const breakIdx = STAGE_BREAKS[0];
  g.buggy.worldX = checkpointX(breakIdx) - 1;

  stepUntilPhaseChanges(g); // playing -> stageClear
  assert.equal(g.phase, 'stageClear');
  assert.equal(g.checkpoint, breakIdx);
  assert.ok(g.stageClear);
  const expectedTotal = g.stageClear.total;
  const scoreAtEntry = g.score;

  const framesInStageClear = stepUntilPhaseChanges(g); // stageClear -> playing
  assert.equal(g.phase, 'playing');
  assert.equal(g.stage, 1, 'stage increments after a non-course-end stageClear');
  assert.equal(g.stageTime, 0, 'stage clock resets after stageClear');
  assert.equal(g.score - scoreAtEntry, expectedTotal, 'the full stage bonus was paid out via ticks');
  assert.ok(framesInStageClear * DT >= STAGE_CLEAR_TIME - DT, 'stageClear lasts at least ~2.5s');
  assert.ok(g.events.includes('tally'), 'tally events were emitted while paying out');
});

// --- Z / course-end progression --------------------------------------------

const Z_IDX = STAGE_BREAKS[STAGE_BREAKS.length - 1];

/** Seeds one enemy, one enemy shot, and one player shot near worldX. */
function seedEntitiesNear(g, worldX) {
  g.enemies = [{ id: 1, kind: 'tank', x: worldX, y: 0, vx: 0, vy: 0, hp: 1, t: 0 }];
  g.enemyShots = [{ id: 2, kind: 'level', from: 1, x: worldX, y: 0, vx: -1, vy: 0 }];
  g.playerShots = [{ x: worldX, y: 0, vx: 1, vy: 0, dir: 'fwd' }];
}

test('crossing Z promotes to the champion course and clears stale entities', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  g.buggy.worldX = checkpointX(Z_IDX) - 1;
  seedEntitiesNear(g, g.buggy.worldX + 50);
  g.waveTimer = 3; // simulate an in-progress wave timer from the old lap

  stepUntilPhaseChanges(g); // playing -> stageClear
  assert.equal(g.phase, 'stageClear');
  assert.ok(g.stageClear.isCourseEnd);

  stepUntilPhaseChanges(g); // stageClear -> playing
  assert.equal(g.phase, 'playing');
  assert.equal(g.courseId, 1, 'courseId promotes to the champion course');
  assert.equal(g.terrain.courseId, 1, 'terrain is rebuilt as the champion course');
  assert.equal(g.checkpoint, 0, 'checkpoint resets to A');
  assert.equal(g.stage, 0);
  assert.equal(g.buggy.worldX, 0, 'buggy restarts at A');

  assert.deepEqual(g.enemies, [], 'stale enemies must not survive the course restart');
  assert.deepEqual(g.enemyShots, [], 'stale enemy shots must not survive the course restart');
  assert.deepEqual(g.playerShots, [], 'stale player shots must not survive the course restart');
  assert.equal(g.waveTimer, undefined, 'wave timer resets so the new lap spawns fresh');
});

test('crossing Z again on the champion course loops it and still clears stale entities', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.courseId = 1;
  g.terrain = { mode: 'test', features: [], courseId: 1 };
  g.buggy.worldX = checkpointX(Z_IDX) - 1;
  seedEntitiesNear(g, g.buggy.worldX + 50);

  stepUntilPhaseChanges(g); // playing -> stageClear
  assert.equal(g.phase, 'stageClear');
  assert.ok(g.stageClear.isCourseEnd);

  stepUntilPhaseChanges(g); // stageClear -> playing
  assert.equal(g.phase, 'playing');
  assert.equal(g.courseId, 1, 'stays on the champion course when looping');
  assert.equal(g.checkpoint, 0);
  assert.equal(g.buggy.worldX, 0);

  assert.deepEqual(g.enemies, [], 'stale enemies must not survive the loop');
  assert.deepEqual(g.enemyShots, [], 'stale enemy shots must not survive the loop');
  assert.deepEqual(g.playerShots, [], 'stale player shots must not survive the loop');
});

test('jump-over a crater awards craterJump 100', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.buggy.worldX = 0;
  // Crater sits well clear of the takeoff point (buggy.worldX + BUGGY_W) and
  // well short of where a full jump arc lands.
  g.terrain = { mode: 'test', features: [{ id: 1, type: 'crater', x: 60, w: 20, hp: 0, destroyed: false }] };

  step(g, press('jump')); // launches the jump; jumpStartX recorded
  assert.equal(g.buggy.airborne, true);

  let n = 0;
  while (g.buggy.airborne && n < 200) { step(g); n++; }

  assert.equal(g.buggy.airborne, false, 'buggy should have landed');
  assert.ok(g.scoreEvents.some((ev) => ev.tag === 'craterJump' && ev.base === 100));
});
