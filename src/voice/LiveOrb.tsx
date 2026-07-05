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

import { colors } from '@/src/theme';

export type OrbPhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export default function LiveOrb({ phase, level }: { phase: OrbPhase; level: number }) {
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

  useEffect(() => {
    amp.value = withTiming(level, { duration: 110 });
  }, [level, amp]);

  const drive = () => {
    'worklet';
    return phase === 'listening' ? amp.value : auto.value;
  };

  const core = useAnimatedStyle(() => ({ transform: [{ scale: 1 + 0.12 * drive() }] }));
  const mid = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.28 * drive() }],
    opacity: 0.5 + 0.3 * drive(),
  }));
  const outer = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.5 * drive() }],
    opacity: 0.25 + 0.25 * drive(),
  }));

  const tint =
    phase === 'error'
      ? colors.danger
      : phase === 'listening'
        ? colors.primary
        : phase === 'speaking'
          ? '#5b8cf5'
          : colors.primaryDeep;

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
