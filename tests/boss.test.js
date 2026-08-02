import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startBoss, updateBoss, hitBoss, bossBox, BOMB_OFFSETS, FINAL_HP, FINAL_PHASE2_HP,
} from '../js/boss.js';
import {
  createGame, updateGame, DT, buggyScreenX, VIEW_W, GROUND_Y, BOSS_ARENA_AHEAD,
} from '../js/state.js';
import { BUGGY_W } from '../js/buggy.js';
import { spawnCapsule } from '../js/powerups.js';
import {
  clearNaturalZone, featuresInRange, NATURAL_TYPES, STAGE_BREAKS, checkpointX,
  CHECKPOINT_SPACING, createEndlessTerrain, ensureGenerated,
} from '../js/terrain.js';

const noInput = {
  state: { accel: false, brake: false, jump: false, fire: false, pause: false, mute: false, restart: false },
  pressed: () => false,
  endFrame() {},
};
const press = (...names) => ({
  state: { accel: false, brake: false, jump: false, fire: false, pause: false, mute: false, restart: false },
  pressed: (n) => names.includes(n),
  endFrame() {},
});

const step = (game, input = noInput, frames = 1) => {
  for (let i = 0; i < frames; i++) updateGame(game, input, DT);
};

// --- startBoss: hp scaling ----------------------------------------------------

test('startBoss scales maxHp with stage, and the Z final boss is a fixed 46hp two-phase fight', () => {
  const g0 = createGame('classic', 1);
  g0.stage = 0;
  startBoss(g0);
  assert.equal(g0.boss.maxHp, 18);
  assert.equal(g0.boss.hp, 18);
  assert.equal(g0.boss.isFinal, false);

  const g3 = createGame('classic', 1);
  g3.stage = 3;
  startBoss(g3);
  assert.equal(g3.boss.maxHp, 36);

  const gFinal = createGame('classic', 1);
  gFinal.stage = 4;
  startBoss(gFinal);
  assert.equal(gFinal.boss.maxHp, FINAL_HP);
  assert.equal(gFinal.boss.hp, FINAL_HP);
  assert.equal(gFinal.boss.isFinal, true);
  assert.equal(gFinal.boss.phase2, false);
});

test('startBoss positions the boss ahead of the buggy and sets the enter pattern', () => {
  const g = createGame('classic', 1);
  g.buggy.worldX = 500;
  startBoss(g);
  assert.equal(g.boss.pattern, 'enter');
  assert.equal(g.boss.patternT, 0);
  assert.ok(g.boss.x > g.buggy.worldX, 'boss spawns ahead of the buggy');
});

// --- pattern cycle order -------------------------------------------------------

test('stage-0 boss cycles enter -> hover -> telegraph -> bombCarpet -> hover -> telegraph -> aimedBurst -> hover', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  g.playerShots = [];
  g.enemyShots = [];

  const seen = [g.boss.pattern];
  for (let i = 0; i < 2000 && seen.length < 8; i++) {
    updateBoss(g, DT);
    if (g.boss.pattern !== seen.at(-1)) seen.push(g.boss.pattern);
  }

  assert.deepEqual(seen, [
    'enter', 'hover', 'telegraph', 'bombCarpet',
    'hover', 'telegraph', 'aimedBurst', 'hover',
  ]);
});

test('stage-0 boss never enters diveSweep (only unlocked at stage>=2 or phase2)', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  g.playerShots = [];
  g.enemyShots = [];

  const seen = new Set();
  for (let i = 0; i < 6000; i++) {
    updateBoss(g, DT);
    seen.add(g.boss.pattern);
  }
  assert.ok(!seen.has('diveSweep'));
});

test('stage-2+ boss pattern cycle includes diveSweep', () => {
  const g = createGame('classic', 1);
  g.stage = 2;
  startBoss(g);
  g.playerShots = [];
  g.enemyShots = [];

  const seen = new Set();
  for (let i = 0; i < 6000; i++) {
    updateBoss(g, DT);
    seen.add(g.boss.pattern);
  }
  assert.ok(seen.has('diveSweep'));
});

test('telegraph flag is set during the telegraph window and an event is pushed', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  g.playerShots = [];
  g.enemyShots = [];

  let sawTelegraph = false;
  for (let i = 0; i < 400; i++) {
    updateBoss(g, DT);
    if (g.boss.pattern === 'telegraph') {
      sawTelegraph = true;
      assert.ok(g.boss.telegraph > 0);
    }
  }
  assert.ok(sawTelegraph);
  assert.ok(g.events.includes('bossTelegraph'));
});

test('bombCarpet fires exactly 5 bombs into game.enemyShots', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  g.playerShots = [];
  g.enemyShots = [];

  for (let i = 0; i < 400 && g.boss.pattern !== 'bombCarpet'; i++) updateBoss(g, DT);
  assert.equal(g.boss.pattern, 'bombCarpet');

  for (let i = 0; i < 400 && g.boss.pattern === 'bombCarpet'; i++) updateBoss(g, DT);
  assert.equal(g.enemyShots.filter((s) => s.kind === 'bomb').length, 5);
});

test('aimedBurst fires exactly 3 aimed shots, capped at 160px/s', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  g.playerShots = [];
  g.enemyShots = [];

  for (let i = 0; i < 1000 && g.boss.pattern !== 'aimedBurst'; i++) updateBoss(g, DT);
  assert.equal(g.boss.pattern, 'aimedBurst');

  for (let i = 0; i < 400 && g.boss.pattern === 'aimedBurst'; i++) updateBoss(g, DT);
  const shots = g.enemyShots.filter((s) => s.kind === 'aimed');
  assert.equal(shots.length, 3);
  for (const s of shots) {
    const speed = Math.hypot(s.vx, s.vy);
    assert.ok(speed <= 160 + 1e-9, `aimed shot speed ${speed} must be <= 160`);
  }
});

// --- hitBoss -------------------------------------------------------------------

test('hitBoss decrements hp and awards 200 bossHit', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  const scoreBefore = g.score;

  hitBoss(g, 1);
  assert.equal(g.boss.hp, 17);
  assert.equal(g.score - scoreBefore, 200);
  assert.equal(g.scoreEvents.at(-1).tag, 'bossHit');
});

test('killing the boss emits bossDown, pays bossKill, drops a capsule, and nulls game.boss', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  g.capsules = [];
  const scoreBefore = g.score;

  for (let i = 0; i < 18; i++) hitBoss(g, 1);

  assert.equal(g.boss, null);
  assert.ok(g.events.includes('bossDown'));
  assert.ok(g.scoreEvents.some((ev) => ev.tag === 'bossKill' && ev.base === 2000));
  assert.ok(g.score > scoreBefore);
  assert.equal(g.capsules.length, 1, 'a guaranteed capsule was dropped');
});

test('bossKill bonus scales with stage (2000 + stage*1000)', () => {
  const g = createGame('classic', 1);
  g.stage = 2;
  startBoss(g);
  for (let i = 0; i < 30; i++) hitBoss(g, 1);
  const killEv = g.scoreEvents.find((ev) => ev.tag === 'bossKill');
  assert.equal(killEv.base, 4000);
});

test('the final boss enters phase2 at the half-hp mark, and the threshold tracks FINAL_HP', () => {
  // The invariant, not the literal: phase 2 is the SECOND HALF of the finale.
  // These drifted apart once already (FINAL_HP 40 -> 46 with the threshold
  // left at 20, moving the transition to 43% of the bar) and nothing caught
  // it, because the test asserted the literal 20 rather than the split.
  assert.equal(FINAL_PHASE2_HP, Math.floor(FINAL_HP / 2),
    'phase 2 must begin at half of the finale\'s max hp');

  const g = createGame('classic', 1);
  g.stage = 4;
  startBoss(g);
  assert.equal(g.boss.maxHp, FINAL_HP);
  assert.equal(g.boss.phase2, false);

  for (let i = 0; i < FINAL_HP - FINAL_PHASE2_HP - 1; i++) hitBoss(g, 1);
  assert.equal(g.boss.hp, FINAL_PHASE2_HP + 1);
  assert.equal(g.boss.phase2, false, 'one hit above the threshold is still phase 1');

  hitBoss(g, 1);
  assert.equal(g.boss.hp, FINAL_PHASE2_HP);
  assert.equal(g.boss.phase2, true);
});

