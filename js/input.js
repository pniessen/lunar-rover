// input.js — unified keyboard + touch input. Presentation-layer: touches the
// DOM (window key events, touch events on the touch-ui root) but holds no
// game logic of its own; it only reports a state object for the sim to read.

const KEYMAP = {
  ArrowRight: 'accel', KeyD: 'accel',
  ArrowLeft: 'brake', KeyA: 'brake',
  Space: 'jump', ArrowUp: 'jump', KeyW: 'jump',
  KeyX: 'fire', KeyZ: 'fire', KeyJ: 'fire', KeyK: 'fire',
  KeyP: 'pause', KeyM: 'mute', KeyR: 'restart',
  // Separate music / SFX toggles (final-review finding I6): M is the global
  // mute (master gain), N and B independently silence the music bed and the
  // sound effects. All three persist through audio.js's localStorage prefs.
  KeyN: 'music', KeyB: 'sfx',
  // C toggles the CRT overlay (Task 14). Deliberately keyboard-only: the
  // touch layout stays minimal (drive / jump / fire / restart), so there is
  // no on-screen CRT button — see css/style.css and the task-14 report.
  KeyC: 'crt',
};

// Default DOM handles — a real browser at runtime. createInput() accepts an
// override so a Node test harness can drive the real listener/edge-detection
// code against a fake window+document (input.js otherwise never references
// `window`/`document` anywhere outside this function, so this is the only
// seam needed to unit-test the input layer without a DOM). Mirrors the
// `contextFactory` seam audio.js uses for AudioContext.
function defaultEnv() {
  return {
    win: typeof window !== 'undefined' ? window : null,
    doc: typeof document !== 'undefined' ? document : null,
  };
}

/**
 * True when the device can generate touch events at all.
 *
 * This has to be answered up front rather than inferred from a touch landing
 * on the controls: #touch-ui is `display: none` until <body> gets the `touch`
 * class, and a display:none element is never hit-tested, so a scheme that
 * waits for a touchstart *on the controls* to reveal them can never fire.
 * That was the bug — the mobile controls were unreachable in every state.
 */
function hasTouchCapability(win) {
  if (!win) return false;
  if (win.navigator && win.navigator.maxTouchPoints > 0) return true;
  return 'ontouchstart' in win;
}

/**
 * @param {HTMLElement} touchRoot - container holding #btn-jump, #btn-fire,
 *   #btn-restart, #zone-speed
 * @param {{win?: Window, doc?: Document}} [env] - DOM handles; defaults to the
 *   real browser globals. Exposed for tests (see defaultEnv above).
 * @returns {{state: object, pressed: (name:string)=>boolean, endFrame: ()=>void}}
 */
export function createInput(touchRoot, env = defaultEnv()) {
  const { win, doc } = env;
  const state = {
    accel: false, brake: false, jump: false, fire: false,
    pause: false, mute: false, restart: false, crt: false,
    music: false, sfx: false,
  };
  const just = new Set();
  const set = (a, v) => {
    if (v && !state[a]) just.add(a);
    state[a] = v;
  };

  if (win) {
    win.addEventListener('keydown', e => {
      const a = KEYMAP[e.code];
      if (a) { set(a, true); e.preventDefault(); }
    });
    win.addEventListener('keyup', e => {
      const a = KEYMAP[e.code];
      if (a) set(a, false);
    });
  }

  const markTouchActive = () => {
    if (doc && doc.body && !doc.body.classList.contains('touch')) {
      doc.body.classList.add('touch');
    }
  };

  // Reveal the touch layer at boot on any touch-capable device, so the very
  // first tap lands on a real button instead of being spent unhiding one. A
  // mouse-only desktop fails the capability check and never gets the overlay.
  if (hasTouchCapability(win)) markTouchActive();

  // Belt-and-braces for devices whose capability flags lie: the first touch
  // *anywhere in the document* reveals the controls. Bound on the window in
  // the capture phase — not on the controls themselves, which are hidden and
  // therefore un-hittable until this runs. Self-removing: once the class is
  // on, this listener has no further work to do.
  if (win) {
    const revealOnFirstTouch = () => {
      markTouchActive();
      win.removeEventListener('touchstart', revealOnFirstTouch, true);
    };
    win.addEventListener('touchstart', revealOnFirstTouch, { passive: true, capture: true });
  }

  if (touchRoot) {
    // Momentary button: held for as long as the finger is down. `set` handles
    // the just-pressed edge that pressed() reports, so jump/fire/restart all
    // behave exactly like their keyboard equivalents.
    const bindHold = (el, action) => {
      if (!el) return;
      el.addEventListener('touchstart', e => {
        set(action, true);
        e.preventDefault();
      }, { passive: false });
      const release = e => {
        set(action, false);
        e.preventDefault();
      };
      el.addEventListener('touchend', release, { passive: false });
      el.addEventListener('touchcancel', release, { passive: false });
    };

    bindHold(touchRoot.querySelector('#btn-jump'), 'jump');
    bindHold(touchRoot.querySelector('#btn-fire'), 'fire');
    // Restart is the touch stand-in for R. state.js's restartRun() is a no-op
    // outside a live run, so a stray tap on the attract screen or the game-over
    // screen does nothing.
    bindHold(touchRoot.querySelector('#btn-restart'), 'restart');

    const zoneSpeed = touchRoot.querySelector('#zone-speed');
    if (zoneSpeed) {
      // Track individual touches within the speed zone so multiple fingers
      // (or a finger moving between halves) resolve correctly.
      const touchSide = new Map(); // identifier -> 'accel' | 'brake'

      const resolveSide = touch => {
        const rect = zoneSpeed.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        return touch.clientY < midY ? 'accel' : 'brake';
      };

      const applyTouches = () => {
        const sides = new Set(touchSide.values());
        set('accel', sides.has('accel'));
        set('brake', sides.has('brake'));
      };

      zoneSpeed.addEventListener('touchstart', e => {
        for (const t of e.changedTouches) {
          touchSide.set(t.identifier, resolveSide(t));
        }
        applyTouches();
        e.preventDefault();
      }, { passive: false });

      zoneSpeed.addEventListener('touchmove', e => {
        for (const t of e.changedTouches) {
          if (touchSide.has(t.identifier)) {
            touchSide.set(t.identifier, resolveSide(t));
          }
        }
        applyTouches();
        e.preventDefault();
      }, { passive: false });

      const releaseTouch = e => {
        for (const t of e.changedTouches) {
          touchSide.delete(t.identifier);
        }
        applyTouches();
        e.preventDefault();
      };
      zoneSpeed.addEventListener('touchend', releaseTouch, { passive: false });
      zoneSpeed.addEventListener('touchcancel', releaseTouch, { passive: false });
    }
  }

  return {
    state,
    pressed: n => just.has(n),
    endFrame: () => just.clear(),
  };
}
