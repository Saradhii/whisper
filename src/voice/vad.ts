// Minimal voice-activity detection for live mode: records, watches the mic's
// amplitude, and resolves with the captured audio once the speaker starts and
// then goes quiet (or a hard cap is hit). Returns null if no speech was heard.
import { currentAmplitude, startRecording, stopRecording } from './recorder';

const POLL_MS = 120;
const SPEECH_ON = 0.12; // amplitude that counts as speaking
const SPEECH_OFF = 0.06; // amplitude below which we count silence
const SILENCE_END_MS = 1000; // trailing silence that ends a turn
const NO_SPEECH_MS = 8000; // give up if the user never speaks
const MAX_MS = 15000; // hard cap on a single turn

export type VadHandle = { cancel: () => void };

/**
 * Listen for one utterance. `onLevel` receives live amplitude (for the orb).
 * Resolves with mono Int16 PCM, or null if cancelled / no speech.
 */
export function listenOnce(
  onLevel: (amp: number) => void,
): { promise: Promise<Int16Array | null>; handle: VadHandle } {
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  // startRecording is async and can reject (mic busy / init failure); let that
  // rejection propagate so the caller shows an error instead of a silent mic.
  const promise = (async (): Promise<Int16Array | null> => {
    await startRecording();
    if (cancelled) {
      stopRecording();
      return null;
    }
    return new Promise<Int16Array | null>((resolve) => {
      let elapsed = 0;
      let speechStarted = false;
      let silence = 0;

      const finish = (emit: boolean) => {
        if (timer) clearInterval(timer);
        timer = null;
        const pcm = stopRecording();
        resolve(emit && !cancelled ? pcm : null);
      };

      timer = setInterval(() => {
        if (cancelled) return finish(false);
        const amp = currentAmplitude();
        onLevel(amp);
        elapsed += POLL_MS;

        if (amp > SPEECH_ON) speechStarted = true;

        if (speechStarted) {
          silence = amp < SPEECH_OFF ? silence + POLL_MS : 0;
          if (silence >= SILENCE_END_MS || elapsed >= MAX_MS) return finish(true);
        } else if (elapsed >= NO_SPEECH_MS) {
          return finish(false); // never heard speech
        }
      }, POLL_MS);
    });
  })();

  return { promise, handle: { cancel: () => {
    cancelled = true;
  } } };
}
