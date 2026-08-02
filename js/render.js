// render.js — presentation. Owns the 384x240 pixel buffer, the rasterized
// sprite set, and the per-stage background palettes. Reads `game`, never
// writes to it.

import { buildSprites, rasterize, MOUNTAIN_FAR_MAP, MOUNTAIN_NEAR_MAP } from './sprites.js';
import { featuresInRange } from './terrain.js';
import { buggyScreenX, DT, DYING_TIME, VIEW_W, VIEW_H, GROUND_Y, HUD_H } from './state.js';
import { mulberry32 } from './rng.js';
import { drawText, textWidth, drawHUD } from './hud.js';
import { loadScores } from './score.js';

const STAR_WORLD_W = 2048; // starfield wrap width, in starfield-local px
const STAR_COUNT = 110;

// Parallax factors, slowest (farthest) first.
const P_STARS = 0.05;
const P_FAR = 0.2;
const P_NEAR = 0.5;

/**
 * Five background themes, indexed by game.stage. Stage 0 is the faithful
 * Moon Patrol look: near-black sky, green ranges, magenta dust. The rest
 * re-hue the sky, both mountain layers and the terrain strip.
 */
export const STAGE_PALETTES = [
  { // 0 — lunar night: green ranges over a pink dust plain
    sky: '#05050e', star: '#ffffff',
    far: { e: '#2f8a45', m: '#1b5c2c', s: '#123f1e', w: '#9fe0b0' },
    near: { e: '#63d47a', m: '#2f9c46', s: '#1d6b2e', w: '#ffffff' },
    ground: '#e05098', groundTop: '#ff9ad0', groundShade: '#a83070',
  },
  { // 1 — violet night, teal ranges
    sky: '#0b0320', star: '#dfe8ff',
    far: { e: '#2a7c8a', m: '#17505c', s: '#0e3540', w: '#a6e6f0' },
    near: { e: '#46c8c0', m: '#209a92', s: '#12645f', w: '#ffffff' },
    ground: '#d4489e', groundTop: '#ff92d6', groundShade: '#9c2a78',
  },
  { // 2 — pre-dawn blue, slate ranges
    sky: '#03101f', star: '#cfe4ff',
    far: { e: '#3a5f9c', m: '#243d68', s: '#172845', w: '#b8cdf0' },
    near: { e: '#5b8ede', m: '#33609f', s: '#213f6c', w: '#ffffff' },
    ground: '#c95494', groundTop: '#ffa0d2', groundShade: '#8f3168',
  },
  { // 3 — rust dusk, ochre ranges
    sky: '#1a0508', star: '#ffe0c0',
    far: { e: '#9a5a24', m: '#6b3a14', s: '#47250c', w: '#f0c08a' },
    near: { e: '#d88a34', m: '#a85e1c', s: '#743e12', w: '#ffe8c0' },
    ground: '#e0603c', groundTop: '#ffa070', groundShade: '#a83c22',
  },
  { // 4 — the cold void, violet ranges
    sky: '#050510', star: '#f0d8ff',
    far: { e: '#6a3f9c', m: '#452668', s: '#2c1745', w: '#d8b8f0' },
    near: { e: '#9c62d8', m: '#6f3aa8', s: '#4a2474', w: '#ffffff' },
    ground: '#b84fd0', groundTop: '#e79aff', groundShade: '#7c2f96',
  },
];

const CRATER_SPRITE = {
  crater: 'crater', bigCrater: 'bigCrater',
  doubleCrater: 'doubleCrater', bombCrater: 'bombCrater',
};
const GROUND_SPRITE = { rock: 'rock', bigRock: 'bigRock' };

// Enemy kind -> sprite built in Task 4; swooper/aimer/bomber reuse the
// three UFO saucer variants so each kind reads distinctly at a glance.
const ENEMY_SPRITE = {
  swooper: 'ufoA', aimer: 'ufoB', bomber: 'ufoC', tank: 'tank', chaser: 'chaser',
};

function mod(a, n) {
  return ((a % n) + n) % n;
}