test('a non-final boss never sets phase2', () => {
  const g = createGame('classic', 1);
  g.stage = 3;
  startBoss(g);
  for (let i = 0; i < 15; i++) hitBoss(g, 1);
  assert.equal(g.boss.hp, 21);
  assert.equal(g.boss.phase2, false);
});

test('player shots (fwd and up) hit the boss via updateBoss', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  g.boss.pattern = 'hover'; // stable position, not mid-enter
  g.enemyShots = [];

  g.playerShots = [
    { x: g.boss.x, y: g.boss.y, vx: 300, vy: 0, dir: 'fwd' },
  ];
  updateBoss(g, DT);
  assert.equal(g.boss.hp, 17, 'fwd shot overlapping the boss hitbox scores a hit');
  assert.equal(g.playerShots.length, 0, 'the consumed shot is removed');

  g.playerShots = [
    { x: g.boss.x, y: g.boss.y, vx: 0, vy: -260, dir: 'up' },
  ];
  updateBoss(g, DT);
  assert.equal(g.boss.hp, 16, 'up shot overlapping the boss hitbox also scores a hit');
});

// --- clearNaturalZone ----------------------------------------------------------

test('clearNaturalZone removes every natural feature overlapping the given range', () => {
  const terrain = {
    features: [
      { id: 1, type: 'crater', x: 0, w: 20, hp: 0, destroyed: false },
      { id: 2, type: 'rock', x: 500, w: 16, hp: 1, destroyed: false },
      { id: 3, type: 'mine', x: 1000, w: 12, hp: 0, destroyed: false },
      { id: 4, type: 'crater', x: 2000, w: 20, hp: 0, destroyed: false },
    ],
  };
  clearNaturalZone(terrain, 400, 1100);
  assert.deepEqual(terrain.features.map((f) => f.id), [1, 4]);
});

test('clearNaturalZone spares bombCraters — the boss arena clears the level, not the fight', () => {
  // The rolling arena (state.js's maintainBossArena) re-applies this over a
  // window that runs 800px ahead of the buggy, and the boss's carpet lands
  // 260-530px ahead: dead centre of that window. A type-blind clear would
  // delete the boss's entire ground attack within a frame of it landing.
  const terrain = {
    features: [
      { id: 1, type: 'crater', x: 100, w: 24, hp: 0, destroyed: false },
      { id: 2, type: 'bombCrater', x: 200, w: 28, hp: 0, destroyed: false },
      { id: 3, type: 'bigRock', x: 300, w: 22, hp: 2, destroyed: false },
      { id: 4, type: 'bombCrater', x: 400, w: 28, hp: 0, destroyed: false },
      { id: 5, type: 'mine', x: 500, w: 12, hp: 0, destroyed: false },
    ],
  };
  clearNaturalZone(terrain, 0, 1000);
  assert.deepEqual(terrain.features.map((f) => f.id), [2, 4],
    'every natural type is swept and only the bomb craters remain');
  // And the exemption is exactly one type wide — no natural type sneaks in.
  assert.ok(!NATURAL_TYPES.has('bombCrater'));
  for (const t of ['crater', 'bigCrater', 'doubleCrater', 'rock', 'bigRock', 'mine']) {
    assert.ok(NATURAL_TYPES.has(t), `${t} is swept by the arena`);
  }
});

// --- state.js integration -------------------------------------------------------

test('crossing break E diverts playing -> boss, and killing the boss returns to stageClear', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  const breakIdx = STAGE_BREAKS[0]; // E
  g.buggy.worldX = checkpointX(breakIdx) - 1;

  step(g); // crosses the checkpoint this frame
  assert.equal(g.phase, 'boss');
  assert.ok(g.boss);
  assert.equal(g.boss.maxHp, 18);

  // Line up a one-shot kill: the boss-vs-playerShot collision must happen
  // *inside* the same updateGame() call state.js uses to detect the
  // boss->null transition, so the shot (not a direct hitBoss() call from
  // the test) is what has to land the blow.
  g.boss.hp = 1;
  g.playerShots = [{ x: g.boss.x + 10, y: g.boss.y + 5, vx: 300, vy: 0, dir: 'fwd' }];

  step(g);

  assert.equal(g.phase, 'stageClear');
  assert.equal(g.boss, null);
});

test('buggy death during a boss fight preserves game.boss and resumes the fight after respawn', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  const breakIdx = STAGE_BREAKS[0];
  g.buggy.worldX = checkpointX(breakIdx) - 1;

  step(g); // -> boss
  assert.equal(g.phase, 'boss');
  const bossRef = g.boss;

  // Force a lethal enemy shot onto the buggy (simulating a boss bomb/aimed
  // hit) without waiting out the real pattern timing.
  g.enemyShots.push({
    id: 'x', kind: 'bomb', from: 'boss', x: g.buggy.worldX + 10, y: 200, vx: 0, vy: 0,
  });
  step(g);
  assert.equal(g.phase, 'dying');
  assert.equal(g.boss, bossRef, 'the same boss object persists through death, not a fresh one');

  let n = 0;
  while (g.phase === 'dying' && n < 200) { step(g); n++; }
  assert.equal(g.phase, 'respawning');
  assert.ok(g.boss, 'boss persists through the dying window');

  n = 0;
  while (g.phase === 'respawning' && n < 200) { step(g); n++; }
  assert.equal(g.phase, 'boss', 'the fight resumes rather than dropping back to playing');
  assert.ok(g.boss);
});

test('the boss arena is open from the frame the fight starts, at every stage break', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  const breakIdx = STAGE_BREAKS[0];
  // Seed a real classic-course-shaped terrain feature just past the break
  // line, inside where the arena should be carved.
  const arenaX = checkpointX(breakIdx) + 100;
  g.terrain.features.push({ id: 99999, type: 'rock', x: arenaX, w: 16, hp: 1, destroyed: false });
  g.buggy.worldX = checkpointX(breakIdx) - 1;

  step(g); // -> boss, arena should now be cleared
  assert.equal(g.phase, 'boss');
  assert.equal(featuresInRange(g.terrain, arenaX - 5, arenaX + 20).length, 0);
});

// --- review fix round 1 regressions ---------------------------------------

// FINDING 1 (Critical): a boss bomb/aimed shot killing the buggy in
// updateEnemies() and the player's shot dropping the boss to 0 in
// updateBoss() could both land in the exact same updateGame() call. The
// original code let the bossWasAlive->null transition win, entering
// 'stageClear' immediately over a visibly dead, frozen buggy — no life
// deducted, no dying/respawn flow, until a stale 'playing'-phase check
// caught up ~2.5s later. Buggy death must always take priority; the boss's
// stage bonus is deferred (via game.bossStageClearCheckpoint) rather than
// lost, and paid out once the death/respawn cycle completes.
test('same-frame boss-death + buggy-death race: buggy death wins immediately, bonus is paid after respawn', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  const breakIdx = STAGE_BREAKS[0]; // E
  g.buggy.worldX = checkpointX(breakIdx) - 1;

  step(g); // playing -> boss
  assert.equal(g.phase, 'boss');

  // Line up a simultaneous kill: a lethal enemy shot overlapping the buggy
  // AND a lethal player shot overlapping the boss, both resolved within the
  // same updateGame() call.
  g.boss.hp = 1;
  g.playerShots = [{ x: g.boss.x + 10, y: g.boss.y + 5, vx: 300, vy: 0, dir: 'fwd' }];
  g.enemyShots = [{ id: 'x', kind: 'bomb', from: 'boss', x: g.buggy.worldX + 10, y: 200, vx: 0, vy: 0 }];
  const livesBefore = g.lives;
  const scoreEventsBefore = g.scoreEvents.length;

  step(g);

  assert.equal(g.phase, 'dying', 'the buggy death takes priority over the boss-down transition this frame');
  assert.equal(g.buggy.alive, false);
  assert.equal(g.lives, livesBefore - 1, 'exactly one life is deducted for this death cycle');
  assert.equal(g.boss, null, 'the boss is still resolved as dead this same frame');
  assert.ok(
    g.scoreEvents.slice(scoreEventsBefore).some((ev) => ev.tag === 'bossKill'),
    'bossKill is still awarded even though the transition to stageClear is deferred',
  );
  assert.equal(g.bossStageClearCheckpoint, breakIdx, 'the checkpoint is stashed so the bonus is not lost');

  // Run out dying -> respawning -> (deferred) stageClear -> playing, and
  // confirm no second life is ever deducted along the way.
  let n = 0;
  while (g.phase === 'dying' && n < 200) { step(g); n++; }
  assert.equal(g.phase, 'respawning');
  assert.equal(g.lives, livesBefore - 1, 'still only one life lost');

  n = 0;
  while (g.phase === 'respawning' && n < 200) { step(g); n++; }
  assert.equal(g.phase, 'stageClear', 'the deferred boss stage bonus is entered once respawn completes');
  assert.equal(g.bossStageClearCheckpoint, null, 'the stash is consumed');
  assert.equal(g.lives, livesBefore - 1, 'still only one life lost');

  const scoreAtStageClearEntry = g.score;
  n = 0;
  while (g.phase === 'stageClear' && n < 20000) { step(g); n++; }
  assert.equal(g.phase, 'playing', 'stageClear finishes normally, bumping stage');
  assert.equal(g.stage, 1);
  assert.ok(g.score > scoreAtStageClearEntry, 'the stage bonus tally actually paid out');
  assert.equal(g.lives, livesBefore - 1, 'still only one life lost across the whole cycle');
});

