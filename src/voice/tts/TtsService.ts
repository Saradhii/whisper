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
let seq = 0; // cancels stale playback when a newer utterance starts

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
  player.play();
  const rate = audio.sampleRate > 0 ? audio.sampleRate : 24000;
  return audio.samples.length / rate;
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
}

/** Stop any current playback and cancel in-flight synthesis. */
export function stop(): void {
  seq++;
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
