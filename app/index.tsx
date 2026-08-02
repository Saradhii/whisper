import * as Device from 'expo-device';
import * as ImagePicker from 'expo-image-picker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Ionicons } from '@expo/vector-icons';

import { parseDecision } from '@/src/agent/grammar';
import { runAgent, type AgentEvent } from '@/src/agent/loop';
import { TOOL_PROMPT_RESERVE } from '@/src/agent/prompt';
import { TOOLS } from '@/src/agent/tools';
import * as Trace from '@/src/agent/trace';
import DrawerMenu from '@/src/chat/DrawerMenu';
import TypingIndicator from '@/src/chat/TypingIndicator';
import Waveform from '@/src/voice/Waveform';
import { ensureVerified } from '@/src/models/verifyModel';
import { useTheme, useThemedStyles, type Colors } from '@/src/theme';
import * as Tts from '@/src/voice/tts/TtsService';
import * as TtsStore from '@/src/voice/tts/TtsStore';
import { useVoiceInput } from '@/src/voice/useVoiceInput';
import { splitThinking } from '@/src/chat/thinking';
import { estimateTokens, trimToBudget, type CountedMessage } from '@/src/chat/historyBudget';
import * as ChatStore from '@/src/chat/store';
import { engineFor, unloadAll, type ChatMessage, type Engine } from '@/src/engines';
import { humanizeLoadError } from '@/src/models/loadErrors';
import * as ModelManager from '@/src/models/ModelManager';
import * as Settings from '@/src/settings/store';

// The transcript row model and every transition over it live in chat/rows.ts —
// pure functions on an array, so the mutations (a confirmation card becoming a
// running chip becoming a settled one) are unit-tested rather than buried in
// setState updaters where they silently swallowed the model's answer.
import {
  appendText,
  applyToolEvent,
  cancelConfirms,
  isMachinery,
  resolveConfirm,
  toStored,
  type ToolStatus,
  type UiMessage,
} from '@/src/chat/rows';

// Message ids are prefixed with a per-launch tag so ids minted this session
// can never collide with ids restored from a previous session's conversation.
let msgSeq = 0;
const launchTag = Date.now().toString(36);
const uid = () => `m${launchTag}-${++msgSeq}`;

// Stable system prompt for the plain-chat path (agent turns build their own).
// Date only, no time-of-day: llama.cpp reuses the KV cache for the longest
// byte-stable prompt prefix, so a changing prefix would force a full re-prefill
// every single turn. User instructions are equally stable between edits.
const chatSystemPrompt = (now: Date, personaExtra: string) =>
  `You are Whisper, a helpful, private assistant running fully on the user's phone. ` +
  `Today's date is ${now.toISOString().slice(0, 10)}. Be concise and natural.` +
  (personaExtra.trim() ? `\nUser instructions: ${personaExtra.trim()}` : '');

// Context budget: leave room for the reply and the system/tool scaffolding.
// An agent turn's scaffolding is much larger than a chat turn's — the tool
// catalog, the worked examples, and the decisions and results the loop appends
// as it goes — so its reserve is owned by the prompt module that produces it.
const historyBudget = (nCtx: number, tools: boolean, maxTokens: number) =>
  Math.max(512, nCtx - (tools ? TOOL_PROMPT_RESERVE : Math.max(768, maxTokens + 256)));

// First-chat suggestions: make capabilities discoverable — nothing else in the
// UI tells the user the assistant can touch alarms, calendar, or the web.
const SUGGESTIONS_TOOLS = [
  'Set an alarm for 7 tomorrow morning',
  "What's on my calendar this week?",
  'Remind me to stretch in an hour',
  'Search the web for tonight’s match result',
];
const SUGGESTIONS_PLAIN = [
  'Help me draft a polite email',
  'Explain something complicated simply',
  'Give me a dinner idea from basic pantry stuff',
  'Write a short bedtime story',
];

