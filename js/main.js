// main.js — presentation/boot layer. Owns the canvas, the fixed-timestep
// game loop, and CSS scaling. Deliberately free of game logic: this task's
// update()/render() are a placeholder heartbeat, to be replaced by real
// simulation/render modules in later tasks.

import { createInput } from './input.js';

const VIEW_W = 384;
const VIEW_H = 240;
const DT = 1 / 60; // fixed simulation timestep, seconds

const screen = document.getElementById('screen');
const screenCtx = screen.getContext('2d');
screenCtx.imageSmoothingEnabled = false;

// Offscreen low-res buffer the sim renders into; screen canvas just
// receives a single drawImage of this buffer, scaled by CSS/layout.
const buffer = document.createElement('canvas');
buffer.width = VIEW_W;
buffer.height = VIEW_H;
const ctx = buffer.getContext('2d');
ctx.imageSmoothingEnabled = false;

const touchRoot = document.getElementById('touch-ui');
const input = createInput(touchRoot);

// --- placeholder sim state (heartbeat, replaced in later tasks) ---
let frame = 0;

function update(dt) {
  frame++;
}

function render(alpha) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // Moving white square: one full sweep across the buffer every ~4s.
  const period = 240; // frames (~4s at 60fps)
  const t = ((frame + alpha) % period) / period;
  const size = 8;
  const x = Math.floor(t * (VIEW_W - size));
  const y = Math.floor(VIEW_H / 2 - size / 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, size, size);

  ctx.fillStyle = '#fff';
  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('LUNAR ROVER', 8, 8);

  screenCtx.clearRect(0, 0, screen.width, screen.height);
  screenCtx.drawImage(buffer, 0, 0);
}

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
    update(DT);
    input.endFrame();
    acc -= DT;
  }
  render(acc / DT);
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
