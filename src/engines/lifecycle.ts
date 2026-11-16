// App-level engine memory lifecycle: what happens to a resident model when the
// app leaves the screen.
//
// The old policy released the whole native context 15 seconds after
// backgrounding, on the theory that a multi-GB process is the low-memory
// killer's first pick. That made every return to the app — from a share sheet,
// the photo picker, a tool's own intent — cost a model re-init plus a KV
// restore, and it did not even buy survival: the process stayed in the
// "cached" bucket, where Android freezes it within seconds and kills it first
// regardless of how little it holds.
//
// The policy now, on Android:
//
//   1. Going to background starts a foreground service (keepAlive.ts; started
//      natively in onPause, the last moment Android still allows it). The
//      process becomes "perceptible": not frozen, not a cached-kill candidate.
//      The model stays loaded, an in-flight generation runs to completion, and
//      coming back is instant.
//   2. After CHECKPOINT_MS off-screen the KV cache is written to disk WITHOUT
//      releasing anything, so even a kill (or a reboot) costs a model load and
//      a file read on the next launch, not a re-prefill of the conversation.
//   3. After RESIDENT_MS off-screen the model is released for real and the
//      service stops — nobody wants a notification guarding RAM overnight. The
//      next visit restores from the checkpoint.
//
// The two delays are armed natively (keepAlive.ts), not with setTimeout: React
// Native pauses every JS timer while the Android activity is paused, so the old
// setTimeout-based suspend only ever fired after the user was already back —
// where 'active' cancelled it. In practice the model was never released and
// never checkpointed; the process simply sat in the cached bucket holding
// everything until it was killed.
//
// Where the service is unavailable (iOS, Expo Go, or Android refusing the
// start) there is no timer to arm either, so the KV cache is checkpointed
// immediately on backgrounding and the model is left resident: the OS may take
// the process, and the checkpoint is what makes that cheap.
import { AppState } from 'react-native';

import {
  armKeepAlive,
  clearBackgroundTimer,
  isGuarding,
  setBackgroundTimer,
  stopKeepAlive,
} from './keepAlive';
import { LlamaEngine } from './LlamaEngine';

/** Off-screen time before the KV cache is checkpointed to disk. Long enough
 *  that quick app-switches never pay a ~100 MB write. */
const CHECKPOINT_MS = 15_000;

/** Off-screen time the model stays resident under the foreground service. */
const RESIDENT_MS = 30 * 60_000;

const CHECKPOINT_TIMER = 'engine-checkpoint';
const RELEASE_TIMER = 'engine-release';

let away = false;
let installed = false;

const stillAway = () => AppState.currentState !== 'active';

/** Install once from the root layout. */
export function installEngineLifecycle(): void {
  if (installed) return;
  installed = true;

  armKeepAlive('Whisper', 'Model kept in memory — ready when you return.');

  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      // (The service itself is stopped natively, in the activity's onResume.)
      away = false;
      clearBackgroundTimer(CHECKPOINT_TIMER);
      clearBackgroundTimer(RELEASE_TIMER);
      void LlamaEngine.resume?.();
      return;
    }
    if (state !== 'background' || away) return;
    // Nothing resident (never loaded, or already released): nothing to guard,
    // so take down the service the native side just started.
    if (!LlamaEngine.isLoaded?.()) {
      stopKeepAlive();
      return;
    }
    away = true;

    // Started natively inside onPause, before this event was even dispatched.
    const guarded = isGuarding();

    const checkpoint = () => {
      if (stillAway()) void LlamaEngine.checkpoint?.();
    };
    if (!guarded || !setBackgroundTimer(CHECKPOINT_TIMER, CHECKPOINT_MS, checkpoint)) {
      checkpoint();
    }
    if (guarded) {
      setBackgroundTimer(RELEASE_TIMER, RESIDENT_MS, () => {
        // Re-checked at queue-execution time too: the suspend may sit behind a
        // long generation, and the user may be back by the time it runs.
        void LlamaEngine.suspend?.(stillAway).finally(() => {
          if (stillAway()) stopKeepAlive();
        });
      });
    }
  });
}
