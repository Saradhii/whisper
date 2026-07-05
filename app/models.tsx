// Model management screen: download / cancel / delete models, pick the active
// one, and register custom GGUF URLs (e.g. any model from Hugging Face).
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { unloadAll } from '@/src/engines';
import { formatBytes, type ModelSpec } from '@/src/models/catalog';
import * as ModelManager from '@/src/models/ModelManager';
import { colors } from '@/src/theme';

export default function Models() {
  const insets = useSafeAreaInsets();
  const version = useSyncExternalStore(ModelManager.subscribe, ModelManager.getVersion);

  const [freeDisk, setFreeDisk] = useState<number | null>(null);
  const deviceRam = Device.totalMemory;

  useEffect(() => {
    void ModelManager.init();
  }, []);
  // Refresh the free-space readout whenever models change on disk.
  useEffect(() => {
    FileSystem.getFreeDiskStorageAsync().then(setFreeDisk).catch(() => {});
  }, [version]);

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

  const startDownload = (spec: ModelSpec) => {
    ModelManager.download(spec).catch((e: unknown) => {
      Alert.alert('Download failed', e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Chat</Text>
        </Pressable>
        <Text style={styles.title}>Models</Text>
        <Text style={styles.subtitle}>
          {deviceRam ? `${formatBytes(deviceRam)} RAM` : 'RAM unknown'}
          {freeDisk != null ? ` · ${formatBytes(freeDisk)} free storage` : ''}
        </Text>
      </View>

      <FlatList
        data={ModelManager.allModels()}
        keyExtractor={(m) => m.id}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
        renderItem={({ item }) => (
          <ModelRow
            spec={item}
            status={ModelManager.getStatus(item.id)}
            isActive={active?.id === item.id}
            deviceRam={deviceRam}
            onDownload={() => startDownload(item)}
            onCancel={() => void ModelManager.cancelDownload(item.id)}
            onDelete={() => confirmDelete(item)}
            onUse={() => ModelManager.setActive(item.id)}
          />
        )}
        ListFooterComponent={<AddCustomModel />}
      />
    </View>
  );
}

function ModelRow({
  spec,
  status,
  isActive,
  deviceRam,
  onDownload,
  onCancel,
  onDelete,
  onUse,
}: {
  spec: ModelSpec;
  status: ModelManager.ModelStatus;
  isActive: boolean;
  deviceRam: number | null;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onUse: () => void;
}) {
  const ramRisk = !!deviceRam && spec.minRamBytes > 0 && spec.minRamBytes > deviceRam;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{spec.name}</Text>
        {isActive ? <Text style={styles.activeBadge}>ACTIVE</Text> : null}
      </View>
      <Text style={styles.cardDesc}>{spec.description}</Text>
      <Text style={styles.cardMeta}>
        {spec.sizeBytes > 0 ? `${formatBytes(spec.sizeBytes)} download` : 'size unknown'}
        {spec.vision ? ' · vision' : ''}
        {spec.minRamBytes > 0 ? ` · needs ${formatBytes(spec.minRamBytes)}+ RAM` : ''}
      </Text>
      {ramRisk ? (
        <Text style={styles.warn}>
          ⚠ This device has {formatBytes(deviceRam!)} RAM — this model will likely crash it.
        </Text>
      ) : null}

      {status.downloading ? (
        <View style={styles.progressRow}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${status.progress * 100}%` }]} />
          </View>
          <Text style={styles.progressText}>{Math.round(status.progress * 100)}%</Text>
          <Pressable style={styles.btnGhost} onPress={onCancel}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.actions}>
          {status.installed ? (
            <>
              {!isActive ? (
                <Pressable style={styles.btn} onPress={onUse}>
                  <Text style={styles.btnText}>Use</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.btnGhost} onPress={onDelete}>
                <Text style={styles.btnDanger}>Delete</Text>
              </Pressable>
            </>
          ) : (
            <Pressable style={styles.btn} onPress={onDownload}>
              <Text style={styles.btnText}>Download</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

function AddCustomModel() {
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
      <Pressable onPress={() => setOpen(true)} hitSlop={8}>
        <Text style={styles.advancedToggle}>Advanced: add your own model ›</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.card}>
      <Pressable onPress={() => setOpen(false)} hitSlop={8}>
        <Text style={styles.cardTitle}>Add custom GGUF ▾</Text>
      </Pressable>
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
        <Pressable style={[styles.btn, !modelUrl.trim() && styles.btnDisabled]} onPress={add}>
          <Text style={styles.btnText}>Add</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: { color: colors.primary, fontSize: 15, marginBottom: 4 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  listContent: { padding: 12, gap: 10 },
  card: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, gap: 6 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  activeBadge: { color: colors.primary, fontSize: 11, fontWeight: '700' },
  cardDesc: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  cardMeta: { color: colors.textFaint, fontSize: 12 },
  warn: { color: colors.warn, fontSize: 12, lineHeight: 17 },
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
  input: {
    color: colors.text,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  advancedToggle: {
    color: colors.textFaint,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 12,
  },
});
