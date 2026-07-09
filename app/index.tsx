import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Ionicons } from '@expo/vector-icons';

import { runAgent, type AgentEvent } from '@/src/agent/loop';
import { TOOLS } from '@/src/agent/tools';
import TypingIndicator from '@/src/chat/TypingIndicator';
import Waveform from '@/src/voice/Waveform';
import { ensureVerified } from '@/src/models/verifyModel';
import { colors } from '@/src/theme';
import * as Tts from '@/src/voice/tts/TtsService';
import * as TtsStore from '@/src/voice/tts/TtsStore';
import { useVoiceInput } from '@/src/voice/useVoiceInput';
import { splitThinking } from '@/src/chat/thinking';
import { engineFor, unloadAll, type ChatMessage } from '@/src/engines';
import * as ModelManager from '@/src/models/ModelManager';

type ToolStatus = 'running' | 'done' | 'denied' | 'error';

// UI message = chat message + optional attached image, or a tool-activity chip.
// `id` is a stable identity so FlatList can reconcile rows (and skip re-rendering
// settled bubbles) as the trailing assistant bubble grows during streaming.
type UiMessage = ChatMessage & {
  id: string;
  image?: string;
  tool?: { label: string; status: ToolStatus };
  error?: boolean;
};

let msgSeq = 0;
const uid = () => `m${++msgSeq}`;

