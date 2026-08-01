// App-level engine memory lifecycle. A 3–6 GB resident model makes this
// process the OS's first low-memory kill target the moment it's backgrounded —
// and getting killed loses the conversation AND costs a full cold load on
// return. Instead: shortly after the app backgrounds, save the KV session and
// release the native context (dropping the anonymous RAM the LMK actually
// weighs; the mmap'd weights are already reclaimable). On return, resume
// proactively so the model is warming while the user reads the screen.
//
// Android is the beneficiary — its JS timers keep running in the background
// while the process is alive. On iOS the JS thread is frozen seconds after
// backgrounding, so the timer usually fires on return, at which point 'active'
// cancels it — a harmless no-op (iOS relies on jetsam + the increased-memory
// entitlement instead).
import { AppState } from 'react-native';

import { LlamaEngine } from './LlamaEngine';

// Long enough that quick app-switches (share sheet, notification peek) never
// pay a suspend/resume cycle; short enough to beat the LMK to it.
const GRACE_MS = 15_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

/** Install once from the root layout. */
export function installEngineLifecycle(): void {
  if (installed) return;
  installed = true;

  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void LlamaEngine.resume?.();
    } else if (state === 'background') {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        // Re-checked at queue-execution time too: the suspend may sit behind a
        // long generation, and the user may be back by the time it runs.
        void LlamaEngine.suspend?.(() => AppState.currentState !== 'active');
      }, GRACE_MS);
    }
  });
}
