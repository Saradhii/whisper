// Model manager: owns everything about model files on disk — download with
// progress, cancel, delete, the active-model selection, and user-added custom
// models. Persists its state to a small JSON file; screens subscribe for
// changes via useSyncExternalStore.
import * as FileSystem from 'expo-file-system/legacy';
import { z } from 'zod';

import { CATALOG, type ModelSpec } from './catalog';
import type { ModelFiles } from '@/src/engines/types';

// Boundary schema for the persisted state file: a hand-edited or corrupted
// file (or a stale shape from an older app version) degrades gracefully
// instead of crashing startup. Invalid custom entries are dropped.
const ModelSpecSchema: z.ZodType<ModelSpec> = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  engine: z.literal('llama'),
  files: z.array(
    z.object({
      key: z.enum(['model', 'mmproj']),
      url: z.string(),
      filename: z.string(),
    }),
  ),
  sizeBytes: z.number(),
  minRamBytes: z.number(),
  vision: z.boolean(),
  tools: z.boolean().optional(),
  nCtx: z.number(),
  stop: z.array(z.string()).optional(),
  custom: z.boolean().optional(),
});

const PersistedSchema = z.object({
  activeId: z.string().nullable().catch(null),
  custom: z
    .array(z.unknown())
    .catch([])
    .transform((list) => list.flatMap((m) => (ModelSpecSchema.safeParse(m).success ? [m as ModelSpec] : []))),
  // Canary results for uncensored models, keyed by model id.
  verified: z.record(z.string(), z.enum(['pass', 'fail'])).catch({}),
});

const MODELS_DIR = FileSystem.documentDirectory + 'models/';
const STATE_PATH = FileSystem.documentDirectory + 'model-manager.json';

// Files the pre-catalog versions of the app left at the document root.
const LEGACY_FILES = ['gemma-4-e4b.gguf', 'gemma-4-e4b-mmproj.gguf'];

export type ModelStatus = {
  installed: boolean;
  downloading: boolean;
  progress: number; // 0..1 while downloading
};

export type VerifyState = 'pass' | 'fail' | 'pending' | 'unverified';

type PersistedState = {
  activeId: string | null;
  custom: ModelSpec[];
  verified: Record<string, 'pass' | 'fail'>;
};

let state: PersistedState = { activeId: null, custom: [], verified: {} };
// Models whose canary is running this session (not persisted).
const verifying = new Set<string>();
const statuses = new Map<string, ModelStatus>();
const inFlight = new Map<string, FileSystem.DownloadResumable>();

// --- change notification (useSyncExternalStore contract) ---
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

// --- init & persistence ---
let initPromise: Promise<void> | null = null;

/** Idempotent. Loads persisted state, cleans up legacy/partial files. */
export function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true }).catch(() => {});

    const raw = await FileSystem.readAsStringAsync(STATE_PATH).catch(() => null);
    if (raw) {
      try {
        const parsed = PersistedSchema.safeParse(JSON.parse(raw));
        if (parsed.success) state = parsed.data;
      } catch {
        // corrupt state file — start fresh
      }
    }

    // Reclaim space from pre-catalog app versions and interrupted downloads.
    for (const f of LEGACY_FILES) {
      await FileSystem.deleteAsync(FileSystem.documentDirectory + f, { idempotent: true });
    }
    const entries = await FileSystem.readDirectoryAsync(MODELS_DIR).catch(() => []);
    for (const f of entries) {
      if (f.endsWith('.part')) {
        await FileSystem.deleteAsync(MODELS_DIR + f, { idempotent: true });
      }
    }

    await refreshStatuses();
    emit();
  })();
  return initPromise;
}

async function persist(): Promise<void> {
  await FileSystem.writeAsStringAsync(STATE_PATH, JSON.stringify(state));
}

// --- queries ---
export function allModels(): ModelSpec[] {
  return [...CATALOG, ...state.custom];
}

export function getModel(id: string): ModelSpec | undefined {
  return allModels().find((m) => m.id === id);
}

export function getStatus(id: string): ModelStatus {
  return statuses.get(id) ?? { installed: false, downloading: false, progress: 0 };
}

export function getActive(): ModelSpec | null {
  if (!state.activeId) return null;
  const spec = getModel(state.activeId);
  return spec && getStatus(spec.id).installed ? spec : null;
}

/** Canary verification state for an (uncensored) model. */
export function getVerifyState(id: string): VerifyState {
  if (verifying.has(id)) return 'pending';
  return state.verified[id] ?? 'unverified';
}

/** Record a completed canary result and persist it. */
export function setVerifyResult(id: string, passed: boolean): void {
  verifying.delete(id);
  state.verified[id] = passed ? 'pass' : 'fail';
  void persist();
  emit();
}

/** Mark a model's canary as in-progress (session-only). */
export function markVerifying(id: string): void {
  verifying.add(id);
  emit();
}

/** Local paths (no file:// prefix) for a downloaded model, keyed for the engine. */
export function filePaths(spec: ModelSpec): ModelFiles {
  const path = (filename: string) => (MODELS_DIR + filename).replace('file://', '');
  const model = spec.files.find((f) => f.key === 'model')!;
  const mmproj = spec.files.find((f) => f.key === 'mmproj');
  return { model: path(model.filename), mmproj: mmproj ? path(mmproj.filename) : undefined };
}

