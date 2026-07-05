// Persisted TTS settings: whether spoken output is enabled, whether to auto-
// speak every assistant reply, and the chosen voice. Small JSON file + a
// useSyncExternalStore subscription, mirroring ModelManager.
import * as FileSystem from 'expo-file-system/legacy';
import { z } from 'zod';

import { DEFAULT_VOICE_SID } from './voices';

const STATE_PATH = FileSystem.documentDirectory + 'tts-settings.json';

const Schema = z.object({
  enabled: z.boolean().catch(false),
  autoSpeak: z.boolean().catch(false),
  voiceSid: z.number().int().catch(DEFAULT_VOICE_SID),
});
type Settings = z.infer<typeof Schema>;

let state: Settings = { enabled: false, autoSpeak: false, voiceSid: DEFAULT_VOICE_SID };

let version = 0;
const listeners = new Set<() => void>();
function emit(): void {
  version++;
  listeners.forEach((l) => l());
}
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getVersion(): number {
  return version;
}

let initPromise: Promise<void> | null = null;
export function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const raw = await FileSystem.readAsStringAsync(STATE_PATH).catch(() => null);
    if (raw) {
      const parsed = Schema.safeParse(JSON.parse(raw));
      if (parsed.success) state = parsed.data;
    }
    emit();
  })();
  return initPromise;
}

async function persist(): Promise<void> {
  await FileSystem.writeAsStringAsync(STATE_PATH, JSON.stringify(state));
}

export function get(): Settings {
  return state;
}

export function setEnabled(enabled: boolean): void {
  state = { ...state, enabled };
  void persist();
  emit();
}
export function setAutoSpeak(autoSpeak: boolean): void {
  state = { ...state, autoSpeak };
  void persist();
  emit();
}
export function setVoice(voiceSid: number): void {
  state = { ...state, voiceSid };
  void persist();
  emit();
}
