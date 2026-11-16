// Model manager: owns everything about model files on disk — download with
// progress, cancel, delete, the active-model selection, and user-added custom
// models. Persists its state to a small JSON file; screens subscribe for
// changes via useSyncExternalStore.
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { z } from 'zod';

import { CATALOG, formatBytes, type ModelSpec } from './catalog';
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
  // Model ids with an interrupted/paused download whose .part files should be
  // kept and resumed rather than deleted on startup.
  paused: z.array(z.string()).catch([]),
});

const MODELS_DIR = FileSystem.documentDirectory + 'models/';
const STATE_PATH = FileSystem.documentDirectory + 'model-manager.json';

// Files the pre-catalog versions of the app left at the document root.
const LEGACY_FILES = ['gemma-4-e4b.gguf', 'gemma-4-e4b-mmproj.gguf'];

export type ModelStatus = {
  installed: boolean;
  downloading: boolean;
  /** An interrupted download with .part bytes on disk, resumable. */
  paused: boolean;
  progress: number; // 0..1 while downloading/paused
  bytesWritten: number;
  bytesTotal: number; // 0 when unknown (custom models)
};

export type VerifyState = 'pass' | 'fail' | 'pending' | 'unverified';

type PersistedState = {
  activeId: string | null;
  custom: ModelSpec[];
  verified: Record<string, 'pass' | 'fail'>;
  paused: string[];
};

let state: PersistedState = { activeId: null, custom: [], verified: {}, paused: [] };
// Models whose canary is running this session (not persisted).
const verifying = new Set<string>();
const statuses = new Map<string, ModelStatus>();
const inFlight = new Map<string, FileSystem.DownloadResumable>();

// --- download run tracking ---
// A download is one long async function waiting on a native promise. Pause and
// Cancel used to work only by poking that native call and then WAITING for the
// function to notice and tidy up — so whenever the promise settled late, or
// never, or the tap landed in a gap where no native call was registered yet,
// the row stayed on "downloading" with two buttons that did nothing, until the
// app was force-closed.
//
// Now each download() call is a numbered RUN, and Pause/Cancel settle the
// visible state THEMSELVES, immediately: they bump the number (which detaches
// the old run — it sees it is stale at its next step and returns without
// touching anything) and then write the new status. The UI never again waits
// on the native layer to become responsive.
const runs = new Map<string, number>();
/** Ids with a live (not detached) download run. The source of truth for
 *  `status.downloading` whenever statuses are recomputed from disk. */
const running = new Set<string>();

/** Detach whatever run is in flight for `id` and return its native handle. */
function detachRun(id: string): FileSystem.DownloadResumable | undefined {
  runs.set(id, (runs.get(id) ?? 0) + 1);
  running.delete(id);
  const resumable = inFlight.get(id);
  inFlight.delete(id);
  return resumable;
}

/** Longest Pause/Cancel waits for the native layer before moving on. */
const NATIVE_STOP_TIMEOUT_MS = 4000;

function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

async function partBytes(spec: ModelSpec): Promise<number> {
  const infos = await Promise.all(
    spec.files.map((f) => FileSystem.getInfoAsync(MODELS_DIR + f.filename + '.part')),
  );
  return infos.reduce((sum, i) => sum + (i.exists ? (i.size ?? 0) : 0), 0);
}

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

    // Reclaim space from pre-catalog app versions and orphaned partials.
    // .part files belonging to a paused/interrupted download are KEPT — they
    // resume from the byte they stopped at instead of restarting a multi-GB
    // download from zero.
    for (const f of LEGACY_FILES) {
      await FileSystem.deleteAsync(FileSystem.documentDirectory + f, { idempotent: true });
    }
    const resumable = new Set<string>();
    for (const id of state.paused) {
      const spec = getModel(id);
      if (spec) for (const f of spec.files) resumable.add(f.filename + '.part');
    }
    const entries = await FileSystem.readDirectoryAsync(MODELS_DIR).catch(() => []);
    for (const f of entries) {
      if (f.endsWith('.part') && !resumable.has(f)) {
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
  return (
    statuses.get(id) ?? {
      installed: false,
      downloading: false,
      paused: false,
      progress: 0,
      bytesWritten: 0,
      bytesTotal: 0,
    }
  );
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
    if (!installed && state.paused.includes(spec.id) && !running.has(spec.id)) {
      // Interrupted download: report how far it got so Resume shows progress.
      const partInfos = await Promise.all(
        spec.files.map((f) => FileSystem.getInfoAsync(MODELS_DIR + f.filename + '.part')),
      );
      const bytes =
        infos.reduce((sum, i) => sum + (i.exists ? (i.size ?? 0) : 0), 0) +
        partInfos.reduce((sum, i) => sum + (i.exists ? (i.size ?? 0) : 0), 0);
      statuses.set(spec.id, {
        installed: false,
        downloading: false,
        paused: true,
        progress: spec.sizeBytes > 0 ? Math.min(bytes / spec.sizeBytes, 0.99) : 0,
        bytesWritten: bytes,
        bytesTotal: spec.sizeBytes,
      });
      continue;
    }
    // `downloading` is recomputed, never carried over: a stale `true` here is
    // exactly the stuck row described above.
    statuses.set(spec.id, {
      ...prev,
      installed,
      paused: false,
      downloading: !installed && running.has(spec.id),
    });
  }
}

