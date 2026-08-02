// boss.js — pure-logic stage-break mothership boss fights: hp scaling, the
// enter/hover/telegraph/attack pattern state machine, the boss's own
// bombs/aimed shots (pushed into the shared game.enemyShots list so they
// move/impact/collide-with-the-buggy through enemies.js's existing
// machinery), and player-shot-vs-boss collision. No DOM/canvas/audio
// imports: this module is Node-testable, mirroring enemies.js/weapons.js's
// pure-logic contract. Presentation reads game.boss (x, y, hp, maxHp,
// phase2, telegraph) and draws a health bar; audio.js already has
// 'bossTelegraph'/'bossDown' handlers wired (see audio.js's sfx table).
//
// NOTE on the GROUND_Y import below: state.js imports startBoss/updateBoss/
// hitBoss from this module, so this file and state.js form an import
// cycle. That is safe here because GROUND_Y is only ever read inside
// function bodies (deferred to call time, after every module has finished
// loading) — never at this module's top level. Same pattern as
// enemies.js/weapons.js/powerups.js.
import { GROUND_Y } from './state.js';
import { BUGGY_W } from './buggy.js';
import { award } from './score.js';
import { spawnCapsule } from './powerups.js';
import { pushFx } from './particles.js';

// --- tunables / balance guardrails ------------------------------------------
//
// Design notes (see task-12 brief):
//  - maxHp = 12 + stage*6 for the four early bosses (E/J/O/T at
//    stage 0/1/2/3 -> 12/18/24/30 hp); the Z course-end boss is a fixed
//    40 hp two-phase fight (stage===4 when entering — the stage index has
//    not yet incremented past the U-Z segment), reaching phase 2 (faster
//    patterns + guaranteed diveSweep) at hp<=20.
//  - Every attack is telegraphed 0.6s before it fires (bossTelegraph event
//    + game.boss.telegraph>0 for render.js to flash the sprite), so the
//    player always gets a fair warning window before anything launches.
//  - bombCarpet drops 5 bombs at fixed world-relative offsets from the
//    buggy at each bomb's fire time (BOMB_OFFSETS below) chosen so a
//    ~90px gap — comfortably wider than BUGGY_W(32) — always survives
//    between two of the resulting craters, guaranteeing a driveable lane.
//  - aimedBurst shots travel at AIMED_SHOT_SPEED (160px/s), capped below
//    the buggy's top cruise band (200px/s) so every shot is outrunnable/
//    dodgeable rather than an inevitable hit.
//  - diveSweep telegraphs first, dips to near buggy-head height over
//    DIVE_SWEEP_DURATION, then returns to hover altitude — it never lingers
//    at head height waiting to be rammed or camped.

const ENTER_TIME = 0.8;      // seconds the boss takes to arrive on screen
const HOVER_TIME = 1.5;      // seconds spent hovering between attacks
const TELEGRAPH_TIME = 0.6;  // seconds of warning flash before an attack fires

const BOMB_COUNT = 5;
const BOMB_INTERVAL = 0.35;   // seconds between each of the 5 bombs
const BOMB_CARPET_TAIL = 0.3; // buffer after the last bomb before the next hover
const BOMB_CARPET_DURATION = (BOMB_COUNT - 1) * BOMB_INTERVAL + BOMB_CARPET_TAIL;
// World-x offsets (from the buggy's position at each bomb's fire time) the
// 5 bombs target. The 92px gap between offset index 2 (140, crater spans
// 140-168) and index 3 (260, crater spans 260-288) is the guaranteed safe
// lane — comfortably wider than BUGGY_W(32).
const BOMB_OFFSETS = [40, 90, 140, 260, 310];

const AIMED_COUNT = 3;
const AIMED_INTERVAL = 0.4;   // seconds between each of the 3 aimed shots
const AIMED_BURST_TAIL = 0.3;
const AIMED_BURST_DURATION = (AIMED_COUNT - 1) * AIMED_INTERVAL + AIMED_BURST_TAIL;
const AIMED_SHOT_SPEED = 160; // px/s — below the buggy's top band (200px/s)

const DIVE_SWEEP_DURATION = 1.2;
const DIVE_DIP_Y = 150; // near buggy head height at the bottom of the dive

const HOVER_Y = 70;
const BOSS_X_AHEAD = 200; // boss tracks this far ahead of the buggy
const BOSS_W = 32;        // hitbox, per the brief ("~32x20")
const BOSS_H = 20;

const FINAL_PHASE2_HP = 20;   // the 40hp final boss enters phase2 at hp<=20
const PHASE2_SPEED_MULT = 0.7; // phase2 shortens hover/telegraph (faster fight)

