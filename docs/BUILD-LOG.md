# Lunar Rover — Build Log & Session Handoff

**Written 2026-08-02.** This document is the durable record of how this project was built, its architecture invariants, testing conventions, and open threads. Read this first in any future session before making changes.

## What this is

A retro-mod remake of **Moon Patrol** (Irem, 1982) in vanilla JavaScript — faithful 1982 core loop plus a mod layer (power-ups, bosses, combo multiplier, endless mode). Zero dependencies, zero build step, no binary assets: all sprites are pixel maps in code, all audio is WebAudio synthesis.

- **Live:** https://pniessen.github.io/lunar-rover/ (GitHub Pages, served straight from `main`'s root — "legacy" build type, no deploy workflow needed because all asset paths are relative)
- **Repo:** https://github.com/pniessen/lunar-rover (public)
- **Sibling project:** https://github.com/pniessen/lunar-lander (separate game; that one *did* need a base-path fix + Pages deploy workflow — don't copy its deploy setup here)
- **Spec:** [docs/superpowers/specs/2026-08-01-lunar-rover-retro-mod-design.md](superpowers/specs/2026-08-01-lunar-rover-retro-mod-design.md) — source of truth for gameplay values
- **Plan:** [docs/superpowers/plans/2026-08-01-lunar-rover-retro-mod.md](superpowers/plans/2026-08-01-lunar-rover-retro-mod.md) — the 14-task implementation plan the build followed

## How it was built (process record)

Single session, 2026-08-01 → 2026-08-02, via **subagent-driven development**: one fresh implementer subagent per plan task, an independent reviewer subagent gating every task, scoped re-reviews after each fix round, and a whole-branch final review before merge. Research on the original arcade game (mechanics, scoring, checkpoint structure, M52 hardware details) ran in a parallel agent during design; its findings are baked into the spec.

Task order and outcomes (24 commits `d8a8e0d..4bd6f68` on the since-deleted `feature/retro-mod` branch, fast-forwarded into `main`):

| # | Task | Fix rounds | What the reviewer caught |
|---|------|-----------|--------------------------|
| 1 | Scaffold, fixed-timestep loop, unified input | 0 | — |
| 2 | Seeded RNG + classic/endless terrain | 0 | Plan self-contradiction (bomb-crater guard vs its own test) — parked with ruling |
| 3 | Buggy physics, speed-scaled jumps, collision | 0 | — |
| 4 | Sprites, parallax renderer, phase machine (first playable) | 0 | — |
| 5 | Dual-fire weapons | 1 | Arity-sniffing signature shim (orchestrator-induced conflict); removed, fire trigger moved to state.js call site |
| 6 | Enemies (swooper/aimer/bomber/tank/chaser) | 1 | Tanks weren't lethal on contact (spec says they are); bomber low-flight rule was dead code |
| 7 | Scoring, checkpoints, stage bonuses, high scores | 1 | Stale entities survived the champion-course rollover and killed the player on lap 2 (reviewer reproduced live) |
| 8 | Bitmap-font HUD, warning lights, A–Z bar | 0 | — |
| 9 | WebAudio chiptune + SFX | 1 | Scheduler catch-up burst after tab throttling (385 stale nodes); prototype-unsafe event dispatch (`['constructor']` froze the loop) |
| 10 | Combo multiplier | 1 | Multi-tick frames double-counted near-miss events; posthumous kills built combo after death |
| 11 | Power-up capsules + hover | 0 | — |
| 12 | Stage-break bosses | 1 | Same-frame boss-death/buggy-death race left a dead buggy frozen through the stage-clear fanfare |
| 13 | Endless mode + mode select | 1 | Unbounded `game.stage` reverted the palette to stage 0 after ~6 minutes of endless play |
| 14 | Particles, shake, hit-stop, CRT, initials entry, touch | 1 | Boss-kill hit-stop was wiped by `setPhase()` before it ever ran |

**Final whole-branch review verdict: NOT MERGEABLE** — it found the single biggest bug of the project, which all 14 task-scoped reviews structurally missed:

> **The boss was mathematically unhittable.** Three compounding causes: (1) `fireDual` was phase-gated to `playing`/`respawning`, so the fire button did nothing during `'boss'`; (2) the boss re-pinned its x to `buggy.worldX + 200` every frame while up-shots had `vx=0` in world space, so shots could never reach its column; (3) forward shots flew at y≈190 vs a hitbox at y 70–90. The unit tests "proved" hits by hand-placing shots inside the hitbox — reachability from the player's gun was never tested. Classic mode ended at checkpoint E; endless at 90 seconds.

