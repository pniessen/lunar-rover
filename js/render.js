// render.js — presentation. Owns the 384x240 pixel buffer, the rasterized
// sprite set, and the per-stage background palettes. Reads `game`, never
// writes to it.

import { buildSprites, rasterize, MOUNTAIN_FAR_MAP, MOUNTAIN_NEAR_MAP } from './sprites.js';
import { featuresInRange } from './terrain.js';
import {
  buggyScreenX, DT, DYING_TIME, VIEW_W, VIEW_H, GROUND_Y, HUD_H, INITIALS_LEN,
} from './state.js';
import { BUGGY_W } from './buggy.js';
import { mulberry32 } from './rng.js';
import { drawText, textWidth, drawHUD } from './hud.js';
import { loadScores } from './score.js';
import { createParticles, emit, updateParticles, poolRandom } from './particles.js';

const STAR_WORLD_W = 2048; // starfield wrap width, in starfield-local px
const STAR_COUNT = 110;

// --- Task 14 polish tunables ------------------------------------------------

/**
 * game.fx kind -> {particles, shake}. game.fx is the VISUAL event channel
 * (see particles.js): the sim pushes {kind,x,y} entries, this table turns
 * each into a particle burst and a screen-shake magnitude in buffer pixels.
 * game.events stays the audio channel and is not consulted for shake.
 */
const FX_TABLE = {
  boom: { particles: 'boom', shake: 6 },      // any 'explosion'-family kill
  bombHit: { particles: 'boom', shake: 3 },   // a bomb cratering the ground
  bossDown: { particles: 'boom', shake: 10 }, // mothership destroyed
  spark: { particles: 'spark', shake: 0 },    // boss taking a hit — no shake
};

const SHAKE_DECAY = 8;   // px/s, linear decay of r.shake
const SHAKE_MAX = 10;    // matches the largest FX_TABLE magnitude
// World layers are drawn under a translate of up to +/-SHAKE_MAX px, so every
// full-bleed fill/tile is over-drawn by this margin to keep the shake from
// exposing bare canvas at the edges.
const SHAKE_MARGIN = SHAKE_MAX + 2;

// Wheel dust is rate-limited by DISTANCE TRAVELLED, not wall clock: one puff
// per DUST_EVERY_PX of buggy worldX. At the band-2 cruise speed (200px/s)
// that works out to the ~40ms cadence the brief asks for, and unlike a
// Date.now() timer it is derived purely from game state, so it stays
// deterministic and frame-rate independent.
const DUST_EVERY_PX = 8;

const CRT_KEY = 'lunar-rover-crt';
const SCANLINE_ALPHA = 'rgba(0,0,0,0.25)';

const GAMEOVER_TABLE_ROWS = 5;
const ATTRACT_TABLE_ROWS = 3;

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

// --- CRT preference persistence ---------------------------------------------
// Same guarded-localStorage pattern as score.js/audio.js: every access is
// wrapped, so a browser with storage disabled (or a Node import) simply falls
// back to the default (ON) instead of throwing.

function loadCrtPref() {
  try {
    const v = globalThis.localStorage?.getItem(CRT_KEY);
    return v == null ? true : v === '1'; // default ON
  } catch {
    return true;
  }
}

function saveCrtPref(on) {
  try {
    globalThis.localStorage?.setItem(CRT_KEY, on ? '1' : '0');
  } catch {
    // Persistence unavailable — the in-memory toggle still works this session.
  }
}

/**
 * Builds the CRT overlay ONCE per screen size: horizontal scanlines on every
 * other device row plus a radial vignette, baked into an offscreen canvas.
 * Frame time then costs a single drawImage instead of thousands of fillRects,
 * which is what keeps the effect free at 60fps.
 */
function buildCrtOverlay(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');

  // Scanline pitch is locked to the buffer's upscale factor so every dark
  // line lands on the SAME row of every game pixel. Drawing a strict "every
  // other screen row" at an odd scale (3x: a 2-row period over a 3-row
  // pixel) beats against the pixel grid and reads as uneven zebra banding
  // rather than scanlines. At even scales this rule *is* "every other row"
  // (4x -> 2 dark + 2 light); at 3x it becomes 1 dark + 2 light.
  //
  // Below 2x there is no room for a scanline that isn't also half the
  // artwork, so a small phone-sized viewport gets the vignette only. The
  // effect degrades instead of wrecking the image.
  const scale = Math.max(1, Math.round(w / VIEW_W));
  if (scale >= 2) {
    const thickness = Math.max(1, Math.floor(scale / 2));
    x.fillStyle = SCANLINE_ALPHA;
    for (let y = 0; y < h; y += scale) x.fillRect(0, y, w, thickness);
  }

  const cx = w / 2;
  const cy = h / 2;
  const g = x.createRadialGradient(cx, cy, Math.min(w, h) * 0.30, cx, cy, Math.max(w, h) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.60, 'rgba(0,0,0,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);

  return c;
}

/** Flips the CRT overlay and persists the new preference. Bound to the C key. */
export function toggleCrt(r) {
  r.crt = !r.crt;
  saveCrtPref(r.crt);
  return r.crt;
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

    // Task 14 presentation state. All of this is owned by the renderer, not
    // by `game` — state.js stays a pure simulation with no notion of "shake
    // for 0.4s" or "a puff of dust every 8px".
    particles: createParticles(256),
    shake: 0,          // remaining shake magnitude in buffer px
    shakeX: 0,
    shakeY: 0,
    dustCarry: 0,      // px of travel banked toward the next dust puff
    lastWorldX: null,  // buggy worldX at the previous frame, for that travel delta
    crt: loadCrtPref(),
    crtOverlay: null,  // rebuilt lazily whenever the screen canvas resizes
    crtW: 0,
    crtH: 0,
  };
}

