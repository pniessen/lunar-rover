// enemies.js — pure-logic enemy waves: swooper/aimer/bomber UFOs, ground
// tanks, and rear-chasing chase cars. No DOM/canvas/audio imports: this
// module is Node-testable and consumed by the sim layer in state.js.
// Presentation is signaled purely via game.events.push('explosion'|'bombHit'|
// 'chaserDodge'); render.js reads game.enemies / game.enemyShots.
//
// NOTE on the GROUND_Y import below: state.js imports spawnDirector/
// updateEnemies from this module, so this file and state.js form an import
// cycle. That is safe here because GROUND_Y is only ever read inside
// function bodies (deferred to call time, after every module has finished
// loading) — never at this module's top level, the only place a cycle could
// observe an uninitialized (TDZ) binding. Same pattern as weapons.js.
import { GROUND_Y } from './state.js';
import {
  GRAVITY, BUGGY_W, BUGGY_H, killBuggy, buggyHitbox,
} from './buggy.js';
import { featuresInRange, addBombCrater } from './terrain.js';
import { award } from './weapons.js';

// --- tunables --------------------------------------------------------------

const SPAWN_AHEAD = 350;         // world px ahead of the buggy flyers/tanks spawn at
const CHASER_SPAWN_BEHIND = 400; // world px behind the buggy a chaser spawns at
const MINE_WARN_RANGE = 400;     // px ahead of the buggy the mine-warning scans
const CULL_BEHIND = 450;         // px behind the buggy at which entities are culled

const WAVE_MIN = 6;   // seconds, lower bound of the wave-spawn timer
const WAVE_MAX = 10;  // seconds, upper bound of the wave-spawn timer
const WAVE_FLOOR = 3; // seconds, endless-mode difficulty floor

const AIMER_SHOT_INTERVAL = 2;   // seconds between aimer shots
const AIMER_SHOT_CAP = 2;        // max of an aimer's own shots alive at once
const AIMER_SHOT_SPEED = 140;    // px/s

const BOMBER_DROP_INTERVAL = 1.5; // seconds between bomb drops
const BOMBER_DIP_Y = 140;         // low point of the bomber's dip-and-recover altitude cycle
const BOMB_GRAVITY = GRAVITY * 0.5;

const TANK_SHOT_INTERVAL = 2.5; // seconds between tank shots
const TANK_SHOT_SPEED = 160;    // px/s

// Approximate collision footprints, keyed by kind — the enemy shape itself
// carries no width/height field, so collision code uses this lookup instead
// (mirrors each kind's sprite dimensions in sprites.js).
const ENEMY_W = {
  swooper: 16, aimer: 16, bomber: 14, tank: 20, chaser: 14,
};
const ENEMY_H = {
  swooper: 8, aimer: 8, bomber: 10, tank: 14, chaser: 10,
};

// Mirrors buggy.js's (unexported) CRATER_TYPES so a chaser can detect the
// same crater-type features the buggy itself would fall into.
const CRATER_TYPES = new Set(['crater', 'bigCrater', 'doubleCrater', 'bombCrater']);

const FLYER_KINDS = new Set(['swooper', 'aimer', 'bomber']);
const GROUND_KINDS = new Set(['tank', 'chaser']);

// --- id/formation bookkeeping ----------------------------------------------

function nextId(game) {
  game._enemySeq = (game._enemySeq || 0) + 1;
  return game._enemySeq;
}

// --- wave spawning -----------------------------------------------------------

function spawnSwooperFormation(game) {
  const formationId = `f${nextId(game)}`;
  const startX = game.buggy.worldX + SPAWN_AHEAD;
  const baseY = 45 + game.waveRng() * 35; // 45-80
  for (let i = 0; i < 3; i++) {
    const y = baseY + i * 12;
    game.enemies.push({
      id: nextId(game),
      kind: 'swooper',
      x: startX + i * 34,
      y,
      vx: -70,
      vy: 0,
      hp: 1,
      t: 0,
      formationId,
      baseY: y,
    });
  }
}

function spawnAimerPair(game) {
  for (let i = 0; i < 2; i++) {
    const offset = SPAWN_AHEAD + i * 50;
    const y = 55 + i * 15;
    game.enemies.push({
      id: nextId(game),
      kind: 'aimer',
      x: game.buggy.worldX + offset,
      y,
      vx: 0,
      vy: 0,
      hp: 1,
      t: 0,
      hoverOffset: offset,
      baseY: y,
    });
  }
}