// FINDING 2 (Important): enterBoss cleared terrain features (clearNaturalZone)
// but left game.enemies/game.enemyShots untouched — a wave enemy (or its
// in-flight shot) still alive right at the break line would survive into
// the "cleared" arena and could ram/shoot the buggy during the fight,
// contradicting the fair-arena design.
test('crossing a stage break clears stale wave enemies and enemy shots out of the arena', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  const breakIdx = STAGE_BREAKS[0];
  g.buggy.worldX = checkpointX(breakIdx) - 1;
  g.enemies = [{ id: 1, kind: 'tank', x: g.buggy.worldX + 50, y: 0, vx: 0, vy: 0, hp: 1, t: 0 }];
  g.enemyShots = [{ id: 2, kind: 'level', from: 1, x: g.buggy.worldX + 50, y: 0, vx: -1, vy: 0 }];

  step(g); // playing -> boss

  assert.equal(g.phase, 'boss');
  assert.deepEqual(g.enemies, [], 'stale wave enemies do not survive into the boss arena');
  assert.deepEqual(g.enemyShots, [], 'stale enemy shots do not survive into the boss arena');
});

// --- FINAL REVIEW: real reachability (findings C1 / C2) --------------------
//
// The tests above prove the collision FUNCTION works; they proved nothing
// about whether a player can ever put a shot inside that box, because every
// one of them hand-places shots into game.playerShots. The final review found
// that they could not: the boss was pinned 200px ahead of the buggy, up-shots
// had no forward carry (so they fell behind their own target forever),
// forward shots fly at y≈190 against a box at y 70..90 — and, underneath all
// of that, fireDual refused to fire at all while game.phase === 'boss'.
//
// The tests below are the gate for that class of bug. They never touch
// game.playerShots: a bot drives a real game into a real boss fight and
// presses 'fire' through updateGame, exactly as a player would.

// A "competent player" model: holds a cruise band, taps fire on a fixed
// cooldown, and jumps hazards — checking not just what it is jumping OVER but
// where it will LAND, which is the actual skill the bomb carpet asks for. It
// is a probe for shot REACHABILITY, not a demonstration of optimal play; it
// still loses the occasional life to a carpet, so these runs get a little
// life headroom (deaths only slow a fight down, they never make an
// unreachable boss reachable).
function playerBot(g, fireEvery = 15) {
  let frame = -1;
  return {
    tick() { frame++; },
    state: {},
    pressed(n) {
      if (n === 'fire') return frame % fireEvery === 0;
      if (n !== 'jump') return false;
      const b = g.buggy;
      if (b.airborne || b.settle > 0) return false;
      const mid = b.worldX + 16;
      const reach = g.speed * 1.0; // airtime is 2*|JUMP_VY|/GRAVITY == 1.0s
      const feats = (g.terrain.mode === 'test'
        ? g.terrain.features
        : featuresInRange(g.terrain, mid, mid + reach + 120))
        .filter((f) => !f.destroyed && f.x + f.w > mid + 6)
        .sort((a, c) => a.x - c.x);
      if (!feats.length) return false;
      const d = feats[0].x - mid;
      if (d < 4 || d > 40) return false;
      let end = feats[0].x + feats[0].w;
      for (const f of feats.slice(1)) {
        if (f.x - end > 34) break; // a gap the buggy can actually sit in
        end = f.x + f.w;
      }
      const land = mid + reach;
      const landBlocked = feats.some((f) => f.x - 20 < land && f.x + f.w + 20 > land);
      if (!landBlocked && end - mid + 12 < reach) return true;
      return d < 10; // out of road: jump anyway rather than drive in
    },
    endFrame() {},
  };
}

/** Drives a fresh classic run across `stage`'s break line and into the fight. */
function enterFightAt(stage, seed = 7) {
  const g = createGame('classic', seed);
  g.phase = 'playing';
  g.stage = stage;
  g.lives = 6; // headroom for the bot's occasional carpet death
  g.buggy.worldX = checkpointX(STAGE_BREAKS[stage]) - 1;
  step(g); // crosses the break line -> 'boss'
  assert.equal(g.phase, 'boss');
  return g;
}

/**
 * Runs `g` for at most `seconds` of simulated time with the bot at the
 * controls, returning when the boss dies. Every shot in the fight is fired by
 * the bot pressing 'fire' through updateGame — nothing is hand-placed.
 */
function fightWithBot(g, seconds = 60, fireEvery = 15, wrap = null) {
  const base = playerBot(g, fireEvery);
  const input = wrap ? wrap(base) : base;
  assert.equal(g.phase, 'boss', 'the run is in the fight');
  const startHp = g.boss.hp;
  let hits = 0;
  let prevHp = startHp;
  let frames = 0;
  const maxFrames = Math.round(seconds / DT);
  while (g.boss && frames < maxFrames) {
    input.tick(g);
    updateGame(g, input, DT);
    frames++;
    if (g.boss && g.boss.hp < prevHp) {
      hits += prevHp - g.boss.hp;
      prevHp = g.boss.hp;
    }
  }
  if (!g.boss) hits += prevHp; // the killing blow(s) took the last hp
  return { hits, startHp, seconds: frames * DT, killed: !g.boss };
}

/**
 * An input wrapper that hands the buggy a fresh shield every frame. killBuggy
 * spends the shield and returns false, so the buggy is effectively immortal
 * while everything else about the sim — speed, terrain, the boss's patterns,
 * the bomb carpet — runs untouched.
 */
function shieldEveryFrame(g) {
  return (inner) => ({
    tick(...a) { g.powerup = { type: 'shield', remaining: Infinity }; inner.tick(...a); },
    state: inner.state,
    pressed: (n) => inner.pressed(n),
    endFrame() { inner.endFrame(); },
  });
}

/** An input wrapper that pins the buggy to a chosen speed band. */
function holdBand(g, band) {
  return (inner) => ({
    tick(...a) { inner.tick(...a); },
    state: inner.state,
    pressed(n) {
      if (n === 'accel') return g.buggy.band < band;
      if (n === 'brake') return g.buggy.band > band;
      return inner.pressed(n);
    },
    endFrame() { inner.endFrame(); },
  });
}

test('REACHABILITY: a stage-0 boss can be shot down by a player firing through the real input path', () => {
  const g = enterFightAt(0);
  assert.equal(g.boss.maxHp, 18);
  const r = fightWithBot(g, 90);

  assert.ok(r.hits > 1, `the boss takes repeated hits (got ${r.hits})`);
  assert.equal(r.hits, 18, 'every point of the 18hp bar was taken off by a fired shot');
  assert.ok(r.killed, `the boss reaches 0hp (took ${r.seconds.toFixed(1)}s)`);
  assert.equal(g.boss, null);
  // The fight resolves into the normal stage-clear flow, not a soft-lock.
  assert.ok(g.phase === 'stageClear' || g.phase === 'dying',
    `resolved into the post-fight flow, got ${g.phase}`);
});