The fix wave (`ef1f38e`, `4bd6f68`) redesigned the fight: deterministic sweep (`sweepOffsetAt` in `js/boss.js`, offset −60..+220 crossing the up-gun column), up-shots now carry `game.speed` (arcade screen-column behavior, applied at move time in `moveShots`), `'boss'` added to `FIRE_PHASES`, hitbox centered on the real 48×15 sprite, defensive null-boss exit, boss capsule ejected forward and collectable during `boss`/`stageClear`, plus P pause / R restart / N music / B sfx keys. Re-review measured kill times independently (stage-0 ~11–17s, final 49s + 38s phase 2) and returned CLEAN.

**Post-merge same day:** pushed to GitHub, enabled Pages, and a spun-off session fixed the last residual — **aimer UFOs were also unkillable** (same geometry class): commit `394461e` gives aimers a staggered cosine patrol drift (`aimerPatrolOffset`, 6s/7.5s periods) across the up-gun column, with two mutation-verified real-path reachability tests. Suite now **194 tests**.

## Architecture invariants (do not break these)

- **Pure/presentation split.** `state.js`, `terrain.js`, `buggy.js`, `enemies.js`, `boss.js`, `combo.js`, `score.js`, `powerups.js`, `weapons.js`, `rng.js`, `particles.js` are DOM/canvas/audio-free and Node-testable. Presentation: `main.js`, `input.js`, `render.js`, `sprites.js`, `hud.js`, `audio.js`, plus `index.html`/`css`.
- **Two one-way signal channels.** `game.events` = strings for **audio** (cleared once per rendered frame in `main.js`, which then calls `notifyGameEventsCleared(game)` for combo's cursor). `game.fx` = positioned `{kind,x,y}` records for **visuals** (consumed+cleared by the renderer). Never merge them; never clear them anywhere else.
- **Entropy boundary.** `Date.now`/`Math.random` live only in presentation (`main.js` passes seeds in; `audio.js` noise buffers; the particle pool has its own seeded mulberry32). Pure modules use `game.waveRng` / seeded `mulberry32` only. This is what makes the sim deterministic and brute-force-testable.
- **Scoring choke point.** All points flow through `award(game, base, tag)` in `js/score.js` (combo multiplier applied there; tag `'stageBonus'` exempt). Don't add side-channel `game.score +=`.
- **Combo cursors.** `combo.js` uses non-destructive cursors over `scoreEvents`/`events` plus `syncComboCursors` at every frozen-phase→active transition. If you add a phase or transition, audit cursor sync — two shipped bugs lived exactly here.
- **Phase machine** (`state.js`): `attract → playing ⇄ (dying → respawning) / boss / stageClear / enterScore → gameOver`. Rules learned the hard way: buggy death takes priority over same-frame boss death (`bossStageClearCheckpoint` stash defers the bonus); `setPhase()` zeroes `game.freeze`, so hit-stop that must survive a transition is applied *after* the transition; `enterBoss` clears enemies/enemyShots; course rollover clears all entity arrays + `waveTimer` (set to `undefined`, not 0 — spawnDirector lazily reseeds on `undefined`).
- **The boss arena is a rolling clear, not a zone.** While `game.boss` is non-null, `maintainBossArena` (state.js, called from `updateDrive` and from both boss-entry paths) generates and then sweeps `BOSS_ARENA_AHEAD` = 800px of road ahead of the buggy every frame, via `terrain.js`'s `clearNaturalZone`. It follows the buggy so a long or death-extended fight cannot outrun it, and it **spares `bombCrater`** — the boss's carpet lands 260–530px ahead, inside the window, so a type-blind sweep would delete the boss's entire ground attack. It stops the frame the boss dies. See the "Rolling boss arena" section below.
- **Key constants:** 384×240 buffer, HUD top 36px, `GROUND_Y=200`, `DT=1/60`, `SPEED_BANDS=[80,140,200]` (+`game.speedBonus` for endless ramp, never mutate the array), `CHECKPOINT_SPACING=1200`, `STAGE_BREAKS=[4,9,14,19,25]`, `BOSS_ARENA_AHEAD=800`, fwd-gun limit 1 (3 rapid) / up-gun 4, extra lives at 10k/30k/50k.

## Testing conventions

- Run with `node --test tests/*.test.js` — the bare `node --test tests/` form misbehaves on this machine's Node v26. 251 tests, all green.
- Terrain test doubles: any collision consumer honors `terrain.mode === 'test'` with a bare `features` array.
- **The load-bearing lesson of this project:** hand-placed projectiles test collision predicates, not gameplay. Any claim that "X can be shot/reached/collected" needs a **real-path reachability test** — a bot that only calls `input.pressed()` driving `updateGame` end to end. Patterns to copy: `playerBot`/`fightWithBot` in `tests/boss.test.js` (~line 1146) and the REACHABILITY tests at the end of `tests/enemies.test.js` (seeded first waves: seed 5 → aimer pair, seed 6 → swooper formation; mutation-verified against removing the up-shot speed carry).
- Reviewers on this project reproduced bugs empirically (worktree checkouts of pre-fix commits, standalone repro scripts) rather than trusting reports — keep that bar.

## Open threads / known issues (adjudicated non-blocking)

1. **Music has never been heard by human ears** — verified structurally (frequencies, scheduling, envelopes) only. Wants a listen; the walking bassline should "strut" (112 BPM A-minor walk, staccato ~55% gate).
2. ~~Stage-0 boss dies fast / false "30-60s guardrail" comment~~ — **fixed in the boss-polish pass** (see below).
3. ~~Boss bomb carpet falls entirely off-screen~~ — **fixed in the boss-polish pass** (see below).
4. ~~Cosmetics: boss clips ~4px off-canvas at band-0 sweep extreme; particles/shake animate during pause; boss freezes mid-air during death then snaps on resume; `hud.js` `hudTime += DT` per draw couples blink rate to refresh rate~~ — **fixed in the cosmetic-polish pass** (see below). Remaining cosmetic item: per-frame `loadScores()` JSON.parse.
5. ~~Code-quality deferred: score literals in `weapons.js`/`enemies.js` not sourced from `SCORES`; `TANK_W` duplicated in `state.js`; unused `astronaut` sprite; dead `minOffset` conditional in `terrain.js`; hardcoded `BOMB_MARK_W`/unexported `BOSS_W`; mine/boss-telegraph/bomb-marker flash still animated during pause; no `.gitignore`~~ — **fixed in the code-quality pass** (see below), except `scoreEvents` unbounded growth, deliberately left — see that section.
6. ~~**Never verified on a real touch device** — touch logic is code-reviewed + viewport-tested only.~~ — this hid a **dead-on-arrival bug**: the controls could never appear at all. Fixed in the touch-controls pass (see below). Still not exercised on physical hardware, but now covered by unit tests plus a headless-Chromium touch-emulation harness.
7. **Watch item — one unreproduced flaky test.** `ROLLING ARENA: bomb craters survive...` failed exactly once, mid-session, during the cosmetic-polish pass, and never again: ~185 subsequent attempts (isolated loops + full-suite runs, across both the live tree and a pristine `git worktree` pinned to the commit) all passed. Ruled out by direct inspection: module-level mutable state, wall-clock time, unseeded randomness — the whole path is seeded and per-`game`/per-`terrain`. Unconfirmed hypothesis: the crater-pass check (`mid < rec.x + 28`) and `sweepOffsetAt`'s `Math.sin` are float-boundary-sensitive over long accumulated `+= dt` sequences, and V8 JIT tier-up for `Math.sin` can shift ULP-level results depending on call history — which would be execution-order dependent and fits a once-ever flake. **This test guards a load-bearing invariant** (if bomb craters get swept, the boss's entire attack is erased), so if it ever fails again, treat it as real and chase the float boundary rather than re-running until green.
8. **`tankJump` scoring may be unreachable** (`js/state.js`, `SCORES.tankJump = 100`). Surfaced by the code-quality review: jump hang time is fixed at ~1.0s (`JUMP_VY=-170`, `GRAVITY=340`) while a tank moves at `0.8 × game.speed`, so relative closing distance during a jump tops out near 40px against the ~52px (`BUGGY_W + ENEMY_W.tank`) needed to clear one — meaning it likely requires a hover power-up. Untested and possibly dead reward code. **Same class as the two unreachability bugs already fixed** (the unhittable boss, the unkillable aimers): a reward the geometry never lets you earn. Verify with a real-path test before deciding whether to retune or delete.

