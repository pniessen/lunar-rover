// state.js — the game object and the phase machine that orchestrates every
// per-module update. PURE LOGIC: no DOM/canvas/audio imports, so it runs and
// is tested under `node --test`. Presentation reads `game` and consumes
// `game.events`; it never writes back.

import {
  createBuggy, updateBuggy, checkTerrainCollision, killBuggy, SPEED_BANDS, BUGGY_W,
} from './buggy.js';
import {
  buildClassicCourse, createEndlessTerrain, ensureGenerated,
  checkpointIndexAt, checkpointX, featuresInRange, clearNaturalZone, STAGE_BREAKS,
  CHECKPOINT_SPACING,
} from './terrain.js';
import { fireDual, updateWeapons } from './weapons.js';
import { spawnDirector, updateEnemies, ENEMY_W } from './enemies.js';
import { updatePowerups } from './powerups.js';
import { startBoss, updateBoss, updateBossMotion } from './boss.js';
import { mulberry32 } from './rng.js';
import {
  award, featuresJumped, stageBonus, loadScores, submitScore,
  SCORES, STAGE_PAR, COURSE_BONUS,
} from './score.js';
import {
  createCombo, updateCombo, resetCombo, syncComboCursors,
} from './combo.js';
import { pushFx } from './particles.js';

export const DT = 1 / 60;          // fixed simulation timestep, seconds
export const DYING_TIME = 0.9;     // explosion hold before the respawn
export const RESPAWN_TIME = 1.0;   // invulnerable blink-in, buggy already drivable
export const STAGE_CLEAR_TIME = 2.5; // scripted intermission while the stage bonus tallies
// The boss arena is a ROLLING clear, not a fixed carve-out: this is how far
// ahead of the buggy natural terrain is kept swept, re-applied every frame of
// a fight (see maintainBossArena). It replaced a fixed BOSS_ARENA_LEN = 1600
// measured from the checkpoint line, which was only ~8-11s of driving against
// fights that now run 26-65s — so 80%+ of every fight happened over live
// craters/rocks/mines that the duel was never designed around.
//
// 800px is sized off the two things that have to fit inside it:
//   - the boss's own bomb carpet lands at +260..+558 (BOMB_OFFSETS + the 28px
//     crater width), so the ground it craters is always already swept and
//     addBombCrater never gets rejected for overlapping a natural feature;
//   - the viewport only shows ~+274px ahead of the buggy at top speed
//     (VIEW_W 384 minus buggyScreenX's 110), so nothing natural is ever even
//     drawn during a fight.
// Plus ~240px of margin on the bomb reach. Bigger would work too but costs
// dead road: the sweep stops the instant the boss dies, so whatever is still
// swept at that moment is empty road the player coasts through afterwards.
export const BOSS_ARENA_AHEAD = 800;
export const VIEW_W = 384;
export const VIEW_H = 240;
export const GROUND_Y = 200;       // top of the terrain strip
export const HUD_H = 36;
export const HIGH_SCORE_SLOTS = 10; // table depth submitScore() trims to
export const INITIALS_LEN = 3;

// Hit-stop durations, in seconds (see updateGame's freeze handling). Both are
// consumed as whole fixed ticks: 0.03 == 2 ticks, 0.08 == 5.
export const HIT_STOP_ENEMY = 0.03; // set by enemies.js's hitEnemy
export const HIT_STOP_BOSS = 0.08;  // set below, AFTER the boss-down transition

// Buggy is driven with no-op input during the stageClear intermission — it
// keeps scrolling for the visual effect, but accel/brake/jump/fire are all
// ignored (only updateBuggy's dt-driven movement/gravity runs).
const NOOP_INPUT = { pressed: () => false };

const JUMP_TAG_BY_TYPE = {
  crater: 'craterJump',
  bigCrater: 'craterJump',
  bombCrater: 'craterJump',
  doubleCrater: 'doubleCraterJump',
  mine: 'mineJump',
  rock: 'rockJump',
  bigRock: 'rockJump',
};

// Crater-family types (as opposed to mine/rock) — used to decide whether a
// landed jump counts as a combo-worthy "crater near-miss" (Task 10).
const CRATER_TYPES = new Set(['crater', 'bigCrater', 'bombCrater', 'doubleCrater']);

const GENERATE_AHEAD = 2400;       // endless terrain lookahead, px

/**
 * Screen x the buggy is pinned to. It drifts right as speed rises so the
 * player gets more lookahead the faster they go (SPEED_BANDS[0] -> 56 px,
 * SPEED_BANDS[2] -> 110 px).
 */
export function buggyScreenX(game) {
  return 56 + (game.speed - SPEED_BANDS[0]) * 0.45;
}