// --- helpers -------------------------------------------------------------

// Tiles one strip across the viewport. The extra SHAKE_MARGIN tile on each
// side keeps the strip full-bleed while the world layers are translated by
// the screen shake (see applyShake in render()).
function drawTiled(ctx, img, offset, y) {
  const w = img.width;
  let x = -mod(offset, w) - w;
  while (x < VIEW_W + SHAKE_MARGIN) {
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
  const M = SHAKE_MARGIN;
  ctx.fillStyle = pal.sky;
  ctx.fillRect(-M, -M, VIEW_W + 2 * M, GROUND_Y + M);

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
  const M = SHAKE_MARGIN; // over-draw so the shake never exposes bare canvas

  ctx.fillStyle = pal.ground;
  ctx.fillRect(-M, GROUND_Y, VIEW_W + 2 * M, bandH + M);
  ctx.fillStyle = pal.groundShade;
  ctx.fillRect(-M, GROUND_Y + 24, VIEW_W + 2 * M, bandH - 24 + M);
  ctx.fillStyle = pal.groundTop;
  ctx.fillRect(-M, GROUND_Y, VIEW_W + 2 * M, 2);

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

// --- particles / shake glue -------------------------------------------------
//
// Presentation state is fed from the simulation ONCE per rendered frame, here,
// and only ever by reading: game.fx (the visual event channel — consumed and
// cleared, mirroring how main.js consumes and clears game.events after audio)
// plus a couple of derived reads off game itself for the continuous effects.
// state.js never learns that particles exist.

/**
 * Drains game.fx into particle bursts + screen shake, and emits the
 * continuous/event-driven effects that have no fx entry of their own
 * (wheel dust, muzzle flash).
 */
function consumeFx(r, game, simDt) {
  const p = r.particles;

  const fx = game.fx;
  if (fx && fx.length) {
    for (let i = 0; i < fx.length; i++) {
      const e = fx[i];
      const spec = FX_TABLE[e.kind];
      if (!spec) continue;
      emit(p, spec.particles, e.x, e.y);
      // A mothership goes out with a second, offset burst so it reads as a
      // bigger event than a regular kill rather than just a louder one.
      if (e.kind === 'bossDown') emit(p, 'boom', e.x - 10, e.y + 6);
      // Strongest pending shake wins; shakes never stack into a rumble.
      if (spec.shake > r.shake) r.shake = Math.min(SHAKE_MAX, spec.shake);
    }
    fx.length = 0;
  }

  // Muzzle flash: 'fire' is an audio event with no position, and the cannon
  // position is trivially derivable from the buggy, so this one is read
  // straight off game.events (render runs before main.js clears them).
  // Counted rather than tested, since a laggy frame can contain several
  // simulation steps and therefore several shots.
  const b = game.buggy;
  const events = game.events;
  if (events) {
    for (let i = 0; i < events.length; i++) {
      if (events[i] === 'fire') {
        emit(p, 'muzzle', b.worldX + BUGGY_W, GROUND_Y + b.y - 10);
      } else if (events[i] === 'land') {
        emit(p, 'dust', b.worldX + BUGGY_W / 2, GROUND_Y - 1);
      }
    }
  }

  // Wheel dust while grounded at the top speed band. Rate-limited by distance
  // travelled (see DUST_EVERY_PX) rather than by a wall clock, so it is
  // derived purely from game state and stays deterministic.
  const driving = game.phase === 'playing' || game.phase === 'boss'
    || game.phase === 'respawning';
  const delta = r.lastWorldX == null ? 0 : Math.max(0, b.worldX - r.lastWorldX);
  r.lastWorldX = b.worldX;
  if (driving && !b.airborne && b.alive && b.band === 2) {
    r.dustCarry += delta;
    let guard = 4; // cap bursts per frame after a lag spike / respawn jump
    while (r.dustCarry >= DUST_EVERY_PX && guard-- > 0) {
      r.dustCarry -= DUST_EVERY_PX;
      emit(p, 'dust', b.worldX + 6, GROUND_Y - 1);
    }
    if (r.dustCarry > DUST_EVERY_PX) r.dustCarry = 0;
  } else {
    r.dustCarry = 0;
  }

  // Particles and shake age by the SIMULATION time that actually elapsed this
  // frame (steps * DT), not by one DT per rendered frame. A rendered frame can
  // contain zero, one or several fixed steps, so the naive version would run
  // effects 2.4x fast on a 144Hz display and at half speed on a 30Hz one.
  updateParticles(p, simDt);

  // Shake decays linearly and is resolved to an INTEGER offset, so the world
  // layers always land on whole buffer pixels and never blur.
  if (r.shake > 0) {
    r.shake = Math.max(0, r.shake - SHAKE_DECAY * simDt);
    const mag = r.shake;
    // Reuse the particle pool's seeded PRNG rather than Math.random(), so the
    // renderer stays free of unseeded entropy (see particles.js).
    r.shakeX = Math.round((poolRandom(p) * 2 - 1) * mag);
    r.shakeY = Math.round((poolRandom(p) * 2 - 1) * mag);
  } else {
    r.shakeX = 0;
    r.shakeY = 0;
  }
}

/**
 * Draws every live particle as a chunky 1-4px square. `x` is a world
 * coordinate (so particles stay planted on the ground they were thrown from
 * as the camera scrolls past); `y` is already a screen coordinate. Called
 * inside the screen-shake transform, so bursts shake with the world.
 */
function drawParticles(r, camX) {
  const { ctx } = r;
  const items = r.particles.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.active) continue;
    const sx = Math.round(it.x - camX);
    if (sx < -8 || sx > VIEW_W + 8) continue;
    ctx.fillStyle = it.color;
    ctx.fillRect(sx, Math.round(it.y), it.size, it.size);
  }
}