export default function Chat() {
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<UiMessage>>(null);
  useSyncExternalStore(ModelManager.subscribe, ModelManager.getVersion);
  useSyncExternalStore(TtsStore.subscribe, TtsStore.getVersion);
  const tts = TtsStore.get();

  // Which model the engine finished (or failed) loading. `ready`/`loadError`
  // are derived by comparing against the active id, so switching models makes
  // the UI "loading" again without any synchronous setState in the effect.
  const [loadState, setLoadState] = useState<{ id: string; error?: string } | null>(null);
  const [input, setInput] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // True from send until the first visible token (or between a tool finishing
  // and its summary) — drives the typing indicator during CPU prefill.
  const [thinking, setThinking] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const producedRef = useRef(false); // did this turn yield any visible output?
  // Tokens arrive faster than React can paint. Buffer them and flush on an
  // animation-frame cadence so streaming is one cheap update per frame instead
  // of one full-list re-render per token (the main source of chat jank).
  const pendingRef = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Id of the assistant bubble currently streaming — it renders as plain text
  // (markdown is only parsed once, when the turn settles).
  const [streamingId, setStreamingId] = useState<string | null>(null);

  // Voice input: transcribed text is appended to whatever's already typed.
  const voice = useVoiceInput((text) =>
    setInput((prev) => (prev ? `${prev} ${text}` : text)),
  );

  const active = ModelManager.getActive();
  const activeId = active?.id ?? null;
  const ready = loadState?.id === activeId && !loadState?.error;
  const loadError = loadState?.id === activeId ? (loadState?.error ?? null) : null;

  useEffect(() => {
    void ModelManager.init();
    void TtsStore.init();
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, []);

  // (Re)load the engine whenever the active model changes; free native memory
  // when the model is deleted out from under us.
  useEffect(() => {
    let cancelled = false;
    const spec = activeId ? ModelManager.getModel(activeId) : null;
    if (!spec) {
      void unloadAll();
      return;
    }
    engineFor(spec)
      .load(spec, ModelManager.filePaths(spec))
      .then(() => {
        if (cancelled) return;
        setLoadState({ id: spec.id });
        // First load of an uncensored model → run the canary self-test in the
        // background (does not block chat; result drives the header badge).
        void ensureVerified(spec);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoadState({ id: spec.id, error: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const pickImage = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (!res.canceled && res.assets[0]) setImage(res.assets[0].uri);
  };

  // Drain buffered tokens into the trailing assistant bubble in one update
  // (creating the bubble if the last message is a user turn or a tool chip).
  const flushTokens = () => {
    flushTimer.current = null;
    const chunk = pendingRef.current;
    if (!chunk) return;
    pendingRef.current = '';
    setThinking(false); // first token arrived — hide the typing indicator
    producedRef.current = true;
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === 'assistant' && !last.tool) {
        next[next.length - 1] = { ...last, content: last.content + chunk };
        setStreamingId(last.id);
      } else {
        const msg: UiMessage = { id: uid(), role: 'assistant', content: chunk };
        next.push(msg);
        setStreamingId(msg.id);
      }
      return next;
    });
  };

  // Buffer a streamed token; schedule a flush at ~30fps if one isn't pending.
  const appendToken = (token: string) => {
    pendingRef.current += token;
    if (!flushTimer.current) flushTimer.current = setTimeout(flushTokens, 33);
  };

  // Flush any buffered tokens immediately (turn finished / a tool chip is about
  // to be inserted, so ordering stays correct) and end the streaming state.
  const finishStreaming = () => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    flushTokens();
    setStreamingId(null);
  };

  const handleAgentEvent = (e: AgentEvent) => {
    if (e.type === 'token') return appendToken(e.token);
    finishStreaming(); // land any buffered tokens before inserting the chip
    producedRef.current = true;
    // A tool is running (visible chip) → hide typing; once it finishes, the
    // model prefills again for its summary, so show the indicator once more.
    setThinking(e.status !== 'running');
    // Tool chip: update the running chip with the same label, else append one.
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i];
        if (m?.tool && m.tool.label === e.label && m.tool.status === 'running') {
          next[i] = { ...m, tool: { label: e.label, status: e.status } };
          return next;
        }
      }
      next.push({ id: uid(), role: 'assistant', content: '', tool: { label: e.label, status: e.status } });
      return next;
    });
  };

  const confirmAction = (summary: string) =>
    new Promise<boolean>((resolve) => {
      Alert.alert('Allow this action?', summary, [
        { text: 'Deny', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Allow', onPress: () => resolve(true) },
      ]);
    });

  const send = async () => {
    const text = input.trim();
    if ((!text && !image) || busy || !ready || !active) return;

    const attachedImage = image ?? undefined;
    const history: ChatMessage[] = [
      ...messages.filter((m) => !m.tool).map(stripImage),
      { role: 'user', content: text },
    ];
    setMessages((prev) => [...prev, { id: uid(), role: 'user', content: text, image: attachedImage }]);
    setInput('');
    setImage(null);
    setBusy(true);
    setThinking(true); // show the typing indicator immediately during prefill
    producedRef.current = false;

    try {
      if (active.tools && !attachedImage) {
        // Agent path: the model can call phone tools in a loop.
        await runAgent(engineFor(active), TOOLS, history, {
          onEvent: handleAgentEvent,
          confirm: confirmAction,
        });
      } else {
        await engineFor(active).generate(history, appendToken, { imageUri: attachedImage });
      }
      finishStreaming(); // land the last buffered tokens and parse markdown
      // If the model produced nothing visible (e.g. stopped early), say so.
      if (!producedRef.current) {
        setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: '(no response)' }]);
      } else if (tts.enabled && tts.autoSpeak) {
        // Read the completed reply aloud.
        setMessages((prev) => {
          const last = [...prev].reverse().find((m) => m.role === 'assistant' && !m.tool);
          if (last?.content) void Tts.speak(last.content, tts.voiceSid);
          return prev;
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: msg, error: true }]);
    } finally {
      finishStreaming();
      setBusy(false);
      setThinking(false);
    }
  };

  const stop = () => {
    if (active) void engineFor(active).stop();
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text style={styles.title}>Whisper</Text>
          <Text style={styles.subtitle}>
            {!active
              ? 'no model installed'
              : loadError
                ? 'load failed'
                : ready
                  ? `${active.name}${active.vision ? ' · vision' : ''}${active.tools ? ' · tools' : ''} · offline`
                  : 'loading model…'}
          </Text>
        </View>
        {active && ready && active.uncensored ? <UncensoredBadge id={active.id} /> : null}
        {active && ready ? (
          <Pressable
            style={styles.headerIcon}
            onPress={() => router.push('/live')}
            hitSlop={8}
            accessibilityLabel="Live voice mode">
            <Ionicons name="radio-outline" size={22} color={colors.accent} />
          </Pressable>
        ) : null}
        <Pressable
          style={styles.headerIcon}
          onPress={() => router.push('/voice-settings')}
          hitSlop={8}
          accessibilityLabel="Voice settings">
          <Ionicons name="volume-high-outline" size={22} color={colors.accent} />
        </Pressable>
        <Pressable style={styles.modelsBtn} onPress={() => router.push('/models')} hitSlop={8}>
          <Text style={styles.modelsBtnText}>Models</Text>
        </Pressable>
      </View>

      {!active ? (
        <View style={styles.center}>
          <Text style={styles.hint}>Download a model to start chatting — fully on-device.</Text>
          <Pressable style={styles.cta} onPress={() => router.push('/models')}>
            <Text style={styles.ctaText}>Choose a model</Text>
          </Pressable>
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{loadError}</Text>
          <Text style={styles.hint}>Try another model, or delete and re-download this one.</Text>
        </View>
      ) : !ready ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.hint}>loading model…</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          style={styles.flex}
          contentContainerStyle={styles.listContent}
          keyExtractor={(item) => item.id}
          // Bounded batches keep long chats from mounting every past bubble at
          // once (rows are memoized, so off-screen ones stay cheap).
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={11}
          // Non-animated: streaming appends land many times a second, and
          // animated scrolls stack up and fight each other into visible jank.
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) =>
            item.tool ? (
              <ToolChip label={item.tool.label} status={item.tool.status} />
            ) : item.error ? (
              <ErrorBubble content={item.content} />
            ) : item.role === 'user' ? (
              <UserBubble content={item.content} image={item.image} />
            ) : (
              <AssistantBubble
                content={item.content}
                streaming={item.id === streamingId}
                canSpeak={tts.enabled}
                voiceSid={tts.voiceSid}
              />
            )
          }
          ListFooterComponent={thinking ? <TypingIndicator /> : null}
        />
      )}

      <KeyboardAvoidingView behavior="padding">
        {image ? (
          <View style={styles.attachRow}>
            <Image source={{ uri: image }} style={styles.attachThumb} />
            <Pressable onPress={() => setImage(null)}>
              <Text style={styles.attachRemove}>Remove</Text>
            </Pressable>
          </View>
        ) : null}
        {voice.state.status === 'downloading' || voice.state.status === 'error' ? (
          <View style={styles.voiceRow}>
            <Text style={styles.voiceText}>
              {voice.state.status === 'downloading'
                ? `Downloading speech model… ${Math.round(voice.state.progress * 100)}%`
                : voice.state.message}
            </Text>
            {voice.state.status === 'error' ? (
              <Pressable onPress={voice.reset}>
                <Text style={styles.attachRemove}>Dismiss</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {voice.state.status === 'recording' ? (
          // Recording: cancel · live waveform · confirm (stop & transcribe).
          <View style={[styles.inputRow, { paddingBottom: insets.bottom + 8 }]}>
            <Pressable style={styles.iconBtn} onPress={voice.cancel} hitSlop={6}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
            <View style={styles.waveWrap}>
              <Waveform active />
            </View>
            <Pressable style={styles.sendBtn} onPress={voice.stop}>
              <Ionicons name="checkmark" size={20} color={colors.onPrimary} />
            </Pressable>
          </View>
        ) : (
          <View style={[styles.inputRow, { paddingBottom: insets.bottom + 8 }]}>
            {active?.vision ? (
              <Pressable
                style={[styles.iconBtn, (!ready || busy) && styles.sendBtnDisabled]}
                onPress={pickImage}
                disabled={!ready || busy}>
                <Ionicons name="add" size={24} color={colors.text} />
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.iconBtn, (!ready || busy) && styles.sendBtnDisabled]}
              onPress={voice.start}
              disabled={!ready || busy || voice.state.status === 'transcribing'}>
              {voice.state.status === 'transcribing' ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <Ionicons name="mic-outline" size={22} color={colors.text} />
              )}
            </Pressable>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder={
                voice.state.status === 'transcribing'
                  ? 'Transcribing…'
                  : ready
                    ? 'Ask anything…'
                    : 'Loading…'
              }
              placeholderTextColor={colors.textFaint}
              editable={ready && !busy}
              multiline
            />
            <Pressable
              style={[styles.sendBtn, (!ready || busy) && styles.sendBtnDisabled]}
              onPress={busy ? stop : send}>
              <Text style={styles.sendText}>{busy ? 'Stop' : 'Send'}</Text>
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

// Tool-activity chip with a status icon (no emoji). Memoized on primitive props
// so settled chips don't re-render while a later bubble streams.
const ToolChip = memo(function ToolChip({ label, status }: { label: string; status: ToolStatus }) {
  const icon =
    status === 'running'
      ? { name: 'ellipsis-horizontal' as const, color: colors.textSecondary }
      : status === 'done'
        ? { name: 'checkmark-circle' as const, color: '#2e9e5b' }
        : status === 'denied'
          ? { name: 'close-circle' as const, color: colors.textSecondary }
          : { name: 'alert-circle' as const, color: colors.danger };
  const suffix = status === 'denied' ? ' (denied)' : status === 'error' ? ' (failed)' : '';
  return (
    <View style={styles.toolChip}>
      <Ionicons name={icon.name} size={14} color={icon.color} />
      <Text style={styles.toolChipText}>
        {label}
        {suffix}
      </Text>
    </View>
  );
});

// User turn: text and/or an attached image. Memoized (props are primitives).
const UserBubble = memo(function UserBubble({
  content,
  image,
}: {
  content: string;
  image?: string;
}) {
  return (
    <View style={[styles.bubble, styles.user]}>
      {image ? <Image source={{ uri: image }} style={styles.bubbleImage} /> : null}
      {content || !image ? <Text style={styles.userText}>{content || '…'}</Text> : null}
    </View>
  );
});

// Error bubble. Memoized (settled, never re-renders during later streaming).
const ErrorBubble = memo(function ErrorBubble({ content }: { content: string }) {
  return (
    <View style={[styles.bubble, styles.assistant, styles.errorBubble]}>
      <Ionicons name="alert-circle" size={16} color={colors.danger} />
      <Text style={styles.errorBubbleText}>{content}</Text>
    </View>
  );
});

// Header badge reflecting the uncensored canary self-test for the active model.
function UncensoredBadge({ id }: { id: string }) {
  const state = ModelManager.getVerifyState(id);
  const label =
    state === 'pass'
      ? 'uncensored'
      : state === 'fail'
        ? 'refused canary'
        : state === 'pending'
          ? 'verifying…'
          : 'unverified';
  const style =
    state === 'pass'
      ? styles.badgePass
      : state === 'fail'
        ? styles.badgeFail
        : styles.badgeNeutral;
  return (
    <View style={[styles.badge, style]}>
      {state === 'pass' ? <Ionicons name="shield-checkmark" size={11} color="#2e9e5b" /> : null}
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

// Assistant message: hidden reasoning behind a collapsible "Thoughts" toggle
// (visible live while streaming), final answer as markdown, optional speaker.
// Memoized on primitive props so only the actively streaming bubble re-renders.
// While `streaming`, the answer is plain <Text> — markdown is parsed once, when
// the turn settles, instead of re-parsing the whole growing string per frame.
const AssistantBubble = memo(function AssistantBubble({
  content,
  streaming,
  canSpeak,
  voiceSid,
}: {
  content: string;
  streaming: boolean;
  canSpeak: boolean;
  voiceSid: number;
}) {
  const [showThoughts, setShowThoughts] = useState(false);
  const { thinking, answer } = splitThinking(content);
  const stillThinking = thinking !== null && !answer;

  return (
    <View style={[styles.bubble, styles.assistant]}>
      {thinking ? (
        <Pressable style={styles.thoughtsToggle} onPress={() => setShowThoughts((v) => !v)} hitSlop={6}>
          {!stillThinking ? (
            <Ionicons
              name={showThoughts ? 'chevron-down' : 'chevron-forward'}
              size={13}
              color={colors.textSecondary}
            />
          ) : null}
          <Text style={styles.thoughtsLabel}>{stillThinking ? 'Thinking…' : 'Thoughts'}</Text>
        </Pressable>
      ) : null}
      {thinking && (showThoughts || stillThinking) ? (
        <Text style={styles.thoughtsText}>{thinking}</Text>
      ) : null}
      {answer ? (
        streaming ? (
          <Text style={styles.bubbleText}>{answer}</Text>
        ) : (
          <Markdown style={markdownStyles}>{answer}</Markdown>
        )
      ) : !thinking ? (
        <Text style={styles.bubbleText}>…</Text>
      ) : null}
      {canSpeak && answer && !streaming ? (
        <Pressable style={styles.speakBtn} onPress={() => Tts.speak(answer, voiceSid)} hitSlop={6}>
          <Ionicons name="volume-medium-outline" size={16} color={colors.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
});

// Drop the UI-only `image` field and any reasoning before handing history back
// to the model — replaying thoughts wastes context and confuses small models.
const stripImage = ({ role, content }: UiMessage): ChatMessage => ({
  role,
  content: role === 'assistant' ? splitThinking(content).answer : content,
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  modelsBtn: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  modelsBtnText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  headerIcon: { padding: 6, marginRight: 2 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginRight: 8,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgePass: { backgroundColor: '#e7f6ec' },
  badgeFail: { backgroundColor: '#fdeceb' },
  badgeNeutral: { backgroundColor: colors.surface },
  badgeText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  error: { color: colors.danger, textAlign: 'center' },
  hint: { color: colors.textSecondary, fontSize: 12, textAlign: 'center' },
  cta: {
    backgroundColor: colors.primary,
    borderRadius: 18,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  ctaText: { color: colors.onPrimary, fontWeight: '600' },
  listContent: { padding: 12, gap: 10 },
  bubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  user: { alignSelf: 'flex-end', backgroundColor: colors.primary },
  assistant: { alignSelf: 'flex-start', backgroundColor: colors.surface },
  userText: { color: colors.onPrimary, fontSize: 15, lineHeight: 21 },
  bubbleText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  toolChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  toolChipText: { color: colors.textSecondary, fontSize: 12 },
  thoughtsToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  speakBtn: { alignSelf: 'flex-start', marginTop: 6, paddingVertical: 2 },
  errorBubble: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  errorBubbleText: { color: colors.danger, fontSize: 14, lineHeight: 20, flex: 1 },
  thoughtsLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 2 },
  thoughtsText: {
    color: colors.textFaint,
    fontSize: 13,
    lineHeight: 18,
    fontStyle: 'italic',
    marginBottom: 4,
  },
  bubbleImage: { width: 200, height: 200, borderRadius: 10, marginBottom: 6, resizeMode: 'cover' },
  attachRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  attachThumb: { width: 44, height: 44, borderRadius: 8 },
  attachRemove: { color: colors.textSecondary, fontSize: 13 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxHeight: 120,
    fontSize: 15,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  waveWrap: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 18,
    justifyContent: 'center',
  },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  voiceText: { color: colors.textSecondary, fontSize: 13 },
  sendBtn: {
    backgroundColor: colors.primary,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  sendText: { color: colors.onPrimary, fontWeight: '600' },
  sendBtnDisabled: { opacity: 0.4 },
});

// Markdown theme for assistant answers, matched to the light bubble.
const markdownStyles = {
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  paragraph: { marginTop: 0, marginBottom: 6 },
  strong: { fontWeight: '700' as const },
  heading1: { fontSize: 19, fontWeight: '700' as const, marginBottom: 4 },
  heading2: { fontSize: 17, fontWeight: '700' as const, marginBottom: 4 },
  heading3: { fontSize: 15, fontWeight: '700' as const, marginBottom: 4 },
  bullet_list: { marginBottom: 6 },
  ordered_list: { marginBottom: 6 },
  list_item: { marginBottom: 2 },
  code_inline: {
    backgroundColor: '#ebe8f7',
    color: colors.primaryDeep,
    borderRadius: 4,
    paddingHorizontal: 4,
    fontSize: 13,
  },
  code_block: {
    backgroundColor: '#f0eef8',
    color: '#2b2938',
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
  },
  fence: {
    backgroundColor: '#f0eef8',
    color: '#2b2938',
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
  },
  blockquote: {
    backgroundColor: '#f0eef8',
    borderColor: colors.primary,
    borderLeftWidth: 3,
    paddingHorizontal: 10,
    marginBottom: 6,
  },
  link: { color: colors.primary },
  hr: { backgroundColor: colors.border, marginVertical: 8 },
  table: { borderColor: colors.border },
  th: { padding: 6 },
  td: { padding: 6 },
};
