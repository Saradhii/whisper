// Model management screen: download / cancel / delete models, pick the active
// one, and register custom GGUF URLs (e.g. any model from Hugging Face).
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { memo, useEffect, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Ionicons } from '@expo/vector-icons';

import { unloadAll } from '@/src/engines';
import {
  formatBytes,
  sizeTier,
  TIER_HINT,
  TIER_LABEL,
  TIER_ORDER,
  type ModelSpec,
  type SizeTier,
} from '@/src/models/catalog';
import * as ModelManager from '@/src/models/ModelManager';
import { Touchable, useTheme, useThemedStyles, type Colors } from '@/src/theme';

export default function Models() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const version = useSyncExternalStore(ModelManager.subscribe, ModelManager.getVersion);

  const [freeDisk, setFreeDisk] = useState<number | null>(null);
  // Which size groups are expanded; Medium (where the suggested models live)
  // starts open.
  const [openTiers, setOpenTiers] = useState<Set<SizeTier>>(new Set<SizeTier>(['medium']));
  const deviceRam = Device.totalMemory;

  useEffect(() => {
    void ModelManager.init();
  }, []);
  // Refresh the free-space readout whenever models change on disk.
  useEffect(() => {
    FileSystem.getFreeDiskStorageAsync().then(setFreeDisk).catch(() => {});
  }, [version]);

  // Multi-GB downloads die with the screen (no foreground service) — keep it
  // awake while anything is actively downloading and this screen is open.
  const anyDownloading = ModelManager.allModels().some(
    (m) => ModelManager.getStatus(m.id).downloading,
  );
  useEffect(() => {
    if (!anyDownloading) return;
    void activateKeepAwakeAsync('model-download');
    return () => {
      void deactivateKeepAwake('model-download');
    };
  }, [anyDownloading]);

  const active = ModelManager.getActive();

  const confirmDelete = (spec: ModelSpec) => {
    Alert.alert('Delete model?', `${spec.name} will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (active?.id === spec.id) await unloadAll(); // free native memory first
          await ModelManager.remove(spec);
        },
      },
    ]);
  };

  const runDownload = (spec: ModelSpec) => {
    ModelManager.download(spec).catch((e: unknown) => {
      Alert.alert('Download failed', e instanceof Error ? e.message : String(e));
    });
  };

  // Multi-GB downloads deserve informed consent: size, data-cost hint, and the
  // fact that it's one-time. Resumes (bytes already on disk) skip the prompt.
  const startDownload = (spec: ModelSpec) => {
    const status = ModelManager.getStatus(spec.id);
    if (spec.sizeBytes < 500 * 1024 * 1024 || status.paused) {
      runDownload(spec);
      return;
    }
    Alert.alert(
      `Download ${spec.name}?`,
      `This is a one-time ${formatBytes(spec.sizeBytes)} download. On mobile data it may be slow and use up your plan — Wi-Fi is recommended. Keep the app open while it downloads; you can pause and resume anytime.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Download', onPress: () => runDownload(spec) },
      ],
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Touchable style={styles.backRow} onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={18} color={colors.primary} />
          <Text style={styles.back}>Chat</Text>
        </Touchable>
        <Text style={styles.title}>Models</Text>
        <Text style={styles.subtitle}>
          {deviceRam ? `${formatBytes(deviceRam)} RAM` : 'RAM unknown'}
          {freeDisk != null ? ` · ${formatBytes(freeDisk)} free storage` : ''}
        </Text>
      </View>

      <ScrollView contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}>
        {TIER_ORDER.map((tier) => {
          const models = ModelManager.allModels().filter((m) => sizeTier(m.sizeBytes) === tier);
          if (!models.length) return null;
          const installed = models.filter((m) => ModelManager.getStatus(m.id).installed).length;
          const open = openTiers.has(tier);
          return (
            <View key={tier} style={styles.group}>
              <Touchable
                style={styles.groupHeader}
                onPress={() =>
                  setOpenTiers((prev) => {
                    const next = new Set(prev);
                    if (next.has(tier)) next.delete(tier);
                    else next.add(tier);
                    return next;
                  })
                }>
                <View style={styles.flex}>
                  <Text style={styles.groupTitle}>{TIER_LABEL[tier]}</Text>
                  <Text style={styles.groupHint}>
                    {TIER_HINT[tier]} · {models.length} model{models.length > 1 ? 's' : ''}
                    {installed ? ` · ${installed} installed` : ''}
                  </Text>
                </View>
                <Ionicons
                  name={open ? 'chevron-up' : 'chevron-down'}
                  size={20}
                  color={colors.primary}
                />
              </Touchable>
              {open
                ? models.map((item) => (
                    <ModelRow
                      key={item.id}
                      spec={item}
                      status={ModelManager.getStatus(item.id)}
                      isActive={active?.id === item.id}
                      deviceRam={deviceRam}
                      onDownload={() => startDownload(item)}
                      onPause={() => void ModelManager.pauseDownload(item.id)}
                      onCancel={() => void ModelManager.cancelDownload(item.id)}
                      onDelete={() => confirmDelete(item)}
                      onUse={() => ModelManager.setActive(item.id)}
                    />
                  ))
                : null}
            </View>
          );
        })}
        <AddCustomModel />
      </ScrollView>
    </View>
  );
}

