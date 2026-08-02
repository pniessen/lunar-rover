// audio.js — presentation-layer synthesized audio: WebAudio music sequencer
// + SFX. No audio files; every sound is generated with oscillators/noise at
// runtime. Holds no game logic — it only reads `game.events`/`game.phase`/
// `game.warn` and reacts. Safe to import and call in any order: the
// AudioContext itself is created lazily inside resume() (browsers refuse to
// start audio before a user gesture), so every method here is a no-op until
// resume() has been called from a real keydown/pointerdown/touchstart.
//
// Gain graph:  sfxGain \
//                        -> masterGain -> destination
//              musicGain /
//
// Mute is implemented as masterGain -> 0 (short ramp, not ctx.suspend()) so
// the music scheduler keeps running underneath — scheduling a handful of
// short envelopes every ~100ms is cheap, and keeping it alive means
// unmuting is instant and click-free instead of having to re-sync a
// suspended clock. `musicOn`/`sfxOn`, by contrast, actually stop the
// scheduler/handlers from creating nodes at all (a real "no music, thanks"
// preference, independent of the M-key mute).

const STORAGE_KEY = 'lunar-rover-audio';
const SCHEDULE_AHEAD = 0.1; // seconds of lookahead per processEvents() call

// --- music theory data ----------------------------------------------------

const NOTE_FREQ = {
  A1: 55.00, Bb1: 58.27, B1: 61.74, C2: 65.41, Db2: 69.30, D2: 73.42,
  Eb2: 77.78, E2: 82.41, F2: 87.31, Gb2: 92.50, G2: 98.00, A2: 110.00,
  A3: 220.00, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00,
  A4: 440.00, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, C6: 1046.50,
};

// Walking A-minor bassline: bar 1 is the classic up-and-back-down strut,
// bar 2 a variation that keeps the same shape but walks through the passing
// tone (D2/F2) instead — 16 eighth notes total (2 bars of 4/4).
const MAIN_BASS = [
  'A1', 'C2', 'E2', 'G2', 'A2', 'G2', 'E2', 'C2',
  'A1', 'C2', 'D2', 'E2', 'F2', 'E2', 'D2', 'C2',
];
const MAIN_BPM = 112;
const MAIN_STEP_DUR = 60 / MAIN_BPM / 2; // eighth note
const MAIN_GATE = 0.55; // staccato: note sounds for 55% of the step

// Quiet square-wave phrase, one bar (8 eighth notes) long. Only played
// during the second half of every 16-bar mega-cycle ("every other 8 bars").
const LEAD_MOTIF = ['E4', null, 'A4', null, 'C5', null, 'A4', null];

// Boss ostinato: relentless minor-2nd alternation, faster and squarer than
// the main loop so it reads as a step up in tension.
const BOSS_BASS = ['E2', 'F2', 'E2', 'F2', 'E2', 'F2', 'E2', 'F2'];
const BOSS_BPM = 140;
const BOSS_STEP_DUR = 60 / BOSS_BPM / 2;
const BOSS_GATE = 0.65;

const FANFARE_NOTES = ['A3', 'C4', 'E4', 'A4']; // stageClear: ascending
const FANFARE_STEP = 0.15;
const GAME_OVER_NOTES = ['A4', 'E4', 'C4', 'A3']; // gameOver: descending
const GAME_OVER_STEP = 0.22;

// --- persistence -----------------------------------------------------------

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return {
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : undefined,
      musicOn: typeof parsed.musicOn === 'boolean' ? parsed.musicOn : undefined,
      sfxOn: typeof parsed.sfxOn === 'boolean' ? parsed.sfxOn : undefined,
    };
  } catch {
    return {};
  }
}

// Default AudioContext constructor lookup — a real browser at runtime.
// createAudio() accepts an override so a Node test harness can inject a
// fake AudioContext (audio.js otherwise never references `window`/
// `AudioContext` anywhere outside resume(), so this is the only seam
// needed to unit-test the scheduler without a real WebAudio implementation).
function defaultContextFactory() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  return Ctx ? new Ctx() : null;
}

// --- factory ----------------------------------------------------------------

/**
 * @param {() => (AudioContext|null)} [contextFactory] - constructs the
 *   AudioContext used by resume(); defaults to the real browser one.
 *   Exposed for tests: pass a factory that returns a fake context exposing
 *   the same shape (createOscillator/createGain/createBufferSource/
 *   createBiquadFilter/createBuffer/currentTime/sampleRate/destination) to
 *   drive the real scheduling code without importing WebAudio into Node.
 */
