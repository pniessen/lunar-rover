// rng.js — deterministic seeded PRNG. Pure logic: no DOM/canvas/audio
// imports, Node-testable in isolation. Used by terrain.js so the same
// seed always yields the same course/chunk layout.

// Standard mulberry32 32-bit PRNG. Returns a function that produces
// floats in [0, 1) on each call, deterministic for a given seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
