import test from 'node:test';
import assert from 'node:assert/strict';

// hud.js keeps its blink/flash timers in MODULE-LEVEL state (hudTime,
// comboFlash — see its docstring), deliberately not part of `game` (state.js
// is pure logic with no notion of "flash for 0.3s"). That makes the module
// itself stateful across calls within one import, so each test below imports
// a FRESH module instance (a cache-busting query string forces Node's ESM
// loader to give it its own module record) instead of sharing one hudTime
// counter across unrelated assertions.
function freshHud() {
  return import(`../js/hud.js?t=${Math.random()}-${Date.now()}`);
}

/** Minimal canvas 2D context double: hud.js only ever calls fillRect,
 * fillStyle assignment, and drawImage — no paths, gradients or text APIs. */
function fakeCtx() {
  const fillRects = [];
  return {
    _fillStyle: '#000',
    set fillStyle(v) { this._fillStyle = v; },
    get fillStyle() { return this._fillStyle; },
    fillRect(x, y, w, h) {
      fillRects.push({
        x, y, w, h, color: this._fillStyle,
      });
    },
    drawImage() {},
    fillRects,
  };
}

function baseGame() {
  return {
    score: 0,
    combo: { mult: 1 },
    mode: 'endless', // sidesteps the classic-only A-Z progress bar (LETTERS/STAGE_BREAKS)
    stageTime: 0,
    elapsedTotal: 0,
    checkpoint: 0,
    buggy: { worldX: 0 },
    warn: { air: true, mine: false, rear: false }, // air light lit, so it actually blinks
    powerup: null,
    lives: 3,
  };
}

// Warning lights are drawn at drawHUD's fixed x=213 call to
// drawWarningLights(ctx, game, 213, 2); the air light is the first of the
// three, at (213, 2), 6x6.
function airLightColor(ctx) {
  const hits = ctx.fillRects.filter((r) => r.x === 213 && r.y === 2 && r.w === 6 && r.h === 6);
  return hits[hits.length - 1]?.color;
}

test('drawHUD threads the caller\'s simDt instead of assuming one frame == one DT '
  + '(regression: warning-light blink used to run at refresh rate, not real time)', async () => {
  const sprites = {};
  const game = baseGame();

  // 12 * 1/64 == 0.1875s exactly (1/64 is exactly binary-representable, so
  // this sum has no floating-point drift at all). At the lights' 8Hz blink
  // (see hud.js's drawWarningLights: Math.floor(hudTime*8)%2), 0.1875s is
  // 1.5 half-cycles -> floor(1.5)=1 -> the OFF phase.
  const STEP = 1 / 64;
  const STEPS = 12;
  const TOTAL = STEP * STEPS;
  assert.ok(Math.abs(TOTAL - 0.1875) < 1e-12, 'sanity: the chosen step count lands exactly on 0.1875s');

  // Path A: the whole 0.1875s arrives in a SINGLE drawHUD call (as a low-
  // refresh display, or several fixed steps folded into one render, would
  // deliver it).
  const { drawHUD: drawA } = await freshHud();
  const ctxA = fakeCtx();
  drawA(ctxA, game, sprites, TOTAL);

  // Path B: the same 0.1875s split across STEPS separate drawHUD calls (a
  // higher-refresh display rendering more often per unit of sim time).
  const { drawHUD: drawB } = await freshHud();
  const ctxB = fakeCtx();
  for (let i = 0; i < STEPS; i++) drawB(ctxB, game, sprites, STEP);

  const colorA = airLightColor(ctxA);
  const colorB = airLightColor(ctxB);
  assert.ok(colorA, 'path A drew the air light');
  assert.ok(colorB, 'path B drew the air light');
  assert.equal(colorA, colorB,
    'the same total elapsed sim time must land on the same blink phase regardless of how many '
    + 'drawHUD calls it was split across — with the old `hudTime += DT` per call, path A would only '
    + 'have advanced by one DT (1/60s) no matter what simDt said, diverging from path B');

  // And confirm it actually reached the OFF phase predicted above (not just
  // "A matches B" by both being wrong the same way).
  const LIGHT_OFF_AIR = '#5a2018';
  assert.equal(colorA, LIGHT_OFF_AIR, 'lands on the predicted off-phase of the 8Hz blink');
});

test('drawHUD defaults simDt to DT for a caller that does not pass one', async () => {
  const { drawHUD } = await freshHud();
  const ctx = fakeCtx();
  const game = baseGame();
  assert.doesNotThrow(() => drawHUD(ctx, game, {}));
  assert.ok(airLightColor(ctx), 'still drew the HUD with no explicit simDt argument');
});
