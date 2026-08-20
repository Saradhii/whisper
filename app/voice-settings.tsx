// Voice (text-to-speech) settings: enable spoken replies, auto-speak toggle,
// and a voice picker where each Kokoro voice can be previewed with a fixed
// sample line before selecting. The Kokoro model downloads on first preview/use.
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Touchable, useTheme, useThemedStyles, type Colors } from '@/src/theme';
import * as Tts from '@/src/voice/tts/TtsService';
import * as TtsStore from '@/src/voice/tts/TtsStore';
import { PREVIEW_TEXT, VOICES, type Voice } from '@/src/voice/tts/voices';

export default function VoiceSettings() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  useSyncExternalStore(TtsStore.subscribe, TtsStore.getVersion);
  const settings = TtsStore.get();

  // sid currently previewing, or a download %; null when idle.
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);

  useEffect(() => {
    void TtsStore.init();
  }, []);

  const preview = async (voice: Voice) => {
    Tts.stop();
    setPreviewing(voice.sid);
    try {
      if (!(await Tts.isDownloaded())) {
        setDownloadPct(0);
        await Tts.ensureModel((p) => setDownloadPct(p.progress));
        setDownloadPct(null);
      }
      await Tts.speak(PREVIEW_TEXT, voice.sid);
    } catch (e) {
      setDownloadPct(null);
      Alert.alert('Voice preview failed', e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(null);
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Touchable style={styles.backRow} onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={18} color={colors.primary} />
          <Text style={styles.back}>Chat</Text>
        </Touchable>
        <Text style={styles.title}>Voice</Text>
        <Text style={styles.subtitle}>Spoken replies · on-device · offline</Text>
      </View>

      <FlatList
        data={settings.enabled ? VOICES : []}
        keyExtractor={(v) => String(v.sid)}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
        ListHeaderComponent={
          <View style={styles.card}>
            <Row
              label="Speak replies"
              hint="Adds a speaker button to assistant messages."
              value={settings.enabled}
              onValueChange={TtsStore.setEnabled}
            />
            {settings.enabled ? (
              <Row
                label="Auto-speak"
                hint="Read every reply aloud automatically."
                value={settings.autoSpeak}
                onValueChange={TtsStore.setAutoSpeak}
              />
            ) : null}
            {settings.enabled && downloadPct != null ? (
              <Text style={styles.downloading}>
                Downloading voice model… {Math.round(downloadPct * 100)}%
              </Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const active = settings.voiceSid === item.sid;
          const busy = previewing === item.sid;
          return (
            <View style={[styles.voiceRow, active && styles.voiceRowActive]}>
              <Touchable
                style={styles.playBtn}
                onPress={() => preview(item)}
                disabled={previewing != null}>
                {busy ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Ionicons name="play-outline" size={18} color={colors.accent} />
                )}
              </Touchable>
              <View style={styles.flex}>
                <Text style={styles.voiceName}>{item.name}</Text>
                <Text style={styles.voiceDesc}>{item.description}</Text>
              </View>
              {active ? (
                <Text style={styles.activeTag}>SELECTED</Text>
              ) : (
                <Touchable style={styles.useBtn} onPress={() => TtsStore.setVoice(item.sid)}>
                  <Text style={styles.useText}>Use</Text>
                </Touchable>
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

function Row({
  label,
  hint,
  value,
  onValueChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.settingRow}>
      <View style={styles.flex}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingHint}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: colors.primary, false: colors.border }}
        thumbColor={colors.bg}
      />
    </View>
  );
}

const createStyles = (colors: Colors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    flex: { flex: 1 },
    header: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    back: { color: colors.primary, fontSize: 15 },
    title: { color: colors.text, fontSize: 18, fontWeight: '700' },
    subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    listContent: { padding: 12, gap: 10 },
    card: { backgroundColor: colors.surface, borderRadius: 14, padding: 6 },
    settingRow: { flexDirection: 'row', alignItems: 'center', padding: 10, gap: 12 },
    settingLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
    settingHint: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    downloading: { color: colors.textSecondary, fontSize: 12, paddingHorizontal: 10, paddingBottom: 8 },
    voiceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 12,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    voiceRowActive: { borderColor: colors.primary },
    playBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.bg,
    },
    voiceName: { color: colors.text, fontSize: 15, fontWeight: '600' },
    voiceDesc: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    activeTag: { color: colors.primary, fontSize: 11, fontWeight: '700' },
    useBtn: {
      backgroundColor: colors.primary,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    useText: { color: colors.onPrimary, fontWeight: '600', fontSize: 13 },
  });