// Memoized on data props (callbacks are recreated per parent render but close
// over the same stable spec, so they're excluded from the comparison) — during
// a download only the downloading row re-renders, not all 8+ cards.
const ModelRow = memo(
  function ModelRow({
    spec,
    status,
    isActive,
    deviceRam,
    onDownload,
    onPause,
    onCancel,
    onDelete,
    onUse,
  }: {
    spec: ModelSpec;
    status: ModelManager.ModelStatus;
    isActive: boolean;
    deviceRam: number | null;
    onDownload: () => void;
    onPause: () => void;
    onCancel: () => void;
    onDelete: () => void;
    onUse: () => void;
  }) {
    const { colors } = useTheme();
    const styles = useThemedStyles(createStyles);
    const ramRisk = !!deviceRam && spec.minRamBytes > 0 && spec.minRamBytes > deviceRam;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{spec.name}</Text>
        {spec.suggested ? (
          <View style={styles.suggestedTag}>
            {/* Filled, not outline: at 11px an outline sparkle is mud. */}
            <Ionicons name="sparkles" size={11} color={colors.primaryDeep} />
            <Text style={styles.suggestedText}>Suggested</Text>
          </View>
        ) : null}
        {isActive ? <Text style={styles.activeBadge}>ACTIVE</Text> : null}
      </View>
      <Text style={styles.cardDesc}>{spec.description}</Text>
      <Text style={styles.cardMeta}>
        {spec.sizeBytes > 0 ? `${formatBytes(spec.sizeBytes)} download` : 'size unknown'}
        {spec.vision ? ' · vision' : ''}
        {spec.minRamBytes > 0 ? ` · needs ${formatBytes(spec.minRamBytes)}+ RAM` : ''}
      </Text>
      {ramRisk ? (
        <View style={styles.warnRow}>
          <Ionicons name="warning-outline" size={14} color={colors.warn} />
          <Text style={styles.warn}>
            This device has {formatBytes(deviceRam!)} RAM — this model will likely crash it.
          </Text>
        </View>
      ) : null}

      {status.downloading || status.paused ? (
        <>
          <View style={styles.progressRow}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${status.progress * 100}%` }]} />
            </View>
            <Text style={styles.progressText}>{Math.round(status.progress * 100)}%</Text>
          </View>
          <View style={styles.actions}>
            <Text style={styles.progressBytes}>
              {status.paused ? 'Paused · ' : ''}
              {formatBytes(status.bytesWritten)}
              {status.bytesTotal > 0 ? ` of ${formatBytes(status.bytesTotal)}` : ''}
            </Text>
            {status.downloading ? (
              <Touchable style={styles.btnGhost} onPress={onPause} accessibilityRole="button" accessibilityLabel={`Pause download of ${spec.name}`}>
                <Text style={styles.btnGhostText}>Pause</Text>
              </Touchable>
            ) : (
              <Touchable style={styles.btn} onPress={onDownload} accessibilityRole="button" accessibilityLabel={`Resume download of ${spec.name}`}>
                <Text style={styles.btnText}>Resume</Text>
              </Touchable>
            )}
            <Touchable style={styles.btnGhost} onPress={onCancel} accessibilityRole="button" accessibilityLabel={`Cancel download of ${spec.name}`}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Touchable>
          </View>
        </>
      ) : (
        <View style={styles.actions}>
          {status.installed ? (
            <>
              {!isActive ? (
                <Touchable style={styles.btn} onPress={onUse} accessibilityRole="button" accessibilityLabel={`Use ${spec.name}`}>
                  <Text style={styles.btnText}>Use</Text>
                </Touchable>
              ) : null}
              <Touchable style={styles.btnGhost} onPress={onDelete} accessibilityRole="button" accessibilityLabel={`Delete ${spec.name}`}>
                <Text style={styles.btnDanger}>Delete</Text>
              </Touchable>
            </>
          ) : (
            <Touchable style={styles.btn} onPress={onDownload} accessibilityRole="button" accessibilityLabel={`Download ${spec.name}`}>
              <Text style={styles.btnText}>Download</Text>
            </Touchable>
          )}
        </View>
      )}
    </View>
    );
  },
  (prev, next) =>
    prev.spec === next.spec &&
    prev.isActive === next.isActive &&
    prev.deviceRam === next.deviceRam &&
    prev.status.installed === next.status.installed &&
    prev.status.downloading === next.status.downloading &&
    prev.status.paused === next.status.paused &&
    prev.status.progress === next.status.progress &&
    prev.status.bytesWritten === next.status.bytesWritten,
);

function AddCustomModel() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [modelUrl, setModelUrl] = useState('');
  const [mmprojUrl, setMmprojUrl] = useState('');

  const add = () => {
    try {
      ModelManager.addCustom({ name, modelUrl, mmprojUrl: mmprojUrl || undefined });
      setName('');
      setModelUrl('');
      setMmprojUrl('');
    } catch (e) {
      Alert.alert('Invalid model', e instanceof Error ? e.message : String(e));
    }
  };

  if (!open) {
    return (
      <Touchable style={styles.advancedRow} onPress={() => setOpen(true)} hitSlop={8}>
        <Text style={styles.advancedToggle}>Advanced: add your own model</Text>
        <Ionicons name="chevron-forward" size={15} color={colors.textFaint} />
      </Touchable>
    );
  }

  return (
    <View style={styles.card}>
      <Touchable style={styles.advancedRow} onPress={() => setOpen(false)} hitSlop={8}>
        <Text style={styles.cardTitle}>Add custom GGUF</Text>
        <Ionicons name="chevron-down" size={16} color={colors.text} />
      </Touchable>
      <Text style={styles.cardDesc}>
        Paste direct .gguf links from Hugging Face (use the “resolve/main” download URL). Add a
        mmproj link to enable vision.
      </Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Name (optional)"
        placeholderTextColor={colors.textFaint}
      />
      <TextInput
        style={styles.input}
        value={modelUrl}
        onChangeText={setModelUrl}
        placeholder="Model .gguf URL"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={styles.input}
        value={mmprojUrl}
        onChangeText={setMmprojUrl}
        placeholder="mmproj .gguf URL (optional, for vision)"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.actions}>
        <Touchable style={[styles.btn, !modelUrl.trim() && styles.btnDisabled]} onPress={add}>
          <Text style={styles.btnText}>Add</Text>
        </Touchable>
      </View>
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
    title: { color: colors.text, fontSize: 18, fontWeight: '700' },
    subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    flex: { flex: 1 },
    listContent: { padding: 12, gap: 14 },
    group: {
      borderWidth: 1.5,
      borderColor: colors.borderStrong,
      borderRadius: 16,
      overflow: 'hidden',
      gap: 10,
      paddingBottom: 2,
    },
    groupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: colors.primarySoft,
    },
    groupTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
    groupHint: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 14,
      gap: 6,
      marginHorizontal: 10,
    },
    suggestedTag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: colors.primarySoft,
      borderRadius: 8,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    suggestedText: { color: colors.primaryDeep, fontSize: 11, fontWeight: '700' },
    cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardTitle: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
    activeBadge: { color: colors.primary, fontSize: 11, fontWeight: '700' },
    cardDesc: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
    cardMeta: { color: colors.textFaint, fontSize: 12 },
    warnRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5 },
    warn: { color: colors.warn, fontSize: 12, lineHeight: 17, flex: 1 },
    actions: { flexDirection: 'row', gap: 10, marginTop: 6, alignItems: 'center' },
    btn: {
      backgroundColor: colors.primary,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    btnDisabled: { opacity: 0.4 },
    btnText: { color: colors.onPrimary, fontWeight: '600', fontSize: 13 },
    btnGhost: { paddingHorizontal: 10, paddingVertical: 8 },
    btnGhostText: { color: colors.textSecondary, fontSize: 13 },
    btnDanger: { color: colors.danger, fontSize: 13 },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
    progressTrack: {
      flex: 1,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.border,
      overflow: 'hidden',
    },
    progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
    progressText: { color: colors.textSecondary, fontSize: 12, width: 36, textAlign: 'right' },
    progressBytes: { color: colors.textSecondary, fontSize: 12, flex: 1 },
    input: {
      color: colors.text,
      backgroundColor: colors.bg,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 13,
    },
    advancedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingVertical: 12,
    },
    advancedToggle: {
      color: colors.textFaint,
      fontSize: 13,
    },
  });
