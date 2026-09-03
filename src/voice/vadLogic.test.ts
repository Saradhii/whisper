import { describe, expect, it } from 'vitest';

import { createTurnDetector, DEFAULT_VAD, FLOOR_MAX, FLOOR_MIN, type VadVerdict } from './vadLogic';

const DT = 120;

/** Run a sequence of amplitude samples and return every verdict. */
function run(samples: number[], cfg = DEFAULT_VAD): VadVerdict[] {
  const d = createTurnDetector(cfg);
  return samples.map((a) => d.step(a, DT));
}

const rep = (v: number, n: number) => Array<number>(n).fill(v);
const ms = (t: number) => Math.ceil(t / DT);

describe('createTurnDetector', () => {
  it('gives up after noSpeechMs of silence', () => {
    const out = run(rep(0.01, ms(DEFAULT_VAD.noSpeechMs) + 1));
    const first = out.indexOf('no-speech');
    expect(first).toBe(ms(DEFAULT_VAD.noSpeechMs) - 1);
    expect(out.slice(0, first).every((v) => v === 'idle')).toBe(true);
  });

  it('ends a turn after one second of trailing silence', () => {
    const speech = rep(0.3, 10);
    const quiet = rep(0.01, ms(DEFAULT_VAD.silenceEndMs));
    const out = run([...rep(0.01, 3), ...speech, ...quiet]);
    expect(out).toContain('speaking');
    expect(out.at(-1)).toBe('end');
    expect(out.filter((v) => v === 'end')).toHaveLength(1);
  });

  it('hears quiet speech that the old fixed 0.12 threshold missed', () => {
    // A phone's raw VOICE_RECOGNITION source at arm's length: floor ~0.01,
    // speech ~0.07. Below the old constant; three times the floor here.
    const out = run([...rep(0.01, 4), ...rep(0.07, 6), ...rep(0.01, ms(1000))]);
    expect(out).toContain('speaking');
    expect(out.at(-1)).toBe('end');
  });

  it('ends a turn in a noisy room where the old fixed 0.06 never read as silent', () => {
    // Fan noise at 0.08, speech at 0.35, back to fan, with the floor carried
    // in from the previous window: "silence" is anything under 1.6× 0.08.
    const cfg = { ...DEFAULT_VAD, initialFloor: 0.08 };
    const out = run([...rep(0.08, 8), ...rep(0.35, 8), ...rep(0.08, ms(1000))], cfg);
    expect(out.slice(0, 8)).not.toContain('speaking');
    expect(out).toContain('speaking');
    expect(out.at(-1)).toBe('end');
  });

  it('learns a steady fan after one window so the next window is calibrated', () => {
    // A fresh floor cannot tell a fan from quiet speech, so the first window
    // trips on it and runs to the cap — but reports the fan as the room level.
    const d = createTurnDetector();
    const fan = rep(0.08, ms(DEFAULT_VAD.maxMs) + 1);
    const out = fan.map((a) => d.step(a, DT));
    expect(out).toContain('speaking');
    expect(out.at(-1)).toBe('end');
    expect(d.roomLevel()).toBeCloseTo(0.08, 3);
    // Second window, calibrated: the fan is idle and speech still starts.
    const out2 = run([...rep(0.08, 8), ...rep(0.35, 4)], {
      ...DEFAULT_VAD,
      initialFloor: d.roomLevel(),
    });
    expect(out2.slice(0, 8).every((v) => v === 'idle')).toBe(true);
    expect(out2.at(-1)).toBe('speaking');
  });

  it('does not trigger on the recorder hiss of a dead-quiet room', () => {
    // Floor 0.003: three times that is far below absOn, so hiss at 0.02 —
    // more than six times the floor — must still not count as speech.
    const out = run([...rep(0.003, 4), ...rep(0.02, 10)]);
    expect(out).not.toContain('speaking');
  });

  it('ignores a single loud click', () => {
    const out = run([...rep(0.01, 4), 0.9, ...rep(0.01, 4)]);
    expect(out).not.toContain('speaking');
  });

  it('does not let a loud first syllable become the floor', () => {
    // Speech from the very first sample. If the floor jumped to 0.3 the
    // ratio test could never pass; it must creep, so onset still fires.
    const out = run(rep(0.3, 4));
    expect(out).toContain('speaking');
  });

  it('caps a turn at maxMs even if the speaker never pauses', () => {
    const out = run(rep(0.3, ms(DEFAULT_VAD.maxMs) + 1));
    const first = out.indexOf('end');
    expect(first).toBe(ms(DEFAULT_VAD.maxMs) - 1);
  });

  it('reports the peak and floor for diagnostics', () => {
    const d = createTurnDetector();
    d.step(0.01, DT);
    d.step(0.4, DT);
    d.step(0.01, DT);
    expect(d.peak()).toBe(0.4);
    expect(d.floor()).toBeCloseTo(0.01, 3);
    expect(d.roomLevel()).toBeCloseTo(0.01, 3);
  });

  it('clamps the carried room level to the range the thresholds can work with', () => {
    const quiet = createTurnDetector();
    quiet.step(0, DT);
    expect(quiet.roomLevel()).toBe(FLOOR_MIN);
    const loud = createTurnDetector();
    loud.step(0.9, DT);
    expect(loud.roomLevel()).toBe(FLOOR_MAX);
  });
});
