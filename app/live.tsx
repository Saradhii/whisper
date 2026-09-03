// Live voice mode: a hands-free spoken conversation (like ChatGPT voice). Loops
// listen → transcribe → think → speak entirely on-device. The orb reflects the
// current phase; a caption shows the latest transcript/reply. No emoji.
import { Ionicons } from '@expo/vector-icons';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useVoiceAmplitude } from 'expo-thinking-orbs';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { engineFor, type ChatMessage } from '@/src/engines';
import * as ModelManager from '@/src/models/ModelManager';
import { Touchable, useTheme, useThemedStyles, type Colors } from '@/src/theme';
import LiveOrb, { orbLevel, type OrbPhase } from '@/src/voice/LiveOrb';
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
/** Caption repaint interval while streaming. Matches the chat screen's flush. */
const CAPTION_MS = 33;

const MAX_HISTORY = 12; // messages (6 user/assistant turns)

// What the caption says when a listening window ends without a turn. Three
// cases, because they want three different things from the user: the mic
// heard essentially nothing (a peak under 0.02 is recorder hiss — the phone
// is muted, covered, or another app holds the mic); it heard sound that
// never read as speech (too quiet or too far); or it heard speech that
// whisper could not make words of.
const NO_AUDIO_HINT = "I can't hear the microphone. Is another app using it?";
const NO_SPEECH_HINT = "I didn't catch that — try speaking a little closer.";
const NO_WORDS_HINT = "I heard something but couldn't make out words — say it again?";

const CAPTIONS: Record<OrbPhase, string> = {
  connecting: 'Getting ready…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  error: 'Something went wrong',
};

export default function Live() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  // A hands-free conversation must not be ended by the screen dozing off.
  useKeepAwake();
  const [phase, setPhase] = useState<OrbPhase>('connecting');
  // Mic level lives in a SharedValue, not React state: the VAD polls amplitude
  // every 120 ms purely to drive the orb, and routing that through setState
  // re-rendered this whole screen several times a second to animate one shape.
  // The orb reads this on the UI thread; writing it never re-renders.
  const mic = useVoiceAmplitude();
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const vadRef = useRef<VadHandle | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  // The engine driving this session, captured so exit/unmount can interrupt an
  // in-flight generation without re-resolving the active model.
  const stopEngineRef = useRef<(() => void) | null>(null);

  async function run() {
    const active = ModelManager.getActive();
    if (!active) {
      setError('Download a model first.');
      setPhase('error');
      return;
    }
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone access is off. Allow it in Settings to talk to Whisper.');
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
          // The caption is NOT cleared here: a "didn't hear anything" hint from
          // the previous window has to survive into this one, or it would flash
          // for a frame and vanish. It clears on the next transcript.
          const { promise, handle } = listenOnce((amp) => {
            if (aliveRef.current) mic.set(orbLevel(amp));
          });
          vadRef.current = handle;
          const { pcm, peak, floor } = await promise;
          mic.set(0);
          if (!aliveRef.current) return;
          if (!pcm) {
            // No speech — keep listening, but say so. This used to restart
            // silently, and on a phone whose mic never crossed the old fixed
            // threshold that looked like "Listening…" forever with no clue
            // why. The two numbers are the clue: peak is what the mic heard,
            // floor is the room.
            if (__DEV__) console.log(`[live] no speech: peak=${peak.toFixed(3)} floor=${floor.toFixed(3)}`);
            setCaption(peak < 0.02 ? NO_AUDIO_HINT : NO_SPEECH_HINT);
            continue;
          }

          // 2. Transcribe
          setPhase('thinking');
          const text = await SpeechService.transcribe(pcm);
          if (!aliveRef.current) return;
          if (!text.trim()) {
            if (__DEV__) console.log(`[live] empty transcript: peak=${peak.toFixed(3)} floor=${floor.toFixed(3)}`);
            setCaption(NO_WORDS_HINT);
            continue;
          }
          setCaption(text);
          historyRef.current.push({ role: 'user', content: text });

          // 3. Think + speak, streamed sentence-by-sentence: the first sentence
          //    plays while the model is still generating the rest, so the reply
          //    starts sounding out far sooner than waiting for the whole thing.
          const speech = Tts.speakStream(voiceSid);
          let reply = '';
          let started = false;
          try {
            // The caption is repainted on a timer, not per token. Tokens arrive
            // faster than React can paint, and every setCaption here re-renders
            // the screen including the animated orb — stealing JS-thread time
            // from this very callback, which is also what feeds speech.push()
            // and therefore time-to-first-audio. Chat fixed this the same way;
            // live, where latency actually matters, had been left out.
            let captionTimer: ReturnType<typeof setTimeout> | null = null;
            const flushCaption = () => {
              captionTimer = null;
              if (aliveRef.current) setCaption(reply);
            };
            stopEngineRef.current = () => void engineFor(active).stop();
            const res = await engineFor(active).generate(
              [SYSTEM, ...historyRef.current],
              (tok) => {
                reply += tok;
                if (!aliveRef.current) return;
                if (!started) {
                  started = true;
                  setPhase('speaking');
                }
                // Audio is never delayed — only the on-screen text is batched.
                speech.push(tok);
                if (!captionTimer) captionTimer = setTimeout(flushCaption, CAPTION_MS);
              },
              // Spoken replies are one or two sentences — cap tokens so a runaway
              // generation can't stall the conversation.
              { disableThinking: true, maxTokens: 220 },
            );
            if (captionTimer) clearTimeout(captionTimer);
            if (aliveRef.current && reply) setCaption(reply);
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
    // aliveRef alone cannot be observed until engine.generate() resolves, so
    // without this the model keeps decoding up to maxTokens on all four
    // performance cores for a reply nobody will hear — and the chat screen's
    // next message queues behind it. stop() is the documented un-queued
    // exception in LlamaEngine precisely for this.
    stopEngineRef.current?.();
    router.back();
  };

  // A transient failure (mic grab, audio glitch, one bad turn) shouldn't end
  // the session — restart the loop with the conversation so far intact.
  const retry = () => {
    aliveRef.current = true;
    setError(null);
    setPhase('connecting');
    void run();
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
      stopEngineRef.current?.();
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
        <LiveOrb phase={phase} level={mic.level} />
        <Text style={styles.caption} numberOfLines={4}>
          {error ?? (caption || CAPTIONS[phase])}
        </Text>
      </View>

      <View style={styles.controls}>
        {phase === 'error' ? (
          <View style={styles.controlCol}>
            <Touchable
              style={styles.retryBtn}
              onPress={retry}
              accessibilityRole="button"
              accessibilityLabel="Retry live conversation">
              <Ionicons name="refresh-outline" size={26} color={colors.onPrimary} />
            </Touchable>
            <Text style={styles.endLabel}>Retry</Text>
          </View>
        ) : null}
        <View style={styles.controlCol}>
          <Touchable
            style={styles.endBtn}
            onPress={exit}
            accessibilityRole="button"
            accessibilityLabel="End live conversation">
            <Ionicons name="close-outline" size={28} color={colors.onPrimary} />
          </Touchable>
          <Text style={styles.endLabel}>End</Text>
        </View>
      </View>
    </View>
  );
}

const createStyles = (colors: Colors) =>
  StyleSheet.create({
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
    controls: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'center',
      gap: 40,
      paddingBottom: 24,
    },
    controlCol: { alignItems: 'center', gap: 8 },
    endBtn: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    retryBtn: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    endLabel: { color: colors.textSecondary, fontSize: 13 },
  });