test('REACHABILITY: the final boss stays killable in phase 2 (faster patterns, dives unlocked)', () => {
  const g = enterFightAt(4);
  assert.equal(g.boss.maxHp, FINAL_HP);
  assert.equal(g.boss.isFinal, true);
  // Start the clock at the phase-2 threshold so this measures the phase-2
  // fight specifically: 0.7x hover/telegraph timings and diveSweep in the
  // rotation, which is when the boss is at its most mobile.
  g.boss.hp = FINAL_PHASE2_HP;
  g.boss.phase2 = true;

  const r = fightWithBot(g, 60);
  assert.ok(r.hits > 1, `the phase-2 boss takes repeated hits (got ${r.hits})`);
  assert.equal(r.hits, FINAL_PHASE2_HP);
  assert.ok(r.killed, `phase 2 reaches 0hp within 60s (took ${r.seconds.toFixed(1)}s)`);
  assert.equal(g.boss, null);
});

// --- PACING ------------------------------------------------------------------
//
// The assertion these replace was `seconds < 60` on a fight that took 11s, on
// a comment claiming a "30-60s guardrail" the fight had never been inside. A
// bound that loose cannot fail, so it was proving nothing; the windows below
// are +/-25% around numbers actually measured through updateGame with this
// same bot, tight enough that a retune of hp, fire cadence or sweep geometry
// has to come back here and re-measure.
//
// Deliberately measured at the DEFAULT cruise band (1) with the standard bot,
// which is what the numbers in js/boss.js's PACING block quote. Band 0 and
// band 2 vary by roughly +/-20% and are not asserted: the bot's fixed 1.0s
// jump arc makes it a much weaker driver at band 0 than a human, so a tight
// band-0 bound would be measuring the bot, not the fight.
//
// TWO THINGS CHANGED HERE WITH THE ROLLING ARENA, both because the old shape
// of this helper was measuring the wrong thing:
//
//  1. **Median over seven fire cadences, not one run.** The bot fires on a
//     fixed frame period against a 4.2s sweep, so a cadence can lock into a
//     resonance where its shots keep arriving at boss altitude just after the
//     mothership has left the up-gun column. Cadence 12 turns the stage-2
//     fight into 92s and cadence 16 turns stage 3 into 105s, while their
//     immediate neighbours land on 38.5s and 45.1s — and which cadences are
//     unlucky moves whenever anything perturbs the bot's timing, including a
//     change with no effect on the fight at all. (That is exactly what the
//     arena change did: the old single-cadence-15 stage-2 number moved 38.9s
//     -> 78.4s, while the seven-cadence median moved 39.9s -> 39.9s.) A
//     human's cadence drifts and averages; the median is the honest model.
//  2. **No more shieldEveryFrame.** It existed because the bot could not
//     survive the natural terrain cluster at worldX~20696 during the stage-2
//     fight and death-looped there — measured pre-arena at a 109s median for
//     a 39.9s fight. With the arena rolling, the unshielded bot now takes
//     ZERO deaths across all 35 measurement fights (5 stages x 7 cadences) at
//     band 1 with 6 lives, so the wrapper was masking nothing and is gone
//     from this path. It is still used by traceCarpet below, which pins bands
//     0 and 2 where the bot genuinely cannot drive the boss's own carpet.
const PACING_CADENCES = [12, 13, 14, 15, 16, 17, 18];

function pacingMedian(stage, opts = {}) {
  const runs = PACING_CADENCES.map((fireEvery) => {
    const g = enterFightAt(stage, 7);
    g.lives = 999; // a run-out would truncate the measurement, not fail it
    if (opts.phase2) { g.boss.hp = FINAL_PHASE2_HP; g.boss.phase2 = true; }
    const r = fightWithBot(g, 240, fireEvery);
    assert.ok(r.killed,
      `stage ${stage} boss dies at cadence ${fireEvery} (ran ${r.seconds.toFixed(1)}s)`);
    return r.seconds;
  });
  const sorted = runs.slice().sort((a, b) => a - b);
  return { seconds: sorted[(sorted.length - 1) >> 1], runs: sorted };
}

const pacingWindow = (stage, expected, opts = {}) => {
  const r = pacingMedian(stage, opts);
  assert.ok(r.seconds > expected * 0.75 && r.seconds < expected * 1.25,
    `stage ${stage} boss should take ~${expected}s +/-25%, median measured ${r.seconds.toFixed(1)}s `
    + `over cadences ${PACING_CADENCES.join('/')}: ${r.runs.map((s) => s.toFixed(1)).join(', ')}`);
  return r;
};

test('PACING: the stage-0 boss is a ~27s fight, not the ~11s one the old 12hp curve gave', () => {
  const r = pacingWindow(0, 26.6);
  // The explicit floor the retune existed to establish: the first boss the
  // player ever meets must not be over before the escalation curve starts.
  assert.ok(r.seconds >= 20, `stage-0 must clear 20s, got ${r.seconds.toFixed(1)}s`);
  assert.ok(r.seconds <= 32, `and stay well under the stage-1 fight, got ${r.seconds.toFixed(1)}s`);
});

test('PACING: the hp curve escalates monotonically across E/J/O/T and steps up at Z', () => {
  const times = [
    pacingWindow(0, 26.6).seconds,
    pacingWindow(1, 32.1).seconds,
    pacingWindow(2, 39.9).seconds,
    pacingWindow(3, 49.5).seconds,
    pacingWindow(4, 64.5).seconds,
  ];
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1] + 3,
      `each boss is a clearly longer fight than the last: ${times.map((t) => t.toFixed(1)).join(' -> ')}`);
  }
  // The finale is the one fight with a hard upper bound in the design brief.
  assert.ok(times[4] >= 45 && times[4] <= 70,
    `the Z boss must land in 45-70s, measured ${times[4].toFixed(1)}s`);
});

test('PACING: the finale splits roughly evenly between its two phases', () => {
  // The measurement that would have caught FINAL_PHASE2_HP drifting away from
  // half of FINAL_HP: the constant test above proves they match, this proves
  // the match actually buys an even fight rather than an even hp bar.
  const splits = PACING_CADENCES.map((fireEvery) => {
    const g = enterFightAt(4, 7);
    g.lives = 999;
    const bot = playerBot(g, fireEvery);
    let frames = 0, phase1 = null;
    while (g.boss && frames < Math.round(240 / DT)) {
      bot.tick(g);
      updateGame(g, bot, DT);
      frames++;
      if (phase1 == null && g.boss && g.boss.phase2) phase1 = frames * DT;
    }
    assert.ok(!g.boss, `the finale resolves at cadence ${fireEvery}`);
    assert.ok(phase1 != null, `phase 2 was actually reached at cadence ${fireEvery}`);
    return { total: frames * DT, phase1, phase2: frames * DT - phase1 };
  });
  const med = (xs) => xs.slice().sort((a, b) => a - b)[(xs.length - 1) >> 1];
  const p1 = med(splits.map((s) => s.phase1));
  const p2 = med(splits.map((s) => s.phase2));
  const share = p1 / (p1 + p2);
  assert.ok(share > 0.4 && share < 0.6,
    `phase 1 should be roughly half the finale, measured ${(share * 100).toFixed(0)}% `
    + `(${p1.toFixed(1)}s + ${p2.toFixed(1)}s)`);
});

test('REACHABILITY: fireDual actually fires during a boss fight (it silently no-opped before)', () => {
  const g = enterFightAt(0);
  assert.equal(g.phase, 'boss');
  assert.equal(g.playerShots.length, 0);
  step(g, press('fire'));
  assert.ok(g.playerShots.some((s) => s.dir === 'up'), 'the up gun fires during a boss fight');
  assert.ok(g.playerShots.some((s) => s.dir === 'fwd'), 'the forward cannon fires too');
});