export function createGame(mode = 'classic', seed = 1) {
  const game = {
    mode,
    phase: 'attract',
    phaseTimer: 0,
    buggy: createBuggy(),
    // A fresh run always starts on the beginner course (courseId 0);
    // finishStageClear() promotes to the champion course (1) after Z.
    terrain: mode === 'endless' ? createEndlessTerrain(seed) : buildClassicCourse(0),
    speed: SPEED_BANDS[1],
    camX: 0,
    score: 0,
    scoreEvents: [],
    lives: 3,
    checkpoint: 0,
    stage: 0,
    stageTime: 0,
    courseId: 0,
    jumpStartX: null,
    extraLivesGranted: [],
    stageClear: null,
    // Attract-screen mode selector (Task 13): 0 = CLASSIC, 1 = ENDLESS.
    // accel/brake toggle it while game.phase==='attract'; jump/fire starts
    // whichever is highlighted. Reset to 0 by every fresh createGame() —
    // in particular, gameOver's resetToAttract() always lands back on
    // CLASSIC rather than remembering the previous run's selection.
    menuIndex: 0,
    // Endless-only run clock (Task 13): accumulates dt across the whole
    // run (only while 'playing'/'boss', mirroring stageTime — see
    // tickEndlessClock below), and drives both the speed ramp
    // (game.speedBonus) and the boss cadence (game.nextBossAt). Always
    // present (harmless 0/90 defaults) so the shape is consistent across
    // modes, but only ever mutated when game.mode === 'endless'.
    elapsedTotal: 0,
    speedBonus: 0,
    nextBossAt: 90,
    // Set only in the rare same-frame race where a boss dies in the exact
    // frame the buggy also dies (see the 'boss' case's buggy-death-takes-
    // priority handling and resumeAfterRespawn below) — stashes the
    // checkpoint index enterStageClear needs so the stage bonus is still
    // paid once the death/respawn cycle finishes, instead of being lost.
    bossStageClearCheckpoint: null,
    events: [],
    // Task 14 — the parallel VISUAL event channel. game.events stays the
    // AUDIO channel (bare strings, consumed by audio.js); game.fx carries
    // {kind,x,y} entries so the renderer knows *where* to throw particles and
    // how hard to shake, which the string events never encoded. Written via
    // particles.js's pushFx from enemies/weapons/boss/state; consumed AND
    // cleared by render.js every frame, exactly like main.js clears
    // game.events. Split rather than merged so no audio handler or its tests
    // had to change.
    fx: [],
    // Hit-stop, in seconds of remaining freeze. Set by enemy/boss kills;
    // updateGame decrements it and skips the whole simulation while it is
    // >0 (see updateGame). Cleared by every phase transition.
    freeze: 0,
    // P-key pause (finding I5). While true, updateGame is a no-op — see
    // togglePause/updateGame. Always false on a fresh game, so both
    // resetToAttract() and restartRun() clear it for free.
    paused: false,
    // High-score initials entry ({slots:['A','A','A'], index:0}) while
    // phase==='enterScore'; null otherwise. See endRun/the 'enterScore' case.
    initialsEntry: null,
    // The initials just submitted this run, so the gameOver table can
    // highlight the player's own fresh row. null until a run is entered.
    lastInitials: null,
    playerShots: [],
    enemyShots: [],
    enemies: [],
    capsules: [],
    powerup: null,
    combo: createCombo(),
    rngSeed: seed,
    // Independent stream from the terrain/course rng so wave timing/picks
    // never perturb (or get perturbed by) terrain generation.
    waveRng: mulberry32(seed + 1),
    warn: { air: false, mine: false, rear: false },
  };
  if (game.mode === 'endless') ensureGenerated(game.terrain, GENERATE_AHEAD);
  updateCamera(game);
  return game;
}

function setPhase(game, phase) {
  game.phase = phase;
  game.phaseTimer = 0;
  // A phase transition always cancels any pending hit-stop: a kill landing
  // in the same frame the buggy dies (or a boss fight ends) must never leave
  // the new phase frozen for its first frames.
  game.freeze = 0;
}

/**
 * The single death path (Task 14 refactor of four identical call sites):
 * spend a life, enter 'dying', drop the combo, and throw the explosion
 * particles at the buggy. Keeping the fx push here rather than in
 * buggy.js's killBuggy is deliberate — killBuggy also fires when a shield
 * absorbs a hit (returning false, no death), and it has no access to
 * GROUND_Y (state.js owns that constant, and buggy.js importing it would
 * add a cycle for no gain).
 */
function enterDying(game) {
  game.lives -= 1;
  setPhase(game, 'dying');
  resetCombo(game);
  pushFx(game, 'boom', game.buggy.worldX + BUGGY_W / 2, GROUND_Y + game.buggy.y - 10);
}

/**
 * True when `score` would land in the mode's top-HIGH_SCORE_SLOTS table.
 * A zero score never qualifies (an instant triple-death should not prompt
 * for initials). Exported for tests and for any caller that wants to know
 * before the run actually ends.
 */
export function qualifiesForHighScore(mode, score) {
  if (!(score > 0)) return false;
  const scores = loadScores(mode);
  if (scores.length < HIGH_SCORE_SLOTS) return true;
  return score > scores[scores.length - 1].score;
}

/**
 * Ends a run once the last life is gone. A qualifying score detours through
 * the 'enterScore' initials picker (which submits and then falls through to
 * 'gameOver'); anything else goes straight to 'gameOver'.
 */
function endRun(game) {
  if (qualifiesForHighScore(game.mode, game.score)) {
    game.initialsEntry = { slots: ['A', 'A', 'A'], index: 0 };
    setPhase(game, 'enterScore');
  } else {
    game.initialsEntry = null;
    setPhase(game, 'gameOver');
  }
}

const LETTER_A = 'A'.charCodeAt(0);
const ALPHABET_LEN = 26;

/** Steps a slot letter by `dir`, wrapping A->Z and Z->A. */
function cycleLetter(ch, dir) {
  const i = ch.charCodeAt(0) - LETTER_A;
  const next = ((i + dir) % ALPHABET_LEN + ALPHABET_LEN) % ALPHABET_LEN;
  return String.fromCharCode(LETTER_A + next);
}

function updateCamera(game) {
  game.camX = game.buggy.worldX - buggyScreenX(game);
}

/**
 * Awards jump-over points for every non-destroyed feature (crater family,
 * mine, rock family) fully cleared between jumpStartX and landX, plus a
 * tankJump bonus for any tank enemy fully cleared in the same span.
 *
 * Also signals a combo-worthy near-miss (Task 10): landing at top speed
 * band (band 2) having cleared at least one live crater-family feature
 * pushes 'craterNearMiss' to game.events. This is an internal-only event —
 * no HUD/audio handler needed, since audio.js ignores unrecognized event
 * names — consumed solely by combo.js's updateCombo.
 */