export function createAudio(contextFactory = defaultContextFactory) {
  const prefs = loadPrefs();
  const a = {
    muted: prefs.muted ?? false,
    musicOn: prefs.musicOn ?? true,
    sfxOn: prefs.sfxOn ?? true,
  };

  let ctx = null;
  let masterGain = null;
  let musicGain = null;
  let sfxGain = null;
  let noiseBuffer = null;

  const music = { name: null, stepIndex: 0, nextTime: 0 };
  const siren = { active: false, stepIndex: 0, nextTime: 0 };
  let prevMine = false;

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        muted: a.muted, musicOn: a.musicOn, sfxOn: a.sfxOn,
      }));
    } catch {
      // localStorage unavailable (private mode, disabled, non-browser) — the
      // in-memory flags still work for this session, just don't persist.
    }
  }

  function rampGain(param, value, time = 0.01) {
    if (!param || !ctx) return;
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + time);
  }

  function getNoiseBuffer() {
    if (noiseBuffer) return noiseBuffer;
    const len = Math.floor(ctx.sampleRate * 1); // 1s of white noise, reused for every burst
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  // Short oscillator envelope: linear attack, linear decay to ~0. Used for
  // every tonal SFX/note (bass, lead, chimes, arps, tone-sweeps).
  function playTone({ wave = 'sine', f0, f1 = f0, dur, peak = 0.2, attack = 0.005, dest }, at = ctx.currentTime) {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(Math.max(1, f0), at);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.linearRampToValueAtTime(0.0001, at + Math.max(dur, attack + 0.01));
    osc.connect(g);
    g.connect(dest || sfxGain);
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }

  // Filtered white-noise burst with an optional filter-frequency sweep. Used
  // for explosions, thuds, whooshes, hi-hats.
  function playNoiseSweep({
    f0, f1 = f0, dur, peak = 0.25, filterType = 'lowpass', q = 1, dest,
  }, at = ctx.currentTime) {
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer();
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(20, f0), at);
    if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.008);
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(dest || sfxGain);
    src.start(at);
    src.stop(at + dur + 0.03);
  }

  // --- music: lookahead scheduler ------------------------------------------

  function scheduleMainStep(time, stepIndex) {
    const note = MAIN_BASS[stepIndex % MAIN_BASS.length];
    playTone({
      wave: 'triangle', f0: NOTE_FREQ[note], dur: MAIN_STEP_DUR * MAIN_GATE, peak: 0.22, dest: musicGain,
    }, time);

    // Noise hi-hat tick on every off-beat eighth note.
    if (stepIndex % 2 === 1) {
      playNoiseSweep({
        f0: 6500, dur: 0.03, peak: 0.05, filterType: 'highpass', q: 0.7, dest: musicGain,
      }, time);
    }

    // Lead phrase enters for 8 bars, rests for 8 bars, on repeat.
    const barNumber = Math.floor(stepIndex / 8);
    if (barNumber % 16 >= 8) {
      const leadNote = LEAD_MOTIF[stepIndex % 8];
      if (leadNote) {
        playTone({
          wave: 'square', f0: NOTE_FREQ[leadNote], dur: MAIN_STEP_DUR * 0.8, peak: 0.07, dest: musicGain,
        }, time);
      }
    }
  }

  function scheduleBossStep(time, stepIndex) {
    const note = BOSS_BASS[stepIndex % BOSS_BASS.length];
    playTone({
      wave: 'square', f0: NOTE_FREQ[note], dur: BOSS_STEP_DUR * BOSS_GATE, peak: 0.2, dest: musicGain,
    }, time);
    if (stepIndex % 2 === 1) {
      playNoiseSweep({
        f0: 5000, dur: 0.025, peak: 0.06, filterType: 'highpass', q: 0.7, dest: musicGain,
      }, time);
    }
  }

  function scheduleFanfare(at) {
    FANFARE_NOTES.forEach((n, i) => {
      playTone({
        wave: 'triangle', f0: NOTE_FREQ[n], dur: 0.22, peak: 0.28, dest: musicGain,
      }, at + i * FANFARE_STEP);
    });
  }

  function scheduleGameOverJingle(at) {
    GAME_OVER_NOTES.forEach((n, i) => {
      playTone({
        wave: 'triangle', f0: NOTE_FREQ[n], dur: 0.28, peak: 0.24, dest: musicGain,
      }, at + i * GAME_OVER_STEP);
    });
  }

  function trackForPhase(phase) {
    switch (phase) {
      case 'playing':
      case 'respawning':
        return 'main';
      case 'boss':
        return 'boss';
      case 'stageClear':
        return 'fanfare';
      case 'gameOver':
        return 'gameOver';
      default:
        return null; // attract (silent), dying (gets its own explosion SFX)
    }
  }

  // Switches the active track. Looping tracks (main/boss) reset their step
  // counter and pick up SCHEDULE_AHEAD-seconds in the future; one-shot
  // tracks (fanfare/gameOver) are scheduled once here and then left alone —
  // updateMusic() only keeps *looping* tracks fed. Any notes still ringing
  // from the outgoing track are short (<=0.4s) with their own decay
  // envelopes, so the switch reads as clean rather than a hard cut.
  function startTrack(name) {
    music.name = name;
    music.stepIndex = 0;
    if (!name || !ctx) return;
    const at = ctx.currentTime + 0.02; // always schedule into the future
    music.nextTime = at;
    if (name === 'fanfare') scheduleFanfare(at);
    else if (name === 'gameOver') scheduleGameOverJingle(at);
  }

  function updateMusic(game) {
    const desired = a.musicOn ? trackForPhase(game.phase) : null;
    if (desired !== music.name) startTrack(desired);
    const name = music.name;
    if (name !== 'main' && name !== 'boss') return; // one-shot or silent: nothing left to schedule
    const stepDur = name === 'main' ? MAIN_STEP_DUR : BOSS_STEP_DUR;
    // If the tab was backgrounded/throttled long enough that nextTime has
    // fallen behind the audio clock (rAF can pause for tens of seconds while
    // ctx.currentTime keeps ticking), catching up step-by-step would burst
    // hundreds of stale, in-the-past notes into the graph in one call — an
    // audible glitch and a main-thread hitch. Clamp forward to "now" instead
    // of walking every missed step: the pattern's stepIndex just keeps
    // counting from where it left off. A silent jump in the melody's grid
    // position is the unavoidable cost of having been paused; there's no way
    // to also preserve wall-clock beat alignment across an arbitrary gap.
    if (music.nextTime < ctx.currentTime) music.nextTime = ctx.currentTime + 0.02;
    const aheadUntil = ctx.currentTime + SCHEDULE_AHEAD;
    while (music.nextTime < aheadUntil) {
      if (name === 'main') scheduleMainStep(music.nextTime, music.stepIndex);
      else scheduleBossStep(music.nextTime, music.stepIndex);
      music.stepIndex += 1;
      music.nextTime += stepDur;
    }
  }

  // --- warn-flag driven SFX (mine pip, rear siren loop) --------------------

  function updateWarnSfx(game) {
    const warn = (game && game.warn) || {};

    const mineNow = !!warn.mine;
    if (mineNow && !prevMine && a.sfxOn) {
      playTone({ wave: 'square', f0: 1200, dur: 0.08, peak: 0.18 });
    }
    prevMine = mineNow;

    const rearWanted = !!warn.rear && a.sfxOn;
    if (rearWanted && !siren.active) {
      siren.active = true;
      siren.stepIndex = 0;
      siren.nextTime = ctx.currentTime + 0.02;
    } else if (!rearWanted && siren.active) {
      siren.active = false; // stops feeding new beeps; any already-scheduled finish naturally
    }
    if (siren.active) {
      // Same unbounded-catch-up hazard as updateMusic() above: clamp a
      // stale nextTime forward instead of walking every missed beep.
      if (siren.nextTime < ctx.currentTime) siren.nextTime = ctx.currentTime + 0.02;
      const aheadUntil = ctx.currentTime + SCHEDULE_AHEAD;
      while (siren.nextTime < aheadUntil) {
        const hi = siren.stepIndex % 2 === 0;
        playTone({ wave: 'square', f0: hi ? 720 : 540, dur: 0.12, peak: 0.14 }, siren.nextTime);
        siren.stepIndex += 1;
        siren.nextTime += 0.16;
      }
    }
  }

  // --- event-triggered SFX ---------------------------------------------------

  // Object.create(null): events are looked up by an arbitrary, effectively
  // attacker/future-task-controlled string (game.events entries). A plain
  // {} literal inherits Object.prototype, so a colliding name like
  // 'constructor'/'toString'/'hasOwnProperty' would resolve to a builtin
  // and get called unbound (`handler()`, no receiver) — in strict-mode ES
  // modules that throws (e.g. hasOwnProperty's ToObject(undefined)), which
  // would propagate out of processEvents() and freeze the whole game loop
  // (main.js has no try/catch around it). A null-prototype object has no
  // inherited keys at all, so any name not explicitly listed below is
  // simply `undefined` and silently skipped by the `if (handler)` guard.
  const sfx = Object.assign(Object.create(null), {
    fire: () => playTone({ wave: 'square', f0: 660, f1: 440, dur: 0.06, peak: 0.22 }),
    jump: () => playTone({ wave: 'sine', f0: 180, f1: 320, dur: 0.15, peak: 0.2 }),
    land: () => playTone({ wave: 'sine', f0: 90, dur: 0.05, peak: 0.26 }),
    explosion: () => playNoiseSweep({
      f0: 800, f1: 100, dur: 0.4, peak: 0.32, filterType: 'lowpass', q: 0.9,
    }),
    bombHit: () => playNoiseSweep({
      f0: 700, f1: 200, dur: 0.15, peak: 0.26, filterType: 'lowpass', q: 0.9,
    }),
    shieldBreak: () => {
      const t = ctx.currentTime;
      playTone({ wave: 'square', f0: 480, f1: 220, dur: 0.12, peak: 0.2 }, t);
      playTone({ wave: 'square', f0: 680, f1: 300, dur: 0.09, peak: 0.12 }, t + 0.015);
    },
    checkpoint: () => {
      const t = ctx.currentTime;
      playTone({ wave: 'sine', f0: NOTE_FREQ.C5, dur: 0.1, peak: 0.18 }, t);
      playTone({ wave: 'sine', f0: NOTE_FREQ.E5, dur: 0.14, peak: 0.18 }, t + 0.09);
    },
    extraLife: () => {
      const t = ctx.currentTime;
      ['C5', 'D5', 'G5', 'C6'].forEach((n, i) => {
        playTone({ wave: 'square', f0: NOTE_FREQ[n], dur: 0.12, peak: 0.16 }, t + i * 0.07);
      });
    },
    tally: () => playTone({ wave: 'square', f0: 1400, dur: 0.03, peak: 0.14 }),
    chaserDodge: () => playNoiseSweep({
      f0: 2200, f1: 500, dur: 0.14, peak: 0.18, filterType: 'bandpass', q: 1.4,
    }),
    // Not emitted yet (Tasks 10-12 add powerups/combo/boss) — implemented
    // now so those tasks get sound for free; unknown events are ignored.
    powerup: () => playTone({ wave: 'sine', f0: 300, f1: 900, dur: 0.2, peak: 0.2 }),
    powerupEnd: () => playTone({ wave: 'sine', f0: 500, f1: 200, dur: 0.2, peak: 0.14 }),
    comboUp: () => {
      const t = ctx.currentTime;
      playTone({ wave: 'square', f0: 988, dur: 0.05, peak: 0.16 }, t);
      playTone({ wave: 'square', f0: 1319, dur: 0.08, peak: 0.16 }, t + 0.05);
    },
    comboLost: () => playNoiseSweep({
      f0: 300, f1: 80, dur: 0.12, peak: 0.2, filterType: 'lowpass', q: 0.8,
    }),
    bossTelegraph: () => {
      const t = ctx.currentTime;
      playTone({ wave: 'square', f0: 500, f1: 900, dur: 0.15, peak: 0.22 }, t);
      playTone({ wave: 'square', f0: 500, f1: 900, dur: 0.15, peak: 0.22 }, t + 0.18);
    },
    bossDown: () => playNoiseSweep({
      f0: 600, f1: 50, dur: 0.6, peak: 0.36, filterType: 'lowpass', q: 0.9,
    }),
  });

  // --- public API --------------------------------------------------------

  a.resume = function resume() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    try {
      ctx = contextFactory();
      if (!ctx) return; // WebAudio unavailable — every method below stays a safe no-op
      masterGain = ctx.createGain();
      masterGain.gain.value = a.muted ? 0 : 1;
      masterGain.connect(ctx.destination);
      musicGain = ctx.createGain();
      musicGain.gain.value = 0.5;
      musicGain.connect(masterGain);
      sfxGain = ctx.createGain();
      sfxGain.gain.value = 0.85;
      sfxGain.connect(masterGain);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch {
      ctx = null; // leave audio silently disabled
    }
  };

  a.setMuted = function setMuted(m) {
    a.muted = !!m;
    persist();
    if (masterGain) rampGain(masterGain.gain, a.muted ? 0 : 1);
  };

  a.toggleMuted = function toggleMuted() {
    a.setMuted(!a.muted);
  };

  a.setMusicOn = function setMusicOn(b) {
    a.musicOn = !!b;
    persist();
  };

  a.setSfxOn = function setSfxOn(b) {
    a.sfxOn = !!b;
    persist();
  };

  a.processEvents = function processEvents(events, game) {
    if (!ctx) return; // no gesture yet (or WebAudio unavailable) — stay silent, no errors
    updateMusic(game);
    updateWarnSfx(game);
    if (a.sfxOn) {
      for (let i = 0; i < events.length; i++) {
        const handler = sfx[events[i]];
        if (handler) handler();
      }
    }
  };

  return a;
}
