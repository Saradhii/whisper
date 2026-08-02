// Generation settings: the few knobs a daily user actually benefits from,
// persisted like every other store (JSON + zod, useSyncExternalStore).
import * as FileSystem from 'expo-file-system/legacy';
import { z } from 'zod';

const SettingsSchema = z.object({
  /** Sampling temperature — surfaced as Precise / Balanced / Creative. */
  temperature: z.number().min(0).max(2).catch(0.7),
  /** Reply cap — surfaced as Short / Normal / Long. */
  maxTokens: z.number().int().min(128).max(4096).catch(1024),
  /** Optional extra persona/instructions appended to the system prompt. */
  personaExtra: z.string().max(600).catch(''),
  /** Light / dark / follow the OS. Resolved by ThemeProvider. */
  appearance: z.enum(['light', 'dark', 'system']).catch('system'),
  /** Record agent planning decisions and tool results for the trace viewer.
   *  Off by default — it is a developer surface, and recording is a no-op
   *  until this is on. */
  devTrace: z.boolean().catch(false),
  /** Show each planning decision inline in the chat as a collapsible row.
   *  Independent of devTrace: this one is about the conversation, not the log. */
  showPlanSteps: z.boolean().catch(false),
});

export type Settings = z.infer<typeof SettingsSchema>;

const DEFAULTS: Settings = {
  temperature: 0.7,
  maxTokens: 1024,
  personaExtra: '',
  appearance: 'system',
  devTrace: false,
  showPlanSteps: false,
};
const PATH = FileSystem.documentDirectory + 'settings.json';

let settings: Settings = { ...DEFAULTS };

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVersion(): number {
  return version;
}

export function get(): Settings {
  return settings;
}

let initPromise: Promise<void> | null = null;

export function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const raw = await FileSystem.readAsStringAsync(PATH).catch(() => null);
    if (raw) {
      try {
        const parsed = SettingsSchema.safeParse(JSON.parse(raw));
        if (parsed.success) settings = parsed.data;
      } catch {
        // corrupt file — keep defaults
      }
    }
    emit();
  })();
  return initPromise;
}

export function set(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  void FileSystem.writeAsStringAsync(PATH, JSON.stringify(settings)).catch(() => {});
  emit();
}