function scoreJump(game, jumpStartX, landX) {
  const terrain = game.terrain;
  const candidates = terrain.mode === 'test'
    ? terrain.features
    : featuresInRange(terrain, jumpStartX, landX);
  const cleared = featuresJumped(jumpStartX, landX, candidates);
  for (const f of cleared) {
    if (f.destroyed) continue;
    const tag = JUMP_TAG_BY_TYPE[f.type];
    if (tag) award(game, SCORES[tag], tag);
  }

  if (game.buggy.band === 2
      && cleared.some((f) => !f.destroyed && CRATER_TYPES.has(f.type))) {
    game.events.push('craterNearMiss');
  }

  for (const e of game.enemies) {
    if (e.kind !== 'tank') continue;
    if (e.x >= jumpStartX + BUGGY_W && e.x + ENEMY_W.tank <= landX) {
      award(game, SCORES.tankJump, 'tankJump');
    }
  }
}

/**
 * Shared drive step for `playing` and `respawning`. During `respawning` the
 * buggy is drivable but invulnerable, so terrain collision — and entering
 * stageClear — are skipped (checkpoint tracking/eventing still runs so the
 * HUD stays current).
 */
function updateDrive(game, input, dt, invulnerable) {
  ensureGenerated(game.terrain, game.buggy.worldX + GENERATE_AHEAD);
  maintainBossArena(game);

  const wasAirborne = game.buggy.airborne;
  updateBuggy(game, input, dt);
  const buggy = game.buggy;

  if (!wasAirborne && buggy.airborne) {
    game.jumpStartX = buggy.worldX;
  } else if (wasAirborne && !buggy.airborne && game.jumpStartX != null) {
    scoreJump(game, game.jumpStartX, buggy.worldX);
    game.jumpStartX = null;
  }

  // Checkpoints are monotonic — never regress after a respawn drives the
  // buggy backwards. Tracked in both modes (endless respawn math wants a
  // recent boundary — see respawn() below — and the HUD/audio checkpoint
  // chime is harmless either way), but the stage-break -> boss diversion
  // below is classic-only: endless has no checkpoints/stage-breaks, and
  // checkpointIndexAt clamps at 25 (== STAGE_BREAKS' last entry, the
  // course-end break) for any worldX past the classic course's end, which
  // an endless run will eventually blow past — gating on mode is what
  // keeps that clamp from ever firing the classic course-end path.
  const cp = checkpointIndexAt(buggy.worldX);
  if (cp > game.checkpoint) {
    game.checkpoint = cp;
    game.events.push('checkpoint');
    if (game.mode === 'classic' && !invulnerable && STAGE_BREAKS.includes(cp)) {
      enterBoss(game);
    }
  }

  if (invulnerable) return;

  const cause = checkTerrainCollision(game.buggy, game.terrain);
  // killBuggy returns false when a shield absorbed the hit, in which case
  // the buggy is still alive and the run continues.
  if (cause && killBuggy(game, cause)) {
    enterDying(game);
  }
}

/**
 * maintainBossArena(game) — the rolling boss arena. Keeps BOSS_ARENA_AHEAD px
 * of road ahead of the buggy free of naturally generated terrain for as long
 * as a boss is alive, so the duel stays a duel for its whole duration rather
 * than for the first eight seconds of it.
 *
 * Three things about this are deliberate:
 *
 *  1. **It follows the buggy, not the checkpoint line.** The original arena
 *     was a one-shot 1600px carve at the break line. Fights run 26-65s (see
 *     boss.js's PACING block) — 3500-13000px of road — and a mid-fight death
 *     extends that further, so any fixed constant is a guess that a long
 *     fight outruns. A window anchored on `buggy.worldX` cannot be outrun by
 *     construction.
 *  2. **It spares `bombCrater`.** clearNaturalZone's whole reason for
 *     existing: the carpet lands 260-530px ahead, i.e. inside this window,
 *     so a type-blind clear would delete the boss's attack a frame or two
 *     after it landed. The player's hazard during a fight is exactly the
 *     hazard the boss made.
 *  3. **Generate, then clear.** Endless terrain is produced on demand, so a
 *     chunk that materializes this frame has to be swept this frame — the
 *     ensureGenerated call here is what guarantees the clear below is
 *     operating on the final feature list rather than racing it. (In
 *     practice updateDrive has already generated to +GENERATE_AHEAD, which
 *     is well past this window; the call is kept so this function is correct
 *     standalone, e.g. from enterBoss/enterEndlessBoss.)
 *
 * Gated on `game.boss` rather than `game.phase === 'boss'` so it also runs
 * through a mid-fight death's 'respawning' frames — the buggy respawns
 * *behind* its death position, over road this sweep already cleared, and the
 * sweep has to keep up as it drives forward again. It stops the frame the
 * boss dies (hitBoss nulls game.boss), so the stageClear intermission and
 * everything after it see live terrain again.
 */
function maintainBossArena(game) {
  if (!game.boss) return;
  const x0 = game.buggy.worldX;
  const x1 = x0 + BOSS_ARENA_AHEAD;
  ensureGenerated(game.terrain, x1);
  clearNaturalZone(game.terrain, x0, x1);
}

/**
 * Diverts a stage-break checkpoint crossing (E/J/O/T/Z — every entry in
 * STAGE_BREAKS, as of Task 12) into the 'boss' phase instead of straight
 * into 'stageClear'. Opens the rolling arena (maintainBossArena) so the
 * fight starts on clear ground and stays that way — no pre-placed
 * craters/rocks/mines, just whatever the boss itself drops (bombCarpet's
 * bombs still crater the ground on impact, same as a regular bomber's, and
 * those craters are explicitly exempt from the sweep). Also clears any regular wave
 * enemies/enemy shots still alive from just before the break line (a tank
 * or a stray aimed shot that crossed into the "cleared" arena would
 * otherwise still be able to ram/shoot the buggy during the fight,
 * contradicting the fair-arena design — see review fix round 1, finding
 * 2). game.playerShots is deliberately left alone: the player's own
 * in-flight shots carrying into the fight is fine and arguably fair.
 * The stageClear tally itself still happens — see the 'boss' case in
 * updateGame, which calls enterStageClear once the boss's hp hits 0 (or,
 * in the same-frame boss/buggy-death race, resumeAfterRespawn does once
 * the death cycle finishes) — this just delays it behind the fight.
 */
