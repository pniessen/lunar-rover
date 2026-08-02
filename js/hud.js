// hud.js — presentation. The authentic Moon Patrol-style top panel: a 5x7
// bitmap pixel font (no DOM text rendering — every glyph is drawn as 1px
// fillRects so it stays perfectly crisp at any integer scale) plus
// drawHUD(), which lays out score/high-score/combo/checkpoint/timer/warning
// lights/A-Z progress bar/lives/power-up within the top HUD_H (36px) strip.
// May touch canvas (ctx) — this is presentation, not simulation.
//
// HUD HEIGHT — DELIBERATE DEVIATION. The arcade panel is 48px of a 248-row
// frame (19.4%); ours is 36 of 240 (15.0%). It is deliberately NOT grown. The
// HUD is drawn over the world every frame (see render.js's draw order), and
// flyer altitudes are absolute constants that know nothing about HUD_H:
// enemies.js seeds formations at baseY 45-80 and swoopers oscillate that by
// +/-20, so live, lethal enemies reach y ~= 25. A 46px panel would occlude a
// further 10px of that airspace on top of the 11px it already hides — and the
// boss hovers in the same airspace (boss.js HOVER_Y = 70), so it would lose
// visible headroom too. Occlusion is the whole argument; HUD_H is a drawing
// constant that no pure module reads, so growing it could not move the sweep
// geometry or any hitbox. Gameplay legibility outranks the proportion.
// See BUILD-LOG.

import { LETTERS, STAGE_BREAKS } from './terrain.js';
import { loadScores } from './score.js';
import { DT, VIEW_W, HUD_H } from './state.js';
import { DURATIONS } from './powerups.js';

// --- 5x7 bitmap font -------------------------------------------------------
// Each glyph is 7 rows of a 5-char string; '#' = lit pixel, '.' = off.
// Covers 0-9, A-Z, space, and '×', ':', '-', '.', '!', '/'. Anything else falls
// back to a blank space glyph.

