// terrain.js — pure-logic terrain/feature system for both the classic
// (26-checkpoint) course and the endless mode. No DOM/canvas/audio
// imports: this module is Node-testable and consumed by the sim layer
// in later tasks.
//
// A `terrain` object looks like:
//   { features: Feature[] (x-sorted), nextId, generatedTo, mode, courseId?, seed? }
// A `Feature` looks like: { id, type, x, w, hp, destroyed }
//
// Design note for `clearNaturalZone(terrain, x0, x1)` (Task 12, below):
// features live in a flat, x-sorted array keyed by stable numeric `id`, so
// removing every feature whose range overlaps [x0,x1) is a simple
// filter/scan — no separate per-segment bookkeeping to unwind.

import { mulberry32 } from './rng.js';

export const CHECKPOINT_SPACING = 1200;
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const STAGE_BREAKS = [4, 9, 14, 19, 25]; // indices of E, J, O, T, Z
export const FEATURE_W = {
  crater: 24,
  bigCrater: 40,
  doubleCrater: 56,
  rock: 16,
  bigRock: 22,
  mine: 12,
  bombCrater: 28,
};

const NUM_CHECKPOINTS = LETTERS.length; // 26 (segments 0..25, courses span 26*CHECKPOINT_SPACING)
const GAP = 100; // px between features within a generated recipe (>= required 80px minimum)
const SEGMENT_TAIL_BUFFER = 50; // don't let features run within this many px of the segment end

function hpFor(type) {
  if (type === 'rock') return 1;
  if (type === 'bigRock') return 2;
  return 0;
}

// --- checkpoint helpers -----------------------------------------------

export function checkpointX(i) {
  return i * CHECKPOINT_SPACING;
}

export function checkpointIndexAt(x) {
  let i = Math.floor(x / CHECKPOINT_SPACING);
  if (i < 0) i = 0;
  if (i > NUM_CHECKPOINTS - 1) i = NUM_CHECKPOINTS - 1;
  return i;
}

// 0-indexed difficulty tier (0..4) grouping segments A-E, F-J, K-O, P-T, U-Z.
function tierOfSegment(i) {
  for (let s = 0; s < STAGE_BREAKS.length; s++) {
    if (i <= STAGE_BREAKS[s]) return s;
  }
  return STAGE_BREAKS.length - 1;
}

// Mines are gated independently of the general difficulty tier: they
// start appearing at checkpoint J (segment index 9) onward.
function minesAllowedForSegment(i) {
  return i >= 9;
}

// --- classic course template pools -------------------------------------
// Each recipe is a list of feature type names; offsets are computed by
// layoutRecipe() so gaps and widths never need hand-tuning per template.

const TIER_RECIPES = [
  // tier 0: A-E — sparse, no mines
  [
    ['crater'],
    ['bigRock'],
    ['crater', 'rock'],
    ['rock', 'crater', 'rock'],
    ['bigCrater', 'rock'],
    ['rock', 'bigRock'],
  ],
  // tier 1: F-J — busier; mines only actually used from segment index 9 (J)
  [
    ['crater', 'rock'],
    ['bigRock', 'crater'],
    ['rock', 'rock', 'crater'],
    ['bigCrater', 'rock'],
    ['mine', 'crater'],
    ['crater', 'mine', 'rock'],
  ],
  // tier 2: K-O
  [
    ['mine', 'rock'],
    ['crater', 'mine', 'rock'],
    ['bigRock', 'mine', 'crater'],
    ['mine', 'bigCrater'],
    ['rock', 'mine', 'crater', 'rock'],
  ],
  // tier 3: P-T
  [
    ['mine', 'crater', 'mine'],
    ['bigRock', 'mine', 'rock'],
    ['mine', 'bigRock', 'crater'],
    ['crater', 'mine', 'bigRock'],
    ['mine', 'rock', 'mine', 'crater'],
  ],
  // tier 4: U-Z
  [
    ['mine', 'mine', 'rock'],
    ['bigRock', 'mine', 'crater'],
    ['mine', 'crater', 'mine', 'rock'],
    ['mine', 'bigCrater', 'mine'],
    ['rock', 'mine', 'bigRock', 'mine'],
  ],
];

