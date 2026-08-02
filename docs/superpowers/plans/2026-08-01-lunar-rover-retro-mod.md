# Lunar Rover: Retro-Mod Moon Patrol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser Moon Patrol remake — faithful 1982 core loop plus power-ups, bosses, combo multiplier, and endless mode — in vanilla JS with no build step.

**Architecture:** Fixed-timestep (60 Hz) simulation with rAF-interpolated rendering onto a 384×240 offscreen pixel buffer scaled up with `image-rendering: pixelated`. Pure-logic modules (terrain, buggy, enemies, score, combo, powerups) have no DOM/canvas imports and are tested with `node --test`; presentation modules (render, hud, sprites, audio) consume game state plus a per-frame `game.events` string array.

**Tech Stack:** Vanilla JS (native ES modules), HTML5 Canvas 2D, WebAudio, `node --test` for unit tests. Zero dependencies, zero build tooling.

**Spec:** `docs/superpowers/specs/2026-08-01-lunar-rover-retro-mod-design.md` — read it before starting any task.

## Global Constraints

- Vanilla JS ES modules only. No npm packages, no build step, no image or audio asset files. All sprites are pixel data in code; all audio is synthesized.
- Internal resolution `VIEW_W=384, VIEW_H=240`. HUD occupies top 36 px. Ground line (top of terrain strip) at `GROUND_Y=200`.
- Fixed timestep `DT = 1/60` s. All speeds in px/s, all durations in seconds.
- Pure-logic modules (`terrain.js`, `buggy.js`, `enemies.js`, `boss.js`, `powerups.js`, `combo.js`, `score.js`, `state.js`, `rng.js`) must not import DOM/canvas/audio. Presentation modules (`render.js`, `hud.js`, `sprites.js`, `audio.js`, `input.js`, `main.js`) may.
- Modules communicate through one shared `game` object passed explicitly. Gameplay modules signal presentation via `game.events.push('jump'|'fire'|'explosion'|...)`; `main.js` clears `game.events` after render+audio consume it each frame.
- One-hit deaths (shield power-up absorbs one). Forward gun: max 1 player shot on screen (3 with rapid-fire). Vertical gun: max 4.
- Scoring values, checkpoint structure (A–Z, breaks at E/J/O/T/Z), and extra lives at 10,000/30,000/50,000 exactly as in the spec.
- Tests run with `node --test tests/`. Every pure-logic task follows TDD: failing test first.
- Commit after every task with a conventional-commit message ending in the Co-Authored-By line from the harness rules.
- localStorage access always wrapped in try/catch. AudioContext created/resumed only on first user gesture.

## Task Dependency Graph (for the orchestrator)

```
T1 scaffold ─┬─ T2 terrain ──┬─ T3 buggy ──┬─ T4 render(playable) ─┬─ T5 shooting ── T6 enemies ─┬─ T7 checkpoints/score ─┬─ T8 HUD
             │               │             │                       │                             │                        ├─ T10 combo
             └───────────────┘             │                       └─ T9 audio (parallel OK)     │                        ├─ T11 powerups (needs T6)
                                           │                                                     │                        └─ T13 endless (needs T2,T7)
                                           │                                                     └─ T12 bosses (needs T6,T7,T11)
                                           └─ T14 polish (last; needs everything)
```

Parallel-safe pairs after T7: {T8, T9, T10} together; then {T11, T13}; then T12; then T14. Tasks touching the same file must not run concurrently (check the Files lists).

---

### Task 1: Scaffold, game loop, input

**Files:**
- Create: `index.html`, `css/style.css`, `js/main.js`, `js/input.js`
- Test: manual (browser) — this task is presentation-layer

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `input.js`: `createInput(touchRootEl) -> input`; `input.state = {accel, brake, jump, fire, pause, mute, restart}` (booleans, held); `input.pressed(name) -> bool` (true only on the frame the key went down); `input.endFrame()` called once per sim tick to age just-pressed flags.
  - `main.js`: boots canvas, runs `let acc=0; loop(t){ acc+=elapsed; while(acc>=DT){ update(DT); input.endFrame(); acc-=DT; } render(acc/DT); }`. Exposes nothing; imports everything.
  - `index.html`: `<canvas id="screen" width="384" height="240">`, a `<div id="touch-ui">` with `#btn-jump`, `#btn-fire`, `#zone-speed` elements, `<script type="module" src="js/main.js">`.

- [ ] **Step 1: Write `index.html` and `css/style.css`**

Canvas centered and letterboxed, black background, scaled with CSS to the largest integer-ish multiple that fits, `image-rendering: pixelated`. Touch UI hidden by default; shown via `body.touch` class (added in input.js when a `touchstart` is seen). Touch layout: `#zone-speed` covers left 40% of viewport (top half = accelerate, bottom half = brake, handled in JS by touch Y); `#btn-jump` and `#btn-fire` are 72px round buttons bottom-right.

- [ ] **Step 2: Write `js/input.js`**

