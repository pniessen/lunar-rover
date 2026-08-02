# Lunar Rover: Retro-Mod Moon Patrol — Design Spec

**Date:** 2026-08-01
**Status:** Approved

## Overview

A browser game on a single HTML5 canvas: a faithful recreation of the Moon Patrol (Irem, 1982) core loop — drive, jump, dual-fire, craters/rocks/mines, UFOs, chase cars, A–Z checkpoints — rendered in the original's chunky-pixel style with modern polish (particles, screen shake, subtle CRT scanline overlay, 60fps). Layered on top: power-ups, boss encounters at stage breaks, a combo multiplier, and an endless mode. Keyboard + touch controls, fully synthesized WebAudio chiptune. No build step; deploys as static files.

## Architecture

Vanilla JS, native ES modules, no build tooling. Served as static files (any local HTTP server for dev).

```
lunar-rover/
  index.html          — canvas, touch control DOM, module bootstrap
  css/style.css       — layout, touch buttons, CRT overlay
  js/
    main.js           — boot, game loop (fixed-timestep update, rAF render)
    state.js          — game state machine: attract → playing → dying → respawn → stage-clear → boss → game-over
    input.js          — keyboard + touch + optional gamepad, unified action API
    buggy.js          — player physics: speed bands, jump, wheel bounce, collisions
    terrain.js        — course data (A–Z layouts) + procedural generator (endless), craters/rocks/mines, bomb-crater insertion
    enemies.js        — UFO formations, tanks, chase cars, projectiles
    boss.js           — stage-break boss patterns and health
    powerups.js       — drops, timers, effects (shield, rapid-fire, spread, hover-jump)
    combo.js          — multiplier logic, near-miss detection
    hud.js            — score, checkpoint bar, warning lights, timer, lives
    render.js         — parallax layers, sprite drawing, particles, screen shake, CRT pass
    sprites.js        — pixel-art sprite data (drawn in code onto offscreen canvases)
    audio.js          — WebAudio bassline sequencer + SFX synth
    score.js          — scoring tables, time-vs-par bonus, localStorage high scores
```

- Fixed-timestep simulation (60 Hz) with rendering interpolation.
- Internal low-res pixel buffer (~384×240) scaled up with `image-rendering: pixelated`, letterboxed to the window.
- Modules communicate through a shared `game` context object passed explicitly — no framework, no global event bus.
- Simulation logic (physics, scoring, combo, terrain generation) is kept pure — no canvas/DOM imports — so it is testable in Node.

## Core Gameplay (faithful layer)

Grounded in the research brief (Irem M52 / MAME `mpatrol`, StrategyWiki, Atari 2600 manual, Computer Archeology disassembly).

### Movement
- Constant baseline scroll; three speed bands (slow / cruise / fast) with sluggish, momentum-based acceleration and deceleration.
- The buggy drifts right on screen when accelerating, left when braking. It never stops or reverses.

### Jump
- Fixed impulse, floaty moon gravity, long hang time.
- Horizontal jump distance scales with current speed band (the central skill mechanic).
- No mid-air steering; brief landing-settle period.
- One-hit death (unless shielded): landing in a crater or on a rock/mine, or being hit by any projectile/enemy, destroys the buggy.

### Fire
- One press fires two shots simultaneously: one forward (horizontal), one straight up.
- Forward gun: maximum 1 shot on screen at a time. Vertical gun: up to 4 simultaneous shots.

### Obstacles
- Small craters, large/double craters (require a long, fast jump), rocks (big rocks take 2 hits), land mines (introduced at stage 3, checkpoint J onward; jump or shoot).
- Crater-bomber UFOs blast **new craters into the terrain ahead of the player** — live terrain mutation is a signature mechanic and must be supported by the terrain system.

### Enemies
- Three UFO types: formation swoopers, aimed-shot firers, crater-bombers.
- Ground tanks ahead (shoot with forward gun or jump over).
- Chase cars from behind in later stages (rear warning light; jump to let them pass beneath, or they ram you; destroying one gives a large random bonus).

### Course structure
- Beginner course, then Champion course (harder layouts, doubled time bonuses; loops after completion).
- 26 checkpoints lettered A–Z. Death → respawn at last checkpoint letter reached.
- Major stage breaks at E, J, O, T, Z; each stage has its own background theme/palette.
- Time-vs-par bonus tally at each stage break.

### Scoring
- Crater jump 100, double crater 200, mine jump 50, rock jump 80 / shot 100, tank jump 100 / shot 200, regular UFO 100, crater-bomber UFO 200, chase car 500/800/1000 (random).
- Formation/streak bonuses: 500–1600 for wiping a full UFO formation or consecutive boulders without a miss.
- Stage break bonus: 1,000 + 100 per second under par (doubled on Champion). Course completion: 5,000 + 100/sec under par.
- Extra lives at 10,000, 30,000, 50,000 only. Start with 3 lives.
- Local top-10 high score table with 3-letter initials entry, persisted to localStorage. Separate table for endless mode.