// Extra champion-only (courseId=1) recipes layered onto tiers >= 1,
// introducing doubleCrater from stage 1 onward.
const CHAMPION_EXTRA_RECIPES = [
  null, // tier 0: no doubleCrater
  [['doubleCrater', 'rock'], ['crater', 'doubleCrater']],
  [['doubleCrater', 'mine'], ['mine', 'doubleCrater', 'rock']],
  [['mine', 'doubleCrater'], ['doubleCrater', 'mine', 'rock']],
  [['doubleCrater', 'mine', 'rock'], ['mine', 'doubleCrater', 'mine']],
];

function layoutRecipe(recipe, startOffset) {
  let x = startOffset;
  const out = [];
  for (const type of recipe) {
    const w = FEATURE_W[type];
    if (x + w > CHECKPOINT_SPACING - SEGMENT_TAIL_BUFFER) break;
    out.push({ off: x, type });
    x += w + GAP;
  }
  return out;
}

function buildSegmentFeatures(courseId, index, rng) {
  const tier = tierOfSegment(index);
  let pool = TIER_RECIPES[tier].slice();
  if (courseId === 1 && tier >= 1 && CHAMPION_EXTRA_RECIPES[tier]) {
    pool = pool.concat(CHAMPION_EXTRA_RECIPES[tier]);
  }
  if (!minesAllowedForSegment(index)) {
    pool = pool.filter((r) => !r.includes('mine'));
  }
  if (pool.length === 0) pool = [[]];

  const pick = pool[Math.floor(rng() * pool.length)];
  let recipe = pick.slice();

  if (courseId === 1) {
    // Champion course: one extra feature per segment.
    const extraTypes = minesAllowedForSegment(index)
      ? ['crater', 'rock', 'mine']
      : ['crater', 'rock'];
    recipe = recipe.concat([extraTypes[Math.floor(rng() * extraTypes.length)]]);
  }

  // Respawns must always land on clear road, so every segment keeps its
  // first 300px feature-free (state.js's respawn() docstring cites this
  // guarantee). This used to be Math.max(300, index === 0 ? 200 : 150) — a
  // per-segment minOffset that never mattered, since both 200 and 150 are
  // already <= 300 and Math.max always picked 300. Collapsed to the actual
  // constant it always computed.
  const startOffset = 300;
  return layoutRecipe(recipe, startOffset);
}

export function buildClassicCourse(courseId) {
  const features = [];
  let nextId = 1;
  for (let i = 0; i < NUM_CHECKPOINTS; i++) {
    const rng = mulberry32(courseId * 1000 + i);
    const segFeatures = buildSegmentFeatures(courseId, i, rng);
    const baseX = i * CHECKPOINT_SPACING;
    for (const f of segFeatures) {
      features.push({
        id: nextId++,
        type: f.type,
        x: baseX + f.off,
        w: FEATURE_W[f.type],
        hp: hpFor(f.type),
        destroyed: false,
      });
    }
  }
  features.sort((a, b) => a.x - b.x);
  return {
    features,
    nextId,
    generatedTo: NUM_CHECKPOINTS * CHECKPOINT_SPACING,
    mode: 'classic',
    courseId,
  };
}

// --- endless terrain -----------------------------------------------------

const ENDLESS_TYPES_NO_MINE = ['crater', 'bigCrater', 'rock', 'bigRock'];
const ENDLESS_TYPES_WITH_MINE = ['crater', 'bigCrater', 'rock', 'bigRock', 'mine'];

function buildChunkFeatures(seed, chunkIndex) {
  const rng = mulberry32(seed * 1000000 + chunkIndex);
  const difficulty = chunkIndex * 0.15;
  const count = Math.min(6, 2 + Math.floor(difficulty));
  const types = chunkIndex >= 6 ? ENDLESS_TYPES_WITH_MINE : ENDLESS_TYPES_NO_MINE;
  // Same 300px clear-road guarantee as buildSegmentFeatures above (and the
  // same collapsed-dead-conditional history — see that function's comment).
  const startOffset = 300;

  let x = startOffset;
  const out = [];
  for (let k = 0; k < count; k++) {
    const type = types[Math.floor(rng() * types.length)];
    const w = FEATURE_W[type];
    if (x + w > CHECKPOINT_SPACING - SEGMENT_TAIL_BUFFER) break;
    out.push({ off: x, type });
    x += w + GAP;
  }
  return out;
}