export function createRenderer(screenCanvas) {
  const buffer = document.createElement('canvas');
  buffer.width = VIEW_W;
  buffer.height = VIEW_H;
  const ctx = buffer.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const screenCtx = screenCanvas.getContext('2d');
  screenCtx.imageSmoothingEnabled = false;

  // Mountain strips are re-rasterized once per stage palette at boot, so the
  // per-stage re-hue costs nothing at frame time.
  const mountains = STAGE_PALETTES.map((p) => ({
    far: rasterize(MOUNTAIN_FAR_MAP, p.far, 1, 'mountainFar'),
    near: rasterize(MOUNTAIN_NEAR_MAP, p.near, 1, 'mountainNear'),
  }));

  // Fixed starfield, seeded so it is identical every run.
  const rng = mulberry32(20250801);
  const stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: rng() * STAR_WORLD_W,
      y: HUD_H + 4 + rng() * (GROUND_Y - HUD_H - 24),
      big: rng() < 0.18,
    });
  }
  const earthX = 250; // starfield-local x of the Earth

  return {
    screen: screenCanvas, screenCtx, buffer, ctx,
    sprites: buildSprites(), mountains, stars, earthX, tick: 0,
  };
}

// --- helpers -------------------------------------------------------------

function drawTiled(ctx, img, offset, y) {
  const w = img.width;
  let x = -mod(offset, w);
  while (x < VIEW_W) {
    ctx.drawImage(img, Math.round(x), y);
    x += w;
  }
}

// Bitmap-font centered text (see hud.js) — used by every overlay so the
// attract/game-over/stage-clear screens share the HUD's crisp pixel font
// instead of the browser's anti-aliased canvas text.
function centerText(ctx, str, y, color = '#ffffff', scale = 1) {
  const w = textWidth(str, scale);
  drawText(ctx, (VIEW_W - w) / 2, y, str, color, scale);
}

function drawCentered(ctx, img, cx, cy) {
  ctx.drawImage(img, Math.round(cx - img.width / 2), Math.round(cy - img.height / 2));
}

// --- layers --------------------------------------------------------------

function drawSky(r, pal, camX) {
  const { ctx } = r;
  ctx.fillStyle = pal.sky;
  ctx.fillRect(0, 0, VIEW_W, GROUND_Y);

  const off = camX * P_STARS;
  ctx.fillStyle = pal.star;
  for (const s of r.stars) {
    const x = mod(s.x - off, STAR_WORLD_W);
    if (x >= VIEW_W) continue;
    ctx.fillRect(Math.round(x), Math.round(s.y), s.big ? 2 : 1, s.big ? 2 : 1);
  }

  const ex = mod(r.earthX - off, STAR_WORLD_W);
  if (ex < VIEW_W + 16) ctx.drawImage(r.sprites.earth, Math.round(ex), HUD_H + 10);
}

function drawMountains(r, stage, camX) {
  const set = r.mountains[stage] || r.mountains[0];
  drawTiled(r.ctx, set.far, camX * P_FAR, GROUND_Y - set.far.height);
  drawTiled(r.ctx, set.near, camX * P_NEAR, GROUND_Y - set.near.height);
}

function drawTerrain(r, game, pal, camX) {
  const { ctx, sprites } = r;
  const bandH = VIEW_H - GROUND_Y;

  ctx.fillStyle = pal.ground;
  ctx.fillRect(0, GROUND_Y, VIEW_W, bandH);
  ctx.fillStyle = pal.groundShade;
  ctx.fillRect(0, GROUND_Y + 24, VIEW_W, bandH - 24);
  ctx.fillStyle = pal.groundTop;
  ctx.fillRect(0, GROUND_Y, VIEW_W, 2);

  // Sparse dust speckle, keyed off world x so it scrolls with the ground.
  ctx.fillStyle = pal.groundShade;
  const x0 = Math.floor(camX);
  for (let i = 0; i < VIEW_W; i += 2) {
    const wx = x0 + i;
    if (mod(wx * 7, 53) < 2) ctx.fillRect(i, GROUND_Y + 8 + mod(wx, 11), 2, 1);
  }

  const features = featuresInRange(game.terrain, camX - 80, camX + VIEW_W + 80);
  for (const f of features) {
    if (f.destroyed) continue;
    const sx = Math.round(f.x - camX);

    const craterName = CRATER_SPRITE[f.type];
    if (craterName) {
      ctx.drawImage(sprites[craterName], sx, GROUND_Y);
      continue;
    }
    const groundName = GROUND_SPRITE[f.type];
    if (groundName) {
      const img = sprites[groundName];
      ctx.drawImage(img, sx, GROUND_Y - img.height);
      continue;
    }
    if (f.type === 'mine') {
      const img = Math.floor(r.tick / 12) % 2 ? sprites.mine1 : sprites.mine0;
      ctx.drawImage(img, sx, GROUND_Y - img.height + 2);
    }
  }
}

