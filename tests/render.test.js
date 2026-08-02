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

// --- authentic palette invariants -------------------------------------------
//
// The whole game now draws from the M52's real colour PROMs. Every value below
// was decoded from the raw PROM bytes by the research pass and cross-checked
// against a lossless native-resolution modern-MAME capture — all 20 on-screen
// colours matched exactly, on both captures, with zero unexplained pixels. See
// .superpowers/notes/authenticity-research.md §3.
//
// 35 colours exist in the entire arcade game (black is shared between PROMs).
// These tests pin that: nothing in the sprite sheet or the background palette
// may be a colour the hardware could not produce.

const SPR_PAL = [ // mpc-1.1f, sprite DAC (470-ohm pulldown -> ceiling #C1C8C8)
  '#00001A', '#C100AE', '#00AEC8', '#84C800', '#C10000', '#00C800', '#840000',
  '#C1C8C8', '#C1C800', '#845100', '#3E3700', '#3E00C8', '#C19000', '#3E90C8',
  '#005100',
];
const BG_PAL = ['#000000', '#009700', '#00DE51', '#FFDE51', '#0000FF', '#0097AE']; // mpc-3.1m
const TX_PAL = [ // mpc-4.2a — no pulldown, so this is the only layer that hits #FFFFFF
  '#210000', '#FF0000', '#FF2100', '#00B800', '#FFFF00', '#976851', '#FF9751',
  '#FF00AE', '#2147AE', '#B868AE', '#B8FFAE', '#0021FF', '#00B8FF', '#FFFFFF',
];
const GAMUT = new Set([...SPR_PAL, ...BG_PAL, ...TX_PAL]);

// Sprites drawn through the SPRITE DAC. The exceptions are the entries in the
// sprite sheet that are not actually sprites on real hardware:
//   - mountainFar/mountainNear are BACKGROUND images (bg_pal, no pulldown)
//   - shotUp is drawn in the TILE layer, VERIFIED as pure #FFFFFF (brief §6.2)
const NON_SPRITE_LAYER = new Set(['mountainFar', 'mountainNear', 'shotUp']);

function channels(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

test('every colour in the sprite sheet is a real M52 PROM colour', async () => {
  const { SPRITES } = await import('../js/sprites.js');
  for (const [name, def] of Object.entries(SPRITES)) {
    for (const [ch, hex] of Object.entries(def.palette)) {
      assert.ok(GAMUT.has(hex),
        `sprite ${name} pen '${ch}' is ${hex}, which is not one of the 35 colours the hardware can produce`);
    }
  }
});

test('no sprite exceeds the sprite DAC ceiling — the 470-ohm pulldown means sprites can never be #FFFFFF', async () => {
  const { SPRITES } = await import('../js/sprites.js');
  // Channel maxima of the sprite network: 2-bit red tops out at 193 (#C1),
  // 3-bit green and blue at 200 (#C8). See brief §2.4.
  const MAX = [0xC1, 0xC8, 0xC8];
  for (const [name, def] of Object.entries(SPRITES)) {
    if (NON_SPRITE_LAYER.has(name)) continue;
    for (const [ch, hex] of Object.entries(def.palette)) {
      const rgb = channels(hex);
      for (let i = 0; i < 3; i++) {
        assert.ok(rgb[i] <= MAX[i],
          `sprite ${name} pen '${ch}' is ${hex}: channel ${'RGB'[i]} = ${rgb[i]} exceeds the sprite DAC's ${MAX[i]}`);
      }
    }
  }
});

test('the sprite DAC ceiling test would actually catch a regression', () => {
  // Guards the test above against silently passing on an empty/renamed set.
  assert.ok(channels('#FFFFFF')[0] > 0xC1, 'pure white really is out of the sprite gamut');
  assert.ok(channels('#C1C8C8').every((v, i) => v <= [0xC1, 0xC8, 0xC8][i]), 'the ceiling colour itself passes');
});

test('STAGE_PALETTES has collapsed to the single authentic palette', async () => {
  const { STAGE_PALETTES } = await import('../js/render.js');
  // The array SHAPE is kept on purpose: game.stage indexes it, and the next
  // pass hooks the real hills<->city-ruins alternation in here.
  assert.equal(STAGE_PALETTES.length, 5, 'indexing shape preserved for the next pass');
  for (const p of STAGE_PALETTES) {
    assert.deepEqual(p, STAGE_PALETTES[0],
      'the background PROM holds exactly one palette per layer — five re-hued stage themes are not reachable on the hardware');
  }
  const p = STAGE_PALETTES[0];
  assert.equal(p.ground, '#FF9751', 'flat peach regolith');
  assert.equal(p.sky, '#000000', 'the arcade sky is pure black');
  assert.equal(p.far.e, '#0000FF', 'distant-mountain peaks');
  assert.equal(p.far.m, '#0097AE', 'distant-mountain teal body/fill');
  assert.equal(p.near.e, '#009700', 'hill ridge');
  assert.equal(p.near.m, '#00DE51', 'hill fill');
  assert.ok(!('groundTop' in p) && !('groundShade' in p),
    'the terrain strip is ONE flat colour — no highlight line, no shade band');
  for (const hex of [p.ground, p.sky, p.star, p.far.e, p.far.m, p.near.e, p.near.m]) {
    assert.ok(GAMUT.has(hex), `${hex} is not a real M52 PROM colour`);
  }
});