```js
const KEYMAP = {
  ArrowRight:'accel', KeyD:'accel', ArrowLeft:'brake', KeyA:'brake',
  Space:'jump', ArrowUp:'jump', KeyW:'jump',
  KeyX:'fire', KeyZ:'fire', KeyJ:'fire', KeyK:'fire',
  KeyP:'pause', KeyM:'mute', KeyR:'restart',
};
export function createInput(touchRoot) {
  const state = {accel:false,brake:false,jump:false,fire:false,pause:false,mute:false,restart:false};
  const just = new Set();
  const set = (a,v)=>{ if(v && !state[a]) just.add(a); state[a]=v; };
  addEventListener('keydown', e=>{ const a=KEYMAP[e.code]; if(a){ set(a,true); e.preventDefault(); } });
  addEventListener('keyup',   e=>{ const a=KEYMAP[e.code]; if(a) set(a,false); });
  // touch: buttons map to jump/fire; #zone-speed touches -> accel (upper half) / brake (lower half)
  ...bind touchstart/touchend/touchmove on touchRoot children, add 'touch' class to body on first touchstart...
  return { state, pressed:n=>just.has(n), endFrame:()=>just.clear() };
}
```

(The `...` line above is shorthand in this plan only — write the real listeners: `touchstart`/`touchend` on `#btn-jump`→`set('jump',…)`, `#btn-fire`→`set('fire',…)`, and per-touch tracking on `#zone-speed` comparing `touch.clientY` to the zone's midpoint for accel/brake.)

- [ ] **Step 3: Write `js/main.js` with a visible heartbeat**

Fixed-timestep loop as in Interfaces. For now `update` advances a counter and `render` fills the buffer black, draws a moving white pixel-square and the text "LUNAR ROVER" so motion and scaling are verifiable. Draw onto an offscreen 384×240 canvas, then `drawImage` it to `#screen` (same size — CSS does the upscaling).

- [ ] **Step 4: Verify in browser**

Serve with `python3 -m http.server` (or the in-app preview) and confirm: square moves smoothly, no console errors, canvas stays pixelated when the window resizes, pressing keys logs no errors.

- [ ] **Step 5: Commit**

```bash
git add index.html css js && git commit -m "feat: scaffold canvas, fixed-timestep loop, unified input"
```

---

### Task 2: RNG + terrain system (pure logic)

**Files:**
- Create: `js/rng.js`, `js/terrain.js`
- Test: `tests/terrain.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `rng.js`: `mulberry32(seed) -> () => float in [0,1)`.
  - `terrain.js` constants: `CHECKPOINT_SPACING=1200`, `LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZ'`, `STAGE_BREAKS=[4,9,14,19,25]` (indices of E,J,O,T,Z), `FEATURE_W={crater:24, bigCrater:40, doubleCrater:56, rock:16, bigRock:22, mine:12, bombCrater:28}`.
  - `buildClassicCourse(courseId /*0=beginner,1=champion*/) -> terrain`
  - `createEndlessTerrain(seed) -> terrain`; `ensureGenerated(terrain, upToX)` (no-op for classic)
  - `featuresInRange(terrain, x0, x1) -> Feature[]` where `Feature = {id, type, x, w, hp, destroyed}` (`hp`: rock=1, bigRock=2, others 0)
  - `addBombCrater(terrain, x)` — inserts a `bombCrater` feature if no feature overlaps [x, x+28]
  - `checkpointIndexAt(x) -> 0..25` (clamped), `checkpointX(i) -> i*CHECKPOINT_SPACING`
  - `destroyFeature(terrain, id)` — decrements hp; sets `destroyed=true` at 0 hp; returns `{destroyed:bool, type}`

- [ ] **Step 1: Write failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClassicCourse, createEndlessTerrain, ensureGenerated, featuresInRange,
         addBombCrater, checkpointIndexAt, destroyFeature, CHECKPOINT_SPACING } from '../js/terrain.js';

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
```

- [ ] **Step 2: Run `node --test tests/` — expect FAIL (module not found)**

- [ ] **Step 3: Implement `rng.js` and `terrain.js`**

`mulberry32` is the standard 32-bit PRNG. Terrain internals: `{features: [], nextId: 1, generatedTo: x, mode, rng, difficultyBase}` with features kept x-sorted. Classic course: build per-checkpoint segments from pattern templates — an array of template functions, each returning `[{off, type}]` (offsets within the 1200px segment, ≥80px gaps, no features in the first 200px of segment A or the 150px after each checkpoint line so respawns are safe). Segment difficulty tier = stage index (0–4); mines only appear in templates used for stage ≥2 (checkpoint J onward = index ≥9); champion course (`courseId=1`) uses denser templates (one extra feature per segment, `doubleCrater` allowed from stage 1). Deterministic: use `mulberry32(courseId*1000 + segmentIndex)` per segment to pick among the tier's templates. Endless: `ensureGenerated` appends 1200px chunks; feature count per chunk = `2 + floor(difficulty)` capped at 6, where `difficulty = chunkIndex * 0.15`; mines allowed from chunk 6. `addBombCrater` rejects on any overlap with an existing non-destroyed feature or a checkpoint line ±40px.

- [ ] **Step 4: Run `node --test tests/` — expect all PASS**

- [ ] **Step 5: Commit** — `git add js/rng.js js/terrain.js tests && git commit -m "feat: seeded RNG + classic/endless terrain system"`

---

### Task 3: Buggy physics + collision (pure logic)

**Files:**
- Create: `js/buggy.js`
- Test: `tests/buggy.test.js`

**Interfaces:**
- Consumes: `featuresInRange(terrain,x0,x1)` from Task 2.
- Produces (from `buggy.js`):
  - Constants: `SPEED_BANDS=[80,140,200]`, `ACCEL=60` (px/s² toward band target), `JUMP_VY=-170`, `GRAVITY=340`, `BUGGY_W=32`, `BUGGY_H=20`, `SETTLE_TIME=0.15`.
  - `createBuggy() -> {worldX:0, y:0 /*px above ground, negative = up*/, vy:0, band:1, speed:SPEED_BANDS[1], airborne:false, settle:0, wheelPhase:0, alive:true, deathCause:null}`
  - `updateBuggy(game, input, dt)` — speed band changes on `input.pressed('accel'/'brake')` (clamped 0–2), `game.speed` eases toward `SPEED_BANDS[band]` at `ACCEL`; jump on `pressed('jump')` when grounded and `settle<=0` (emits `'jump'` event); integrates `worldX += speed*dt`, vertical physics when airborne; landing sets `settle=SETTLE_TIME`, emits `'land'`; `wheelPhase += speed*dt*0.15` when grounded.
  - `buggyHitbox(buggy) -> {x0,x1}` (worldX .. worldX+BUGGY_W)
  - `checkTerrainCollision(buggy, terrain) -> null | 'crater'|'rock'|'mine'` — grounded only; crater types kill when the buggy's **midpoint** is inside the crater span; rock/mine kill on any hitbox overlap with a non-destroyed feature.
  - `killBuggy(game, cause)` — respects `game.powerup?.type==='shield'` (consumes shield, emits `'shieldBreak'`, returns false = survived); otherwise sets `alive=false`, `deathCause`, emits `'explosion'`, returns true.

- [ ] **Step 1: Write failing tests**

```js
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
```

Note for implementer: `checkTerrainCollision` should call `featuresInRange` when the terrain object has real internals, but must also work when handed a bare `{features:[...]}` test double — implement it to scan `terrain.features` directly when `terrain.mode==='test'`, else use `featuresInRange`.

- [ ] **Step 2: Run `node --test tests/buggy.test.js` — expect FAIL**

- [ ] **Step 3: Implement `js/buggy.js` per the Interfaces block**

- [ ] **Step 4: Run `node --test tests/` — expect all PASS**

- [ ] **Step 5: Commit** — `git commit -m "feat: buggy physics — speed bands, scaled jumps, terrain collision, shield-aware death"`

---

### Task 4: Sprites + renderer — first playable

**Files:**
- Create: `js/sprites.js`, `js/render.js`, `js/state.js`
- Modify: `js/main.js` (wire real game)
- Test: manual (browser)

**Interfaces:**
- Consumes: Tasks 1–3 (input, terrain, buggy).
- Produces:
  - `state.js`: `createGame(mode /*'classic'|'endless'*/, seed) -> game` with fields `{mode, phase:'attract'|'playing'|'dying'|'respawning'|'stageClear'|'boss'|'gameOver', phaseTimer, buggy, terrain, speed, camX, score, lives:3, checkpoint:0, stage:0, stageTime:0, events:[], playerShots:[], enemyShots:[], enemies:[], capsules:[], powerup:null, combo:{count:0,mult:1,timer:0}, rngSeed}`; `updateGame(game, input, dt)` — the orchestrator that calls the per-module updates that exist so far and manages phase transitions: `attract` → (any key) → `playing`; `playing` → (buggy dead) → `dying` (0.9 s) → `respawning` (reset buggy to `checkpointX(game.checkpoint)`, 1 s invulnerable-blink) → `playing`; lives 0 → `gameOver`. `game.camX = buggy.worldX - buggyScreenX(game)` where `buggyScreenX = 56 + (speed - SPEED_BANDS[0]) * 0.45` (drifts right with speed).
  - `sprites.js`: `buildSprites() -> {name: OffscreenCanvas-like}` for: `buggyBody`, `wheel` (2 frames), `astronaut`, `crater`, `bigCrater`, `doubleCrater`, `rock`, `bigRock`, `mine` (2 frames blink), `shotFwd`, `shotUp`, `ufoA/ufoB/ufoC`, `tank`, `chaser`, `bomb`, `capsule`, `boss1`, `explosion` (3 frames), `earth`, `mountainFar`, `mountainNear` (tileable 96px strips). Each drawn from small string-array pixel maps (`'.'`=transparent, letters index a per-sprite palette), rasterized at boot via `document.createElement('canvas')`. Buggy: squat magenta/pink body ~32×14 with cannon, astronaut bump, 3 wheels drawn separately.
  - `render.js`: `createRenderer(screenCanvas) -> r` (holds the 384×240 buffer); `render(r, game, alpha)` draws: starfield (fixed stars + Earth, scroll ×0.05), far mountains (×0.2), near mountains (×0.5), terrain strip (solid pink band `#e05098` from GROUND_Y down, dark notches for craters, features as sprites), buggy at interpolated position with 3 wheels bobbing (`y += sin(wheelPhase + i*1.7)*1.5` per wheel, only grounded), then shots/enemies/capsules if present, then HUD placeholder bar, then phase overlays (`attract`: title + "PRESS ANY KEY"; `dying`: explosion frames; `gameOver`: text). Stage palette: 5 palettes (background hue set per stage index) defined here.

