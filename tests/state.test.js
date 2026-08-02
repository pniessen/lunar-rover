import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, updateGame, buggyScreenX, qualifiesForHighScore,
  DT, DYING_TIME, RESPAWN_TIME, HIGH_SCORE_SLOTS, INITIALS_LEN,
} from '../js/state.js';
import { SPEED_BANDS } from '../js/buggy.js';
import { checkpointX, CHECKPOINT_SPACING } from '../js/terrain.js';
import { _setStorage, loadScores } from '../js/score.js';

// In-memory localStorage double, mirroring tests/score.test.js's convention.
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

const tableOf = (n, score) => Array.from(
  { length: n },
  (_, i) => ({ initials: 'ZZZ', score: score - i }),
);

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

// A terrain double: buggy.js treats mode:'test' as "consider every feature",
// so a single crater is enough to script a death at a known worldX.
const craterAt = (x, w = 24) => ({
  mode: 'test',
  features: [{ id: 1, type: 'crater', x, w, hp: 0, destroyed: false }],
});

const step = (game, input = noInput, frames = 1) => {
  for (let i = 0; i < frames; i++) updateGame(game, input, DT);
};

// Drive a running game until it leaves `phase` (or the budget runs out).
const stepUntilPhaseChanges = (game, input = noInput, maxFrames = 600) => {
  const from = game.phase;
  let n = 0;
  while (game.phase === from && n < maxFrames) { step(game, input); n++; }
  return n;
};

test('createGame produces the documented shape', () => {
  const g = createGame('classic', 7);
  assert.equal(g.mode, 'classic');
  assert.equal(g.phase, 'attract');
  assert.equal(g.lives, 3);
  assert.equal(g.checkpoint, 0);
  assert.equal(g.stage, 0);
  assert.equal(g.score, 0);
  assert.equal(g.rngSeed, 7);
  assert.equal(g.menuIndex, 0, 'menu defaults to CLASSIC');
  assert.deepEqual(g.combo, {
    count: 0, mult: 1, timer: 0, lastSeenScoreEventCount: 0, lastSeenGameEventCount: 0,
  });
  for (const k of ['events', 'playerShots', 'enemyShots', 'enemies', 'capsules']) {
    assert.ok(Array.isArray(g[k]), `${k} must be an array`);
  }
  assert.equal(g.powerup, null);
});

test('attract -> playing on any key, and the buggy does not move until then', () => {
  const g = createGame('classic', 1);
  step(g, noInput, 30);
  assert.equal(g.phase, 'attract');
  assert.equal(g.buggy.worldX, 0, 'attract screen must not advance the buggy');

  step(g, press('fire'));
  assert.equal(g.phase, 'playing');
  assert.equal(g.phaseTimer, 0);

  step(g, noInput);
  assert.ok(g.buggy.worldX > 0, 'playing must advance the buggy');
});

// Task 13: the attract screen gained a CLASSIC/ENDLESS mode-select menu.
// This replaces the old "any of the seven actions wakes the attract
// screen" behavior — accel/brake now only toggle the menu (see the
// dedicated endless.test.js menu tests for that), and pause/mute/restart
// are no-ops here, same as once a run is underway.
test('attract: only jump/fire start the game; accel/brake/pause/mute/restart do not', () => {
  for (const a of ['jump', 'fire']) {
    const g = createGame('classic', 1);
    step(g, press(a));
    assert.equal(g.phase, 'playing', `${a} should start the game`);
  }
  for (const a of ['accel', 'brake', 'pause', 'mute', 'restart']) {
    const g = createGame('classic', 1);
    step(g, press(a));
    assert.equal(g.phase, 'attract', `${a} should not start the game`);
  }
});

test('buggyScreenX drifts right with speed; camX trails the buggy by it', () => {
  const g = createGame('classic', 1);
  g.speed = SPEED_BANDS[0];
  assert.equal(buggyScreenX(g), 56);
  g.speed = SPEED_BANDS[2];
  assert.ok(Math.abs(buggyScreenX(g) - (56 + (SPEED_BANDS[2] - SPEED_BANDS[0]) * 0.45)) < 1e-9);
  assert.ok(buggyScreenX(g) > 56, 'faster == further right on screen');

  g.buggy.worldX = 1234;
  g.phase = 'playing';
  step(g);
  assert.ok(Math.abs(g.camX - (g.buggy.worldX - buggyScreenX(g))) < 1e-9);
});