const FONT = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['..#..', '.#.#.', '#...#', '#...#', '#####', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['....#', '....#', '....#', '....#', '#...#', '#...#', '.###.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  ':': ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '..#..', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '×': ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

/**
 * Draws `str` as bitmap-font pixels, top-left at (x,y), scaled by `scale`
 * (each font pixel becomes a scale x scale square — integer positions only,
 * so it always stays crisp). Uppercases input; unmapped characters fall
 * back to a blank space glyph. Returns the x just past the last character,
 * useful for chaining adjacent drawText calls.
 */
export function drawText(ctx, x, y, str, color = '#FFFFFF', scale = 1) {
  ctx.fillStyle = color;
  let cx = Math.round(x);
  const y0 = Math.round(y);
  for (const ch of String(str).toUpperCase()) {
    const glyph = FONT[ch] || FONT[' '];
    for (let ry = 0; ry < GLYPH_H; ry++) {
      const row = glyph[ry];
      for (let rx = 0; rx < GLYPH_W; rx++) {
        if (row[rx] === '#') {
          ctx.fillRect(cx + rx * scale, y0 + ry * scale, scale, scale);
        }
      }
    }
    cx += (GLYPH_W + 1) * scale;
  }
  return cx;
}

/** Pixel width `str` would occupy at the given scale — for right/center alignment. */
export function textWidth(str, scale = 1) {
  return String(str).length * (GLYPH_W + 1) * scale - scale;
}

// --- module-level HUD-only timers ------------------------------------------
// Presentation-only animation state (blink phase, combo-flash), deliberately
// NOT part of `game` (state.js is pure logic with no notion of "flash for
// 0.3s"). Driven by an accumulating counter advanced by the caller's real
// simulation delta (see drawHUD's `simDt` param) — NOT Date.now() and NOT a
// bare per-call DT — so it stays deterministic and frame-rate independent.
// A rendered frame can contain zero, one, or several fixed sim steps (see
// main.js's loop()); assuming exactly one DT per drawHUD() call ran the
// warning-light blink and combo-flash fast on any display faster than 60Hz
// and slow on any display slower than 60Hz — the same class of bug already
// fixed for particles/shake via render.js's simDt = steps * DT.

let hudTime = 0;
let prevComboMult = 1;
let comboFlash = 0;

const COMBO_FLASH_TIME = 0.3;
// Pip-bar denominators for the power-up countdown, sourced directly from
// powerups.js's DURATIONS so the HUD bar can never drift out of sync with
// the actual timer it's displaying (shield has no timer — remaining is
// always Infinity, handled as a special case in drawPowerup below).
const POWERUP_MAX = DURATIONS;
const POWERUP_LETTER = { shield: 'S', rapid: 'R', spread: 'W', hover: 'H' };
const POWERUP_COLOR = {
  shield: '#0021FF', rapid: '#FFFF00', spread: '#FF00AE', hover: '#00B800',
};
// Letter ink per chip, so the glyph always has contrast against its own chip.
const POWERUP_INK = {
  shield: '#FFFFFF', rapid: '#210000', spread: '#FFFFFF', hover: '#210000',
};

// --- authentic tile-layer palette ------------------------------------------
// Every colour below is a VERIFIED entry of the M52 text/tile palette PROM
// `mpc-4.2a`, decoded from the raw PROM bytes and cross-checked against a
// lossless native-resolution modern-MAME capture. See
// .superpowers/notes/authenticity-research.md §3.3 / §6.3.
//
// The tile layer has NO pulldown resistor on its DAC, so unlike sprites it
// genuinely reaches pure #FFFFFF and pure #FF0000. HUD text really is brighter
// than anything moving in the world — that brightness gap is what makes the
// panel read as a lit instrument and the sprites as objects out there.
const PANEL = '#0021FF';      // HUD panel background, blue
const SUBPANEL = '#00B8FF';   // status sub-panel, cyan
const INK_RED = '#FF2100';    // red-orange: scores, timer, progress fill
const INK_YELLOW = '#FFFF00'; // yellow: labels, crown/marker accents
const INK_DARK = '#210000';   // near-black red: text on the cyan sub-panel
const INK_WHITE = '#FFFFFF';  // pure white

// Sub-panel geometry. The arcade's cyan window is exactly 128px wide (x
// 84-211 of a 240px screen — brief §8.5); that literal 128px is kept here,
// positioned so its centre sits at ~59% of our wider 384px buffer against the
// arcade's ~61%. It holds the same class of content as the original: the
// mid-panel status readouts, with score/high-score outside it on the left and
// the life icons outside it on the right.
const SUBPANEL_X = 164;
const SUBPANEL_W = 128;
const SUBPANEL_Y = 0;
const SUBPANEL_H = 16;

const LIGHT_ON = { air: INK_RED, mine: INK_YELLOW, rear: PANEL };
const LIGHT_OFF = { air: INK_DARK, mine: INK_DARK, rear: INK_DARK };

const BAR_START_X = 17;
const BAR_SPACING = 14; // (VIEW_W - 2*BAR_START_X) / 25, rounded down
const BAR_Y = 29;       // top row of the 4px filled bar
const BAR_H = 4;        // matches the arcade's 4px-tall progress bar
const BAR_W = BAR_SPACING * (26 - 1); // A..Z inclusive, 25 gaps

function drawWarningLights(ctx, game, x, y) {
  const blinkOn = Math.floor(hudTime * 8) % 2 === 0;
  let lx = x;
  for (const key of ['air', 'mine', 'rear']) {
    const lit = !!game.warn?.[key];
    const color = lit ? (blinkOn ? LIGHT_ON[key] : LIGHT_OFF[key]) : LIGHT_OFF[key];
    ctx.fillStyle = color;
    ctx.fillRect(lx, y, 6, 6);
    lx += 10;
  }
}

/**
 * The A-Z checkpoint bar. This used to be a row of 26 one-pixel ticks with a
 * yellow cursor; the arcade's is a SOLID FILLED BAR — red `#FF2100` from the
 * left edge up to the player's position, cyan `#00B8FF` for the remainder,
 * with 1px red dividers at the checkpoint positions and the letters above it
 * in red (brief §6.3, VERIFIED). The filled form reads progress at a glance in
 * a way the tick row did not, and the fill edge *is* the position marker, so
 * the separate cursor is gone.
 */
function drawProgressBar(ctx, game) {
  const last = LETTERS.length - 1;
  const cp = Math.max(0, Math.min(game.checkpoint, last));
  const fillW = Math.round((cp / last) * BAR_W);

  ctx.fillStyle = SUBPANEL;
  ctx.fillRect(BAR_START_X, BAR_Y, BAR_W, BAR_H);
  ctx.fillStyle = INK_RED;
  ctx.fillRect(BAR_START_X, BAR_Y, fillW, BAR_H);

  for (const i of STAGE_BREAKS) {
    const x = BAR_START_X + i * BAR_SPACING;
    ctx.fillStyle = INK_RED;
    ctx.fillRect(x, BAR_Y, 1, BAR_H);
    drawText(ctx, x - 2, BAR_Y - GLYPH_H - 2, LETTERS[i], INK_RED, 1);
  }
}

/**
 * Life icons. These used to be the buggy SPRITE squashed to 10x5 — which
 * stopped working the moment the panel went from near-black to `#0021FF`
 * blue, because the authentic buggy is `#C100AE` magenta and magenta on blue
 * is nearly unreadable at 5px tall. The arcade draws its life icons in the
 * TILE layer in red/orange (brief §6.3), so this now paints a red-orange mini
 * buggy pictogram directly instead of tinting a sprite. `sprites` is kept in
 * the signature: it is part of drawHUD's contract with render.js and other
 * HUD elements may want it again.
 */
function drawLives(ctx, sprites, game, x, y) {
  const n = Math.min(game.lives, 6);
  ctx.fillStyle = INK_RED;
  for (let i = 0; i < n; i++) {
    const lx = x + i * 12;
    ctx.fillRect(lx, y, 10, 3);        // hull
    ctx.fillRect(lx + 1, y + 3, 2, 2); // three wheels, matching the real buggy
    ctx.fillRect(lx + 4, y + 3, 2, 2);
    ctx.fillRect(lx + 7, y + 3, 2, 2);
  }
}

function drawPowerup(ctx, game, x, y) {
  const pu = game.powerup;
  if (!pu) return;
  const color = POWERUP_COLOR[pu.type] || INK_WHITE;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 9, 9);
  drawText(ctx, x + 2, y + 1, POWERUP_LETTER[pu.type] || '?', POWERUP_INK[pu.type] || INK_DARK, 1);
  if (pu.remaining === Infinity) return; // shield: icon only, no timer
  const max = POWERUP_MAX[pu.type] || 15;
  const frac = Math.max(0, Math.min(1, pu.remaining / max));
  ctx.fillStyle = INK_DARK;
  ctx.fillRect(x, y + 10, 9, 2);
  ctx.fillStyle = color;
  ctx.fillRect(x, y + 10, Math.round(9 * frac), 2);
}

/**
 * Draws the full HUD into the top HUD_H (36px) strip of `ctx`. Reads only
 * from `game`; never mutates it. `sprites` is the rasterized sprite set
 * from render.js's renderer (used for the mini life-buggy icons).
 *
 * `simDt` is the real simulation time elapsed since the previous drawHUD()
 * call — render.js passes its own `simDt` (steps * DT) straight through, so
 * this module's blink/flash timers age at the same real-world rate on a
 * 30Hz, 60Hz or 144Hz display. Defaults to DT for any caller that doesn't
 * track it. Also 0 while paused (render.js's caller zeroes it — see
 * main.js's loop()), which freezes the blink/flash exactly on the frame the
 * game was paused; that's the intended feel, not an oversight — see
 * BUILD-LOG.md.
 */
export function drawHUD(ctx, game, sprites, simDt = DT) {
  hudTime += simDt;
  if (game.combo.mult > prevComboMult) comboFlash = COMBO_FLASH_TIME;
  prevComboMult = game.combo.mult;
  if (comboFlash > 0) comboFlash = Math.max(0, comboFlash - simDt);

  // Solid blue panel with the cyan status sub-panel inside it. The arcade HUD
  // is a bright lit instrument, not the dark strip this used to draw.
  ctx.fillStyle = PANEL;
  ctx.fillRect(0, 0, VIEW_W, HUD_H);
  ctx.fillStyle = SUBPANEL;
  ctx.fillRect(SUBPANEL_X, SUBPANEL_Y, SUBPANEL_W, SUBPANEL_H);

  // 1UP score + combo multiplier. Yellow label, red-orange digits — the same
  // split the arcade uses for its `1P-` label and player score.
  const labelEndX = drawText(ctx, 3, 2, '1UP ', INK_YELLOW);
  const scoreEndX = drawText(ctx, labelEndX, 2, String(game.score).padStart(6, '0'), INK_RED);
  if (game.combo.mult > 1) {
    drawText(ctx, scoreEndX + 4, 2, `×${game.combo.mult}`, comboFlash > 0 ? INK_WHITE : INK_YELLOW);
  }

  // HI + top score for this mode
  const scores = loadScores(game.mode);
  const hi = scores.length ? scores[0].score : 0;
  const hiEndX = drawText(ctx, 100, 2, 'HI ', INK_YELLOW);
  drawText(ctx, hiEndX, 2, String(hi).padStart(6, '0'), INK_RED);

  const isEndless = game.mode === 'endless';

  // Stage timer M:SS — classic: the current stage's clock (game.stageTime,
  // reset on every stageClear); endless has no stages to reset the clock
  // between, so this slot is repurposed to the whole run's elapsed time
  // (game.elapsedTotal) instead of being hidden outright.
  const secs = Math.max(0, Math.floor(isEndless ? (game.elapsedTotal || 0) : game.stageTime));
  const timerStr = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  // Inside the cyan sub-panel, matching the arcade's red-orange `TIME 031`.
  drawText(ctx, 170, 2, timerStr, INK_RED);

  drawWarningLights(ctx, game, 213, 2);

  if (isEndless) {
    // Distance counter (meters = worldX/10) replaces the checkpoint letter —
    // endless has no checkpoints (state.js gates the STAGE_BREAKS/
    // checkpoint-letter machinery to mode==='classic').
    const meters = Math.floor(game.buggy.worldX / 10);
    drawText(ctx, 246, 2, `${String(meters).padStart(4, '0')}M`, INK_DARK, 1);
  } else {
    // Checkpoint letter, large (2x). Near-black on the cyan sub-panel, the
    // same treatment the arcade gives its `POINT G` target readout.
    const letter = LETTERS[game.checkpoint] || 'A';
    drawText(ctx, 255, 1, letter, INK_DARK, 2);
  }

  drawPowerup(ctx, game, 278, 1);

  drawLives(ctx, sprites, game, 306, 3);

  // The A-Z progress bar is a classic-only concept (it's keyed to
  // LETTERS/STAGE_BREAKS, which endless never advances through).
  if (!isEndless) drawProgressBar(ctx, game);
}