- [ ] **Step 1: Implement `sprites.js`** — pixel maps as described. Keep every sprite ≤ 24×24 except mountains/earth.

- [ ] **Step 2: Implement `state.js`** — `createGame` + `updateGame` with phase machine; call `updateBuggy` and `checkTerrainCollision` → `killBuggy` when playing; decrement lives on death; respawn at `checkpointX(checkpoint)`.

- [ ] **Step 3: Implement `render.js`** and rewrite `main.js` to create game on boot (classic, attract phase), run loop `updateGame`/`render`.

- [ ] **Step 4: Playtest in browser**

Verify: parallax layers move at different speeds; buggy accelerates/brakes with visible screen drift; jump arc feels floaty; driving into a crater/rock kills, explodes, respawns at last checkpoint; wheels bob; 60fps smooth.

- [ ] **Step 5: Commit** — `git commit -m "feat: sprites, parallax renderer, game state machine — first playable"`

---

### Task 5: Shooting

**Files:**
- Create: `js/weapons.js`
- Modify: `js/state.js` (call `updateWeapons`), `js/render.js` (draw shots — if not already stubbed)
- Test: `tests/weapons.test.js`

**Interfaces:**
- Consumes: `game` from state.js, `destroyFeature` from terrain.js, `addScore(game, base, tag)` — **not yet built** (Task 7); until T7, call `game.score += base` via the provided shim `award(game, base, tag)` exported from `weapons.js` and re-exported later. `award` must: push `{base, tag}` onto `game.scoreEvents` array and add to `game.score`. Task 7 replaces `award`'s internals (multiplier), not its signature.
- Produces:
  - `weapons.js`: `SHOT_SPEED_FWD=300` (relative to world), `SHOT_SPEED_UP=260`; `fireDual(game)` — respects on-screen limits (fwd: 1, or 3 with `game.powerup?.type==='rapid'`; up: 4; spread power-up makes the up-shot three shots at -20°/0°/+20°), pushes shots `{x,y,vx,vy,dir:'fwd'|'up'}`, emits `'fire'`; `updateWeapons(game, dt)` — on `input.pressed('fire')` calls `fireDual`; moves shots (fwd shots also add `game.speed*dt` so they outrun the buggy); culls off-screen; collides fwd shots with terrain features (`rock`/`bigRock`/`mine` only): `destroyFeature`, `award(game, 100, 'rockShot')` when destroyed, emit `'explosion'`; shot is consumed on hit even if rock survives.
  - `award(game, base, tag)` as described above.