function enterBoss(game) {
  game.enemies = [];
  game.enemyShots = [];
  startBoss(game);        // must precede maintainBossArena — it gates on game.boss
  maintainBossArena(game);
  setPhase(game, 'boss');
}

/**
 * Endless-mode boss entry (Task 13): triggered by elapsed run time
 * (game.elapsedTotal >= game.nextBossAt, checked once per 'playing' frame
 * in updateGame) rather than a checkpoint line — endless has no
 * checkpoints/stage-breaks to anchor to. The arena is the same rolling
 * clear as classic's enterBoss (maintainBossArena — which is anchored on the
 * buggy in both modes, so there is nothing mode-specific left about it).
 * It matters more here than in classic: endless terrain is generated on
 * demand as the buggy advances, so every chunk a fight drives into is born
 * *during* the fight, and the sweep is the only thing that ever sees it.
 *
 * Difficulty scales on the same BASE_HP+stage*HP_PER_STAGE curve as classic
 * (18/24/30/36, or FINAL_HP's two-phase fight at stage 4) —
 * game.stage is set here, before startBoss reads it, from elapsed time
 * rather than segment index; once a run runs long enough (elapsed >= 360s)
 * every subsequent boss is the stage-4 "final" FINAL_HP two-phase fight, which
 * is the intended cap for an endlessly-scaling difficulty curve.
 * game.nextBossAt advances immediately (not after the fight ends), per the
 * brief's "game.nextBossAt = 90 then += 90".
 */
function enterEndlessBoss(game) {
  game.enemies = [];
  game.enemyShots = [];
  game.stage = Math.min(4, Math.floor(game.elapsedTotal / 90));
  startBoss(game);        // must precede maintainBossArena — it gates on game.boss
  maintainBossArena(game);
  setPhase(game, 'boss');
  game.nextBossAt += 90;
}

/**
 * Advances the endless-only run clock and the speed ramp it drives
 * (Task 13). No-ops for classic. Called once per simulated frame from both
 * the 'playing' and 'boss' cases below, mirroring exactly where/when
 * game.stageTime itself accumulates (frozen during dying/respawning/
 * stageClear).
 *
 * Speed ramp: +4 px/s to the buggy's band target every 30s, capped at +60
 * (30s * 15 = 450s to cap). Applied via game.speedBonus, read by buggy.js's
 * updateBuggy as an addend on top of SPEED_BANDS[band] — SPEED_BANDS
 * itself is never mutated (it's a shared const imported all over), so
 * classic (which never touches speedBonus, staying at its 0 default) is
 * completely unaffected.
 */
function tickEndlessClock(game, dt) {
  if (game.mode !== 'endless') return;
  game.elapsedTotal += dt;
  game.speedBonus = Math.min(60, Math.floor(game.elapsedTotal / 30) * 4);
}

/**
 * Enters the stageClear intermission. Z (the last STAGE_BREAKS index) is
 * the course-end case: it pays COURSE_BONUS + a par-time bonus instead of
 * the regular per-stage stageBonus(), and finishStageClear() swaps/loops
 * the course afterward rather than just incrementing `stage`.
 */
function enterStageClear(game, checkpointIdx) {
  // Course-end (courseId swap to the champion course) is a classic-only
  // concept. Gating on mode matters because checkpointIndexAt clamps at 25
  // — STAGE_BREAKS' last entry — for any worldX past the classic course's
  // end, which an endless run's game.checkpoint will eventually reach; an
  // ungated check here would wrongly rebuild the terrain as
  // buildClassicCourse(1) once that happened (see finishStageClear).
  const isCourseEnd = game.mode === 'classic'
    && checkpointIdx === STAGE_BREAKS[STAGE_BREAKS.length - 1];
  const champion = game.courseId === 1;
  const total = isCourseEnd
    ? COURSE_BONUS + 100 * Math.max(0, Math.floor(STAGE_PAR - game.stageTime))
    : stageBonus(game.stageTime, champion);
  game.stageClear = { total, paid: 0, isCourseEnd };
  setPhase(game, 'stageClear');
}

/** Pays out one 100-pt tick of the stageClear tally per frame (remainder tick last). */
function tickStageClearTally(game) {
  const sc = game.stageClear;
  if (!sc || sc.paid >= sc.total) return;
  const tick = Math.min(100, sc.total - sc.paid);
  award(game, tick, 'stageBonus');
  sc.paid += tick;
  game.events.push('tally');
}

/**
 * Ends the stageClear intermission once its tally is fully paid and its
 * timer has elapsed. Non-course-end: classic bumps `stage` by one and
 * resumes play in place; endless instead *recomputes* `stage` from
 * elapsedTotal via the same `min(4, floor(elapsedTotal/90))` formula
 * enterEndlessBoss uses — endless has no "next segment" the way classic's
 * checkpoint index does, so an unconditional `+= 1` here would drift stage
 * upward forever across repeated boss cycles (5th cycle onward it would
 * exceed STAGE_PALETTES.length/mountains.length, visually reverting a long
 * run to the stage-0 look instead of staying capped at the stage-4 theme).
 * Course-end (Z): rebuild the champion course (courseId 1, fresh —
 * this both starts the champion course the first time and loops it every
 * time after) and reset the run's position/checkpoint/stage cleanly so it
 * restarts at A.
 *
 * The course-end branch also clears every live entity (enemies, enemy
 * shots, player shots) and the wave-spawn timer. Without this, entities
 * near the old Z line — parked at their stale worldX — would survive into
 * the new lap fully collidable (the champion course reuses the same
 * worldX range as the beginner course), since culling only removes
 * entities *behind* the buggy, not ones simply left over from a previous
 * lap at a worldX the buggy is about to revisit.
 */
