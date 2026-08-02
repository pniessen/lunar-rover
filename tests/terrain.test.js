import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClassicCourse, createEndlessTerrain, ensureGenerated, featuresInRange,
         addBombCrater, checkpointIndexAt, checkpointX, destroyFeature, CHECKPOINT_SPACING,
         LETTERS, STAGE_BREAKS, FEATURE_W } from '../js/terrain.js';

test('classic course spans 26 checkpoints and is deterministic', () => {
  const a = buildClassicCourse(0), b = buildClassicCourse(0);
  assert.deepEqual(featuresInRange(a, 0, 26*CHECKPOINT_SPACING).map(f=>[f.type,f.x]),
                   featuresInRange(b, 0, 26*CHECKPOINT_SPACING).map(f=>[f.type,f.x]));
  assert.ok(featuresInRange(a, 0, 26*CHECKPOINT_SPACING).length > 50);
});
test('checkpoint A–D segment has no mines (mines start stage 3)', () => {
  const t = buildClassicCourse(0);
  const early = featuresInRange(t, 0, 9*CHECKPOINT_SPACING);
  assert.equal(early.filter(f=>f.type==='mine').length, 0);
  const later = featuresInRange(t, 9*CHECKPOINT_SPACING, 15*CHECKPOINT_SPACING);
  assert.ok(later.filter(f=>f.type==='mine').length > 0);
});
test('features never overlap', () => {
  const t = buildClassicCourse(0);
  const fs = featuresInRange(t, 0, 26*CHECKPOINT_SPACING).sort((p,q)=>p.x-q.x);
  for (let i=1;i<fs.length;i++) assert.ok(fs[i].x >= fs[i-1].x + fs[i-1].w, `${i} overlaps`);
});
test('bomb crater inserts only into clear ground', () => {
  const t = buildClassicCourse(0);
  const clearX = 30; // start zone is feature-free
  addBombCrater(t, clearX);
  assert.ok(featuresInRange(t, clearX, clearX+28).some(f=>f.type==='bombCrater'));
  const before = featuresInRange(t, clearX, clearX+28).length;
  addBombCrater(t, clearX); // overlapping -> rejected
  assert.equal(featuresInRange(t, clearX, clearX+28).length, before);
});
test('big rock takes two hits', () => {
  const t = buildClassicCourse(0);
  const rock = featuresInRange(t, 0, 26*CHECKPOINT_SPACING).find(f=>f.type==='bigRock');
  assert.equal(destroyFeature(t, rock.id).destroyed, false);
  assert.equal(destroyFeature(t, rock.id).destroyed, true);
  assert.ok(rock.destroyed);
});
test('endless terrain is seeded-deterministic and extends on demand', () => {
  const a = createEndlessTerrain(42), b = createEndlessTerrain(42), c = createEndlessTerrain(7);
  ensureGenerated(a, 10000); ensureGenerated(b, 10000); ensureGenerated(c, 10000);
  const key = t=>featuresInRange(t,0,10000).map(f=>`${f.type}@${f.x}`).join();
  assert.equal(key(a), key(b));
  assert.notEqual(key(a), key(c));
});
test('checkpointIndexAt clamps', () => {
  assert.equal(checkpointIndexAt(-5), 0);
  assert.equal(checkpointIndexAt(3*CHECKPOINT_SPACING+1), 3);
  assert.equal(checkpointIndexAt(999*CHECKPOINT_SPACING), 25);
});

// --- additional tests beyond the brief ---

test('constants match spec', () => {
  assert.equal(CHECKPOINT_SPACING, 1200);
  assert.equal(LETTERS, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  assert.equal(LETTERS.length, 26);
  assert.deepEqual(STAGE_BREAKS, [4,9,14,19,25]);
  assert.deepEqual(FEATURE_W, {crater:24, bigCrater:40, doubleCrater:56, rock:16, bigRock:22, mine:12, bombCrater:28});
});

test('checkpointX is inverse-ish of checkpointIndexAt', () => {
  assert.equal(checkpointX(0), 0);
  assert.equal(checkpointX(3), 3*CHECKPOINT_SPACING);
  assert.equal(checkpointX(25), 25*CHECKPOINT_SPACING);
});

test('rock has hp 1, bigRock has hp 2, others have hp 0', () => {
  const t = buildClassicCourse(0);
  const fs = featuresInRange(t, 0, 26*CHECKPOINT_SPACING);
  for (const f of fs) {
    if (f.type === 'rock') assert.equal(f.hp, 1);
    else if (f.type === 'bigRock') assert.equal(f.hp, 2);
    else assert.equal(f.hp, 0);
  }
});

test('destroyFeature single-hit feature dies immediately', () => {
  const t = buildClassicCourse(0);
  const crater = featuresInRange(t, 0, 26*CHECKPOINT_SPACING).find(f=>f.type==='crater' || f.type==='rock');
  const rock = featuresInRange(t, 0, 26*CHECKPOINT_SPACING).find(f=>f.type==='rock');
  const res = destroyFeature(t, rock.id);
  assert.equal(res.destroyed, true);
  assert.equal(res.type, 'rock');
});

test('start zone and post-checkpoint zones are clear in classic course', () => {
  const t = buildClassicCourse(0);
  const startZone = featuresInRange(t, 0, 200);
  assert.equal(startZone.length, 0);
  for (let i = 0; i <= 5; i++) {
    const cx = checkpointX(i);
    const postCheckpoint = featuresInRange(t, cx, cx + 150);
    assert.equal(postCheckpoint.length, 0, `checkpoint ${i} not clear`);
  }
});

test('champion course (courseId=1) differs from beginner and is denser', () => {
  const beginner = buildClassicCourse(0);
  const champion = buildClassicCourse(1);
  const bCount = featuresInRange(beginner, 0, 26*CHECKPOINT_SPACING).length;
  const cCount = featuresInRange(champion, 0, 26*CHECKPOINT_SPACING).length;
  assert.ok(cCount > bCount, `expected champion(${cCount}) > beginner(${bCount})`);
});

test('featuresInRange includes destroyed features', () => {
  const t = buildClassicCourse(0);
  const rock = featuresInRange(t, 0, 26*CHECKPOINT_SPACING).find(f=>f.type==='rock');
  destroyFeature(t, rock.id);
  const stillThere = featuresInRange(t, 0, 26*CHECKPOINT_SPACING).find(f=>f.id===rock.id);
  assert.ok(stillThere);
  assert.equal(stillThere.destroyed, true);
});

test('addBombCrater rejects near checkpoint lines', () => {
  const t = createEndlessTerrain(1);
  ensureGenerated(t, 5000);
  const cpX = checkpointX(1);
  const before = featuresInRange(t, cpX-40, cpX+40).length;
  addBombCrater(t, cpX + 10); // within 40px of checkpoint line
  const after = featuresInRange(t, cpX-40, cpX+40).length;
  assert.equal(after, before);
});

test('ensureGenerated is a no-op for classic terrain', () => {
  const t = buildClassicCourse(0);
  const before = featuresInRange(t, 0, 26*CHECKPOINT_SPACING).length;
  ensureGenerated(t, 999999);
  const after = featuresInRange(t, 0, 26*CHECKPOINT_SPACING).length;
  assert.equal(before, after);
});

test('endless terrain post-checkpoint-boundary zones stay clear', () => {
  const t = createEndlessTerrain(99);
  ensureGenerated(t, 20000);
  for (let x = 0; x < 20000; x += CHECKPOINT_SPACING) {
    const zone = featuresInRange(t, x, x + 150);
    assert.equal(zone.length, 0, `boundary at ${x} not clear`);
  }
});