// --- hp scaling --------------------------------------------------------------

/**
 * startBoss(game) — call once when a stage-break checkpoint (E/J/O/T/Z)
 * diverts the run into the 'boss' phase. Sets up game.boss fresh; does not
 * touch game.phase itself (state.js owns that transition).
 */
export function startBoss(game) {
  const isFinal = game.stage === 4; // only the Z break happens at stage 4
  const maxHp = isFinal ? 40 : 12 + game.stage * 6;
  game.boss = {
    hp: maxHp,
    maxHp,
    isFinal,
    phase2: false,
    x: game.buggy.worldX + BOSS_X_AHEAD,
    y: HOVER_Y,
    t: 0,
    pattern: 'enter',
    patternT: 0,
    telegraph: 0,
    nextAttack: null,
    attackIndex: 0,
    bombsFired: 0,
    aimedFired: 0,
  };
}

// --- pattern state machine ----------------------------------------------------

function speedMult(b) {
  return b.phase2 ? PHASE2_SPEED_MULT : 1;
}

/** Attacks available this fight: diveSweep unlocks at stage>=2, or in phase2. */
function attackPool(game, b) {
  const pool = ['bombCarpet', 'aimedBurst'];
  if (game.stage >= 2 || b.phase2) pool.push('diveSweep');
  return pool;
}

function enterHover(b) {
  b.pattern = 'hover';
  b.patternT = 0;
  b.y = HOVER_Y;
}

function enterTelegraph(game) {
  const b = game.boss;
  const pool = attackPool(game, b);
  b.nextAttack = pool[b.attackIndex % pool.length];
  b.attackIndex += 1;
  b.pattern = 'telegraph';
  b.patternT = 0;
  b.telegraph = TELEGRAPH_TIME * speedMult(b);
  game.events.push('bossTelegraph');
}

function beginAttack(game) {
  const b = game.boss;
  b.pattern = b.nextAttack;
  b.patternT = 0;
  b.bombsFired = 0;
  b.aimedFired = 0;
}

function nextBossShotId(game) {
  game._bossShotSeq = (game._bossShotSeq || 0) + 1;
  return `boss${game._bossShotSeq}`;
}

function fireBossBomb(game, index) {
  const b = game.boss;
  game.enemyShots.push({
    id: nextBossShotId(game),
    kind: 'bomb',
    from: 'boss',
    x: game.buggy.worldX + BOMB_OFFSETS[index % BOMB_OFFSETS.length],
    y: b.y,
    vx: 0,
    vy: 0,
  });
}

function fireBossAimedShot(game) {
  const b = game.boss;
  const buggy = game.buggy;
  const targetX = buggy.worldX + BUGGY_W / 2;
  const targetY = GROUND_Y + buggy.y - 10;
  const dx = targetX - b.x;
  const dy = targetY - b.y;
  const dist = Math.hypot(dx, dy) || 1;
  game.enemyShots.push({
    id: nextBossShotId(game),
    kind: 'aimed',
    from: 'boss',
    x: b.x,
    y: b.y,
    vx: (dx / dist) * AIMED_SHOT_SPEED,
    vy: (dy / dist) * AIMED_SHOT_SPEED,
  });
}

const BOMB_TIMES = Array.from({ length: BOMB_COUNT }, (_, i) => i * BOMB_INTERVAL);
const AIMED_TIMES = Array.from({ length: AIMED_COUNT }, (_, i) => i * AIMED_INTERVAL);

function runBombCarpet(game) {
  const b = game.boss;
  while (b.bombsFired < BOMB_COUNT && b.patternT >= BOMB_TIMES[b.bombsFired]) {
    fireBossBomb(game, b.bombsFired);
    b.bombsFired += 1;
  }
  if (b.patternT >= BOMB_CARPET_DURATION) enterHover(b);
}

function runAimedBurst(game) {
  const b = game.boss;
  while (b.aimedFired < AIMED_COUNT && b.patternT >= AIMED_TIMES[b.aimedFired]) {
    fireBossAimedShot(game);
    b.aimedFired += 1;
  }
  if (b.patternT >= AIMED_BURST_DURATION) enterHover(b);
}

function runDiveSweep(game) {
  const b = game.boss;
  const frac = Math.min(1, b.patternT / DIVE_SWEEP_DURATION);
  const dip = Math.sin(Math.PI * frac); // 0 at start/end, 1 at the midpoint
  b.y = HOVER_Y + (DIVE_DIP_Y - HOVER_Y) * dip;
  if (b.patternT >= DIVE_SWEEP_DURATION) {
    b.y = HOVER_Y;
    enterHover(b);
  }
}

