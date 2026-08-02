import test from 'node:test';
import assert from 'node:assert/strict';
import { fireDual, updateWeapons } from '../js/weapons.js';
import { award } from '../js/score.js';
import { createGame } from '../js/state.js';

const DT = 1/60;
const game = () => { const g = createGame('classic', 1); g.phase='playing'; return g; };

test('one press fires forward + vertical simultaneously', () => {
  const g = game();
  fireDual(g);
  assert.equal(g.playerShots.filter(s=>s.dir==='fwd').length, 1);
  assert.equal(g.playerShots.filter(s=>s.dir==='up').length, 1);
});
test('forward gun limited to 1 on screen; vertical to 4', () => {
  const g = game();
  for (let i=0;i<6;i++) fireDual(g);
  assert.equal(g.playerShots.filter(s=>s.dir==='fwd').length, 1);
  assert.equal(g.playerShots.filter(s=>s.dir==='up').length, 4);
});
test('rapid-fire raises forward limit to 3', () => {
  const g = game(); g.powerup = {type:'rapid', remaining:10};
  for (let i=0;i<6;i++) fireDual(g);
  assert.equal(g.playerShots.filter(s=>s.dir==='fwd').length, 3);
});
test('spread makes vertical shot 3-way', () => {
  const g = game(); g.powerup = {type:'spread', remaining:10};
  fireDual(g);
  const ups = g.playerShots.filter(s=>s.dir==='up');
  assert.equal(ups.length, 3);
  assert.ok(ups.some(s=>s.vx<0) && ups.some(s=>s.vx===0) && ups.some(s=>s.vx>0));
});
test('forward shot destroys rock and scores 100', () => {
  const g = game();
  g.terrain = { mode:'test', features:[{id:1,type:'rock',x:g.buggy.worldX+60,w:16,hp:1,destroyed:false}] };
  fireDual(g);
  for (let i=0;i<120 && !g.terrain.features[0].destroyed;i++) updateWeapons(g, DT);
  assert.ok(g.terrain.features[0].destroyed);
  assert.ok(g.scoreEvents.some(e=>e.tag==='rockShot'));
});
