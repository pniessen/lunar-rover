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

// The boss's guaranteed drop falls far faster than a regular capsule (finding
// I4): a 20px/s drift from the mothership's hover altitude would take ~6
// seconds to reach the ground, by which time the buggy is ~1200px past it.
const BOSS_DROP_VY = 120;

// Phases in which a capsule the buggy is overlapping is actually picked up —
// every phase where the buggy is on the ground and moving. See updatePowerups.
const COLLECT_PHASES = new Set(['playing', 'respawning', 'boss', 'stageClear']);

/**
 * spawnCapsule(game, x, y, type?) — pushes a new falling capsule onto
 * game.capsules. `type` is optional; when omitted it is picked uniformly
 * from TYPES via game.waveRng (the only permitted source of randomness in
 * this module). Passing an explicit type lets callers (e.g. the Task 12
 * boss drop) force a specific power-up instead of relying on chance.
 */
export function spawnCapsule(game, x, y, type, vy = FALL_SPEED) {
  const resolvedType = type ?? TYPES[Math.floor(game.waveRng() * TYPES.length)];
  game.capsules.push({
    x, y, vy, type: resolvedType, grounded: false, groundedTime: 0,
  });
}

/**
 * spawnBossCapsule(game, y) — the mothership's guaranteed drop (finding I4).
 *
 * A boss can die anywhere in its sweep, including *behind* the buggy, and it
 * dies high up. Dropping the capsule at the boss's own position therefore
 * produced a pod that was unreachable by construction: it drifted down at
 * 20px/s for six seconds while the buggy drove ~1200px away from it, then
 * expired uncollected. Instead the pod is ejected forward, on a fast fall,
 * with the lead computed so it touches down exactly where the buggy will be:
 * lead = speed * fallTime. The buggy keeps scrolling through the whole
 * bossDown -> stageClear tally (and updatePowerups now runs, and collects,
 * during 'boss'/'stageClear' — see below), so it drives straight into it;
 * GROUNDED_LIFETIME then leaves 8 more seconds of slack if the tally's timing
 * or a mid-fight death shifts things.
 */
export function spawnBossCapsule(game, y, type) {
  const fallTime = Math.max(0, (GROUND_Y - CAPSULE_H - y)) / BOSS_DROP_VY;
  const lead = Math.max(80, game.speed * fallTime);
  spawnCapsule(game, game.buggy.worldX + lead, y, type, BOSS_DROP_VY);
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
 * called; collection is additionally gated to the phases where the player is
 * actually driving the buggy: 'playing', 'respawning', 'boss' and
 * 'stageClear'.
 *
 * 'boss'/'stageClear' were added by finding I4. The boss's guaranteed drop
 * lands during exactly those two phases, so with them excluded the pod froze
 * mid-air through the whole ~2.5s tally, ended up hundreds of px behind the
 * buggy, and expired — the "guaranteed" reward was unobtainable. During
 * 'stageClear' the buggy is on rails (NOOP_INPUT) but still scrolling
 * forward, so driving into the pod is exactly what happens; letting it be
 * picked up there is the whole point of the fix, not a freebie.
 *
 * The active power-up's remaining-time countdown still only ticks during
 * 'playing'. That is deliberate: a rapid/spread timer does not burn down
 * while the run is on rails (stageClear), blinking in (respawning) or —
 * player-friendly, and matching how the boss arena is a scripted set-piece —
 * during a boss fight. It also matches the shield's "duration" of Infinity:
 * a shield only ever ends by being consumed in killBuggy, never by a clock.
 *
 * state.js calls this during 'playing' (full behavior), 'respawning', 'boss'
 * and 'stageClear' (movement + collection, no tick). It is still *not* called
 * during 'dying': capsules simply pause for the explosion hold, an acceptable
 * documented simplification.
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

  const collectionAllowed = COLLECT_PHASES.has(game.phase);
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
