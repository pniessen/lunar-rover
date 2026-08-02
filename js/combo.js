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
    // Same idea for game.events, EXCEPT that array *is* cleared in place
    // (length = 0) once per rendered frame by main.js (after render/audio
    // consume it) — see notifyGameEventsCleared below for how this cursor
    // stays valid across that clear.
    lastSeenGameEventCount: 0,
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
 * Detects actions two ways, both cursor-based (never re-scanning an entry
 * already consumed) so that main.js's fixed-timestep catch-up loop — which
 * can call updateGame (and this) several times for one rendered frame after
 * a lag spike — counts each entry exactly once no matter how many times
 * updateCombo runs before the next render:
 *  - every new game.scoreEvents entry since lastSeenScoreEventCount, except
 *    tag 'stageBonus' (the stageClear tally's ticks are not player skill).
 *    scoreEvents is never cleared/truncated, so this cursor only ever moves
 *    forward.
 *  - every new game.events entry since lastSeenGameEventCount whose name is
 *    'chaserDodge' (enemies.js) or 'craterNearMiss' (state.js' jump landing
 *    handler — internal-only, no audio handler needed since audio.js
 *    ignores unknown event names). Unlike scoreEvents, game.events *is*
 *    cleared in place (`.length = 0`) once per rendered frame by main.js
 *    (after render/audio have consumed it) — main.js calls
 *    notifyGameEventsCleared() in the same breath, which is what keeps this
 *    cursor valid across that clear (see its docstring for why a plain
 *    length comparison here can't reliably substitute for that call).
 *
 * Finally ticks the timer down by dt; when it reaches zero the combo
 * resets (count/mult back to 0/1), emitting 'comboLost' only if mult had
 * actually been raised above 1 — letting an idle x1 combo time out silently.
 */
export function updateCombo(game, dt) {
  const combo = game.combo;

  const scoreEvents = game.scoreEvents ?? [];
  for (let i = combo.lastSeenScoreEventCount; i < scoreEvents.length; i++) {
    if (scoreEvents[i].tag !== 'stageBonus') comboAction(game);
  }
  combo.lastSeenScoreEventCount = scoreEvents.length;

  const events = game.events ?? [];
  // Cheap defensive fallback for a plain shrink (e.g. something clears
  // game.events directly without going through notifyGameEventsCleared) —
  // NOT sufficient on its own for the real main.js clear point; see that
  // function's docstring for the gap this doesn't cover.
  if (events.length < combo.lastSeenGameEventCount) combo.lastSeenGameEventCount = 0;
  for (let i = combo.lastSeenGameEventCount; i < events.length; i++) {
    if (events[i] === 'chaserDodge' || events[i] === 'craterNearMiss') comboAction(game);
  }
  combo.lastSeenGameEventCount = events.length;

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
 * cue — comboLost is reserved for a live timeout). Does NOT touch either
 * cursor — see syncComboCursors below for why that alone wouldn't be
 * enough, and where the actual cursor fast-forward happens.
 */
export function resetCombo(game) {
  const combo = game.combo;
  combo.count = 0;
  combo.mult = 1;
  combo.timer = 0;
}

/**
 * Fast-forwards both cursors to the current game.scoreEvents/game.events
 * lengths, discarding (not counting) anything logged since the last time
 * they were consumed. This is the single mechanism that keeps "death is a
 * clean slate" true end-to-end: updateCombo only ever runs while
 * game.phase === 'playing', but weapons/enemies keep scoring and eventing
 * through the *entire* frozen window a death opens up — 'dying' (shots
 * already in flight still fly and can still kill something) and
 * 'respawning' (invulnerable but drivable, so a jump can land and clear a
 * crater mid-blink-in) — not just the single instant killBuggy() fires. A
 * cursor fast-forward at death alone (the previous, insufficient fix) still
 * leaves that whole window's worth of scoreEvents/events unconsumed, which
 * would otherwise get replayed as a lump of posthumous combo actions the
 * instant 'playing' resumes.
 *
 * Call this exactly once, at the point a frozen-combo phase transitions
 * back into 'playing': state.js does so at respawning->playing (covers the
 * dying+respawning window) and stageClear->playing (belt-and-suspenders —
 * stageClear's own tally is already tag-excluded and nothing else can score
 * during it, but this keeps the invariant "every non-'playing' phase is a
 * clean slate on the way back in" true uniformly, including for 'boss' once
 * a later task wires that phase up the same way).
 */
export function syncComboCursors(game) {
  const combo = game.combo;
  combo.lastSeenScoreEventCount = (game.scoreEvents ?? []).length;
  combo.lastSeenGameEventCount = (game.events ?? []).length;
}

/**
 * Call this from main.js in the same breath as `game.events.length = 0`
 * (immediately after, same synchronous tick — nothing can push to
 * game.events in between, since JS is single-threaded and the next push
 * only happens from inside a later updateGame() call). Resets
 * lastSeenGameEventCount to 0 so updateCombo's cursor is never stale
 * relative to the just-cleared array.
 *
 * This has to be an explicit notification from the clearer, not something
 * updateCombo can reliably infer after the fact from array length alone:
 * length only *strictly decreasing* proves a clear happened, but a clear
 * immediately followed by enough new pushes to reach or exceed the old
 * cursor value — entirely possible, since main.js's fixed-timestep loop
 * can push several game.events entries in the very first tick after a
 * clear — would make the array's length look like it only grew, hiding
 * the dip to zero in between. Only the owner of the clear knows for
 * certain when it happened.
 */
export function notifyGameEventsCleared(game) {
  game.combo.lastSeenGameEventCount = 0;
}
