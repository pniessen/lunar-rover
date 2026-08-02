// main.js — presentation/boot layer. Owns the canvas element, the
// fixed-timestep game loop, and CSS scaling. Holds no game logic itself:
// simulation lives in state.js, drawing in render.js.

import { createInput } from './input.js';
import { createGame, updateGame, DT, VIEW_W, VIEW_H } from './state.js';
import { createRenderer, render } from './render.js';

const screen = document.getElementById('screen');
const touchRoot = document.getElementById('touch-ui');

const input = createInput(touchRoot);
const renderer = createRenderer(screen);
const game = createGame('classic', 1);

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
    updateGame(game, input, DT);
    input.endFrame();
    acc -= DT;
  }
  render(renderer, game, acc / DT);
  // Audio (Task 11) consumes events here too, before they are cleared.
  game.events.length = 0;
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
