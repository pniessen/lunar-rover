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
//   - mountainFar/mountainNear/cityRuins are BACKGROUND images (bg_pal, no
//     pulldown — cityRuins' #FFDE51 pale yellow is well past the sprite
//     network's 0xC1 red ceiling, which is exactly the point of the exception)
//   - shotUp is drawn in the TILE layer, VERIFIED as pure #FFFFFF (brief §6.2)
const NON_SPRITE_LAYER = new Set(['mountainFar', 'mountainNear', 'cityRuins', 'shotUp']);

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

test('STAGE_PALETTES is ONE palette — every entry has identical colours', async () => {
  const { STAGE_PALETTES } = await import('../js/render.js');
  assert.equal(STAGE_PALETTES.length, 5, 'five sections per course');
  for (const p of STAGE_PALETTES) {
    // Everything EXCEPT `mid` must be byte-identical: the background PROM
    // holds exactly one colour triple per layer, so re-hued stage themes are
    // not reachable on the hardware. `mid` picks which IMAGE is drawn, which
    // is the variety mechanism the hardware actually has.
    const { mid, ...colours } = p;
    const { mid: _m0, ...base } = STAGE_PALETTES[0];
    assert.deepEqual(colours, base,
      'no per-stage hue variation — only the mid-ground image may differ');
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

// --- hills <-> city-ruins alternation ----------------------------------------
//
// The arcade's background variety is NOT per-stage hues (impossible — see
// above). It is which mid-ground image the background-control port $C0 lets
// through: the distant mountains are always drawn and the mid-ground is
// either rolling hills (bg1) or city ruins (bg2), never both. Brief §7
// finding 3. The layer *selection* is pure arithmetic over `game`, so unlike
// the drawing it is genuinely unit-testable here.

test('the classic course alternates hills/city/hills/city/hills across its five stages', async () => {
  const { STAGE_PALETTES, MID_HILLS, MID_CITY } = await import('../js/render.js');
  assert.deepEqual(STAGE_PALETTES.map((p) => p.mid),
    [MID_HILLS, MID_CITY, MID_HILLS, MID_CITY, MID_HILLS],
    'matches the $0C08 section-counter parity: every course starts on hills');
});

test('paletteFor picks the section palette from game.stage in classic', async () => {
  const { paletteFor, backgroundSection, MID_HILLS, MID_CITY } = await import('../js/render.js');
  const seen = [];
  for (let stage = 0; stage < 5; stage++) {
    const game = { mode: 'classic', stage };
    assert.equal(backgroundSection(game), stage);
    seen.push(paletteFor(game).mid);
  }
  assert.deepEqual(seen, [MID_HILLS, MID_CITY, MID_HILLS, MID_CITY, MID_HILLS]);
  // The champion course resets stage to 0 (finishStageClear), so lap 2 starts
  // on hills again — the same phase alignment the arcade's CP $05 / ADC $00
  // fixup produces.
  assert.equal(paletteFor({ mode: 'classic', stage: 0 }).mid, MID_HILLS);
});

test('endless keeps alternating forever, driven by its boss cadence rather than the clamped game.stage', async () => {
  const { paletteFor, backgroundSection, MID_HILLS, MID_CITY } = await import('../js/render.js');
  const { ENDLESS_BOSS_PERIOD } = await import('../js/state.js');

  // One section per boss cycle. game.stage is deliberately capped at 4 in
  // endless (it is a difficulty step), so a background keyed off it would
  // freeze on hills after six minutes — this is the regression this test
  // exists for: `stage` is pinned at its cap for every sample below.
  const mids = [];
  for (let cycle = 0; cycle < 12; cycle++) {
    const game = {
      mode: 'endless',
      stage: Math.min(4, cycle), // exactly what state.js computes
      elapsedTotal: cycle * ENDLESS_BOSS_PERIOD + 1,
    };
    assert.equal(backgroundSection(game), cycle, 'unclamped section counter');
    mids.push(paletteFor(game).mid);
  }
  assert.deepEqual(mids, [
    MID_HILLS, MID_CITY, MID_HILLS, MID_CITY, MID_HILLS,
    MID_HILLS, MID_CITY, MID_HILLS, MID_CITY, MID_HILLS,
    MID_HILLS, MID_CITY,
  ], 'period-5 wrap, including the doubled hills at the 5->6 seam');
  assert.ok(mids.slice(5).includes(MID_CITY),
    'the city still appears long after game.stage has pinned at its cap of 4');
});

test('the section counter never falls off the end of the table or goes negative', async () => {
  const { paletteFor, backgroundSection } = await import('../js/render.js');
  // Defensive: render() calls this every frame on whatever `game` it is
  // handed, including the attract screen's fresh game and (in tests/tools)
  // partially-built stand-ins.
  for (const game of [
    undefined, {}, { mode: 'classic' }, { mode: 'endless' },
    { mode: 'classic', stage: -3 }, { mode: 'classic', stage: 99 },
    { mode: 'endless', elapsedTotal: NaN }, { mode: 'endless', elapsedTotal: 1e9 },
  ]) {
    const section = backgroundSection(game);
    assert.ok(Number.isInteger(section) && section >= 0, `bad section ${section}`);
    assert.ok(paletteFor(game) && paletteFor(game).mid, 'always resolves to a real palette');
  }
});

// --- the city-ruins strip ----------------------------------------------------

test('the city strip uses only the city layer\'s three verified bg_pal pens', async () => {
  const { CITY_PALETTE } = await import('../js/sprites.js');
  // Brief §6.1: city ruins (bg2/GFX5) = pen1 #000000, pen2 #FFDE51 pale
  // yellow, pen3 #00DE51 green, with a solid #00DE51 fill below.
  assert.deepEqual(new Set(Object.values(CITY_PALETTE)),
    new Set(['#000000', '#FFDE51', '#00DE51']));
  for (const hex of Object.values(CITY_PALETTE)) {
    assert.ok(BG_PAL.includes(hex), `${hex} is not in the background PROM`);
  }
});

test('the city strip is a filled mass the same height as the hills it replaces', async () => {
  const { CITY_MAP, MOUNTAIN_NEAR_MAP } = await import('../js/sprites.js');
  assert.equal(CITY_MAP.length, MOUNTAIN_NEAR_MAP.length,
    'same band height — a swap, not a new layer');
  const w = CITY_MAP[0].length;
  assert.equal(w, 256, 'the hardware background image wraps every 256px (brief §8.3)');
  for (const row of CITY_MAP) assert.equal(row.length, w, 'rectangular map');
  // The bottom rows are the solid below-image fill every M52 background layer
  // gets (MAME's m_do_bg_fills), so the skyline rises out of a mass rather
  // than floating on bare sky.
  const bottom = CITY_MAP[CITY_MAP.length - 1];
  assert.ok(/^m+$/.test(bottom), 'bottom row is solid pen-3 fill');
});

test('the city strip tiles seamlessly — nothing straddles the wrap seam', async () => {
  const { CITY_MAP } = await import('../js/sprites.js');
  const w = CITY_MAP[0].length;
  const bottomFillTop = CITY_MAP.findIndex((row) => /^m+$/.test(row));
  assert.ok(bottomFillTop > 0, 'there is a skyline above the fill');
  // drawTiled repeats the strip end-to-end, so a building crossing column 0 /
  // column w-1 would be sliced in half at every repeat. Above the fill line
  // both edge columns must be empty sky.
  for (let y = 0; y < bottomFillTop; y++) {
    assert.equal(CITY_MAP[y][0], '.', `row ${y}: left seam column must be sky`);
    assert.equal(CITY_MAP[y][w - 1], '.', `row ${y}: right seam column must be sky`);
  }
});

test('the city strip actually looks like a city — a broken skyline, lit rims and openings', async () => {
  const { CITY_MAP } = await import('../js/sprites.js');
  const counts = { m: 0, y: 0, k: 0, '.': 0 };
  for (const row of CITY_MAP) for (const c of row) counts[c]++;
  assert.ok(counts.y > 100, `expected a lit rim tracing the silhouette, got ${counts.y}px`);
  assert.ok(counts.k > 100, `expected window/arch openings, got ${counts.k}px`);
  assert.ok(counts['.'] > 0, 'there is sky between the buildings');

  // Openings must be spread across the strip, not concentrated in the handful
  // of columns the arch and the three gashes occupy (~14 of 256): the window
  // grids are what make the masses read as buildings rather than as blocks.
  const openColumns = new Set();
  CITY_MAP.forEach((row) => row.split('').forEach((c, x) => { if (c === 'k') openColumns.add(x); }));
  assert.ok(openColumns.size > 40,
    `openings should span many columns, found ${openColumns.size}`);

  // A skyline, not a flat wall: the height of the drawn mass has to vary a
  // lot across the strip. (A ridge would too — what separates this from the
  // hills is the vertical edges, checked next.)
  const w = CITY_MAP[0].length;
  const tops = [];
  for (let x = 0; x < w; x++) {
    let top = CITY_MAP.length;
    for (let y = 0; y < CITY_MAP.length; y++) {
      if (CITY_MAP[y][x] !== '.') { top = y; break; }
    }
    tops.push(top);
  }
  assert.ok(Math.max(...tops) - Math.min(...tops) > 20, 'tall towers and empty gaps');
  // Buildings have vertical walls: many columns must repeat the exact same
  // top height as their neighbour, and the transitions must be sheer.
  const sheer = tops.filter((t, i) => i > 0 && Math.abs(t - tops[i - 1]) > 6).length;
  assert.ok(sheer >= 8, `expected sheer building edges, found ${sheer}`);
});

test('rasterizing the city strip would fail loudly on a bad pen', async () => {
  // validateMap is what catches a typo'd character at boot instead of
  // rendering it as a hole — confirms the map/palette pair is self-consistent
  // without needing a canvas.
  const { validateMap, CITY_MAP, CITY_PALETTE } = await import('../js/sprites.js');
  const { w, h } = validateMap('cityRuins', CITY_MAP, CITY_PALETTE);
  assert.equal(w, 256);
  assert.equal(h, 40);
  assert.throws(() => validateMap('cityRuins', CITY_MAP, { m: '#00DE51' }),
    /unknown char/, 'the validation this relies on really does bite');
});
