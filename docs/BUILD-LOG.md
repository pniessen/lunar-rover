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
- **Key constants:** 384×240 buffer, HUD top 36px, `GROUND_Y=200`, `DT=1/60`, `SPEED_BANDS=[80,140,200]` (+`game.speedBonus` for endless ramp, never mutate the array), `CHECKPOINT_SPACING=1200`, `STAGE_BREAKS=[4,9,14,19,25]`, fwd-gun limit 1 (3 rapid) / up-gun 4, extra lives at 10k/30k/50k.

## Testing conventions

- Run with `node --test tests/*.test.js` — the bare `node --test tests/` form misbehaves on this machine's Node v26. 194 tests, all green as of `37ed6b8`.
- Terrain test doubles: any collision consumer honors `terrain.mode === 'test'` with a bare `features` array.
- **The load-bearing lesson of this project:** hand-placed projectiles test collision predicates, not gameplay. Any claim that "X can be shot/reached/collected" needs a **real-path reachability test** — a bot that only calls `input.pressed()` driving `updateGame` end to end. Patterns to copy: `playerBot`/`fightWithBot` in `tests/boss.test.js` (~line 1146) and the REACHABILITY tests at the end of `tests/enemies.test.js` (seeded first waves: seed 5 → aimer pair, seed 6 → swooper formation; mutation-verified against removing the up-shot speed carry).
- Reviewers on this project reproduced bugs empirically (worktree checkouts of pre-fix commits, standalone repro scripts) rather than trusting reports — keep that bar.

## Open threads / known issues (adjudicated non-blocking)

1. **Music has never been heard by human ears** — verified structurally (frequencies, scheduling, envelopes) only. Wants a listen; the walking bassline should "strut" (112 BPM A-minor walk, staccato ~55% gate).
2. **Stage-0 boss dies fast** (~11–17s) vs the 30–60s intent; comments in `js/boss.js` (~line 132) still falsely cite a "30-60s guardrail". Later bosses hit the target. Either accept + fix comments, or bump stage-0 hp.
3. **Boss bomb carpet falls entirely off-screen** (drops at screen x 396–720; craters appear with ~0.39s reaction at top speed). Consciously accepted — telegraph still announces it — but a "bombs visible while falling" pass would help readability.
4. **Cosmetics:** boss clips ~4px off-canvas at band-0 sweep extreme; particles/shake animate during pause; boss freezes mid-air during death then snaps on resume; `hud.js` `hudTime += DT` per draw couples blink rate to refresh rate; per-frame `loadScores()` JSON.parse.
5. **Code-quality deferred:** score literals in `weapons.js`/`enemies.js` not sourced from `SCORES`; `TANK_W` duplicated in `state.js`; `scoreEvents` grows unbounded within a run; unused `astronaut` sprite; dead `minOffset` conditional in `terrain.js`.
6. **Never verified on a real touch device** — touch logic is code-reviewed + viewport-tested only.

## Ideas that came up but were never scoped

Gamepad support (spec listed it as optional), per-type capsule art, pickup forgiveness margin (~±4px like shot hitboxes), a visible "bombs incoming" indicator, endless-mode chime past 3000m.

## Session/process facts a future session might need

- Task briefs, reviews, and the progress ledger lived in `.superpowers/sdd/2026-08-01-lunar-rover-retro-mod/` (gitignored scratch) — **deleted after merge**; this document and git history are the record now.
- Project memory (auto-loaded each session) is at `~/.claude/projects/-Users-pniessen-Documents-Claude-Projects-lunar-rover/memory/` — `lunar-rover-v1-status.md` mirrors the open-issues list above; update both together.
- Dev server: `.claude/launch.json` (`npx http-server`, auto-picks a port if 8420 is busy). The in-app preview throttles `requestAnimationFrame` when hidden — reviewers verified live gameplay by driving the loop via console `setTimeout`; screenshots work fine either way.
- Deploy is automatic: any push to `main` republishes GitHub Pages within a minute or two. No workflow file exists or is needed.
