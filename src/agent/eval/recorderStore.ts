// The persistence edge for the trajectory recorder: JSONL under the app's
// document directory, bounded, deletable, and exportable by an explicit action.
//
// Split from recorder.ts on purpose — everything about WHAT gets recorded and
// HOW MUCH may survive is pure and unit-tested in Node (recorder.ts); this file
// is only the Expo binding. Same shape as chat/store.ts: module singleton,
// version counter for useSyncExternalStore, debounced writes flushed when the
// app backgrounds, every I/O failure swallowed because a developer capture must
// never be able to break a user's turn.
//
// Layout, on Android:
//   /data/data/com.whisper.app/files/eval/traj-<epoch>.jsonl   (private)
//   /sdcard/Android/data/com.whisper.app/files/whisper-eval/   (export target)
// The first is app-private storage, which is the point: recordings live where
// nothing else on the phone can read them, and only `export()` copies them
// anywhere a cable can reach.
import { ExternalDirectoryPath } from '@dr.pogodin/react-native-fs';
import * as FileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';

import * as Recorder from './recorder';
import type { Trajectory } from './types';

const DIR = `${FileSystem.documentDirectory}eval/`;
/** Where `export()` copies to. Android app-scoped external storage: no runtime
 *  permission, survives `adb pull`, and is removed with the app. Empty string
 *  on iOS, where there is no such location and the caller falls back to Share. */
const EXPORT_DIR = ExternalDirectoryPath ? `file://${ExternalDirectoryPath}/whisper-eval/` : '';

const WRITE_DEBOUNCE_MS = 400;

/** Current session's file, and the lines written to it so far. Held in memory
 *  between debounced flushes exactly as chat/store.ts holds the open
 *  conversation — bounded by `maxFileBytes`, and dropped on roll or clear. */
let currentName: string | null = null;
let currentLines: string[] = [];
let currentBytes = 0;
/** Bumped by `clearAll()`, so a write already in flight knows it has been
 *  overtaken by a delete and drops its payload instead of re-creating it. */
let epoch = 0;

export type CorpusStats = { files: number; bytes: number };
let stats: CorpusStats = { files: 0, bytes: 0 };

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

/** Last known corpus size. Refreshed by `refreshStats()`; the viewer reads it
 *  synchronously so it can render before the directory listing comes back. */
export function getStats(): CorpusStats {
  return stats;
}

/** Where recordings live, for the viewer to show and for the report to cite. */
export function corpusPath(): string {
  return DIR;
}

let initPromise: Promise<void> | null = null;

/**
 * Idempotent. Creates the directory, attaches the recorder's sink, and lands
 * any debounced write before the OS can freeze or kill the process — the same
 * hazard chat/store.ts guards, and worse here because the app is holding a
 * multi-GB model and is the first thing the OS reclaims.
 */
export function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    AppState.addEventListener('change', (s) => {
      if (s !== 'active') void flushWrites();
    });
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
    Recorder.setSink(append);
    await refreshStats();
  })();
  return initPromise;
}

function append(trajectory: Trajectory): void {
  const line = Recorder.toJsonl(trajectory);
  // Roll BEFORE appending, so no single file exceeds the cap and the in-memory
  // buffer stays bounded by it too. The reset is synchronous — flushWrites()
  // snapshots the name and body at entry, so the file being left behind still
  // lands even though the next line already belongs to a new one.
  if (currentName && currentBytes + line.length > Recorder.CORPUS_LIMITS.maxFileBytes) {
    void flushWrites();
    currentName = null;
    currentLines = [];
    currentBytes = 0;
  }
  if (!currentName) currentName = `traj-${Date.now()}.jsonl`;
  currentLines.push(line);
  currentBytes += line.length;
  scheduleWrite();
  emit();
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => void flushWrites(), WRITE_DEBOUNCE_MS);
}

/** Write the session file now and enforce the corpus bound. */
export async function flushWrites(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const name = currentName;
  const body = currentLines.join('');
  const era = epoch;
  if (!name || !body) return;
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  // A delete that landed while this write was in flight wins: the user asked
  // for the corpus to be gone, and re-creating the file they just deleted is
  // the one bug this feature cannot afford.
  if (era !== epoch) return;
  await FileSystem.writeAsStringAsync(DIR + name, body).catch(() => {});
  await enforceBounds();
  await refreshStats();
}

async function listFiles(): Promise<Recorder.CorpusFile[]> {
  const names = await FileSystem.readDirectoryAsync(DIR).catch(() => [] as string[]);
  const files: Recorder.CorpusFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const info = await FileSystem.getInfoAsync(DIR + name).catch(() => null);
    files.push({ name, bytes: info?.exists ? info.size : 0 });
  }
  return files;
}

/** Delete whatever the pure policy says no longer fits. */
async function enforceBounds(): Promise<void> {
  const doomed = Recorder.overflow(await listFiles());
  for (const name of doomed) {
    await FileSystem.deleteAsync(DIR + name, { idempotent: true }).catch(() => {});
  }
}

export async function refreshStats(): Promise<CorpusStats> {
  const files = await listFiles();
  stats = { files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
  emit();
  return stats;
}

/**
 * Copy the corpus somewhere a cable can reach and return that path, or null if
 * there is nothing to export (or no external storage, i.e. iOS).
 *
 * Explicit action, never automatic: recordings leaving app-private storage is
 * the one moment this feature stops being local-only, so it happens on a tap
 * and nowhere else.
 */
export async function exportCorpus(): Promise<string | null> {
  await flushWrites();
  const files = await listFiles();
  if (!files.length || !EXPORT_DIR) return null;
  await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true }).catch(() => {});
  for (const file of files) {
    // copyAsync refuses an existing destination, so a re-export of the same
    // session (the common case while iterating) would otherwise be a silent
    // no-op that hands back a stale file.
    await FileSystem.deleteAsync(EXPORT_DIR + file.name, { idempotent: true }).catch(() => {});
    await FileSystem.copyAsync({ from: DIR + file.name, to: EXPORT_DIR + file.name }).catch(
      () => {},
    );
  }
  return `${ExternalDirectoryPath}/whisper-eval`;
}

/** Read the whole corpus back as text — the fallback share payload, and how a
 *  small capture gets off an iOS device where there is no pullable directory. */
export async function toText(): Promise<string> {
  await flushWrites();
  const files = await listFiles();
  const parts: string[] = [];
  for (const file of files) {
    const raw = await FileSystem.readAsStringAsync(DIR + file.name).catch(() => '');
    if (raw) parts.push(raw);
  }
  return parts.join('');
}

/** Delete every recording. The corpus is the user's raw words; the control that
 *  removes it has to be one tap away from the control that creates it. */
export async function clearAll(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  currentName = null;
  currentLines = [];
  currentBytes = 0;
  epoch++;
  await FileSystem.deleteAsync(DIR, { idempotent: true }).catch(() => {});
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  await refreshStats();
}
