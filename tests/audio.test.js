// audio.js is presentation-layer WebAudio code, but createAudio() accepts an
// injectable `contextFactory` (see the doc comment above it in audio.js)
// specifically so this suite can drive the *real* scheduling/dispatch code
// against a fake-but-faithful AudioContext, without importing WebAudio (or
// any DOM) into Node. `localStorage`/`window` are never referenced except
// inside loadPrefs()/persist()/defaultContextFactory() (all guarded with
// try/catch or unused here since we always pass our own factory), so no
// other stubbing is required.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudio } from '../js/audio.js';

// --- fake WebAudio -----------------------------------------------------

class FakeParam {
  constructor(v) { this.value = v; this.events = []; }

  setValueAtTime(v, t) { this.value = v; this.events.push({ type: 'set', v, t }); return this; }

  linearRampToValueAtTime(v, t) { this.value = v; this.events.push({ type: 'lin', v, t }); return this; }

  exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push({ type: 'exp', v, t }); return this; }

  cancelScheduledValues() { return this; }
}

function firstOfType(events, type) { return events.find((e) => e.type === type); }
function lastOfType(events, type) { return [...events].reverse().find((e) => e.type === type); }

// Every scheduled tone/noise node is recorded onto `scheduled` (reset
// between tests) as { kind, wave, f0, f1, startAt, nowAtSchedule }.
function makeFakeAudioContext(scheduled) {
  class FakeOsc {
    constructor(ctx) { this.ctx = ctx; this.frequency = new FakeParam(0); this.type = 'sine'; }

    connect() { return this; }

    start(t) {
      scheduled.push({
        kind: 'tone',
        wave: this.type,
        f0: firstOfType(this.frequency.events, 'set')?.v,
        f1: lastOfType(this.frequency.events, 'exp')?.v,
        startAt: t,
        nowAtSchedule: this.ctx.currentTime,
      });
    }

    stop() {}
  }

  class FakeGain {
    constructor() { this.gain = new FakeParam(1); }

    connect() { return this; }
  }

  class FakeBufferSource {
    constructor(ctx) { this.ctx = ctx; }

    connect() { return this; }

    start(t) {
      scheduled.push({ kind: 'noise', startAt: t, nowAtSchedule: this.ctx.currentTime });
    }

    stop() {}
  }

  class FakeBiquad {
    constructor() { this.frequency = new FakeParam(0); this.Q = new FakeParam(1); this.type = 'lowpass'; }

    connect() { return this; }
  }

  return class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.destination = {};
      this.state = 'running';
    }

    createOscillator() { return new FakeOsc(this); }

    createGain() { return new FakeGain(); }

    createBufferSource() { return new FakeBufferSource(this); }

    createBiquadFilter() { return new FakeBiquad(); }

    createBuffer(_channels, len) { return { getChannelData: () => new Float32Array(len) }; }

    resume() { return Promise.resolve(); }
  };
}

// Builds a resumed audio instance wired to its own isolated fake context +
// scheduled-event log, plus a helper to advance the fake clock the way
// main.js's requestAnimationFrame loop would (in FRAME-sized ticks, calling
// processEvents on every tick).
function setup(game) {
  const scheduled = [];
  const FakeAudioContext = makeFakeAudioContext(scheduled);
  let ctx;
  const a = createAudio(() => { ctx = new FakeAudioContext(); return ctx; });
  a.resume();
  const FRAME = 1 / 60;
  const advance = (seconds, events = []) => {
    const frames = Math.round(seconds / FRAME);
    for (let i = 0; i < frames; i++) {
      a.processEvents(events, game);
      ctx.currentTime += FRAME;
    }
  };
  return {
    a, ctx, scheduled, advance,
  };
}

const playingGame = () => ({ phase: 'playing', stage: 0, warn: { air: false, mine: false, rear: false } });

// --- regression: unbounded catch-up burst after a throttled/paused tab ---

test('music scheduler clamps a stale nextTime instead of bursting a catch-up backlog', () => {
  const game = playingGame();
  const { a, ctx, scheduled, advance } = setup(game);

  // Run normally for a bit so the scheduler is mid-loop with a real nextTime.
  advance(1);
  assert.ok(scheduled.length > 0, 'sanity: scheduling happened during normal playback');

  // Simulate a backgrounded/throttled tab: requestAnimationFrame stops
  // firing for a long stretch, but ctx.currentTime (a real clock) keeps
  // advancing underneath. On the next processEvents call, the scheduler's
  // bookkeeping nextTime is now ~60s behind ctx.currentTime.
  scheduled.length = 0;
  ctx.currentTime += 60;
  a.processEvents([], game);

  assert.ok(
    scheduled.length > 0 && scheduled.length <= 6,
    `catch-up call scheduled a bounded number of nodes, not a 60s backlog (got ${scheduled.length})`,
  );
  for (const e of scheduled) {
    assert.ok(e.startAt >= e.nowAtSchedule, `scheduled start time ${e.startAt} is not in the past (now was ${e.nowAtSchedule})`);
  }
});

