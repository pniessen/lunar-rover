// weapons.js — pure-logic dual-fire weapon system (forward cannon + vertical
// gun). No DOM/canvas/audio imports: this module is Node-testable and
// consumed by the sim layer in state.js. Presentation is signaled purely via
// game.events.push('fire'|'explosion'); render.js reads game.playerShots.
//
// NOTE on the GROUND_Y import below: state.js imports `updateWeapons` from
// this module, so this file and state.js form an import cycle. That is safe
// here because GROUND_Y is only ever read inside function bodies (deferred
// to call time, after every module has finished loading) — never at this
// module's top level, which is the only place a cycle could observe an
// uninitialized (TDZ) binding.
import { GROUND_Y } from './state.js';
import { BUGGY_W } from './buggy.js';
import { destroyFeature, featuresInRange } from './terrain.js';
import { award } from './score.js';
import { pushFx } from './particles.js';

export const SHOT_SPEED_FWD = 300; // px/s, relative to world; buggy speed is added on top
export const SHOT_SPEED_UP = 260;  // px/s, upward (vy is negative)

const FWD_MAX_NORMAL = 1;
const FWD_MAX_RAPID = 3;
const UP_MAX = 4;
const SPREAD_VX = 60;
const SHOT_W_FWD = 4; // collision width, matches the 4px-wide shotFwd sprite

// Muzzle sits ~10px above the ground line, offset by buggy.y so shots spawn
// correctly mid-jump too.
const MUZZLE_Y_OFFSET = 10;

// Culling: fwd shots die once they outrun a camera-agnostic stand-in for
// camX + VIEW_W (buggy.worldX + 400, comfortably past the 384px viewport
// regardless of the buggy's screen-x drift); up shots die once they climb
// above groundTop - 240 (well above the visible sky).
const FWD_CULL_AHEAD = 400;
const UP_CULL_HEIGHT = 240;

const SHOOTABLE = new Set(['rock', 'bigRock', 'mine']);

// award() now lives in score.js (combo multiplier, extra-life grants,
// stageBonus tag handling); this module's own collideShots below uses the
// imported award directly. Every other caller (enemies.js, state.js)
// imports award from score.js directly too — score.js is the single
// source, nothing re-exports it.

function muzzleY(game) {
  return GROUND_Y + game.buggy.y - MUZZLE_Y_OFFSET;
}

/**
 * Fires the forward cannon and the vertical gun in one press, each subject
 * to its own on-screen limit. Only fires while 'playing' or 'respawning'
 * (blinking-in after a respawn is still a playable, shootable state).
 *
 * Vertical-gun capacity rule under the spread power-up: a press fires its
 * full 3-pellet fan only if doing so would not exceed the 4-shot up limit
 * (i.e. current up-shot count + 3 <= 4); otherwise the up barrel fires
 * nothing that press. This keeps the up-shot count from ever exceeding 4
 * while still matching the spec: "one press always fires its full 3-pellet
 * fan if any capacity remains" is resolved conservatively as "only if full
 * capacity for the fan remains," rather than firing a partial fan.
 */
export function fireDual(game) {
  if (game.phase !== 'playing' && game.phase !== 'respawning') return;

  const b = game.buggy;
  const rapid = game.powerup?.type === 'rapid';
  const spread = game.powerup?.type === 'spread';
  const y = muzzleY(game);
  let fired = false;

  const fwdMax = rapid ? FWD_MAX_RAPID : FWD_MAX_NORMAL;
  const fwdCount = game.playerShots.reduce((n, s) => n + (s.dir === 'fwd' ? 1 : 0), 0);
  if (fwdCount < fwdMax) {
    game.playerShots.push({
      x: b.worldX + BUGGY_W, y, vx: SHOT_SPEED_FWD, vy: 0, dir: 'fwd',
    });
    fired = true;
  }

  const upX = b.worldX + BUGGY_W / 2;
  const upCount = game.playerShots.reduce((n, s) => n + (s.dir === 'up' ? 1 : 0), 0);
  if (spread) {
    if (upCount + 3 <= UP_MAX) {
      for (const vx of [-SPREAD_VX, 0, SPREAD_VX]) {
        game.playerShots.push({ x: upX, y, vx, vy: -SHOT_SPEED_UP, dir: 'up' });
      }
      fired = true;
    }
  } else if (upCount < UP_MAX) {
    game.playerShots.push({ x: upX, y, vx: 0, vy: -SHOT_SPEED_UP, dir: 'up' });
    fired = true;
  }

  if (fired) game.events.push('fire');
}

function moveShots(game, dt) {
  for (const s of game.playerShots) {
    const speedBoost = s.dir === 'fwd' ? game.speed : 0;
    s.x += (s.vx + speedBoost) * dt;
    s.y += s.vy * dt;
  }
}

function findShootableHit(terrain, shot) {
  const x0 = shot.x;
  const x1 = shot.x + SHOT_W_FWD;
  const features = terrain.mode === 'test'
    ? terrain.features
    : featuresInRange(terrain, x0, x1);
  for (const f of features) {
    if (f.destroyed) continue;
    if (!SHOOTABLE.has(f.type)) continue;
    if (x0 < f.x + f.w && x1 > f.x) return f;
  }
  return null;
}

function collideShots(game) {
  const terrain = game.terrain;
  const kept = [];
  for (const s of game.playerShots) {
    if (s.dir !== 'fwd') { kept.push(s); continue; }
    const hit = findShootableHit(terrain, s);
    if (!hit) { kept.push(s); continue; }
    // Shot is consumed on impact regardless of whether the feature survives.
    const result = destroyFeature(terrain, hit.id);
    if (result.destroyed) {
      award(game, 100, 'rockShot');
      game.events.push('explosion');
      // Visual twin of the audio event, carrying the position game.events
      // cannot (see particles.js): centered on the destroyed feature, a
      // little above the ground line where the rock/mine actually sat.
      pushFx(game, 'boom', hit.x + hit.w / 2, GROUND_Y - 6);
    }
  }
  game.playerShots = kept;
}

function cullShots(game) {
  const cullX = game.buggy.worldX + FWD_CULL_AHEAD;
  const cullY = GROUND_Y - UP_CULL_HEIGHT;
  game.playerShots = game.playerShots.filter((s) => (
    s.dir === 'fwd' ? s.x < cullX : s.y > cullY
  ));
}

/**
 * updateWeapons(game, dt) — movement/collision/culling only. It does not
 * read input or call fireDual: state.js's game loop is responsible for
 * calling fireDual(game) itself (on input.pressed('fire')) before calling
 * this, in whichever phases firing is allowed. Keeping input handling out
 * of this function means its signature is unambiguous — no arity-sniffing,
 * no silent no-op if a caller forgets an argument.
 */
export function updateWeapons(game, dt) {
  moveShots(game, dt);
  collideShots(game);
  cullShots(game);
}