## Boss-polish pass (2026-08-02, post-v1)

A follow-up pass on the stage-break fight closing open issues 2 and 3 above. Everything below was **measured by instrumenting real fights through `updateGame`**, never derived from the constants — the whole point of the pre-v1 disaster was that reading the offsets could not have found the bug.

- **Bomb carpet is now visible.** Boss bombs are *launched* downward (`BOMB_DROP_VY = 120` on top of `enemies.js`'s `BOMB_GRAVITY`), cutting the 130px fall from ~1.23s to ~0.72s. Half the fall time buys the same crater-clearance for 100px less lead, so `BOMB_OFFSETS` came back from `[340…610]` to `[260…530]`. At band 2 the leading bomb is now released at screen x 370 (was 450) and is on screen for **100% of its fall** (was 73%); reaction on the first crater went **0.39s → 0.50s**. `render.js`'s new `drawBombMarkers` paints a red ground bracket on every airborne bomb's 28px crater footprint.
- **Crater layout is byte-identical.** Only the *lead* changed, not the spacing, so world-space free gaps are unchanged at every band: 49/50/120/50 (band 0), 69/71/141/71 (band 1), 89/92/162/92 (band 2). The `>=92px` safe lane survives.
- **The far pair of a 5-bomb carpet still lands off the right edge at band 2, and always will.** Carpet offset span (270px) + buggy body (32) + buggy screen x at top speed (110) = 412px against a 384px viewport. No fall time or lead can fit it without narrowing the lane or breaking the 0.39s reaction floor. Those craters land 337/387px ahead and scroll into frame ~1.3s before the buggy reaches them.
- **Incidental endless-mode fix.** At the `speedBonus` cap (260px/s) the old 1.23s fall ate 321 of the 340px lead and put the first crater 19px ahead — *inside* the buggy's 0..32 body box. The same bug the pre-v1 fix wave killed in classic was still live in endless. Now +73px. Guarded by a test.
- **Pacing retune.** The whole hp curve shifted **+6hp** — shape untouched (`BASE_HP + stage*HP_PER_STAGE`, 18/24/30/36, `FINAL_HP` 46). Damage throughput is a property of the sweep geometry (~0.75–0.81 hp/s), not of hp, so hp is the only honest dial. Measured band-1 kill times at the time: 22.6 / 30.9 / 38.9 / 48.3 / 63.4s (was 11.2 / 18.4 / 28.9 / 38.5 / 48.3s). *Superseded numbers* — those were single-cadence measurements; see the rolling-arena section below for the seven-cadence medians (26.6 / 32.1 / 39.9 / 49.5 / 64.5s) that replaced them.
- **Testing.** 194 → 201 tests. The toothless `seconds < 60` pacing assertion is replaced by PACING tests asserting ±25% windows around the measured numbers plus a monotonic-escalation check; four new BOMB CARPET tests trace real fights at all three bands (no crater in the body span, endless speed cap, gap floors, and per-band visibility/reaction floors). All new tests mutation-verified against reverting each constant.
- ~~**Harness caveat for future sessions:** `playerBot` cannot solve one terrain cluster at worldX≈20696~~ — that cluster is no longer in the fight at all; see the rolling arena below.

## Rolling boss arena (2026-08-02, post-v1)

The problem the polish pass above created and did not notice: `enterBoss` carved a fixed **1600px** arena at the break line so the fight would be the spec's "fair dodge-and-shoot duel", but 1600px is 8–11 seconds of driving and the retuned fights run **26–65s**. So 80%+ of every fight happened over live craters, rocks and mines — the player dodged the level on top of the boss's bombs, and the arena was a fair duel for its first eight seconds. The legible symptom was the harness caveat above: the unshielded bot died repeatedly at worldX≈20696 during the stage-2 fight, and the PACING tests had to wrap it in `shieldEveryFrame` to measure anything at all.

- **The arena now follows the buggy.** `maintainBossArena(game)` in `state.js`: while `game.boss` is non-null, `ensureGenerated` then `clearNaturalZone` over `[buggy.worldX, +BOSS_ARENA_AHEAD)` every frame. A window anchored on the buggy cannot be outrun by a long fight, a slow fight, or a fight extended by three deaths — which is exactly what any fixed constant is a guess about. Gated on `game.boss` (not the phase) so it keeps running through a mid-fight `dying`/`respawning` cycle, and stops the instant the boss dies.
- **`clearZone` became `clearNaturalZone`, and the type filter is the load-bearing part.** The sweep runs 800px ahead; `BOMB_OFFSETS` lands the carpet 260–530px ahead. A type-blind clear deletes each bomb crater a frame or two after it opens — the fight still runs, still looks right, and has no ground hazard at all. `NATURAL_TYPES` (crater/bigCrater/doubleCrater/rock/bigRock/mine) is swept; `bombCrater` never is. **Measured:** across 15 classic fights (5 stages × 3 bands) and 18 endless fights, **0** natural features were ever on screen or under the wheels during `'boss'`, while 13–49 bomb craters opened per fight and **100%** of the ones the buggy reached were still there when it got there. Every unshielded-bot death in the arena is now a bombCrater.
- **800px, not bigger.** It covers the carpet's furthest crater (+558) plus margin, and comfortably covers the ~274px of road the 384px viewport shows ahead at top speed. Bigger costs dead road, because the sweep stops when the boss dies and whatever is still swept is empty road the player coasts through afterwards.
- **Endless was the real test.** Classic's Z fight starts at worldX 30000 and `buildClassicCourse` only lays 31200px, so most of the finale runs past the end of the world and there was never anything there to clear. Endless generates chunks on demand forever, so every metre of a 59–64s endless finale is over terrain born *during* the fight. Measured there: the nearest natural feature ahead of the buggy sat at **796–798px** for the entire fight, at every band, and never once entered the viewport.
- **Pacing is unchanged — that was the point of checking.** Sweeping the level out of the fight was not supposed to make the fight easier. Band-1 medians, before → after: 26.6→26.6 / 32.1→32.1 / 39.9 / 49.5→49.5 / 64.5→64.5s. The only one that moved is stage 2, and only for a bot with no shield: over live terrain the unshielded median was **109s** for a 39.9s fight.
- **PACING now measures a median over seven fire cadences.** The bot fires on a fixed frame period against a 4.2s sweep, so a cadence can lock into a resonance where its shots keep arriving at boss altitude just after the mothership leaves the up-gun column — cadence 12 turns stage 2 into 92s, cadence 16 turns stage 3 into 105s, and *which* cadences are unlucky moves whenever anything perturbs the bot's timing, including changes with no effect on the fight. Single-cadence-15 stage 2 read 38.9s → 78.4s across this change; the seven-cadence median read 39.9s → 39.9s. **`shieldEveryFrame` is gone from the PACING path**: the unshielded bot now takes zero deaths across all 35 measurement fights at band 1. It is still used by `traceCarpet` and the arena traces, which pin bands 0 and 2 where the bot genuinely cannot drive the boss's own carpet.
  - **Caveat found in review: the median-of-seven is not robust to its own window.** Widening the sampled range from cadences 12–18 to 12–20 flips stage 2's median from 39.9s to ~78s, because cadence 19 is a cliff (38.5s → 138.5s in one frame-period step). The chosen window happens to sit on the safe side of that cliff at every stage. The resonance is also *pre-existing*, not introduced by the arena change — the same peaks reproduce at the same cadences on the pre-change commit. **Report these figures as "kill time under a specific synthetic-cadence model," never as a physical constant.** A real player's fire timing isn't periodic, so no fixed-period bot is fully representative; human play is the better instrument for pacing feel.
- **`FINAL_PHASE2_HP` is now derived,** `Math.floor(FINAL_HP / 2)` == 23. It had been left at the literal 20 when `FINAL_HP` went 40→46, quietly moving the finale's phase-2 line from 50% of the bar to 43%. Measured (median of seven cadences): phase 1 35.5s + phase 2 28.9s = 64.5s before, **30.3s + 34.3s = 64.5s** after. The total is unchanged — throughput is a property of the sweep geometry, not of where the phase line sits — so restoring the split costs nothing.
- **Respawn safety re-measured, not assumed.** A rolling clear anchored on the buggy has to survive the buggy moving *backwards*: respawn drops it at the last checkpoint line (classic) or 1200px boundary (endless), behind everything the sweep has done. It holds because features are removed outright and never regenerate — a consequence of two designs meeting, not something either states. Across 63 forced mid-fight respawns (both modes, all three bands): **0** landed on a hazard, and the closest hazard ever ahead of a respawn point was +98px.
- **Testing.** 201 → 209 tests. Six new ROLLING ARENA tests (natural terrain never seen/hit at every band; bomb craters survive and are still what kills you; endless chunks swept as they generate; a full-length finale keeps clear road; the sweep *stops* with the boss so the level comes back; respawn safety), plus a finale phase-split PACING test. Mutation-verified against: removing the per-frame sweep, making the clear type-blind, removing the `game.boss` gate, and reverting `FINAL_PHASE2_HP` to 20.

## Cosmetic-polish pass (2026-08-02, post-v1)

A presentation-only sweep closing open issue 4 above. No gameplay constants
(hp/BOMB_OFFSETS/sweep geometry) or arena-clearing logic changed — every fix
either draws differently or ticks presentation-only state, and the
pure/presentation split (state.js/boss.js stay Node-testable, DOM-free) held
throughout.

- **Boss no longer clips off-canvas.** At speed band 0 the sweep's left
  extreme (offset −60) put the 48px mothership at screen x −4..44 — 4px of
  its left edge drawn off the 384px buffer. Fixed on the drawing side only:
  `render.js` exports a pure `clampSpriteScreenX(sx, spriteW)` that clamps
  the boss's *screen* x into `[0, VIEW_W - spriteW]` right before `drawImage`.
  `boss.js`'s world-space sweep (`SWEEP_CENTER`/`SWEEP_AMP`/`sweepOffsetAt`)
  and the boss's collision box are completely untouched, so the up-gun
  overlap window the pre-v1 fix wave depends on cannot have moved — there
  was nothing gameplay-visible to re-prove.
- **Particles and screen shake now freeze while paused.** `main.js`'s loop
  was passing `steps * DT` into `render()` even while `game.paused` — `steps`
  keeps counting fixed-timestep iterations that `updateGame` itself no-ops
  on, so the effect layer kept aging through a pause the simulation was
  correctly frozen for. Now `render(renderer, game, acc / DT, game.paused ? 0
  : steps * DT)`. Two related snags found and fixed along the way: (1) even
  at `simDt=0`, the shake block was re-rolling `shakeX`/`shakeY` from the
  particle pool's PRNG every call regardless of decay — an in-progress shake
  would keep twitching in a random direction for as long as the game stayed
  paused; now gated on `simDt > 0`. (2) `render()`'s buggy-position
  extrapolation (`step = moving ? DT * alpha : 0`) didn't check
  `game.paused`, so `alpha`'s normal frame-to-frame jitter (harmless while
  actually moving) very slightly panned the camera every paused frame; `moving`
  now requires `!game.paused` too.