// --- high-score tables ------------------------------------------------------

function scoreRow(rank, entry) {
  const initials = String(entry?.initials ?? '---').slice(0, INITIALS_LEN).padEnd(INITIALS_LEN, ' ');
  const score = String(entry?.score ?? 0).padStart(6, '0');
  return `${rank} ${initials} ${score}`;
}

/**
 * Draws `rows` rows of the mode's table starting at y. The row matching the
 * initials just submitted this run (game.lastInitials at game.score) is
 * highlighted so the player can find their own entry instantly.
 */
function drawScoreTable(ctx, game, rows, y, lineH) {
  const scores = loadScores(game.mode);
  let highlighted = false;
  for (let i = 0; i < rows; i++) {
    const e = scores[i];
    const mine = !highlighted && e && game.lastInitials
      && e.initials === game.lastInitials && e.score === game.score;
    if (mine) highlighted = true;
    const color = mine ? '#ffffff' : (i === 0 ? '#ffe060' : '#7fd8ff');
    centerText(ctx, scoreRow(i + 1, e), y + i * lineH, color, 1);
  }
}

// hud.js's font cell, mirrored here for laying out the oversized initials
// slots. Kept as a local constant rather than exported from hud.js: it is a
// layout detail of this screen, not part of the font's public contract.
const GLYPH_BLOCK_W = 5;
const GLYPH_BLOCK_H = 7;