- [ ] **Step 1: Write failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fireDual, updateWeapons, award } from '../js/weapons.js';
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
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `weapons.js`; wire `updateWeapons` into `state.js`; draw shots in `render.js` (2×2 white fwd, 1×4 white up)**
- [ ] **Step 4: Run `node --test tests/` — all PASS; quick browser check**
- [ ] **Step 5: Commit** — `git commit -m "feat: dual-fire weapons with on-screen limits and rock destruction"`

---

### Task 6: Enemies — UFOs, tanks, chase cars, bomb craters

**Files:**
- Create: `js/enemies.js`
- Modify: `js/state.js` (spawn director + updates), `js/render.js` (draw enemies/bombs)
- Test: `tests/enemies.test.js`

**Interfaces:**
- Consumes: `addBombCrater`, `award`, `killBuggy`, game state.
- Produces (`enemies.js`):
  - Enemy shapes: `{id, kind:'swooper'|'aimer'|'bomber'|'tank'|'chaser', x, y, vx, vy, hp:1, t:0, formationId?}`.
  - `spawnDirector(game, dt)` — timer-driven waves while `phase==='playing'`: every 6–10 s (rng from `game.waveRng = mulberry32(seed)`) pick by stage: stage 0: swooper formation (3 UFOs, sine path); stage ≥1: + aimer pairs and tanks (tank spawns on ground at `camX+VIEW_W+40`); stage ≥2: + bombers (fly ahead of buggy, drop `bomb` every 1.5 s targeting terrain ~120px ahead of buggy); stage ≥3: + chasers (spawn behind: `x = camX-40`, ground, `vx = game.speed*1.25`); endless mode: interval shrinks with difficulty, floor 3 s. Sets warning flags `game.warn = {air, mine, rear}` (`mine` true when a mine is within 400px ahead; `air` while any flyer alive; `rear` while a chaser is alive).
  - `updateEnemies(game, dt)` — moves each kind (swooper: sine; aimer: hovers then fires aimed shot every 2 s, max 2 of its shots alive; bomber: level flight + bomb drops; bombs fall with `GRAVITY*0.5`, on ground impact call `addBombCrater` at impact x, emit `'bombHit'`; tank: rolls at `speed*0.8` same direction, fires level shot every 2.5 s; chaser: gains on buggy, dies if it reaches a crater (falls in, no points), rams buggy on overlap while buggy grounded — buggy jumping over it emits near-miss `'chaserDodge'`), collides player shots vs enemies (up-shots hit flyers, fwd-shots hit ground enemies and bombers flying low), awards spec scores (`swooper` 100, `bomber` 200, `aimer` 100, `tank` 200 shot, `chaser` random pick of [500,800,1000]), formation bonus: if all 3 members of a `formationId` die, `award(game, 1000, 'formation')`; collides enemy shots/bombs/enemies vs buggy → `killBuggy`.
  - All enemy state lives in `game.enemies` / `game.enemyShots`; module is pure (rng passed via game).

