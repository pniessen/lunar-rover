import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSpriteScreenX, consumeFx } from '../js/render.js';
import { createParticles, emit, activeCount, pushFx } from '../js/particles.js';
import { sweepOffsetAt, BOSS_W } from '../js/boss.js';
import { buggyScreenX, VIEW_W, DT } from '../js/state.js';
import { SPEED_BANDS } from '../js/buggy.js';

// --- clampSpriteScreenX (cosmetic-polish: boss clips off-canvas) -----------

test('clampSpriteScreenX leaves an already-on-screen sprite untouched', () => {
  assert.equal(clampSpriteScreenX(100, 48), 100);
  assert.equal(clampSpriteScreenX(0, 48), 0);
  assert.equal(clampSpriteScreenX(VIEW_W - 48, 48), VIEW_W - 48);
});

test('clampSpriteScreenX pulls a left-clipping sprite fully on screen', () => {
  assert.equal(clampSpriteScreenX(-4, 48), 0, 'the reported band-0 sweep-extreme case');
  assert.equal(clampSpriteScreenX(-100, 48), 0);
});

test('clampSpriteScreenX pulls a right-clipping sprite fully on screen', () => {
  assert.equal(clampSpriteScreenX(VIEW_W - 10, 48), VIEW_W - 48);
});

test('clampSpriteScreenX never asks for a negative width, even for a sprite wider than the viewport', () => {
  // Degenerate input a real sprite never hits, but the clamp shouldn't flip
  // min/max and produce something worse than doing nothing.
  const sx = clampSpriteScreenX(10, VIEW_W + 50);
  assert.ok(Number.isFinite(sx));
});

// The boss sprite (boss1/boss2) is documented as 48x15 (BUILD-LOG.md, the
// FIGHT GEOMETRY / hitbox notes in boss.js) and matches boss.js's exported
// BOSS_W exactly (its collision box is sized off the real sprite). render.js
// itself only ever learns the width from the rasterized sprite image, which
// needs a real canvas, so this test uses the pure constant instead.

test('the boss sweep stays fully on screen at every point of a full period, at every speed band', () => {
  // Reproduces render.js's drawBoss screen-x math exactly (sx = boss.x - camX
  // === sweepOffsetAt(t) + buggyScreenX(game), since boss.x = buggy.worldX +
  // sweepOffsetAt(t) and camX = buggy.worldX - buggyScreenX(game)) without
  // needing a canvas, then clamps it — this is the whole fix for "boss clips
  // ~4px off-canvas at band-0 sweep extreme": a render-side clamp that never
  // touches the world-space sweep the up-gun overlap window depends on.
  const SWEEP_PERIOD = 4.2; // mirrors boss.js's SWEEP_PERIOD (not exported)
  for (const speed of SPEED_BANDS) {
    const game = { speed };
    const screenX = buggyScreenX(game);
    let sawOffCanvasBeforeClamp = false;
    for (let t = 0; t <= SWEEP_PERIOD; t += SWEEP_PERIOD / 500) {
      const rawSx = sweepOffsetAt(t) + screenX;
      if (rawSx < 0 || rawSx + BOSS_W > VIEW_W) sawOffCanvasBeforeClamp = true;
      const sx = clampSpriteScreenX(Math.round(rawSx), BOSS_W);
      assert.ok(sx >= 0, `band ${speed}px/s, t=${t.toFixed(2)}: left edge on screen (sx=${sx})`);
      assert.ok(sx + BOSS_W <= VIEW_W,
        `band ${speed}px/s, t=${t.toFixed(2)}: right edge on screen (sx=${sx})`);
    }
    if (speed === SPEED_BANDS[0]) {
      assert.ok(sawOffCanvasBeforeClamp,
        'sanity check: band 0 really does clip before the clamp, confirming this test would catch a regression');
    }
  }
});

// --- consumeFx pause freeze (cosmetic-polish: particles/shake animate while
// paused) --------------------------------------------------------------

function fakeRenderer() {
  return {
    particles: createParticles(64),
    shake: 0,
    shakeX: 0,
    shakeY: 0,
    dustCarry: 0,
    lastWorldX: null,
  };
}

function fakeGame() {
  return {
    fx: [],
    events: [],
    buggy: { worldX: 0, y: 0, airborne: false, alive: true, band: 2 },
    phase: 'playing',
  };
}

test('consumeFx(simDt=0) leaves every live particle completely unchanged', () => {
  const r = fakeRenderer();
  const game = fakeGame();
  emit(r.particles, 'boom', 100, 50);
  const before = r.particles.items.map((it) => ({ ...it }));

  consumeFx(r, game, 0);

  assert.deepEqual(r.particles.items, before, 'no position/life/velocity integration happened at simDt=0');
});

test('consumeFx(simDt=0) does not re-roll the shake offset, only consumeFx(simDt>0) decays and re-rolls it', () => {
  const r = fakeRenderer();
  const game = fakeGame();
  r.shake = 10;
  r.shakeX = 3;
  r.shakeY = -4;

  consumeFx(r, game, 0);
  assert.equal(r.shake, 10, 'magnitude does not decay at simDt=0');
  assert.equal(r.shakeX, 3, 'offset is not re-rolled at simDt=0 (would otherwise jitter every paused frame)');
  assert.equal(r.shakeY, -4);

  consumeFx(r, game, DT);
  assert.ok(r.shake < 10, 'magnitude decays once real sim time elapses');
});

test('consumeFx(simDt=0) still drains game.fx (a paused frame never leaves fx entries queued)', () => {
  const r = fakeRenderer();
  const game = fakeGame();
  pushFx(game, 'boom', 10, 20);

  consumeFx(r, game, 0);

  assert.equal(game.fx.length, 0, 'fx is consumed even when the effect layer does not age');
  assert.ok(activeCount(r.particles) > 0, 'the burst it was told about still spawned');
});
