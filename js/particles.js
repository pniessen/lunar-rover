// particles.js — the chunky-arcade particle pool (Task 14) plus `pushFx`,
// the tiny writer for the parallel `game.fx` visual-event channel.
//
// PURITY / DETERMINISM
// --------------------
// No DOM, no canvas, no imports at all: this module is Node-testable and
// safe to import from both the pure sim modules (state/enemies/weapons/boss,
// for pushFx) and the renderer (for the pool itself) without creating an
// import cycle.
//
// The pool is a *fixed-size* ring: createParticles(max) allocates every slot
// up front and nothing is ever allocated again. emit() writes into slots
// round-robin, so an emission past capacity recycles the oldest slots rather
// than growing the array or silently dropping particles.
//
// Randomness: particle scatter uses a cheap internal LCG (`rand` below)
// seeded ONCE per pool, never Math.random() and never Date.now(). Particles
// are presentation-only — the simulation never reads a particle back — but a
// seeded stream keeps the renderer reproducible (identical replays look
// identical) and keeps this module unit-testable.
//
// COORDINATES
// -----------
// `x` is a WORLD x (drawn at x - camX, so particles scroll with the ground
// they were emitted from) and `y` is a SCREEN y, exactly like every entity
// in the game (see enemies.js/weapons.js). Velocities are px/s; `gravity` is
// px/s^2 applied to vy.
//
// EVENTS vs FX
// ------------
// `game.events` (strings) is the AUDIO channel — untouched by this task.
// `game.fx` ({kind,x,y}) is the parallel VISUAL channel this module writes:
// it carries the positions the string events never had. render.js consumes
// and clears game.fx every frame, mapping each entry to a particle burst and
// a screen-shake magnitude. Adding positions to game.events instead would
// have meant rewriting every audio handler and its tests, so the two stay
// deliberately split.

/** Particles emitted per emit() call, by kind. */
export const PARTICLE_COUNTS = {
  dust: 2,
  muzzle: 3,
  boom: 16,
  spark: 10,
};

/** How many of a boom's 16 chunks form the bright, slow core (see emit). */
const BOOM_CORE = 5;

// Chunky arcade palettes — few colors, high contrast, no soft gradients.
// Every value is an entry of the M52 SPRITE palette PROM (`mpc-1.1f`), whose
// DAC carries a 470-ohm pulldown: particles are world-layer effects, so like
// every other sprite they top out at #C1C8C8 and can never be pure white.
// The dust ramp is keyed to the terrain strip and moved with it when the
// ground went from the old hot pink to the authentic #FF9751 peach.
// See .superpowers/notes/authenticity-research.md §3.1.
const BOOM_COLORS = ['#C1C8C8', '#C1C800', '#C19000', '#C10000'];
const DUST_COLORS = ['#C19000', '#845100', '#C1C800'];
const MUZZLE_COLORS = ['#C1C8C8', '#C1C800'];
const SPARK_COLORS = ['#C1C8C8', '#3E90C8', '#00AEC8'];

/**
 * @param {number} [max=256] pool capacity — the hard ceiling on particles
 *   alive at once. 256 covers several simultaneous booms (16 each) with room
 *   to spare at the 384x240 buffer size.
 */
export function createParticles(max = 256) {
  const items = new Array(max);
  for (let i = 0; i < max; i++) {
    items[i] = {
      active: false,
      x: 0, y: 0, vx: 0, vy: 0,
      gravity: 0,
      life: 0, maxLife: 0,
      size: 1,
      color: '#C1C8C8',
    };
  }
  return { max, items, cursor: 0, rngState: 0x9e3779b9 };
}

/**
 * Cheap seeded PRNG, seeded once per pool. This is mulberry32's step
 * (the same generator rng.js uses for terrain/waves), inlined rather than
 * imported so this module keeps zero dependencies.
 *
 * A plain LCG was tried first and had to go: consecutive LCG outputs fall on
 * hyperplanes, and because a boom consumes 5 draws per particle (angle,
 * speed, upward bias, size, color) that correlation was directly visible —
 * the 16 chunks came out arranged along a diagonal lattice instead of
 * scattering. mulberry32's avalanche mixing kills it.
 */
