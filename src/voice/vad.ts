// Minimal voice-activity detection for live mode: records, watches the mic's
// amplitude, and resolves with the captured audio once the speaker starts and
// then goes quiet (or a hard cap is hit). The decision itself lives in
// vadLogic.ts — adaptive to the room's noise floor, and tested there — and
// this file only feeds it the recorder.
import { currentAmplitude, startRecording, stopRecording } from './recorder';
import { createTurnDetector, DEFAULT_VAD } from './vadLogic';

const POLL_MS = 120;

// The room, as the last window measured it. Carried so a window does not
// have to relearn the noise floor from a guess while the user may already be
// talking — and so a window that mistook a steady noise for speech corrects
// the next one instead of repeating. Module-level rather than per screen:
// the room does not change because the user left live mode and came back.
let lastFloor = DEFAULT_VAD.initialFloor;

export type VadHandle = { cancel: () => void };

export type ListenResult = {
  /** Mono Int16 PCM at 16 kHz, or null if cancelled / no speech. */
  pcm: Int16Array | null;
  /** Loudest amplitude sample this window (0..1). With `floor`, this is what
   *  a "heard nothing" report needs: whether the mic saw anything at all,
   *  and how far above the room it got. */
  peak: number;
  /** The room's noise level as this window measured it (0..1). */
  floor: number;
};

/**
 * Listen for one utterance. `onLevel` receives live amplitude (for the orb).
 */
export function listenOnce(onLevel: (amp: number) => void): {
  promise: Promise<ListenResult>;
  handle: VadHandle;
} {
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  // startRecording is async and can reject (mic busy / init failure); let that
  // rejection propagate so the caller shows an error instead of a silent mic.
  const promise = (async (): Promise<ListenResult> => {
    await startRecording();
    if (cancelled) {
      stopRecording();
      return { pcm: null, peak: 0, floor: 0 };
    }
    return new Promise<ListenResult>((resolve) => {
      const detector = createTurnDetector({
        ...DEFAULT_VAD,
        initialFloor: lastFloor,
      });

      const finish = (emit: boolean) => {
        if (timer) clearInterval(timer);
        timer = null;
        const pcm = stopRecording();
        lastFloor = detector.roomLevel();
        resolve({
          pcm: emit && !cancelled ? pcm : null,
          peak: detector.peak(),
          floor: lastFloor,
        });
      };

      timer = setInterval(() => {
        if (cancelled) return finish(false);
        const amp = currentAmplitude();
        onLevel(amp);
        const verdict = detector.step(amp, POLL_MS);
        if (verdict === 'end') return finish(true);
        if (verdict === 'no-speech') return finish(false);
      }, POLL_MS);
    });
  })();

  return {
    promise,
    handle: {
      cancel: () => {
        cancelled = true;
      },
    },
  };
}
