// powerups.js — pure-logic power-up capsules: spawning, falling/grounding/
// expiry, buggy-overlap collection, and the active power-up's countdown
// timer. No DOM/canvas/audio imports: this module is Node-testable and
// consumed by the sim layer in state.js. Presentation is signaled purely via
// game.events.push('powerup'|'powerupEnd'); render.js reads game.capsules /
// game.powerup. Randomness is drawn only from game.waveRng, per the
// project-wide rule that all gameplay randomness flows through that single
// seeded stream (see rng.js / state.js).
//
// NOTE on the GROUND_Y import below: state.js imports updatePowerups from
// this module, so this file and state.js form an import cycle. That is safe
// here because GROUND_Y is only ever read inside function bodies (deferred
// to call time, after every module has finished loading) — never at this
// module's top level. Same pattern as weapons.js/enemies.js.
import { GROUND_Y } from './state.js';
import { BUGGY_W, BUGGY_H } from './buggy.js';

export const TYPES = ['shield', 'rapid', 'spread', 'hover'];
export const DURATIONS = {
  shield: Infinity, rapid: 10, spread: 10, hover: 15,
};

// Matches the 12x10 `capsule` sprite defined in sprites.js — duplicated here
// as plain constants (rather than importing sprites.js, a presentation
// module) so this file stays a pure-logic module with no DOM entanglement.
const CAPSULE_W = 12;
const CAPSULE_H = 10;

const FALL_SPEED = 20;       // px/s, matches the documented `vy:20`
const GROUNDED_LIFETIME = 8; // seconds a grounded, uncollected capsule survives

/**
 * spawnCapsule(game, x, y, type?) — pushes a new falling capsule onto
 * game.capsules. `type` is optional; when omitted it is picked uniformly
 * from TYPES via game.waveRng (the only permitted source of randomness in
 * this module). Passing an explicit type lets callers (e.g. the Task 12
 * boss drop) force a specific power-up instead of relying on chance.
 */
export function spawnCapsule(game, x, y, type) {
  const resolvedType = type ?? TYPES[Math.floor(game.waveRng() * TYPES.length)];
  game.capsules.push({
    x, y, vy: FALL_SPEED, type: resolvedType, grounded: false, groundedTime: 0,
  });
}

/** True if `game.buggy`'s current body box overlaps the capsule's box. */
function buggyOverlapsCapsule(game, capsule) {
  const b = game.buggy;
  const x0 = b.worldX;
  const x1 = b.worldX + BUGGY_W;
  const overlapsX = x0 < capsule.x + CAPSULE_W && x1 > capsule.x;
  if (!overlapsX) return false;

  // Buggy body vertical span, mirroring enemies.js's buggyBox: GROUND_Y
  // shifted by buggy.y (negative while airborne) gives the buggy's current
  // ground-contact line; BUGGY_H extends the box upward from there. A
  // grounded buggy's box always brackets a grounded capsule (both sit at
  // GROUND_Y), which is what makes "grounded buggy always collects on
  // x-overlap" true without any special-casing here.
  const by0 = GROUND_Y + b.y - BUGGY_H;
  const by1 = GROUND_Y + b.y;
  const cy0 = capsule.y;
  const cy1 = capsule.y + CAPSULE_H;
  return by0 < cy1 && by1 > cy0;
}

/**
 * applyPowerup(game, type) — sets the active power-up, replacing whatever
 * (if anything) was active before. Does not itself push a 'powerup' event —
 * that is the collection path's job in updatePowerups, so direct callers
 * (tests, a future boss guaranteed-drop path) can apply a power-up without
 * implying a capsule was just collected.
 */
export function applyPowerup(game, type) {
  game.powerup = { type, remaining: DURATIONS[type] };
}

/**
 * updatePowerups(game, dt) — advances every capsule (fall -> ground ->
 * expire-or-collect) and ticks the active power-up's countdown.
 *
 * Capsule movement/grounding/expiry runs unconditionally whenever this is
 * called; collection is additionally gated to 'playing'/'respawning' (a
 * capsule collected mid-death or mid-intermission would be a confusing
 * freebie). The active power-up's remaining-time countdown only ticks
 * during 'playing' — this mirrors the combo timer's phase gating in
 * state.js (frozen during stageClear/dying/respawning/boss) and matches the
 * shield's existing "duration" of Infinity: it can only ever end by being
 * consumed in killBuggy, never by a clock.
 *
 * state.js is expected to call this during 'playing' (full behavior) and
 * 'respawning' (movement + collection, no tick — player-friendly, matches
 * fireDual/updateWeapons already running during respawning). It is *not*
 * called during 'dying'/'stageClear'/'boss': capsules simply pause falling
 * for those few frames, which is an acceptable, documented simplification
 * rather than a hazard (nothing depends on capsules moving during a scripted
 * intermission or an explosion hold).
 */
export function updatePowerups(game, dt) {
  // Tick the power-up that was already active *before* this frame's capsule
  // pass runs, so a capsule collected this very frame starts its countdown
  // fresh next frame rather than immediately losing one dt of its duration.
  if (game.powerup && game.phase === 'playing' && Number.isFinite(game.powerup.remaining)) {
    game.powerup.remaining -= dt;
    if (game.powerup.remaining <= 0) {
      game.powerup = null;
      game.events.push('powerupEnd');
    }
  }

  const collectionAllowed = game.phase === 'playing' || game.phase === 'respawning';
  const groundY = GROUND_Y - CAPSULE_H;
  const kept = [];

  for (const c of game.capsules) {
    if (!c.grounded) {
      c.y += c.vy * dt;
      if (c.y >= groundY) {
        c.y = groundY;
        c.grounded = true;
      }
    } else {
      c.groundedTime += dt;
      if (c.groundedTime >= GROUNDED_LIFETIME) continue; // expired, drop silently
    }

    if (collectionAllowed && buggyOverlapsCapsule(game, c)) {
      applyPowerup(game, c.type);
      game.events.push('powerup');
      continue; // collected, drop from the list
    }

    kept.push(c);
  }
  game.capsules = kept;
}
