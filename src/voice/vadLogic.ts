// The turn-taking decision for live mode, as a pure state machine over mic
// amplitude samples. vad.ts owns the recorder and the timer; this owns the
// question "has the user started and then finished speaking?", which is the
// part that went wrong on real phones and the part worth testing without one.
//
// Why adaptive and not two constants: the previous detector fired at a fixed
// amplitude (0.12 — a chunk RMS of about −30 dBFS). That number was tuned on
// the emulator, whose "microphone" is the Mac's, with macOS gain control
// behind it. A phone's VOICE_RECOGNITION source is raw and several times
// quieter at conversational distance, so on device speech rarely crossed the
// line and live mode sat on "Listening…" forever — every 8 s window ended in
// no-speech and quietly restarted. Conversely a fixed silence threshold of
// 0.06 never counted a room with a fan as silent, so a turn that did start
// could only end at the 15 s cap. Both fail in the same way: the constant
// knows nothing about this phone in this room.
//
// So the detector tracks the noise floor and decides relative to it, with an
// absolute minimum underneath so a dead-quiet room does not trigger on the
// recorder's own hiss.

/** Amplitudes are the recorder's chunk RMS × 4, clamped to 0..1. */
export type VadConfig = {
  /** Speech must exceed BOTH: this absolute level and `onRatio` × floor. */
  absOn: number;
  onRatio: number;
  /** Silence is below BOTH: this absolute level and `offRatio` × floor. */
  absOff: number;
  offRatio: number;
  /** Consecutive above-threshold samples before speech counts as started.
   *  Two polls (240 ms) ignore a tap on the case or a door closing. */
  onsetSamples: number;
  /** Trailing silence that ends a turn. */
  silenceEndMs: number;
  /** Give up if the user never speaks. */
  noSpeechMs: number;
  /** Hard cap on a single turn. */
  maxMs: number;
  /** Where the floor starts. The caller carries the previous window's
   *  `roomLevel()` in here, so only the very first window guesses. */
  initialFloor: number;
  /** EMA weight for a sample above the floor (0..1). Low, so a loud first
   *  syllable nudges the floor rather than becoming it; the floor drops to
   *  any quieter sample at once. */
  floorAlpha: number;
};

export const DEFAULT_VAD: VadConfig = {
  absOn: 0.05, // chunk RMS ≈ −38 dBFS
  onRatio: 3,
  absOff: 0.03,
  offRatio: 1.6,
  onsetSamples: 2,
  silenceEndMs: 1000,
  noSpeechMs: 8000,
  maxMs: 15000,
  initialFloor: 0.02,
  floorAlpha: 0.1,
};

/** The carried floor is clamped to this range: below it the room is quieter
 *  than the recorder's own hiss and the absolute thresholds take over; above
 *  it a very loud room would push the speech threshold past what a voice can
 *  reach, and the turn is better cut by the cap than never started. */
export const FLOOR_MIN = 0.005;
export const FLOOR_MAX = 0.2;

export type VadVerdict =
  /** Still waiting for speech to start. */
  | 'idle'
  /** The user is talking. */
  | 'speaking'
  /** The user talked and has now gone quiet — the turn is complete. */
  | 'end'
  /** The user never spoke within `noSpeechMs`. */
  | 'no-speech';

export type TurnDetector = {
  /** Feed one amplitude sample taken `dtMs` after the previous one. */
  step: (amp: number, dtMs: number) => VadVerdict;
  /** Loudest sample seen this window — what the diagnostics report. */
  peak: () => number;
  /** The tracked noise floor. Frozen once speech starts. */
  floor: () => number;
  /**
   * The quietest the window ever got, clamped to the carry range — the best
   * estimate of the room for the NEXT window. Speech has gaps between words
   * that dip to the floor, so this is honest across a turn; and a window that
   * mistook a steady fan for speech (a fresh floor cannot tell them apart)
   * reports the fan's level here, so the next window starts calibrated and
   * the mistake happens once, not every 15 s.
   */
  roomLevel: () => number;
};

export function createTurnDetector(cfg: VadConfig = DEFAULT_VAD): TurnDetector {
  let floor = cfg.initialFloor;
  let peak = 0;
  let min = Infinity;
  let elapsed = 0;
  let onset = 0;
  let speaking = false;
  let silence = 0;

  const onThreshold = () => Math.max(cfg.absOn, floor * cfg.onRatio);
  const offThreshold = () => Math.max(cfg.absOff, floor * cfg.offRatio);

  return {
    step(amp, dtMs) {
      elapsed += dtMs;
      if (amp > peak) peak = amp;
      if (amp < min) min = amp;

      if (!speaking) {
        // Judged against the floor as it stood BEFORE this sample, and a
        // sample that clears the bar does not move the bar: otherwise the
        // floor chases the first syllable up and the second one fails the
        // ratio test. Only noise-like samples train the floor — it drops to
        // a quieter one at once and creeps toward a louder one — and it is
        // frozen for the whole of a turn so a long sentence cannot raise its
        // own bar. The cost is that a steady noise that a fresh floor cannot
        // tell from quiet speech (a fan at 0.08 against a first-window guess
        // of 0.02) is taken for speech once; `roomLevel()` then reports it
        // and the next window starts above it.
        const above = amp > onThreshold();
        if (!above) floor = amp < floor ? amp : floor + (amp - floor) * cfg.floorAlpha;

        onset = above ? onset + 1 : 0;
        if (onset >= cfg.onsetSamples) {
          speaking = true;
          silence = 0;
          return 'speaking';
        }
        return elapsed >= cfg.noSpeechMs ? 'no-speech' : 'idle';
      }

      silence = amp < offThreshold() ? silence + dtMs : 0;
      if (silence >= cfg.silenceEndMs || elapsed >= cfg.maxMs) return 'end';
      return 'speaking';
    },
    peak: () => peak,
    floor: () => floor,
    roomLevel: () =>
      Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, min === Infinity ? cfg.initialFloor : min)),
  };
}