test('death runs playing -> dying -> respawning -> playing and costs one life', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = craterAt(0); // buggy midpoint (worldX+16) starts inside it

  step(g);
  assert.equal(g.phase, 'dying');
  assert.equal(g.lives, 2, 'one life lost per death');
  assert.equal(g.buggy.alive, false);
  assert.ok(g.events.includes('explosion'));

  const dyingFrames = stepUntilPhaseChanges(g);
  assert.equal(g.phase, 'respawning');
  assert.ok(Math.abs(dyingFrames * DT - DYING_TIME) < 2 * DT, 'dying lasts ~0.9s');

  const respawnFrames = stepUntilPhaseChanges(g);
  assert.equal(g.phase, 'playing');
  assert.ok(Math.abs(respawnFrames * DT - RESPAWN_TIME) < 2 * DT, 'respawn lasts ~1s');
});

test('respawn rebuilds the buggy at the last checkpoint, alive and drivable', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.buggy.worldX = 2 * CHECKPOINT_SPACING + 100; // segment C
  g.terrain = craterAt(2 * CHECKPOINT_SPACING + 100);

  step(g);
  assert.equal(g.phase, 'dying');
  assert.equal(g.checkpoint, 2, 'checkpoint advances with the buggy');

  stepUntilPhaseChanges(g);
  assert.equal(g.phase, 'respawning');
  assert.equal(g.buggy.worldX, checkpointX(2));
  assert.equal(g.buggy.alive, true);
  assert.equal(g.buggy.deathCause, null);
  assert.equal(g.buggy.vy, 0);
  assert.equal(g.buggy.airborne, false);

  const x0 = g.buggy.worldX;
  step(g);
  assert.ok(g.buggy.worldX > x0, 'buggy is drivable during the respawn blink');
});

test('respawning is invulnerable — driving through the killer crater is survivable', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  // A crater wide enough that the buggy is still inside it at respawn.
  g.terrain = craterAt(0, 400);

  step(g);
  assert.equal(g.phase, 'dying');
  stepUntilPhaseChanges(g); // -> respawning, back at checkpoint 0 (x=0)
  assert.equal(g.phase, 'respawning');

  step(g, noInput, 30);
  assert.equal(g.phase, 'respawning');
  assert.equal(g.buggy.alive, true, 'no death while invulnerable');
  assert.equal(g.lives, 2, 'no extra life lost');
});

test('the third death ends the run at gameOver', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = craterAt(0, 4000);

  for (let life = 3; life > 1; life--) {
    stepUntilPhaseChanges(g); // playing -> dying
    assert.equal(g.phase, 'dying');
    stepUntilPhaseChanges(g); // dying -> respawning
    assert.equal(g.phase, 'respawning');
    stepUntilPhaseChanges(g); // respawning -> playing
    assert.equal(g.phase, 'playing');
  }
  assert.equal(g.lives, 1);

  stepUntilPhaseChanges(g); // playing -> dying
  assert.equal(g.lives, 0);
  stepUntilPhaseChanges(g); // dying -> gameOver, no respawn at 0 lives
  assert.equal(g.phase, 'gameOver');
});

test('gameOver returns to a fresh attract screen on jump/fire', () => {
  const g = createGame('classic', 3);
  g.phase = 'gameOver';
  g.lives = 0;
  g.score = 4200;
  g.buggy.worldX = 5000;
  g.checkpoint = 4;

  step(g, press('accel'));
  assert.equal(g.phase, 'gameOver', 'only jump/fire dismisses game over');

  step(g, press('fire'));
  assert.equal(g.phase, 'attract');
  assert.equal(g.lives, 3);
  assert.equal(g.score, 0);
  assert.equal(g.checkpoint, 0);
  assert.equal(g.buggy.worldX, 0);
  assert.equal(g.rngSeed, 3, 'mode/seed carry over into the new run');
  assert.equal(g.mode, 'classic');
});

