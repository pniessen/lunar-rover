// input.js is presentation-layer DOM code, but createInput() accepts an
// injectable `env` of {win, doc} (see the doc comment above it in input.js)
// specifically so this suite can drive the *real* listener wiring and
// edge-detection code against a fake-but-faithful window/document, without
// importing a DOM into Node. input.js references no other global, so those
// two handles plus a fake touchRoot are the only stubbing required.
//
// The headline case here is the deadlock regression at the bottom of the
// "touch activation" block: the touch controls used to be revealed only by a
// touchstart handler bound to elements inside the display:none #touch-ui, so
// they were unreachable in every state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInput } from '../js/input.js';

// --- fake DOM ---------------------------------------------------------------

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
  };
}

function makeDoc() {
  return { body: { classList: makeClassList() } };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.maxTouchPoints] - navigator.maxTouchPoints to report
 * @param {boolean} [opts.ontouchstart] - whether `'ontouchstart' in win` holds
 */
function makeWin({ maxTouchPoints = 0, ontouchstart = false } = {}) {
  const listeners = new Map();
  const win = {
    navigator: { maxTouchPoints },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const fns = listeners.get(type);
      if (!fns) return;
      const i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    },
    // test helper: fire every listener currently bound for `type`
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    listenerCount: (type) => (listeners.get(type) ?? []).length,
  };
  if (ontouchstart) win.ontouchstart = null;
  return win;
}

/** A fake element that records listeners and can replay them. */
function makeEl(rect = { top: 0, height: 200 }) {
  const listeners = new Map();
  return {
    addEventListener(type, fn, opts) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, opts });
    },
    getBoundingClientRect: () => rect,
    dispatch(type, event = {}) {
      for (const { fn } of listeners.get(type) ?? []) fn(event);
    },
    optsFor: (type) => (listeners.get(type) ?? []).map((l) => l.opts),
    has: (type) => listeners.has(type),
  };
}

/** A #touch-ui stand-in resolving the four control selectors. */
function makeTouchRoot(els = {}) {
  const map = {
    '#btn-jump': els.jump ?? makeEl(),
    '#btn-fire': els.fire ?? makeEl(),
    '#btn-restart': els.restart ?? makeEl(),
    '#zone-speed': els.zone ?? makeEl({ top: 0, height: 200 }), // midY = 100
  };
  return { querySelector: (sel) => map[sel] ?? null, els: map };
}

