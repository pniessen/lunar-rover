// state.js — the game object and the phase machine that orchestrates every
// per-module update. PURE LOGIC: no DOM/canvas/audio imports, so it runs and
// is tested under `node --test`. Presentation reads `game` and consumes
// `game.events`; it never writes back.

import {
  createBuggy, updateBuggy, checkTerrainCollision, killBuggy, SPEED_BANDS,
} from './buggy.js';
import {
  buildClassicCourse, createEndlessTerrain, ensureGenerated,
  checkpointIndexAt, checkpointX,
} from './terrain.js';

export const DT = 1 / 60;          // fixed simulation timestep, seconds
export const DYING_TIME = 0.9;     // explosion hold before the respawn
export const RESPAWN_TIME = 1.0;   // invulnerable blink-in, buggy already drivable
export const VIEW_W = 384;
export const VIEW_H = 240;
export const GROUND_Y = 200;       // top of the terrain strip
export const HUD_H = 36;

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
    // Classic runs course 0 for now; course selection lands with Task 7.
    terrain: mode === 'endless' ? createEndlessTerrain(seed) : buildClassicCourse(0),
    speed: SPEED_BANDS[1],
    camX: 0,
    score: 0,
    lives: 3,
    checkpoint: 0,
    stage: 0,
    stageTime: 0,
    events: [],
    playerShots: [],
    enemyShots: [],
    enemies: [],
    capsules: [],
    powerup: null,
    combo: { count: 0, mult: 1, timer: 0 },
    rngSeed: seed,
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
 * Shared drive step for `playing` and `respawning`. During `respawning` the
 * buggy is drivable but invulnerable, so terrain collision is skipped.
 */
function updateDrive(game, input, dt, invulnerable) {
  ensureGenerated(game.terrain, game.buggy.worldX + GENERATE_AHEAD);
  updateBuggy(game, input, dt);

  // Checkpoints are monotonic — never regress after a respawn drives the
  // buggy backwards. Full checkpoint/stage progression arrives in Task 7.
  const cp = checkpointIndexAt(game.buggy.worldX);
  if (cp > game.checkpoint) game.checkpoint = cp;

  if (invulnerable) return;

  const cause = checkTerrainCollision(game.buggy, game.terrain);
  // killBuggy returns false when a shield absorbed the hit, in which case
  // the buggy is still alive and the run continues.
  if (cause && killBuggy(game, cause)) {
    game.lives -= 1;
    setPhase(game, 'dying');
  }
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
      break;

    case 'dying':
      // Buggy is dead: never call updateBuggy/killBuggy here.
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
      if (game.phaseTimer >= RESPAWN_TIME) setPhase(game, 'playing');
      break;

    case 'stageClear':
    case 'boss':
      // Recognized phases with no behavior yet (Tasks 7 and 10).
      break;

    case 'gameOver':
      if (input.pressed('jump') || input.pressed('fire')) resetToAttract(game);
      break;
  }

  updateCamera(game);
}