test('stageTime advances only while playing', () => {
  const g = createGame('classic', 1);
  step(g, noInput, 10);
  assert.equal(g.stageTime, 0, 'attract does not run the stage clock');

  g.phase = 'playing';
  step(g, noInput, 10);
  assert.ok(Math.abs(g.stageTime - 10 * DT) < 1e-9);

  const t = g.stageTime;
  g.phase = 'dying';
  step(g, noInput, 10);
  assert.equal(g.stageTime, t, 'dying does not run the stage clock');

  g.phase = 'respawning';
  g.phaseTimer = 0;
  step(g, noInput, 10);
  assert.equal(g.stageTime, t, 'respawning does not run the stage clock');
});

// --- Task 14: hit-stop ---------------------------------------------------

test('freeze skips the whole simulation and drains in whole fixed ticks', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  step(g, noInput, 5);
  const x = g.buggy.worldX;
  const t = g.stageTime;

  g.freeze = 0.03; // an enemy kill's hit-stop: exactly 2 ticks at DT=1/60
  step(g);
  assert.equal(g.buggy.worldX, x, 'nothing moves while frozen');
  assert.equal(g.stageTime, t, 'no timer advances while frozen');
  assert.ok(g.freeze > 0, 'still frozen after one tick');

  step(g);
  assert.equal(g.freeze, 0, 'drained after the second tick');
  assert.equal(g.buggy.worldX, x, 'still frozen on the tick that drains it');

  step(g);
  assert.ok(g.buggy.worldX > x, 'simulation resumes once freeze hits 0');
});

test('a phase transition cancels any pending freeze', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = craterAt(0);
  g.freeze = 0;
  step(g);
  assert.equal(g.phase, 'dying');
  assert.equal(g.freeze, 0, 'entering dying leaves no freeze behind');
});

// --- Task 14: high-score initials entry -----------------------------------

test('qualifiesForHighScore: empty table, partial table, full table, zero score', () => {
  _setStorage(fakeStorage());
  assert.equal(qualifiesForHighScore('classic', 500), true, 'empty table takes anything');
  assert.equal(qualifiesForHighScore('classic', 0), false, 'a zero score never qualifies');

  _setStorage(fakeStorage({
    'lunar-rover-hs-classic': JSON.stringify(tableOf(HIGH_SCORE_SLOTS - 1, 9000)),
  }));
  assert.equal(qualifiesForHighScore('classic', 1), true, 'a free slot takes anything positive');

  _setStorage(fakeStorage({
    'lunar-rover-hs-classic': JSON.stringify(tableOf(HIGH_SCORE_SLOTS, 9000)),
  }));
  assert.equal(qualifiesForHighScore('classic', 8992), true, 'beats the last entry (8991)');
  assert.equal(qualifiesForHighScore('classic', 8991), false, 'ties do not displace');
  assert.equal(qualifiesForHighScore('classic', 10), false, 'below the table');
});

test('a qualifying run ends in enterScore with a fresh AAA entry', () => {
  _setStorage(fakeStorage());
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.lives = 1;
  g.score = 4200;
  g.terrain = craterAt(0, 4000);

  stepUntilPhaseChanges(g); // playing -> dying
  assert.equal(g.phase, 'dying');
  assert.equal(g.lives, 0);
  stepUntilPhaseChanges(g); // dying -> enterScore (not gameOver)
  assert.equal(g.phase, 'enterScore');
  assert.deepEqual(g.initialsEntry, { slots: ['A', 'A', 'A'], index: 0 });
});

test('a non-qualifying run skips straight to gameOver', () => {
  _setStorage(fakeStorage({
    'lunar-rover-hs-classic': JSON.stringify(tableOf(HIGH_SCORE_SLOTS, 90000)),
  }));
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.lives = 1;
  g.score = 120; // nowhere near the table
  g.terrain = craterAt(0, 4000);

  stepUntilPhaseChanges(g); // -> dying
  stepUntilPhaseChanges(g); // -> gameOver
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.initialsEntry, null);
});