- **Boss motion now ticks through a mid-fight death instead of freezing then
  snapping.** `updateBoss` never ran during `'dying'`/`'respawning'`
  (correctly — it must not fire/damage/advance pattern while the player is
  dead), so `game.boss.x` (pinned to `buggy.worldX + sweepOffsetAt(sweepT)`)
  held still against the buggy's *pre-death* worldX for the whole ~1.9s
  window, while the buggy itself teleported to the respawn point and drove
  forward again — then snapped to the correct position the instant `'boss'`
  resumed. New `updateBossMotion(game, dt)` in `boss.js` ticks only
  `sweepT`/`x` (no pattern advance, no firing, no `collidePlayerShotsVsBoss`)
  and is called from both `state.js` phases. One subtlety: it has to run
  *after* the `respawn()` call in the `'dying'` case, not before — `respawn()`
  teleports `buggy.worldX` mid-frame on the exact frame the window ends, and
  computing `b.x` against the pre-teleport value (tried first) left exactly
  one frame where the boss was correct for a `worldX` that had already been
  overwritten, a same-frame miniature of the bug this exists to fix. A test
  in `tests/boss.test.js` asserts `boss.x - buggy.worldX ==
  sweepOffsetAt(sweepT)` on every single sampled frame across a forced
  death/respawn cycle — a stronger claim than "eventually consistent" — and
  caught the ordering bug the first time it was written.
