import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCombo, comboAction, updateCombo, resetCombo,
} from '../js/combo.js';
import { createGame, DT } from '../js/state.js';
import { award } from '../js/score.js';

// combo.js is pure logic — comboAction/updateCombo only need `game.combo`
// and `game.events`/`game.scoreEvents` to exist, so a real createGame()
// gives every test a realistic, fully-shaped game object for free.

// --- createCombo() -------------------------------------------------------

test('createCombo returns the documented fresh shape', () => {
  assert.deepEqual(createCombo(), {
    count: 0, mult: 1, timer: 0, lastSeenScoreEventCount: 0,
  });
});

// --- comboAction() / thresholds -------------------------------------------

test('comboAction raises mult at the documented count thresholds', () => {
  const g = createGame('classic', 1);

  for (let i = 0; i < 2; i++) comboAction(g);
  assert.equal(g.combo.mult, 1, 'still x1 before the count=3 threshold');

  comboAction(g); // count=3
  assert.equal(g.combo.count, 3);
  assert.equal(g.combo.mult, 2);
  assert.ok(g.events.includes('comboUp'), 'comboUp emitted on the mult increase');

  for (let i = 0; i < 3; i++) comboAction(g); // count=6
  assert.equal(g.combo.mult, 3);

  for (let i = 0; i < 4; i++) comboAction(g); // count=10
  assert.equal(g.combo.mult, 4);

  for (let i = 0; i < 5; i++) comboAction(g); // count=15
  assert.equal(g.combo.count, 15);
  assert.equal(g.combo.mult, 5);
});

test('comboAction only emits comboUp when mult actually increases', () => {
  const g = createGame('classic', 1);
  comboAction(g); // count=1, mult stays 1 — no comboUp
  assert.equal(g.combo.mult, 1);
  assert.ok(!g.events.includes('comboUp'));

  comboAction(g); // count=2, mult stays 1 — no comboUp
  assert.ok(!g.events.includes('comboUp'));

  comboAction(g); // count=3, mult -> 2 — one comboUp
  assert.equal(g.events.filter((e) => e === 'comboUp').length, 1);
});

test('comboAction refreshes the 4s timer on every call', () => {
  const g = createGame('classic', 1);
  comboAction(g);
  assert.equal(g.combo.timer, 4.0);
  g.combo.timer = 1.5;
  comboAction(g);
  assert.equal(g.combo.timer, 4.0, 'timer resets to 4s on any new action');
});

// --- updateCombo() timer expiry -------------------------------------------

test('updateCombo resets count/mult and emits comboLost after 4s with no new actions', () => {
  const g = createGame('classic', 1);
  for (let i = 0; i < 3; i++) comboAction(g); // count=3, mult=2
  assert.equal(g.combo.mult, 2);
  g.events = []; // clear the comboUp events from setup so we can check comboLost cleanly

  let n = 0;
  while (g.combo.mult > 1 && n < 500) { updateCombo(g, DT); n++; }

  assert.equal(g.combo.count, 0);
  assert.equal(g.combo.mult, 1);
  assert.equal(g.combo.timer, 0);
  assert.ok(g.events.includes('comboLost'), 'comboLost emitted when a boosted combo times out');
  assert.ok(Math.abs(n * DT - 4.0) < 0.02, 'expiry takes ~4s of updateCombo calls');
});

test('updateCombo does not emit comboLost when the combo times out already at x1', () => {
  const g = createGame('classic', 1);
  // Never call comboAction — combo starts idle at x1/count 0/timer 0.
  updateCombo(g, DT);
  assert.equal(g.combo.mult, 1);
  assert.ok(!g.events.includes('comboLost'), 'no comboLost for an already-idle combo');
});

// --- resetCombo() ----------------------------------------------------------

test('resetCombo zeroes count/mult/timer without emitting any event', () => {
  const g = createGame('classic', 1);
  for (let i = 0; i < 8; i++) comboAction(g); // count=8, mult=3
  assert.equal(g.combo.mult, 3);
  g.events = [];

  resetCombo(g);

  assert.equal(g.combo.count, 0);
  assert.equal(g.combo.mult, 1);
  assert.equal(g.combo.timer, 0);
  assert.deepEqual(g.events, [], 'resetCombo must not push any event, including comboLost');
});

// --- integration with score.js's award() -----------------------------------

test('award() multiplies by the mult comboAction built up', () => {
  const g = createGame('classic', 1);
  for (let i = 0; i < 8; i++) comboAction(g); // count=8 -> mult 3
  assert.equal(g.combo.mult, 3);

  award(g, 100, 'x');

  const ev = g.scoreEvents.at(-1);
  assert.equal(ev.base, 100);
  assert.equal(ev.pts, 300);
});

// --- ordering: this frame's actions must not inflate this frame's awards ---

test('updateCombo runs after awards, so a comboUp it triggers never multiplies the very awards that caused it', () => {
  const g = createGame('classic', 1);
  assert.equal(g.combo.mult, 1);

  // Simulate 3 kills scored in a single frame, all at the mult held coming
  // into the frame (x1) — exactly what state.js's playing-branch award
  // calls do before updateCombo runs at the end of the frame.
  award(g, 100, 'kill');
  award(g, 100, 'kill');
  award(g, 100, 'kill');
  for (const ev of g.scoreEvents) assert.equal(ev.pts, 100, 'all three awards scored at x1');

  updateCombo(g, DT); // processes the 3 new scoreEvents as combo actions

  assert.equal(g.combo.count, 3);
  assert.equal(g.combo.mult, 2, 'the 3rd kill raised the combo to x2');
  // The awards already recorded above are untouched — still x1.
  for (const ev of g.scoreEvents) assert.equal(ev.pts, 100);
});

// --- stageBonus tag excluded ------------------------------------------------

test('stageBonus-tagged scoreEvents do not count toward the combo', () => {
  const g = createGame('classic', 1);
  award(g, 100, 'stageBonus');
  award(g, 100, 'stageBonus');
  award(g, 100, 'stageBonus');

  updateCombo(g, DT);

  assert.equal(g.combo.count, 0);
  assert.equal(g.combo.mult, 1);
});

// --- near-miss events (chaserDodge / craterNearMiss) ------------------------

test('a chaserDodge event this frame counts as a combo action', () => {
  const g = createGame('classic', 1);
  g.events.push('chaserDodge');

  updateCombo(g, DT);

  assert.equal(g.combo.count, 1);
});

test('a craterNearMiss event this frame counts as a combo action', () => {
  const g = createGame('classic', 1);
  g.events.push('craterNearMiss');

  updateCombo(g, DT);

  assert.equal(g.combo.count, 1);
});

test('scoreEvents already seen before are not double-counted on the next updateCombo call', () => {
  const g = createGame('classic', 1);
  award(g, 100, 'kill');
  updateCombo(g, DT); // consumes the 1 new event
  assert.equal(g.combo.count, 1);

  updateCombo(g, DT); // no new scoreEvents/events this call
  assert.equal(g.combo.count, 1, 'no new actions this frame — count unchanged');
});
