// Mic capture for speech-to-text. @fugood/react-native-audio-pcm-stream is a
// STREAMING module: it emits base64 16-bit PCM chunks via the 'data' event and
// its stop() returns void and writes NO file (the published .d.ts claiming
// stop(): Promise<string> + a wavFile output is wrong — verified against the
// native source). So we accumulate the chunks ourselves, expose a live
// amplitude for the waveform UI, and produce a Float32 buffer for whisper.rn's
// transcribeData (16 kHz mono, the format whisper wants — no file, no
// transcoding).
import AudioRecord from '@fugood/react-native-audio-pcm-stream';
import { Buffer } from 'buffer';

let recording = false;
let chunks: Int16Array[] = [];
let subscription: { remove: () => void } | null = null;
let amplitude = 0; // 0..1 RMS of the most recent chunk, for the waveform

function onData(base64: string): void {
  const bytes = Buffer.from(base64, 'base64');
  // Interpret the bytes as little-endian Int16 PCM. RN targets (iOS/Android) are
  // all little-endian ARM, so an Int16 view over the raw bytes is correct — and
  // one native slice+view is far cheaper than readInt16LE per sample (these
  // chunks arrive many times a second). slice() copies out of Buffer's shared
  // pool into a fresh, 2-byte-aligned buffer we own.
  const evenBytes = bytes.byteLength & ~1;
  const samples = new Int16Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + evenBytes),
  );
  chunks.push(samples);

  // RMS amplitude of this chunk, normalized to ~0..1 for the waveform.
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]! / 32768;
    sumSq += v * v;
  }
  amplitude = samples.length ? Math.min(1, Math.sqrt(sumSq / samples.length) * 4) : 0;
}

/** Begin recording. No-op if already recording. Rejects if the mic can't be
 *  initialized — callers must surface that instead of listening to silence. */
export async function startRecording(): Promise<void> {
  if (recording) return;
  chunks = [];
  amplitude = 0;
  await AudioRecord.init({
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    audioSource: 6, // Android VOICE_RECOGNITION — tuned for speech
    wavFile: '', // unused by this streaming lib; we accumulate PCM ourselves
  });
  subscription = AudioRecord.on('data', onData);
  AudioRecord.start();
  recording = true;
}

/** Current mic amplitude (0..1), sampled by the waveform on an interval. */
export function currentAmplitude(): number {
  return recording ? amplitude : 0;
}

/**
 * Stop recording and return the captured audio as one mono Int16Array at
 * 16 kHz (ready to wrap in a WAV for whisper), or null if nothing was
 * captured.
 */
export function stopRecording(): Int16Array | null {
  if (!recording) return null;
  recording = false;
  AudioRecord.stop();
  subscription?.remove();
  subscription = null;

  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (!total) return null;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  chunks = [];
  return out;
}