## New Mechanics (mod layer)

### Power-ups
- Destroyed UFO formations occasionally drop a floating capsule; bosses always drop one.
- Four types: **Shield** (absorbs one hit), **Rapid-fire** (forward-gun on-screen limit 1→3, 10 s), **Spread shot** (vertical gun fires 3-way, 10 s), **Hover** (tap jump mid-air for a boost, 15 s).
- One active at a time (picking up a new one replaces the current). HUD shows icon + countdown.

### Combo multiplier
- Kills and near-misses (clearing an obstacle with a tight margin; letting a chase car pass under a jump) build a ×1→×5 multiplier displayed next to the score.
- Resets on death or after ~4 s without a scoring action.
- Applies to all points earned.

### Bosses
- At stage breaks E, J, O, T a UFO mothership descends: health bar, telegraphed attack patterns (bomb carpets that crater the terrain, aimed bursts, dive sweeps), escalating per stage.
- Terrain generation goes crater-light during boss fights (dodge-and-shoot duel).
- Z is a two-phase final boss.
- Bosses drop a guaranteed power-up. Boss kill adds to the stage bonus tally.

### Endless mode
- Selectable from the title screen alongside the classic course.
- Procedurally generated terrain seeded from the classic obstacle patterns; scroll speed and enemy density ramp over time.
- A boss appears roughly every 90 seconds.
- Seeded RNG for reproducibility; separate high-score table.

## Presentation

### Visuals
- Faithful palette: pink/magenta terrain strip, green mountain layers with white caps, black starfield with Earth/planet.
- Three parallax background layers (starfield, far mountains, near mountains) plus the foreground terrain strip; theme/palette changes per stage.
- Six-wheel buggy (three axles) with independently bouncing wheels and visible astronaut driver; constant idle bobbing.
- Modern juice: wheel dust particles, muzzle flashes, chunky explosion particles, screen shake on explosions/boss hits, brief hit-stop on kills.
- CRT overlay: scanlines + slight vignette, toggleable, default on.
- All sprites defined as pixel data in code (`sprites.js`), rasterized to offscreen canvases at boot — no image assets.

### HUD
- Authentic top panel: 1UP score, high score, current checkpoint letter, stage timer, three warning lights (air attack / minefield / rear attack), horizontal A–Z progress bar with position marker, lives as buggy icons.
- Mod additions: combo multiplier readout, active power-up icon + countdown.

### Audio
- WebAudio-synthesized throughout; no audio files.
- Original walking-bassline-style loop (inspired by, not copying, the arcade theme), danger stinger layered when UFOs attack, death jingle, checkpoint fanfare, ticking time-bonus tally, boss theme.
- SFX: engine putter, jump boing, dual-shot pew, noise-burst explosion, mine beep, rear-attack siren, power-up chime.
- Master mute + separate music/SFX toggles, persisted to localStorage.
- AudioContext created/resumed only after first user gesture (browser autoplay policy).

## Controls

- **Keyboard:** ←/→ or A/D = brake/accelerate, Space or ↑/W = jump, X/Z or J/K = fire, P = pause, M = mute, R = instant restart.
- **Touch:** left half of screen = brake/accelerate zones; right side = Jump and Fire buttons. Touch UI rendered only on touch devices. Landscape orientation prompt on phones.
- **Gamepad:** optional, time permitting (standard mapping: stick/d-pad speed, A jump, X fire).

## Error Handling

- localStorage access wrapped in try/catch (private browsing).
- Canvas and layout re-computed on resize/orientation change.
- Audio init gated behind first user gesture; game runs fine if AudioContext is unavailable.
- Deterministic simulation (fixed timestep, seeded RNG in endless mode) keeps behavior reproducible for debugging.

## Testing

- Pure-logic modules (buggy physics, collision, scoring, combo, terrain generation, checkpoint/respawn) covered by a lightweight Node test runner (`node --test`): jump arc vs speed band, collision cases, combo build/reset rules, respawn-at-letter, score table values, endless-mode seeding.
- Rendering, input, and audio verified by playtesting in the browser.

## Build Order (phasing preview)

1. Core loop: drive, jump, terrain, collide, die/respawn.
2. Shooting + obstacles + enemies.
3. Checkpoints, scoring, HUD.
4. Audio.
5. Mod layer: power-ups, combo, bosses.
6. Endless mode.
7. Polish: CRT, particles, screen shake, touch controls, high-score table.

The game must be playable at the end of every phase.

## Out of Scope

- Online leaderboards, multiplayer, level editor.
- Copying the original ROM's art, music, or sound data — all assets are original, code-generated homages.
- Desktop packaging (Electron/Tauri).
