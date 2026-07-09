// On-device text-to-speech via sherpa-onnx + Kokoro-82M. The Kokoro model is
// downloaded once through the library's model registry (like our LLM/whisper
// downloads), the engine is created lazily, and generated PCM is written to a
// WAV and played through expo-audio. Voice = Kokoro speaker id (sid).
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import {
  ensureModelByCategory,
  getLocalModelPathByCategory,
  isModelDownloadedByCategory,
  ModelCategory,
  refreshModelsByCategory,
  subscribeDownloadProgress,
  type TtsModelMeta,
} from 'react-native-sherpa-onnx/download';
import { createTTS, saveAudioToFile, type TtsEngine } from 'react-native-sherpa-onnx/tts';

import { splitThinking } from '@/src/chat/thinking';

let modelId: string | null = null;
let engine: TtsEngine | null = null;
let engineLoading: Promise<TtsEngine> | null = null;
let player: AudioPlayer | null = null;
let playerWavPath: string | null = null; // deleted when its playback is stopped
let seq = 0; // cancels stale playback when a newer utterance starts
let clipSeq = 0; // unique suffix for streamed clips so their wavs never collide
let activeStream: { cancel: () => void } | null = null; // live streaming session

export type TtsDownloadProgress = { progress: number }; // 0..1

/**
 * Resolve the Kokoro TTS model id from the library's registry. Must use
 * refreshModelsByCategory (which fetches + caches from the sherpa-onnx GitHub
 * release) — listModelsByCategory only reads the cache and is empty on first run.
 */
async function kokoroId(): Promise<string> {
  if (modelId) return modelId;
  let models: TtsModelMeta[] = [];
  try {
    models = (await refreshModelsByCategory(ModelCategory.Tts)) as TtsModelMeta[];
  } catch {
    throw new Error("Couldn't reach the voice catalog. Check your connection and try again.");
  }
  const kokoros = models.filter((m) => m.type === 'kokoro');
  if (!kokoros.length) {
    throw new Error("Couldn't reach the voice catalog. Check your connection and try again.");
  }
  // Prefer the int8 multi-lang v1.0 build (~86 MB) whose voice order matches
  // our voice list; then any int8 Kokoro; then any Kokoro.
  const pick =
    kokoros.find((m) => m.id.includes('int8') && m.id.includes('multi-lang-v1_0')) ??
    kokoros.find((m) => m.id.includes('int8')) ??
    kokoros[0]!;
  modelId = pick.id;
  return pick.id;
}

export async function isDownloaded(): Promise<boolean> {
  return isModelDownloadedByCategory(ModelCategory.Tts, await kokoroId());
}

/** Download the Kokoro model (once), reporting progress. */
export async function ensureModel(onProgress?: (p: TtsDownloadProgress) => void): Promise<void> {
  const id = await kokoroId();
  if (await isModelDownloadedByCategory(ModelCategory.Tts, id)) return;
  const unsub = onProgress
    ? subscribeDownloadProgress((_category, mId, progress) => {
        if (mId === id) onProgress({ progress: progress.percent / 100 });
      })
    : undefined;
  try {
    await ensureModelByCategory(ModelCategory.Tts, id);
  } finally {
    unsub?.();
  }
}

async function getEngine(): Promise<TtsEngine> {
  if (engine) return engine;
  if (engineLoading) return engineLoading;
  engineLoading = (async () => {
    const id = await kokoroId();
    await ensureModel();
    const path = await getLocalModelPathByCategory(ModelCategory.Tts, id);
    if (!path) throw new Error('Kokoro model files are missing.');
    engine = await createTTS({ modelPath: { type: 'file', path }, modelType: 'kokoro' });
    return engine;
  })();
  engineLoading.catch(() => {
    engineLoading = null;
  });
  return engineLoading;
}

// Strip markdown / reasoning so the spoken text is clean prose.
function speakable(text: string): string {
  return splitThinking(text)
    .answer.replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/[*_#`>~|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Synthesize `text` with the given voice and play it. Cancels any prior audio.
 * Resolves with the playback duration in seconds (0 if nothing was spoken), so
 * callers (e.g. live mode) can wait for speech to finish before continuing.
 */
export async function speak(text: string, sid: number): Promise<number> {
  const clean = speakable(text);
  if (!clean) return 0;
  activeStream?.cancel(); // a one-shot supersedes any live stream
  activeStream = null;
  const mine = ++seq;
  const eng = await getEngine();
  if (mine !== seq) return 0; // superseded while the engine loaded
  const audio = await eng.generateSpeech(clean, { sid });
  if (mine !== seq) return 0; // superseded while synthesizing
  const wavPath = `${FileSystem.cacheDirectory}tts-${mine}.wav`;
  await saveAudioToFile(audio, wavPath.replace('file://', ''));
  await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  if (mine !== seq) return 0;
  stopPlayer(); // stop the previous utterance's audio, keep our seq ownership
  player = createAudioPlayer(wavPath);
  playerWavPath = wavPath;
  player.play();
  const rate = audio.sampleRate > 0 ? audio.sampleRate : 24000;
  return audio.samples.length / rate;
}

// Play one wav to completion. Resolves on the real playback-finished event, or
// a duration-based fallback if the event never fires. `onEnd` is exposed so a
// cancel can cut playback short and settle the promise immediately.
function playToEnd(
  wavPath: string,
  durationS: number,
  register: (cancel: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const p = createAudioPlayer(wavPath);
    let sub: { remove: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        sub?.remove();
      } catch {
        // listener already gone
      }
      try {
        p.remove();
      } catch {
        // player already released
      }
      void FileSystem.deleteAsync(wavPath, { idempotent: true }).catch(() => {});
      resolve();
    };
    register(cleanup); // let the queue abort this clip on cancel
    sub = p.addListener('playbackStatusUpdate', (s: { didJustFinish?: boolean }) => {
      if (s?.didJustFinish) cleanup();
    });
    // Fallback so a missed finish event never hangs the live loop.
    timer = setTimeout(cleanup, durationS * 1000 + 400);
    p.play();
  });
}

