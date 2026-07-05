// Cold-start animated splash: a soft blue→violet→purple gradient bloom on
// white (Fresha-style) with the lowercase wordmark centered in the glow.
// Exit: the bloom expands past the screen edges (everything goes violet),
// then the overlay fades out into the light app theme.
// Mounted only by the root layout, so it plays on cold start
// and never on resume from background (no remount). Respects reduce-motion.
import { Blur, Canvas, Circle, Fill, Group, RadialGradient, vec } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import { AccessibilityInfo, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

export default function AnimatedSplash({ onDone }: { onDone: () => void }) {
  const { width, height } = useWindowDimensions();
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.min(width, height) * 0.55;

  const bloom = useSharedValue(0); // entrance: bloom grows in
  const breath = useSharedValue(0); // idle: subtle breathing
  const word = useSharedValue(0); // wordmark reveal
  const exit = useSharedValue(0); // bloom fills screen, overlay fades

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduced) => {
        if (cancelled) return;
        const finish = (finished?: boolean) => {
          'worklet';
          if (finished) runOnJS(onDone)();
        };
        if (reduced) {
          bloom.value = 1;
          word.value = 1;
          exit.value = withDelay(1100, withTiming(1, { duration: 450 }, finish));
          return;
        }
        bloom.value = withTiming(1, { duration: 1000, easing: Easing.out(Easing.cubic) });
        breath.value = withRepeat(
          withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.quad) }),
          -1,
          true,
        );
        word.value = withDelay(450, withTiming(1, { duration: 750, easing: Easing.out(Easing.quad) }));
        exit.value = withDelay(1700, withTiming(1, { duration: 650, easing: Easing.in(Easing.cubic) }, finish));
      });
    return () => {
      cancelled = true;
    };
  }, [bloom, breath, word, exit, onDone]);

  const bloomTransform = useDerivedValue(() => [
    {
      scale:
        (0.5 + 0.5 * bloom.value) * (1 + 0.035 * breath.value) + 2.2 * exit.value * exit.value,
    },
  ]);
  const bloomOpacity = useDerivedValue(() => 0.25 + 0.75 * bloom.value);

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: interpolate(exit.value, [0, 0.55, 1], [1, 1, 0]),
  }));
  const wordStyle = useAnimatedStyle(() => ({
    // No letterSpacing: this is a connected script; spacing breaks the joins.
    opacity: word.value * (1 - exit.value),
    transform: [{ translateY: (1 - word.value) * 14 }, { scale: 0.9 + 0.1 * word.value }],
  }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, overlayStyle]}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color="#ffffff" />
        <Group origin={vec(cx, cy)} transform={bloomTransform} opacity={bloomOpacity}>
          {/* Core red bloom (brand) */}
          <Circle c={vec(cx, cy)} r={R}>
            <RadialGradient
              c={vec(cx, cy)}
              r={R}
              colors={['#c81e1e', '#e5322b', 'rgba(229, 50, 43, 0)']}
              positions={[0, 0.42, 1]}
            />
          </Circle>
          {/* Violet accent lobe, lower left */}
          <Circle c={vec(cx - R * 0.55, cy + R * 0.3)} r={R * 0.95}>
            <RadialGradient
              c={vec(cx - R * 0.55, cy + R * 0.3)}
              r={R * 0.95}
              colors={['rgba(124, 92, 252, 0.75)', 'rgba(124, 92, 252, 0)']}
              positions={[0, 1]}
            />
          </Circle>
          {/* Warm pink lobe, upper right */}
          <Circle c={vec(cx + R * 0.5, cy - R * 0.4)} r={R * 0.9}>
            <RadialGradient
              c={vec(cx + R * 0.5, cy - R * 0.4)}
              r={R * 0.9}
              colors={['rgba(249, 121, 160, 0.7)', 'rgba(249, 121, 160, 0)']}
              positions={[0, 1]}
            />
          </Circle>
          <Blur blur={30} />
        </Group>
      </Canvas>
      <Animated.View style={styles.center} pointerEvents="none">
        <Animated.Text style={[styles.word, wordStyle]}>whisper</Animated.Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  word: {
    fontFamily: 'DancingScript_700Bold',
    fontSize: 68,
    color: '#ffffff',
    textShadowColor: 'rgba(200, 30, 30, 0.35)',
    textShadowRadius: 18,
    textShadowOffset: { width: 0, height: 2 },
  },
});