- **HUD blink/combo-flash now threaded on the real sim delta, same fix as
  particles/shake.** `hud.js` was doing `hudTime += DT` (and `comboFlash -=
  DT`) once per `drawHUD()` call, i.e. once per *rendered* frame, coupling
  both animations to display refresh rate rather than sim time. `drawHUD`
  now takes a `simDt` parameter (defaults to `DT`) and `render.js` threads
  its own `simDt` straight through, exactly mirroring `consumeFx`. Since
  `main.js` now also zeroes `simDt` while paused (the fix above), the blink
  freezes on the exact frame the game is paused rather than continuing to
  animate — chosen deliberately as the more correct-feeling default, not
  left as an oversight.
- **Testing.** 209 → 223 tests. New `tests/render.test.js` (pure
  `clampSpriteScreenX` cases, a full-sweep-period/all-bands on-screen
  invariant, and `consumeFx(simDt=0)` particle/shake-freeze assertions —
  `consumeFx` was exported specifically because it's pure computation over
  plain objects, no canvas needed) and `tests/hud.test.js` (a same-total-
  elapsed-time-via-different-call-counts regression test for the blink
  coupling, using a cache-busted dynamic `import()` per test to get a fresh
  copy of `hud.js`'s module-level timer state). `tests/boss.test.js` gained
  four `updateBossMotion` tests (ticks the sweep; fires/damages/advances
  nothing; freezes during a dive same as `updateBoss`; the per-frame formula
  invariant above). All new tests mutation-verified against reverting each
  fix.

## Code-quality pass (2026-08-02, post-v1)

A hygiene-only sweep closing item 5 above. Every change is a refactor or
docs/test fix — no gameplay constant, scoring value, or arena-clearing logic
was touched, and the whole point of the exercise was proving that in each
case rather than assuming it.

- **Score literals now route through `SCORES`.** `weapons.js`'s `rockShot`
  award and `enemies.js`'s `swooper`/`aimer`/`bomber`/`tankShot`/`formation`
  awards used to hardcode the same numbers `js/score.js`'s `SCORES` table
  already defines. Both files now import `SCORES` and pass `SCORES.<tag>`
  instead of the literal. The chaser kill's randomized `[500, 800, 1000]`
  payout is deliberately untouched — it has no single fixed value, so there
  is nothing in the table to route it through. Verified two ways: the full
  suite (unchanged, 223 green) and a standalone instrumented script driving
  `hitEnemy`/`updateWeapons` directly and asserting every awarded value
  against `SCORES` — same numbers before and after for all five tags.
- **`TANK_W` de-duplicated.** `state.js` redefined a copy (20) of what
  `enemies.js` already tracks internally as `ENEMY_W.tank`. `enemies.js` now
  exports `ENEMY_W`; `state.js` imports it and reads `ENEMY_W.tank` at the one
  call site (`scoreJump`'s tank-jump check), removing the local constant.
  Safe across the existing `state.js`⇄`enemies.js` import cycle by the same
  rule documented at both files' top: the import is only ever dereferenced
  inside a function body, deferred to call time, never at module top level.
- **Dead conditional collapsed in `terrain.js`.** Both `buildSegmentFeatures`
  and `buildChunkFeatures` computed `startOffset = Math.max(300, minOffset)`
  where `minOffset` (200 or 150 depending on segment/chunk index) is always
  less than 300 — so the branch was dead and implied a per-segment safe zone
  that never existed. Both now read `const startOffset = 300;` with a comment
  pointing at the real, constant 300px guarantee that `state.js`'s `respawn()`
  docstring already depends on and cites explicitly.
- **Unused `astronaut` sprite removed** from `js/sprites.js` — grep-confirmed
  zero references anywhere in `js/` or `tests/`; the driver is baked directly
  into `buggyBody` and was never drawn.
- **`BOMB_MARK_W` now imports the real constant.** `render.js` used to
  hardcode `28` with a comment asserting it equals `FEATURE_W.bombCrater`.
  It now imports `FEATURE_W` from `terrain.js` (already importing
  `featuresInRange` from the same module, so no new import cycle) and reads
  `FEATURE_W.bombCrater` directly, so the two values can't drift apart again.
- **`BOSS_W` exported.** `boss.js`'s internal 48px boss-sprite-width constant
  is now `export const BOSS_W`. `tests/render.test.js` used to hardcode a
  local `BOSS_SPRITE_W = 48` mirror with a comment explaining why it couldn't
  import the real thing; it now imports `BOSS_W` directly.
- **Mine flash / boss telegraph flash / bomb-marker blink now freeze during
  pause too — finishing the cosmetic-polish pass's job.** That pass froze
  particles, screen shake, and the HUD blink while paused but missed these
  three, because all three read `r.tick` (render.js's own frame counter)
  rather than sim time, and `r.tick++` ran unconditionally on every rendered
  frame regardless of `game.paused`. Now gated the same way as the `moving`
  flag just below it: `if (!game.paused) r.tick++;`. **This is the one small,
  deliberate behavior change in this pass** (everything else is a pure
  refactor) — verified by driving `render()` directly through a scratch
  harness (not committed) with a mine, an active boss telegraph, and an
  airborne bomb all on screen simultaneously: 90 repeated `render()` calls
  while `game.paused` produced byte-identical canvas pixel hashes and a
  frozen `r.tick`, while the same 90 calls with `paused` cleared changed both
  (tick 0→90, hash changed) — confirming both that the freeze works and that
  the harness would have caught a regression. No console errors either run.
- **`.gitignore` added.** The repo had none; `.superpowers/` (agent scratch —
  task briefs, review diffs) sat untracked where a stray `git add -A` could
  commit it. Ignores `.superpowers/`, `.DS_Store`, and (pre-emptively, since
  none exists yet) `node_modules/`. Does **not** ignore `.claude/launch.json`
  — that file is tracked and wanted.
- **`scoreEvents` unbounded growth — deliberately NOT fixed.** `game.
  scoreEvents` grows for the whole run (~40 bytes/event, not urgent). `combo.
  js` keeps non-destructive index cursors into this exact array
  (`lastSeenScoreEventCount`), and two shipped bugs have already lived in
  that cursor logic (see the Task 10 and Task 12 rows in the task table
  above). Compacting the array safely means atomically rewriting every
  outstanding cursor in the same operation, with tests covering compaction
  mid-combo-streak, across a death, and across a stageClear tally. That's a
  real feature of its own, not a hygiene fix, so it was left alone rather
  than forced — see the comment directly above `award()` in `js/score.js`.
- **Testing.** Suite stays at 223 green (no new tests added — items 1-6 and 9
  are refactors covered by the existing suite plus the instrumented
  before/after checks described above; item 7's fix isn't unit-testable
  without a canvas/DOM shim this zero-dependency project doesn't have, so it
  was verified live in-browser instead, matching how the rest of the
  presentation layer — `main.js`, `sprites.js`'s `rasterize` — is already
  excluded from `node --test` coverage for the same reason).

## Touch-controls pass (2026-08-02, post-v1)

Reported as "the mobile controls don't seem to be working." They weren't —
not intermittently, but in every state, by construction.

- **Root cause: a chicken-and-egg deadlock.** `#touch-ui` was `display: none`
  until `<body>` got the `touch` class, and the *only* code that added that
  class was `markTouchActive()`, called from the `touchstart` handlers bound
  to `#btn-jump`, `#btn-fire`, and `#zone-speed` — all children of `#touch-ui`.
  A `display: none` element is never hit-tested, so those handlers could never
  fire, so the class was never added, so the layer stayed hidden. No touch
  input could ever reach the game.
- **Fix: answer "is this a touch device?" up front** instead of inferring it
  from a touch that cannot happen. `input.js` now calls `markTouchActive()` at
  boot when `navigator.maxTouchPoints > 0 || 'ontouchstart' in window`, so the
  first tap lands on a real button rather than being spent unhiding one. A
  self-removing `window`-level capture-phase `touchstart` listener is the
  belt-and-braces path for devices whose capability flags lie — bound on the
  window precisely because the controls themselves are un-hittable until it
  runs. A mouse-only desktop fails both and correctly gets no overlay.
- **`input.js` is now testable.** It grew an injectable `env` of `{win, doc}`
  (defaulting to the real globals), mirroring the `contextFactory` seam
  `audio.js` already uses for `AudioContext`. It references no other global,
  so those two handles plus a fake `touchRoot` are the whole shim.
- **`tests/input.test.js` — 28 tests, the module's first coverage ever.** That
  gap is why this shipped: `input.js` was the one module with no tests. Covers
  boot-time activation, the window-level fallback and its self-removal, the
  mouse-only negative case, speed-zone halves / held-touch edge suppression /
  midline slides / multi-touch, momentary buttons, sub-frame taps, and
  non-passive registration. Mutation-verified: disabling the reveal paths
  fails 3 tests including the explicitly-named REGRESSION one.
- **Restart button added** (`#btn-restart`, the touch stand-in for `R`). `P`,
  `M`, `N`, `B`, and `C` stay keyboard-only, keeping the on-screen layout
  minimal per the original Task-14 decision. It is small (44px), dimmed, and
  parked in the *top*-right — diagonally opposite the speed zone and clear of
  the bottom thumb row — because an accidental hit wipes a live run.
- **Verified in a real browser**, not just against the fake DOM: a headless
  Chromium harness (scratch, not committed) at 812×375 landscape with
  `hasTouch` asserts the class lands at boot, the overlay is visible, all four
  controls are the topmost element at their own centres, and raw CDP touch
  dispatch drives real held/dragged/two-finger gestures through to the input
  state. 26 checks, all green; the mouse-only context correctly gets nothing.

## Ideas that came up but were never scoped

Gamepad support (spec listed it as optional), per-type capsule art, pickup forgiveness margin (~±4px like shot hitboxes), a visible "bombs incoming" indicator, endless-mode chime past 3000m.

## Session/process facts a future session might need

- Task briefs, reviews, and the progress ledger lived in `.superpowers/sdd/2026-08-01-lunar-rover-retro-mod/` (gitignored scratch) — **deleted after merge**; this document and git history are the record now.
- Project memory (auto-loaded each session) is at `~/.claude/projects/-Users-pniessen-Documents-Claude-Projects-lunar-rover/memory/` — `lunar-rover-v1-status.md` mirrors the open-issues list above; update both together.
- Dev server: `.claude/launch.json` (`npx http-server`, auto-picks a port if 8420 is busy). The in-app preview throttles `requestAnimationFrame` when hidden — reviewers verified live gameplay by driving the loop via console `setTimeout`; screenshots work fine either way.
- Deploy is automatic: any push to `main` republishes GitHub Pages within a minute or two. No workflow file exists or is needed.
