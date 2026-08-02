import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnDirector, updateEnemies, hitEnemy } from '../js/enemies.js';
import { createGame, updateGame, GROUND_Y, DT as STATE_DT } from '../js/state.js';
import { featuresInRange } from '../js/terrain.js';

const DT = 1 / 60;

const noInput = {
  state: { accel: false, brake: false, jump: false, fire: false, pause: false, mute: false, restart: false },
  pressed: () => false,
  endFrame() {},
};

const game = () => { const g = createGame('classic', 1); g.phase = 'playing'; return g; };

// --- required coverage per the task-6 brief -------------------------------

test("bomber's bomb creates a crater in clear terrain and emits bombHit", () => {
  const g = game();
  g.buggy.worldX = 0;
  g.enemyShots = [{ id: 1, kind: 'bomb', x: 100, y: GROUND_Y - 50, vx: 0, vy: 0 }];

  for (let i = 0; i < 200 && g.enemyShots.some((s) => s.kind === 'bomb'); i++) {
    updateEnemies(g, DT);
  }

  assert.ok(g.events.includes('bombHit'));
  assert.ok(featuresInRange(g.terrain, 70, 130).some((f) => f.type === 'bombCrater' && !f.destroyed));
});

test('chaser ram kills a grounded buggy', () => {
  const g = game();
  g.buggy.worldX = 100;
  g.buggy.airborne = false;
  g.enemies = [{ id: 1, kind: 'chaser', x: 100, y: GROUND_Y - 10, vx: 0, vy: 0, hp: 1, t: 0 }];

  updateEnemies(g, DT);

  assert.equal(g.buggy.alive, false);
  assert.equal(g.buggy.deathCause, 'chaser');
});

test('chaser passing under an airborne buggy emits chaserDodge exactly once, no death', () => {
  const g = game();
  g.buggy.worldX = 100;
  g.buggy.airborne = true;
  g.buggy.y = -30;
  g.enemies = [{ id: 1, kind: 'chaser', x: 100, y: GROUND_Y - 10, vx: 0, vy: 0, hp: 1, t: 0 }];

  updateEnemies(g, DT);
  updateEnemies(g, DT); // still overlapping a second frame

  assert.equal(g.buggy.alive, true);
  const dodges = g.events.filter((e) => e === 'chaserDodge').length;
  assert.equal(dodges, 1);
});

test('up-shot kills a swooper: awards 100 with tag swooper and an explosion event', () => {
  const g = game();
  const e = { id: 1, kind: 'swooper', x: 100, y: 60, vx: 0, vy: 0, hp: 1, t: 0 };
  g.enemies = [e];
  g.playerShots = [{ x: 100, y: 60, vx: 0, vy: -260, dir: 'up' }];

  updateEnemies(g, DT);

  assert.equal(g.enemies.length, 0);
  assert.ok(g.scoreEvents.some((ev) => ev.tag === 'swooper' && ev.base === 100));
  assert.ok(g.events.includes('explosion'));
});

test('full formation wipe pays 1000 bonus', () => {
  const g = game();
  g.enemies = [0, 1, 2].map((i) => ({
    id: i, kind: 'swooper', x: g.buggy.worldX + 80 + i * 20, y: 60, vx: 0, vy: 0, hp: 1, t: 0, formationId: 'f1',
  }));
  for (const e of [...g.enemies]) hitEnemy(g, e);
  assert.ok(g.scoreEvents.some((ev) => ev.tag === 'formation' && ev.base === 1000));
});

test('tank killed by a forward shot awards 200 tankShot', () => {
  const g = game();
  g.buggy.worldX = 0;
  const e = { id: 1, kind: 'tank', x: 400, y: GROUND_Y - 14, vx: 0, vy: 0, hp: 1, t: 0 };
  g.enemies = [e];
  g.playerShots = [{ x: 400, y: GROUND_Y - 14, vx: 300, vy: 0, dir: 'fwd' }];

  updateEnemies(g, DT);

  assert.equal(g.enemies.length, 0);
  assert.ok(g.scoreEvents.some((ev) => ev.tag === 'tankShot' && ev.base === 200));
});

test('warn.air true while a flyer is alive, false once cleared', () => {
  const g = game();
  g.enemies = [{ id: 1, kind: 'swooper', x: g.buggy.worldX + 50, y: 60, vx: 0, vy: 0, hp: 1, t: 0 }];
  spawnDirector(g, 0);
  assert.equal(g.warn.air, true);

  g.enemies = [];
  spawnDirector(g, 0);
  assert.equal(g.warn.air, false);
});

test('warn.rear true while a chaser is alive', () => {
  const g = game();
  g.enemies = [{ id: 1, kind: 'chaser', x: g.buggy.worldX - 50, y: GROUND_Y - 10, vx: 0, vy: 0, hp: 1, t: 0 }];
  spawnDirector(g, 0);
  assert.equal(g.warn.rear, true);
});

test('warn.mine true only when a live mine sits within 400px ahead', () => {
  const g = game();
  g.buggy.worldX = 0;
  g.terrain = { mode: 'test', features: [{ id: 1, type: 'mine', x: 300, w: 12, hp: 0, destroyed: false }] };
  spawnDirector(g, 0);
  assert.equal(g.warn.mine, true);

  g.terrain = { mode: 'test', features: [{ id: 1, type: 'mine', x: 900, w: 12, hp: 0, destroyed: false }] };
  spawnDirector(g, 0);
  assert.equal(g.warn.mine, false);

  g.terrain = { mode: 'test', features: [{ id: 1, type: 'mine', x: 300, w: 12, hp: 0, destroyed: true }] };
  spawnDirector(g, 0);
  assert.equal(g.warn.mine, false, 'a destroyed mine does not warn');
});

