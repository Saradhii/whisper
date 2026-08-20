// Agent trace viewer: what the agent actually decided, step by step.
//
// This exists because the interesting failures were invisible. The planner is
// grammar-constrained and falls back to "just answer" on anything it can't
// read, so a mis-converted grammar, a truncated decision, and a model that
// simply chose not to act all looked identical from the chat — the assistant
// narrated and nothing happened. Every one of those now leaves a row here,
// with the raw decision text behind it.
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Alert, FlatList, Platform, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as RecorderStore from '@/src/agent/eval/recorderStore';
import * as Trace from '@/src/agent/trace';
import type { AgentTraceKind } from '@/src/agent/types';
import * as Settings from '@/src/settings/store';
import { Touchable, useTheme, useThemedStyles, type Colors } from '@/src/theme';

const KIND_ICON: Record<AgentTraceKind, keyof typeof Ionicons.glyphMap> = {
  plan: 'git-branch-outline',
  tool: 'construct-outline',
  answer: 'chatbubble-outline',
  warn: 'alert-circle-outline',
  error: 'close-circle-outline',
};

export default function AgentTraceScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  useSyncExternalStore(Trace.subscribe, Trace.getVersion);
  useSyncExternalStore(Settings.subscribe, Settings.getVersion);
  useSyncExternalStore(RecorderStore.subscribe, RecorderStore.getVersion);

  const entries = Trace.list();
  const recording = Settings.get().devTrace;
  const corpus = RecorderStore.getStats();

  // Stat the corpus, don't initialise it: opening the viewer must not be what
  // creates the directory. Only the Settings toggle does that.
  useEffect(() => {
    void RecorderStore.refreshStats();
  }, []);

  /** Copy the corpus somewhere a cable can reach, then hand back the path (and
   *  the command) through the share sheet. This is the only path off-device. */
  const exportCorpus = async () => {
    const path = await RecorderStore.exportCorpus();
    if (path) {
      await Share.share({
        message: `Whisper trajectory corpus (${corpus.files} file(s)) copied to:\n${path}\n\nPull it with:\nadb pull ${path}`,
      });
      return;
    }
    // No app-scoped external storage (iOS): the JSONL itself is the payload.
    const text = await RecorderStore.toText();
    if (!text) {
      Alert.alert('Nothing to export', 'No trajectories have been recorded yet.');
      return;
    }
    await Share.share({ message: text });
  };

  const deleteCorpus = () => {
    Alert.alert(
      'Delete recordings?',
      'Removes every recorded trajectory from this phone. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void RecorderStore.clearAll() },
      ],
    );
  };
  // Relative timestamps read better than clock times for a step log; entries
  // come back newest-first, so the oldest is the baseline.
  const t0 = entries.length ? entries[entries.length - 1]!.at : 0;

  const kindColor = (kind: AgentTraceKind) =>
    kind === 'error'
      ? colors.danger
      : kind === 'warn'
        ? colors.warn
        : kind === 'tool'
          ? colors.success
          : colors.textSecondary;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Touchable style={styles.backRow} onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={18} color={colors.primary} />
          <Text style={styles.back}>Settings</Text>
        </Touchable>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Agent trace</Text>
          <View style={styles.headerActions}>
            <Touchable
              onPress={() => void Share.share({ message: Trace.toText() })}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Share trace">
              <Ionicons name="share-outline" size={20} color={colors.icon} />
            </Touchable>
            <Touchable
              onPress={() => void Clipboard.setStringAsync(Trace.toText())}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Copy trace">
              <Ionicons name="copy-outline" size={19} color={colors.icon} />
            </Touchable>
            <Touchable
              onPress={Trace.clear}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Clear trace">
              <Ionicons name="trash-outline" size={19} color={colors.icon} />
            </Touchable>
          </View>
        </View>
      </View>

      {!recording ? (
        <View style={styles.notice}>
          <Ionicons name="information-circle-outline" size={16} color={colors.warn} />
          <Text style={styles.noticeText}>
            Recording is off — turn on “Record agent trace” in Settings, then send a message.
          </Text>
        </View>
      ) : null}

      <View style={styles.corpus}>
        <View style={styles.corpusText}>
          <Text style={styles.corpusTitle}>Trajectory recordings</Text>
          <Text style={styles.corpusMeta}>
            {corpus.files
              ? `${corpus.files} file${corpus.files === 1 ? '' : 's'} · ${(corpus.bytes / 1024).toFixed(0)} KB on this phone`
              : 'None on this phone'}
          </Text>
        </View>
        <Touchable
          onPress={() => void exportCorpus()}
          disabled={!corpus.files}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Export trajectory recordings">
          <Ionicons
            name="download-outline"
            size={20}
            color={corpus.files ? colors.icon : colors.textFaint}
          />
        </Touchable>
        <Touchable
          onPress={deleteCorpus}
          disabled={!corpus.files}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Delete trajectory recordings">
          <Ionicons
            name="trash-outline"
            size={19}
            color={corpus.files ? colors.danger : colors.textFaint}
          />
        </Touchable>
      </View>

      <FlatList
        data={entries}
        keyExtractor={(e) => String(e.id)}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {recording
              ? 'No agent activity yet. Send a message that uses tools.'
              : 'Nothing recorded.'}
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowHead}>
              <Ionicons name={KIND_ICON[item.kind]} size={15} color={kindColor(item.kind)} />
              <Text style={[styles.label, { color: kindColor(item.kind) }]} numberOfLines={2}>
                {item.label}
              </Text>
              <Text style={styles.meta}>
                {item.ms !== undefined ? `${item.ms}ms` : ''}
              </Text>
            </View>
            <Text style={styles.stamp}>
              turn {item.turn} · +{((item.at - t0) / 1000).toFixed(2)}s
            </Text>
            {item.detail ? (
              <Text style={styles.detail} numberOfLines={8}>
                {item.detail}
              </Text>
            ) : null}
          </View>
        )}
      />
    </View>
  );
}

const createStyles = (colors: Colors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    header: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    back: { color: colors.primary, fontSize: 15 },
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { color: colors.text, fontSize: 18, fontWeight: '700' },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
    notice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: colors.surface,
    },
    noticeText: { color: colors.textSecondary, fontSize: 12.5, flex: 1, lineHeight: 18 },
    corpus: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 18,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    corpusText: { flex: 1, gap: 1 },
    corpusTitle: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
    corpusMeta: { color: colors.textFaint, fontSize: 11.5 },
    list: { padding: 12, gap: 8 },
    empty: { color: colors.textFaint, fontSize: 13, textAlign: 'center', paddingTop: 40 },
    row: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 3,
    },
    rowHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    label: { fontSize: 13.5, fontWeight: '600', flex: 1 },
    meta: { color: colors.textFaint, fontSize: 11 },
    stamp: { color: colors.textFaint, fontSize: 10.5, marginLeft: 22 },
    detail: {
      color: colors.textSecondary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 11,
      lineHeight: 16,
      marginTop: 4,
      marginLeft: 22,
    },
  });