function spawnTank(game) {
  game.enemies.push({
    id: nextId(game),
    kind: 'tank',
    x: game.buggy.worldX + SPAWN_AHEAD + 60,
    y: GROUND_Y - ENEMY_H.tank,
    vx: game.speed * 0.8,
    vy: 0,
    hp: 1,
    t: 0,
  });
}

function spawnBomber(game) {
  const offset = SPAWN_AHEAD - 60;
  const y = 60;
  game.enemies.push({
    id: nextId(game),
    kind: 'bomber',
    x: game.buggy.worldX + offset,
    y,
    vx: 0,
    vy: 0,
    hp: 1,
    t: 0,
    hoverOffset: offset,
    baseY: y,
  });
}

function spawnChaser(game) {
  game.enemies.push({
    id: nextId(game),
    kind: 'chaser',
    x: game.buggy.worldX - CHASER_SPAWN_BEHIND,
    y: GROUND_Y - ENEMY_H.chaser,
    vx: game.speed * 1.25,
    vy: 0,
    hp: 1,
    t: 0,
  });
}

function pickInterval(game) {
  let interval = WAVE_MIN + game.waveRng() * (WAVE_MAX - WAVE_MIN);
  if (game.mode === 'endless') {
    // Endless difficulty ramps with elapsed stage time; task 7 owns real
    // stage progression, this module just reads game.stageTime for now.
    const shrink = Math.min(WAVE_MAX - WAVE_FLOOR, game.stageTime / 30);
    interval = Math.max(WAVE_FLOOR, interval - shrink);
  }
  return interval;
}

function spawnWave(game) {
  const pool = [spawnSwooperFormation];
  if (game.stage >= 1) pool.push(spawnAimerPair, spawnTank);
  if (game.stage >= 2) pool.push(spawnBomber);
  if (game.stage >= 3) pool.push(spawnChaser);
  const pick = pool[Math.floor(game.waveRng() * pool.length)];
  pick(game);
}

function computeWarn(game) {
  const air = game.enemies.some((e) => FLYER_KINDS.has(e.kind));
  const rear = game.enemies.some((e) => e.kind === 'chaser');

  const terrain = game.terrain;
  const x0 = game.buggy.worldX;
  const x1 = x0 + MINE_WARN_RANGE;
  const candidates = terrain.mode === 'test' ? terrain.features : featuresInRange(terrain, x0, x1);
  const mine = candidates.some((f) => f.type === 'mine' && !f.destroyed && f.x + f.w > x0 && f.x < x1);

  game.warn = { air, mine, rear };
}

/**
 * spawnDirector(game, dt) — call only while game.phase === 'playing'.
 * Counts down game.waveTimer (lazily seeded on first call) and spawns a
 * wave once it elapses, then also refreshes game.warn every call so the
 * HUD warning lights stay current even between waves.
 */
export function spawnDirector(game, dt) {
  if (game.waveTimer === undefined) game.waveTimer = pickInterval(game);
  game.waveTimer -= dt;
  if (game.waveTimer <= 0) {
    spawnWave(game);
    game.waveTimer += pickInterval(game);
  }
  computeWarn(game);
}

// --- per-kind behavior -------------------------------------------------------

function crossedInterval(t, dt, interval) {
  return Math.floor(t / interval) !== Math.floor((t - dt) / interval);
}

function fireAimedShot(game, e) {
  const b = game.buggy;
  const targetX = b.worldX + BUGGY_W / 2;
  const targetY = GROUND_Y + b.y - 10;
  const dx = targetX - e.x;
  const dy = targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  game.enemyShots.push({
    id: nextId(game),
    kind: 'aimed',
    from: e.id,
    x: e.x,
    y: e.y,
    vx: (dx / dist) * AIMER_SHOT_SPEED,
    vy: (dy / dist) * AIMER_SHOT_SPEED,
  });
}

function fireLevelShot(game, e) {
  game.enemyShots.push({
    id: nextId(game),
    kind: 'level',
    from: e.id,
    x: e.x,
    y: e.y,
    vx: -TANK_SHOT_SPEED,
    vy: 0,
  });
}