function drawBuggy(r, game, screenX, by) {
  const { ctx, sprites } = r;
  const b = game.buggy;
  const bodyY = Math.round(GROUND_Y + by - 20);

  ctx.drawImage(sprites.buggyBody, screenX, bodyY);

  const wheel = Math.floor(b.wheelPhase * 0.5) % 2 ? sprites.wheel1 : sprites.wheel0;
  for (let i = 0; i < 3; i++) {
    const bob = b.airborne ? 0 : Math.sin(b.wheelPhase + i * 1.7) * 1.5;
    ctx.drawImage(wheel, screenX + 2 + i * 10, Math.round(bodyY + 12 + bob));
  }
}

// Capsules are still empty until Task 9; this loop is the hook-up point and
// reads a `sprite` name off each entity when it exists, falling back to the
// generic capsule sprite.
function drawEntities(r, game, camX) {
  const { ctx, sprites } = r;

  // Player shots pick their sprite off dir ('fwd' -> shotFwd 2x2, 'up' ->
  // shotUp 1x4) rather than a generic fallback, since a single shot list
  // mixes both kinds of sprite.
  for (const s of game.playerShots) {
    const img = sprites[s.dir === 'up' ? 'shotUp' : 'shotFwd'];
    if (!img) continue;
    ctx.drawImage(img, Math.round(s.x - camX), Math.round(s.y));
  }

  // Enemy shots: bombs get the dedicated bomb sprite; aimed/level shots
  // (enemies.js kinds 'aimed'/'level') have no sprite of their own and are
  // drawn as small colored pixels — red for an aimed shot, white for a
  // tank's level shot.
  for (const s of game.enemyShots) {
    const sx = Math.round(s.x - camX);
    const sy = Math.round(s.y);
    if (s.kind === 'bomb') {
      ctx.drawImage(sprites.bomb, sx, sy);
    } else {
      ctx.fillStyle = s.kind === 'aimed' ? '#ff4030' : '#ffffff';
      ctx.fillRect(sx, sy, 2, 2);
    }
  }

  for (const e of game.enemies) {
    const img = sprites[ENEMY_SPRITE[e.kind]];
    if (!img) continue;
    ctx.drawImage(img, Math.round(e.x - camX), Math.round(e.y));
  }

  for (const o of game.capsules) {
    const img = sprites[o.sprite] || sprites.capsule;
    if (!img) continue;
    ctx.drawImage(img, Math.round(o.x - camX), Math.round(o.y));
  }
}

// Draws the active stage-break boss (Task 12): the mothership sprite
// (boss2's hot-red recolor for the Z final boss, boss1 otherwise), a
// flicker while game.boss.telegraph>0 signaling an attack is about to
// fire, and a thin hp bar (green, red once phase2 kicks in) under it.
function drawBoss(r, game, camX) {
  const boss = game.boss;
  if (!boss) return;
  const { ctx, sprites } = r;
  const img = sprites[boss.isFinal ? 'boss2' : 'boss1'] || sprites.boss1;
  if (!img) return;

  const sx = Math.round(boss.x - camX);
  const sy = Math.round(boss.y);

  const flashing = boss.telegraph > 0 && Math.floor(r.tick / 4) % 2 === 0;
  ctx.globalAlpha = flashing ? 0.45 : 1;
  ctx.drawImage(img, sx, sy);
  ctx.globalAlpha = 1;

  const barW = img.width;
  const barY = sy - 6;
  const pct = Math.max(0, Math.min(1, boss.hp / boss.maxHp));
  ctx.fillStyle = '#20141c';
  ctx.fillRect(sx, barY, barW, 3);
  ctx.fillStyle = boss.phase2 ? '#ff4030' : '#60e060';
  ctx.fillRect(sx, barY, Math.round(barW * pct), 3);
}

