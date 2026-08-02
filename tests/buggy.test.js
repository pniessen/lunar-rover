import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuggy, updateBuggy, checkTerrainCollision, killBuggy,
         SPEED_BANDS, GRAVITY, JUMP_VY } from '../js/buggy.js';
import { buildClassicCourse } from '../js/terrain.js';

const mkInput = (held={}, once=[]) => ({ state:{accel:false,brake:false,jump:false,fire:false,...held},
                                         pressed:n=>once.includes(n), endFrame(){} });
const mkGame = () => ({ buggy:createBuggy(), speed:SPEED_BANDS[1], events:[], powerup:null,
                        terrain:buildClassicCourse(0) });
const DT = 1/60;

test('speed eases toward band target, never jumps instantly', () => {
  const g = mkGame();
  updateBuggy(g, mkInput({}, ['accel']), DT); // band 1 -> 2
  assert.equal(g.buggy.band, 2);
  assert.ok(g.speed < SPEED_BANDS[2] && g.speed > SPEED_BANDS[1]);
});
test('jump distance scales with speed band', () => {
  const dist = band => {
    const g = mkGame(); g.buggy.band = band; g.speed = SPEED_BANDS[band];
    updateBuggy(g, mkInput({}, ['jump']), DT);
    const x0 = g.buggy.worldX;
    while (g.buggy.airborne) updateBuggy(g, mkInput(), DT);
    return g.buggy.worldX - x0;
  };
  assert.ok(dist(2) > dist(1) * 1.3, 'fast jump must be much longer');
});
test('no double jump, no jump during settle', () => {
  const g = mkGame();
  updateBuggy(g, mkInput({}, ['jump']), DT);
  assert.ok(g.buggy.airborne);
  const y = g.buggy.y;
  updateBuggy(g, mkInput({}, ['jump']), DT); // mid-air jump attempt
  assert.ok(g.buggy.vy > JUMP_VY, 'second impulse must not apply');
});
test('grounded buggy dies over crater midpoint, survives at edge', () => {
  const g = mkGame();
  g.terrain = { features:[{id:1,type:'crater',x:100,w:24,hp:0,destroyed:false}], mode:'test' };
  g.buggy.worldX = 100+12-16; // midpoint at crater center
  assert.equal(checkTerrainCollision(g.buggy, g.terrain), 'crater');
  g.buggy.worldX = 100-30;    // midpoint left of crater
  assert.equal(checkTerrainCollision(g.buggy, g.terrain), null);
});
test('airborne buggy never collides with terrain', () => {
  const g = mkGame();
  g.terrain = { features:[{id:1,type:'rock',x:100,w:16,hp:1,destroyed:false}], mode:'test' };
  g.buggy.worldX = 100; g.buggy.airborne = true; g.buggy.y = -30;
  assert.equal(checkTerrainCollision(g.buggy, g.terrain), null);
});
test('shield absorbs exactly one hit', () => {
  const g = mkGame(); g.powerup = {type:'shield', remaining:99};
  assert.equal(killBuggy(g, 'rock'), false);
  assert.equal(g.powerup, null);
  assert.ok(g.buggy.alive);
  assert.equal(killBuggy(g, 'rock'), true);
  assert.ok(!g.buggy.alive);
});

// --- additional coverage (implementer-added, not removing brief tests) ---

test('createBuggy returns the documented default shape', () => {
  const b = createBuggy();
  assert.deepEqual(b, {
    worldX: 0, y: 0, vy: 0, band: 1, speed: SPEED_BANDS[1],
    airborne: false, settle: 0, wheelPhase: 0, alive: true, deathCause: null,
    hoverUsed: false,
  });
});

test('brake decreases band, clamped at 0', () => {
  const g = mkGame();
  g.buggy.band = 0;
  g.speed = SPEED_BANDS[0];
  updateBuggy(g, mkInput({}, ['brake']), DT);
  assert.equal(g.buggy.band, 0); // already at floor, stays clamped
  assert.equal(g.speed, SPEED_BANDS[0]);
});

test('grounded rock hit only registers on hitbox overlap, not midpoint', () => {
  const g = mkGame();
  g.terrain = { features:[{id:1,type:'rock',x:100,w:16,hp:1,destroyed:false}], mode:'test' };
  // hitbox [90,122) overlaps rock [100,116) but midpoint (106) is also inside — overlap rule applies regardless
  g.buggy.worldX = 90;
  assert.equal(checkTerrainCollision(g.buggy, g.terrain), 'rock');
  // hitbox barely touches rock at the very edge
  g.buggy.worldX = 84; // hitbox [84,116) touches rock start at 100..116
  assert.equal(checkTerrainCollision(g.buggy, g.terrain), 'rock');
  // hitbox entirely clear of rock
  g.buggy.worldX = 50; // hitbox [50,82)
  assert.equal(checkTerrainCollision(g.buggy, g.terrain), null);
});

test('destroyed rock/mine features are ignored by collision', () => {
  const g = mkGame();
  g.terrain = { features:[{id:1,type:'rock',x:100,w:16,hp:0,destroyed:true}], mode:'test' };
  g.buggy.worldX = 100;
  assert.equal(checkTerrainCollision(g.buggy, g.terrain), null);
});

test('grounded, no matching feature returns null', () => {
  const g = mkGame();
  g.terrain = { features:[], mode:'test' };
  g.buggy.worldX = 100;
  assert.equal(checkTerrainCollision(g.buggy, g.terrain), null);
});

test('landing resets vertical state, sets settle, and emits land event', () => {
  const g = mkGame();
  updateBuggy(g, mkInput({}, ['jump']), DT);
  assert.ok(g.buggy.airborne);
  let landed = false;
  for (let i = 0; i < 1000 && !landed; i++) {
    updateBuggy(g, mkInput(), DT);
    if (!g.buggy.airborne) landed = true;
  }
  assert.ok(landed, 'buggy should land within a reasonable number of frames');
  assert.equal(g.buggy.y, 0);
  assert.equal(g.buggy.vy, 0);
  assert.ok(g.buggy.settle > 0);
  assert.ok(g.events.includes('land'));
  assert.ok(g.events.includes('jump'));
});

test('checkTerrainCollision against real terrain uses featuresInRange (non-test mode)', () => {
  const g = mkGame(); // real classic course terrain, mode:'classic'
  // Course start zone (first ~200-300px of segment A) is guaranteed feature-free.
  g.buggy.worldX = 10;
  assert.equal(checkTerrainCollision(g.buggy, g.terrain), null);
});
