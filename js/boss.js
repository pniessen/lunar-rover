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
//  - maxHp = BASE_HP + stage*HP_PER_STAGE for the four early bosses (E/J/O/T
//    at stage 0/1/2/3 -> 18/24/30/36 hp); the Z course-end boss is a fixed
//    FINAL_HP two-phase fight (stage===4 when entering — the stage index has
//    not yet incremented past the U-Z segment), reaching phase 2 (faster
//    patterns + guaranteed diveSweep) at hp<=FINAL_PHASE2_HP.
//    See the PACING block by those constants for the measured kill times.
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
// Boss bombs are LAUNCHED downward rather than merely released: this initial
// vy (px/s, applied on top of enemies.js's BOMB_GRAVITY = GRAVITY*0.5) cuts
// the 130px fall from hover altitude from ~1.23s to ~0.72s. That is the whole
// readability lever — see the READABILITY block below. Only the boss sets it;
// a bomber UFO's bombs still leave with vy 0 and fall exactly as before.
const BOMB_DROP_VY = 120;

// World-x offsets (from the buggy's position at each bomb's fire time) the
// 5 bombs target. The spacing between them is unchanged since the fix wave —
// index 2 (crater spans +360..+388) to index 3 (+480..+508) is the guaranteed
// safe lane, and it lands as 92px of free road at band 2 / 50px at band 0,
// both driveable (buggy.js tests craters against the buggy's MIDPOINT only).
//
// The offsets are all LEAD, and the lead is what makes the carpet fair
// (final-review fix wave, folded into C1's "keep telegraphs/fairness"). A
// bomb falls for ~0.72s, in which the buggy covers 57px (band 0) to
// 143px (band 2), so every offset has to clear that plus the buggy's own
// 32px body. The original [40, 90, 140, 260, 310] were measured from the
// buggy at DROP time, so by LANDING time the carpet had slid backwards past
// the player: at band 1 the first three craters appeared behind the buggy
// entirely, and at band 2 the fourth materialized at worldX+13..+41 — i.e.
// underneath the buggy's own midpoint, an instant unavoidable death with no
// reaction window at all. (Measured with the fight bot: ~1 death per 2s of
// boss fight at top speed, none of them dodgeable.)
//
// --- READABILITY (this pass) -------------------------------------------------
// The fix wave shifted every offset by +300, which bought the clearance but
// spent it all on lead: the whole carpet was released at screen x 396..720 on
// a 384px viewport, so the near bombs only scrolled into frame ~30% into their
// fall and the far pair was never on screen at all. The player got the 0.6s
// bossTelegraph — the attack was announced, but never *located*.
//
// Halving the fall time buys the same clearance for 100px less lead, so the
// offsets drop back by 80 and the carpet is released at 370..640 instead: at
// band 2 the first bomb is now fully on screen from the frame it leaves the
// mothership, and drawBombMarkers in render.js paints a ground bracket on
// every airborne bomb's impact footprint. Measured at band 2: bomb 0 visible
// 100% of its fall (was 73%), bomb 1 75%, bomb 2 40%, and the reaction window
// on the first crater goes 0.39s -> 0.50s.
//
// The far pair still lands off the right edge at band 2 and this is not a
// tuning failure, it is geometry: the carpet's offset span (270px) plus the
// buggy's body (32px) plus its screen x at top speed (110px) is 412px against
// a 384px viewport, so no fall time and no lead can fit the whole carpet on
// screen without either narrowing the safe lane or cutting the reaction
// window below the 0.39s floor. Those craters land 337/387px ahead (1.7/1.9s
// of road) and scroll into frame ~1.3s before the buggy reaches them.
//
// The pattern the player learns is unchanged: jump the leading three-crater
// cluster, land in the wide lane, then jump the trailing pair.
export const BOMB_OFFSETS = [260, 310, 360, 480, 530];

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
// tests/boss.test.js (4 shots/s, band 1): 0.75-0.81 hp per second of fight.
// That rate is the real pacing constraint — see the PACING block above the hp
// constants for the resulting kill times, which are asserted by the PACING
// tests rather than left as a claim here. (This comment used to assert the
// fight "sits inside the review's 30-60s balance guardrail". It did not: the
// stage-0 boss was an 11-15s fight, and no measurement in the repo ever said
// otherwise. Nothing here is a guardrail — it is a measurement, and if the
// numbers above and the tests ever disagree, believe the tests.)
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

