import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { generate, loadModel, stop, type ChatMessage } from '@/src/LlamaService';

// UI message = chat message + an optional attached image (local URI).
type UiMessage = ChatMessage & { image?: string };

export default function Chat() {
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<UiMessage>>(null);

  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('loading model…');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);

  // Download (first run only) + load the model on mount.
  useEffect(() => {
    loadModel((p) => {
      setStatus(
        p.phase === 'downloading'
          ? `downloading ${p.file}… ${(p.progress * 100).toFixed(0)}%`
          : 'loading model…',
      );
    })
      .then(() => setReady(true))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  const pickImage = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (!res.canceled) setImage(res.assets[0].uri);
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && !image) || busy || !ready) return;

    const attachedImage = image ?? undefined;
    const history: ChatMessage[] = [...messages.map(stripImage), { role: 'user', content: text }];
    // Push the user message (+ image) + an empty assistant message to stream into.
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, image: attachedImage },
      { role: 'assistant', content: '' },
    ]);
    setInput('');
    setImage(null);
    setBusy(true);

    try {
      await generate(
        history,
        (token) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + token };
            return next;
          });
        },
        attachedImage,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: `⚠️ ${msg}` };
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Whisper</Text>
        <Text style={styles.subtitle}>
          {loadError ? 'load failed' : ready ? 'Gemma 4 E4B · vision · offline' : status}
        </Text>
      </View>

      {loadError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{loadError}</Text>
          <Text style={styles.hint}>Check your connection and reopen the app to retry.</Text>
        </View>
      ) : !ready ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.hint}>{status}</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          style={styles.flex}
          contentContainerStyle={styles.listContent}
          keyExtractor={(_, i) => String(i)}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => (
            <View style={[styles.bubble, item.role === 'user' ? styles.user : styles.assistant]}>
              {item.image ? <Image source={{ uri: item.image }} style={styles.bubbleImage} /> : null}
              {item.content || !item.image ? (
                <Text style={styles.bubbleText}>{item.content || '…'}</Text>
              ) : null}
            </View>
          )}
        />
      )}

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {image ? (
          <View style={styles.attachRow}>
            <Image source={{ uri: image }} style={styles.attachThumb} />
            <Pressable onPress={() => setImage(null)}>
              <Text style={styles.attachRemove}>Remove</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={[styles.inputRow, { paddingBottom: insets.bottom + 8 }]}>
          <Pressable
            style={[styles.iconBtn, (!ready || busy) && styles.sendBtnDisabled]}
            onPress={pickImage}
            disabled={!ready || busy}>
            <Text style={styles.iconText}>＋</Text>
          </Pressable>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={ready ? 'Ask anything…' : 'Loading…'}
            placeholderTextColor="#6a6a78"
            editable={ready && !busy}
            multiline
          />
          <Pressable
            style={[styles.sendBtn, (!ready || busy) && styles.sendBtnDisabled]}
            onPress={busy ? stop : send}>
            <Text style={styles.sendText}>{busy ? 'Stop' : 'Send'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// Drop the UI-only `image` field before handing history to the model.
const stripImage = ({ role, content }: UiMessage): ChatMessage => ({ role, content });

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d0d12' },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#26262e',
  },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  subtitle: { color: '#8a8a98', fontSize: 12, marginTop: 2 },
  error: { color: '#ff6b6b', textAlign: 'center' },
  hint: { color: '#8a8a98', fontSize: 12, textAlign: 'center' },
  listContent: { padding: 12, gap: 10 },
  bubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  user: { alignSelf: 'flex-end', backgroundColor: '#7c5cfc' },
  assistant: { alignSelf: 'flex-start', backgroundColor: '#1c1c24' },
  bubbleText: { color: '#fff', fontSize: 15, lineHeight: 21 },
  bubbleImage: { width: 200, height: 200, borderRadius: 10, marginBottom: 6, resizeMode: 'cover' },
  attachRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  attachThumb: { width: 44, height: 44, borderRadius: 8 },
  attachRemove: { color: '#8a8a98', fontSize: 13 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#26262e',
  },
  input: {
    flex: 1,
    color: '#fff',
    backgroundColor: '#1c1c24',
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
    backgroundColor: '#1c1c24',
  },
  iconText: { color: '#fff', fontSize: 22, lineHeight: 24 },
  sendBtn: {
    backgroundColor: '#7c5cfc',
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendText: { color: '#fff', fontWeight: '600' },
});