/** A touch event carrying `changedTouches`, recording preventDefault calls. */
function touchEvent(touches) {
  const e = {
    changedTouches: touches,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
  return e;
}

const touch = (identifier, clientY) => ({ identifier, clientY });

/** Boot an input with fakes, returning everything a test needs to poke at. */
function boot({ win = makeWin({ maxTouchPoints: 1 }), doc = makeDoc(), root = makeTouchRoot() } = {}) {
  const input = createInput(root, { win, doc });
  return { input, win, doc, root, els: root.els };
}

// --- touch activation (the deadlock) ---------------------------------------

test('a touch-capable device gets the touch class at boot, before any event', () => {
  const { doc } = boot({ win: makeWin({ maxTouchPoints: 5 }) });
  assert.ok(doc.body.classList.contains('touch'));
});

test('ontouchstart-in-window also counts as touch-capable', () => {
  const { doc } = boot({ win: makeWin({ maxTouchPoints: 0, ontouchstart: true }) });
  assert.ok(doc.body.classList.contains('touch'));
});

test('a mouse-only desktop does NOT get the touch class', () => {
  const { doc } = boot({ win: makeWin({ maxTouchPoints: 0 }) });
  assert.equal(doc.body.classList.contains('touch'), false);
});

test('a window-level touchstart reveals the controls when capability flags lie', () => {
  const { win, doc } = boot({ win: makeWin({ maxTouchPoints: 0 }) });
  assert.equal(doc.body.classList.contains('touch'), false, 'precondition');
  win.dispatch('touchstart', touchEvent([touch(0, 10)]));
  assert.ok(doc.body.classList.contains('touch'));
});

test('the window-level reveal listener removes itself once it has fired', () => {
  const { win } = boot({ win: makeWin({ maxTouchPoints: 0 }) });
  assert.equal(win.listenerCount('touchstart'), 1);
  win.dispatch('touchstart', touchEvent([touch(0, 10)]));
  assert.equal(win.listenerCount('touchstart'), 0);
});

test('REGRESSION: the touch class never depends on an event reaching #touch-ui', () => {
  // The bug: #touch-ui is `display: none` until <body>.touch is set, and a
  // display:none element is never hit-tested — so wiring the reveal to a
  // touchstart on #zone-speed / #btn-jump / #btn-fire (all children of
  // #touch-ui) meant the class could never be added and the mobile controls
  // were unreachable in every state. Both reveal paths below must work with
  // ZERO events dispatched to any element inside the root.
  const capable = boot({ win: makeWin({ maxTouchPoints: 1 }) });
  assert.ok(capable.doc.body.classList.contains('touch'), 'boot-time detection');

  const lying = boot({ win: makeWin({ maxTouchPoints: 0 }) });
  lying.win.dispatch('touchstart', touchEvent([touch(0, 10)]));
  assert.ok(lying.doc.body.classList.contains('touch'), 'window-level fallback');
});

// --- speed zone -------------------------------------------------------------

test('a touch in the top half of the speed zone presses accel', () => {
  const { input, els } = boot();
  els['#zone-speed'].dispatch('touchstart', touchEvent([touch(0, 40)]));
  assert.equal(input.state.accel, true);
  assert.equal(input.state.brake, false);
  assert.ok(input.pressed('accel'));
});

test('a touch in the bottom half of the speed zone presses brake', () => {
  const { input, els } = boot();
  els['#zone-speed'].dispatch('touchstart', touchEvent([touch(0, 160)]));
  assert.equal(input.state.brake, true);
  assert.equal(input.state.accel, false);
  assert.ok(input.pressed('brake'));
});

test('a held touch does not re-fire the just-pressed edge', () => {
  // accel/brake are edge-triggered gear shifts (buggy.js), so a finger resting
  // in the top half must bump the band exactly once, not once per touchmove.
  const { input, els } = boot();
  const zone = els['#zone-speed'];
  zone.dispatch('touchstart', touchEvent([touch(0, 40)]));
  input.endFrame();
  zone.dispatch('touchmove', touchEvent([touch(0, 30)]));
  zone.dispatch('touchmove', touchEvent([touch(0, 20)]));
  assert.equal(input.state.accel, true, 'still held');
  assert.equal(input.pressed('accel'), false, 'but no fresh edge');
});

test('sliding a finger across the midline releases accel and presses brake', () => {
  const { input, els } = boot();
  const zone = els['#zone-speed'];
  zone.dispatch('touchstart', touchEvent([touch(0, 40)]));
  input.endFrame();
  zone.dispatch('touchmove', touchEvent([touch(0, 170)]));
  assert.equal(input.state.accel, false);
  assert.equal(input.state.brake, true);
  assert.ok(input.pressed('brake'));
});

test('two fingers, one per half, hold accel and brake at once', () => {
  const { input, els } = boot();
  const zone = els['#zone-speed'];
  zone.dispatch('touchstart', touchEvent([touch(0, 40)]));
  zone.dispatch('touchstart', touchEvent([touch(1, 160)]));
  assert.equal(input.state.accel, true);
  assert.equal(input.state.brake, true);

  // Lifting only the bottom finger must leave accel held.
  zone.dispatch('touchend', touchEvent([touch(1, 160)]));
  assert.equal(input.state.accel, true);
  assert.equal(input.state.brake, false);
});

test('touchend and touchcancel both clear the speed zone', () => {
  for (const endType of ['touchend', 'touchcancel']) {
    const { input, els } = boot();
    const zone = els['#zone-speed'];
    zone.dispatch('touchstart', touchEvent([touch(0, 40)]));
    zone.dispatch(endType, touchEvent([touch(0, 40)]));
    assert.equal(input.state.accel, false, endType);
    assert.equal(input.state.brake, false, endType);
  }
});

test('an unknown touch identifier on touchmove is ignored', () => {
  const { input, els } = boot();
  els['#zone-speed'].dispatch('touchmove', touchEvent([touch(99, 40)]));
  assert.equal(input.state.accel, false);
});

// --- momentary buttons ------------------------------------------------------

for (const [sel, action] of [['#btn-jump', 'jump'], ['#btn-fire', 'fire'], ['#btn-restart', 'restart']]) {
  test(`${sel} presses and releases ${action}`, () => {
    const { input, els } = boot();
    els[sel].dispatch('touchstart', touchEvent([touch(0, 0)]));
    assert.equal(input.state[action], true);
    assert.ok(input.pressed(action));

    els[sel].dispatch('touchend', touchEvent([touch(0, 0)]));
    assert.equal(input.state[action], false);
  });

  test(`${sel} releases ${action} on touchcancel`, () => {
    const { input, els } = boot();
    els[sel].dispatch('touchstart', touchEvent([touch(0, 0)]));
    els[sel].dispatch('touchcancel', touchEvent([touch(0, 0)]));
    assert.equal(input.state[action], false);
  });
}

test('a tap shorter than a sim step still reports one just-pressed edge', () => {
  // touchstart+touchend can both land between two rAF frames; the press must
  // survive to the next pressed() read rather than being cancelled by release.
  const { input, els } = boot();
  els['#btn-jump'].dispatch('touchstart', touchEvent([touch(0, 0)]));
  els['#btn-jump'].dispatch('touchend', touchEvent([touch(0, 0)]));
  assert.equal(input.state.jump, false, 'not held');
  assert.ok(input.pressed('jump'), 'but the edge is still reported');
});

// --- event plumbing ---------------------------------------------------------

test('touch handlers preventDefault and are registered non-passive', () => {
  // A passive listener cannot preventDefault, so the browser would keep the
  // synthetic click / scroll gesture and the controls would misbehave.
  const { els } = boot();
  for (const sel of ['#btn-jump', '#btn-fire', '#btn-restart', '#zone-speed']) {
    const el = els[sel];
    const e = touchEvent([touch(0, 40)]);
    el.dispatch('touchstart', e);
    assert.ok(e.prevented, `${sel} touchstart preventDefault`);
    for (const opts of el.optsFor('touchstart')) {
      assert.equal(opts.passive, false, `${sel} touchstart non-passive`);
    }
  }
});

test('the window-level reveal listener is passive so it never blocks scrolling', () => {
  const win = makeWin({ maxTouchPoints: 0 });
  const opts = [];
  const origAdd = win.addEventListener.bind(win);
  win.addEventListener = (type, fn, o) => { if (type === 'touchstart') opts.push(o); origAdd(type, fn, o); };
  createInput(makeTouchRoot(), { win, doc: makeDoc() });
  assert.equal(opts.length, 1);
  assert.equal(opts[0].passive, true);
  assert.equal(opts[0].capture, true);
});

// --- keyboard ---------------------------------------------------------------

test('keyboard bindings still work through the injected window', () => {
  const { input, win } = boot();
  win.dispatch('keydown', { code: 'ArrowRight', preventDefault() {} });
  assert.equal(input.state.accel, true);
  assert.ok(input.pressed('accel'));
  win.dispatch('keyup', { code: 'ArrowRight' });
  assert.equal(input.state.accel, false);
});

test('an unmapped key is ignored and not preventDefaulted', () => {
  const { input, win } = boot();
  let prevented = false;
  win.dispatch('keydown', { code: 'F5', preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(input.pressed('accel'), false);
});

test('R restarts from the keyboard and #btn-restart is its touch twin', () => {
  const kb = boot();
  kb.win.dispatch('keydown', { code: 'KeyR', preventDefault() {} });
  assert.ok(kb.input.pressed('restart'));

  const tp = boot();
  tp.els['#btn-restart'].dispatch('touchstart', touchEvent([touch(0, 0)]));
  assert.ok(tp.input.pressed('restart'));
});

test('endFrame clears the just-pressed set but leaves held state alone', () => {
  const { input, els } = boot();
  els['#zone-speed'].dispatch('touchstart', touchEvent([touch(0, 40)]));
  assert.ok(input.pressed('accel'));
  input.endFrame();
  assert.equal(input.pressed('accel'), false);
  assert.equal(input.state.accel, true);
});

// --- degenerate wiring ------------------------------------------------------

test('createInput survives a missing touchRoot and missing controls', () => {
  assert.doesNotThrow(() => createInput(null, { win: makeWin(), doc: makeDoc() }));
  assert.doesNotThrow(() => createInput({ querySelector: () => null }, { win: makeWin(), doc: makeDoc() }));
});

test('createInput survives a missing window/document (no DOM at all)', () => {
  assert.doesNotThrow(() => createInput(null, { win: null, doc: null }));
});
