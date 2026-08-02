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
import { spawnBossCapsule } from './powerups.js';
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
//  - diveSweep telegraphs first, dips to strike height over
//    DIVE_SWEEP_DURATION, then returns to hover altitude — it never lingers
//    at head height waiting to be rammed or camped, and (final-review fix)
//    it only ever begins from a column at least DIVE_MIN_OFFSET ahead of the
//    buggy, holding that column for the whole run.
//  - See the FIGHT GEOMETRY block below for the horizontal sweep that makes
//    the whole fight winnable at all — that is the load-bearing part of the
//    design, and it was broken until the final-review fix wave.

const ENTER_TIME = 0.8;      // seconds the boss takes to arrive on screen
const HOVER_TIME = 1.5;      // seconds spent hovering between attacks
const TELEGRAPH_TIME = 0.6;  // seconds of warning flash before an attack fires

const BOMB_COUNT = 5;
const BOMB_INTERVAL = 0.35;   // seconds between each of the 5 bombs
const BOMB_CARPET_TAIL = 0.3; // buffer after the last bomb before the next hover
const BOMB_CARPET_DURATION = (BOMB_COUNT - 1) * BOMB_INTERVAL + BOMB_CARPET_TAIL;
// World-x offsets (from the buggy's position at each bomb's fire time) the
// 5 bombs target. The 92px gap between offset index 2 (crater spans 440-468)
// and index 3 (560-588) is the guaranteed safe lane — comfortably wider than
// BUGGY_W(32).
//
// The offsets are all LEAD, and the lead is what makes the carpet fair
// (final-review fix wave, folded into C1's "keep telegraphs/fairness"). A
// bomb takes ~1.24s to fall from hover altitude (130px at GRAVITY*0.5), in
// which time the buggy covers 99px (band 0) to 247px (band 2). The original
// [40, 90, 140, 260, 310] were measured from the buggy at DROP time, so by
// LANDING time the carpet had slid backwards past the player: at band 1 the
// first three craters appeared behind the buggy entirely, and at band 2 the
// fourth materialized at worldX+13..+41 — i.e. underneath the buggy's own
// midpoint, an instant unavoidable death with no reaction window at all.
// (Measured with the fight bot: ~1 death per 2s of boss fight at top speed,
// none of them dodgeable.) Shifting every offset by +300 puts the whole
// carpet ahead of the buggy at every speed band — landing at worldX+93 in
// the worst case, ~0.3s of road at top speed — while preserving the exact
// crater spacing, and with it the guaranteed lane the design has always
// claimed. The pattern the player learns: jump the leading three-crater
// cluster, land in the wide lane, then jump the trailing pair.
const BOMB_OFFSETS = [340, 390, 440, 560, 610];

const AIMED_COUNT = 3;
const AIMED_INTERVAL = 0.4;   // seconds between each of the 3 aimed shots
const AIMED_BURST_TAIL = 0.3;
const AIMED_BURST_DURATION = (AIMED_COUNT - 1) * AIMED_INTERVAL + AIMED_BURST_TAIL;
const AIMED_SHOT_SPEED = 160; // px/s — below the buggy's top band (200px/s)

const DIVE_SWEEP_DURATION = 1.2;
// Bottom of the dive. The boss's own body spans DIVE_DIP_Y..DIVE_DIP_Y+15
// (plus BOX_PAD_Y), i.e. 175..196 — which brackets the forward cannon's
// muzzle line (GROUND_Y + buggy.y - 10 == 190 on the ground), so a forward
// shot fired while the boss is at the bottom of its dive connects. On the way
// down and back up the body also crosses y≈147, the muzzle line at a jump
// apex, so a shot fired from the top of a jump connects too. See the
// FIGHT GEOMETRY note above.
const DIVE_DIP_Y = 178;
// A dive only *starts* while the boss is at least this far ahead of the
// buggy, and its x is frozen for the dive's duration — the mothership never
// drops to ground height on top of the player's roof.
const DIVE_MIN_OFFSET = 56;

const HOVER_Y = 70;