test('an up-shot holds its column relative to the buggy for its whole climb', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  step(g, press('fire'));
  const up = g.playerShots.find((s) => s.dir === 'up');
  const offset0 = up.x - g.buggy.worldX;
  // Climb it up to roughly the boss's hover altitude.
  for (let i = 0; i < 30; i++) step(g);
  const offset1 = up.x - g.buggy.worldX;
  assert.ok(up.y < 120, 'the shot climbed toward boss altitude');
  assert.ok(Math.abs(offset1 - offset0) < 2,
    `the shot keeps its column (was +${offset0.toFixed(1)}, now +${offset1.toFixed(1)}) — `
    + 'without the forward carry it slides ~100px behind the buggy over this climb');
});

// --- FINDING I7: hitbox vs sprite ------------------------------------------

test('the boss hitbox matches the drawn 48x15 sprite plus a symmetric pad', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  const b = g.boss;
  const box = bossBox(b);
  // Centered on the sprite: equal overhang on both sides, both axes.
  assert.equal(b.x - box.x0, box.x1 - (b.x + 48), 'x pad is symmetric about the 48px sprite');
  assert.equal(b.y - box.y0, box.y1 - (b.y + 15), 'y pad is symmetric about the 15px sprite');
  // And it covers the whole sprite (the old 32x20 box left the sprite's right
  // third unhittable while claiming 5px of empty air below it).
  assert.ok(box.x0 <= b.x && box.x1 >= b.x + 48, 'the full sprite width is hittable');
  assert.ok(box.y0 <= b.y && box.y1 >= b.y + 15, 'the full sprite height is hittable');
  assert.ok(box.x1 - box.x0 <= 48 + 8 && box.y1 - box.y0 <= 15 + 8, 'the pad stays modest');
});

// --- dive geometry ----------------------------------------------------------

test('a dive drops low enough for a ground-level forward shot to connect', () => {
  const g = createGame('classic', 1);
  g.stage = 2;
  startBoss(g);
  g.playerShots = [];

  let lowest = -Infinity; // lowest on screen == largest y
  let sawDive = false;
  for (let i = 0; i < 3000; i++) {
    updateBoss(g, DT);
    if (g.boss.pattern === 'diveSweep') {
      sawDive = true;
      lowest = Math.max(lowest, g.boss.y);
    }
  }
  assert.ok(sawDive);
  // The forward cannon's muzzle line is GROUND_Y + buggy.y - 10 == 190 on the
  // ground; a 2px-tall shot there occupies y 190..192.
  const box = bossBox({ x: 0, y: lowest });
  assert.ok(box.y0 < 192 && box.y1 > 190,
    `at the bottom of its dive (y=${lowest}) the boss box ${box.y0}..${box.y1} must bracket the muzzle line`);
});

test('a dive never begins on top of the buggy', () => {
  const g = createGame('classic', 1);
  g.stage = 2;
  startBoss(g);
  g.playerShots = [];

  let sawDive = false;
  for (let i = 0; i < 6000; i++) {
    updateBoss(g, DT);
    if (g.boss.pattern !== 'diveSweep') continue;
    sawDive = true;
    const offset = g.boss.x - g.buggy.worldX;
    assert.ok(offset >= 32,
      `the mothership must stay clear of the buggy's 32px body while at strike height (offset ${offset.toFixed(1)})`);
  }
  assert.ok(sawDive);
});

test('the horizontal sweep is deterministic and sweeps past the buggy every cycle', () => {
  const run = () => {
    const g = createGame('classic', 1);
    g.stage = 0;
    startBoss(g);
    const offsets = [];
    for (let i = 0; i < 600; i++) {
      updateBoss(g, DT);
      offsets.push(+(g.boss.x - g.buggy.worldX).toFixed(6));
    }
    return offsets;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b, 'no RNG anywhere in the fight geometry');
  assert.ok(Math.min(...a) < 0, 'the sweep carries the boss back over/behind the buggy');
  assert.ok(Math.max(...a) > 150, 'and back out ahead of it');
  // On screen throughout: the buggy sits at ~56-110px, the viewport is 384px.
  assert.ok(Math.min(...a) > -80 && Math.max(...a) < 250, 'the sweep stays on screen');
});

// --- FINDING I3: defensive exit when the boss is missing --------------------

test('a null boss at the start of a boss frame exits to stageClear instead of soft-locking', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  g.buggy.worldX = checkpointX(STAGE_BREAKS[0]) - 1;
  step(g);
  assert.equal(g.phase, 'boss');

  // Simulate the impossible-today state the guard exists for.
  g.boss = null;
  step(g);
  assert.equal(g.phase, 'stageClear', 'the phase resolves rather than hanging with nothing to kill');
  assert.ok(g.stageClear);
});

// --- FINDING I4: the boss's guaranteed capsule is actually collectable ------

test('the boss drop lands on the buggy path and is collected during the stage-clear tally', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  g.buggy.worldX = checkpointX(STAGE_BREAKS[0]) - 1;
  step(g);
  assert.equal(g.phase, 'boss');

  g.boss.hp = 1;
  g.playerShots = [{ x: g.boss.x + 10, y: g.boss.y + 5, vx: 300, vy: 0, dir: 'fwd' }];
  step(g);
  assert.equal(g.boss, null);
  assert.equal(g.capsules.length, 1, 'the guaranteed drop exists');
  const capsule = g.capsules[0];
  assert.ok(capsule.x > g.buggy.worldX,
    'and it is ejected AHEAD of the buggy, not left behind at the wreck');

  // Run the tally out. The capsule must be picked up somewhere in the
  // stageClear -> playing window rather than expiring behind the buggy.
  let n = 0;
  while (g.powerup == null && n < 1200) { step(g); n++; }
  assert.ok(g.powerup, `the capsule was collected (phase ${g.phase} after ${(n * DT).toFixed(1)}s)`);
  assert.ok(g.events.includes('powerup'));
  assert.equal(g.capsules.length, 0);
});

test('capsules move and can be collected during a boss fight', () => {
  const g = createGame('classic', 1);
  g.phase = 'playing';
  g.terrain = { mode: 'test', features: [] };
  g.buggy.worldX = checkpointX(STAGE_BREAKS[0]) - 1;
  step(g);
  assert.equal(g.phase, 'boss');

  spawnCapsule(g, g.buggy.worldX + 40, 120, 'rapid');
  const y0 = g.capsules[0].y;
  step(g);
  assert.ok(g.capsules.length === 0 || g.capsules[0].y > y0,
    'capsules no longer freeze in mid-air for the whole fight');

  let n = 0;
  while (g.powerup == null && n < 600) { step(g); n++; }
  assert.equal(g.powerup?.type, 'rapid', 'and the buggy can drive into one mid-fight');
});

// --- BOMB CARPET: readability + the crater-under-the-buggy regression --------
//
// The pre-fix bug this guards against was a bomb landing at worldX+13..+41,
// i.e. inside the buggy's own 0..32 body box, at band 2 — an unavoidable death
// with no reaction window at all. It was found by INSTRUMENTING A REAL FIGHT,
// not by reasoning about the offsets, and that is how it is guarded: the
// helper below drives a real fight through updateGame and records where every
// bomb was released, how much of its fall happened inside the 384px viewport,
// and where its crater actually opened relative to the buggy at that instant.
//
// Reading the offsets alone would not catch it. The landing position is
// BOMB_OFFSETS[i] minus however far the buggy travels during the fall, and
// the fall time is set by enemies.js's gravity plus boss.js's launch velocity
// while the travel is set by buggy.js's speed bands — four constants in three
// modules that no single file can check.

