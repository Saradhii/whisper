// Left slide-in menu for the chat screen: "New chat" and the conversation
// history at the top, Settings and Models pinned to the bottom.
//
// Deliberately not @react-navigation/drawer — that pulls in
// react-native-gesture-handler, a new native dependency and therefore a full
// rebuild, and its layout isn't shaped for a pinned bottom section. A Modal
// hosts the panel so it covers the status bar (the chat screen's root is
// already inset by the safe area) and so Android's back button closes it via
// onRequestClose.
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AccessibilityInfo,
  Alert,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as ChatStore from '@/src/chat/store';
import { useTheme, useThemedStyles, type Colors } from '@/src/theme';

const OPEN_MS = 220;
const CLOSE_MS = 180;

function relativeTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function DrawerMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(320, Math.round(width * 0.84));

  useSyncExternalStore(ChatStore.subscribe, ChatStore.getVersion);
  const conversations = ChatStore.list();
  const currentId = ChatStore.getCurrentId();

  // Stays mounted through the close animation so the panel can slide out
  // instead of vanishing the moment `open` flips false.
  const [mounted, setMounted] = useState(open);
  // React's "adjust state during render" pattern: the panel must exist in the
  // same commit that starts the entrance animation, and doing this in an effect
  // would cost an extra render pass before anything is on screen.
  if (open && !mounted) setMounted(true);

  // Two shared values, split by who writes them: `progress` is driven only by
  // the effect below, `drag` only by the gesture. Keeping the gesture off
  // `progress` is what lets it stay an effect dependency.
  const progress = useSharedValue(0); // 0 = closed, 1 = fully open
  const drag = useSharedValue(0); // live finger offset in px, <= 0
  const reduceMotion = useRef(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((r) => {
        if (!cancelled) reduceMotion.current = r;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Runs after the panel is mounted, so the entrance animation always has a
  // rendered view to drive.
  useEffect(() => {
    if (!mounted) return;
    if (open) {
      progress.value = withTiming(1, {
        duration: reduceMotion.current ? 0 : OPEN_MS,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      progress.value = withTiming(
        0,
        { duration: reduceMotion.current ? 0 : CLOSE_MS, easing: Easing.in(Easing.cubic) },
        (finished) => {
          'worklet';
          if (finished) runOnJS(setMounted)(false);
        },
      );
    }
  }, [open, mounted, progress]);

  // useMemo, not useRef: the handlers are read during render, and this also
  // keeps them off stale props (panelWidth changes on rotation).
  const pan = useMemo(
    () =>
      PanResponder.create({
        // Capture-phase: the conversation FlatList is a child scroll view and
        // would otherwise claim the gesture first, so the panel never sees the
        // drag. The predicate stays strict — only clearly-horizontal leftward
        // movement is intercepted, leaving vertical list scrolling intact.
        onMoveShouldSetPanResponderCapture: (_e, g) =>
          g.dx < -6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onMoveShouldSetPanResponder: (_e, g) => g.dx < -6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_e, g) => {
          drag.value = Math.max(-panelWidth, Math.min(0, g.dx));
        },
        onPanResponderRelease: (_e, g) => {
          const dismissed = g.dx < -panelWidth / 3 || g.vx < -0.5;
          // Either way the finger offset returns to zero — on dismiss it runs
          // alongside the close animation so the two converge instead of jumping.
          drag.value = withTiming(0, { duration: dismissed ? CLOSE_MS : 140 });
          if (dismissed) onClose();
        },
        onPanResponderTerminate: () => {
          drag.value = withTiming(0, { duration: 140 });
        },
      }),
    // `drag` is intentionally absent: shared values are stable for the lifetime
    // of the component, and listing it here would make the gesture a "value
    // passed to a hook" that it is then not allowed to write to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panelWidth, onClose],
  );

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -panelWidth * (1 - progress.value) + drag.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, progress.value * (1 + drag.value / panelWidth)),
  }));

  const goto = useCallback(
    (path: '/settings' | '/models') => {
      onClose();
      router.push(path);
    },
    [onClose],
  );

  const openChat = useCallback(
    async (id: string) => {
      onClose();
      await ChatStore.open(id);
    },
    [onClose],
  );

  const newChat = useCallback(async () => {
    onClose();
    await ChatStore.startNew();
  }, [onClose]);

  const confirmDelete = useCallback((id: string, title: string) => {
    Alert.alert('Delete chat?', `“${title}” will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void ChatStore.remove(id) },
    ]);
  }, []);

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      // The slide is ours; the Modal itself must not animate on top of it.
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}>
      <View style={styles.fill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable
            style={styles.fill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
          />
        </Animated.View>

        <Animated.View
          style={[styles.panel, { width: panelWidth, paddingTop: insets.top + 8 }, panelStyle]}>
          {/* The responder lives on a plain View: touch-handler props are not
              reliably forwarded through Reanimated's animated wrapper. */}
          <View style={styles.fill} {...pan.panHandlers}>
            <Pressable
              style={styles.newRow}
              onPress={() => void newChat()}
              accessibilityRole="button"
              accessibilityLabel="Start a new chat">
              <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
              <Text style={styles.newText}>New chat</Text>
            </Pressable>

            <FlatList
              data={conversations}
              keyExtractor={(item) => item.id}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>
                    No conversations yet — everything you chat about stays on this phone.
                  </Text>
                </View>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.row, item.id === currentId && styles.rowActive]}
                  onPress={() => void openChat(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open chat: ${item.title}`}>
                  <View style={styles.flex}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {relativeTime(item.updatedAt)} · {item.messageCount} message
                      {item.messageCount === 1 ? '' : 's'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => confirmDelete(item.id, item.title)}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete chat: ${item.title}`}>
                    <Ionicons name="trash-outline" size={18} color={colors.icon} />
                  </Pressable>
                </Pressable>
              )}
            />

            <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
              <Pressable
                style={styles.footerRow}
                onPress={() => goto('/settings')}
                accessibilityRole="button"
                accessibilityLabel="Settings">
                <Ionicons name="settings-outline" size={20} color={colors.icon} />
                <Text style={styles.footerText}>Settings</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
              </Pressable>
              <Pressable
                style={styles.footerRow}
                onPress={() => goto('/models')}
                accessibilityRole="button"
                accessibilityLabel="Manage models">
                <Ionicons name="cube-outline" size={20} color={colors.icon} />
                <Text style={styles.footerText}>Models</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: Colors) =>
  StyleSheet.create({
    fill: { flex: 1 },
    flex: { flex: 1 },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.scrim },
    panel: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      backgroundColor: colors.bg,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.border,
      shadowColor: colors.shadow,
      shadowOpacity: 0.16,
      shadowRadius: 18,
      shadowOffset: { width: 2, height: 0 },
      elevation: 16,
    },
    newRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 12,
      marginBottom: 4,
      paddingHorizontal: 14,
      paddingVertical: 14,
      borderRadius: 14,
      backgroundColor: colors.surface,
    },
    newText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    list: { flex: 1 },
    listContent: { padding: 12, paddingTop: 4, gap: 8 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 14,
      backgroundColor: colors.surface,
    },
    rowActive: { borderWidth: 1.5, borderColor: colors.primary },
    rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    empty: { padding: 20, alignItems: 'center' },
    emptyText: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 },
    footer: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingHorizontal: 12,
      paddingTop: 8,
      gap: 2,
    },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 14,
      borderRadius: 12,
    },
    footerText: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' },
  });