export function createEndlessTerrain(seed) {
  return {
    features: [],
    nextId: 1,
    generatedTo: 0,
    mode: 'endless',
    seed,
  };
}

export function ensureGenerated(terrain, upToX) {
  if (terrain.mode !== 'endless') return; // no-op for classic
  while (terrain.generatedTo < upToX) {
    const chunkIndex = terrain.generatedTo / CHECKPOINT_SPACING;
    const baseX = terrain.generatedTo;
    const chunkFeatures = buildChunkFeatures(terrain.seed, chunkIndex);
    for (const f of chunkFeatures) {
      terrain.features.push({
        id: terrain.nextId++,
        type: f.type,
        x: baseX + f.off,
        w: FEATURE_W[f.type],
        hp: hpFor(f.type),
        destroyed: false,
      });
    }
    terrain.generatedTo += CHECKPOINT_SPACING;
  }
  terrain.features.sort((a, b) => a.x - b.x);
}

// --- queries / mutations --------------------------------------------------

export function featuresInRange(terrain, x0, x1) {
  return terrain.features.filter((f) => f.x < x1 && f.x + f.w > x0);
}

function overlapsCheckpointLine(x, w) {
  const k0 = Math.floor(x / CHECKPOINT_SPACING);
  for (const k of [k0, k0 + 1]) {
    if (k < 1) continue; // the course start line (index 0) isn't guarded here
    const m = k * CHECKPOINT_SPACING;
    if (x < m + 40 && x + w > m - 40) return true;
  }
  return false;
}

export function addBombCrater(terrain, x) {
  const w = FEATURE_W.bombCrater;
  if (overlapsCheckpointLine(x, w)) return null;

  const collides = terrain.features.some(
    (f) => !f.destroyed && f.x < x + w && f.x + f.w > x
  );
  if (collides) return null;

  const feature = { id: terrain.nextId++, type: 'bombCrater', x, w, hp: 0, destroyed: false };
  terrain.features.push(feature);
  terrain.features.sort((a, b) => a.x - b.x);
  return feature;
}

// Every feature type the generators above can emit. `bombCrater` is the one
// type NOT in here: it is not generated terrain at all, it is the scar a
// bomb leaves on impact (see addBombCrater), and the boss arena depends on
// that distinction — see clearNaturalZone.
export const NATURAL_TYPES = new Set([
  'crater', 'bigCrater', 'doubleCrater', 'rock', 'bigRock', 'mine',
]);

/**
 * clearNaturalZone(terrain, x0, x1) — removes every NATURALLY GENERATED
 * feature overlapping [x0, x1) outright (rather than merely marking it
 * `destroyed`), so a boss arena (Task 12) is guaranteed free of both live
 * and rubble hazards — a `destroyed` feature still occupies a slot
 * `featuresInRange` would return, which callers elsewhere (e.g. jump-over
 * scoring) treat specially, so a clean removal is the least surprising way
 * to guarantee "nothing here."
 *
 * It deliberately does NOT touch `bombCrater` features, and that exclusion
 * is load-bearing rather than incidental. state.js re-applies this every
 * frame of a boss fight over a window that runs ~800px ahead of the buggy
 * (see maintainBossArena), while the boss's own carpet lands 260-530px
 * ahead (BOMB_OFFSETS) — squarely inside that window. A type-blind sweep
 * would therefore delete each crater within a frame or two of it opening
 * and erase the boss's entire ground attack, turning the fight into a
 * shooting gallery. The arena clears the LEVEL, not the fight.
 */
export function clearNaturalZone(terrain, x0, x1) {
  terrain.features = terrain.features.filter(
    (f) => !(NATURAL_TYPES.has(f.type) && f.x < x1 && f.x + f.w > x0),
  );
}

export function destroyFeature(terrain, id) {
  const f = terrain.features.find((feat) => feat.id === id);
  if (!f) return { destroyed: false, type: undefined };
  if (f.destroyed) return { destroyed: true, type: f.type };

  if (f.hp > 0) {
    f.hp -= 1;
    if (f.hp <= 0) f.destroyed = true;
  } else {
    f.destroyed = true;
  }
  return { destroyed: f.destroyed, type: f.type };
}
