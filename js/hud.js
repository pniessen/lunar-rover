// hud.js — presentation. The authentic Moon Patrol-style top panel: a 5x7
// bitmap pixel font (no DOM text rendering — every glyph is drawn as 1px
// fillRects so it stays perfectly crisp at any integer scale) plus
// drawHUD(), which lays out score/high-score/combo/checkpoint/timer/warning
// lights/A-Z progress bar/lives/power-up within the top HUD_H (36px) strip.
// May touch canvas (ctx) — this is presentation, not simulation.

import { LETTERS, STAGE_BREAKS } from './terrain.js';
import { loadScores } from './score.js';
import { DT, VIEW_W, HUD_H } from './state.js';
import { DURATIONS } from './powerups.js';

// --- 5x7 bitmap font -------------------------------------------------------
// Each glyph is 7 rows of a 5-char string; '#' = lit pixel, '.' = off.
// Covers 0-9, A-Z, space, and '×', ':', '-', '.', '!'. Anything else falls
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
export function drawText(ctx, x, y, str, color = '#ffffff', scale = 1) {
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
// 0.3s"). Driven by an accumulating counter advanced one DT per drawHUD()
// call — NOT Date.now() — so it stays deterministic and frame-based.

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
  shield: '#60e0ff', rapid: '#ffe060', spread: '#ff60c0', hover: '#60ff90',
};

const LIGHT_ON = { air: '#ff4030', mine: '#ffe060', rear: '#60c0ff' };
const LIGHT_OFF = { air: '#5a2018', mine: '#5a4c18', rear: '#1c3a54' };

const BAR_START_X = 17;
const BAR_SPACING = 14; // (VIEW_W - 2*BAR_START_X) / 25, rounded down
const BAR_BOTTOM_Y = 33; // ticks grow upward from here
const TICK_H = 3;
const BREAK_TICK_H = 7;

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

function drawProgressBar(ctx, game) {
  for (let i = 0; i < LETTERS.length; i++) {
    const x = BAR_START_X + i * BAR_SPACING;
    const isBreak = STAGE_BREAKS.includes(i);
    const h = isBreak ? BREAK_TICK_H : TICK_H;
    ctx.fillStyle = isBreak ? '#7fd8ff' : '#5a5a78';
    ctx.fillRect(x, BAR_BOTTOM_Y - h, 1, h);
    if (isBreak) {
      drawText(ctx, x - 2, BAR_BOTTOM_Y - BREAK_TICK_H - 9, LETTERS[i], '#7fd8ff', 1);
    }
  }
  // Marker: a bright vertical cursor spanning (and overshooting) the tick
  // at the current checkpoint, so it reads clearly regardless of whether it
  // lands on a break tick or a plain one.
  const mx = BAR_START_X + Math.min(game.checkpoint, LETTERS.length - 1) * BAR_SPACING;
  ctx.fillStyle = '#ffe060';
  ctx.fillRect(mx, BAR_BOTTOM_Y - BREAK_TICK_H - 2, 1, BREAK_TICK_H + 2);
}

function drawLives(ctx, sprites, game, x, y) {
  const n = Math.min(game.lives, 6);
  for (let i = 0; i < n; i++) {
    ctx.drawImage(sprites.buggyBody, x + i * 12, y, 10, 5);
  }
}

function drawPowerup(ctx, game, x, y) {
  const pu = game.powerup;
  if (!pu) return;
  const color = POWERUP_COLOR[pu.type] || '#ffffff';
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 9, 9);
  drawText(ctx, x + 2, y + 1, POWERUP_LETTER[pu.type] || '?', '#0a0a12', 1);
  if (pu.remaining === Infinity) return; // shield: icon only, no timer
  const max = POWERUP_MAX[pu.type] || 15;
  const frac = Math.max(0, Math.min(1, pu.remaining / max));
  ctx.fillStyle = '#2a2a3c';
  ctx.fillRect(x, y + 10, 9, 2);
  ctx.fillStyle = color;
  ctx.fillRect(x, y + 10, Math.round(9 * frac), 2);
}

/**
 * Draws the full HUD into the top HUD_H (36px) strip of `ctx`. Reads only
 * from `game`; never mutates it. `sprites` is the rasterized sprite set
 * from render.js's renderer (used for the mini life-buggy icons).
 */
export function drawHUD(ctx, game, sprites) {
  hudTime += DT;
  if (game.combo.mult > prevComboMult) comboFlash = COMBO_FLASH_TIME;
  prevComboMult = game.combo.mult;
  if (comboFlash > 0) comboFlash = Math.max(0, comboFlash - DT);

  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, 0, VIEW_W, HUD_H);
  ctx.fillStyle = '#3a3a5c';
  ctx.fillRect(0, HUD_H - 1, VIEW_W, 1);

  // 1UP score + combo multiplier
  const scoreEndX = drawText(ctx, 3, 2, `1UP ${String(game.score).padStart(6, '0')}`, '#ffffff');
  if (game.combo.mult > 1) {
    drawText(ctx, scoreEndX + 4, 2, `×${game.combo.mult}`, comboFlash > 0 ? '#ffffff' : '#ffe060');
  }

  // HI + top score for this mode
  const scores = loadScores(game.mode);
  const hi = scores.length ? scores[0].score : 0;
  drawText(ctx, 100, 2, `HI ${String(hi).padStart(6, '0')}`, '#7fd8ff');

  // Stage timer M:SS
  const secs = Math.max(0, Math.floor(game.stageTime));
  const timerStr = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  drawText(ctx, 170, 2, timerStr, '#ffffff');

  drawWarningLights(ctx, game, 213, 2);

  // Checkpoint letter, large (2x)
  const letter = LETTERS[game.checkpoint] || 'A';
  drawText(ctx, 255, 1, letter, '#ffe060', 2);

  drawPowerup(ctx, game, 278, 1);

  drawLives(ctx, sprites, game, 306, 3);

  drawProgressBar(ctx, game);
}
