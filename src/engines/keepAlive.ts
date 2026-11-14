// JS face of the local keep-alive module (modules/whisper-keepalive/): an
// Android foreground service that holds the process at "perceptible" priority
// while a model is resident off-screen, plus a CPU wake lock for generations
// that outlive the display.
//
// Everything degrades to a no-op returning false where the module is not
// linked (iOS, Expo Go, vitest): callers treat false as "the OS may reclaim us"
// and fall back to releasing the model themselves.
import { requireOptionalNativeModule } from 'expo-modules-core';

type WhisperKeepAliveModule = {
  arm(on: boolean, title: string, text: string): boolean;
  isGuarding(): boolean;
  stop(): boolean;
  setWakeLock(held: boolean, timeoutMs: number): boolean;
  schedule(id: string, delayMs: number): boolean;
  cancel(id: string): boolean;
  addListener(event: 'onTimer', listener: (e: { id: string }) => void): { remove(): void };
};

let native: WhisperKeepAliveModule | null = null;
try {
  native = requireOptionalNativeModule<WhisperKeepAliveModule>('WhisperKeepAlive');
} catch {
  native = null;
}

/** Longest a single wake lock may be held. A generation is bounded well under
 *  this; the timeout exists so a missed release cannot drain a battery. */
const WAKE_LOCK_TIMEOUT_MS = 10 * 60_000;

/**
 * Arm the guard: from now on the foreground service starts natively whenever
 * the app leaves the screen and stops when it returns. The start is native
 * because it must happen inside the activity's onPause — Android 12+ refuses
 * it once the app is actually in the background, and the 'background' event
 * reaches JS too late to be sure of that.
 */
export function armKeepAlive(title: string, text: string): void {
  try {
    native?.arm(true, title, text);
  } catch {
    // unguarded
  }
}

/** Whether the service is up for the current off-screen period. */
export function isGuarding(): boolean {
  try {
    return native?.isGuarding() ?? false;
  } catch {
    return false;
  }
}

/** Take the service down early (the model was released; nothing to guard). */
export function stopKeepAlive(): void {
  try {
    native?.stop();
  } catch {
    // nothing to stop
  }
}

/** Keep the CPU awake for the duration of a generation. */
export function holdWakeLock(held: boolean): void {
  try {
    native?.setWakeLock(held, WAKE_LOCK_TIMEOUT_MS);
  } catch {
    // best-effort
  }
}

// --- off-screen timers ---
// React Native pauses every JS timer while the Android activity is paused
// (JavaTimerManager.onHostPause), so a setTimeout armed on 'background' fires
// only after the user is already back. These are posted natively and arrive as
// events, which ARE delivered while the process is alive.
const timerCallbacks = new Map<string, () => void>();
let listening = false;

/** Whether off-screen timers exist on this platform/build. */
export const hasBackgroundTimers = native !== null;

/** Run `fn` after `delayMs` even if the app is off-screen. One timer per id;
 *  re-arming replaces. Returns false (and arms nothing) without the module. */
export function setBackgroundTimer(id: string, delayMs: number, fn: () => void): boolean {
  if (!native) return false;
  try {
    if (!listening) {
      native.addListener('onTimer', (e) => {
        const cb = timerCallbacks.get(e.id);
        timerCallbacks.delete(e.id);
        cb?.();
      });
      listening = true;
    }
    timerCallbacks.set(id, fn);
    return native.schedule(id, delayMs);
  } catch {
    timerCallbacks.delete(id);
    return false;
  }
}

export function clearBackgroundTimer(id: string): void {
  timerCallbacks.delete(id);
  try {
    native?.cancel(id);
  } catch {
    // nothing armed
  }
}