// --- FIGHT GEOMETRY (final-review finding C1) --------------------------------
//
// The boss used to be re-pinned to `buggy.worldX + 200` every frame, which
// made it mathematically unhittable:
//   - up-shots had no forward carry, so they climbed at the world column they
//     were fired from while the boss stayed 200px ahead — the gap only ever
//     grew;
//   - forward shots fly at the muzzle line (y≈190 grounded, ≈147 at a jump
//     apex) while the boss's box sat at y 70..90 — never overlapping.
// The fight is now built around two intersecting facts:
//
//  1. weapons.js gives every shot the buggy's forward carry, so an up-shot
//     holds a fixed column *relative to the buggy*: buggy.worldX + BUGGY_W/2
//     (== +16). It climbs 190 -> 70 in ~0.46s.
//  2. The boss no longer holds station. Its offset from the buggy sweeps
//     sinusoidally between SWEEP_CENTER-SWEEP_AMP (-60, just behind the
//     buggy) and SWEEP_CENTER+SWEEP_AMP (+220, near the right edge of the
//     384px viewport) every SWEEP_PERIOD seconds.
//
// The boss's box covers the up-gun column whenever its offset is in
// (-34, +18) — roughly 16% of every sweep, twice per period, and always
// crossed at speed (the window sits mid-sweep, not at a turnaround, so the
// boss never parks in the firing line). That is the anti-air rhythm: the
// mothership swings back over the buggy, you empty the up-gun into it as it
// passes, it swings out ahead again and attacks.
//
// Measured with the hold-cruise / fire-on-cooldown / jump-the-craters bot in
// tests/boss.test.js (4 shots/s, band 1): ~0.7-0.9 hits per second of fight,
// so the 12hp stage-0 boss dies in ~16s losing 0-1 lives, the 24hp stage-2
// boss in ~29s and the 40hp final boss in ~49s without dying. That sits
// inside the review's 30-60s balance guardrail while still being a fight —
// and, unlike the old geometry, it is a fight the player can actually win.
//
// The sweep is a pure function of b.sweepT (accumulated dt) — no RNG at all,
// so the fight is bit-identical for a given input sequence, per the
// project-wide seeded-randomness rule.
const SWEEP_CENTER = 80;   // px ahead of the buggy the sweep is centered on
const SWEEP_AMP = 140;     // px either side of that center
const SWEEP_PERIOD = 4.2;  // seconds for one full out-and-back sweep

// Hitbox. Matches the 48x15 boss1/boss2 sprite exactly (finding I7 — it used
// to be a 32x20 box on a 48x15 sprite, leaving the right third of the drawn
// mothership unhittable and its bottom rows lying about where it could be
// hit), plus a small symmetric forgiveness pad in the player's favor. The pad
// mirrors the ±4px margins already used elsewhere for shot-vs-feature hits.
const BOSS_W = 48;
const BOSS_H = 15;
const BOX_PAD_X = 2;
const BOX_PAD_Y = 3;

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
    // sweepT starts a quarter period in, i.e. at sin()==1 — the boss arrives
    // at the far end of its sweep (offset +220, near the right edge of the
    // viewport) and its first move is inbound toward the buggy.
    sweepT: SWEEP_PERIOD / 4,
    x: game.buggy.worldX + SWEEP_CENTER + SWEEP_AMP,
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

/**
 * The boss's x offset from the buggy at sweep-clock time `t`. Pure function of
 * t: callers use it both for "where is the boss now" and for "where will the
 * boss be when this telegraph finishes" (see diveClearIn below).
 */
export function sweepOffsetAt(t) {
  return SWEEP_CENTER + SWEEP_AMP * Math.sin((2 * Math.PI * t) / SWEEP_PERIOD);
}

/**
 * True when the boss will be far enough ahead of the buggy in `ahead` seconds
 * to begin a dive. The dive freezes the sweep for its whole duration (see
 * updateBoss), so this one look-ahead check at telegraph time is enough to
 * guarantee the whole strafing run happens clear of the buggy.
 */
function diveClearIn(b, ahead) {
  return sweepOffsetAt(b.sweepT + ahead) >= DIVE_MIN_OFFSET;
}

/** The attack enterTelegraph would pick next, without consuming it. */
function peekNextAttack(game, b) {
  const pool = attackPool(game, b);
  return pool[b.attackIndex % pool.length];
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
      if (b.patternT >= HOVER_TIME * speedMult(b)) {
        // A dive waits in hover until the sweep will have carried the boss
        // clear of the buggy by the time the telegraph finishes — it reads as
        // the mothership climbing out ahead before its strafing run, and it
        // guarantees the dive never drops to ground height on the player's
        // roof. Bounded by construction: the sweep is above DIVE_MIN_OFFSET
        // for most of every SWEEP_PERIOD, so the wait is a fraction of one
        // sweep at worst.
        if (peekNextAttack(game, b) === 'diveSweep'
            && !diveClearIn(b, TELEGRAPH_TIME * speedMult(b))) break;
        enterTelegraph(game);
      }
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

/**
 * The boss's collision box: the drawn 48x15 sprite exactly, plus a small
 * symmetric forgiveness pad (finding I7). Exported so tests can assert the
 * box against the sprite's real dimensions rather than re-deriving them.
 */
export function bossBox(b) {
  return {
    x0: b.x - BOX_PAD_X,
    x1: b.x + BOSS_W + BOX_PAD_X,
    y0: b.y - BOX_PAD_Y,
    y1: b.y + BOSS_H + BOX_PAD_Y,
  };
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
    // Ejected forward onto the buggy's path rather than dropped from the
    // wreck (finding I4) — see spawnBossCapsule's docstring for why the
    // literal in-place drop was uncollectable by construction.
    spawnBossCapsule(game, b.y);
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

  // Horizontal sweep (see the FIGHT GEOMETRY note at the top of this file).
  // The sweep clock is held still for the whole of a dive — the boss commits
  // to the column it started the dive from, so the strafing run stays clear of
  // the buggy (it could only have started from DIVE_MIN_OFFSET or further
  // ahead) and the sweep resumes from exactly where it paused, with no
  // teleport at either end of the dive.
  if (b.pattern !== 'diveSweep') b.sweepT += dt;
  b.x = game.buggy.worldX + sweepOffsetAt(b.sweepT);

  advancePattern(game, dt);
  collidePlayerShotsVsBoss(game);
}
