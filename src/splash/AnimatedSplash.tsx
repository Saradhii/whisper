// Cold-start splash: the launcher icon's mascot, drawn as vector, settles into
// place on the app's own background, opens its eyes, and blinks once; the
// wordmark rises in under it. Then the whole overlay lifts off the chat screen,
// which has been mounting (and loading the model) underneath the entire time.
//
// The point of the design is continuity. The user has just tapped this exact
// mark on their home screen, so the splash picks it up — same shape, same
// colours (see mascot.ts) — instead of introducing a second identity, and it
// sits on the theme background so the hand-off to the app is a fade between two
// frames that already agree. No bloom, no glow: the mark is the only colour.
//
// Mounted only by the root layout, so it plays on cold start and never on
// resume from background (no remount). Respects reduce-motion.
import { Canvas, Group, LinearGradient, Path, Shader, Skia, vec } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import { AccessibilityInfo, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemedStyles, type Colors } from '@/src/theme';

import {
  BODY_PATH,
  EYE_CENTERS,
  EYE_COLOR,
  EYE_PATH,
  EYE_TILT_RAD,
  FILL_COLORS,
  FILL_FALLBACK,
  FILL_SKSL,
  MASCOT_RADIUS,
} from './mascot';

/** Tip-to-tip diameter of the mark, in dp. */
const MARK = 132;
/** The canvas is larger than the mark so the exit lift never clips a tip. */
const BOX = 176;
const UNIT = MARK / 2 / MASCOT_RADIUS;

// A missing shader must not take the cold start down with it — the splash is
// the one screen every launch goes through. Null falls back to a plain
// gradient in the icon's colours.
const fillEffect = (() => {
  try {
    return Skia.RuntimeEffect.Make(FILL_SKSL);
  } catch {
    return null;
  }
})();
const fillUniforms = { uColors: FILL_COLORS };

// Decelerating curves only: everything arrives and settles, nothing bounces
// around. The one exception is the eyes, which overshoot a touch as they open
// — that is the moment the mark stops being a shape and becomes a character.
const SETTLE = Easing.bezier(0.22, 1, 0.36, 1);
const POP = Easing.bezier(0.34, 1.56, 0.64, 1);

export default function AnimatedSplash({ onDone }: { onDone: () => void }) {
  const styles = useThemedStyles(createStyles);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const enter = useSharedValue(0); // mark: scale + turn into place
  const fade = useSharedValue(0); // mark: opacity (quicker than the settle)
  const eyes = useSharedValue(0); // eye openness; dips for the blink
  const word = useSharedValue(0); // wordmark reveal
  const foot = useSharedValue(0); // footer line reveal
  const lift = useSharedValue(0); // exit: lockup eases toward the viewer
  const exit = useSharedValue(0); // exit: overlay fades off the app

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
          // Same composition, no movement: hold the finished frame, cross-fade.
          enter.value = 1;
          fade.value = 1;
          eyes.value = 1;
          word.value = 1;
          foot.value = 1;
          exit.value = withDelay(1100, withTiming(1, { duration: 300 }, finish));
          return;
        }
        enter.value = withTiming(1, { duration: 720, easing: SETTLE });
        fade.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.quad) });
        eyes.value = withSequence(
          withDelay(440, withTiming(1, { duration: 300, easing: POP })),
          withDelay(400, withTiming(0.08, { duration: 80, easing: Easing.in(Easing.quad) })),
          withTiming(1, { duration: 170, easing: Easing.out(Easing.cubic) }),
        );
        word.value = withDelay(380, withTiming(1, { duration: 560, easing: SETTLE }));
        foot.value = withDelay(640, withTiming(1, { duration: 480, easing: Easing.out(Easing.quad) }));
        lift.value = withDelay(1760, withTiming(1, { duration: 360, easing: Easing.in(Easing.quad) }));
        exit.value = withDelay(
          1760,
          withTiming(1, { duration: 360, easing: Easing.in(Easing.quad) }, finish),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [enter, fade, eyes, word, foot, lift, exit, onDone]);

  // The body turns a quarter (two of its eight arms) as it grows in. The
  // silhouette is identical every 45°, so it reads as the mark spinning down
  // to rest rather than as a shape rotating into the right orientation.
  const markTransform = useDerivedValue(() => [
    { translateX: BOX / 2 },
    { translateY: BOX / 2 },
    { scale: UNIT * (0.62 + 0.38 * enter.value) },
    { rotate: (enter.value - 1) * (Math.PI / 2) },
  ]);
  // Blink along each eye's own (tilted) long axis, hence rotate before scaleY.
  const leftEye = useDerivedValue(() => [
    { translateX: EYE_CENTERS[0]![0] },
    { translateY: EYE_CENTERS[0]![1] },
    { rotate: EYE_TILT_RAD },
    { scaleY: eyes.value },
  ]);
  const rightEye = useDerivedValue(() => [
    { translateX: EYE_CENTERS[1]![0] },
    { translateY: EYE_CENTERS[1]![1] },
    { rotate: EYE_TILT_RAD },
    { scaleY: eyes.value },
  ]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: 1 - exit.value }));
  const lockupStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.05 * lift.value }],
  }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: word.value,
    transform: [{ translateY: (1 - word.value) * 12 }],
  }));
  const footStyle = useAnimatedStyle(() => ({ opacity: foot.value }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.root, overlayStyle]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Whisper">
      {/* Optical centre, not geometric: a lockup dead-centre on a tall phone
          reads as sagging, so it rides a little above the midline. */}
      <Animated.View style={[styles.lockup, { marginBottom: height * 0.07 }, lockupStyle]}>
        <Canvas style={styles.canvas}>
          <Group transform={markTransform} opacity={fade}>
            <Path path={BODY_PATH}>
              {fillEffect ? (
                <Shader source={fillEffect} uniforms={fillUniforms} />
              ) : (
                <LinearGradient
                  start={vec(-MASCOT_RADIUS, 0)}
                  end={vec(MASCOT_RADIUS, 0)}
                  colors={[...FILL_FALLBACK]}
                />
              )}
            </Path>
            <Group transform={leftEye}>
              <Path path={EYE_PATH} color={EYE_COLOR} />
            </Group>
            <Group transform={rightEye}>
              <Path path={EYE_PATH} color={EYE_COLOR} />
            </Group>
          </Group>
        </Canvas>
        <Animated.Text style={[styles.word, wordStyle]} allowFontScaling={false}>
          whisper
        </Animated.Text>
      </Animated.View>
      <View style={[styles.footWrap, { bottom: insets.bottom + 28 }]} pointerEvents="none">
        <Animated.Text style={[styles.foot, footStyle]} maxFontSizeMultiplier={1.3}>
          Runs entirely on this phone
        </Animated.Text>
      </View>
    </Animated.View>
  );
}

const createStyles = (colors: Colors) =>
  StyleSheet.create({
    root: { backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    lockup: { alignItems: 'center' },
    canvas: { width: BOX, height: BOX },
    // Lowercase geometric sans, tracked in slightly: at this size Poppins'
    // default spacing is airy enough to read as a caption, not a name. The
    // negative top margin takes back the canvas's lift headroom so the gap
    // between mark and name is 16dp, measured from the lowest arm tip.
    word: {
      marginTop: 16 - (BOX - MARK) / 2,
      fontFamily: 'Poppins_600SemiBold',
      fontSize: 32,
      lineHeight: 40,
      letterSpacing: -0.9,
      color: colors.text,
      includeFontPadding: false,
    },
    footWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
    foot: { fontSize: 13, letterSpacing: 0.1, color: colors.textSecondary },
  });