export function poolRandom(pool) {
  pool.rngState = (pool.rngState + 0x6D2B79F5) >>> 0;
  let t = pool.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const rand = poolRandom;

/** Uniform in [lo, hi). */
function range(pool, lo, hi) {
  return lo + rand(pool) * (hi - lo);
}

function pick(pool, arr) {
  return arr[Math.floor(rand(pool) * arr.length) % arr.length];
}

/**
 * Claims the next slot in the ring (recycling the oldest if the pool is
 * full) and writes one particle into it.
 */
function spawn(pool, x, y, vx, vy, gravity, life, size, color) {
  const it = pool.items[pool.cursor];
  pool.cursor = (pool.cursor + 1) % pool.max;
  it.active = true;
  it.x = x;
  it.y = y;
  it.vx = vx;
  it.vy = vy;
  it.gravity = gravity;
  it.life = life;
  it.maxLife = life;
  it.size = size;
  it.color = color;
  return it;
}

/**
 * emit(pool, kind, x, y) — spawn one burst. Returns the number of particles
 * written (0 for an unknown kind).
 *
 *  - 'boom'   16 chunky 2-3px squares thrown radially and pulled down by
 *             gravity: the explosion/bomb-impact/death burst.
 *  - 'dust'   2 small puffs kicked backwards off the wheels — subtle, used
 *             continuously while grounded at the top speed band.
 *  - 'muzzle' 3 fast, very short-lived flecks straight ahead of the cannon.
 *  - 'spark'  10 light scatter with barely any gravity — a boss taking a hit.
 */
export function emit(pool, kind, x, y) {
  switch (kind) {
    case 'boom': {
      // The 16 chunks are split into a bright, near-stationary CORE and the
      // shrapnel that flies off it. Without the core, a burst that has to
      // spread far enough to read as an explosion is already sparse by the
      // second frame and looks like confetti; the core gives the first ~0.15s
      // a solid hot centre for the shrapnel to leave behind.
      for (let i = 0; i < BOOM_CORE; i++) {
        const a = range(pool, 0, Math.PI * 2);
        const sp = range(pool, 0, 22);
        spawn(
          pool, x + range(pool, -2, 2), y + range(pool, -2, 2),
          Math.cos(a) * sp, Math.sin(a) * sp,
          40,
          range(pool, 0.10, 0.20),
          4,
          rand(pool) < 0.5 ? '#C1C8C8' : '#C1C800',
        );
      }
      for (let i = BOOM_CORE; i < PARTICLE_COUNTS.boom; i++) {
        const a = range(pool, 0, Math.PI * 2);
        const sp = range(pool, 20, 90);
        spawn(
          pool, x, y,
          Math.cos(a) * sp,
          Math.sin(a) * sp - range(pool, 5, 35), // slight upward bias, so it arcs
          260,
          range(pool, 0.30, 0.70),
          rand(pool) < 0.5 ? 3 : 2,
          pick(pool, BOOM_COLORS),
        );
      }
      return PARTICLE_COUNTS.boom;
    }
    case 'dust': {
      for (let i = 0; i < PARTICLE_COUNTS.dust; i++) {
        spawn(
          pool, x + range(pool, -3, 3), y,
          range(pool, -55, -18),
          range(pool, -26, -6),
          70,
          range(pool, 0.22, 0.45),
          rand(pool) < 0.3 ? 2 : 1,
          pick(pool, DUST_COLORS),
        );
      }
      return PARTICLE_COUNTS.dust;
    }
    case 'muzzle': {
      for (let i = 0; i < PARTICLE_COUNTS.muzzle; i++) {
        spawn(
          pool, x, y + range(pool, -2, 2),
          range(pool, 130, 230),
          range(pool, -18, 18),
          0,
          range(pool, 0.05, 0.12),
          2,
          pick(pool, MUZZLE_COLORS),
        );
      }
      return PARTICLE_COUNTS.muzzle;
    }
    case 'spark': {
      for (let i = 0; i < PARTICLE_COUNTS.spark; i++) {
        const a = range(pool, 0, Math.PI * 2);
        const sp = range(pool, 40, 145);
        spawn(
          pool, x, y,
          Math.cos(a) * sp,
          Math.sin(a) * sp,
          45,
          range(pool, 0.18, 0.42),
          2,
          pick(pool, SPARK_COLORS),
        );
      }
      return PARTICLE_COUNTS.spark;
    }
    default:
      return 0;
  }
}

/**
 * Ages every live particle by `dt` and integrates it. A particle whose life
 * reaches 0 is deactivated in place — its slot stays in the array and is
 * immediately reusable by the next emit().
 */
export function updateParticles(pool, dt) {
  const items = pool.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.active) continue;
    it.life -= dt;
    if (it.life <= 0) {
      it.active = false;
      it.life = 0;
      continue;
    }
    it.vy += it.gravity * dt;
    it.x += it.vx * dt;
    it.y += it.vy * dt;
  }
}

/** Number of live particles — diagnostics and tests. */
export function activeCount(pool) {
  let n = 0;
  for (let i = 0; i < pool.items.length; i++) if (pool.items[i].active) n++;
  return n;
}

/**
 * pushFx(game, kind, x, y) — the sim-side writer for the visual event
 * channel (see the EVENTS vs FX note at the top of this file). Kinds are
 * render.js's FX_TABLE keys: 'boom', 'bombHit', 'bossDown', 'spark'.
 * Deliberately tolerant: a hand-built test `game` with no fx array gets one,
 * and a missing game is a no-op, so no pure-logic caller ever has to guard.
 */
export function pushFx(game, kind, x, y) {
  if (!game) return;
  if (!game.fx) game.fx = [];
  game.fx.push({ kind, x, y });
}