// Pull complete sentences out of a running buffer. Anything after the last
// sentence terminator stays buffered until more text arrives (or end()).
function takeSentences(buf: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let rest = buf;
  const re = /^[\s\S]*?(?:[.!?\n]+|.{160,}?\s)/;
  let m = re.exec(rest);
  while (m) {
    done.push(m[0]);
    rest = rest.slice(m[0].length);
    m = re.exec(rest);
  }
  return { done, rest };
}

export type SpeechStream = {
  /** Feed streamed reply text; complete sentences are spoken as they form. */
  push: (delta: string) => void;
  /** No more text — resolves once everything queued has finished playing. */
  end: () => Promise<void>;
  /** Abort synthesis and playback immediately. */
  cancel: () => void;
};

/**
 * Stream speech sentence-by-sentence: the first sentence starts playing while
 * the model is still generating the rest, cutting time-to-first-audio in live
 * mode from "whole reply" down to "first sentence". Only one stream (or one-shot
 * speak) is active at a time.
 */
export function speakStream(sid: number): SpeechStream {
  activeStream?.cancel();
  const mine = ++seq;
  stopPlayer();
  const owns = () => mine === seq;

  let buffer = '';
  const queue: string[] = [];
  let ended = false;
  let working = false;
  let cancelled = false;
  let drained: (() => void) | null = null;
  let cancelClip: (() => void) | null = null;

  const finishIfDrained = () => {
    if (!working && queue.length === 0 && (ended || cancelled) && drained) {
      const done = drained;
      drained = null;
      done();
    }
  };

  async function work(): Promise<void> {
    if (working) return;
    working = true;
    try {
      while (queue.length && owns() && !cancelled) {
        const clean = speakable(queue.shift()!);
        if (!clean) continue;
        const eng = await getEngine();
        if (!owns() || cancelled) break;
        const audio = await eng.generateSpeech(clean, { sid });
        if (!owns() || cancelled) break;
        const wavPath = `${FileSystem.cacheDirectory}tts-${mine}-${clipSeq++}.wav`;
        await saveAudioToFile(audio, wavPath.replace('file://', ''));
        await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
        if (!owns() || cancelled) {
          void FileSystem.deleteAsync(wavPath, { idempotent: true }).catch(() => {});
          break;
        }
        const rate = audio.sampleRate > 0 ? audio.sampleRate : 24000;
        await playToEnd(wavPath, audio.samples.length / rate, (c) => (cancelClip = c));
        cancelClip = null;
      }
    } finally {
      working = false;
      finishIfDrained();
    }
  }

  const stream: SpeechStream = {
    push(delta: string) {
      if (cancelled || !owns()) return;
      buffer += delta;
      const { done, rest } = takeSentences(buffer);
      buffer = rest;
      if (done.length) {
        queue.push(...done);
        void work();
      }
    },
    end() {
      return new Promise<void>((resolve) => {
        if (!cancelled && owns() && buffer.trim()) {
          queue.push(buffer);
          buffer = '';
          void work();
        }
        ended = true;
        drained = resolve;
        finishIfDrained();
      });
    },
    cancel() {
      cancelled = true;
      cancelClip?.();
      cancelClip = null;
      queue.length = 0;
      if (activeStream === stream) activeStream = null;
      finishIfDrained();
    },
  };
  activeStream = stream;
  return stream;
}

/** Release the current audio player without cancelling in-flight synthesis. */
function stopPlayer(): void {
  if (player) {
    try {
      player.remove();
    } catch {
      // player already released
    }
    player = null;
  }
  // Every utterance writes its own WAV; without this they accumulate in the
  // cache directory forever (one per spoken reply).
  if (playerWavPath) {
    void FileSystem.deleteAsync(playerWavPath, { idempotent: true }).catch(() => {});
    playerWavPath = null;
  }
}

/** Stop any current playback and cancel in-flight synthesis (one-shot or stream). */
export function stop(): void {
  seq++;
  activeStream?.cancel();
  activeStream = null;
  stopPlayer();
}

/** Free the engine (e.g. under memory pressure). */
export async function unload(): Promise<void> {
  stop();
  if (engine) {
    await engine.destroy().catch(() => {});
    engine = null;
  }
  engineLoading = null;
}