test('initials cycling wraps A->Z on brake and Z->A on accel', () => {
  _setStorage(fakeStorage());
  const g = createGame('classic', 1);
  g.phase = 'enterScore';
  g.score = 500;
  g.initialsEntry = { slots: ['A', 'A', 'A'], index: 0 };

  step(g, press('accel'));
  assert.equal(g.initialsEntry.slots[0], 'B');
  step(g, press('brake'));
  assert.equal(g.initialsEntry.slots[0], 'A');
  step(g, press('brake'));
  assert.equal(g.initialsEntry.slots[0], 'Z', 'A wraps back to Z');
  step(g, press('accel'));
  assert.equal(g.initialsEntry.slots[0], 'A', 'Z wraps forward to A');

  // Full lap forward returns to A and never leaves the alphabet.
  for (let i = 0; i < 26; i++) {
    step(g, press('accel'));
    assert.match(g.initialsEntry.slots[0], /^[A-Z]$/);
  }
  assert.equal(g.initialsEntry.slots[0], 'A');
  assert.equal(g.initialsEntry.index, 0, 'cycling never advances the slot');
});

test('jump/fire advance the slot; the third advance submits and shows gameOver', () => {
  const storage = fakeStorage();
  _setStorage(storage);
  const g = createGame('classic', 1);
  g.phase = 'enterScore';
  g.score = 7300;
  g.initialsEntry = { slots: ['A', 'A', 'A'], index: 0 };

  // Slot 0 -> 'P'
  for (let i = 0; i < 15; i++) step(g, press('accel'));
  assert.equal(g.initialsEntry.slots[0], 'P');
  step(g, press('jump'));
  assert.equal(g.initialsEntry.index, 1, 'jump advances');
  assert.equal(g.phase, 'enterScore');

  // Slot 1 stays 'A'; fire advances just like jump.
  step(g, press('fire'));
  assert.equal(g.initialsEntry.index, 2, 'fire advances too');
  assert.equal(g.phase, 'enterScore');

  // Slot 2 -> 'T', then the third advance commits.
  for (let i = 0; i < 19; i++) step(g, press('accel'));
  assert.equal(g.initialsEntry.slots[2], 'T');
  step(g, press('jump'));

  assert.equal(g.phase, 'gameOver', 'the INITIALS_LEN-th advance submits');
  assert.equal(g.initialsEntry, null);
  assert.equal(g.lastInitials, 'PAT');
  assert.deepEqual(loadScores('classic'), [{ initials: 'PAT', score: 7300 }]);
  assert.ok(
    storage._map.has('lunar-rover-hs-classic'),
    'submitScore persisted through the injected storage stub',
  );
  assert.equal(INITIALS_LEN, 3);
});

test('enterScore ignores pause/mute/restart and self-heals a missing entry', () => {
  _setStorage(fakeStorage());
  const g = createGame('classic', 1);
  g.phase = 'enterScore';
  g.score = 900;
  g.initialsEntry = { slots: ['A', 'A', 'A'], index: 0 };

  for (const a of ['pause', 'mute', 'restart']) {
    step(g, press(a));
    assert.equal(g.phase, 'enterScore', `${a} must not leave the picker`);
    assert.deepEqual(g.initialsEntry, { slots: ['A', 'A', 'A'], index: 0 });
  }
  assert.deepEqual(loadScores('classic'), [], 'nothing submitted by a stray key');

  g.initialsEntry = null; // defensive branch
  step(g, noInput);
  assert.equal(g.phase, 'gameOver');
});

test('endless scores go to the endless table, classic to the classic one', () => {
  _setStorage(fakeStorage());
  const g = createGame('endless', 9);
  g.phase = 'enterScore';
  g.score = 2500;
  g.initialsEntry = { slots: ['E', 'N', 'D'], index: 0 };
  step(g, press('fire'));
  step(g, press('fire'));
  step(g, press('fire'));

  assert.equal(g.phase, 'gameOver');
  assert.deepEqual(loadScores('endless'), [{ initials: 'END', score: 2500 }]);
  assert.deepEqual(loadScores('classic'), [], 'modes keep separate tables');
});

test('endless mode generates terrain ahead of the buggy', () => {
  const g = createGame('endless', 42);
  assert.equal(g.terrain.mode, 'endless');
  assert.ok(g.terrain.generatedTo >= CHECKPOINT_SPACING);
  g.phase = 'playing';
  step(g, noInput, 60);
  assert.ok(g.terrain.generatedTo > g.buggy.worldX);
});