function dropBomb(game, e) {
  game.enemyShots.push({
    id: nextId(game),
    kind: 'bomb',
    from: e.id,
    x: game.buggy.worldX + 120,
    y: e.y,
    vx: 0,
    vy: 0,
  });
}

function chaserHitsCrater(game, e) {
  const terrain = game.terrain;
  const w = ENEMY_W.chaser;
  const features = terrain.mode === 'test' ? terrain.features : featuresInRange(terrain, e.x, e.x + w);
  return features.some((f) => !f.destroyed && CRATER_TYPES.has(f.type) && e.x + w > f.x && e.x < f.x + f.w);
}

function updateOneEnemy(game, e, dt) {
  e.t += dt;

  switch (e.kind) {
    case 'swooper': {
      e.x += e.vx * dt;
      const base = e.baseY ?? e.y;
      e.y = base + Math.sin(e.t * 3) * 20;
      break;
    }
    case 'aimer': {
      if (e.hoverOffset != null) e.x = game.buggy.worldX + e.hoverOffset;
      const base = e.baseY ?? e.y;
      e.y = base + Math.sin(e.t * 2) * 5;
      if (crossedInterval(e.t, dt, AIMER_SHOT_INTERVAL)) {
        const ownShots = game.enemyShots.filter((s) => s.from === e.id).length;
        if (ownShots < AIMER_SHOT_CAP) fireAimedShot(game, e);
      }
      break;
    }
    case 'bomber': {
      if (e.hoverOffset != null) e.x = game.buggy.worldX + e.hoverOffset;
      // Dip-and-recover altitude cycle, synced to the bomb-drop cadence:
      // starts each interval at baseY, dips down toward BOMBER_DIP_Y around
      // the midpoint (this is when it's low enough for the forward cannon
      // to reach it), and climbs back to baseY before the next drop.
      const base = e.baseY ?? e.y;
      const frac = (e.t % BOMBER_DROP_INTERVAL) / BOMBER_DROP_INTERVAL;
      e.y = base + (BOMBER_DIP_Y - base) * Math.sin(Math.PI * frac);
      if (crossedInterval(e.t, dt, BOMBER_DROP_INTERVAL)) dropBomb(game, e);
      break;
    }
    case 'tank': {
      e.vx = game.speed * 0.8;
      e.x += e.vx * dt;
      if (crossedInterval(e.t, dt, TANK_SHOT_INTERVAL)) fireLevelShot(game, e);
      break;
    }
    case 'chaser': {
      e.vx = game.speed * 1.25;
      e.x += e.vx * dt;
      if (chaserHitsCrater(game, e)) e.fellIn = true;
      break;
    }
    default:
      break;
  }
}

// --- enemy shots: movement, ground impact ------------------------------------