// --- actions ---
export function setActive(id: string | null): void {
  state.activeId = id;
  void persist();
  emit();
}

// "GGUF" magic bytes, base64-encoded — every model AND mmproj file must start
// with them. Catches truncated downloads and HTML error pages saved as models
// (which otherwise only surface later as an opaque llama.cpp load error).
const GGUF_MAGIC_B64 = 'R0dVRg==';

async function validateGguf(path: string, filename: string): Promise<void> {
  const head = await FileSystem.readAsStringAsync(path, {
    encoding: FileSystem.EncodingType.Base64,
    position: 0,
    length: 4,
  }).catch(() => null);
  if (head !== GGUF_MAGIC_B64) {
    await FileSystem.deleteAsync(path, { idempotent: true });
    throw new Error(
      `${filename} downloaded but isn't a valid model file (the server may have returned an error page). Please try again.`,
    );
  }
}

function setDownloading(id: string, progress: number, bytesWritten: number, bytesTotal: number) {
  statuses.set(id, {
    installed: false,
    downloading: true,
    paused: false,
    progress,
    bytesWritten,
    bytesTotal,
  });
}

// Progress events arrive many times a second; every emit() re-renders every
// subscribed screen. Coalesce to ~4 fps — plenty for a progress bar.
const lastProgressEmit = new Map<string, number>();
function emitProgress(id: string): void {
  const now = Date.now();
  if (now - (lastProgressEmit.get(id) ?? 0) < 250) return;
  lastProgressEmit.set(id, now);
  emit();
}

/**
 * Download every missing file for `spec`, reporting combined progress. Files
 * land as `.part` and are renamed on success, so an interrupted download never
 * masquerades as an installed model. Interrupted/paused downloads keep their
 * .part bytes and resume from that offset (HTTP Range) on Android.
 *
 * Resolves quietly when paused or cancelled. Rejects on a real failure — and
 * in that case the bytes already on disk are KEPT and the row is left paused,
 * so a dropped connection 150 MB into a multi-GB file costs a tap on Resume,
 * not the 150 MB.
 */
