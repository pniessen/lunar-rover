import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPES, DURATIONS, spawnCapsule, updatePowerups, applyPowerup,
} from '../js/powerups.js';
import { createGame, GROUND_Y } from '../js/state.js';
import { hitEnemy } from '../js/enemies.js';
import { updateBuggy, GRAVITY } from '../js/buggy.js';

const DT = 1 / 60;

const game = () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  return g;
};

const noInput = {
  state: {
    accel: false, brake: false, jump: false, fire: false, pause: false, mute: false, restart: false,
  },
  pressed: () => false,
  endFrame() {},
};
const press = (...names) => ({
  state: {
    accel: false, brake: false, jump: false, fire: false, pause: false, mute: false, restart: false,
  },
  pressed: (n) => names.includes(n),
  endFrame() {},
});

test('module exports the documented constants', () => {
  assert.deepEqual(TYPES, ['shield', 'rapid', 'spread', 'hover']);
  assert.deepEqual(DURATIONS, {
    shield: Infinity, rapid: 10, spread: 10, hover: 15,
  });
});

test('capsule collected on x-overlap applies power-up, replaces existing, emits powerup', () => {
  const g = game();
  g.powerup = { type: 'shield', remaining: Infinity };
  g.buggy.worldX = 100;
  g.buggy.airborne = false;
  spawnCapsule(g, 100, GROUND_Y - 10, 'rapid');
  g.capsules[0].grounded = true; // grounded buggy collects on x-overlap alone
  updatePowerups(g, DT);
  assert.equal(g.powerup.type, 'rapid');
  assert.equal(g.powerup.remaining, DURATIONS.rapid);
  assert.equal(g.capsules.length, 0);
  assert.ok(g.events.includes('powerup'));
});

test('rapid expires after 10s of playing updates -> null + powerupEnd', () => {
  const g = game();
  applyPowerup(g, 'rapid');
  assert.equal(g.powerup.type, 'rapid');
  const frames = Math.ceil(DURATIONS.rapid / DT) + 2;
  for (let i = 0; i < frames; i++) updatePowerups(g, DT);
  assert.equal(g.powerup, null);
  assert.ok(g.events.includes('powerupEnd'));
});

test('shield persists (Infinity) through long updates until consumed', () => {
  const g = game();
  applyPowerup(g, 'shield');
  for (let i = 0; i < 100000; i++) updatePowerups(g, DT);
  assert.equal(g.powerup.type, 'shield');
  assert.equal(g.powerup.remaining, Infinity);
});

test('hover grants exactly one mid-air boost per jump; resets on landing', () => {
  const g = game();
  applyPowerup(g, 'hover');
  updateBuggy(g, press('jump'), DT); // ground jump
  assert.ok(g.buggy.airborne);

  // Let it fly past the apex (vy turns positive, i.e. falling) before
  // hovering — hover is meant to arrest a fall, not override the launch.
  let guard = 0;
  while (g.buggy.vy <= 0 && guard < 200) { updateBuggy(g, noInput, DT); guard++; }
  assert.ok(g.buggy.airborne, 'should still be airborne past the apex');
  const vyBeforeHover = g.buggy.vy;

  updateBuggy(g, press('jump'), DT); // hover boost
  assert.equal(g.buggy.hoverUsed, true);
  assert.ok(g.events.includes('jump'));
  assert.ok(g.buggy.vy < vyBeforeHover, 'hover impulse should cut the fall, pushing vy back up');
  const vyAfterHover = g.buggy.vy;

  updateBuggy(g, press('jump'), DT); // second press mid-air: no-op, gravity only
  assert.ok(Math.abs((g.buggy.vy - vyAfterHover) - GRAVITY * DT) < 1e-9);

  // Land, then confirm hover is available again for the next jump (waiting
  // out the post-landing settle window before jumping again, same as any
  // ordinary jump — see buggy.js's SETTLE_TIME).
  while (g.buggy.airborne) updateBuggy(g, noInput, DT);
  assert.equal(g.buggy.hoverUsed, false);
  while (g.buggy.settle > 0) updateBuggy(g, noInput, DT);

  updateBuggy(g, press('jump'), DT); // fresh grounded jump
  assert.ok(g.buggy.airborne);
  assert.equal(g.buggy.hoverUsed, false);
});

test('forced-rng formation wipe spawns a capsule at 0.1, not at 0.9', () => {
  const spawn = (rngVal) => {
    const g = game();
    g.waveRng = () => rngVal;
    g.enemies = [{
      id: 1, kind: 'swooper', x: 150, y: 60, vx: 0, vy: 0, hp: 1, t: 0, formationId: 'f1',
    }];
    hitEnemy(g, g.enemies[0]);
    return g;
  };
  const dropped = spawn(0.1);
  assert.equal(dropped.capsules.length, 1);
  const notDropped = spawn(0.9);
  assert.equal(notDropped.capsules.length, 0);
});

test('grounded capsule expires after 8s', () => {
  const g = game();
  spawnCapsule(g, 500, GROUND_Y - 10, 'shield'); // far from buggy, no collection
  g.buggy.worldX = 0;
  // Drift down to grounded.
  for (let i = 0; i < 60; i++) updatePowerups(g, DT);
  assert.equal(g.capsules[0].grounded, true);
  // Now let it sit grounded for 8s+.
  for (let i = 0; i < Math.ceil(8 / DT) + 2; i++) updatePowerups(g, DT);
  assert.equal(g.capsules.length, 0);
});

test('no ticking during non-playing phases', () => {
  const g = game();
  applyPowerup(g, 'rapid');
  g.phase = 'stageClear';
  const before = g.powerup.remaining;
  for (let i = 0; i < 120; i++) updatePowerups(g, DT);
  assert.equal(g.powerup.remaining, before);
});

test('spawnCapsule with no explicit type picks uniformly from TYPES via waveRng', () => {
  const g = game();
  g.waveRng = () => 0; // floor(0*4) = 0 -> TYPES[0] === 'shield'
  spawnCapsule(g, 10, 10);
  assert.equal(g.capsules[0].type, 'shield');
  assert.equal(g.capsules[0].vy, 20);
  assert.equal(g.capsules[0].grounded, false);
  assert.equal(g.capsules[0].groundedTime, 0);
});

test('airborne buggy collects a capsule only when vertically overlapping', () => {
  const g = game();
  g.buggy.worldX = 100;
  g.buggy.airborne = true;
  g.buggy.y = -30; // well above ground, buggy body far from a grounded capsule
  spawnCapsule(g, 100, GROUND_Y - 10, 'rapid');
  g.capsules[0].grounded = true;
  updatePowerups(g, DT);
  assert.equal(g.powerup, null, 'no vertical overlap, no collection');
  assert.equal(g.capsules.length, 1);
});