function advancePattern(game, dt) {
  const b = game.boss;
  b.patternT += dt;

  switch (b.pattern) {
    case 'enter':
      if (b.patternT >= ENTER_TIME) enterHover(b);
      break;
    case 'hover':
      if (b.patternT >= HOVER_TIME * speedMult(b)) enterTelegraph(game);
      break;
    case 'telegraph':
      if (b.patternT >= TELEGRAPH_TIME * speedMult(b)) beginAttack(game);
      break;
    case 'bombCarpet':
      runBombCarpet(game);
      break;
    case 'aimedBurst':
      runAimedBurst(game);
      break;
    case 'diveSweep':
      runDiveSweep(game);
      break;
    default:
      break;
  }
}

// --- player shots vs boss -----------------------------------------------------

function bossBox(b) {
  return { x0: b.x, x1: b.x + BOSS_W, y0: b.y, y1: b.y + BOSS_H };
}

function shotOverlapsBoss(s, box) {
  const sw = s.dir === 'fwd' ? 4 : 2;
  const sh = s.dir === 'fwd' ? 2 : 4;
  return s.x < box.x1 && s.x + sw > box.x0 && s.y < box.y1 && s.y + sh > box.y0;
}

function collidePlayerShotsVsBoss(game) {
  if (!game.boss) return;
  const box = bossBox(game.boss);
  const kept = [];
  for (const s of game.playerShots) {
    if (game.boss && shotOverlapsBoss(s, box)) {
      hitBoss(game, 1);
    } else {
      kept.push(s);
    }
  }
  game.playerShots = kept;
}

// --- exported hit/kill path ----------------------------------------------------

/**
 * hitBoss(game, damage=1) — applies one hit to the active boss: decrements
 * hp, awards 200 'bossHit' every time (even the killing blow — it stacks
 * with the 'bossKill' bonus below, matching how a regular enemy's last hit
 * still pays its normal per-hit/per-kill amounts). At hp<=0 it emits
 * 'bossDown', pays the kill bonus, guarantees a capsule drop at the boss's
 * position, and nulls game.boss — state.js reads that null transition to
 * resume the stageClear tally flow (see enterStageClear in state.js), so
 * this module stays decoupled from the phase machine itself.
 */
export function hitBoss(game, damage = 1) {
  const b = game.boss;
  if (!b) return;

  b.hp -= damage;
  award(game, 200, 'bossHit');
  // Visual-only channel (see particles.js): every connecting shot throws a
  // light spark scatter off the hull. No audio event and no screen shake —
  // a 40hp fight would rattle the screen continuously otherwise.
  pushFx(game, 'spark', b.x + BOSS_W / 2, b.y + BOSS_H / 2);

  if (b.isFinal && !b.phase2 && b.hp <= FINAL_PHASE2_HP) {
    b.phase2 = true;
  }

  if (b.hp <= 0) {
    game.events.push('bossDown');
    // The big one: render.js maps 'bossDown' to a double boom burst and the
    // 10px screen shake.
    //
    // The matching hit-stop is NOT set here. It used to be, and it never
    // fired: state.js's 'boss' case reacts to game.boss going null later in
    // the same updateGame call by entering stageClear (or dying, in the
    // same-frame death race), and setPhase() clears game.freeze by design, so
    // the freeze was wiped before any frame could observe it. state.js now
    // applies HIT_STOP_BOSS *after* that transition instead — see the
    // bossJustDied branch there.
    pushFx(game, 'bossDown', b.x + BOSS_W / 2, b.y + BOSS_H / 2);
    award(game, 2000 + game.stage * 1000, 'bossKill');
    spawnCapsule(game, b.x, b.y);
    game.boss = null;
  }
}

/**
 * updateBoss(game, dt) — call every frame while game.phase === 'boss'.
 * Advances the boss's own timers/position, runs its pattern state machine
 * (spawning bombs/aimed shots into the shared game.enemyShots list, which
 * enemies.js's updateEnemies then moves/impacts/collides with the buggy
 * exactly like a regular enemy's fire), and resolves player shots against
 * the boss hitbox. No-ops if game.boss is already null (e.g. the boss died
 * to its own last-hit collision earlier in this same call).
 */
export function updateBoss(game, dt) {
  const b = game.boss;
  if (!b) return;

  b.t += dt;
  if (b.telegraph > 0) b.telegraph = Math.max(0, b.telegraph - dt);

  // Track ahead of the buggy so the boss stays reachable as the arena scrolls.
  b.x = game.buggy.worldX + BOSS_X_AHEAD;

  advancePattern(game, dt);
  collidePlayerShotsVsBoss(game);
}