export async function download(spec: ModelSpec): Promise<void> {
  const status = getStatus(spec.id);
  if (status.downloading || status.installed) return;

  const run = (runs.get(spec.id) ?? 0) + 1;
  runs.set(spec.id, run);
  running.add(spec.id);
  /** False once Pause/Cancel (or a newer run) has taken this download over. */
  const live = () => runs.get(spec.id) === run;

  const already = status.bytesWritten;
  // Shown immediately — before the storage check and the state write below —
  // so there is no window in which the row still offers "Download".
  setDownloading(spec.id, status.progress, already, spec.sizeBytes);
  emit();

  try {
    // Refuse a download that cannot fit. `sizeBytes` is 0 (unknown) for custom
    // models — those proceed unchecked.
    if (spec.sizeBytes > 0) {
      const free = await FileSystem.getFreeDiskStorageAsync().catch(() => null);
      const needed = spec.sizeBytes - already + 500 * 1024 * 1024; // keep 500 MB headroom
      if (free != null && free < needed) {
        throw new Error(
          `Not enough storage: this model needs ${formatBytes(spec.sizeBytes - already)} more, but only ${formatBytes(free)} is free. Delete another model or free up space first.`,
        );
      }
    }
    if (!live()) return;

    // Persist "download in flight" BEFORE starting so a killed app resumes
    // instead of restarting from zero.
    if (!state.paused.includes(spec.id)) {
      state.paused = [...state.paused, spec.id];
      await persist();
    }

    for (let i = 0; i < spec.files.length; i++) {
      const file = spec.files[i]!;
      const finalPath = MODELS_DIR + file.filename;
      const partPath = finalPath + '.part';
      if ((await FileSystem.getInfoAsync(finalPath)).exists) continue;

      // Resume from existing .part bytes. On Android, resumeData is the byte
      // offset sent as a Range header and the file is opened in append mode.
      // iOS resumeData is an opaque NSURLSession blob we can't synthesize, so
      // iOS restarts the file.
      const partInfo = await FileSystem.getInfoAsync(partPath);
      let resumeFrom = 0;
      if (partInfo.exists && (partInfo.size ?? 0) > 0) {
        if (Platform.OS === 'android') {
          resumeFrom = partInfo.size ?? 0;
        } else {
          await FileSystem.deleteAsync(partPath, { idempotent: true });
        }
      }
      if (!live()) return;

      const resumable = FileSystem.createDownloadResumable(
        file.url,
        partPath,
        {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          if (!live()) return; // a late event from a run that was paused/cancelled
          const fileProgress =
            totalBytesExpectedToWrite > 0 ? totalBytesWritten / totalBytesExpectedToWrite : 0;
          setDownloading(
            spec.id,
            (i + fileProgress) / spec.files.length,
            totalBytesWritten,
            spec.sizeBytes > 0 ? spec.sizeBytes : totalBytesExpectedToWrite,
          );
          emitProgress(spec.id);
        },
        resumeFrom > 0 ? String(resumeFrom) : undefined,
      );
      inFlight.set(spec.id, resumable);

      const result = resumeFrom > 0 ? await resumable.resumeAsync() : await resumable.downloadAsync();
      if (!live()) return;
      inFlight.delete(spec.id);
      // No result without a pause/cancel of ours: the transfer was torn down
      // underneath us. Treated as an interruption, like any network failure.
      if (!result) throw new Error(`The download of ${file.filename} was interrupted.`);
      if (resumeFrom > 0 && result.status === 200) {
        // Server ignored the Range request and re-sent the whole file, which
        // got APPENDED to the partial — the .part is now corrupt. Scrap it.
        await FileSystem.deleteAsync(partPath, { idempotent: true });
        throw new Error(
          `The server restarted ${file.filename} from the beginning; the partial file was discarded. Please try again.`,
        );
      }
      if (result.status !== 200 && result.status !== 206) {
        // An error page, not model bytes: never keep it as a partial.
        await FileSystem.deleteAsync(partPath, { idempotent: true });
        throw new Error(`Download failed for ${file.filename} (HTTP ${result.status}).`);
      }
      await validateGguf(partPath, file.filename);
      await FileSystem.moveAsync({ from: partPath, to: finalPath });
      if (!live()) return;
    }

    running.delete(spec.id);
    state.paused = state.paused.filter((id) => id !== spec.id);
    await persist();
    statuses.set(spec.id, {
      installed: true,
      downloading: false,
      paused: false,
      progress: 1,
      bytesWritten: spec.sizeBytes,
      bytesTotal: spec.sizeBytes,
    });
    // First successful download becomes the active model automatically.
    if (!state.activeId || !getActive()) setActive(spec.id);
    emit();
  } catch (e) {
    // Paused or cancelled while we were awaiting: that call already settled
    // the state, and whatever the native layer threw on its way down is noise.
    if (!live()) return;
    running.delete(spec.id);
    inFlight.delete(spec.id);
    // A real failure. Keep whatever bytes made it to disk and leave the row
    // paused so Resume continues from there; with nothing on disk there is
    // nothing to resume, so drop back to a plain "Download".
    if ((await partBytes(spec)) === 0) {
      state.paused = state.paused.filter((id) => id !== spec.id);
      await persist();
    }
    await refreshStatuses();
    emit();
    throw e;
  }
}

/** Stop the network transfer but keep the bytes — resumable via download(). */
export async function pauseDownload(id: string): Promise<void> {
  if (!getStatus(id).downloading) return;
  const resumable = detachRun(id);
  // The row leaves "downloading" NOW; the native teardown is awaited only so
  // the byte count shown is final, and only for a bounded time.
  statuses.set(id, { ...getStatus(id), downloading: false, paused: true });
  emit();
  if (resumable) {
    await settleWithin(
      resumable.pauseAsync().catch(() => resumable.cancelAsync().catch(() => {})),
      NATIVE_STOP_TIMEOUT_MS,
    );
  }
  if (!state.paused.includes(id)) {
    state.paused = [...state.paused, id];
    await persist();
  }
  await refreshStatuses();
  emit();
}

/** Abandon a download entirely, deleting any partial bytes. */
export async function cancelDownload(id: string): Promise<void> {
  const resumable = detachRun(id);
  const idle: ModelStatus = {
    installed: false,
    downloading: false,
    paused: false,
    progress: 0,
    bytesWritten: 0,
    bytesTotal: 0,
  };
  statuses.set(id, idle);
  emit();
  if (resumable) {
    await settleWithin(resumable.cancelAsync().catch(() => {}), NATIVE_STOP_TIMEOUT_MS);
  }
  state.paused = state.paused.filter((p) => p !== id);
  await persist();
  const spec = getModel(id);
  if (spec) {
    for (const f of spec.files) {
      await FileSystem.deleteAsync(MODELS_DIR + f.filename + '.part', { idempotent: true });
    }
  }
  statuses.set(id, idle);
  await refreshStatuses();
  emit();
}

/** Delete a model's files. Clears the active selection if it pointed here. */
export async function remove(spec: ModelSpec): Promise<void> {
  for (const f of spec.files) {
    await FileSystem.deleteAsync(MODELS_DIR + f.filename, { idempotent: true });
  }
  statuses.set(spec.id, {
    installed: false,
    downloading: false,
    paused: false,
    progress: 0,
    bytesWritten: 0,
    bytesTotal: 0,
  });
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
  statuses.set(id, {
    installed: false,
    downloading: false,
    paused: false,
    progress: 0,
    bytesWritten: 0,
    bytesTotal: 0,
  });
  void persist();
  emit();
  return spec;
}