/** Traces every boss bomb of a real fight at a pinned speed band. */
function traceCarpet(stage, band, seconds = 45) {
  const g = enterFightAt(stage, 7);
  g.lives = 999;
  const base = playerBot(g, 15);
  const input = holdBand(g, band)(shieldEveryFrame(g)(base));
  const live = new Map();
  const bombs = [];
  let frames = 0;
  const maxFrames = Math.round(seconds / DT);
  const screenXof = (wx) => wx - g.buggy.worldX + buggyScreenX(g);

  while (g.boss && frames < maxFrames) {
    input.tick(g);
    updateGame(g, input, DT);
    frames++;
    for (const shot of g.enemyShots) {
      if (shot.kind !== 'bomb') continue;
      if (!live.has(shot.id)) {
        live.set(shot.id, {
          id: shot.id, worldX: shot.x, dropScreenX: screenXof(shot.x),
          dropOffset: shot.x - g.buggy.worldX, visFrames: 0, frames: 0,
        });
      }
      const rec = live.get(shot.id);
      rec.frames++;
      const sx = screenXof(shot.x);
      if (sx > -8 && sx < VIEW_W) rec.visFrames++;
    }
    for (const [id, rec] of live) {
      if (rec.done || g.enemyShots.some((shot) => shot.id === id)) continue;
      rec.done = true;
      rec.fallTime = rec.frames * DT;
      rec.visibleTime = rec.visFrames * DT;
      rec.visibleFrac = rec.visibleTime / rec.fallTime;
      // Crater geometry at the instant the crater opened.
      rec.landOffset = rec.worldX - g.buggy.worldX;      // crater left vs buggy left
      rec.reactSec = (rec.landOffset - BUGGY_W / 2) / g.speed; // craters test the MIDPOINT
      bombs.push(rec);
    }
  }
  const craters = g.terrain.features.filter((f) => f.type === 'bombCrater').sort((a, b) => a.x - b.x);
  const gaps = [];
  for (let i = 1; i < craters.length; i++) {
    const gap = craters[i].x - (craters[i - 1].x + craters[i - 1].w);
    if (gap < 400) gaps.push(gap); // anything wider is the road between two carpets
  }
  return { bombs, gaps, speed: g.speed };
}

test('BOMB CARPET: no crater ever opens on or behind the buggy body, at any speed band', () => {
  for (const band of [0, 1, 2]) {
    const { bombs } = traceCarpet(2, band);
    assert.ok(bombs.length >= 10, `band ${band} traced a real carpet (got ${bombs.length} bombs)`);
    for (const b of bombs) {
      // The crater spans [landOffset, landOffset+28); the body spans [0, 32).
      assert.ok(b.landOffset >= BUGGY_W,
        `band ${band}: bomb ${b.id} released at +${b.dropOffset.toFixed(0)} cratered at `
        + `+${b.landOffset.toFixed(1)}px, inside/behind the buggy's 0..${BUGGY_W} body box`);
    }
  }
});

test('BOMB CARPET: the endless speed ramp cannot pull a crater under the buggy either', () => {
  // Classic tops out at 200px/s, but endless adds game.speedBonus (+60 max),
  // and the lead is a fixed offset table — so the fastest the game ever gets
  // is where the clearance is thinnest. Before boss bombs were launched
  // instead of dropped, a 1.23s fall at 260px/s ate 321 of the 340px lead and
  // put the first crater 19px ahead of the buggy: INSIDE the body box.
  const g = enterFightAt(2, 7);
  g.lives = 999;
  g.mode = 'endless';
  g.elapsedTotal = 600;  // past the +60 cap
  const base = playerBot(g, 15);
  const input = holdBand(g, 2)(shieldEveryFrame(g)(base));
  let frames = 0, seen = 0, worst = Infinity;
  const live = new Map();
  while (g.boss && frames < 45 / DT) {
    input.tick(g);
    updateGame(g, input, DT);
    frames++;
    for (const shot of g.enemyShots) if (shot.kind === 'bomb') live.set(shot.id, shot.x);
    for (const [id, worldX] of live) {
      if (g.enemyShots.some((shot) => shot.id === id)) continue;
      live.delete(id);
      seen++;
      worst = Math.min(worst, worldX - g.buggy.worldX);
    }
  }
  assert.ok(g.speed >= 255, `the endless ramp really is at full tilt (${g.speed.toFixed(0)}px/s)`);
  assert.ok(seen >= 5, `bombs actually fell (${seen})`);
  assert.ok(worst >= BUGGY_W,
    `closest crater at the endless speed cap was +${worst.toFixed(1)}px, inside the 0..${BUGGY_W} body box`);
});

test('BOMB CARPET: the safe lane and every other gap stay driveable at every band', () => {
  // buggy.js tests crater-family features against the buggy MIDPOINT only, so
  // the gap the player has to hit is a point, not the 32px body — which is why
  // the 49px band-0 gaps are driveable at all. These are the widths the fight
  // shipped with; the readability pass must not have narrowed any of them.
  const floors = { 0: 49, 1: 69, 2: 89 };
  for (const band of [0, 1, 2]) {
    const { gaps } = traceCarpet(2, band);
    assert.ok(gaps.length >= 4, `band ${band} produced measurable gaps (${gaps.length})`);
    const min = Math.min(...gaps);
    assert.ok(min >= floors[band] - 0.5, // sub-pixel: dt-integrated positions
      `band ${band} min free gap is ${min.toFixed(1)}px, was ${floors[band]}px before the pass`);
    // And a genuinely wide safe lane survives somewhere in every carpet.
    assert.ok(Math.max(...gaps) >= 92,
      `band ${band} still has a >=92px safe lane (widest ${Math.max(...gaps).toFixed(0)}px)`);
  }
});

test('BOMB CARPET: the player can SEE the leading bombs fall, and gets >=0.39s on the first crater', () => {
  // The failure this pins down: after the +300 lead shift the whole carpet was
  // released at screen x 396..720 on a 384px viewport, so the near bombs only
  // scrolled into frame a third of the way down and the attack was announced
  // (bossTelegraph) without ever being located.
  const expectations = {
    // band: [max screen-x the FIRST bomb may be released at, min reaction on
    //        the first crater, min bombs per carpet visible for most of the fall]
    0: [384, 1.5, 2],
    1: [384, 0.85, 2],
    2: [384, 0.39, 1],
  };
  for (const band of [0, 1, 2]) {
    const [maxDropX, minReact, minWellSeen] = expectations[band];
    const { bombs } = traceCarpet(2, band);
    // Bombs come in repeating 5-bomb carpets; index 0 of each is the near one.
    const lead = bombs.filter((b) => Math.round(b.dropOffset) === BOMB_OFFSETS[0]);
    assert.ok(lead.length >= 2, `band ${band} traced multiple carpets (${lead.length})`);
    for (const b of lead) {
      assert.ok(b.dropScreenX <= maxDropX,
        `band ${band}: the leading bomb is released at screen x ${b.dropScreenX.toFixed(0)}, `
        + `off the ${VIEW_W}px viewport — the carpet is announced but not located`);
      assert.ok(b.visibleFrac > 0.9,
        `band ${band}: the leading bomb is on screen for ${(b.visibleFrac * 100).toFixed(0)}% of its fall`);
      assert.ok(b.reactSec >= minReact,
        `band ${band}: only ${b.reactSec.toFixed(3)}s of road between the buggy midpoint and the `
        + `first crater (floor ${minReact}s)`);
    }
    // Per 5-bomb carpet, how many bombs spend most of their fall on screen.
    const wellSeen = bombs.filter((b) => b.visibleFrac >= 0.7).length / (bombs.length / 5);
    assert.ok(wellSeen >= minWellSeen,
      `band ${band}: only ${wellSeen.toFixed(1)} of 5 bombs per carpet are visible for >=70% of the fall`);
  }
});

test('BOMB CARPET: boss bombs are launched downward; a bomber UFO still just drops them', () => {
  // The readability lever. Halving the fall is what let the lead shrink by
  // 80px without moving the craters onto the buggy — and it must not leak into
  // the regular bomber wave enemy, whose slow drop is its own telegraph.
  const g = createGame('classic', 1);
  g.stage = 0;
  g.terrain = { mode: 'test', features: [] };
  startBoss(g);
  g.boss.pattern = 'bombCarpet';
  g.boss.patternT = 0;
  g.enemyShots = [];
  updateBoss(g, DT);
  const bomb = g.enemyShots.find((s) => s.kind === 'bomb');
  assert.ok(bomb, 'the carpet fired');
  assert.ok(bomb.vy > 0, `a boss bomb leaves with downward speed (got vy ${bomb.vy})`);

  // And the resulting fall really is the ~0.72s the offsets are sized for.
  // Driven through updateGame in the real 'boss' phase, so the number comes
  // from enemies.js's actual integration rather than a formula rewritten here.
  g.phase = 'boss';
  let t = 0;
  while (g.enemyShots.includes(bomb) && t < 5) { updateGame(g, noInput, DT); t += DT; }
  assert.ok(bomb.y >= GROUND_Y, 'the bomb reached the ground rather than being culled');
  assert.ok(t > 0.6 && t < 0.85,
    `a boss bomb falls from hover altitude in ~0.72s (measured ${t.toFixed(2)}s); `
    + 'BOMB_OFFSETS is sized against that number');
});

