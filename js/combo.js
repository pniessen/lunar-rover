// combo.js — pure logic for the x1-x5 combo multiplier. No DOM/canvas/audio
// imports, so it runs under `node --test`. score.js reads game.combo.mult;
// state.js drives comboAction/updateCombo/resetCombo.

const COMBO_TIMER = 4.0; // seconds a combo survives with no new action

// [count threshold, multiplier], checked highest-first.
const THRESHOLDS = [
  [15, 5],
  [10, 4],
  [6, 3],
  [3, 2],
];

function multFor(count) {
  for (const [min, mult] of THRESHOLDS) {
    if (count >= min) return mult;
  }
  return 1;
}

export function createCombo() {
  return {
    count: 0, mult: 1, timer: 0,
    // How many of game.scoreEvents updateCombo has already consumed. Not a
    // pointer into a per-frame buffer: scoreEvents accumulates for the
    // whole run (nothing clears it — award() callers and tests both rely on
    // it as a full log), so this is the non-destructive way to find "what's
    // new since last frame" without disturbing that log.
    lastSeenScoreEventCount: 0,
  };
}

/**
 * One combo-raising action: a scored kill/jump-over, a chaser dodge, or a
 * crater near-miss. Bumps count, refreshes the 4s timer, and recomputes
 * mult — pushing 'comboUp' to game.events only when mult actually
 * increases (not on every action once a threshold is already held).
 */
export function comboAction(game) {
  const combo = game.combo;
  combo.count += 1;
  combo.timer = COMBO_TIMER;
  const newMult = multFor(combo.count);
  if (newMult > combo.mult) {
    combo.mult = newMult;
    game.events.push('comboUp');
  }
}

/**
 * Per-frame combo update. Call this at the END of the 'playing' branch,
 * after every award-generating system has already run this frame — awards
 * made this frame were multiplied by the mult held *coming into* the
 * frame, so any comboAction triggered here only raises the multiplier for
 * the *next* frame's awards. This sidesteps order ambiguity: a kill can
 * never be inflated by the very combo increment it causes.
 *
 * Detects actions three ways:
 *  - every new game.scoreEvents entry since lastSeenScoreEventCount, except
 *    tag 'stageBonus' (the stageClear tally's ticks are not player skill —
 *    they'd otherwise farm infinite combo during the intermission, which
 *    doesn't even tick this function anyway since state.js only calls it
 *    from the 'playing' branch, but the exclusion also matters if a
 *    stageBonus-tagged award is ever issued while still 'playing').
 *  - a 'chaserDodge' event pushed elsewhere this frame (enemies.js).
 *  - a 'craterNearMiss' event pushed elsewhere this frame (state.js' jump
 *    landing handler) — an internal-only signal with no audio handler;
 *    audio.js ignores unknown event names, so this is safe to push.
 *
 * Finally ticks the timer down by dt; when it reaches zero the combo
 * resets (count/mult back to 0/1), emitting 'comboLost' only if mult had
 * actually been raised above 1 — letting an idle x1 combo time out silently.
 */
export function updateCombo(game, dt) {
  const combo = game.combo;
  const events = game.scoreEvents ?? [];
  for (let i = combo.lastSeenScoreEventCount; i < events.length; i++) {
    if (events[i].tag !== 'stageBonus') comboAction(game);
  }
  combo.lastSeenScoreEventCount = events.length;

  if (game.events.includes('chaserDodge')) comboAction(game);
  if (game.events.includes('craterNearMiss')) comboAction(game);

  combo.timer -= dt;
  if (combo.timer <= 0) {
    const wasBoosted = combo.mult > 1;
    combo.count = 0;
    combo.mult = 1;
    combo.timer = 0;
    if (wasBoosted) game.events.push('comboLost');
  }
}

/**
 * Death reset: zero count/mult/timer with no event (a death is not a "loss"
 * cue — comboLost is reserved for a live timeout). Also fast-forwards
 * lastSeenScoreEventCount to the current scoreEvents length so that any
 * awards scored while the phase isn't 'playing' (updateCombo doesn't run
 * outside 'playing', so it never got to consume them) don't get replayed
 * as a posthumous combo build-up once play resumes — a death is a clean
 * slate.
 */
export function resetCombo(game) {
  const combo = game.combo;
  combo.count = 0;
  combo.mult = 1;
  combo.timer = 0;
  combo.lastSeenScoreEventCount = (game.scoreEvents ?? []).length;
}