export default function Chat() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<UiMessage>>(null);
  useSyncExternalStore(ModelManager.subscribe, ModelManager.getVersion);
  useSyncExternalStore(TtsStore.subscribe, TtsStore.getVersion);
  useSyncExternalStore(ChatStore.subscribe, ChatStore.getVersion);
  useSyncExternalStore(Settings.subscribe, Settings.getVersion);
  const tts = TtsStore.get();

  // Which model the engine finished (or failed) loading. `ready`/`loadError`
  // are derived by comparing against the active id, so switching models makes
  // the UI "loading" again without any synchronous setState in the effect.
  const [loadState, setLoadState] = useState<{ id: string; error?: string } | null>(null);
  // Keyed by model id (like loadState) so switching models resets the readout
  // without a synchronous setState in the load effect.
  const [loadProgress, setLoadProgress] = useState<{ id: string; p: number } | null>(null);
  const [input, setInput] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Stable so the drawer's own callbacks don't change identity every render.
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
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
  // Text of the trailing assistant bubble this turn (reset when a tool chip or
  // new turn starts a fresh bubble) — used for auto-speak without reading
  // React state from inside an updater.
  const lastBubbleTextRef = useRef('');
  // Cooperative cancellation for the agent loop (engine.stop only interrupts
  // the CURRENT completion; this flag stops the loop from continuing after it).
  const abortRef = useRef({ aborted: false });
  // Tokenizer counts per settled message, so history budgeting doesn't re-count
  // the whole conversation every send.
  const tokenCounts = useRef(new Map<string, number>());

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
    void ChatStore.init();
    void Settings.init();
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, []);

  // Restore / switch conversations. State is adjusted during render (the
  // documented React pattern for syncing state to an external value) so the
  // list always matches the open conversation, including first restore after
  // ChatStore.init() resolves.
  const convId = ChatStore.getCurrentId();
  const [syncedConv, setSyncedConv] = useState<string | null | undefined>(undefined);
  if (syncedConv !== convId) {
    setSyncedConv(convId);
    const restored = ChatStore.getCurrentMessages();
    setMessages(restored.map((m) => ({ ...m })));
  }

  // A CPU generation can run for minutes; if the screen sleeps, Android
  // suspends the JS thread and the turn stalls. Hold a wake lock while busy.
  useEffect(() => {
    if (!busy) return;
    void activateKeepAwakeAsync('generation');
    return () => {
      void deactivateKeepAwake('generation');
    };
  }, [busy]);

  // Persist at turn boundaries: when idle, and when a user message is added
  // (so an outgoing message survives even if generation takes the app down).
  // Token streaming (busy, assistant last) deliberately doesn't hit disk.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!busy || last?.role === 'user') {
      ChatStore.saveCurrent(messages.flatMap(toStored));
    }
  }, [messages, busy]);

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
      .load(spec, ModelManager.filePaths(spec), (p) => {
        if (!cancelled) setLoadProgress({ id: spec.id, p });
      })
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
    lastBubbleTextRef.current += chunk;
    const newId = uid(); // minted outside the updater — updaters must be pure
    setMessages((prev) => appendText(prev, chunk, newId));
  };

  // Buffer a streamed token; schedule a flush at ~30fps if one isn't pending.
  const appendToken = (token: string) => {
    pendingRef.current += token;
    if (!flushTimer.current) flushTimer.current = setTimeout(flushTokens, 33);
  };

  // Flush any buffered tokens immediately (turn finished / a tool chip is about
  // to be inserted, so ordering stays correct).
  const finishStreaming = () => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    flushTokens();
  };

  // Close out the current assistant bubble so a non-prose row (chip, plan step,
  // confirmation) lands after it in the right order. Deliberately does NOT set
  // producedRef — a turn that emitted only planning rows and then died still
  // owes the user the "I didn't manage to reply" notice.
  const breakBubble = () => {
    finishStreaming(); // land any buffered tokens first
    lastBubbleTextRef.current = '';
  };

  const handleAgentEvent = (e: AgentEvent) => {
    if (e.type === 'token') return appendToken(e.token);

    if (e.type === 'plan') {
      // Planning happens during prefill, before anything visible — keep the
      // typing indicator up, the decision row is not an answer. Read straight
      // from the store, not the render scope: this runs inside a closure the
      // agent loop captured at send time, so a render-scope read would be
      // stale for the rest of the turn.
      if (!Settings.get().showPlanSteps) return;
      breakBubble();
      const id = uid();
      setMessages((prev) => [
        ...prev,
        { id, role: 'assistant', content: '', plan: { step: e.step, text: e.text, forced: e.forced } },
      ]);
      return;
    }

    breakBubble();
    producedRef.current = true; // a tool chip is real output for this turn
    // A tool is running (visible chip) → hide typing; once it finishes, the
    // model prefills again for its summary, so show the indicator once more.
    setThinking(e.status !== 'running');
    const newId = uid(); // minted outside the updater — updaters must be pure
    setMessages((prev) => applyToolEvent(prev, e, newId));
  };

  // Inline confirmation: an Allow/Deny card in the transcript rather than a
  // native modal. The promise resolvers live in a ref keyed by row id — an
  // unresolved one would leave the agent loop, and therefore the whole chat,
  // stuck busy forever, so stop() drains them and every path resolves exactly
  // once.
  const confirmResolvers = useRef(new Map<string, (allow: boolean) => void>());

  const confirmAction = (summary: string, name: string) =>
    new Promise<boolean>((resolve) => {
      const id = uid();
      confirmResolvers.current.set(id, resolve);
      breakBubble();
      producedRef.current = true;
      setThinking(false); // the ball is in the user's court, not the model's
      setMessages((prev) => [
        ...prev,
        { id, role: 'assistant', content: '', confirm: { name, label: summary } },
      ]);
    });

  // Answer a pending card: resolve the loop's promise and convert the row in
  // place into the tool chip it becomes, so the transcript reads as one item.
  const answerConfirm = useCallback((id: string, allow: boolean) => {
    const resolve = confirmResolvers.current.get(id);
    if (!resolve) return;
    confirmResolvers.current.delete(id);
    setMessages((prev) => resolveConfirm(prev, id, allow));
    setThinking(allow);
    resolve(allow);
  }, []);

  // Tokenizer count for a settled message, cached by message id. Falls back to
  // a length estimate if the engine can't count (or errors).
  const countTokens = async (engine: Engine, id: string, content: string): Promise<number> => {
    const hit = tokenCounts.current.get(id);
    if (hit !== undefined) return hit;
    const n = engine.countTokens
      ? await engine.countTokens(content).catch(() => estimateTokens(content))
      : estimateTokens(content);
    tokenCounts.current.set(id, n);
    return n;
  };

  // Takes the text explicitly rather than reading `input`, so a suggestion chip
  // can send its own text in one tap — routing it through setInput would only
  // be readable on the next render.
  const sendText = async (text: string, attachedImage?: string) => {
    if ((!text && !attachedImage) || busy || !ready || !active) return;
    const userMsg: UiMessage = { id: uid(), role: 'user', content: text, image: attachedImage };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setImage(null);
    await runModel([...messages, userMsg], attachedImage);
  };

  const send = () => void sendText(input.trim(), image ?? undefined);

  // Drop the trailing assistant turn(s) and answer the last user message again.
  const regenerate = () => {
    if (busy || !ready || !active) return;
    let idx = messages.length - 1;
    while (idx >= 0 && !(messages[idx]!.role === 'user' && !isMachinery(messages[idx]!))) idx--;
    if (idx < 0) return;
    const kept = messages.slice(0, idx + 1);
    setMessages(kept);
    void runModel(kept, messages[idx]!.image);
  };

  // One model turn: `turnMessages` ends with the user message to answer.
  const runModel = async (turnMessages: UiMessage[], attachedImage?: string) => {
    if (!active) return;
    const engine = engineFor(active);
    setBusy(true);
    setThinking(true); // show the typing indicator immediately during prefill
    producedRef.current = false;
    lastBubbleTextRef.current = '';
    abortRef.current = { aborted: false };
    Trace.startTurn(); // group this turn's steps in the trace viewer

    try {
      const useTools = !!active.tools && !attachedImage;
      // Budget the history to the model's context window (see historyBudget.ts
      // for why trims are rare-but-large: KV-cache prefix reuse).
      const source = turnMessages.filter((m) => !isMachinery(m));
      const counted: CountedMessage<ChatMessage>[] = [];
      for (const m of source) {
        const stripped = stripImage(m);
        counted.push({ message: stripped, tokens: await countTokens(engine, m.id, stripped.content) });
      }
      const prefs = Settings.get();
      const history = trimToBudget(
        counted,
        historyBudget(active.nCtx, useTools, prefs.maxTokens),
      );

      if (useTools) {
        // Agent path: the model can call phone tools in a loop.
        await runAgent(engine, TOOLS, history, {
          onEvent: handleAgentEvent,
          confirm: confirmAction,
          signal: abortRef.current,
        });
      } else {
        await engine.generate(
          [{ role: 'system', content: chatSystemPrompt(new Date(), prefs.personaExtra) }, ...history],
          appendToken,
          {
            imageUri: attachedImage,
            temperature: prefs.temperature,
            maxTokens: prefs.maxTokens,
          },
        );
      }
      finishStreaming(); // land the last buffered tokens and parse markdown
      // If the model produced nothing visible (e.g. stopped early), say so —
      // unless the user stopped it themselves.
      if (!producedRef.current && !abortRef.current.aborted) {
        setMessages((prev) => [
          ...prev,
          { id: uid(), role: 'assistant', content: 'I didn’t manage to produce a reply — please try again.', error: true },
        ]);
      } else if (tts.enabled && tts.autoSpeak) {
        // Read the completed reply aloud (reasoning stripped).
        const answer = splitThinking(lastBubbleTextRef.current).answer;
        if (answer) void Tts.speak(answer, tts.voiceSid);
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
    abortRef.current.aborted = true; // agent loop exits between steps
    // A card still waiting on the user would hold the loop open forever —
    // stopping counts as declining.
    for (const [id, resolve] of confirmResolvers.current) {
      confirmResolvers.current.delete(id);
      resolve(false);
    }
    setMessages(cancelConfirms);
    if (active) void engineFor(active).stop(); // interrupt the current completion
  };

  // Only follow the stream when the user is already at the bottom — otherwise
  // they're reading history and auto-scroll would rip the view away from them.
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const onListScroll = (e: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    const atBottom = distance < 80;
    atBottomRef.current = atBottom;
    setShowJump((prev) => (prev === !atBottom ? prev : !atBottom));
  };
  const jumpToEnd = () => {
    atBottomRef.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated: true });
  };

  const bubbleActions = (item: UiMessage) => {
    const text = item.role === 'assistant' ? splitThinking(item.content).answer : item.content;
    if (!text) return;
    Alert.alert(
      'Message',
      text.length > 120 ? `${text.slice(0, 120)}…` : text,
      [
        { text: 'Copy', onPress: () => void Clipboard.setStringAsync(text) },
        { text: 'Share', onPress: () => void Share.share({ message: text }) },
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true },
    );
  };

  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && !isMachinery(m))?.id;

  // The trailing assistant bubble renders as plain <Text> while the turn is
  // busy; markdown is parsed once, when the turn settles. Derived — no state
  // to keep in sync from inside updaters.
  const streamingId = busy ? (lastAssistantId ?? null) : null;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          style={styles.menuBtn}
          onPress={() => setDrawerOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Menu: chats, settings and models">
          <Ionicons name="menu-outline" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.flex}>
          <Text style={styles.title}>Whisper</Text>
          <View style={styles.statusRow}>
            <Text style={styles.subtitle} numberOfLines={1}>
              {!active
                ? 'no model installed'
                : loadError
                  ? 'load failed'
                  : ready
                    ? `${modelLabel(active)}${active.vision ? ' · vision' : ''}${active.tools ? ' · tools' : ''} · offline`
                    : 'loading model…'}
            </Text>
            {active && ready && active.uncensored ? <UncensoredBadge id={active.id} /> : null}
          </View>
        </View>
        {active && ready ? (
          <Pressable
            style={styles.headerIcon}
            onPress={() => router.push('/live')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Live voice mode">
            {/* Circled, unlike the composer's bare mic-outline: the ring is what
                separates "start a hands-free conversation" from "dictate into
                the box", since both live on this screen. */}
            <Ionicons name="mic-circle-outline" size={26} color={colors.accent} />
          </Pressable>
        ) : null}
      </View>

      <DrawerMenu open={drawerOpen} onClose={closeDrawer} />

      {!active ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Your private AI assistant</Text>
          <View style={styles.onboardRows}>
            <View style={styles.onboardRow}>
              <Ionicons name="lock-closed-outline" size={20} color={colors.primary} />
              <Text style={styles.onboardText}>
                Everything runs on this phone. No account, no cloud — conversations never leave
                your device, and it works with no internet.
              </Text>
            </View>
            <View style={styles.onboardRow}>
              <Ionicons name="sparkles-outline" size={20} color={colors.primary} />
              <Text style={styles.onboardText}>
                Talk or type. It can answer questions, set alarms and reminders, check your
                calendar, and more.
              </Text>
            </View>
            <View style={styles.onboardRow}>
              <Ionicons name="download-outline" size={20} color={colors.primary} />
              <Text style={styles.onboardText}>
                First, download its brain — an AI model (a one-time few-GB download; Wi-Fi
                recommended).
              </Text>
            </View>
          </View>
          <Pressable style={styles.cta} onPress={() => router.push('/models')}>
            <Text style={styles.ctaText}>Choose a model</Text>
          </Pressable>
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.error}>
            {humanizeLoadError(loadError, active, Device.totalMemory)}
          </Text>
          <Pressable style={styles.cta} onPress={() => router.push('/models')}>
            <Text style={styles.ctaText}>Choose another model</Text>
          </Pressable>
        </View>
      ) : !ready ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.hint}>
            {loadProgress?.id === activeId
              ? `loading model… ${Math.round(loadProgress.p * 100)}%`
              : 'loading model…'}
          </Text>
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
          onContentSizeChange={() => {
            if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
          }}
          onScroll={onListScroll}
          scrollEventThrottle={100}
          renderItem={({ item }) =>
            item.confirm ? (
              <ConfirmCard
                id={item.id}
                name={item.confirm.name}
                label={item.confirm.label}
                onAnswer={answerConfirm}
              />
            ) : item.plan ? (
              <PlanRow step={item.plan.step} text={item.plan.text} forced={item.plan.forced} />
            ) : item.tool ? (
              <ToolChip label={item.tool.label} status={item.tool.status} />
            ) : item.error ? (
              <ErrorBubble content={item.content} />
            ) : item.role === 'user' ? (
              <Pressable onLongPress={() => bubbleActions(item)} delayLongPress={300}>
                <UserBubble content={item.content} image={item.image} />
              </Pressable>
            ) : (
              <Pressable onLongPress={() => bubbleActions(item)} delayLongPress={300}>
                <AssistantBubble
                  content={item.content}
                  streaming={item.id === streamingId}
                  canSpeak={tts.enabled}
                  voiceSid={tts.voiceSid}
                  onRegenerate={item.id === lastAssistantId && !busy ? regenerate : undefined}
                />
              </Pressable>
            )
          }
          ListEmptyComponent={
            !thinking ? (
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyTitle}>Private AI on your phone</Text>
                <Text style={styles.hint}>
                  Replies are generated on-device — your conversations never leave this phone.
                </Text>
                <View style={styles.suggestionWrap}>
                  {(active?.tools ? SUGGESTIONS_TOOLS : SUGGESTIONS_PLAIN).map((s) => (
                    <Pressable
                      key={s}
                      style={[styles.suggestion, !ready && styles.suggestionDisabled]}
                      disabled={!ready || busy}
                      onPress={() => void sendText(s)}
                      accessibilityRole="button"
                      accessibilityLabel={`Send: ${s}`}>
                      <Text style={styles.suggestionText}>{s}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null
          }
          ListFooterComponent={thinking ? <TypingIndicator /> : null}
        />
      )}

      {showJump ? (
        <Pressable
          style={[styles.jumpBtn, { bottom: insets.bottom + 96 }]}
          onPress={jumpToEnd}
          accessibilityRole="button"
          accessibilityLabel="Scroll to latest message">
          <Ionicons name="chevron-down" size={20} color={colors.text} />
        </Pressable>
      ) : null}

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
              <View style={styles.voiceActions}>
                {voice.state.canOpenSettings ? (
                  <Pressable onPress={() => void Linking.openSettings()}>
                    <Text style={styles.voiceLink}>Open Settings</Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={voice.reset}>
                  <Text style={styles.attachRemove}>Dismiss</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
        {voice.state.status === 'recording' ? (
          // Recording: cancel · live waveform · confirm (stop & transcribe).
          <View style={[styles.inputRow, { paddingBottom: insets.bottom + 8 }]}>
            <Pressable
              style={styles.iconBtn}
              onPress={voice.cancel}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Cancel recording">
              <Ionicons name="close-outline" size={22} color={colors.textSecondary} />
            </Pressable>
            <View style={styles.waveWrap}>
              <Waveform active />
            </View>
            <Pressable
              style={styles.sendBtn}
              onPress={voice.stop}
              accessibilityRole="button"
              accessibilityLabel="Finish recording and transcribe">
              <Ionicons name="checkmark" size={20} color={colors.onPrimary} />
            </Pressable>
          </View>
        ) : (
          <View style={[styles.inputRow, { paddingBottom: insets.bottom + 8 }]}>
            {active?.vision ? (
              <Pressable
                style={[styles.iconBtn, (!ready || busy) && styles.sendBtnDisabled]}
                onPress={pickImage}
                disabled={!ready || busy}
                accessibilityRole="button"
                accessibilityLabel="Attach an image">
                <Ionicons name="add-outline" size={24} color={colors.text} />
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.iconBtn, (!ready || busy) && styles.sendBtnDisabled]}
              onPress={voice.start}
              disabled={!ready || busy || voice.state.status === 'transcribing'}
              accessibilityRole="button"
              accessibilityLabel="Voice input">
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
              style={[styles.sendBtn, !ready && styles.sendBtnDisabled]}
              onPress={busy ? stop : send}
              accessibilityRole="button"
              accessibilityLabel={busy ? 'Stop generating' : 'Send message'}>
              <Text style={styles.sendText}>{busy ? 'Stop' : 'Send'}</Text>
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

// Per-tool glyph (bundled Ionicons — no download). Keyed by the tool name the
// agent loop reports, so "Read calendar" shows a calendar, "Set alarm" a clock,
// and so on. Anything unmapped falls back to a generic tool icon.
type IoniconName = ComponentProps<typeof Ionicons>['name'];
const TOOL_ICONS: Record<string, IoniconName> = {
  create_calendar_event: 'calendar-outline',
  list_calendar_events: 'calendar-outline',
  schedule_reminder: 'notifications-outline',
  set_alarm: 'alarm-outline',
  search_contacts: 'people-outline',
  dial_number: 'call-outline',
  compose_sms: 'chatbubble-ellipses-outline',
  compose_email: 'mail-outline',
  open_maps: 'map-outline',
  open_url: 'open-outline',
  web_search: 'search-outline',
  web_fetch: 'globe-outline',
  get_battery: 'battery-half-outline',
  read_clipboard: 'clipboard-outline',
  write_clipboard: 'clipboard-outline',
  set_brightness: 'sunny-outline',
  get_location: 'location-outline',
  search_phone_media: 'images-outline',
};

// Tool-activity chip. Memoized on primitive props so settled chips don't
// re-render while a later bubble streams.
//
// The leading glyph is the STATUS, not the tool: at chip size one icon reads
// instantly and two compete, and by the time a chip has settled the only
// question left is "did that work?". The tool's own glyph does the identifying
// job earlier, on the confirmation card, where there is room for it.
const ToolChip = memo(function ToolChip({
  label,
  status,
}: {
  label: string;
  status: ToolStatus;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const icon: IoniconName =
    status === 'done'
      ? 'checkmark-circle'
      : status === 'error'
        ? 'alert-circle'
        : 'close-circle';
  const color =
    status === 'done'
      ? colors.success
      : status === 'error'
        ? colors.danger
        : colors.textFaint;
  const suffix = status === 'denied' ? ' · denied' : status === 'error' ? ' · failed' : '';
  return (
    <View style={styles.toolChip}>
      {status === 'running' ? (
        <ActivityIndicator size="small" color={colors.textSecondary} style={styles.toolSpinner} />
      ) : (
        <Ionicons name={icon} size={17} color={color} />
      )}
      <Text style={styles.toolChipText} numberOfLines={2}>
        {label}
        {suffix}
      </Text>
    </View>
  );
});

// Pending side-effecting action: Allow/Deny inline in the transcript instead of
// a native modal. A modal for "set an alarm" reads as an error dialog and rips
// the user out of the conversation; here the request stays in place, keeps the
// tool's own glyph for identification, and converts into its chip once answered.
const ConfirmCard = memo(function ConfirmCard({
  id,
  name,
  label,
  onAnswer,
}: {
  id: string;
  name: string;
  label: string;
  onAnswer: (id: string, allow: boolean) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.confirmCard}>
      <View style={styles.confirmHead}>
        <Ionicons name={TOOL_ICONS[name] ?? 'construct-outline'} size={18} color={colors.primary} />
        <Text style={styles.confirmLabel}>{label}</Text>
      </View>
      <View style={styles.confirmActions}>
        <Pressable
          style={[styles.confirmBtn, styles.confirmDeny]}
          onPress={() => onAnswer(id, false)}
          accessibilityRole="button"
          accessibilityLabel={`Deny: ${label}`}>
          <Text style={styles.confirmDenyText}>Deny</Text>
        </Pressable>
        <Pressable
          style={[styles.confirmBtn, styles.confirmAllow]}
          onPress={() => onAnswer(id, true)}
          accessibilityRole="button"
          accessibilityLabel={`Allow: ${label}`}>
          <Text style={styles.confirmAllowText}>Allow</Text>
        </Pressable>
      </View>
    </View>
  );
});

// A single grammar-constrained planning decision, collapsed by default. This is
// the agent's reasoning made literal: the model's choice between calling a tool
// and answering is exactly one JSON object, so showing it is more honest (and
// far shorter) than free-text chain-of-thought.
const PlanRow = memo(function PlanRow({
  step,
  text,
  forced,
}: {
  step: number;
  text: string;
  forced?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  // Summarize the decision so the collapsed row is still informative.
  const decision = parseDecision(text);
  const summary =
    decision.kind === 'tool'
      ? `call ${decision.name}`
      : decision.malformed
        ? 'unreadable decision'
        : 'answer directly';
  return (
    <View style={styles.planWrap}>
      <Pressable
        style={styles.planRow}
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Planning step ${step + 1}: ${summary}`}>
        <Ionicons
          name={open ? 'chevron-down' : 'chevron-forward'}
          size={12}
          color={colors.textFaint}
        />
        <Text style={styles.planText}>
          {forced ? 'Retry · ' : `Step ${step + 1} · `}
          {summary}
        </Text>
      </Pressable>
      {open ? <Text style={styles.planJson}>{text}</Text> : null}
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
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.bubble, styles.user]}>
      {image ? <Image source={{ uri: image }} style={styles.bubbleImage} /> : null}
      {content || !image ? <Text style={styles.userText}>{content || '…'}</Text> : null}
    </View>
  );
});

// Error bubble. Memoized (settled, never re-renders during later streaming).
const ErrorBubble = memo(function ErrorBubble({ content }: { content: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.bubble, styles.assistant, styles.errorBubble]}>
      <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
      <Text style={styles.errorBubbleText}>{content}</Text>
    </View>
  );
});

// The catalog name of an abliterated build already ends in "· Uncensored", and
// the badge beside it says the same thing while also carrying the canary
// verification state — so drop the suffix rather than print it twice.
function modelLabel(model: { name: string; uncensored?: boolean }): string {
  return model.uncensored ? model.name.replace(/\s*·\s*Uncensored\s*$/i, '') : model.name;
}

// Header badge reflecting the uncensored canary self-test for the active model.
function UncensoredBadge({ id }: { id: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const state = ModelManager.getVerifyState(id);
  // A passing canary is the expected case, so it collapses to a shield glyph to
  // leave the model name room. The states that need explaining keep their words.
  if (state === 'pass') {
    return (
      <View
        style={[styles.badge, styles.badgePass, styles.badgeIconOnly]}
        accessibilityRole="image"
        accessibilityLabel="Uncensored model, canary verified">
        <Ionicons name="shield-checkmark" size={12} color={colors.success} />
      </View>
    );
  }
  const label =
    state === 'fail' ? 'refused canary' : state === 'pending' ? 'verifying…' : 'unverified';
  return (
    <View style={[styles.badge, state === 'fail' ? styles.badgeFail : styles.badgeNeutral]}>
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
  onRegenerate,
}: {
  content: string;
  streaming: boolean;
  canSpeak: boolean;
  voiceSid: number;
  onRegenerate?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const markdownStyles = useThemedStyles(createMarkdownStyles);
  const [showThoughts, setShowThoughts] = useState(false);
  const { thinking, answer } = splitThinking(content);
  const stillThinking = thinking !== null && !answer;

  return (
    <View style={[styles.bubble, styles.assistant]}>
      {thinking ? (
        <Pressable
          style={styles.thoughtsToggle}
          onPress={() => setShowThoughts((v) => !v)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ expanded: showThoughts }}
          accessibilityLabel="Model reasoning">
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
      {answer && !streaming && (canSpeak || onRegenerate) ? (
        <View style={styles.bubbleActionsRow}>
          {canSpeak ? (
            <Pressable
              onPress={() => Tts.speak(answer, voiceSid)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Read reply aloud">
              <Ionicons name="volume-medium-outline" size={16} color={colors.textSecondary} />
            </Pressable>
          ) : null}
          {onRegenerate ? (
            <Pressable
              onPress={onRegenerate}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Regenerate reply">
              <Ionicons name="refresh-outline" size={16} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>
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

const createStyles = (colors: Colors) =>
  StyleSheet.create({
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
    // flexShrink lets a long model name ellipsize instead of wrapping the header
    // onto extra lines.
    subtitle: { color: colors.textSecondary, fontSize: 12, flexShrink: 1 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
    // Negative left margin keeps the glyph optically aligned with the title while
    // preserving a comfortable touch target.
    menuBtn: { padding: 6, marginLeft: -6, marginRight: 8 },
    headerIcon: { padding: 6, marginLeft: 4 },
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    badgeIconOnly: { paddingHorizontal: 5 },
    badgePass: { backgroundColor: colors.successBg },
    badgeFail: { backgroundColor: colors.dangerBg },
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
    // Fully rounded pill, sized between a chip and a bubble: it sits in the
    // same column as the assistant's replies but must never be mistaken for
    // one, so it stays borderless-light with a status glyph and no tail.
    toolChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'flex-start',
      maxWidth: '85%',
      backgroundColor: colors.surface,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      paddingLeft: 12,
      paddingRight: 16,
      paddingVertical: 9,
    },
    toolChipText: { color: colors.textSecondary, fontSize: 13.5, flexShrink: 1 },
    toolSpinner: { width: 17, height: 17, transform: [{ scale: 0.75 }] },

    // Confirmation card: a real surface with actions, not a chip — it is the
    // one row in the transcript that blocks the turn on the user.
    confirmCard: {
      alignSelf: 'flex-start',
      maxWidth: '90%',
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 12,
    },
    confirmHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
    confirmLabel: { color: colors.text, fontSize: 14.5, lineHeight: 20, flexShrink: 1 },
    confirmActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    confirmBtn: { borderRadius: 999, paddingHorizontal: 18, paddingVertical: 9 },
    confirmDeny: { backgroundColor: colors.surfaceSunken },
    confirmDenyText: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '600' },
    confirmAllow: { backgroundColor: colors.primary },
    confirmAllowText: { color: colors.onPrimary, fontSize: 13.5, fontWeight: '600' },

    // Planning steps sit visually *below* every other row — no surface, faint
    // text — because they are machinery the user opted into seeing, not part
    // of the conversation.
    planWrap: { alignSelf: 'flex-start', maxWidth: '90%', paddingLeft: 2 },
    planRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    planText: { color: colors.textFaint, fontSize: 11.5, fontWeight: '600' },
    planJson: {
      color: colors.textFaint,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 11,
      lineHeight: 16,
      marginTop: 4,
      marginLeft: 17,
    },
    thoughtsToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
    speakBtn: { alignSelf: 'flex-start', marginTop: 6, paddingVertical: 2 },
    bubbleActionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      marginTop: 8,
      paddingVertical: 2,
    },
    emptyWrap: { alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 48 },
    onboardRows: { gap: 16, marginVertical: 10, paddingHorizontal: 8 },
    onboardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    onboardText: { color: colors.textSecondary, fontSize: 13.5, lineHeight: 20, flex: 1 },
    emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
    suggestionWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: 8,
      marginTop: 14,
    },
    suggestion: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    suggestionDisabled: { opacity: 0.5 },
    suggestionText: { color: colors.textSecondary, fontSize: 13 },
    jumpBtn: {
      position: 'absolute',
      right: 16,
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 3,
    },
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
    voiceText: { color: colors.textSecondary, fontSize: 13, flex: 1, marginRight: 8 },
    voiceActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    voiceLink: { color: colors.primary, fontSize: 13, fontWeight: '600' },
    sendBtn: {
      backgroundColor: colors.primary,
      borderRadius: 18,
      paddingHorizontal: 18,
      paddingVertical: 12,
    },
    sendText: { color: colors.onPrimary, fontWeight: '600' },
    sendBtnDisabled: { opacity: 0.4 },
  });

// Markdown theme for assistant answers, matched to the bubble it sits in.
const createMarkdownStyles = (colors: Colors) => ({
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
    backgroundColor: colors.surfaceSunken,
    color: colors.primaryDeep,
    borderRadius: 4,
    paddingHorizontal: 4,
    fontSize: 13,
  },
  code_block: {
    backgroundColor: colors.surfaceSunken,
    color: colors.text,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
  },
  fence: {
    backgroundColor: colors.surfaceSunken,
    color: colors.text,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
  },
  blockquote: {
    backgroundColor: colors.surfaceSunken,
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
});
