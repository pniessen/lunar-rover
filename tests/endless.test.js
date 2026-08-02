// endless.test.js — Task 13: endless mode rules (terrain lookahead, the
// speed ramp, timed bosses, boundary respawn, no classic stage-breaks) and
// the attract-screen mode-select menu.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, updateGame, DT, VIEW_W } from '../js/state.js';
import { SPEED_BANDS } from '../js/buggy.js';
import { CHECKPOINT_SPACING, checkpointX, STAGE_BREAKS } from '../js/terrain.js';

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

const stepUntilPhaseChanges = (game, input = noInput, maxFrames = 600) => {
  const from = game.phase;
  let n = 0;
  while (game.phase === from && n < maxFrames) { step(game, input); n++; }
  return n;
};

// A terrain double: buggy.js/enemies.js treat mode:'test' as "consider
// every listed feature", regardless of worldX range — same convention as
// state.test.js/boss.test.js's craterAt/empty-terrain doubles.
const craterAt = (x, w = 24) => ({
  mode: 'test',
  features: [{ id: 1, type: 'crater', x, w, hp: 0, destroyed: false }],
});

// --- terrain lookahead -----------------------------------------------------

test('endless generates terrain at least 2*VIEW_W ahead of camX as the buggy drives', () => {
  const g = createGame('endless', 1);
  g.phase = 'playing';
  step(g, press('accel'), 5); // reach top speed quickly
  step(g, noInput, 300);
  assert.ok(g.buggy.worldX > 0, 'sanity: the buggy actually moved');
  assert.ok(
    g.terrain.generatedTo >= g.camX + 2 * VIEW_W,
    `generatedTo(${g.terrain.generatedTo}) must be >= camX(${g.camX}) + 2*VIEW_W(${2 * VIEW_W})`,
  );
});

// --- speed ramp --------------------------------------------------------------

test('endless speed bonus ramps +4px/s every 30s, caps at +60, and the buggy band target reflects it', () => {
  const g = createGame('endless', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };

  g.elapsedTotal = 59; // just under two 30s ticks
  step(g);
  assert.equal(g.speedBonus, 4, 'one 30s tick has elapsed');

  g.elapsedTotal = 100000; // far past the cap
  step(g);
  assert.equal(g.speedBonus, 60, 'speed bonus caps at +60');

  // Band stays at its default (1); let the eased game.speed catch up to
  // the bonused target (ACCEL=60px/s^2, diff=60px/s -> ~1s to close).
  step(g, noInput, 200);
  const target = SPEED_BANDS[g.buggy.band] + 60;
  assert.ok(Math.abs(g.speed - target) < 1, `game.speed(${g.speed}) should ease toward ${target}`);
});

test('classic never accrues elapsedTotal/speedBonus', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  step(g, press('accel'), 5);
  step(g, noInput, 300);
  assert.equal(g.elapsedTotal, 0);
  assert.equal(g.speedBonus, 0);
});

// --- timed bosses --------------------------------------------------------------

