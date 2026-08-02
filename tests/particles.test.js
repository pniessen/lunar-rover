import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createParticles, emit, updateParticles, activeCount, pushFx, PARTICLE_COUNTS,
} from '../js/particles.js';

const KINDS = ['dust', 'muzzle', 'boom', 'spark'];

test('createParticles builds a fixed-size pool of inactive slots', () => {
  const p = createParticles(16);
  assert.equal(p.max, 16);
  assert.equal(p.items.length, 16);
  assert.equal(activeCount(p), 0);
  for (const it of p.items) {
    assert.equal(it.active, false);
    assert.equal(it.life, 0);
  }
});

test('createParticles defaults to 256 slots', () => {
  assert.equal(createParticles().items.length, 256);
});

test('every kind emits its documented particle count', () => {
  for (const kind of KINDS) {
    const p = createParticles(64);
    const n = emit(p, kind, 100, 50);
    assert.equal(n, PARTICLE_COUNTS[kind], `${kind} count`);
    assert.equal(activeCount(p), PARTICLE_COUNTS[kind], `${kind} active`);
  }
});

test('boom is 16 chunky squares that fall under gravity', () => {
  const p = createParticles(64);
  emit(p, 'boom', 0, 0);
  assert.equal(activeCount(p), 16);
  const live = p.items.filter((i) => i.active);
  for (const it of live) {
    assert.ok(it.size >= 2 && it.size <= 4, 'chunky, 2-4px');
    assert.ok(it.gravity > 0, 'boom chunks fall');
    assert.ok(it.life > 0);
  }
  // Not all identical — the emitter scatters velocity.
  assert.ok(new Set(live.map((i) => i.vx)).size > 1);

  // Core/shrapnel split: a handful of big, bright, short-lived, slow chunks
  // hold the centre while the rest fly out (see emit's BOOM_CORE).
  const core = live.filter((i) => i.size === 4);
  const shrapnel = live.filter((i) => i.size < 4);
  assert.ok(core.length >= 3 && core.length < live.length, 'a core, not the whole burst');
  assert.equal(core.length + shrapnel.length, 16);
  const maxCoreSpeed = Math.max(...core.map((i) => Math.hypot(i.vx, i.vy)));
  const maxShrapnelSpeed = Math.max(...shrapnel.map((i) => Math.hypot(i.vx, i.vy)));
  assert.ok(maxCoreSpeed < maxShrapnelSpeed, 'the core stays put, the shrapnel leaves');
  assert.ok(Math.max(...core.map((i) => i.life)) < Math.max(...shrapnel.map((i) => i.life)),
    'the core burns out first');
});

test('an unknown kind emits nothing and leaves the pool untouched', () => {
  const p = createParticles(8);
  assert.equal(emit(p, 'nope', 1, 2), 0);
  assert.equal(activeCount(p), 0);
});

test('emitting beyond capacity recycles the oldest slots, never grows', () => {
  const p = createParticles(8);
  emit(p, 'boom', 10, 10); // 16 > 8 capacity
  assert.equal(p.items.length, 8, 'pool never grows');
  assert.equal(activeCount(p), 8, 'every slot in use, nothing dropped on the floor');

  // Round-robin cursor means the slot written first is the one reused first.
  const p2 = createParticles(4);
  emit(p2, 'dust', 0, 0); // 2 particles -> slots 0,1
  const firstX = p2.items[0].x;
  emit(p2, 'dust', 500, 0); // slots 2,3
  emit(p2, 'dust', 900, 0); // wraps: recycles slots 0,1 (the oldest)
  assert.equal(p2.items.length, 4);
  assert.notEqual(p2.items[0].x, firstX, 'oldest slot was recycled');
  assert.ok(Math.abs(p2.items[0].x - 900) < 40, 'recycled slot holds the newest emission');
  assert.ok(Math.abs(p2.items[2].x - 500) < 40, 'the newer slots survived');
});

test('10000 emits leave the pool length and active count bounded', () => {
  const p = createParticles(256);
  for (let i = 0; i < 10000; i++) {
    emit(p, KINDS[i % KINDS.length], i, i % 200);
    if (i % 7 === 0) updateParticles(p, 1 / 60);
    assert.equal(p.items.length, 256, 'no allocation growth');
  }
  assert.equal(p.items.length, 256);
  assert.ok(activeCount(p) <= 256);
});

test('updateParticles integrates position, gravity and age', () => {
  const p = createParticles(4);
  emit(p, 'boom', 100, 40);
  const it = p.items[0];
  const x0 = it.x;
  const y0 = it.y;
  const vy0 = it.vy;
  const life0 = it.life;
  const dt = 0.1;

  updateParticles(p, dt);

  assert.ok(Math.abs(it.life - (life0 - dt)) < 1e-9, 'ages by dt');
  assert.ok(Math.abs(it.vy - (vy0 + it.gravity * dt)) < 1e-9, 'gravity applied to vy');
  assert.ok(Math.abs(it.x - (x0 + it.vx * dt)) < 1e-9, 'x integrates vx');
  assert.ok(Math.abs(it.y - (y0 + it.vy * dt)) < 1e-9, 'y integrates the post-gravity vy');
});

test('particles expire at life 0 and their slots become reusable', () => {
  const p = createParticles(32);
  emit(p, 'muzzle', 10, 10);
  assert.ok(activeCount(p) > 0);

  for (let i = 0; i < 300; i++) updateParticles(p, 1 / 60); // 5 seconds
  assert.equal(activeCount(p), 0, 'everything expires eventually');
  for (const it of p.items) assert.equal(it.active, false);

  emit(p, 'muzzle', 20, 20);
  assert.equal(activeCount(p), PARTICLE_COUNTS.muzzle, 'expired slots are reusable');
});

test('updateParticles on an empty pool is a no-op', () => {
  const p = createParticles(4);
  updateParticles(p, 1 / 60);
  assert.equal(activeCount(p), 0);
});

test('emit is deterministic for a given pool seed', () => {
  const a = createParticles(64);
  const b = createParticles(64);
  emit(a, 'boom', 5, 5);
  emit(b, 'boom', 5, 5);
  assert.deepEqual(a.items, b.items, 'seeded LCG: same pool age -> same jitter');
});

test('pushFx appends to game.fx, creating the channel if absent', () => {
  const game = {};
  pushFx(game, 'boom', 12, 34);
  assert.deepEqual(game.fx, [{ kind: 'boom', x: 12, y: 34 }]);
  pushFx(game, 'spark', 1, 2);
  assert.equal(game.fx.length, 2);
  assert.doesNotThrow(() => pushFx(null, 'boom', 0, 0));
});