function moveEnemyShots(game, dt) {
  for (const s of game.enemyShots) {
    if (s.kind === 'bomb') {
      s.vy += BOMB_GRAVITY * dt;
      s.y += s.vy * dt;
    } else {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
  }
}

function resolveBombImpacts(game) {
  const kept = [];
  for (const s of game.enemyShots) {
    if (s.kind === 'bomb' && s.y >= GROUND_Y) {
      addBombCrater(game.terrain, s.x);
      game.events.push('bombHit');
    } else {
      kept.push(s);
    }
  }
  game.enemyShots = kept;
}

// --- collisions --------------------------------------------------------------

function shotOverlapsEnemy(s, e) {
  const w = ENEMY_W[e.kind] ?? 16;
  const h = ENEMY_H[e.kind] ?? 10;
  const sw = s.dir === 'fwd' ? 4 : 2;
  const sh = s.dir === 'fwd' ? 2 : 4;
  return s.x < e.x + w && s.x + sw > e.x && s.y < e.y + h && s.y + sh > e.y;
}

function collidePlayerShotsVsEnemies(game) {
  const kept = [];
  for (const s of game.playerShots) {
    let consumed = false;
    for (const e of game.enemies) {
      const canHit = s.dir === 'up'
        ? FLYER_KINDS.has(e.kind)
        : (GROUND_KINDS.has(e.kind) || (e.kind === 'bomber' && e.y > 120));
      if (!canHit) continue;
      if (shotOverlapsEnemy(s, e)) {
        hitEnemy(game, e);
        consumed = true;
        break;
      }
    }
    if (!consumed) kept.push(s);
  }
  game.playerShots = kept;
}

function buggyBox(buggy) {
  const hb = buggyHitbox(buggy);
  return {
    x0: hb.x0,
    x1: hb.x1,
    y0: GROUND_Y + buggy.y - BUGGY_H - 4,
    y1: GROUND_Y + buggy.y + 4,
  };
}

function pointInBox(p, box) {
  return p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1;
}

function collideEnemiesVsBuggy(game) {
  const b = game.buggy;
  const hb = buggyHitbox(b);
  for (const e of game.enemies) {
    if (e.kind === 'chaser') {
      const w = ENEMY_W.chaser;
      const overlapsX = e.x < hb.x1 && e.x + w > hb.x0;
      if (!overlapsX) continue;
      if (!b.airborne) {
        killBuggy(game, 'chaser');
      } else if (!e.dodged) {
        game.events.push('chaserDodge');
        e.dodged = true;
      }
    } else if (e.kind === 'tank') {
      // Ground obstacle, same ram rule as a chaser: lethal on contact while
      // grounded, cleared for free by jumping over (jump-over scoring is
      // Task 7's concern, not this one — no points are awarded here).
      const w = ENEMY_W.tank;
      const overlapsX = e.x < hb.x1 && e.x + w > hb.x0;
      if (overlapsX && !b.airborne) {
        killBuggy(game, 'tank');
      }
    }
  }
}

function collideEnemyShotsVsBuggy(game) {
  const box = buggyBox(game.buggy);
  const kept = [];
  for (const s of game.enemyShots) {
    if (pointInBox(s, box)) {
      killBuggy(game, s.kind === 'bomb' ? 'bomb' : 'enemyShot');
    } else {
      kept.push(s);
    }
  }
  game.enemyShots = kept;
}

// --- culling -------------------------------------------------------------

function cullEnemies(game) {
  const minX = game.buggy.worldX - CULL_BEHIND;
  game.enemies = game.enemies.filter((e) => {
    if (e.fellIn) return false; // silent removal: no explosion, no score
    return e.x >= minX;
  });
}

function cullEnemyShots(game) {
  const minX = game.buggy.worldX - CULL_BEHIND;
  game.enemyShots = game.enemyShots.filter((s) => s.x >= minX && s.y > -100 && s.y < 500);
}

// --- exported kill path --------------------------------------------------

/**
 * hitEnemy(game, enemy) — the shared kill path for both updateEnemies'
 * player-shot collisions and direct test calls. Applies one hit; at 0 hp it
 * removes the enemy, emits 'explosion', awards score by kind, and — if this
 * was the last living member of its formationId — pays the 1000 formation
 * bonus on top.
 */
export function hitEnemy(game, enemy) {
  enemy.hp -= 1;
  if (enemy.hp > 0) return;

  game.enemies = game.enemies.filter((e) => e !== enemy);
  game.events.push('explosion');

  switch (enemy.kind) {
    case 'swooper':
      award(game, 100, 'swooper');
      break;
    case 'aimer':
      award(game, 100, 'aimer');
      break;
    case 'bomber':
      award(game, 200, 'bomber');
      break;
    case 'tank':
      award(game, 200, 'tankShot');
      break;
    case 'chaser': {
      const pool = [500, 800, 1000];
      award(game, pool[Math.floor(game.waveRng() * pool.length)], 'chaser');
      break;
    }
    default:
      break;
  }

  if (enemy.formationId) {
    const remaining = game.enemies.some((e) => e.formationId === enemy.formationId);
    if (!remaining) award(game, 1000, 'formation');
  }
}

/**
 * updateEnemies(game, dt) — call every frame while 'playing', 'dying', or
 * 'respawning' (enemies keep flying/rolling/shooting through a death, only
 * the buggy-collision checks below are gated to 'playing' — mirroring the
 * `invulnerable` gating updateDrive applies during 'respawning').
 */
export function updateEnemies(game, dt) {
  for (const e of game.enemies) updateOneEnemy(game, e, dt);

  moveEnemyShots(game, dt);

  if (game.phase === 'playing') {
    collideEnemiesVsBuggy(game);
    collideEnemyShotsVsBuggy(game);
  }

  resolveBombImpacts(game);
  collidePlayerShotsVsEnemies(game);

  cullEnemies(game);
  cullEnemyShots(game);
}
