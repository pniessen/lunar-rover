import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, updateGame, buggyScreenX, DT, DYING_TIME, RESPAWN_TIME,
} from '../js/state.js';
import { SPEED_BANDS } from '../js/buggy.js';
import { checkpointX, CHECKPOINT_SPACING } from '../js/terrain.js';

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
  assert.deepEqual(g.combo, { count: 0, mult: 1, timer: 0 });
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

test('attract wakes on any of the seven actions', () => {
  for (const a of ['accel', 'brake', 'jump', 'fire', 'pause', 'mute', 'restart']) {
    const g = createGame('classic', 1);
    step(g, press(a));
    assert.equal(g.phase, 'playing', `${a} should start the game`);
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

test('endless mode generates terrain ahead of the buggy', () => {
  const g = createGame('endless', 42);
  assert.equal(g.terrain.mode, 'endless');
  assert.ok(g.terrain.generatedTo >= CHECKPOINT_SPACING);
  g.phase = 'playing';
  step(g, noInput, 60);
  assert.ok(g.terrain.generatedTo > g.buggy.worldX);
});
