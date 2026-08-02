// main.js — presentation/boot layer. Owns the canvas element, the
// fixed-timestep game loop, and CSS scaling. Holds no game logic itself:
// simulation lives in state.js, drawing in render.js.

import { createInput } from './input.js';
import {
  createGame, updateGame, togglePause, restartRun, DT, VIEW_W, VIEW_H,
} from './state.js';
import { createRenderer, render, toggleCrt } from './render.js';
import { createAudio } from './audio.js';
import { notifyGameEventsCleared } from './combo.js';

const screen = document.getElementById('screen');
const touchRoot = document.getElementById('touch-ui');

const input = createInput(touchRoot);
const renderer = createRenderer(screen);
const game = createGame('classic', 1);
const audio = createAudio();

// AudioContext creation/resume must happen inside a user-gesture handler —
// browsers block autoplay otherwise. Fire once on the first keydown/
// pointerdown/touchstart, whichever comes first, then get out of the way.
function resumeAudioOnce() {
  audio.resume();
  removeEventListener('keydown', resumeAudioOnce);
  removeEventListener('pointerdown', resumeAudioOnce);
  removeEventListener('touchstart', resumeAudioOnce);
}
addEventListener('keydown', resumeAudioOnce);
addEventListener('pointerdown', resumeAudioOnce);
addEventListener('touchstart', resumeAudioOnce, { passive: true });

function resizeCanvas() {
  const viewport = document.getElementById('viewport');
  const availW = viewport.clientWidth;
  const availH = viewport.clientHeight;

  let scale = Math.min(availW / VIEW_W, availH / VIEW_H);
  // Prefer an integer scale for crisp pixels; only fall back to a
  // fractional scale above 1x when no integer multiple fits.
  const intScale = Math.floor(scale);
  if (intScale >= 1) {
    scale = intScale;
  }
  scale = Math.max(scale, 0.1);

  screen.style.width = `${VIEW_W * scale}px`;
  screen.style.height = `${VIEW_H * scale}px`;

  // The backing store tracks the displayed size (Task 14) instead of staying
  // at 384x240. render.js blits the buffer up to it with smoothing off, which
  // is pixel-identical to letting CSS do the scaling, but it gives the CRT
  // overlay real screen rows to draw scanlines on — a 1px line every other
  // row here reads as a scanline, whereas a 1px line in the 384x240 buffer
  // would be magnified into a fat zebra stripe. Guarded so a same-size
  // resize event does not needlessly clear the canvas (assigning width/height
  // resets it) or force render.js to rebuild the cached overlay.
  const bw = Math.max(1, Math.round(VIEW_W * scale));
  const bh = Math.max(1, Math.round(VIEW_H * scale));
  if (screen.width !== bw || screen.height !== bh) {
    screen.width = bw;
    screen.height = bh;
  }
}

addEventListener('resize', resizeCanvas);
resizeCanvas();

let acc = 0;
let last = performance.now();

function loop(t) {
  const elapsed = Math.min((t - last) / 1000, 0.25); // clamp to avoid spiral of death
  last = t;
  acc += elapsed;
  let steps = 0;
  while (acc >= DT) {
    steps++;
    // Pause and restart are read here, INSIDE the fixed-timestep loop, for
    // the reason spelled out on the mute toggle below — and before
    // updateGame, so a press lands on this very step rather than a frame
    // late. Both are no-ops outside a live run; state.js owns that rule (see
    // togglePause/restartRun) so it is testable there rather than buried in
    // this untested boot file.
    if (input.pressed('pause')) togglePause(game);
    if (input.pressed('restart')) restartRun(game, Date.now());
    // The 4th argument (and restartRun's `seed` above) is the ONLY place
    // Date.now()-derived entropy is allowed to reach state.js — it stays a
    // pure, Node-testable module that never calls Date.now()/Math.random()
    // itself (see updateGame's docstring). It's read every step but only
    // actually consumed on the exact frame the attract screen's mode-select
    // menu is dismissed (jump/fire pressed while game.phase==='attract'),
    // seeding that run's terrain/wave RNGs so repeated plays don't all replay
    // the same layout.
    updateGame(game, input, DT, Date.now());
    // input.pressed() is "just pressed this sim step" and is aged away by
    // endFrame() below — so the mute toggle has to be read here, inside the
    // fixed-timestep loop, not once per rendered frame. A rendered frame can
    // contain zero, one, or several sim steps; checking after the loop would
    // both miss presses that occurred in an earlier step this frame (already
    // aged out) and double-fire on frames with 2+ steps. Reading it here, at
    // most one of those steps has `pressed('mute')` true, so a single key
    // press toggles exactly once.
    if (input.pressed('mute')) audio.toggleMuted();
    // N / B: independent music and SFX toggles (finding I6). Both persist via
    // audio.js's own localStorage prefs, same as M's master mute.
    if (input.pressed('music')) audio.setMusicOn(!audio.musicOn);
    if (input.pressed('sfx')) audio.setSfxOn(!audio.sfxOn);
    // CRT overlay toggle (C). Read inside the fixed-timestep loop for exactly
    // the same reason as mute above: input.pressed() is "just pressed this
    // sim step" and is aged away by endFrame(), so a check outside this loop
    // would both miss and double-fire. render.js owns the flag and persists
    // it to localStorage ('lunar-rover-crt', default ON).
    if (input.pressed('crt')) toggleCrt(renderer);
    input.endFrame();
    acc -= DT;
  }
  // 4th argument: the simulation time this frame actually advanced. render.js
  // ages particles, screen shake, and the HUD's blink/flash timers by it
  // instead of assuming one fixed step per rendered frame, which would
  // otherwise make all of them run fast on a high-refresh display and slow
  // on a low-refresh one. Forced to 0 while paused: `steps` still counts the
  // fixed-timestep loop's iterations above even when every one of them was a
  // no-op (updateGame's own pause check), so passing the real steps*DT here
  // would keep aging the effect layer through a pause the simulation itself
  // is correctly frozen for. A 0 simDt makes updateParticles/the shake decay/
  // the HUD blink hold exactly the frame they were on when P was pressed.
  render(renderer, game, acc / DT, game.paused ? 0 : steps * DT);
  // Audio consumes this frame's events after render (render itself doesn't
  // read game.events) but before the single clear point below.
  //
  // While paused, the audio pass is skipped entirely (finding I5):
  // processEvents is what feeds the music scheduler, so not calling it stops
  // new notes from being queued and the bed fades out as the last scheduled
  // ~0.4s of envelopes ring off. Resuming cannot burst: updateMusic's Task-9
  // forward clamp (music.nextTime < ctx.currentTime -> now + 0.02) discards
  // the missed steps instead of walking them, exactly as it does for a
  // backgrounded tab.
  if (!game.paused) audio.processEvents(game.events, game);
  game.events.length = 0;
  // combo.js's updateCombo keeps a cursor into game.events (see its
  // docstring) that must be invalidated in lockstep with this clear —
  // otherwise a lag-spike rendered frame that pushes enough new events in
  // its first tick to reach/exceed the old cursor would silently hide the
  // dip to zero from a plain length check inside updateCombo.
  notifyGameEventsCleared(game);
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
