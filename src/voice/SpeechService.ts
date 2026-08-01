// On-device speech-to-text via whisper.rn (whisper.cpp — same ggml stack as
// llama.rn). The whisper model is downloaded once (like the LLMs), cached, and
// loaded lazily on first use. Transcription is batch: record a 16 kHz mono WAV,
// hand the path to whisper. Only one whisper context is held; it's released
// under memory pressure via unload().
import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import { initWhisper, type WhisperContext } from 'whisper.rn';

const SAMPLE_RATE = 16000;
const WAV_PATH = FileSystem.cacheDirectory + 'whisper-input.wav';

/** Wrap mono 16-bit PCM in a canonical 44-byte WAV header (base64). This is
 *  the format whisper.cpp reads reliably — far more robust than handing it a
 *  raw typed-array buffer, which produced hallucinated/garbage transcripts. */
function buildWavBase64(pcm: Int16Array, sampleRate: number): string {
  const dataLen = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(1, 22); // channels = mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (sampleRate * blockAlign)
  buf.writeUInt16LE(2, 32); // block align (channels * bytesPerSample)
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  // Bulk-copy the PCM bytes in one shot. The Int16Array is already little-endian
  // in memory on ARM (all RN targets), matching the WAV layout — no per-sample
  // writeInt16LE loop (that ran up to ~240k times for a 15 s utterance).
  Buffer.from(pcm.buffer, pcm.byteOffset, dataLen).copy(buf, 44);
  return buf.toString('base64');
}

// base q5_1: multilingual, ~56 MB, good accuracy/speed balance on phone CPU.
const WHISPER_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin';
const WHISPER_PATH = FileSystem.documentDirectory + 'whisper-base-q5_1.bin';

export type STTProgress = { phase: 'downloading' | 'loading'; progress: number };

let context: WhisperContext | null = null;
let loading: Promise<WhisperContext> | null = null;

export async function isModelDownloaded(): Promise<boolean> {
  return (await FileSystem.getInfoAsync(WHISPER_PATH)).exists;
}

/** Ensure the whisper model is downloaded and a context is loaded. */
export function loadWhisper(onProgress?: (p: STTProgress) => void): Promise<WhisperContext> {
  if (context) return Promise.resolve(context);
  if (loading) return loading;

  loading = (async () => {
    const info = await FileSystem.getInfoAsync(WHISPER_PATH);
    if (!info.exists) {
      const partPath = WHISPER_PATH + '.part';
      const dl = FileSystem.createDownloadResumable(
        WHISPER_URL,
        partPath,
        {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          const progress =
            totalBytesExpectedToWrite > 0 ? totalBytesWritten / totalBytesExpectedToWrite : 0;
          onProgress?.({ phase: 'downloading', progress });
        },
      );
      const res = await dl.downloadAsync();
      if (!res || res.status !== 200) {
        await FileSystem.deleteAsync(partPath, { idempotent: true });
        throw new Error(`Speech model download failed (status ${res?.status ?? 'unknown'}).`);
      }
      await FileSystem.moveAsync({ from: partPath, to: WHISPER_PATH });
    }

    onProgress?.({ phase: 'loading', progress: 1 });
    context = await initWhisper({ filePath: WHISPER_PATH.replace('file://', '') });
    return context;
  })();

  // Reset the shared promise if this attempt fails, so a retry can start clean.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Transcribe captured mono 16-bit PCM (16 kHz) to text via a WAV file. */
export async function transcribe(pcm: Int16Array, language = 'en'): Promise<string> {
  const ctx = await loadWhisper();
  const wavBase64 = buildWavBase64(pcm, SAMPLE_RATE);
  await FileSystem.writeAsStringAsync(WAV_PATH, wavBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const { promise } = ctx.transcribe(WAV_PATH.replace('file://', ''), {
    language,
    maxThreads: 4,
  });
  const { result } = await promise;
  await FileSystem.deleteAsync(WAV_PATH, { idempotent: true });
  return typeof result === 'string' ? result.trim() : '';
}

/** Free the whisper context (e.g. under memory pressure while an LLM loads). */
export async function unloadWhisper(): Promise<void> {
  if (context) {
    await context.release();
    context = null;
  }
  loading = null;
}
