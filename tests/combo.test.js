import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCombo, comboAction, updateCombo, resetCombo, syncComboCursors, notifyGameEventsCleared,
} from '../js/combo.js';
import { createGame, updateGame, DT } from '../js/state.js';
import { award } from '../js/score.js';

const noInput = { pressed: () => false };
const step = (game, input = noInput, frames = 1) => {
  for (let i = 0; i < frames; i++) updateGame(game, input, DT);
};
const stepUntilPhaseChanges = (game, input = noInput, maxFrames = 20000) => {
  const from = game.phase;
  let n = 0;
  while (game.phase === from && n < maxFrames) { step(game, input); n++; }
  return n;
};
// buggy midpoint (worldX+16) starts inside a crater at worldX=0 -> dies on the first step.
const craterAt0 = { mode: 'test', features: [{ id: 1, type: 'crater', x: 0, w: 24, hp: 0, destroyed: false }] };

// combo.js is pure logic — comboAction/updateCombo only need `game.combo`
// and `game.events`/`game.scoreEvents` to exist, so a real createGame()
// gives every test a realistic, fully-shaped game object for free.

// --- createCombo() -------------------------------------------------------

test('createCombo returns the documented fresh shape', () => {
  assert.deepEqual(createCombo(), {
    count: 0, mult: 1, timer: 0, lastSeenScoreEventCount: 0, lastSeenGameEventCount: 0,
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

// --- regression: Finding 1 (game.events over-counted on multi-tick frames) --
//
// main.js runs updateGame (and therefore updateCombo) in a fixed-timestep
// while-loop that can iterate several times for one rendered frame after a
// lag spike, but only clears game.events once per RENDER, after the loop.
// A naive `.includes('chaserDodge')` check would recount the same pushed
// event on every one of those extra updateCombo calls.

test('one chaserDodge event is counted once even across several updateCombo calls before the next clear', () => {
  const g = createGame('classic', 1);
  g.events.push('chaserDodge'); // pushed once, e.g. by tick 1 of a catch-up loop

  updateCombo(g, DT); // tick 1
  updateCombo(g, DT); // tick 2 — same still-uncleared game.events array
  updateCombo(g, DT); // tick 3

  assert.equal(g.combo.count, 1, 'the same event must not be recounted on later ticks in the same window');
});

test('an event pushed after main.js clears+notifies is still detected, even when the refill reaches the pre-clear cursor', () => {
  const g = createGame('classic', 1);
  g.events.push('chaserDodge');
  updateCombo(g, DT);
  assert.equal(g.combo.count, 1);
  assert.equal(g.combo.lastSeenGameEventCount, 1);

  // main.js clears game.events in place (`.length = 0`, never reassigned)
  // once per rendered frame, then immediately calls notifyGameEventsCleared
  // — synchronously, before anything else can push to the array. Refilling
  // to exactly the pre-clear length (1) is deliberate here: a plain length
  // comparison inside updateCombo ("did it shrink?") cannot detect this
  // case since, by the time updateCombo looks again, the length is back to
  // where it was — only the explicit notify call closes that gap.
  g.events.length = 0;
  notifyGameEventsCleared(g);
  g.events.push('craterNearMiss');
  updateCombo(g, DT);

  assert.equal(g.combo.count, 2, 'the post-clear event must still be counted despite the length matching the pre-clear cursor');
});

test('without notifyGameEventsCleared, a plain shrink still self-corrects via the defensive fallback', () => {
  const g = createGame('classic', 1);
  g.events.push('chaserDodge');
  g.events.push('checkpoint'); // unrelated event, still advances the cursor
  updateCombo(g, DT);
  assert.equal(g.combo.lastSeenGameEventCount, 2);

  // A shrink with no notify call — updateCombo's own defensive fallback
  // (length < cursor) must still catch this simpler case on its own.
  g.events.length = 0;
  g.events.push('craterNearMiss');
  updateCombo(g, DT);

  assert.equal(g.combo.count, 2, 'chaserDodge + craterNearMiss both counted; the shrink alone was enough to self-correct');
});

// --- regression: Finding 2 (posthumous combo credit across a death) ---------
//
// Kills/near-misses logged while the combo is frozen (dying + respawning)
// must be discarded, not replayed as combo actions once 'playing' resumes.

test('scoreEvents/events logged during the dying+respawning window are discarded once playing resumes', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = craterAt0;

  step(g); // crashes into the crater this frame
  assert.equal(g.phase, 'dying');
  assert.equal(g.combo.count, 0, 'resetCombo already zeroed the combo on death');

  // Simulate award-generating activity during the frozen window: an
  // in-flight shot scoring a kill while the buggy explodes/respawns.
  award(g, 100, 'kill');
  g.events.push('chaserDodge');

  stepUntilPhaseChanges(g); // dying -> respawning
  stepUntilPhaseChanges(g); // respawning -> playing (syncComboCursors runs here)
  assert.equal(g.phase, 'playing');

  updateCombo(g, DT); // the first real 'playing'-branch updateCombo call after respawn

  assert.equal(g.combo.count, 0, 'window activity must not be replayed as combo actions post-respawn');
});

test('syncComboCursors alone fast-forwards both cursors to the current array lengths', () => {
  const g = createGame('classic', 1);
  award(g, 100, 'kill');
  g.events.push('chaserDodge');
  assert.equal(g.combo.lastSeenScoreEventCount, 0);
  assert.equal(g.combo.lastSeenGameEventCount, 0);

  syncComboCursors(g);

  assert.equal(g.combo.lastSeenScoreEventCount, g.scoreEvents.length);
  assert.equal(g.combo.lastSeenGameEventCount, g.events.length);

  updateCombo(g, DT);
  assert.equal(g.combo.count, 0, 'nothing left to consume after the sync');
});

test('stageClear -> playing also discards the intermission window via syncComboCursors', () => {
  const g = createGame('classic', 1);
  g.phase = 'stageClear';
  g.stageClear = { total: 100, paid: 100, isCourseEnd: false };
  g.phaseTimer = 999; // past STAGE_CLEAR_TIME so the very next step finishes it
  // Something (hypothetically) logged during the intermission that must not count.
  award(g, 100, 'kill');
  g.events.push('chaserDodge');

  step(g); // stageClear -> playing (finishStageClear calls syncComboCursors)
  assert.equal(g.phase, 'playing');

  updateCombo(g, DT);
  assert.equal(g.combo.count, 0, 'intermission-window activity must not count post-transition');
});
