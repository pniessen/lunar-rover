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
  // touch layout stays minimal (drive / jump / fire), so there is no on-screen
  // CRT button — see css/style.css and the task-14 report.
  KeyC: 'crt',
};

/**
 * @param {HTMLElement} touchRoot - container holding #btn-jump, #btn-fire, #zone-speed
 * @returns {{state: object, pressed: (name:string)=>boolean, endFrame: ()=>void}}
 */
export function createInput(touchRoot) {
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

  addEventListener('keydown', e => {
    const a = KEYMAP[e.code];
    if (a) { set(a, true); e.preventDefault(); }
  });
  addEventListener('keyup', e => {
    const a = KEYMAP[e.code];
    if (a) set(a, false);
  });

  const markTouchActive = () => {
    if (!document.body.classList.contains('touch')) {
      document.body.classList.add('touch');
    }
  };

  if (touchRoot) {
    const btnJump = touchRoot.querySelector('#btn-jump');
    const btnFire = touchRoot.querySelector('#btn-fire');
    const zoneSpeed = touchRoot.querySelector('#zone-speed');

    if (btnJump) {
      btnJump.addEventListener('touchstart', e => {
        markTouchActive();
        set('jump', true);
        e.preventDefault();
      }, { passive: false });
      btnJump.addEventListener('touchend', e => {
        set('jump', false);
        e.preventDefault();
      }, { passive: false });
      btnJump.addEventListener('touchcancel', e => {
        set('jump', false);
        e.preventDefault();
      }, { passive: false });
    }

    if (btnFire) {
      btnFire.addEventListener('touchstart', e => {
        markTouchActive();
        set('fire', true);
        e.preventDefault();
      }, { passive: false });
      btnFire.addEventListener('touchend', e => {
        set('fire', false);
        e.preventDefault();
      }, { passive: false });
      btnFire.addEventListener('touchcancel', e => {
        set('fire', false);
        e.preventDefault();
      }, { passive: false });
    }

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
        markTouchActive();
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
