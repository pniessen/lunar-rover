// state.js — the game object and the phase machine that orchestrates every
// per-module update. PURE LOGIC: no DOM/canvas/audio imports, so it runs and
// is tested under `node --test`. Presentation reads `game` and consumes
// `game.events`; it never writes back.

import {
  createBuggy, updateBuggy, checkTerrainCollision, killBuggy, SPEED_BANDS, BUGGY_W,
} from './buggy.js';
import {
  buildClassicCourse, createEndlessTerrain, ensureGenerated,
  checkpointIndexAt, checkpointX, featuresInRange, STAGE_BREAKS,
} from './terrain.js';
import { fireDual, updateWeapons } from './weapons.js';
import { spawnDirector, updateEnemies } from './enemies.js';
import { mulberry32 } from './rng.js';
import {
  award, featuresJumped, stageBonus, SCORES, STAGE_PAR, COURSE_BONUS,
} from './score.js';
import {
  createCombo, updateCombo, resetCombo, syncComboCursors,
} from './combo.js';

export const DT = 1 / 60;          // fixed simulation timestep, seconds
export const DYING_TIME = 0.9;     // explosion hold before the respawn
export const RESPAWN_TIME = 1.0;   // invulnerable blink-in, buggy already drivable
export const STAGE_CLEAR_TIME = 2.5; // scripted intermission while the stage bonus tallies
export const VIEW_W = 384;
export const VIEW_H = 240;
export const GROUND_Y = 200;       // top of the terrain strip
export const HUD_H = 36;

// Buggy is driven with no-op input during the stageClear intermission — it
// keeps scrolling for the visual effect, but accel/brake/jump/fire are all
// ignored (only updateBuggy's dt-driven movement/gravity runs).
const NOOP_INPUT = { pressed: () => false };

// Jump-over tank scoring needs the tank's collision width, which lives in
// enemies.js as an unexported per-kind lookup (ENEMY_W.tank). Duplicated
// here as a single constant rather than exporting that whole lookup table
// just for one value — mirrors how enemies.js already mirrors buggy.js's
// (unexported) CRATER_TYPES for the same reason.
const TANK_W = 20;

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

// Every input action; any of them wakes the attract screen.
const ACTIONS = ['accel', 'brake', 'jump', 'fire', 'pause', 'mute', 'restart'];

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
    events: [],
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
}

function updateCamera(game) {
  game.camX = game.buggy.worldX - buggyScreenX(game);
}

function anyPressed(input) {
  return ACTIONS.some((a) => input.pressed(a));
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
    if (e.x >= jumpStartX + BUGGY_W && e.x + TANK_W <= landX) {
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
  // buggy backwards.
  const cp = checkpointIndexAt(buggy.worldX);
  if (cp > game.checkpoint) {
    game.checkpoint = cp;
    game.events.push('checkpoint');
    if (!invulnerable && STAGE_BREAKS.includes(cp)) {
      enterStageClear(game, cp);
    }
  }

  if (invulnerable) return;

  const cause = checkTerrainCollision(game.buggy, game.terrain);
  // killBuggy returns false when a shield absorbed the hit, in which case
  // the buggy is still alive and the run continues.
  if (cause && killBuggy(game, cause)) {
    game.lives -= 1;
    setPhase(game, 'dying');
    resetCombo(game);
  }
}

/**
 * Enters the stageClear intermission. Z (the last STAGE_BREAKS index) is
 * the course-end case: it pays COURSE_BONUS + a par-time bonus instead of
 * the regular per-stage stageBonus(), and finishStageClear() swaps/loops
 * the course afterward rather than just incrementing `stage`.
 */
function enterStageClear(game, checkpointIdx) {
  const isCourseEnd = checkpointIdx === STAGE_BREAKS[STAGE_BREAKS.length - 1];
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
 * timer has elapsed. Non-course-end: bump `stage` and resume play in
 * place. Course-end (Z): rebuild the champion course (courseId 1, fresh —
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
 * Rebuild the buggy from scratch at the last checkpoint. A fresh createBuggy()
 * (rather than resurrecting the dead one) guarantees vy/airborne/settle/
 * wheelPhase/deathCause are all clean — updateBuggy no-ops while `alive` is
 * false, so a half-reset buggy would silently freeze.
 */
function respawn(game) {
  const buggy = createBuggy();
  buggy.worldX = checkpointX(game.checkpoint);
  game.buggy = buggy;
  game.speed = SPEED_BANDS[buggy.band];
  game.jumpStartX = null; // a jump in progress at death never lands
}

/** Mutate `game` back to a brand-new attract-screen run, in place. */
function resetToAttract(game) {
  Object.assign(game, createGame(game.mode, game.rngSeed));
}

export function updateGame(game, input, dt) {
  game.phaseTimer += dt;

  switch (game.phase) {
    case 'attract':
      if (anyPressed(input)) setPhase(game, 'playing');
      break;

    case 'playing':
      game.stageTime += dt; // stage clock runs only during live play
      updateDrive(game, input, dt, false);
      // updateDrive may have entered 'stageClear' this frame (a stage-break
      // checkpoint just crossed) — the scripted intermission owns the rest
      // of this frame instead of the usual playing-phase systems.
      if (game.phase === 'stageClear') break;
      spawnDirector(game, dt);
      updateEnemies(game, dt);
      if (input.pressed('fire')) fireDual(game);
      updateWeapons(game, dt);
      // updateDrive already handles lives/phase transition for a terrain
      // kill; this catches a kill that happened inside updateEnemies
      // (enemy shot, bomb, or chaser ram) this same frame.
      if (game.phase === 'playing' && !game.buggy.alive) {
        game.lives -= 1;
        setPhase(game, 'dying');
        resetCombo(game);
      }
      // Combo updates LAST, after every award-generating system above has
      // run this frame — any comboAction detected here (new scoreEvents,
      // a chaser dodge, a crater near-miss) raises the multiplier for
      // *next* frame's awards only, so this frame's own awards were never
      // inflated by the combo bump they themselves caused. Guarded on
      // phase still being 'playing' so a same-frame death (which already
      // called resetCombo above) doesn't immediately re-tick the timer;
      // this also means the combo timer is frozen (does not tick down)
      // during stageClear/dying/respawning/boss — only 'playing' frames
      // advance it.
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
          setPhase(game, 'gameOver');
        } else {
          respawn(game);
          setPhase(game, 'respawning');
        }
      }
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
      if (game.phaseTimer >= RESPAWN_TIME) {
        setPhase(game, 'playing');
        // Discard anything scored/evented across the whole dying+respawning
        // window (see syncComboCursors' docstring) — a death is a clean
        // slate, not a lump of free combo the instant play resumes.
        syncComboCursors(game);
      }
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
      tickStageClearTally(game);
      if (game.stageClear.paid >= game.stageClear.total && game.phaseTimer >= STAGE_CLEAR_TIME) {
        finishStageClear(game);
      }
      break;

    case 'boss':
      // Recognized phase with no behavior yet (Task 10).
      break;

    case 'gameOver':
      if (input.pressed('jump') || input.pressed('fire')) resetToAttract(game);
      break;
  }

  updateCamera(game);
}
