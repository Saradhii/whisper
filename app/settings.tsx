// Settings: the small set of controls a daily user needs — reply style and
// length, optional persona instructions, and a link to voice settings.
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as Settings from '@/src/settings/store';
import { useTheme, useThemedStyles, type Appearance, type Colors } from '@/src/theme';

const APPEARANCES: { label: string; value: Appearance; hint: string }[] = [
  { label: 'Light', value: 'light', hint: 'always' },
  { label: 'Dark', value: 'dark', hint: 'always' },
  { label: 'System', value: 'system', hint: 'follow phone' },
];

const TEMPS = [
  { label: 'Precise', value: 0.3, hint: 'sticks to facts' },
  { label: 'Balanced', value: 0.7, hint: 'default' },
  { label: 'Creative', value: 1.0, hint: 'more varied' },
];

const LENGTHS = [
  { label: 'Short', value: 512 },
  { label: 'Normal', value: 1024 },
  { label: 'Long', value: 2048 },
];

export default function SettingsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  useSyncExternalStore(Settings.subscribe, Settings.getVersion);
  const s = Settings.get();

  useEffect(() => {
    void Settings.init();
  }, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backRow} onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={18} color={colors.primary} />
          <Text style={styles.back}>Chat</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <Pressable
          style={styles.linkRow}
          onPress={() => router.push('/voice-settings')}
          accessibilityRole="button"
          accessibilityLabel="Voice and speech settings">
          <Ionicons name="volume-high-outline" size={20} color={colors.accent} />
          <Text style={styles.linkText}>Voice & speech</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
        </Pressable>

        <Text style={styles.sectionTitle}>Appearance</Text>
        <View style={styles.chipRow}>
          {APPEARANCES.map((a) => (
            <Pressable
              key={a.value}
              style={[styles.chip, s.appearance === a.value && styles.chipOn]}
              onPress={() => Settings.set({ appearance: a.value })}
              accessibilityRole="button"
              accessibilityState={{ selected: s.appearance === a.value }}
              accessibilityLabel={`Appearance: ${a.label}`}>
              <Text style={[styles.chipText, s.appearance === a.value && styles.chipTextOn]}>
                {a.label}
              </Text>
              <Text style={styles.chipHint}>{a.hint}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Reply style</Text>
        <View style={styles.chipRow}>
          {TEMPS.map((t) => (
            <Pressable
              key={t.label}
              style={[styles.chip, s.temperature === t.value && styles.chipOn]}
              onPress={() => Settings.set({ temperature: t.value })}
              accessibilityRole="button"
              accessibilityState={{ selected: s.temperature === t.value }}
              accessibilityLabel={`Reply style: ${t.label}`}>
              <Text style={[styles.chipText, s.temperature === t.value && styles.chipTextOn]}>
                {t.label}
              </Text>
              <Text style={styles.chipHint}>{t.hint}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Reply length</Text>
        <View style={styles.chipRow}>
          {LENGTHS.map((l) => (
            <Pressable
              key={l.label}
              style={[styles.chip, s.maxTokens === l.value && styles.chipOn]}
              onPress={() => Settings.set({ maxTokens: l.value })}
              accessibilityRole="button"
              accessibilityState={{ selected: s.maxTokens === l.value }}
              accessibilityLabel={`Reply length: ${l.label}`}>
              <Text style={[styles.chipText, s.maxTokens === l.value && styles.chipTextOn]}>
                {l.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Assistant instructions</Text>
        <Text style={styles.hint}>
          Optional. Tell the assistant how to behave — e.g. “Answer briefly. I&apos;m a nurse;
          use plain language.”
        </Text>
        <TextInput
          style={styles.input}
          value={s.personaExtra}
          onChangeText={(text) => Settings.set({ personaExtra: text })}
          placeholder="Extra instructions for every chat (optional)"
          placeholderTextColor={colors.textFaint}
          multiline
          maxLength={600}
        />

        <Text style={styles.sectionTitle}>Developer</Text>
        <Text style={styles.hint}>
          For debugging tool use. The trace stays in memory and is never written to disk.
        </Text>
        <Pressable
          style={styles.toggleRow}
          onPress={() => Settings.set({ showPlanSteps: !s.showPlanSteps })}
          accessibilityRole="switch"
          accessibilityState={{ checked: s.showPlanSteps }}
          accessibilityLabel="Show planning steps in chat">
          <View style={styles.toggleLabels}>
            <Text style={styles.toggleTitle}>Show planning steps</Text>
            <Text style={styles.toggleHint}>Each tool decision, inline in the chat</Text>
          </View>
          <Switch
            value={s.showPlanSteps}
            onValueChange={(v) => Settings.set({ showPlanSteps: v })}
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor={colors.bg}
          />
        </Pressable>
        <Pressable
          style={styles.toggleRow}
          onPress={() => Settings.set({ devTrace: !s.devTrace })}
          accessibilityRole="switch"
          accessibilityState={{ checked: s.devTrace }}
          accessibilityLabel="Record agent trace">
          <View style={styles.toggleLabels}>
            <Text style={styles.toggleTitle}>Record agent trace</Text>
            <Text style={styles.toggleHint}>Decisions, tool results, and timings</Text>
          </View>
          <Switch
            value={s.devTrace}
            onValueChange={(v) => Settings.set({ devTrace: v })}
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor={colors.bg}
          />
        </Pressable>
        <Pressable
          style={styles.linkRow}
          onPress={() => router.push('/agent-trace')}
          accessibilityRole="button"
          accessibilityLabel="View agent trace">
          <Ionicons name="pulse-outline" size={20} color={colors.icon} />
          <Text style={styles.linkText}>Agent trace</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
        </Pressable>

        <Text style={styles.privacy}>
          Whisper runs entirely on this phone. Chats, voice, and settings stay on-device. The
          only network use is downloading models and, if the assistant uses them, web search
          and web page tools.
        </Text>
      </ScrollView>
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
    content: { padding: 16, gap: 10 },
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.surface,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 14,
      marginBottom: 6,
    },
    linkText: { color: colors.text, fontSize: 15, fontWeight: '600', flex: 1 },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    toggleLabels: { flex: 1, gap: 1 },
    toggleTitle: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
    toggleHint: { color: colors.textFaint, fontSize: 11.5 },
    sectionTitle: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 14 },
    hint: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 18 },
    chipRow: { flexDirection: 'row', gap: 8 },
    chip: {
      flex: 1,
      alignItems: 'center',
      gap: 2,
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.surface,
      paddingVertical: 10,
      paddingHorizontal: 6,
    },
    chipOn: { borderColor: colors.primary },
    chipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
    chipTextOn: { color: colors.primary },
    chipHint: { color: colors.textFaint, fontSize: 10.5 },
    input: {
      color: colors.text,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 14,
      minHeight: 72,
      textAlignVertical: 'top',
    },
    privacy: {
      color: colors.textFaint,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 20,
    },
  });