- [ ] **Step 1: Write failing tests** (same style as prior tasks) covering: bomber's bomb creates a crater in clear terrain; chaser ram kills a grounded buggy but passing under an airborne buggy emits `'chaserDodge'` event and no death; up-shot kills a swooper and scores 100; killing all 3 formation members awards the 1000 formation bonus; tank shot with fwd gun scores 200; warning flags set correctly (air/rear).

Representative test:

```js
test('full formation wipe pays 1000 bonus', () => {
  const g = game(); // helper as in weapons tests
  g.enemies = [0,1,2].map(i=>({id:i, kind:'swooper', x:g.buggy.worldX+80+i*20, y:60, vx:0, vy:0, hp:1, t:0, formationId:'f1'}));
  for (const e of [...g.enemies]) hitEnemy(g, e);          // exported helper: applies one hit
  assert.ok(g.scoreEvents.some(ev=>ev.tag==='formation' && ev.base===1000));
});
```

Export `hitEnemy(game, enemy)` so tests and `updateEnemies` share the kill path.

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement, wire into state/render (sprites already exist from T4)**
- [ ] **Step 4: `node --test` all PASS; browser check: waves feel fair at stage 0**
- [ ] **Step 5: Commit** — `git commit -m "feat: UFO formations, aimers, crater-bombers, tanks, chase cars"`

---

### Task 7: Checkpoints, scoring, lives, respawn flow

**Files:**
- Create: `js/score.js`
- Modify: `js/state.js` (checkpoint/stage progression, stage-clear phase), `js/weapons.js` (`award` now applies combo mult — keep signature)
- Test: `tests/score.test.js`

**Interfaces:**
- Consumes: everything prior.
- Produces (`score.js`):
  - `SCORES = {craterJump:100, doubleCraterJump:200, mineJump:50, rockJump:80, rockShot:100, tankJump:100, tankShot:200, swooper:100, aimer:100, bomber:200, formation:1000}`; `EXTRA_LIFE_AT=[10000,30000,50000]`; `STAGE_PAR=55` (s), `STAGE_BONUS_BASE=1000`, `COURSE_BONUS=5000`.
  - `award(game, base, tag)` (moves here; weapons re-exports or imports): `pts = base * (game.combo?.mult ?? 1)`; adds to score; pushes `{base, pts, tag}` to `game.scoreEvents`; grants extra life crossing each `EXTRA_LIFE_AT` threshold once (emit `'extraLife'`).
  - `stageBonus(elapsed, champion) -> (STAGE_BONUS_BASE + 100*max(0, floor(STAGE_PAR - elapsed))) * (champion?2:1)`.
  - Jump-over scoring: in `state.js`, when the buggy lands, any non-destroyed feature fully passed while airborne awards its `*Jump` score (track `jumpStartX`; features with `x >= jumpStartX+BUGGY_W && x+w <= worldX` at landing).
  - Checkpoint progression in `state.js`: when `checkpointIndexAt(buggy.worldX) > game.checkpoint`, update it, emit `'checkpoint'`; when the new index is a stage break (in `STAGE_BREAKS`), enter `stageClear` phase (2.5 s): award `stageBonus(game.stageTime, courseId===1)` via ticking tally (award in 100-pt ticks each frame for the audio/HUD effect), reset `stageTime`, `stage++`, then (Task 12 will divert E/J/O/T to `boss` phase first). Passing Z: `COURSE_BONUS` + switch to champion course or loop it.
  - High scores: `loadScores(mode) -> [{initials, score}]` (≤10, sorted), `submitScore(mode, initials, score)`; localStorage key `lunar-rover-hs-<mode>`, try/catch, corrupt data → `[]`.

