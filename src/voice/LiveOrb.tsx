// Animated orb for live voice mode. Concentric glowing rings that react to the
// current phase: pulse with mic amplitude while listening, breathe while
// thinking, and pulse gently while speaking. Reanimated only (no emoji).
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/src/theme';

export type OrbPhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export default function LiveOrb({ phase, level }: { phase: OrbPhase; level: number }) {
  const { colors } = useTheme();
  // Auto-animation used for non-listening phases.
  const auto = useSharedValue(0);
  // Smoothed amplitude for the listening phase.
  const amp = useSharedValue(0);

  useEffect(() => {
    if (phase === 'thinking' || phase === 'connecting') {
      auto.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true);
    } else if (phase === 'speaking') {
      auto.value = withRepeat(withTiming(1, { duration: 500, easing: Easing.inOut(Easing.quad) }), -1, true);
    } else {
      auto.value = withTiming(0, { duration: 200 });
    }
  }, [phase, auto]);

  // 1 while listening (orb tracks mic amplitude), 0 otherwise (auto-animation).
  const listening = useSharedValue(0);

  useEffect(() => {
    amp.value = withTiming(level, { duration: 110 });
  }, [level, amp]);

  useEffect(() => {
    listening.value = phase === 'listening' ? 1 : 0;
  }, [phase, listening]);

  const core = useAnimatedStyle(() => {
    const d = listening.value ? amp.value : auto.value;
    return { transform: [{ scale: 1 + 0.12 * d }] };
  });
  const mid = useAnimatedStyle(() => {
    const d = listening.value ? amp.value : auto.value;
    return { transform: [{ scale: 1 + 0.28 * d }], opacity: 0.5 + 0.3 * d };
  });
  const outer = useAnimatedStyle(() => {
    const d = listening.value ? amp.value : auto.value;
    return { transform: [{ scale: 1 + 0.5 * d }], opacity: 0.25 + 0.25 * d };
  });

  // A violet ramp, not a hue change: the orb is the voice surface, so every
  // phase stays in the accent family and only the brightness moves. (Speaking
  // used to be blue, the one color in the app that belonged to no palette.)
  const tint =
    phase === 'error'
      ? colors.danger
      : phase === 'listening'
        ? colors.accent
        : phase === 'speaking'
          ? colors.accentSoft
          : colors.accentDeep;

  return (
    <View style={styles.wrap}>
      <Animated.View style={[styles.ring, styles.outer, outer, { backgroundColor: tint }]} />
      <Animated.View style={[styles.ring, styles.mid, mid, { backgroundColor: tint }]} />
      <Animated.View style={[styles.ring, styles.core, core, { backgroundColor: tint }]} />
    </View>
  );
}

const SIZE = 160;
const styles = StyleSheet.create({
  wrap: { width: SIZE * 2, height: SIZE * 2, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', borderRadius: 999 },
  core: { width: SIZE, height: SIZE },
  mid: { width: SIZE * 1.4, height: SIZE * 1.4 },
  outer: { width: SIZE * 1.9, height: SIZE * 1.9 },
});