function finishStageClear(game) {
  const sc = game.stageClear;
  game.stageClear = null;
  game.stageTime = 0;

  if (sc.isCourseEnd) {
    game.courseId = 1;
    game.terrain = buildClassicCourse(1);
    game.checkpoint = 0;
    game.stage = 0;
    const buggy = game.buggy;
    buggy.worldX = 0;
    buggy.y = 0;
    buggy.vy = 0;
    buggy.airborne = false;
    buggy.settle = 0;
    game.enemies = [];
    game.enemyShots = [];
    game.playerShots = [];
    game.waveTimer = undefined; // spawnDirector lazily re-seeds this on its next call
  } else if (game.mode === 'endless') {
    // See the docstring above — recomputed from elapsed time, not bumped,
    // so it stays capped at 4 no matter how many boss cycles a run sees.
    game.stage = Math.min(4, Math.floor(game.elapsedTotal / 90));
  } else {
    game.stage += 1;
  }

  setPhase(game, 'playing');
  // Discard anything scored/evented during the intermission (see
  // syncComboCursors' docstring) rather than letting it get replayed as
  // combo actions the instant play resumes.
  syncComboCursors(game);
}

/**
 * Rebuild the buggy from scratch at the respawn point. A fresh createBuggy()
 * (rather than resurrecting the dead one) guarantees vy/airborne/settle/
 * wheelPhase/deathCause are all clean — updateBuggy no-ops while `alive` is
 * false, so a half-reset buggy would silently freeze.
 *
 * Classic respawns at the last checkpoint line (checkpointX(game.checkpoint)
 * — clamped to the 26-checkpoint course, which is exactly right there).
 * Endless instead respawns at the nearest 1200px (CHECKPOINT_SPACING)
 * boundary at or behind the death worldX, computed directly from
 * game.buggy.worldX (still the dead buggy, frozen at its death position —
 * updateBuggy no-ops once alive is false) rather than via
 * checkpointX(game.checkpoint): checkpointIndexAt/checkpointX clamp to the
 * classic course's 26 checkpoints, which a long-enough endless run would
 * overrun, silently pinning every later respawn to the same stale spot.
 * The boundary is always safe: endless terrain chunks (terrain.js's
 * buildChunkFeatures) keep the first 300px after every CHECKPOINT_SPACING
 * boundary clear, same guarantee the classic checkpoints rely on.
 */
function respawn(game) {
  const deathX = game.buggy.worldX;
  const buggy = createBuggy();
  buggy.worldX = game.mode === 'endless'
    ? Math.floor(deathX / CHECKPOINT_SPACING) * CHECKPOINT_SPACING
    : checkpointX(game.checkpoint);
  game.buggy = buggy;
  game.speed = SPEED_BANDS[buggy.band] + (game.speedBonus || 0);
  game.jumpStartX = null; // a jump in progress at death never lands
}

/**
 * Decides which phase 'respawning' resumes into once RESPAWN_TIME elapses,
 * and performs that transition. Three cases:
 *  - game.boss is still alive (a normal mid-fight death, the common case)
 *    -> resume 'boss' exactly where the fight left off.
 *  - game.boss is null AND game.bossStageClearCheckpoint was stashed (the
 *    boss died in the *exact same frame* the buggy did — see the 'boss'
 *    case below, "buggy death takes priority") -> the stage bonus was
 *    never paid because the death took priority over the boss-down
 *    transition that frame, so pay it now via the stashed checkpoint index
 *    rather than losing it.
 *  - neither -> an ordinary death during regular play -> 'playing'.
 * In every case, syncComboCursors() runs last so the whole dying+
 * respawning window's scoring/eventing is discarded exactly as it always
 * has been (see that function's docstring) — including, in the middle
 * case, the transition straight into 'stageClear' rather than 'playing'.
 */
function resumeAfterRespawn(game) {
  if (game.boss) {
    setPhase(game, 'boss');
  } else if (game.bossStageClearCheckpoint != null) {
    const checkpointIdx = game.bossStageClearCheckpoint;
    game.bossStageClearCheckpoint = null;
    enterStageClear(game, checkpointIdx);
  } else {
    setPhase(game, 'playing');
  }
  syncComboCursors(game);
}

/** Mutate `game` back to a brand-new attract-screen run, in place. */
function resetToAttract(game) {
  Object.assign(game, createGame(game.mode, game.rngSeed));
}

/**
 * Leaves the attract screen's mode-select menu and starts a fresh run of
 * whichever mode is highlighted (game.menuIndex: 0 = classic, 1 = endless).
 * `seed` is optional deterministic-but-varied entropy for the new run's
 * terrain/wave RNG: state.js itself never calls Date.now()/Math.random()
 * (this module stays pure/Node-testable), so a caller with no seed to offer
 * (e.g. a test) falls back to reusing game.rngSeed — deterministic, but the
 * same seed every time. The presentation layer (main.js) is the sanctioned
 * place to break that determinism: it may read Date.now() and pass the
 * result in as `seed` (see updateGame's docstring below), so a real player
 * gets a different course/enemy layout each run they start from the menu.
 */
function startSelectedRun(game, seed) {
  const mode = game.menuIndex === 0 ? 'classic' : 'endless';
  const runSeed = seed != null ? seed : game.rngSeed;
  Object.assign(game, createGame(mode, runSeed));
  setPhase(game, 'playing');
}

// Phases P can pause and R can restart from — every phase that is part of a
// live run. 'attract' and 'gameOver' are deliberately excluded: there is
// nothing to pause on a menu, and restarting from one would skip the mode
// selection the player is standing in front of. (Task 14's initials picker,
// 'enterScore', counts as in-run: it is still the run's own end sequence.)
const IN_RUN_PHASES = new Set([
  'playing', 'dying', 'respawning', 'boss', 'stageClear', 'enterScore',
]);

/**
 * togglePause(game) — the P key (finding I5). No-op outside a live run.
 * Returns the resulting paused state so the caller can react (main.js keeps
 * rendering either way, and stops feeding the audio scheduler while paused).
 *
 * The pause itself is enforced by updateGame's early return below rather than
 * by the caller skipping the call, so "paused" means the same thing to every
 * caller — the browser loop, a test, anything — and cannot be half-implemented.
 */
