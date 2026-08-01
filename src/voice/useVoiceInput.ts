// Hook driving the mic button: permission → record → stop → transcribe locally.
// Exposes a small state machine the chat screen renders (idle / recording /
// transcribing / downloading-model) plus start/stop actions. All on-device.
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useCallback, useRef, useState } from 'react';

import { startRecording, stopRecording } from './recorder';
import { isModelDownloaded, loadWhisper, transcribe } from './SpeechService';

export type VoiceState =
  | { status: 'idle' }
  | { status: 'downloading'; progress: number } // first-use model fetch
  | { status: 'recording' }
  | { status: 'transcribing' }
  | { status: 'error'; message: string; canOpenSettings?: boolean };

export function useVoiceInput(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceState>({ status: 'idle' });
  const activeRef = useRef(false);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setState({
          status: 'error',
          message: 'Microphone access is off. Allow it in Settings to talk to Whisper.',
          canOpenSettings: true,
        });
        return;
      }
      // Pre-fetch the whisper model on first use so recording isn't wasted if
      // the download fails; show progress while it lands.
      if (!(await isModelDownloaded())) {
        await loadWhisper((p) =>
          setState(
            p.phase === 'downloading'
              ? { status: 'downloading', progress: p.progress }
              : { status: 'transcribing' },
          ),
        );
      }
      await startRecording();
      activeRef.current = true;
      setState({ status: 'recording' });
    } catch (e) {
      activeRef.current = false;
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const stop = useCallback(async () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setState({ status: 'transcribing' });
    try {
      const pcm = stopRecording();
      if (!pcm || pcm.length === 0) {
        setState({ status: 'idle' });
        return;
      }
      const text = await transcribe(pcm);
      if (text) onText(text);
      setState({ status: 'idle' });
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [onText]);

  /** Cancel recording without transcribing. */
  const cancel = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    stopRecording();
    setState({ status: 'idle' });
  }, []);

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  return { state, start, stop, cancel, reset };
}