function drawEnterScore(ctx, game) {
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, HUD_H, VIEW_W, GROUND_Y - HUD_H);

  centerText(ctx, 'NEW HIGH SCORE', 50, '#3a0f26', 2);
  centerText(ctx, 'NEW HIGH SCORE', 48, '#ffe060', 2);
  centerText(ctx, `SCORE ${String(game.score).padStart(6, '0')}`, 74, '#7fd8ff', 1);

  const entry = game.initialsEntry;
  if (!entry) return;

  // Three 4x glyphs on a fixed pitch, centered as a block.
  const scale = 4;
  const pitch = 32;
  const blockW = pitch * (INITIALS_LEN - 1) + GLYPH_BLOCK_W * scale;
  let x = Math.round((VIEW_W - blockW) / 2);
  const y = 96;
  const blink = Math.floor(game.phaseTimer * 4) % 2 === 0;

  for (let i = 0; i < INITIALS_LEN; i++) {
    const active = i === entry.index;
    const done = i < entry.index;
    let color = '#5a5a78';
    if (done) color = '#ffffff';
    if (active) color = blink ? '#ffe060' : '#8a6a20';
    drawText(ctx, x, y, entry.slots[i], color, scale);
    // Underline caret under the slot being edited.
    ctx.fillStyle = active ? (blink ? '#ffe060' : '#3a3a5c') : '#3a3a5c';
    ctx.fillRect(x, y + GLYPH_BLOCK_H * scale + 3, GLYPH_BLOCK_W * scale, 2);
    x += pitch;
  }

  centerText(ctx, 'LEFT RIGHT PICK LETTER', 146, '#7fd8ff', 1);
  centerText(ctx, 'FIRE TO ENTER', 160, '#ffffff', 1);
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

    // Top 3 of the currently-highlighted mode's table (Task 14 — this used
    // to be a single HI line). Empty slots render as '--- 000000' so the
    // block keeps a fixed height and the menu below it never jumps.
    const scores = loadScores(classicSel ? 'classic' : 'endless');
    for (let i = 0; i < ATTRACT_TABLE_ROWS; i++) {
      centerText(ctx, scoreRow(i + 1, scores[i]), 152 + i * 10,
        i === 0 ? '#ffe060' : '#7fd8ff', 1);
    }

    if (blink) {
      centerText(ctx, 'PRESS FIRE', 186, '#ffffff', 1);
    }
    return;
  }

  if (game.phase === 'enterScore') {
    drawEnterScore(ctx, game);
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
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, HUD_H, VIEW_W, GROUND_Y - HUD_H);
    centerText(ctx, 'GAME OVER', 50, '#ff5000', 2);
    // Task 14: the run's own table, so a fresh entry is visible immediately
    // rather than only after returning to the attract screen.
    centerText(ctx, `${game.mode} TOP ${GAMEOVER_TABLE_ROWS}`, 76, '#ffffff', 1);
    drawScoreTable(ctx, game, GAMEOVER_TABLE_ROWS, 90, 11);
    if (Math.floor(game.phaseTimer * 2) % 2 === 0) {
      centerText(ctx, 'PRESS FIRE', 158, '#ffffff', 1);
    }
  }
}

// --- entry point ---------------------------------------------------------

/**
 * @param {object} r renderer from createRenderer
 * @param {object} game
 * @param {number} alpha 0..1 fraction of a fixed step already elapsed
 * @param {number} [simDt=DT] simulation seconds that elapsed since the last
 *   render — i.e. (fixed steps run this frame) * DT. Particles and screen
 *   shake age by this rather than by one DT per rendered frame, so they run
 *   at the same real-world speed on a 30Hz, 60Hz or 144Hz display. Defaults
 *   to a single step for callers that do not track it.
 */
export function render(r, game, alpha, simDt = DT) {
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

  // Feed the presentation-only effect state from this frame's simulation
  // output BEFORE anything is drawn — and, critically, before main.js clears
  // game.events after the audio pass. Also drains and clears game.fx.
  consumeFx(r, game, simDt);

  // Screen shake translates the WORLD layers only, by a whole number of
  // buffer pixels. The HUD and every overlay are drawn after the restore(),
  // so text and gauges stay rock-steady while the ground jumps.
  ctx.save();
  ctx.translate(r.shakeX, r.shakeY);

  drawSky(r, pal, camX);
  drawMountains(r, game.stage, camX);
  drawTerrain(r, game, pal, camX);

  // The buggy is hidden while it is exploding, and blinks at 8 Hz while
  // respawning to signal invulnerability.
  const blinkOff = game.phase === 'respawning' && Math.floor(game.phaseTimer * 8) % 2 === 1;
  if (game.phase !== 'dying' && !blinkOff) drawBuggy(r, game, screenX, by);

  drawEntities(r, game, camX);
  drawBoss(r, game, camX);
  drawParticles(r, camX);

  ctx.restore();

  drawHUD(ctx, game, r.sprites);
  drawOverlays(r, game, screenX, by);

  presentToScreen(r);
}

/**
 * Blits the 384x240 buffer up to the screen canvas and composites the CRT
 * overlay on top of the SCALED result, so scanlines land on real screen rows
 * rather than being magnified into zebra stripes.
 *
 * main.js sizes the screen canvas's backing store to an integer multiple of
 * the buffer (see resizeCanvas), so the upscale is always a crisp
 * nearest-neighbour blow-up. The overlay canvas is rebuilt only when that
 * size actually changes — never per frame — which keeps this whole step at
 * two drawImage calls.
 */
function presentToScreen(r) {
  const { screen, screenCtx } = r;
  const w = screen.width;
  const h = screen.height;

  if (r.crtW !== w || r.crtH !== h) {
    r.crtOverlay = buildCrtOverlay(w, h);
    r.crtW = w;
    r.crtH = h;
    // Resizing a canvas resets its 2D context state, so re-assert this.
    screenCtx.imageSmoothingEnabled = false;
  }

  screenCtx.clearRect(0, 0, w, h);
  screenCtx.drawImage(r.buffer, 0, 0, w, h);
  if (r.crt && r.crtOverlay) screenCtx.drawImage(r.crtOverlay, 0, 0);
}
