// Curated Kokoro-82M voices. Kokoro exposes voices by speaker id (sid); these
// are the strongest-regarded ones from the standard sherpa-onnx Kokoro v1.0
// voice order. The Preview button in settings is the source of truth — users
// pick by ear — but names/descriptions match the real Kokoro voices.
export type Voice = {
  sid: number;
  name: string;
  description: string;
};

export const VOICES: Voice[] = [
  { sid: 3, name: 'Aria', description: 'Warm American female' },
  { sid: 2, name: 'Bella', description: 'Bright American female' },
  { sid: 6, name: 'Nicole', description: 'Soft American female' },
  { sid: 16, name: 'Michael', description: 'Natural American male' },
  { sid: 14, name: 'Fenrir', description: 'Deep American male' },
  { sid: 18, name: 'Puck', description: 'Lively American male' },
  { sid: 21, name: 'Emma', description: 'British female' },
  { sid: 26, name: 'George', description: 'British male' },
];

export const DEFAULT_VOICE_SID = 3; // Aria

/** The line spoken when previewing a voice in settings. */
export const PREVIEW_TEXT = "Hi, I'm Whisper. This is how I sound — pick the voice you like best.";