// --- PACING (measured, not intended) ----------------------------------------
//
// Damage throughput is a property of the sweep geometry above, not of these
// numbers: the mothership only crosses the up-gun column for ~16% of each
// 4.2s sweep, which caps a competent player at ~0.75-0.81 hp/s no matter what
// the hp bar says. So hp is the only honest pacing dial, and it is linear in
// stage.
//
// The whole curve was shifted +6hp in the boss-polish pass. The shape is
// unchanged (still +HP_PER_STAGE per stage, still a fixed course-end boss a
// step above stage 3) — the old base of 12 simply put the very first boss the
// player ever meets at ~15s, so the escalation curve started flat and the
// comment right here used to claim a "30-60s guardrail" it did not meet.
//
// Measured end to end through updateGame with the tests/boss.test.js bot
// (cruise band 1, jump-the-craters, not dying), which is what the PACING
// tests in tests/boss.test.js assert +/-25% windows around:
//
//   stage 0  18hp  26.6s   (was 12hp, ~11s before the polish pass)
//   stage 1  24hp  32.1s
//   stage 2  30hp  39.9s
//   stage 3  36hp  49.5s
//   final    46hp  64.5s   — phase 2 engages at half hp, 30.3s + 34.3s
//
// Each of those is a MEDIAN over seven fire cadences (a shot every 12..18
// frames), not a single run, and that is not incidental precision. The bot
// fires on a fixed period against a 4.2s sweep, so a given cadence can lock
// into a resonance where its shots repeatedly arrive at boss altitude just as
// the mothership leaves the up-gun column — cadence 12 turns the stage-2 fight
// into 92s and cadence 16 turns the stage-3 fight into 105s, while their
// neighbours land on 38.5s and 45.1s. Those outliers are a property of a
// metronome, not of the fight; a human's cadence drifts and averages out. A
// single-cadence measurement was measuring the phase alignment, which is why
// this table (and the tests) take the median.
//
// Band 0 tracks band 1 closely; band 2 runs longer on the middle stages
// because the bot spends more of the fight airborne over craters. Those bands
// are not asserted: the bot's fixed 1.0s jump arc makes it a much weaker
// driver than a human at the extremes, so a tight bound there would be
// measuring the bot rather than the fight.
//
// These numbers are unchanged (four of the five bit-identical) by the rolling
// boss arena in state.js, which was the point of checking: sweeping the level
// out of the fight was not supposed to make the fight easier, only to stop it
// being decided by a crater cluster the duel was never designed around. The
// one that moved is stage 2, and only for a bot with no shield: over live
// terrain it died repeatedly at worldX~20696 and took a 109s median to finish
// a 39.9s fight.
const BASE_HP = 18;           // stage-0 boss — the first one the player meets
const HP_PER_STAGE = 6;       // linear escalation across E/J/O/T
export const FINAL_HP = 46;   // the Z course-end boss, a step above stage 3
// The finale's phase-2 threshold is DERIVED from FINAL_HP, not a free number:
// "phase 2 is the second half of the fight" is the design, so the two have to
// move together. They came apart in the polish pass — FINAL_HP went 40 -> 46
// while this stayed at the literal 20 it had been back when 20 *was* half of
// 40 — which silently pushed the transition from 50% of the bar to 43% and
// nothing documented it as intended. Restored, and measured (band 1, the
// tests/boss.test.js bot, median of seven fire cadences):
//
//              phase 1   phase 2   total   split
//   hp<=20      35.5s     28.9s    64.5s   55/45
//   hp<=23      30.3s     34.3s    64.5s   47/53
//
// The total is unchanged — no surprise, since damage throughput is a property
// of the sweep geometry and not of where the phase line sits — so this costs
// nothing and buys back the even split. It reads as 53% by time rather than
// exactly 50% because phase 2's faster patterns put the boss in the air more,
// which is a wash for the up gun but slightly widens the dive rotation.
export const FINAL_PHASE2_HP = Math.floor(FINAL_HP / 2); // == 23
const PHASE2_SPEED_MULT = 0.7; // phase2 shortens hover/telegraph (faster fight)

// --- hp scaling --------------------------------------------------------------

/**
 * startBoss(game) — call once when a stage-break checkpoint (E/J/O/T/Z)
 * diverts the run into the 'boss' phase. Sets up game.boss fresh; does not
 * touch game.phase itself (state.js owns that transition).
 */
export function startBoss(game) {
  const isFinal = game.stage === 4; // only the Z break happens at stage 4
  const maxHp = isFinal ? FINAL_HP : BASE_HP + game.stage * HP_PER_STAGE;
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
    // Launched, not dropped — see BOMB_DROP_VY. enemies.js's moveEnemyShots
    // integrates BOMB_GRAVITY on top of whatever vy a bomb arrives with, so
    // this needs no special case there.
    vy: BOMB_DROP_VY,
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
/**
 * updateBossMotion(game, dt) — ticks ONLY the boss's horizontal sweep
 * (b.sweepT, b.x) during a mid-fight buggy death ('dying'/'respawning' —
 * state.js calls this from both). Deliberately does nothing else: no
 * advancePattern (no telegraph countdown, no bombs/aimed shots/dive), no
 * collidePlayerShotsVsBoss (no damage). The boss must not attack or take
 * damage while the player is dead or blinking in — only its position has to
 * stay honest.
 *
 * Without this, updateBoss was simply never called during those phases, so
 * b.x (pinned to `buggy.worldX + sweepOffsetAt(b.sweepT)` — see the FIGHT
 * GEOMETRY note above) held perfectly still for the whole ~1.9s dying+
 * respawning window, frozen against the buggy's PRE-death worldX — while the
 * buggy itself teleported backward to the respawn point (see state.js's
 * respawn()) and drove forward again. The instant 'boss' resumed and
 * updateBoss ran again, it recomputed b.x against the buggy's NEW worldX and
 * the mothership visibly snapped from its stale, far-away frozen spot to
 * right on top of the respawn point in a single frame.
 *
 * Ticking the same sweep formula here every frame instead means b.x tracks
 * the buggy's actual worldX continuously — frozen while the buggy is (during
 * 'dying', updateBuggy itself doesn't run), then moving again once it does
 * (during 'respawning') — so there is nothing left to snap when 'boss'
 * resumes: the sweep is already exactly where updateBoss would put it.
 */
export function updateBossMotion(game, dt) {
  const b = game.boss;
  if (!b) return;
  if (b.pattern !== 'diveSweep') b.sweepT += dt;
  b.x = game.buggy.worldX + sweepOffsetAt(b.sweepT);
}

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