export function togglePause(game) {
  if (!IN_RUN_PHASES.has(game.phase)) return false;
  game.paused = !game.paused;
  return game.paused;
}

/**
 * restartRun(game, seed) — the R key (finding I5). Instantly abandons the
 * current run and starts a fresh one of the SAME mode, straight into
 * 'playing' (no attract screen, arcade-style). No-op on the attract screen,
 * where the player is choosing a mode and R would bypass that choice.
 *
 * `seed` follows the same rule as updateGame's: presentation owns entropy, so
 * main.js passes Date.now() and a test can pass a fixed number (or nothing,
 * reusing the current run's seed) and stay deterministic.
 * Returns true if a restart actually happened.
 */
export function restartRun(game, seed) {
  if (!IN_RUN_PHASES.has(game.phase)) return false;
  const mode = game.mode;
  const runSeed = seed != null ? seed : game.rngSeed;
  Object.assign(game, createGame(mode, runSeed));
  setPhase(game, 'playing');
  return true;
}

/**
 * @param {object} game
 * @param {object} input
 * @param {number} dt
 * @param {number} [seed] - Optional entropy for a new run started this call
 *   (see startSelectedRun's docstring) — the ONLY place Date.now()-derived
 *   values are allowed to reach this pure module, and only ever consumed at
 *   the exact frame the attract-screen menu is dismissed; every other use
 *   of randomness in this module and everything it calls goes through the
 *   seeded mulberry32 RNGs (game.rngSeed/game.waveRng), never this.
 */
