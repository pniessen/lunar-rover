import test from 'node:test';
import assert from 'node:assert/strict';
import { startBoss, updateBoss, hitBoss } from '../js/boss.js';
import { createGame, updateGame, DT } from '../js/state.js';
import { clearZone, featuresInRange, STAGE_BREAKS, checkpointX } from '../js/terrain.js';

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

test('startBoss scales maxHp with stage, and the Z final boss is a fixed 40hp two-phase fight', () => {
  const g0 = createGame('classic', 1);
  g0.stage = 0;
  startBoss(g0);
  assert.equal(g0.boss.maxHp, 12);
  assert.equal(g0.boss.hp, 12);
  assert.equal(g0.boss.isFinal, false);

  const g3 = createGame('classic', 1);
  g3.stage = 3;
  startBoss(g3);
  assert.equal(g3.boss.maxHp, 30);

  const gFinal = createGame('classic', 1);
  gFinal.stage = 4;
  startBoss(gFinal);
  assert.equal(gFinal.boss.maxHp, 40);
  assert.equal(gFinal.boss.hp, 40);
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
  assert.equal(g.boss.hp, 11);
  assert.equal(g.score - scoreBefore, 200);
  assert.equal(g.scoreEvents.at(-1).tag, 'bossHit');
});

test('killing the boss emits bossDown, pays bossKill, drops a capsule, and nulls game.boss', () => {
  const g = createGame('classic', 1);
  g.stage = 0;
  startBoss(g);
  g.capsules = [];
  const scoreBefore = g.score;

  for (let i = 0; i < 12; i++) hitBoss(g, 1);

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
  for (let i = 0; i < 24; i++) hitBoss(g, 1);
  const killEv = g.scoreEvents.find((ev) => ev.tag === 'bossKill');
  assert.equal(killEv.base, 4000);
});

test('final boss enters phase2 at hp<=20 (half of 40)', () => {
  const g = createGame('classic', 1);
  g.stage = 4;
  startBoss(g);
  assert.equal(g.boss.phase2, false);

  for (let i = 0; i < 19; i++) hitBoss(g, 1); // hp 40 -> 21
  assert.equal(g.boss.hp, 21);
  assert.equal(g.boss.phase2, false);

  hitBoss(g, 1); // hp 21 -> 20
  assert.equal(g.boss.hp, 20);
  assert.equal(g.boss.phase2, true);
});

test('a non-final boss never sets phase2', () => {
  const g = createGame('classic', 1);
  g.stage = 3;
  startBoss(g);
  for (let i = 0; i < 15; i++) hitBoss(g, 1);
  assert.equal(g.boss.hp, 15);
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
  assert.equal(g.boss.hp, 11, 'fwd shot overlapping the boss hitbox scores a hit');
  assert.equal(g.playerShots.length, 0, 'the consumed shot is removed');

  g.playerShots = [
    { x: g.boss.x, y: g.boss.y, vx: 0, vy: -260, dir: 'up' },
  ];
  updateBoss(g, DT);
  assert.equal(g.boss.hp, 10, 'up shot overlapping the boss hitbox also scores a hit');
});

// --- clearZone -----------------------------------------------------------------

test('clearZone removes every feature overlapping the given range', () => {
  const terrain = {
    features: [
      { id: 1, type: 'crater', x: 0, w: 20, hp: 0, destroyed: false },
      { id: 2, type: 'rock', x: 500, w: 16, hp: 1, destroyed: false },
      { id: 3, type: 'mine', x: 1000, w: 12, hp: 0, destroyed: false },
      { id: 4, type: 'crater', x: 2000, w: 20, hp: 0, destroyed: false },
    ],
  };
  clearZone(terrain, 400, 1100);
  assert.deepEqual(terrain.features.map((f) => f.id), [1, 4]);
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
  assert.equal(g.boss.maxHp, 12);

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

test('clearZone carves the boss arena from the checkpoint line at every stage break', () => {
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

// FINDING 2 (Important): enterBoss cleared terrain features via clearZone
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
