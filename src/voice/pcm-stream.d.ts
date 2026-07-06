// Honest types for @fugood/react-native-audio-pcm-stream. Its published .d.ts
// both (a) declares a differently-named module and (b) LIES about the runtime:
// it claims `stop(): Promise<string>` writing a wavFile, but the native code
// (RNLiveAudioStreamModule.java) makes stop() a fire-and-forget that returns
// nothing and writes no file — it's a pure PCM streamer. Trusting the shipped
// type is what crashed voice input ("startsWith of undefined"). These
// declarations match the ACTUAL native behavior, verified against source.
declare module '@fugood/react-native-audio-pcm-stream' {
  export interface Options {
    sampleRate: number;
    channels: 1 | 2;
    bitsPerSample: 8 | 16;
    audioSource?: number;
    wavFile: string; // accepted but unused by this streaming module
    bufferSize?: number;
  }
  export interface Subscription {
    remove: () => void;
  }
  export interface IAudioRecord {
    /** Resolves once the native AudioRecord is created; rejects if the mic
     *  can't be initialized (e.g. another app holds it). */
    init: (options: Options) => Promise<void>;
    start: () => void;
    /** Fire-and-forget: returns nothing and writes no file. */
    stop: () => void;
    /** Subscribe to base64 PCM16 chunks; returns a removable subscription. */
    on: (event: 'data', callback: (data: string) => void) => Subscription;
  }
  const AudioRecord: IAudioRecord;
  export default AudioRecord;
}