export function updateGame(game, input, dt, seed) {
  // Pause (finding I5). A hard freeze of the entire simulation — no movement,
  // no timers, no input, not even phaseTimer — held until togglePause() flips
  // it back. Deliberately checked before the hit-stop countdown below so a
  // pause during a hit-stop resumes with that freeze intact. Presentation
  // keeps rendering (main.js draws the PAUSED overlay over the frozen world).
  if (game.paused) return;

  // Hit-stop (Task 14). A kill sets game.freeze (0.03s for a regular enemy,
  // 0.08s for a boss); until it drains, this whole function is a no-op apart
  // from the countdown itself — no movement, no timers, no input, not even
  // phaseTimer. Note the interaction with the fixed timestep: `dt` here is
  // always DT (1/60), so a freeze consumes whole simulation TICKS, not wall
  // time — 0.03 costs exactly 2 ticks and 0.08 exactly 5, identically on a
  // 60Hz and a 144Hz display, and identically in `node --test`. Rendering
  // continues at display rate through the freeze, so the particles thrown by
  // the kill keep animating while the world holds still: that contrast is
  // the whole point of the effect. Decrement-first (rather than
  // check-then-decrement) means a freeze can never outlast its nominal
  // duration by an extra tick.
  if (game.freeze > 0) {
    game.freeze = Math.max(0, game.freeze - dt);
    return;
  }

  game.phaseTimer += dt;

  switch (game.phase) {
    case 'attract':
      // Mode-select menu (Task 13): accel/brake toggle CLASSIC/ENDLESS;
      // jump/fire starts the highlighted mode. This replaces the previous
      // "any of the seven actions wakes the attract screen" behavior —
      // pause/mute/restart are no-ops here now, same as they are once a
      // run is actually underway.
      if (input.pressed('accel') || input.pressed('brake')) {
        game.menuIndex = game.menuIndex === 0 ? 1 : 0;
      } else if (input.pressed('jump') || input.pressed('fire')) {
        startSelectedRun(game, seed);
      }
      break;

    case 'playing':
      game.stageTime += dt; // stage clock runs only during live play
      tickEndlessClock(game, dt); // endless-only: run clock + speed ramp
      updateDrive(game, input, dt, false);
      // updateDrive may have entered 'boss' this frame (a stage-break
      // checkpoint just crossed — every STAGE_BREAKS entry now diverts into
      // a boss fight rather than straight into 'stageClear') — either way,
      // that phase owns the rest of this frame instead of the usual
      // playing-phase systems.
      if (game.phase === 'boss' || game.phase === 'stageClear') break;
      // Endless has no checkpoints to divert into a boss fight from — it's
      // timed instead: once the run clock crosses game.nextBossAt, enter
      // the boss the same way a classic stage-break does. Gated on phase
      // still being 'playing' (not just !== 'boss'/'stageClear' above): a
      // terrain hit inside updateDrive this same frame already moved us to
      // 'dying', and entering the boss here would stomp that transition —
      // clearing the death, forcing 'boss' back on, and losing the life
      // deduction. The boss simply waits one more frame in that case.
      if (game.mode === 'endless' && game.phase === 'playing'
          && game.elapsedTotal >= game.nextBossAt) {
        enterEndlessBoss(game);
        break;
      }
      spawnDirector(game, dt);
      updateEnemies(game, dt);
      if (input.pressed('fire')) fireDual(game);
      updateWeapons(game, dt);
      updatePowerups(game, dt);
      // updateDrive already handles lives/phase transition for a terrain
      // kill; this catches a kill that happened inside updateEnemies
      // (enemy shot, bomb, or chaser ram) this same frame.
      if (game.phase === 'playing' && !game.buggy.alive) {
        enterDying(game);
      }
      // Combo updates LAST, after every award-generating system above has
      // run this frame — any comboAction detected here (new scoreEvents,
      // a chaser dodge, a crater near-miss) raises the multiplier for
      // *next* frame's awards only, so this frame's own awards were never
      // inflated by the combo bump they themselves caused. Guarded on
      // phase still being 'playing' so a same-frame death (which already
      // called resetCombo above) doesn't immediately re-tick the timer;
      // this also means the combo timer is frozen (does not tick down)
      // during stageClear/dying/respawning — only 'playing' and (as of
      // Task 12) 'boss' frames advance it; see the 'boss' case below for
      // why a boss fight builds combo just like regular play.
      if (game.phase === 'playing') updateCombo(game, dt);
      break;

    case 'dying':
      // Buggy is dead: never call updateBuggy/killBuggy here, and never
      // trigger fireDual — the player cannot fire while exploding. Shots
      // already in flight still fly (and can still score) while the buggy
      // explodes, so updateWeapons still runs to move/collide/cull them.
      // Enemies also keep moving/shooting through the explosion — only
      // spawnDirector (new waves) is withheld outside 'playing'.
      updateWeapons(game, dt);
      updateEnemies(game, dt);
      if (game.phaseTimer >= DYING_TIME) {
        if (game.lives <= 0) {
          // Task 14: a run that made the mode's top-10 detours through the
          // 'enterScore' initials picker first; everything else lands on
          // 'gameOver' directly, exactly as before.
          endRun(game);
        } else {
          respawn(game);
          setPhase(game, 'respawning');
        }
      }
      // Cosmetic-polish pass: keeps a mid-fight boss's sweep tracking the
      // buggy's worldX instead of holding still and snapping to the new
      // position once 'boss' resumes — see updateBossMotion's docstring in
      // boss.js. No-ops if game.boss is null (an ordinary, non-boss death).
      // Deliberately placed AFTER the respawn() branch above, not before:
      // respawn() teleports buggy.worldX on the exact frame this window
      // ends, and computing b.x against the PRE-teleport worldX (as an
      // earlier version of this fix did) left one single frame where b.x
      // was correct for a buggy.worldX that had already been overwritten —
      // a same-frame version of the exact snap this fix exists to remove.
      // Running last means b.x is always computed against buggy.worldX as
      // it stands at the end of the frame.
      updateBossMotion(game, dt);
      break;

    case 'respawning':
      updateDrive(game, input, dt, true);
      // Invulnerability (skipped terrain collision above) only affects
      // deaths — the player can still shoot while blinking in. updateEnemies
      // internally gates its own buggy-collision checks to phase==='playing',
      // so the invulnerable buggy is safe here too.
      if (input.pressed('fire')) fireDual(game);
      updateWeapons(game, dt);
      updateEnemies(game, dt);
      // Capsules keep falling and can still be collected while blinking in
      // (player-friendly); the active power-up's countdown does not tick
      // here, though — updatePowerups internally gates that to 'playing'
      // only, mirroring the combo timer's phase gating above.
      updatePowerups(game, dt);
      // Same continuity fix as the 'dying' case above, run after updateDrive
      // so it reads this frame's already-moved buggy.worldX. No-ops if
      // game.boss is null.
      updateBossMotion(game, dt);
      // See resumeAfterRespawn's docstring: resumes 'boss' (fight still
      // going), pays a stashed boss stage bonus via 'stageClear' (the
      // boss died the same frame the buggy did), or 'playing' (an
      // ordinary death) — and discards anything scored/evented across the
      // whole dying+respawning window (syncComboCursors) either way.
      if (game.phaseTimer >= RESPAWN_TIME) resumeAfterRespawn(game);
      break;

    case 'stageClear':
      // Scripted intermission: buggy keeps scrolling (no-op input, so
      // accel/brake/jump/fire are all ignored) but is invulnerable and
      // un-collidable — no terrain/enemy collisions, no new waves, no
      // enemy/weapon updates. The stage bonus pays out as a ticking tally
      // (100 pts/frame, 'tally' event each tick) until its total is paid;
      // the phase only exits once BOTH the tally is fully paid AND
      // STAGE_CLEAR_TIME has elapsed.
      updateBuggy(game, NOOP_INPUT, dt);
      // Capsules keep falling and can still be collected while the tally runs
      // (finding I4): the buggy is on rails but still scrolling forward, and
      // the boss's guaranteed drop is deliberately aimed at the patch of
      // ground it rolls over during this intermission.
      updatePowerups(game, dt);
      tickStageClearTally(game);
      if (game.stageClear.paid >= game.stageClear.total && game.phaseTimer >= STAGE_CLEAR_TIME) {
        finishStageClear(game);
      }
      break;

    case 'boss': {
      // Defensive exit (final-review finding I3). Every in-phase path that
      // nulls game.boss also transitions out of 'boss' in the same call, so
      // reaching a frame here with no boss should be impossible — but if it
      // ever happened (a future bug, a hand-built game object, a save/replay
      // path) the phase would sit forever with no boss to kill and no exit
      // condition: an unrecoverable soft-lock in the middle of a run. Fall
      // through to the tally the fight would have paid instead. game.checkpoint
      // is the break index in classic and simply the last checkpoint crossed in
      // endless, which is exactly what enterStageClear wants in both modes.
      if (!game.boss) {
        enterStageClear(game, game.checkpoint);
        break;
      }

      // Stage-break mothership fight (Task 12). The buggy drives/jumps/
      // fires exactly as in 'playing' — spawnDirector is the only system
      // withheld (no regular enemy waves during a boss fight); terrain
      // collision stays active via updateDrive, which also re-sweeps the
      // rolling arena every frame (maintainBossArena), so the only hazards
      // for the whole fight are craters the boss's own bombs leave behind on
      // impact, via the normal bomb-vs-terrain path in enemies.js's
      // updateEnemies.
      game.stageTime += dt; // time bonus stays meaningful through a boss fight
      tickEndlessClock(game, dt); // endless-only: run clock + speed ramp keep advancing through a fight
      updateDrive(game, input, dt, false);
      if (game.phase !== 'boss') break; // a terrain hit above already moved us to 'dying'

      updateEnemies(game, dt); // moves/culls the boss's bombs & aimed shots (game.enemyShots); may kill the buggy

      // bossWasAlive/game.boss-after comparison, not a 'bossDown' events
      // scan: game.events is a whole-run log only main.js clears, so an
      // includes() check here could match a stale event from many frames
      // ago. A before/after null check on this exact call is unambiguous.
      const bossWasAlive = !!game.boss;
      updateBoss(game, dt); // pattern machine + player-shot-vs-boss + hitBoss/bossDown
      const bossJustDied = bossWasAlive && !game.boss;

      // Buggy death takes priority over a same-frame boss death (review
      // fix round 1, finding 1): a boss bomb/aimed shot landing on the
      // buggy in updateEnemies() above and the player's own shot dropping
      // the boss to 0 in updateBoss() above can both happen in this same
      // frame. Entering 'stageClear' first (the original bug) ran the
      // whole ~2.5s scripted intermission over a visibly dead, frozen
      // buggy with no life deducted and no dying/respawn flow — the life
      // loss only ever caught up ~2.5s later via a stale check. The buggy
      // dying always wins: go to 'dying' now, deducting the life and
      // resetting combo exactly like any other death. hitBoss() already
      // ran unconditionally above (bossKill awarded, capsule dropped,
      // 'bossDown' pushed, game.boss nulled) — the bonus isn't lost, it's
      // just deferred: stash the checkpoint index and let
      // resumeAfterRespawn() enter 'stageClear' once the death/respawn
      // cycle completes instead of doing it now.
      if (!game.buggy.alive) {
        if (bossJustDied) game.bossStageClearCheckpoint = game.checkpoint;
        enterDying(game);
        // See the bossJustDied branch below for why the hit-stop is applied
        // *after* the transition rather than inside boss.js's hitBoss.
        if (bossJustDied) game.freeze = HIT_STOP_BOSS;
        break;
      }

      if (bossJustDied) {
        // The boss died this frame and the buggy is still alive — the
        // common case. Resume the exact same stageClear tally flow a
        // non-boss break used to enter directly — game.checkpoint is
        // still the break index (E/J/O/T/Z) that started this fight, so
        // isCourseEnd/COURSE_BONUS/champion handling all fall out of
        // enterStageClear() unchanged.
        enterStageClear(game, game.checkpoint);
        // Boss hit-stop, applied AFTER the phase transition (fix round 1,
        // finding 1). hitBoss() used to set game.freeze itself, but every
        // boss death routes through setPhase() later in this same updateGame
        // call — via enterStageClear here, or enterDying in the same-frame
        // death race above — and setPhase() clears freeze by design (so a
        // kill landing on the frame the buggy dies can never leave the new
        // phase frozen). The freeze was therefore wiped before any later
        // frame could observe it, and the effect never fired at all.
        // Setting it here instead means the freeze applies to the NEW phase's
        // first ticks, which is exactly the intent: the world hangs for 0.08s
        // on the explosion burst, then the tally starts.
        //
        // Consequence, and it is the intended one: updateGame's freeze check
        // is an early return at the very top, so during those 5 ticks
        // stageClear's phaseTimer does not advance and tickStageClearTally()
        // does not pay out. The intermission is simply delayed by 0.08s —
        // identical semantics to the enemy-kill hit-stop, which likewise
        // pauses every timer while it drains.
        game.freeze = HIT_STOP_BOSS;
        break;
      }

      if (input.pressed('fire')) fireDual(game);
      updateWeapons(game, dt);
      // Capsules move and can be collected during a boss fight (finding I4).
      // The boss's own guaranteed drop lands during 'boss'/'stageClear', so
      // without this it froze mid-air for the whole fight-end sequence and
      // expired behind the buggy. The active power-up's countdown still does
      // not tick here — see updatePowerups' docstring.
      updatePowerups(game, dt);

      // Defensive mirror of 'playing': updateWeapons never actually kills
      // the buggy (player shots only ever hit terrain/the boss), so this
      // is unreachable in practice today, but it costs nothing to keep the
      // same shape as 'playing' in case that ever changes.
      if (game.phase === 'boss' && !game.buggy.alive) {
        enterDying(game);
      }

      // Combo updates during a boss fight too — bosses should build the
      // multiplier just like any other kill/action (hitBoss's award() call
      // pushes a non-'stageBonus'-tagged scoreEvent, which updateCombo's
      // cursor already treats as a comboAction with no boss-specific code
      // needed). The one frame where the boss dies breaks out above before
      // reaching here, so that frame's final bossHit/bossKill scoreEvents
      // go uncounted for combo purposes — harmless, since 'stageClear'
      // freezes the combo entirely anyway and finishStageClear()'s existing
      // syncComboCursors() call already discards anything logged during it,
      // this frame's tail end included, once play resumes.
      if (game.phase === 'boss') updateCombo(game, dt);
      break;
    }

    case 'enterScore': {
      // Three-slot A-Z initials picker, arcade style. accel steps the active
      // letter forward, brake steps it back (both wrap); jump AND fire both
      // commit the slot and advance — on the third commit the entry is
      // submitted to the mode's table and the phase falls through to
      // 'gameOver', which now renders that table with this row highlighted.
      //
      // Only these four actions are read here. pause/mute/restart are
      // deliberately NOT handled: mute is owned by main.js globally (a
      // phase-independent audio toggle, correct to keep working here), and
      // pause/restart have no per-phase behavior anywhere in this machine,
      // so there is no side effect for a stray keypress to trigger while the
      // player is picking letters.
      const entry = game.initialsEntry;
      if (!entry) { setPhase(game, 'gameOver'); break; } // defensive: never reachable via endRun

      if (input.pressed('accel')) {
        entry.slots[entry.index] = cycleLetter(entry.slots[entry.index], 1);
      } else if (input.pressed('brake')) {
        entry.slots[entry.index] = cycleLetter(entry.slots[entry.index], -1);
      } else if (input.pressed('jump') || input.pressed('fire')) {
        entry.index += 1;
        if (entry.index >= INITIALS_LEN) {
          const initials = entry.slots.join('');
          submitScore(game.mode, initials, game.score);
          game.lastInitials = initials;
          game.initialsEntry = null;
          setPhase(game, 'gameOver');
        }
      }
      break;
    }

    case 'gameOver':
      if (input.pressed('jump') || input.pressed('fire')) resetToAttract(game);
      break;
  }

  updateCamera(game);
}
