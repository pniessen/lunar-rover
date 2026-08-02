// buggy.js — pure-logic buggy physics, movement, and terrain collision.
// No DOM/canvas/audio imports: this module is Node-testable and consumed
// by the sim/render layer in later tasks. Presentation is signaled purely
// via game.events.push('jump'|'land'|'explosion'|'shieldBreak').

import { featuresInRange } from './terrain.js';

export const SPEED_BANDS = [80, 140, 200];
export const ACCEL = 60;       // px/s^2 easing of game.speed toward the band target
export const JUMP_VY = -170;   // px/s, negative = upward impulse
export const GRAVITY = 340;    // px/s^2, pulls vy back toward/through 0 (ground)
export const BUGGY_W = 32;
export const BUGGY_H = 20;
export const SETTLE_TIME = 0.15; // seconds of post-landing settle before another jump

const CRATER_TYPES = new Set(['crater', 'bigCrater', 'doubleCrater', 'bombCrater']);
const ROCK_TYPES = new Set(['rock', 'bigRock']);

export function createBuggy() {
  return {
    worldX: 0,
    y: 0,           // vertical offset from ground; negative = above ground (airborne)
    vy: 0,
    band: 1,
    speed: SPEED_BANDS[1],
    airborne: false,
    settle: 0,
    wheelPhase: 0,
    alive: true,
    deathCause: null,
    hoverUsed: false,
  };
}

export function updateBuggy(game, input, dt) {
  const b = game.buggy;
  if (!b.alive) return;

  // Speed band changes on a fresh press, clamped to the band table's range.
  if (input.pressed('accel')) b.band = Math.min(SPEED_BANDS.length - 1, b.band + 1);
  if (input.pressed('brake')) b.band = Math.max(0, b.band - 1);

  // game.speed is the single source of truth for scroll speed; it eases
  // toward the current band's target at ACCEL px/s^2 rather than snapping.
  const target = SPEED_BANDS[b.band];
  const maxStep = ACCEL * dt;
  const diff = target - game.speed;
  game.speed += Math.abs(diff) <= maxStep ? diff : Math.sign(diff) * maxStep;
  b.speed = game.speed;

  // Jump only from a grounded, settled state — no double jump, no jump
  // immediately after landing while still settling. The hover power-up
  // grants exactly one mid-air re-boost per jump (weaker than the initial
  // launch, at 0.7x JUMP_VY) — it's consumed by hoverUsed and reset on the
  // next landing, so it can't be chained into a second boost mid-flight.
  if (!b.airborne && b.settle <= 0 && input.pressed('jump')) {
    b.vy = JUMP_VY;
    b.airborne = true;
    game.events.push('jump');
  } else if (b.airborne && game.powerup?.type === 'hover' && !b.hoverUsed && input.pressed('jump')) {
    b.vy = JUMP_VY * 0.7;
    b.hoverUsed = true;
    game.events.push('jump');
  }

  if (b.settle > 0) {
    b.settle = Math.max(0, b.settle - dt);
  }

  b.worldX += game.speed * dt;

  if (b.airborne) {
    b.vy += GRAVITY * dt;
    b.y += b.vy * dt;
    if (b.y >= 0 && b.vy >= 0) {
      b.y = 0;
      b.vy = 0;
      b.airborne = false;
      b.settle = SETTLE_TIME;
      b.hoverUsed = false;
      game.events.push('land');
    }
  } else {
    b.wheelPhase += game.speed * dt * 0.15;
  }
}

export function buggyHitbox(buggy) {
  return { x0: buggy.worldX, x1: buggy.worldX + BUGGY_W };
}

export function checkTerrainCollision(buggy, terrain) {
  if (buggy.airborne) return null;

  const hb = buggyHitbox(buggy);
  const mid = (hb.x0 + hb.x1) / 2;
  const features = terrain.mode === 'test'
    ? terrain.features
    : featuresInRange(terrain, hb.x0, hb.x1);

  for (const f of features) {
    if (f.destroyed) continue;
    if (CRATER_TYPES.has(f.type)) {
      if (mid >= f.x && mid < f.x + f.w) return 'crater';
    } else if (ROCK_TYPES.has(f.type)) {
      if (hb.x0 < f.x + f.w && hb.x1 > f.x) return 'rock';
    } else if (f.type === 'mine') {
      if (hb.x0 < f.x + f.w && hb.x1 > f.x) return 'mine';
    }
  }
  return null;
}

export function killBuggy(game, cause) {
  if (game.powerup && game.powerup.type === 'shield') {
    game.powerup = null;
    game.events.push('shieldBreak');
    return false;
  }
  game.buggy.alive = false;
  game.buggy.deathCause = cause;
  game.events.push('explosion');
  return true;
}