test('endless boss triggers once elapsedTotal reaches nextBossAt (90s), and nextBossAt advances to 180', () => {
  const g = createGame('endless', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  assert.equal(g.nextBossAt, 90);

  g.elapsedTotal = 80;
  step(g);
  assert.equal(g.phase, 'playing', 'not yet at 90s');

  g.elapsedTotal = 89.99;
  step(g); // this frame's dt pushes elapsedTotal just past 90
  assert.equal(g.phase, 'boss');
  assert.ok(g.boss, 'a boss was actually started');
  assert.equal(g.nextBossAt, 180, 'nextBossAt advances by 90 the instant the boss triggers');
});

// Regression: the boss-timer check runs in updateGame's 'playing' case
// *after* updateDrive() — if a terrain hit inside that same updateDrive()
// call already moved the phase to 'dying' this frame, an ungated boss
// check would stomp that transition (setPhase back to 'boss'), clobbering
// the death and its life deduction.
test('a same-frame terrain death takes priority over an elapsed-time boss trigger', () => {
  const g = createGame('endless', 1);
  g.phase = 'playing';
  g.terrain = craterAt(0, 400); // buggy (worldX 0) starts inside it -> dies this frame
  g.elapsedTotal = 89.99; // this frame's dt also crosses the 90s boss threshold
  const livesBefore = g.lives;

  step(g);

  assert.equal(g.phase, 'dying', 'the terrain death wins, not the boss trigger');
  assert.equal(g.lives, livesBefore - 1);
  assert.equal(g.boss, undefined, 'no boss was started this frame');
  assert.equal(g.nextBossAt, 90, 'the boss trigger did not fire, so nextBossAt is untouched');
});

test('endless boss difficulty scales off elapsed time (stage = min(4, floor(elapsed/90)))', () => {
  const g = createGame('endless', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  g.elapsedTotal = 179.99; // about to cross the *second* boss threshold (180)
  g.nextBossAt = 180;

  step(g);
  assert.equal(g.phase, 'boss');
  assert.equal(g.stage, 2, 'floor(180/90) = 2');
  assert.equal(g.boss.maxHp, 18 + 2 * 6);
});

// Regression (review fix round 1): finishStageClear's non-course-end branch
// used to do an unconditional `game.stage += 1` regardless of mode. In
// classic that's right (stage tracks segment tier), but endless has no
// "next segment" — each boss cycle's enterEndlessBoss already *recomputes*
// stage fresh from elapsedTotal (min(4, floor(elapsedTotal/90))), so an
// unconditional bump on top of that drifts stage past 4 during the
// *between-bosses* 'playing' window (it gets silently overwritten back to
// the correct value the next time a boss triggers, which is why the
// bug only shows up between fights, not at trigger time — see the
// per-cycle assertions below). An unbounded stage pushes the difficulty
// step past the cap the endless curve is meant to settle on. (It used to
// wreck the visuals too, back when render.js indexed per-stage palettes by
// `stage`; the background now runs off its own unclamped section counter.)
test('endless game.stage stays capped at 4 across many boss cycles', () => {
  const g = createGame('endless', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };

  for (let cycle = 0; cycle < 6; cycle++) {
    // Force this cycle's boss to trigger right now (direct state
    // manipulation, same technique the other endless boss tests use).
    g.elapsedTotal = g.nextBossAt - DT / 2;
    step(g);
    assert.equal(g.phase, 'boss', `cycle ${cycle}: boss should trigger`);
    assert.ok(g.stage <= 4, `cycle ${cycle}: stage(${g.stage}) must stay <=4 entering the fight`);

    // One-shot kill: line up a lethal player shot on the boss box so it
    // lands *inside* this same updateGame() call — mirrors boss.test.js's
    // state.js integration tests (a direct hitBoss() call from outside
    // updateGame wouldn't be noticed by the 'boss' case's bossWasAlive/
    // after-null detection that drives the boss -> stageClear transition).
    g.boss.hp = 1;
    g.playerShots = [{ x: g.boss.x + 10, y: g.boss.y + 5, vx: 300, vy: 0, dir: 'fwd' }];
    step(g);
    assert.equal(g.phase, 'stageClear', `cycle ${cycle}: the boss kill should enter stageClear`);

    stepUntilPhaseChanges(g, noInput, 20000);
    assert.equal(g.phase, 'playing', `cycle ${cycle}: stageClear should finish back to playing`);
    assert.ok(g.stage <= 4, `cycle ${cycle}: stage(${g.stage}) must stay <=4 after finishStageClear`);
  }

  assert.ok(g.elapsedTotal > 540, 'sanity: the loop ran past the 6th 90s boss threshold');
});

// --- boundary respawn --------------------------------------------------------

test('endless respawn lands on the 1200px boundary at or behind the death worldX', () => {
  const g = createGame('endless', 1);
  g.phase = 'playing';
  // A crater wide enough that wherever the buggy's worldX lands this frame
  // (it advances by speed*dt before the collision check runs, so it won't
  // be exactly 5000), it's still inside the crater and dies right here —
  // pinning the death worldX to a known, not-a-1200-multiple range.
  g.terrain = craterAt(5000, 100);
  g.buggy.worldX = 5000;

  step(g);
  assert.equal(g.phase, 'dying');
  const deathX = g.buggy.worldX; // frozen from here — updateBuggy no-ops while dead
  assert.ok(deathX >= 5000 && deathX < 5100, `sanity: death worldX(${deathX}) inside the crater`);

  stepUntilPhaseChanges(g);
  assert.equal(g.phase, 'respawning');

  const expected = Math.floor(deathX / CHECKPOINT_SPACING) * CHECKPOINT_SPACING;
  assert.equal(expected, 4800);
  assert.equal(g.buggy.worldX, expected);
  assert.ok(g.buggy.worldX <= deathX);
  assert.equal(g.buggy.alive, true);
});

// --- no classic checkpoints/stage-breaks --------------------------------------

test('endless never enters stageClear/boss from crossing a classic-style stage-break worldX', () => {
  const g = createGame('endless', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  const breakX = checkpointX(STAGE_BREAKS[0]); // classic's break E — no meaning in endless
  g.buggy.worldX = breakX - 50;

  step(g, noInput, 200); // drives across breakX; far short of the 90s boss timer
  assert.equal(g.phase, 'playing');
  assert.ok(g.buggy.worldX > breakX, 'sanity: the buggy actually crossed the line');
});

// --- attract-screen mode-select menu ------------------------------------------

test('attract: accel/brake toggle menuIndex; jump/fire start the highlighted mode', () => {
  const g = createGame('classic', 5);
  assert.equal(g.menuIndex, 0, 'defaults to CLASSIC');

  step(g, press('accel'));
  assert.equal(g.menuIndex, 1, 'toggles to ENDLESS');
  assert.equal(g.phase, 'attract', 'toggling does not start a run');

  step(g, press('brake'));
  assert.equal(g.menuIndex, 0, 'toggles back to CLASSIC');

  step(g, press('accel')); // select ENDLESS
  assert.equal(g.menuIndex, 1);
  step(g, press('fire'));
  assert.equal(g.phase, 'playing');
  assert.equal(g.mode, 'endless', 'fire started the highlighted mode');
});

test('attract: jump also starts the highlighted mode (classic, default selection)', () => {
  const g = createGame('classic', 9);
  step(g, press('jump'));
  assert.equal(g.phase, 'playing');
  assert.equal(g.mode, 'classic');
});

test('starting a run from the attract menu uses the passed-in seed when given', () => {
  const g = createGame('classic', 1);
  step(g, press('accel')); // -> ENDLESS
  updateGame(g, press('fire'), DT, 4242);
  assert.equal(g.phase, 'playing');
  assert.equal(g.mode, 'endless');
  assert.equal(g.rngSeed, 4242, 'the caller-supplied seed wins over game.rngSeed');
});