- [ ] **Step 1: Write failing tests** — `award` applies multiplier (set `game.combo={mult:3}` → 300 for base 100); extra life exactly once at each threshold (score 9990 → award 100 → lives+1; award more past 10000 again → no second life until 30000); `stageBonus(40,false)===2500`, `stageBonus(70,false)===1000`, doubled for champion; jump-scoring helper `featuresJumped(jumpStartX, landX, features)` returns cleared features only when fully cleared; `submitScore` keeps top-10 sorted and survives a throwing localStorage (inject a stub via exported `_setStorage(obj)` test hook).
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement `score.js`; refactor `weapons.js`/`enemies.js` to import `award` from it; add checkpoint/stageClear logic to `state.js`**
- [ ] **Step 4: `node --test` all PASS (including earlier suites — the `award` refactor must not break them)**
- [ ] **Step 5: Commit** — `git commit -m "feat: scoring tables, checkpoints, stage bonuses, lives, local high scores"`

---

### Task 8: HUD

**Files:**
- Create: `js/hud.js`
- Modify: `js/render.js` (replace placeholder bar with `drawHUD`)
- Test: manual (browser)

**Interfaces:**
- Consumes: `game` fields: score, lives, checkpoint, stage, stageTime, warn flags, combo, powerup; high score via `loadScores`.
- Produces: `drawHUD(ctx, game, sprites)` drawing the top 36 px: `1UP <score>` and `HI <top score>` in a 5×7 pixel font (implement `drawText(ctx,x,y,str)` with a bitmap font in `hud.js` — digits, A–Z, ×); current checkpoint letter (large); stage timer `MM:SS`; three warning lights (red=air, yellow=mine, blue=rear — lit versions blink at 4 Hz); A–Z progress bar: 26 ticks with E/J/O/T/Z taller + labeled, marker at current position; lives as small buggy icons; combo `×N` next to score (flashes when it increases); active power-up icon + shrinking countdown pip-bar. Attract screen also uses `drawText` for title/menu.

- [ ] **Step 1: Implement bitmap font + `drawHUD` as specified**
- [ ] **Step 2: Playtest — verify every element updates live (warning lights, progress marker, timer, combo, power-up timer)**
- [ ] **Step 3: Commit** — `git commit -m "feat: authentic HUD — score, warning lights, A-Z progress, lives, combo, power-up"`

---

### Task 9: Audio

**Files:**
- Create: `js/audio.js`
- Modify: `js/main.js` (init on first gesture; feed `game.events` each frame; M mutes)
- Test: manual (browser)

**Interfaces:**
- Consumes: `game.events`, `game.phase`, `game.stage`.
- Produces (`audio.js`): `createAudio() -> a`; `a.resume()` (call on first key/touch); `a.processEvents(events, game)`; `a.setMuted(m)`, `a.setMusicOn(b)`, `a.setSfxOn(b)` (persist all three to localStorage key `lunar-rover-audio`, try/catch).
  - Music: 16-step sequencer on `setInterval`-free scheduling (lookahead via `audioCtx.currentTime`, schedule 0.1 s ahead each rAF). Walking bassline: triangle osc, 8th-note pattern in A minor (A1 C2 E2 G2 A2 G2 E2 C2 style walk, 112 BPM), plus a square-wave lead entering every other 8 bars, noise-burst hi-hat on off-beats. Boss phase: same engine, minor-2nd ostinato pattern, 140 BPM. `stageClear`: ascending fanfare arpeggio. `gameOver`: descending jingle.
  - SFX (each a short coded synth, triggered by event name): `fire` square blip 660→440 Hz 60 ms; `jump` sine 180→320 Hz 150 ms; `land` 90 Hz thud 50 ms; `explosion` white-noise burst through lowpass 800→100 Hz 400 ms; `bombHit` shorter noise burst; `checkpoint` two-note chime; `extraLife` 4-note arp; `powerup` rising sweep; `shieldBreak` metallic square hit; `mineBeep` 1200 Hz pip when `warn.mine` first lights; `siren` two-tone alternating while `warn.rear` (loop, stop when flag clears); `tally` 30 ms tick per 100-pt stage-bonus tick.
  - Master `GainNode` chain: sfxGain + musicGain → masterGain → destination.

- [ ] **Step 1: Implement `audio.js`; wire into `main.js` (`audio.processEvents(game.events, game)` after render, then `game.events.length = 0`)**
- [ ] **Step 2: Playtest — bassline loops seamlessly, stingers fire, M toggles mute, no autoplay warning in console before first input**
- [ ] **Step 3: Commit** — `git commit -m "feat: synthesized chiptune — walking bassline, stingers, full SFX"`

---

### Task 10: Combo multiplier

**Files:**
- Create: `js/combo.js`
- Modify: `js/state.js` (update + near-miss detection), `js/score.js` (already reads `combo.mult`)
- Test: `tests/combo.test.js`