async function refreshStatuses(): Promise<void> {
  for (const spec of allModels()) {
    const infos = await Promise.all(
      spec.files.map((f) => FileSystem.getInfoAsync(MODELS_DIR + f.filename)),
    );
    const installed = infos.every((i) => i.exists);
    const prev = getStatus(spec.id);
    statuses.set(spec.id, { ...prev, installed });
  }
}

// --- actions ---
export function setActive(id: string | null): void {
  state.activeId = id;
  void persist();
  emit();
}

/**
 * Download every missing file for `spec`, reporting combined progress. Files
 * land as `.part` and are renamed on success, so an interrupted download never
 * masquerades as an installed model.
 */
export async function download(spec: ModelSpec): Promise<void> {
  if (getStatus(spec.id).downloading || getStatus(spec.id).installed) return;
  statuses.set(spec.id, { installed: false, downloading: true, progress: 0 });
  emit();

  try {
    for (let i = 0; i < spec.files.length; i++) {
      const file = spec.files[i]!;
      const finalPath = MODELS_DIR + file.filename;
      const partPath = finalPath + '.part';
      if ((await FileSystem.getInfoAsync(finalPath)).exists) continue;

      const resumable = FileSystem.createDownloadResumable(
        file.url,
        partPath,
        {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          const fileProgress =
            totalBytesExpectedToWrite > 0 ? totalBytesWritten / totalBytesExpectedToWrite : 0;
          statuses.set(spec.id, {
            installed: false,
            downloading: true,
            progress: (i + fileProgress) / spec.files.length,
          });
          emit();
        },
      );
      inFlight.set(spec.id, resumable);

      const result = await resumable.downloadAsync();
      inFlight.delete(spec.id);
      // undefined result = cancelled via cancelDownload()
      if (!result) throw new CancelledError();
      if (result.status !== 200) {
        throw new Error(`Download failed for ${file.filename} (HTTP ${result.status}).`);
      }
      await FileSystem.moveAsync({ from: partPath, to: finalPath });
    }

    statuses.set(spec.id, { installed: true, downloading: false, progress: 1 });
    // First successful download becomes the active model automatically.
    if (!state.activeId || !getActive()) setActive(spec.id);
    emit();
  } catch (e) {
    inFlight.delete(spec.id);
    for (const f of spec.files) {
      await FileSystem.deleteAsync(MODELS_DIR + f.filename + '.part', { idempotent: true });
    }
    await refreshStatuses();
    emit();
    if (!(e instanceof CancelledError)) throw e;
  }
}

class CancelledError extends Error {}

export async function cancelDownload(id: string): Promise<void> {
  const resumable = inFlight.get(id);
  if (resumable) await resumable.cancelAsync().catch(() => {});
}

/** Delete a model's files. Clears the active selection if it pointed here. */
export async function remove(spec: ModelSpec): Promise<void> {
  for (const f of spec.files) {
    await FileSystem.deleteAsync(MODELS_DIR + f.filename, { idempotent: true });
  }
  statuses.set(spec.id, { installed: false, downloading: false, progress: 0 });
  if (state.activeId === spec.id) state.activeId = null;
  if (spec.custom) state.custom = state.custom.filter((m) => m.id !== spec.id);
  await persist();
  emit();
}

/** Register a user-supplied GGUF (with optional mmproj for vision). */
export function addCustom(input: { name: string; modelUrl: string; mmprojUrl?: string }): ModelSpec {
  const modelUrl = input.modelUrl.trim();
  const mmprojUrl = input.mmprojUrl?.trim() || undefined;
  for (const url of [modelUrl, mmprojUrl]) {
    if (url === undefined) continue;
    const clean = url.split('?')[0] ?? '';
    if (!/^https?:\/\//.test(url) || !clean.toLowerCase().endsWith('.gguf')) {
      throw new Error('URLs must be direct http(s) links to .gguf files.');
    }
  }

  const id = `custom-${Date.now().toString(36)}`;
  const basename = (url: string) =>
    decodeURIComponent((url.split('?')[0] ?? '').split('/').pop() ?? 'model.gguf');
  const spec: ModelSpec = {
    id,
    name: input.name.trim() || basename(modelUrl).replace(/\.gguf$/i, ''),
    description: 'Custom GGUF · runs on llama.cpp',
    engine: 'llama',
    files: [
      { key: 'model', url: modelUrl, filename: `${id}-${basename(modelUrl)}` },
      ...(mmprojUrl
        ? [{ key: 'mmproj' as const, url: mmprojUrl, filename: `${id}-${basename(mmprojUrl)}` }]
        : []),
    ],
    sizeBytes: 0,
    minRamBytes: 0,
    vision: !!mmprojUrl,
    nCtx: 2048,
    custom: true,
  };

  state.custom = [...state.custom, spec];
  statuses.set(id, { installed: false, downloading: false, progress: 0 });
  void persist();
  emit();
  return spec;
}