// --- ROLLING ARENA -----------------------------------------------------------
//
// The problem: enterBoss used to carve a fixed 1600px arena at the break line
// so the fight would be the "fair dodge-and-shoot duel" the spec asks for.
// 1600px is 8-11 seconds of driving. Fights run 26-65s (see the PACING block
// above), so 80%+ of every fight happened over live craters/rocks/mines, and
// the player dodged the level on top of the boss's bombs. The most legible
// symptom was that the unshielded bot could not survive the natural cluster at
// worldX~20696 during the stage-2 fight and death-looped there — a 39.9s fight
// took a 109s median to finish.
//
// The arena is now a ROLLING clear (state.js's maintainBossArena) anchored on
// the buggy, so it cannot be outrun by a long or death-extended fight. The
// tests below are the gate on the two halves of that, and the second half is
// the one that is easy to get wrong: the sweep runs 800px ahead of the buggy
// and the boss's carpet lands 260-530px ahead, so a type-blind clear would
// quietly delete the boss's entire ground attack and leave a fight that looks
// fine and is trivial. Nothing else in the suite would notice.
//
// Like the BOMB CARPET tests, these instrument REAL fights through updateGame
// rather than calling the clear directly: what matters is what the buggy
// actually meets over a whole fight, which is a product of state.js's per-frame
// ordering (generate -> clear -> drive -> collide), not of clearNaturalZone in
// isolation.

/**
 * Drives a real fight and reports what the buggy met: every natural feature
 * that came within the viewport or under the wheels, and the fate of every
 * bombCrater the boss opened.
 */
function traceArena(g, { band = null, seconds = 240, fireEvery = 15, shield = true } = {}) {
  let input = playerBot(g, fireEvery);
  if (shield) input = shieldEveryFrame(g)(input);
  if (band != null) input = holdBand(g, band)(input);

  const naturalSeen = new Map();
  const naturalUnderWheels = new Map();
  const craters = new Map();
  let frames = 0;
  let nearestNaturalAhead = Infinity;
  const maxFrames = Math.round(seconds / DT);

  while (g.boss && frames < maxFrames) {
    input.tick(g);
    updateGame(g, input, DT);
    frames++;
    // 'dying'/'respawning' are still part of the fight — game.boss is alive
    // through them and the sweep is expected to keep running.
    if (!['boss', 'dying', 'respawning'].includes(g.phase)) continue;

    const wx = g.buggy.worldX;
    const mid = wx + BUGGY_W / 2;

    for (const f of g.terrain.features) {
      if (NATURAL_TYPES.has(f.type)) {
        if (f.x + f.w > wx) nearestNaturalAhead = Math.min(nearestNaturalAhead, f.x - wx);
        // Anything from just behind the buggy out to the right edge of the
        // 384px viewport is something the player can see or hit.
        if (f.x < wx + VIEW_W && f.x + f.w > wx - 120) naturalSeen.set(f.id, f.type);
        if (mid >= f.x && mid < f.x + f.w) naturalUnderWheels.set(f.id, f.type);
      } else if (f.type === 'bombCrater' && !craters.has(f.id)) {
        craters.set(f.id, { x: f.x, offsetAtBirth: f.x - wx, passed: false, aliveAtPass: null });
      }
    }
    for (const [id, rec] of craters) {
      if (rec.passed || mid < rec.x + 28) continue;
      rec.passed = true;
      rec.aliveAtPass = g.terrain.features.some((f) => f.id === id);
    }
  }

  const passed = [...craters.values()].filter((c) => c.passed);
  return {
    seconds: frames * DT, killed: !g.boss,
    naturalSeen: [...naturalSeen.values()],
    naturalUnderWheels: [...naturalUnderWheels.values()],
    nearestNaturalAhead,
    craters: craters.size,
    cratersPassed: passed.length,
    cratersDeadAtPass: passed.filter((c) => !c.aliveAtPass).length,
    closestCraterAtBirth: Math.min(...[...craters.values()].map((c) => c.offsetAtBirth)),
  };
}

/** Drives a fresh endless run into its timed boss fight at a chosen difficulty. */
function enterEndlessFight(seed, elapsed) {
  const g = createGame('endless', seed);
  g.phase = 'playing';
  g.elapsedTotal = elapsed;
  g.nextBossAt = elapsed; // fires on the next 'playing' frame
  g.lives = 999;
  for (let i = 0; i < 600 && g.phase !== 'boss'; i++) step(g);
  assert.equal(g.phase, 'boss', 'the endless run reached its timed boss fight');
  return g;
}

test('ROLLING ARENA: no natural terrain is ever seen or hit for a whole fight, at every band', () => {
  for (const stage of [0, 2, 4]) {
    for (const band of [0, 1, 2]) {
      const g = enterFightAt(stage, 7);
      g.lives = 999;
      const r = traceArena(g, { band });
      assert.ok(r.killed, `stage ${stage} band ${band} fight resolved (${r.seconds.toFixed(1)}s)`);
      assert.ok(r.seconds > 15, `and it was a real, full-length fight (${r.seconds.toFixed(1)}s)`);
      assert.deepEqual(r.naturalUnderWheels, [],
        `stage ${stage} band ${band}: the buggy drove over ${r.naturalUnderWheels.join('/')} `
        + 'during a boss fight — the arena is supposed to have swept it');
      assert.deepEqual(r.naturalSeen, [],
        `stage ${stage} band ${band}: ${r.naturalSeen.join('/')} was on screen during a boss `
        + 'fight; the duel is meant to be fought on clear ground');
    }
  }
});

test('ROLLING ARENA: bomb craters survive the sweep and are still the thing that kills you', () => {
  // The failure mode this exists for is silent: sweep bombCraters along with
  // everything else and the fight still runs, still looks right, and has no
  // ground hazard at all. Every assertion here is about the boss's OWN craters
  // outliving a clear window they land inside of.
  for (const band of [0, 1, 2]) {
    const g = enterFightAt(2, 7);
    g.lives = 999;
    const r = traceArena(g, { band });
    assert.ok(r.craters >= 10,
      `band ${band}: the carpet actually cratered the arena (${r.craters} craters)`);
    assert.ok(r.cratersPassed >= 8,
      `band ${band}: the buggy actually reached them (${r.cratersPassed} passed)`);
    assert.equal(r.cratersDeadAtPass, 0,
      `band ${band}: ${r.cratersDeadAtPass} of ${r.cratersPassed} bomb craters had been swept away `
      + 'before the buggy got there — the rolling arena is eating the boss\'s attack');
    // And they open inside the swept window, which is exactly why the type
    // exemption is load-bearing rather than theoretical.
    assert.ok(r.closestCraterAtBirth < 800,
      `band ${band}: craters open ${r.closestCraterAtBirth.toFixed(0)}px ahead, inside the sweep`);
  }

  // Mortal bot, band 0/2: every death in the arena is now a bombCrater, which
  // is the design — the fight stays dangerous, it just stopped being decided
  // by the level.
  const g = enterFightAt(2, 7);
  g.lives = 3;
  const r = traceArena(g, { band: 2, shield: false, seconds: 120 });
  assert.deepEqual(r.naturalUnderWheels, [], 'nothing natural was ever driven into');
  assert.ok(r.craters > 0, 'and the boss still cratered the road it drove over');
});