// --- additional coverage (implementer-added, not removing brief tests) ---

test('aimer fires an aimed shot within 2s', () => {
  const g = game();
  g.buggy.worldX = 500;
  const e = {
    id: 1, kind: 'aimer', x: 720, y: 60, vx: 0, vy: 0, hp: 1, t: 0, hoverOffset: 220, baseY: 60,
  };
  g.enemies = [e];

  for (let i = 0; i < 130; i++) updateEnemies(g, DT); // > 2s

  assert.ok(g.enemyShots.some((s) => s.kind === 'aimed' && s.from === 1));
});

test('aimer holds fire once 2 of its own shots are already alive', () => {
  const g = game();
  g.buggy.worldX = 500;
  const e = {
    id: 1, kind: 'aimer', x: 720, y: 60, vx: 0, vy: 0, hp: 1, t: 0, hoverOffset: 220, baseY: 60,
  };
  g.enemies = [e];
  // Parked well clear of the buggy box (y=60 vs buggy ~y=190) so these never
  // resolve via a buggy hit and never move out of the world.
  g.enemyShots = [
    { id: 90, kind: 'aimed', from: 1, x: 720, y: 60, vx: 0, vy: 0 },
    { id: 91, kind: 'aimed', from: 1, x: 720, y: 60, vx: 0, vy: 0 },
  ];

  for (let i = 0; i < 130; i++) updateEnemies(g, DT); // cross the 2s fire boundary

  const own = g.enemyShots.filter((s) => s.from === 1).length;
  assert.equal(own, 2, 'no third shot fired while 2 are already alive');
});

test('tank fires a level shot every 2.5s', () => {
  const g = game();
  g.buggy.worldX = 0;
  const e = { id: 1, kind: 'tank', x: 400, y: GROUND_Y - 14, vx: 0, vy: 0, hp: 1, t: 0 };
  g.enemies = [e];

  for (let i = 0; i < 170; i++) updateEnemies(g, DT); // > 2.5s

  assert.ok(g.enemyShots.some((s) => s.kind === 'level' && s.from === 1));
});

test('chaser falling into a crater dies silently: no explosion, no score, removed', () => {
  const g = game();
  g.buggy.worldX = 0;
  g.terrain = { mode: 'test', features: [{ id: 1, type: 'crater', x: 150, w: 24, hp: 0, destroyed: false }] };
  g.enemies = [{ id: 1, kind: 'chaser', x: 145, y: GROUND_Y - 10, vx: 0, vy: 0, hp: 1, t: 0 }];

  updateEnemies(g, DT);

  assert.equal(g.enemies.length, 0, 'chaser removed');
  assert.equal(g.events.includes('explosion'), false);
  assert.equal(g.scoreEvents.length, 0);
});

test('enemies and enemy shots are culled once far behind the camera', () => {
  const g = game();
  g.buggy.worldX = 1000;
  g.enemies = [{ id: 1, kind: 'swooper', x: 1000 - 500, y: 60, vx: 0, vy: 0, hp: 1, t: 0 }];
  g.enemyShots = [{ id: 2, kind: 'aimed', from: 99, x: 1000 - 500, y: 60, vx: 0, vy: 0 }];

  updateEnemies(g, DT);

  assert.equal(g.enemies.length, 0);
  assert.equal(g.enemyShots.length, 0);
});

test('bomb hitting the buggy directly kills it with cause bomb', () => {
  const g = game();
  g.buggy.worldX = 100;
  g.enemyShots = [{ id: 1, kind: 'bomb', x: g.buggy.worldX + 10, y: GROUND_Y - 5, vx: 0, vy: 0 }];

  updateEnemies(g, DT);

  assert.equal(g.buggy.alive, false);
  assert.equal(g.buggy.deathCause, 'bomb');
});

test('at stage 0, spawned waves are swooper formations only', () => {
  const g = game();
  g.rngSeed = 5;
  for (let i = 0; i < 60 * 40; i++) spawnDirector(g, DT); // simulate 40s, several waves

  assert.ok(g.enemies.length > 0);
  assert.ok(g.enemies.every((e) => e.kind === 'swooper'));
});

test('stage >= 3 wave pool can include a chaser', () => {
  const g = game();
  g.stage = 3;
  let sawChaser = false;
  for (let i = 0; i < 60 * 200 && !sawChaser; i++) {
    spawnDirector(g, DT);
    if (g.enemies.some((e) => e.kind === 'chaser')) sawChaser = true;
  }
  assert.ok(sawChaser, 'chasers should appear in the pool once stage >= 3');
});

test('updateGame wiring spawns enemy waves while playing', () => {
  const g = createGame('classic', 9);
  g.phase = 'playing';
  // Hazard-free terrain double: this test isolates the spawnDirector/
  // updateEnemies wiring from unrelated terrain deaths (noInput never jumps).
  g.terrain = { mode: 'test', features: [] };
  let sawEnemies = false;
  for (let i = 0; i < 60 * 12; i++) {
    updateGame(g, noInput, STATE_DT);
    if (g.enemies.length > 0) sawEnemies = true;
  }
  assert.ok(sawEnemies, 'at least one wave should have spawned within 12s');
});

test('createGame provisions a waveRng function', () => {
  const g = createGame('classic', 3);
  assert.equal(typeof g.waveRng, 'function');
  assert.ok(g.waveRng() >= 0 && g.waveRng() < 1);
});