**Interfaces:**
- Consumes: `game.scoreEvents`, buggy state.
- Produces (`combo.js`): `createCombo() -> {count:0, mult:1, timer:0}`; `comboAction(combo)` — increments count, `timer=4.0`, recomputes `mult`: count ≥15→5, ≥10→4, ≥6→3, ≥3→2, else 1 (emit `'comboUp'` when mult increases); `updateCombo(game, dt)` — decrements timer, at 0 resets count/mult (emit `'comboLost'` only if mult>1); `resetCombo(combo)` for death. Wiring in `state.js`: every `scoreEvents` entry this frame (except `stageBonus`/`tally` tags) counts as an action; near-misses count too: landing a jump whose cleared features included any crater type at speed band 2, and the `'chaserDodge'` event. `award` already multiplies — combo must be updated **after** awards are multiplied (i.e., this frame's actions raise the multiplier for the *next* award, which avoids order ambiguity).
- [ ] **Step 1: Write failing tests** — mult thresholds (3 actions → ×2, 15 → ×5); timer expiry resets (simulate 4 s of `updateCombo`); death resets; an award at mult 3 yields `pts === base*3` (integration with `score.js`); action during `stageClear` tally does not increment count.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement + wire (HUD already renders `×N` from Task 8)**
- [ ] **Step 4: `node --test` all PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat: x1-x5 combo multiplier with near-miss detection"`

---

### Task 11: Power-ups

**Files:**
- Create: `js/powerups.js`
- Modify: `js/state.js`, `js/enemies.js` (formation-wipe drop), `js/buggy.js` (hover double-jump uses `game.powerup`)
- Test: `tests/powerups.test.js`

**Interfaces:**
- Consumes: formation-wipe path in `enemies.js` (`hitEnemy`), buggy jump logic.
- Produces (`powerups.js`): `TYPES=['shield','rapid','spread','hover']`, `DURATIONS={shield:Infinity, rapid:10, spread:10, hover:15}`; `spawnCapsule(game, x, y)` — pushes `{x, y, vy:20, type}` onto `game.capsules`, type from `game.waveRng` uniform; `updatePowerups(game, dt)` — capsules drift down then sit on ground scrolling with world, expire after 8 s grounded, collect on buggy overlap → `applyPowerup(game, type)` (replaces current, emits `'powerup'`); ticks `game.powerup.remaining`, clears at 0 (emit `'powerupEnd'`). Drop rules: formation wipe → 40% chance (`waveRng`), bosses (T12) → guaranteed. Hover: in `buggy.js`, when `game.powerup?.type==='hover'` and airborne and `pressed('jump')` and `!buggy.hoverUsed` → `vy = JUMP_VY*0.7`, `hoverUsed=true` (reset on landing). Shield/rapid/spread effects already implemented in T3/T5 — this task makes them obtainable.
- [ ] **Step 1: Write failing tests** — capsule collected on overlap applies power-up and replaces existing; rapid expires after 10 s of updates; shield persists (Infinity) until consumed; hover grants exactly one mid-air boost per jump; formation wipe with rng forced (inject `game.waveRng=()=>0.1`) spawns a capsule.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement + wire; capsule sprite exists from T4**
- [ ] **Step 4: `node --test` all PASS; browser check pickup feel**
- [ ] **Step 5: Commit** — `git commit -m "feat: shield/rapid/spread/hover power-up capsules"`

---

### Task 12: Bosses

**Files:**
- Create: `js/boss.js`
- Modify: `js/state.js` (divert stage breaks into `boss` phase), `js/render.js` (boss + health bar), `js/sprites.js` (boss2 sprite if not present)
- Test: `tests/boss.test.js`

**Interfaces:**
- Consumes: stage-clear flow (T7), `addBombCrater`, `spawnCapsule`, `award`.
- Produces (`boss.js`): `startBoss(game) -> game.boss = {hp, maxHp, phase:0, t:0, x, y, pattern:'enter', patternT:0}`; `maxHp = 12 + stage*6` (Z final boss: `hp=40`, two phases — phase 1 patterns as stage bosses, at hp≤20 phase 2: faster + adds dive sweeps); `updateBoss(game, dt)` — pattern state machine cycling `enter → hover → bombCarpet (5 bombs across the screen) → aimedBurst (3 aimed shots) → [stage≥2: diveSweep] → hover…`, telegraph each attack with 0.6 s flash (emit `'bossTelegraph'`); player up/fwd shots hit boss hitbox (`hitBoss(game)` exported), `award(game, 200, 'bossHit')` per hit; on death: `award(game, 2000 + stage*1000, 'bossKill')`, guaranteed `spawnCapsule`, emit `'bossDown'`, resume `stageClear` tally then next stage. During `boss` phase: `spawnDirector` paused, terrain features suppressed (skip collision for features, or better: boss arena occupies clear ground — `state.js` clamps scroll so the fight happens over a 1600px pre-cleared strip appended at each stage break by `terrain.js`'s course builder — add `clearZone(terrain, x0, x1)` there). Buggy still scrolls/jumps normally.
- [ ] **Step 1: Write failing tests** — `startBoss` hp scales with stage; pattern cycle order for stage 0 boss over simulated time; `hitBoss` decrements and kills at 0 with capsule spawned + `bossKill` score event; Z boss switches to phase 2 at half hp; state.js diverts to `boss` phase at break E and returns to `playing` after `bossDown`.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement; add `clearZone` to terrain course builder; wire phases**
- [ ] **Step 4: `node --test` all PASS; browser fight-feel check (fair, readable telegraphs)**
- [ ] **Step 5: Commit** — `git commit -m "feat: stage-break mothership bosses with two-phase finale"`

---

### Task 13: Endless mode + mode select

**Files:**
- Modify: `js/state.js` (mode select on attract screen, endless rules), `js/enemies.js` (difficulty-scaled spawn intervals — already parameterized), `js/terrain.js` (already built in T2), `js/hud.js` (endless: distance counter instead of checkpoint letter)
- Test: `tests/endless.test.js`

**Interfaces:**
- Consumes: `createEndlessTerrain`, `ensureGenerated` (T2), spawn director scaling (T6), `submitScore('endless', …)` (T7).
- Produces: attract screen menu — Up/Down (or brake/accel keys) toggles CLASSIC / ENDLESS, jump/fire starts (HUD hint text). Endless rules in `state.js`: `game.speed` band targets scale `+4 px/s` every 30 s (cap +60); `ensureGenerated(terrain, camX + 2*VIEW_W)` each frame; boss every 90 s (`game.nextBossAt = 90` then `+= 90`), reusing T12 with `stage = min(4, floor(elapsed/90))`; endless uses the same 3-lives rule, respawning at the nearest 1200px boundary at or behind the death position; distance in meters (`worldX/10`) drives HUD counter; on game over `submitScore('endless', initials, score)`.
- [ ] **Step 1: Write failing tests** — endless game generates terrain ahead as worldX grows; speed cap respected after long simulation; boss triggers at 90 s; respawn X is a 1200 boundary ≤ death X; separate high-score key used.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement + menu**
- [ ] **Step 4: `node --test` all PASS; browser: full endless run to first boss**
- [ ] **Step 5: Commit** — `git commit -m "feat: endless mode with ramping difficulty and mode-select menu"`

---

### Task 14: Polish — particles, shake, CRT, high-score entry, touch pass

**Files:**
- Create: `js/particles.js`
- Modify: `js/render.js` (shake + CRT + particles), `js/state.js` (hit-stop, initials entry phase), `js/hud.js` (high-score table + initials entry UI), `css/style.css` (touch sizing pass)
- Test: `tests/particles.test.js` (pool logic only) + manual

**Interfaces:**
- Consumes: `game.events`.
- Produces:
  - `particles.js` (pure pool): `createParticles(max=256)`, `emit(p, kind, x, y)` kinds: `dust` (wheel puffs while grounded at band 2), `muzzle`, `boom` (16 chunky squares, gravity), `spark` (boss hits); `updateParticles(p, dt)`; render loop draws them as 2–3px rects.
  - Screen shake: `render.js` keeps `shake` decaying 8/s; `'explosion'`→6px, `'bossDown'`→10px, `'bombHit'`→3px; applied as integer pixel offset of the world layers (never the HUD).
  - Hit-stop: in `state.js`, enemy kills set `game.freeze=0.03` (skip sim while >0, decrement by real dt).
  - CRT overlay: after drawing the buffer to screen canvas, draw scanlines (every other row `rgba(0,0,0,0.25)`) and a radial vignette from a pre-built overlay canvas; toggle with C key + persist (`lunar-rover-crt`).
  - Initials entry: new phase `enterScore` when a run's score makes the top 10 — 3-slot A–Z picker (accel/brake cycles letter, jump advances), then `submitScore`, then show table on attract screen (classic + endless toggle with the mode selector).
  - Touch pass: verify all controls reachable with thumbs on a phone-sized viewport; landscape prompt overlay (`css` media query portrait → "ROTATE DEVICE" banner).
- [ ] **Step 1: Write failing pool tests** — emit caps at max, particles expire, pool reuses slots (no unbounded growth over 10 000 emits)
- [ ] **Step 2: Run — FAIL; implement `particles.js`; PASS**
- [ ] **Step 3: Implement shake, hit-stop, CRT, initials entry, touch pass**
- [ ] **Step 4: Full playtest — classic through first boss and endless 3 min, desktop + mobile viewport; `node --test tests/` all green**
- [ ] **Step 5: Commit** — `git commit -m "feat: particles, screen shake, CRT overlay, high-score entry, touch polish"`

---

## Final Verification (after all tasks)

- [ ] `node --test tests/` — entire suite green.
- [ ] Browser playthrough: classic A→ first boss → death/respawn → game over → initials entry → table shows entry.
- [ ] Endless: menu select, 3 minutes, boss at 90 s, ramping speed, separate table.
- [ ] Toggles: mute (M), CRT (C), pause (P), restart (R) all work and persist where specified.
- [ ] Mobile viewport: touch controls usable, landscape prompt in portrait.
- [ ] No console errors; no 404s; works from a plain static file server.