test('rear-siren loop clamps a stale nextTime instead of bursting a catch-up backlog', () => {
  const game = playingGame();
  game.warn.rear = true;
  const { a, ctx, scheduled, advance } = setup(game);

  advance(0.5); // siren activates and schedules a beep or two
  assert.ok(scheduled.length > 0, 'sanity: the siren scheduled something while active');

  scheduled.length = 0;
  ctx.currentTime += 60; // simulate the same 60s throttled gap
  a.processEvents([], game); // warn.rear is still true

  assert.ok(
    scheduled.length > 0 && scheduled.length <= 3,
    `siren catch-up call scheduled a bounded number of nodes (got ${scheduled.length})`,
  );
  for (const e of scheduled) {
    assert.ok(e.startAt >= e.nowAtSchedule, `siren start time ${e.startAt} is not in the past (now was ${e.nowAtSchedule})`);
  }
});

test('a long gap never produces a scheduled start time in the past, across many resumptions', () => {
  // Belt-and-suspenders: hammer the clamp with several repeated large gaps
  // (not just one) and confirm the monotonic/never-past invariant holds
  // throughout, not just on the first catch-up.
  const game = playingGame();
  const { a, ctx, scheduled, advance } = setup(game);
  advance(0.5);
  for (let i = 0; i < 5; i++) {
    scheduled.length = 0;
    ctx.currentTime += 45;
    a.processEvents([], game);
    for (const e of scheduled) {
      assert.ok(e.startAt >= e.nowAtSchedule, `gap #${i}: start time ${e.startAt} scheduled before now (${e.nowAtSchedule})`);
    }
    assert.ok(scheduled.length <= 6, `gap #${i}: catch-up stayed bounded (got ${scheduled.length})`);
  }
});

// --- regression: prototype-unsafe event dispatch --------------------------

test('processEvents ignores prototype-inherited names instead of throwing', () => {
  // attract + no warn flags isolates this to pure sfx-dispatch: nothing
  // else in processEvents schedules a node in that state, so any node
  // appearing here would have to have come from the malicious names below.
  const game = { phase: 'attract', stage: 0, warn: { air: false, mine: false, rear: false } };
  const { a, scheduled } = setup(game);

  assert.doesNotThrow(() => {
    a.processEvents(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'], game);
  });
  assert.equal(scheduled.length, 0, 'no prototype-inherited name resolved to a callable handler');
});

test('processEvents still dispatches real events after seeing prototype-colliding names', () => {
  const game = { phase: 'attract', stage: 0, warn: { air: false, mine: false, rear: false } };
  const { a, scheduled } = setup(game);

  a.processEvents(['constructor', 'fire', 'toString'], game);
  assert.ok(scheduled.length > 0, 'the real "fire" event in the same batch still played');
});

test('an entirely unknown event name is a silent no-op', () => {
  const game = { phase: 'attract', stage: 0, warn: { air: false, mine: false, rear: false } };
  const { a, scheduled } = setup(game);

  assert.doesNotThrow(() => a.processEvents(['thisEventDoesNotExist'], game));
  assert.equal(scheduled.length, 0);
});

// --- carried-forward invariants (composition/scheduling sanity) -----------

test('scheduled start times are monotonically non-decreasing and never in the past', () => {
  const game = playingGame();
  const { scheduled, advance } = setup(game);
  advance(12);

  let prevStart = -Infinity;
  for (const e of scheduled) {
    assert.ok(e.startAt >= prevStart - 1e-9, 'start times never regress');
    assert.ok(e.startAt >= e.nowAtSchedule - 1e-9, 'never scheduled in the past');
    prevStart = Math.max(prevStart, e.startAt);
  }
});

test('main bassline stays within the A1-A2 walking range and repeats every 16 steps', () => {
  const game = playingGame();
  const { scheduled, advance } = setup(game);
  advance(12);

  const bass = scheduled.filter((e) => e.kind === 'tone' && e.wave === 'triangle' && e.f1 === undefined);
  assert.ok(bass.length >= 32, `captured at least two full 16-step loops (got ${bass.length})`);
  for (const e of bass) assert.ok(e.f0 >= 50 && e.f0 <= 120, `bass note ${e.f0}Hz in range`);

  const freqs = bass.map((e) => Math.round(e.f0 * 100));
  for (let i = 0; i < 16; i++) assert.equal(freqs[i], freqs[i + 16], `step ${i} repeats after 16 steps`);
});

test('boss ostinato alternates exactly two minor-second pitches', () => {
  const game = { phase: 'boss', stage: 0, warn: { air: false, mine: false, rear: false } };
  const { scheduled, advance } = setup(game);
  advance(3);

  const tones = scheduled.filter((e) => e.kind === 'tone' && e.wave === 'square');
  assert.ok(tones.length > 10, `boss ostinato scheduled notes (got ${tones.length})`);
  const pitches = new Set(tones.map((e) => Math.round(e.f0)));
  assert.equal(pitches.size, 2, `alternates exactly 2 pitches (got ${[...pitches]})`);
  for (const f of pitches) assert.ok(f >= 80 && f <= 90, `${f}Hz is E2/F2`);
});

test('mute persists muted:true to an injected localStorage and a fresh instance picks it up', () => {
  let savedRaw = null;
  const realLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => savedRaw,
    setItem: (_k, v) => { savedRaw = v; },
  };
  try {
    const { a: a1 } = setup(playingGame());
    a1.setMuted(true);
    assert.ok(savedRaw, 'setMuted persisted something');
    assert.deepEqual(JSON.parse(savedRaw), { muted: true, musicOn: true, sfxOn: true });

    const { a: a2 } = setup(playingGame());
    assert.equal(a2.muted, true, 'a fresh createAudio() reads the persisted muted flag');
  } finally {
    if (realLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = realLocalStorage;
  }
});
