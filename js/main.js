// main.js — presentation/boot layer. Owns the canvas element, the
// fixed-timestep game loop, and CSS scaling. Holds no game logic itself:
// simulation lives in state.js, drawing in render.js.

import { createInput } from './input.js';
import { createGame, updateGame, DT, VIEW_W, VIEW_H } from './state.js';
import { createRenderer, render } from './render.js';
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
}

addEventListener('resize', resizeCanvas);
resizeCanvas();

let acc = 0;
let last = performance.now();

function loop(t) {
  const elapsed = Math.min((t - last) / 1000, 0.25); // clamp to avoid spiral of death
  last = t;
  acc += elapsed;
  while (acc >= DT) {
    // The 4th argument is the ONLY place Date.now()-derived entropy is
    // allowed to reach state.js — it stays a pure, Node-testable module
    // that never calls Date.now()/Math.random() itself (see updateGame's
    // docstring). It's read every step but only actually consumed on the
    // exact frame the attract screen's mode-select menu is dismissed
    // (jump/fire pressed while game.phase==='attract'), seeding that run's
    // terrain/wave RNGs so repeated plays don't all replay the same layout.
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
    input.endFrame();
    acc -= DT;
  }
  render(renderer, game, acc / DT);
  // Audio consumes this frame's events after render (render itself doesn't
  // read game.events) but before the single clear point below.
  audio.processEvents(game.events, game);
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