test('ROLLING ARENA: endless chunks generated mid-fight are swept as they appear', () => {
  // Endless is where the ordering inside maintainBossArena earns its keep:
  // terrain is produced on demand as the buggy advances, so every metre of a
  // 60s fight is over chunks that were BORN during the fight. Generate-then-
  // clear is the only reason they are ever swept at all.
  for (const elapsed of [90, 400]) {      // stage 1 and the stage-4 finale
    for (const band of [0, 2]) {
      const g = enterEndlessFight(11, elapsed);
      const r = traceArena(g, { band });
      assert.ok(r.killed, `endless boss at ${elapsed}s band ${band} resolved`);
      assert.deepEqual(r.naturalUnderWheels, [],
        `endless ${elapsed}s band ${band}: drove over ${r.naturalUnderWheels.join('/')}`);
      assert.deepEqual(r.naturalSeen, [],
        `endless ${elapsed}s band ${band}: ${r.naturalSeen.join('/')} appeared on screen mid-fight`);
      // The window really is holding at its nominal length rather than the
      // fight simply having outrun terrain generation.
      assert.ok(r.nearestNaturalAhead > VIEW_W && r.nearestNaturalAhead <= BOSS_ARENA_AHEAD + 4,
        `endless ${elapsed}s band ${band}: the sweep edge sat at +${r.nearestNaturalAhead.toFixed(0)}px, `
        + `expected it to track BOSS_ARENA_AHEAD (${BOSS_ARENA_AHEAD})`);
    }
  }
});

test('ROLLING ARENA: a full-length finale keeps clear road ahead from first frame to last', () => {
  // The fixed arena's actual failure, stated as a measurement: 1600px is 8-11s
  // of road against a fight that runs ~65s. Run the longest fight in the game
  // and check the sweep edge every single frame.
  const g = enterEndlessFight(11, 400);
  assert.equal(g.boss.isFinal, true, 'the endless stage-4 boss is the two-phase finale');
  let input = shieldEveryFrame(g)(playerBot(g, 15));
  let frames = 0;
  let worstClear = Infinity;
  let sawPhase2 = false;
  while (g.boss && frames < Math.round(240 / DT)) {
    input.tick(g);
    updateGame(g, input, DT);
    frames++;
    if (g.boss?.phase2) sawPhase2 = true;
    const wx = g.buggy.worldX;
    const ahead = g.terrain.features
      .filter((f) => NATURAL_TYPES.has(f.type) && f.x + f.w > wx)
      .reduce((m, f) => Math.min(m, f.x - wx), Infinity);
    worstClear = Math.min(worstClear, ahead);
  }
  const seconds = frames * DT;
  assert.ok(!g.boss, `the finale resolved (${seconds.toFixed(1)}s)`);
  assert.ok(sawPhase2, 'and it went the distance into phase 2');
  assert.ok(seconds > 45, `it is the long fight this test claims to cover (${seconds.toFixed(1)}s)`);
  // A fixed 1600px arena would have run out around the 11s mark here.
  assert.ok(worstClear > VIEW_W,
    `the nearest natural feature ahead of the buggy fell to +${worstClear.toFixed(0)}px during the `
    + `finale — inside the ${VIEW_W}px viewport, i.e. visible and driveable-into`);
});

test('ROLLING ARENA: the sweep stops with the boss — the level comes back after the fight', () => {
  // The other direction of the same knob. A clear anchored on the buggy that
  // forgot to stop would quietly delete the rest of the run, and every test
  // above would still be green — they only ever assert that terrain is GONE.
  // Endless rather than classic so there is no second stage break within
  // reach to muddy the measurement (the next timed boss is 90s away).
  const g = enterEndlessFight(11, 90);
  const r = traceArena(g, { band: 1 });
  assert.ok(r.killed, `the fight resolved (${r.seconds.toFixed(1)}s)`);
  assert.equal(g.boss, null);

  // A stretch of road starting just past the sweep's last reach, measured
  // against a REFERENCE terrain built from the same seed: endless generation
  // is deterministic, so this is what the road there is supposed to contain,
  // independent of how far the live game happens to have generated.
  const from = g.buggy.worldX + 900; // sweep only ever reached worldX + 800
  const to = from + 4 * CHECKPOINT_SPACING;
  const ref = createEndlessTerrain(11);
  ensureGenerated(ref, to + CHECKPOINT_SPACING);
  const expected = featuresInRange(ref, from, to)
    .filter((f) => NATURAL_TYPES.has(f.type))
    .map((f) => `${f.type}@${Math.round(f.x)}`);
  assert.ok(expected.length >= 4,
    `there is real terrain to protect past the arena (${expected.length} features in `
    + `${from.toFixed(0)}..${to.toFixed(0)})`);

  // Drive the buggy all the way through that stretch. It gets the shield
  // wrapper because live terrain is exactly what the bot is bad at — the point
  // here is whether the features are STILL THERE, and a bot that respawn-loops
  // on one of them would never reach the end to find out. The next timed
  // endless boss is pushed out of the way for the same reason: this measures
  // ordinary driving, not a second fight.
  g.nextBossAt = Infinity;
  g.lives = 999;
  const driver = shieldEveryFrame(g)(playerBot(g, 15));
  for (let i = 0; i < Math.round(180 / DT) && g.buggy.worldX < to; i++) {
    driver.tick(g);
    updateGame(g, driver, DT);
  }
  assert.ok(g.buggy.worldX >= to, 'the buggy drove the whole watched stretch');
  const actual = featuresInRange(g.terrain, from, to)
    .filter((f) => NATURAL_TYPES.has(f.type))
    .map((f) => `${f.type}@${Math.round(f.x)}`);
  assert.deepEqual(actual, expected,
    `${expected.length - actual.length} natural features vanished from the road after the boss `
    + 'died — the rolling arena is still running with no fight to justify it');
});

test('ROLLING ARENA: a mid-fight respawn never lands on or straight into a hazard', () => {
  // A rolling clear anchored on the buggy has to survive the buggy moving
  // BACKWARDS: respawn drops it at the last checkpoint line (classic) or the
  // last 1200px boundary (endless), behind everything the sweep has done. It
  // works out because features are removed outright and never regenerate, but
  // that is a consequence of two separate designs meeting, not something
  // either one states — so it gets measured. Deaths are forced rather than
  // waited for, to get a lot of respawns out of one fight.
  const CRATERS = new Set(['crater', 'bigCrater', 'doubleCrater', 'bombCrater']);
  for (const [label, make] of [
    ['classic', () => { const g = enterFightAt(2, 7); g.lives = 999; return g; }],
    ['endless', () => enterEndlessFight(11, 200)],
  ]) {
    const g = make();
    const input = holdBand(g, 2)(playerBot(g, 15));
    let frames = 0, respawns = 0, spawnedOnHazard = 0, tightest = Infinity;
    let prevPhase = g.phase;
    let nextKill = Math.round(6 / DT);
    while (g.boss && frames < Math.round(150 / DT)) {
      input.tick(g);
      if (frames >= nextKill && g.phase === 'boss') {
        g.buggy.alive = false;
        g.buggy.deathCause = 'forced';
        nextKill = frames + Math.round(6 / DT);
      }
      updateGame(g, input, DT);
      frames++;
      if (prevPhase === 'dying' && g.phase === 'respawning') {
        respawns++;
        const wx = g.buggy.worldX;
        const mid = wx + BUGGY_W / 2;
        const near = featuresInRange(g.terrain, wx - 60, wx + 400).filter((f) => !f.destroyed);
        if (near.some((f) => (CRATERS.has(f.type)
          ? mid >= f.x && mid < f.x + f.w
          : wx < f.x + f.w && wx + BUGGY_W > f.x))) spawnedOnHazard++;
        for (const f of near) {
          const d = f.x - mid;
          if (d > 0) tightest = Math.min(tightest, d);
        }
      }
      prevPhase = g.phase;
    }
    assert.ok(respawns >= 5, `${label}: the fight really did cycle through respawns (${respawns})`);
    assert.equal(spawnedOnHazard, 0,
      `${label}: the buggy respawned inside a hazard ${spawnedOnHazard} time(s) mid-fight`);
    // Not a hard floor on the fight's difficulty — just "there is road to
    // react on", i.e. more than the buggy's own body length.
    assert.ok(tightest > BUGGY_W,
      `${label}: closest hazard to a respawn point was +${tightest.toFixed(0)}px`);
  }
});