function drawOverlays(r, game, screenX, by) {
  const { ctx, sprites } = r;

  if (game.phase === 'attract') {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, HUD_H, VIEW_W, GROUND_Y - HUD_H);
    centerText(ctx, 'LUNAR ROVER', 83, '#3a0f26', 3);
    centerText(ctx, 'LUNAR ROVER', 81, '#ff8fc8', 3);
    centerText(ctx, 'RETRO-MOD', 110, '#7fd8ff', 1);

    // Mode-select menu (Task 13): accel/brake toggle game.menuIndex between
    // CLASSIC (0) and ENDLESS (1) — see state.js's 'attract' case; jump/fire
    // starts whichever is highlighted. 'CLASSIC' and 'ENDLESS' are both 7
    // characters, so they share one centered x — only the row's color and a
    // blinking marker square to its left change with the selection.
    const classicSel = game.menuIndex === 0;
    const optW = textWidth('CLASSIC', 1);
    const optX = (VIEW_W - optW) / 2;
    drawText(ctx, optX, 126, 'CLASSIC', classicSel ? '#ffe060' : '#ffffff', 1);
    drawText(ctx, optX, 138, 'ENDLESS', classicSel ? '#ffffff' : '#ffe060', 1);

    const blink = Math.floor(game.phaseTimer * 2) % 2 === 0;
    if (blink) {
      ctx.fillStyle = '#ffe060';
      ctx.fillRect(optX - 10, (classicSel ? 126 : 138) + 1, 4, 4);
    }

    // Top score of the currently-highlighted mode's table.
    const scores = loadScores(classicSel ? 'classic' : 'endless');
    const hi = scores.length ? scores[0].score : 0;
    centerText(ctx, `HI ${String(hi).padStart(6, '0')}`, 155, '#7fd8ff', 1);

    if (blink) {
      centerText(ctx, 'PRESS FIRE', 175, '#ffffff', 1);
    }
    return;
  }

  if (game.phase === 'dying') {
    const frames = [sprites.explosion0, sprites.explosion1, sprites.explosion2];
    const i = Math.min(2, Math.floor((game.phaseTimer / DYING_TIME) * 3));
    drawCentered(ctx, frames[i], screenX + 16, GROUND_Y + by - 10);
    return;
  }

  if (game.phase === 'stageClear') {
    const sc = game.stageClear;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, HUD_H, VIEW_W, GROUND_Y - HUD_H);
    centerText(ctx, sc.isCourseEnd ? 'COURSE CLEAR' : 'STAGE CLEAR', 84, '#7fd8ff', 2);
    centerText(ctx, `BONUS ${sc.paid}`, 110, '#ffe060', 1);
    return;
  }

  if (game.phase === 'gameOver') {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, HUD_H, VIEW_W, GROUND_Y - HUD_H);
    centerText(ctx, 'GAME OVER', 96, '#ff5000', 2);
    if (Math.floor(game.phaseTimer * 2) % 2 === 0) {
      centerText(ctx, 'PRESS FIRE', 128, '#ffffff', 1);
    }
  }
}

// --- entry point ---------------------------------------------------------

/**
 * @param {object} r renderer from createRenderer
 * @param {object} game
 * @param {number} alpha 0..1 fraction of a fixed step already elapsed
 */
export function render(r, game, alpha) {
  const { ctx } = r;
  r.tick++;

  const pal = STAGE_PALETTES[game.stage] || STAGE_PALETTES[0];
  const b = game.buggy;

  // Extrapolate the buggy by the leftover fraction of a step so the world
  // scrolls smoothly at display rate; the buggy itself stays pinned to
  // buggyScreenX, so only the camera actually moves sub-pixel.
  const moving = game.phase === 'playing' || game.phase === 'respawning';
  const step = moving ? DT * alpha : 0;
  const worldX = b.worldX + game.speed * step;
  const by = b.airborne ? b.y + b.vy * step : b.y;
  const camX = worldX - buggyScreenX(game);
  const screenX = Math.round(buggyScreenX(game));

  drawSky(r, pal, camX);
  drawMountains(r, game.stage, camX);
  drawTerrain(r, game, pal, camX);

  // The buggy is hidden while it is exploding, and blinks at 8 Hz while
  // respawning to signal invulnerability.
  const blinkOff = game.phase === 'respawning' && Math.floor(game.phaseTimer * 8) % 2 === 1;
  if (game.phase !== 'dying' && !blinkOff) drawBuggy(r, game, screenX, by);

  drawEntities(r, game, camX);
  drawBoss(r, game, camX);
  drawHUD(ctx, game, r.sprites);
  drawOverlays(r, game, screenX, by);

  r.screenCtx.clearRect(0, 0, r.screen.width, r.screen.height);
  r.screenCtx.drawImage(r.buffer, 0, 0);
}
