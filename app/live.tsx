// Live voice mode: a hands-free spoken conversation (like ChatGPT voice). Loops
// listen → transcribe → think → speak entirely on-device. The orb reflects the
// current phase; a caption shows the latest transcript/reply. No emoji.
import { Ionicons } from '@expo/vector-icons';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { engineFor, type ChatMessage } from '@/src/engines';
import * as ModelManager from '@/src/models/ModelManager';
import { colors } from '@/src/theme';
import LiveOrb, { type OrbPhase } from '@/src/voice/LiveOrb';
import * as SpeechService from '@/src/voice/SpeechService';
import * as Tts from '@/src/voice/tts/TtsService';
import * as TtsSettings from '@/src/voice/tts/TtsStore';
import { listenOnce, type VadHandle } from '@/src/voice/vad';

const SYSTEM: ChatMessage = {
  role: 'system',
  content:
    'You are Whisper in a spoken voice conversation. Reply in one or two short, ' +
    'natural sentences — conversational, not a list. No markdown, no emoji.',
};

// Keep only the most recent turns in the prompt. Live sessions run for many
// turns; an unbounded history grows the prompt (and KV cache) every turn until
// it overflows the 4096-token context. Spoken replies are short, so a few
// turns of context is plenty.
const MAX_HISTORY = 12; // messages (6 user/assistant turns)

const CAPTIONS: Record<OrbPhase, string> = {
  connecting: 'Getting ready…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  error: 'Something went wrong',
};

export default function Live() {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<OrbPhase>('connecting');
  const [level, setLevel] = useState(0);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const vadRef = useRef<VadHandle | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);

  async function run() {
    const active = ModelManager.getActive();
    if (!active) {
      setError('Download a model first.');
      setPhase('error');
      return;
    }
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone permission denied.');
      setPhase('error');
      return;
    }
    await TtsSettings.init();
    const voiceSid = TtsSettings.get().voiceSid;
    // Release any audio player left over from the voice-settings preview: a
    // live AudioPlayer holding the output session crashes AudioRecord when we
    // start listening. Then warm up STT only — the TTS model loads lazily on
    // the first spoken reply, so recording never runs during TTS setup.
    Tts.stop();
    try {
      await SpeechService.loadWhisper();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
      return;
    }

    try {
      while (aliveRef.current) {
        try {
          // 1. Listen (release any playback first so the mic gets a clean session)
          Tts.stop();
          setPhase('listening');
          setCaption('');
          const { promise, handle } = listenOnce((amp) => aliveRef.current && setLevel(amp));
          vadRef.current = handle;
          const pcm = await promise;
          setLevel(0);
          if (!aliveRef.current) return;
          if (!pcm) continue; // no speech — keep listening

          // 2. Transcribe
          setPhase('thinking');
          const text = await SpeechService.transcribe(pcm);
          if (!aliveRef.current) return;
          if (!text.trim()) continue;
          setCaption(text);
          historyRef.current.push({ role: 'user', content: text });

          // 3. Think + speak, streamed sentence-by-sentence: the first sentence
          //    plays while the model is still generating the rest, so the reply
          //    starts sounding out far sooner than waiting for the whole thing.
          const speech = Tts.speakStream(voiceSid);
          let reply = '';
          let started = false;
          try {
            const res = await engineFor(active).generate(
              [SYSTEM, ...historyRef.current],
              (tok) => {
                reply += tok;
                if (!aliveRef.current) return;
                if (!started) {
                  started = true;
                  setPhase('speaking');
                }
                setCaption(reply);
                speech.push(tok);
              },
              // Spoken replies are one or two sentences — cap tokens so a runaway
              // generation can't stall the conversation.
              { disableThinking: true, maxTokens: 220 },
            );
            // Grammar/non-streaming fallback: use the final text if nothing streamed.
            if (!reply.trim() && res.text) {
              reply = res.text;
              setPhase('speaking');
              setCaption(reply);
              speech.push(res.text);
            }
          } catch (e) {
            speech.cancel();
            throw e;
          }
          if (!aliveRef.current) {
            speech.cancel();
            return;
          }
          historyRef.current.push({ role: 'assistant', content: reply });
          if (historyRef.current.length > MAX_HISTORY) {
            historyRef.current.splice(0, historyRef.current.length - MAX_HISTORY);
          }

          // 4. Wait for all queued speech to finish before listening again.
          await speech.end();
          if (!aliveRef.current) return;
        } catch (e) {
          return fail(e); // any turn error → error screen, never a crash
        }
      }
    } finally {
      // Back to chat: free the voice models so a large chat model gets its RAM
      // headroom back. Both reload lazily on the next voice use.
      void SpeechService.unloadWhisper();
      void Tts.unload();
    }
  }

  function fail(e: unknown) {
    if (!aliveRef.current) return;
    setError(e instanceof Error ? e.message : String(e));
    setPhase('error');
  }

  const exit = () => {
    aliveRef.current = false;
    vadRef.current?.cancel();
    Tts.stop();
    router.back();
  };

  useEffect(() => {
    aliveRef.current = true;
    // Defer so the loop's first setState isn't synchronous within the effect.
    const id = setTimeout(() => void run(), 0);
    return () => {
      clearTimeout(id);
      aliveRef.current = false;
      vadRef.current?.cancel();
      Tts.stop();
    };
    // run once on mount; the conversation loop is controlled by aliveRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.top}>
        <Text style={styles.title}>Live</Text>
      </View>

      <View style={styles.center}>
        <LiveOrb phase={phase} level={level} />
        <Text style={styles.caption} numberOfLines={4}>
          {error ?? (caption || CAPTIONS[phase])}
        </Text>
      </View>

      <View style={styles.controls}>
        <Pressable style={styles.endBtn} onPress={exit} accessibilityLabel="End live conversation">
          <Ionicons name="close" size={28} color={colors.onPrimary} />
        </Pressable>
        <Text style={styles.endLabel}>End</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center' },
  top: { paddingVertical: 12 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 40, paddingHorizontal: 32 },
  caption: {
    color: colors.textSecondary,
    fontSize: 17,
    lineHeight: 24,
    textAlign: 'center',
    minHeight: 72,
  },
  controls: { alignItems: 'center', gap: 8, paddingBottom: 24 },
  endBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endLabel: { color: colors.textSecondary, fontSize: 13 },
});
