// score.js — pure-logic scoring: point tables, the shared award() choke
// point, jump-over feature scoring, stage/course bonuses, and local
// high-score persistence. No DOM/canvas/audio imports: this module is
// Node-testable. localStorage is accessed only through an injectable
// `storage` reference (see _setStorage) so `node --test` never touches a
// real browser API.

import { BUGGY_W } from './buggy.js';

export const SCORES = {
  craterJump: 100,
  doubleCraterJump: 200,
  mineJump: 50,
  rockJump: 80,
  rockShot: 100,
  tankJump: 100,
  tankShot: 200,
  swooper: 100,
  aimer: 100,
  bomber: 200,
  formation: 1000,
};

export const EXTRA_LIFE_AT = [10000, 30000, 50000];
export const STAGE_PAR = 55;          // seconds; par time for a stage-clear bonus
export const STAGE_BONUS_BASE = 1000;
export const COURSE_BONUS = 5000;

/**
 * Single choke point for scoring. Called by weapons.js (rockShot),
 * enemies.js (all kills, formation wipe), and state.js (jump-over scoring
 * and the stageClear ticking tally).
 *
 * pts = base * game.combo.mult, EXCEPT for the 'stageBonus' tag: the
 * stageClear tally already computed its pre-multiplied total (via
 * stageBonus()) before ticking it out in 100-pt chunks, so multiplying
 * each tick again would double-apply the combo. Every other tag goes
 * through the normal multiplier.
 *
 * After adding points, grants exactly one extra life the first time the
 * running score crosses each EXTRA_LIFE_AT threshold (oldScore < threshold
 * <= newScore), tracked via game.extraLivesGranted so a threshold already
 * paid out never re-fires even if score dips conceptually (it never does —
 * score is monotonic — but this keeps the guarantee explicit rather than
 * relying on that invariant).
 */
export function award(game, base, tag) {
  if (!game.scoreEvents) game.scoreEvents = [];
  if (!game.extraLivesGranted) game.extraLivesGranted = [];

  const mult = tag === 'stageBonus' ? 1 : (game.combo?.mult ?? 1);
  const pts = base * mult;
  const oldScore = game.score;
  game.score += pts;
  game.scoreEvents.push({ base, pts, tag });

  for (const threshold of EXTRA_LIFE_AT) {
    if (oldScore < threshold && game.score >= threshold
        && !game.extraLivesGranted.includes(threshold)) {
      game.extraLivesGranted.push(threshold);
      game.lives += 1;
      game.events.push('extraLife');
    }
  }
}

/**
 * Stage-clear bonus: STAGE_BONUS_BASE plus 100 points per second under par
 * (STAGE_PAR seconds), floored at the base with no bonus once over par;
 * doubled on the champion course (courseId 1).
 */
export function stageBonus(elapsed, champion) {
  return (STAGE_BONUS_BASE + 100 * Math.max(0, Math.floor(STAGE_PAR - elapsed))) * (champion ? 2 : 1);
}

/**
 * Pure jump-over helper: returns every feature *fully* cleared during a
 * single jump — it must start clear of the buggy's nose (BUGGY_W past the
 * jump's takeoff point) and end clear of the landing point. A feature the
 * buggy merely clipped at takeoff or landing (partial overlap at either
 * end) does not count.
 */
export function featuresJumped(jumpStartX, landX, features) {
  return features.filter((f) => f.x >= jumpStartX + BUGGY_W && f.x + f.w <= landX);
}

// --- local high scores -------------------------------------------------------

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let storage = defaultStorage();

/** Test hook: swap the storage backend (or install a throwing stub). */
export function _setStorage(storageLike) {
  storage = storageLike;
}

function keyFor(mode) {
  return `lunar-rover-hs-${mode}`;
}

/**
 * loadScores(mode) -> up to 10 {initials, score} entries, sorted desc.
 * Returns [] when storage is missing, empty, corrupt, or throws.
 */
export function loadScores(mode) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(keyFor(mode));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * submitScore(mode, initials, score) -> inserts the entry, sorts desc,
 * trims to 10, and persists (best-effort — a throwing/missing storage
 * still returns the correct in-memory trimmed list, it just won't stick).
 */
export function submitScore(mode, initials, score) {
  const list = loadScores(mode);
  list.push({ initials, score });
  list.sort((a, b) => b.score - a.score);
  const trimmed = list.slice(0, 10);
  try {
    if (storage) storage.setItem(keyFor(mode), JSON.stringify(trimmed));
  } catch {
    // Persistence failed; the in-memory result above is still returned.
  }
  return trimmed;
}
